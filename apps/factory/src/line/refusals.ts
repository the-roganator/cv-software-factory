/**
 * The refusals the line records for mechanisms with no role of their own in the store (deviation 5, 7), as
 * `action.refused`, folded (`../refusal-log.ts`):
 *
 * - **Relayed from the GitHub worker** (`github-guard`, `token-permission`): each refusal it answers one of the line's
 *   own requests with, signed (`../signed-refusals.ts`). The line verifies it against the worker's public key, the
 *   ConfigMap `refusal-key`, before it appends it, with its record and signature, on the work item the request was
 *   for, or with what was refused when none. One that does not verify, or with no key to verify it, is logged and not
 *   appended. Relaying changes nothing the line does with the answer: the action fails as it would have.
 * - **Admission control's** (`admission-control`), read from the cluster's Events (`AdmissionReader`): a request
 *   Kyverno blocked in a guarded namespace, and a pod a controller could not make because a policy refused it. Its
 *   output is what the Event says, the policy's message verbatim within it; its guardrails 3 for an image and 4 for
 *   the rest. It goes on the work item when the refused object is a runner's Job, and always names the object.
 *
 * Where each Event is, as Kyverno 1.19 makes them:
 *
 * - Kyverno records a request it blocked on the policy that blocked it, with the refused object as the Event's related
 *   object. Its policies are cluster-wide, so the Event is in `default`, never in the namespace of what it refused.
 *   It records none for an object with no name yet: a pod a controller makes, named from `generateName`.
 * - So a pod a ReplicaSet, a Job or the app's Rollout could not make is recorded by its controller, as `FailedCreate`
 *   in the controller's namespace, with the webhook's answer in its message; the controller tries again, and each
 *   try adds to that one Event's count, so the line records each try, folded.
 * - The cluster's own ValidatingAdmissionPolicies (the Rollout's controls, the flags, the flags' stages, the share
 *   key) record no Event at all: their refusals reach only whoever asked, and are not recorded here.
 *
 * Events are kept for an hour. The line lists them every few seconds, and remembers each one's count, so each try is
 * recorded once while it runs; when it starts, it takes only what came after the last admission refusal it recorded,
 * and what came in that same second that it had not recorded: an Event's time is to the second, so two can share one.
 */
import type { KeyObject } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AGENTS, cutTo, type PayloadOf } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { guardrailsFor } from '../../../../policy/refusals.ts';
import type { ActingFor } from '../github/server.ts';
import type { Logger } from '../log.ts';
import { RefusalLog } from '../refusal-log.ts';
import { NAMESPACE as RUNNERS } from '../runners/jobs.ts';
import type { Kube } from '../runners/kube.ts';
import { verifyRefusal } from '../signed-refusals.ts';

/** The namespaces admission control guards (ADR 0010): the line reads the Events in each. */
export const GUARDED_NAMESPACES = ['factory', 'runners', 'website', 'scoreboard', 'flagd'] as const;

/** Where Kyverno keeps its record of a request it blocked: on the policy, which is cluster-wide, so in `default`. */
export const KYVERNO_EVENTS = 'default';

type Mechanism = 'github-guard' | 'token-permission' | 'admission-control';

/** The mechanisms the line relays from the GitHub worker's answers to its own requests. */
const RELAYED = ['github-guard', 'token-permission'] as const satisfies Mechanism[];
type Relayed = (typeof RELAYED)[number];

const SUMMARIES: Record<Mechanism, string> = {
  'github-guard': "The GitHub worker's guard refused an action",
  'token-permission': "GitHub refused the factory App's token",
  'admission-control': 'Admission control refused an object in a guarded namespace',
};

export interface LineRefusalsOptions {
  events: Pick<EventWriter, 'append'>;
  log: Logger;
  /** The GitHub worker's public key; without it, nothing it refused is relayed. */
  key: KeyObject | undefined;
  clock?: () => Date;
  foldMs?: number;
}

/** A denial admission control left an Event of, as the line records it. */
export interface Denial {
  workItem: string | null;
  cause: 'image' | 'production';
  action: string;
  output: string;
  subject: NonNullable<PayloadOf<'action.refused'>['subject']>;
  at: Date;
}

export class LineRefusals {
  readonly #log: RefusalLog<Mechanism>;
  readonly #o: LineRefusalsOptions;

  constructor(options: LineRefusalsOptions) {
    this.#o = options;
    this.#log = new RefusalLog<Mechanism>({
      events: options.events,
      log: options.log,
      what: 'a refusal',
      summary: (mechanism, { payload }) =>
        (payload.count ?? 1) > 1 ? `${SUMMARIES[mechanism]}, ${payload.count} times in a minute` : SUMMARIES[mechanism],
      ...(options.clock && { clock: options.clock }),
      ...(options.foldMs !== undefined && { foldMs: options.foldMs }),
    });
  }

  /**
   * Relays one refusal the GitHub worker answered a request with, if it verifies; `on` is what the request was for.
   * Never throws: a refusal it cannot verify is logged.
   */
  readonly relay = (answer: unknown, on: ActingFor): void => {
    const workItem = on.workItem ?? null;
    if (!this.#o.key) {
      this.#o.log.warn(
        { workItem },
        'the GitHub worker refused an action, and with no key to verify it, it is not recorded',
      );
      return;
    }
    const verified = verifyRefusal(this.#o.key, answer);
    if (!verified.ok) {
      this.#o.log.warn(
        { workItem, why: verified.why },
        'the GitHub worker answered a refusal that does not verify: not recorded',
      );
      return;
    }
    const { repo, number, at, payload, record, signature } = verified.refusal;
    // Only what the worker answers the line's own requests with: the review check's verdict it signs is for the
    // red-team harness, which asks for it, and is never the line's to record.
    if (!RELAYED.includes(payload.mechanism as Relayed)) {
      this.#o.log.warn(
        { workItem, mechanism: payload.mechanism },
        'the GitHub worker answered a refusal the line does not relay: not recorded',
      );
      return;
    }
    const subject = {
      kind: number === null ? 'repository' : 'issue or pull request',
      name: number === null ? repo : `${repo}#${number}`,
    };
    this.#log.refused(payload.mechanism as Mechanism, {
      workItem,
      at: new Date(at),
      payload: { ...payload, record, signature, ...(workItem === null && { subject }) },
    });
  };

  /** Records one denial admission control left an Event of. */
  denied({ workItem, cause, action, output, subject, at }: Denial): void {
    this.#log.refused('admission-control', {
      workItem,
      at,
      payload: {
        mechanism: 'admission-control',
        action: cutTo(action, 200),
        output: cutTo(output, 4000),
        guardrails: guardrailsFor('admission-control', cause),
        subject,
      },
    });
  }

  start(): void {
    this.#log.start();
  }

  flush(now?: Date): Promise<void> {
    return this.#log.flush(now);
  }

  stop(): Promise<void> {
    return this.#log.stop();
  }

  settled(): Promise<void> {
    return this.#log.settled();
  }
}

const reference = z.object({
  kind: z.string().optional(),
  namespace: z.string().optional(),
  name: z.string().optional(),
  uid: z.string().optional(),
});

/** An Event, as the core API lists it: what the line reads of one. */
const EVENT = z.object({
  metadata: z.object({ uid: z.string(), namespace: z.string().optional(), creationTimestamp: z.string().optional() }),
  involvedObject: reference,
  related: reference.nullish(),
  reason: z.string().nullish(),
  message: z.string().nullish(),
  action: z.string().nullish(),
  reportingComponent: z.string().nullish(),
  source: z.object({ component: z.string().optional() }).nullish(),
  count: z.number().int().nullish(),
  series: z.object({ count: z.number().int().optional(), lastObservedTime: z.string().optional() }).nullish(),
  firstTimestamp: z.string().nullish(),
  lastTimestamp: z.string().nullish(),
  eventTime: z.string().nullish(),
});

export type KubeEvent = z.infer<typeof EVENT>;

const EVENTS = z.object({ items: z.array(EVENT) });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A runner's Job (`../runners/jobs.ts`): its agent, its work item, its round and step, and its part. */
const RUNNER_JOB = new RegExp(`^(?:${AGENTS.join('|')})-([1-9]\\d{0,8})-\\d+-\\d+-(?:prepare|agent)$`);
/** A webhook's or the API server's own answer refusing a request. */
const DENIED =
  /admission webhook "[^"]+" denied the request|ValidatingAdmissionPolicy '[^']+' with binding '[^']+' denied request/;
/** Kyverno's image policies answer through webhooks of their own (`ivpol.…`). */
const IMAGE_WEBHOOK = /admission webhook "ivpol\./;

/** How many times an Event says it happened. */
export const timesOf = (event: KubeEvent): number => Math.max(1, event.series?.count ?? event.count ?? 1);

/** When an Event last happened. */
export function lastOf(event: KubeEvent): Date {
  const at =
    event.series?.lastObservedTime ??
    event.lastTimestamp ??
    event.eventTime ??
    event.firstTimestamp ??
    event.metadata.creationTimestamp;
  const time = at ? Date.parse(at) : Number.NaN;
  return new Date(Number.isNaN(time) ? 0 : time);
}

/** When an Event first happened. */
function firstOf(event: KubeEvent): Date {
  const at = event.firstTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp;
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(time) ? lastOf(event) : new Date(time);
}

const guarded = (namespace: string | undefined): namespace is (typeof GUARDED_NAMESPACES)[number] =>
  (GUARDED_NAMESPACES as readonly string[]).includes(namespace ?? '');

/** The work item an object in the cluster belongs to: a runner's Job is its work item's; nothing else is. */
function workItemOf(namespace: string, kind: string, name: string): string | null {
  if (namespace !== RUNNERS || kind !== 'Job') return null;
  return RUNNER_JOB.exec(name)?.[1] ?? null;
}

const subjectOf = (namespace: string, kind: string, name: string, uid: string | undefined) => ({
  namespace: cutTo(namespace, 63),
  kind: cutTo(kind || 'object', 63),
  name: cutTo(name || '(no name yet)', 253),
  ...(uid && UUID.test(uid) && { uid: uid.toLowerCase() }),
});

/**
 * The denial an Event records, or undefined for any other Event: Kyverno's own record of a request it blocked in a
 * guarded namespace, or a controller's of a pod admission would not let it make there. Pure.
 */
export function denialOf(event: KubeEvent): Omit<Denial, 'at'> | undefined {
  const output = event.message?.trim();
  if (!output) return undefined;
  const reporter = event.reportingComponent || event.source?.component;
  const related = event.related;
  if (
    event.reason === 'PolicyViolation' &&
    reporter === 'kyverno-admission' &&
    event.action === 'Resource Blocked' &&
    related &&
    guarded(related.namespace)
  ) {
    const kind = related.kind ?? '';
    const name = related.name ?? '';
    const policy = event.involvedObject.name ?? 'a policy';
    return {
      workItem: workItemOf(related.namespace, kind, name),
      cause: event.involvedObject.kind === 'ImageValidatingPolicy' ? 'image' : 'production',
      action: `Admit ${kind} ${related.namespace}/${name}, refused by ${policy}`,
      output,
      subject: subjectOf(related.namespace, kind, name, related.uid),
    };
  }
  const namespace = event.metadata.namespace ?? event.involvedObject.namespace;
  if (event.reason === 'FailedCreate' && guarded(namespace) && DENIED.test(output)) {
    const kind = event.involvedObject.kind ?? '';
    const name = event.involvedObject.name ?? '';
    return {
      workItem: workItemOf(namespace, kind, name),
      cause: IMAGE_WEBHOOK.test(output) ? 'image' : 'production',
      action: `Create a pod for ${kind} ${namespace}/${name}`,
      output,
      subject: subjectOf(namespace, kind, name, event.involvedObject.uid),
    };
  }
  return undefined;
}

/**
 * The most tries of one Event recorded at one look: a controller's backs off, so more is a count gone wrong, or one
 * written to flood the line. The rest wait for the looks after it, so none is lost, and each look's work is bounded.
 */
export const MOST_AT_ONCE = 100;

export interface AdmissionReaderOptions {
  kube: Pick<Kube, 'get'>;
  /** As the line's role, to find where it left off. */
  sql: Sql;
  refusals: Pick<LineRefusals, 'denied'>;
  log: Logger;
}

/**
 * Lists the Events that can record a denial, in each guarded namespace and in Kyverno's, and records each new denial,
 * and each new try of one, once.
 */
export class AdmissionReader {
  readonly #o: AdmissionReaderOptions;
  /** Each Event seen, by its uid, with how many of the times it had happened are recorded. */
  #seen = new Map<string, number>();
  /** Only what happened after this is new when it starts: the last admission refusal it recorded. */
  #since: Watermark | undefined;
  #failing = false;

  constructor(options: AdmissionReaderOptions) {
    this.#o = options;
  }

  /** Looks once: lists the Events, and records what is new. A namespace it cannot list is logged, once until it can. */
  async look(): Promise<void> {
    this.#since ??= await lastAdmissionRefusal(this.#o.sql);
    const since = this.#since;
    const lists = [
      ...GUARDED_NAMESPACES.map((namespace) => ({ namespace, reason: 'FailedCreate' })),
      { namespace: KYVERNO_EVENTS, reason: 'PolicyViolation' },
    ];
    const listed: KubeEvent[] = [];
    let failed: unknown;
    for (const { namespace, reason } of lists) {
      try {
        const events = await this.#o.kube.get(
          `/api/v1/namespaces/${namespace}/events?fieldSelector=${encodeURIComponent(`reason=${reason}`)}`,
          EVENTS,
        );
        listed.push(...(events?.items ?? []));
      } catch (error) {
        failed ??= error;
      }
    }
    if (failed && !this.#failing)
      this.#o.log.warn({ err: failed }, 'could not list the Events admission denials are in');
    if (!failed && this.#failing) this.#o.log.info('listing the Events admission denials are in again');
    this.#failing = failed !== undefined;

    const seen = new Map<string, number>();
    for (const event of listed) {
      const times = timesOf(event);
      const before = this.#seen.get(event.metadata.uid);
      const denial = denialOf(event);
      if (!denial) {
        seen.set(event.metadata.uid, times);
        continue;
      }
      // Never later than now: an Event dated ahead would otherwise set where a restart starts, and hide what came before.
      const at = new Date(Math.min(lastOf(event).getTime(), Date.now()));
      // Recorded before it started: before the last it recorded, or in that second and recorded then.
      const recorded =
        at < since.at || (at.getTime() === since.at.getTime() && since.actions.has(cutTo(denial.action, 200)));
      const fresh = before !== undefined ? times - before : recorded ? 0 : firstOf(event) > since.at ? times : 1;
      const now = Math.min(fresh, MOST_AT_ONCE);
      // What it leaves for the next look is not yet counted as seen, so that look records it.
      seen.set(event.metadata.uid, times - (fresh - now));
      if (fresh > now)
        this.#o.log.warn(
          { uid: event.metadata.uid, tries: fresh, recorded: now },
          'recording a denial’s tries over the looks to come',
        );
      for (let i = 0; i < now; i++) this.#o.refusals.denied({ ...denial, at });
    }
    // An Event no longer listed has gone, and one whose namespace failed to list is kept until it lists again.
    if (!failed) this.#seen = seen;
    else for (const [uid, times] of seen) this.#seen.set(uid, times);
  }

  /** Looks every `everyMs` until stopped. */
  async run(signal: AbortSignal, everyMs = 15_000): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.look();
      } catch (error) {
        this.#o.log.warn({ err: error }, 'could not read admission denials');
      }
      // Rejects when aborted, and leaves no listener behind on the signal when it is not.
      await sleep(everyMs, undefined, { signal }).catch(() => undefined);
    }
  }
}

/** Where the line's record of admission refusals ends: when the last happened, and what it recorded then. */
export interface Watermark {
  /** When the last admission refusal it recorded happened, its last repeat's time if folded, or the start of time. */
  at: Date;
  /** The actions of those it recorded at that time: an Event of another, in the same second, is still to record. */
  actions: Set<string>;
}

/** Where the line's record of admission refusals ends. */
export async function lastAdmissionRefusal(sql: Sql): Promise<Watermark> {
  const rows = await sql<{ at: Date; action: string }[]>`
    with mine as (
      select greatest(ts, coalesce((payload ->> 'lastAt')::timestamptz, ts)) as at, payload ->> 'action' as action
      from events
      where type = 'action.refused' and payload ->> 'mechanism' = 'admission-control' and appended_by = current_user
    )
    select at, action from mine where at = (select max(at) from mine)`;
  return { at: rows[0]?.at ?? new Date(0), actions: new Set(rows.map((row) => row.action)) };
}
