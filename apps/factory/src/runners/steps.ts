/**
 * Running one step of one work item in a runner, and taking its handback.
 *
 *     token → volume → prepare Job (the pins) → agent Job → handback → lockfile Job → token ended
 *
 * (or a Job failing, or its deadline). On a dependency's work item the prepare pod writes the move's pins before the
 * agent starts and prints them, and the line reads them from its log as soon as it has finished, before the agent
 * pod is made, so nothing the agent does can reach them; pins that wait for Martin end the step there, `held`. After a
 * coder's patch that changes a `package.json`, a lockfile Job writes the lockfile for it on a fresh checkout and
 * prints it, read the same way. Neither pod holds the job token. Both patches go beside the agent's in the outcome,
 * for the GitHub worker to apply around it (`PatchCommit`), and are never part of it.
 *
 * The job token is made before the agent pod starts and ended when the step is over, however it ends, so the gateway
 * and the handback refuse it from then on. It keeps the step's span, the one active as `run` is called, so the
 * gateway's spans for the job's calls join the work item's trace (`spans.ts`). The Jobs are deleted afterwards, and their pods with them, so first each
 * pod's log is read and kept with the step (`logs.ts`). The volume stays for the next step, until the work item merges
 * or is over (`finish`).
 *
 * The handback (`POST /v1/handback`) takes a job's result with its token, checked with Zod at the door, and hands it
 * to the step waiting for it. A job hands back once.
 *
 * Each attempt at a step has a job of its own, named by the agent, the round and the step's number within the work
 * item: a job's name, and so its token, is used once, and a retry never finds the Jobs of the attempt before it.
 * `cancel` deletes the Jobs of every step in hand, for the line stopping, as aborting a step's own `signal` deletes its
 * Jobs; each of those steps ends `stopped`, and nothing it did counts. A step whose signal has aborted before it
 * starts never starts.
 */
import { lookup } from 'node:dns/promises';
import type { IncomingMessage, RequestListener } from 'node:http';
import { isIP } from 'node:net';
import { type Context, context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { cutTo, inScope } from '@software-factory/events';
import { endJobToken, issueJobToken, jobForToken } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { z } from 'zod';
// Types only: the factory image holds no runner, so a value from it would fail to load there (`scripts/image-modules.test.ts`).
import type { Handback, Step } from '../../../runner/src/step.ts';

export type { Handback, Step };

import { changesManifest, LOCKFILES, PNPM_SETTINGS } from '../github/paths.ts';
import {
  agentJob,
  isRedTeam,
  JOB_PARTS,
  jobName,
  lockfileJob,
  NAMESPACE,
  NOT_RED_TEAM,
  prepareJob,
  volume,
} from './jobs.ts';
import type { Kube } from './kube.ts';
import type { StepEnding, StepLogs } from './logs.ts';

/** The most a result may be, as JSON: the runner's own bound (`apps/runner/src/step.ts`), which a test holds equal. */
export const RESULT_BYTES = 64 * 1024;

export const handbackBody = z.strictObject({
  ending: z.enum(['finished', 'max-turns', 'failed']),
  patch: z.string().max(1024 * 1024),
  note: z.string().max(4000),
  turns: z.number().int().nonnegative(),
  session: z.string().max(100).nullable(),
  error: z.string().max(4000).optional(),
  /** Read through the agent's own schema by the line; here only its size is judged. */
  result: z
    .json()
    .optional()
    .refine(
      (result) => Buffer.byteLength(JSON.stringify(result ?? null)) <= RESULT_BYTES,
      `a result is at most ${RESULT_BYTES} bytes`,
    ),
});

export interface StepRequest extends Step {
  workItem: string;
  /** Which round of this agent's work this is, from 1: a coder sent back by review works a second round. */
  round: number;
  /**
   * The step's number within the work item, whichever agent ran its steps (`Queue.startStep`): from 1, and never used
   * twice for one work item. With the agent and the round, it names the job.
   */
  attempt?: number;
  /** How long the agent may run, in seconds. Preparing has ten minutes of its own. */
  deadlineSeconds: number;
  /** Stops the step, at any point, as `cancel` does: the line aborts it when it stops. */
  signal?: AbortSignal;
}

export type StepOutcome =
  | {
      kind: 'handed-back';
      job: string;
      handback: Handback;
      /** The pin step's patch, made before the agent ran, which the agent's patch goes on: a dependency's move. */
      pins?: string;
      /** The lockfile the pin step wrote after the agent's patch changed a manifest, which goes on that patch. */
      lockfile?: string;
    }
  /** The move's pins need a file only Martin may change: no agent ran. */
  | { kind: 'held'; job: string; path: string; reason: string }
  /** The prepare or agent pod failed, or ran out of time, without handing anything back. */
  | { kind: 'failed'; job: string; reason: string }
  /** The line stopped while the step ran: its Jobs were deleted, and nothing it did counts. */
  | { kind: 'stopped'; job: string };

export interface RunnersOptions {
  sql: Sql;
  kube: Kube;
  /** The `factory-runner` image, by digest. */
  image: string;
  /** How an agent pod reaches the gateway, and the handback. */
  gatewayUrl: string;
  handbackUrl: string;
  log: Logger;
  /** Where each pod's log is kept before its Job is deleted. Without it, none is. */
  logs?: StepLogs;
  /** How long a step's Jobs wait for its logs to be kept (`LOG_WAIT_MS`). */
  logWaitMs?: number;
  /** How often a Job's state is read. */
  pollMs?: number;
  /** How long a handback may follow the agent pod's end: a pod hands back, then ends. */
  graceMs?: number;
  /** Injected so tests need neither real waiting nor a real clock, nor real names. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  lookup?: (hostname: string) => Promise<string>;
}

const PREPARE_SECONDS = 600;

/** The most of a prepare pod's log read for what it printed for the line: pins and a lockfile, as a patch each. */
const PRINTED_BYTES = 8 * 1024 * 1024;

/**
 * How much of a pod's log is kept: its last lines, which say how it ended. A byte limit would be taken from the start
 * of those lines and cut the end, so the runner bounds its own lines instead (`apps/runner/src/log.ts`).
 */
const LOG_LINES = 2000;
/**
 * How long a step's Jobs wait for its logs to be kept before they are deleted all the same: an API that does not
 * answer must not keep an agent working after the line has stopped it.
 */
const LOG_WAIT_MS = 10_000;

const PODS = z.object({
  items: z.array(
    z.object({
      metadata: z.object({ name: z.string(), labels: z.record(z.string(), z.string()).optional() }),
      status: z.object({ reason: z.string().optional() }).optional(),
    }),
  ),
});

const JOB = z.object({
  status: z
    .object({
      succeeded: z.number().optional(),
      conditions: z.array(z.object({ type: z.string(), status: z.string(), reason: z.string().optional() })).optional(),
    })
    .optional(),
});

export class Runners {
  readonly #o: RunnersOptions;
  readonly #waiting = new Map<string, (handback: Handback) => void>();
  /** The jobs of the steps in hand, with whose they are, and those of them the line has stopped. */
  readonly #running = new Map<string, { workItem: string; agent: string }>();
  readonly #stopped = new Set<string>();
  /** Each step's logs being kept, so a step stopped as it ends keeps them once. */
  readonly #keeping = new Map<string, Promise<void>>();

  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: RunnersOptions) {
    this.#o = options;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  async run(request: StepRequest): Promise<StepOutcome> {
    const { sql, kube, log } = this.#o;
    const { workItem, round, attempt = 1, deadlineSeconds, signal, ...step } = request;
    const job = jobName(step.agent, workItem, round, attempt);
    const names = { job, workItem };
    const jobs = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
    if (signal?.aborted) return { kind: 'stopped', job };
    // The step's span, if one is active, goes with the token, so the gateway starts the job's calls under it.
    const { traceparent } = traceOf(context.active());
    const token = await issueJobToken(sql, {
      job,
      workItem,
      agent: step.agent,
      ...(traceparent ? { traceparent } : {}),
    });
    this.#running.set(job, { workItem, agent: step.agent });
    const stop = () => void this.#stop(job);
    signal?.addEventListener('abort', stop);
    let outcome: StepOutcome | undefined;
    let thrown: unknown;
    try {
      outcome = await this.#attempt(names, step, token, deadlineSeconds, signal);
      return outcome;
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      signal?.removeEventListener('abort', stop);
      this.#waiting.delete(job);
      this.#running.delete(job);
      this.#stopped.delete(job);
      // Each of these is tried whatever the others do: a token that will not end must not leave a Job running.
      await endJobToken(sql, job).catch((error: Error) => log.error({ job, err: error }, 'could not end a job token'));
      const [ending, reason] = outcome ? endingOf(outcome) : (['errored', messageOf(thrown)] as const);
      await this.#keepLogsWithin(job, { workItem, agent: step.agent }, ending, reason);
      this.#keeping.delete(job);
      for (const part of JOB_PARTS) {
        await kube
          .remove(`${jobs}/${job}-${part}`)
          .catch((error: Error) => log.warn({ job, err: error }, 'could not delete a job'));
      }
    }
  }

  /** One attempt at a step, from its prepare Job to its handback, or to the first sign it will not come. */
  async #attempt(
    names: { job: string; workItem: string },
    step: Step,
    token: string,
    deadlineSeconds: number,
    signal: AbortSignal | undefined,
  ): Promise<StepOutcome> {
    const { kube, log } = this.#o;
    const { job, workItem } = names;
    const jobs = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
    // Stopped while the token was made: nothing has started yet.
    if (signal?.aborted) this.#stopped.add(job);
    if (this.#stopped.has(job)) return { kind: 'stopped', job };
    await kube.create(`/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims`, volume(workItem));
    await kube.create(jobs, prepareJob(names, step, { image: this.#o.image, deadlineSeconds: PREPARE_SECONDS }));
    log.info({ job, workItem, agent: step.agent }, 'preparing');
    const prepared = await this.#finished(`${jobs}/${job}-prepare`, PREPARE_SECONDS);
    if (this.#stopped.has(job)) return { kind: 'stopped', job };
    if (prepared !== 'succeeded') return { kind: 'failed', job, reason: `The prepare pod ${prepared}.` };
    let pins: string | undefined;
    if (step.move) {
      const said = await this.#printed(`${job}-prepare`, ['the pins', 'the pins wait for Martin']);
      if (this.#stopped.has(job)) return { kind: 'stopped', job };
      if (!said) return { kind: 'failed', job, reason: 'The prepare pod printed no pins for the move.' };
      if (said.msg === 'the pins wait for Martin') {
        const held = HELD.safeParse(said.held);
        if (!held.success) return { kind: 'failed', job, reason: 'The prepare pod held the pins without saying why.' };
        return { kind: 'held', job, ...held.data };
      }
      if (typeof said.pins !== 'string')
        return { kind: 'failed', job, reason: 'The prepare pod printed no pins for the move.' };
      pins = said.pins || undefined;
    }

    const handedBack = new Promise<Handback>((resolve) => this.#waiting.set(job, resolve));
    if (this.#stopped.has(job)) return { kind: 'stopped', job };
    await kube.create(
      jobs,
      agentJob(names, step, {
        image: this.#o.image,
        deadlineSeconds,
        gatewayUrl: this.#o.gatewayUrl,
        handbackUrl: this.#o.handbackUrl,
        token,
        hosts: await this.#hosts(),
      }),
    );
    log.info({ job, workItem, agent: step.agent }, 'the agent is working');
    // The pod ending is checked after the handback could have arrived: a pod hands back, then ends.
    const ended = this.#finished(`${jobs}/${job}-agent`, deadlineSeconds + 60).then(async (state) => {
      await this.#sleep(this.#o.graceMs ?? 2_000);
      return state;
    });
    const first = await Promise.race([
      handedBack.then((handback) => ({ handback })),
      ended.then((state) => ({ state })),
    ]);
    if (this.#stopped.has(job)) return { kind: 'stopped', job };
    if ('handback' in first) {
      // A pod hands back, then ends: its log is kept whole once it has, or after the grace.
      await Promise.race([ended, this.#sleep(this.#o.graceMs ?? 2_000)]);
      if (this.#stopped.has(job)) return { kind: 'stopped', job };
      const { handback } = first;
      const written = await this.#lockfile(names, step, pins, handback.patch);
      if (this.#stopped.has(job)) return { kind: 'stopped', job };
      if (typeof written === 'object') return written;
      return {
        kind: 'handed-back',
        job,
        handback,
        ...(pins ? { pins } : {}),
        ...(written ? { lockfile: written } : {}),
      };
    }
    return { kind: 'failed', job, reason: `The agent pod ${first.state} without handing anything back.` };
  }

  /**
   * The lockfile for a patch that changes a manifest, written by the pin step in a Job of its own: its patch, empty
   * when the lockfile needs no change, or the step's failure. None for a patch that changes no manifest, or one that
   * also changes a lockfile or pnpm's settings, which the scope fence refuses whole.
   */
  async #lockfile(
    names: { job: string; workItem: string },
    step: Step,
    pins: string | undefined,
    patch: string,
  ): Promise<string | undefined | StepOutcome> {
    if (!patch || !changesManifest(patch)) return undefined;
    if (touchesSettings(patch)) return undefined;
    const { job } = names;
    const jobs = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
    // The checkout the agent started from, less the move, which the pins already are, and with the patch.
    const { move: _move, base: _base, resume: _resume, ...rest } = step;
    const lockfileStep: Step = { ...rest, ...(pins ? { pins } : {}), change: patch };
    await this.#o.kube.create(
      jobs,
      lockfileJob(names, lockfileStep, { image: this.#o.image, deadlineSeconds: PREPARE_SECONDS }),
    );
    this.#o.log.info({ job, workItem: names.workItem }, 'writing the lockfile');
    const state = await this.#finished(`${jobs}/${job}-lockfile`, PREPARE_SECONDS);
    if (this.#stopped.has(job)) return { kind: 'stopped', job };
    const said = await this.#printed(`${job}-lockfile`, [
      'the lockfile',
      'the prepare step failed',
      'the lockfile step failed',
    ]);
    if (state !== 'succeeded' || said?.msg !== 'the lockfile' || typeof said.lockfile !== 'string') {
      const why = typeof said?.error === 'string' ? `: ${said.error}` : '.';
      return {
        kind: 'failed',
        job,
        reason: cutTo(`The lockfile pod ${state === 'succeeded' ? 'printed no lockfile' : state}${why}`, 4000),
      };
    }
    return said.lockfile;
  }

  /**
   * The last line a finished Job's pod printed with one of `messages`, as JSON: read whole from its log, since the pins
   * it prints may be longer than the lines the step keeps. Nothing when the pod or the line is not there.
   */
  async #printed(jobName: string, messages: readonly string[]): Promise<Record<string, unknown> | undefined> {
    const pods = `/api/v1/namespaces/${NAMESPACE}/pods`;
    const selector = encodeURIComponent(`job-name=${jobName},${NOT_RED_TEAM}`);
    const found = await this.#o.kube.get(`${pods}?labelSelector=${selector}`, PODS);
    const pod = found?.items.find((item) => !isRedTeam(item.metadata.labels));
    if (!pod) return undefined;
    const text = await this.#o.kube.text(
      `${pods}/${encodeURIComponent(pod.metadata.name)}/log?limitBytes=${PRINTED_BYTES}`,
    );
    let said: Record<string, unknown> | undefined;
    for (const line of (text ?? '').split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.msg === 'string' && messages.includes(parsed.msg)) said = parsed;
      } catch {
        // A line that is not JSON is no line of the runner's.
      }
    }
    return said;
  }

  /** Keeps a step's logs, waiting no longer than `LOG_WAIT_MS` for them; they go on being kept after that. */
  async #keepLogsWithin(
    job: string,
    whose: { workItem: string; agent: string },
    ending: StepEnding,
    reason: string | null,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#o.logWaitMs ?? LOG_WAIT_MS);
    });
    try {
      await Promise.race([this.#keepLogs(job, whose, ending, reason), waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads the log of each of a step's pods and keeps it (`logs.ts`), before its Jobs are deleted. Once for each step,
   * however many ask; a log that cannot be read or kept is warned of, and never stops the step's Jobs being deleted.
   */
  #keepLogs(job: string, whose: { workItem: string; agent: string }, ending: StepEnding, reason: string | null) {
    const { logs } = this.#o;
    if (!logs) return Promise.resolve();
    const kept = this.#keeping.get(job);
    if (kept) return kept;
    const keeping = (async () => {
      const { kube, log } = this.#o;
      const pods = `/api/v1/namespaces/${NAMESPACE}/pods`;
      try {
        const selector = encodeURIComponent(`factory.mrogan.dev/job=${job},${NOT_RED_TEAM}`);
        const found = await kube.get(`${pods}?labelSelector=${selector}`, PODS);
        for (const pod of found?.items ?? []) {
          const { name, labels } = pod.metadata;
          const part = labels?.['factory.mrogan.dev/runner'];
          // An attack's pod is the red-team harness's, whatever else its labels say: its log is no step's.
          if ((part !== 'prepare' && part !== 'agent') || isRedTeam(labels)) continue;
          try {
            const text = await kube.text(`${pods}/${encodeURIComponent(name)}/log?tailLines=${LOG_LINES}`);
            if (text === undefined) {
              log.warn({ job, pod: name }, 'a pod’s log was gone before it could be kept');
              continue;
            }
            await logs.keep({ job, ...whose, part, pod: name, ending, reason }, text);
          } catch (error) {
            // A pod that never started has no log to read.
            log.warn({ job, pod: name, err: error }, 'could not keep a pod’s log');
          }
        }
      } catch (error) {
        log.warn({ job, err: error }, 'could not find a step’s pods to keep their logs');
      }
    })();
    this.#keeping.set(job, keeping);
    return keeping;
  }

  /**
   * The line has stopped: deletes the Jobs of every step in hand, so no agent works on. Each of those steps ends
   * `stopped` within a poll, and ends its token as any step does.
   */
  async cancel(): Promise<void> {
    await Promise.all([...this.#running.keys()].map((job) => this.#stop(job)));
  }

  /** Stops one step in hand: its Jobs go, and it ends `stopped`. */
  async #stop(job: string): Promise<void> {
    const whose = this.#running.get(job);
    if (!whose || this.#stopped.has(job)) return;
    this.#stopped.add(job);
    // Its token ends first, so the agent can neither call the gateway nor hand back while its logs are kept.
    await endJobToken(this.#o.sql, job).catch((error: Error) =>
      this.#o.log.error({ job, err: error }, 'could not end a job token'),
    );
    await this.#keepLogsWithin(job, whose, 'stopped', null);
    const jobs = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
    for (const part of JOB_PARTS) {
      await this.#o.kube
        .remove(`${jobs}/${job}-${part}`)
        .catch((error: Error) => this.#o.log.warn({ job, err: error }, 'could not delete a job'));
    }
    this.#o.log.info({ job }, 'the line stopped; the step’s jobs are deleted');
  }

  /** The work item needs its volume no more, merged or over: it goes. A volume already gone is no error. */
  async finish(workItem: string): Promise<void> {
    const path = `/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims/${volume(workItem).metadata.name}`;
    await this.#o.kube.remove(path);
    this.#o.log.info({ workItem }, 'the work item’s volume is deleted');
  }

  /** The addresses an agent pod needs, looked up here because it has no DNS of its own. */
  async #hosts(): Promise<{ ip: string; hostnames: string[] }[]> {
    const find = this.#o.lookup ?? (async (hostname: string) => (await lookup(hostname)).address);
    const names = [...new Set([this.#o.gatewayUrl, this.#o.handbackUrl].map((url) => new URL(url).hostname))];
    const hosts = await Promise.all(
      names.filter((name) => !isIP(name)).map(async (name) => ({ ip: await find(name), hostnames: [name] })),
    );
    return hosts;
  }

  /** Waits for a Job to end, and says how. */
  async #finished(
    path: string,
    withinSeconds: number,
  ): Promise<'succeeded' | 'failed' | 'ran out of time' | 'vanished'> {
    const until = this.#now() + withinSeconds * 1000;
    while (this.#now() < until) {
      // Outside the step's span: a read every poll, for as long as the step runs, would bury the step's calls.
      const job = await context.with(ROOT_CONTEXT, () => this.#o.kube.get(path, JOB));
      if (!job) return 'vanished';
      if (job.status?.succeeded) return 'succeeded';
      const failed = job.status?.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
      if (failed)
        return failed.reason === 'DeadlineExceeded' || (await this.#podOutOfTime(path)) ? 'ran out of time' : 'failed';
      await this.#sleep(this.#o.pollMs ?? 2_000);
    }
    return 'ran out of time';
  }

  /** Whether a failed Job's pod failed at its own deadline, which is how a step runs out of time. */
  async #podOutOfTime(path: string): Promise<boolean> {
    const name = path.split('/').at(-1) ?? '';
    const selector = encodeURIComponent(`job-name=${name},${NOT_RED_TEAM}`);
    try {
      const pods = await this.#o.kube.get(`/api/v1/namespaces/${NAMESPACE}/pods?labelSelector=${selector}`, PODS);
      return (pods?.items ?? []).some(
        (pod) => !isRedTeam(pod.metadata.labels) && pod.status?.reason === 'DeadlineExceeded',
      );
    } catch (error) {
      this.#o.log.warn({ job: name, err: error }, 'could not read why a job’s pod failed');
      return false;
    }
  }

  /** `POST /v1/handback`, for agent pods. */
  handback(): RequestListener {
    const send = (res: Parameters<RequestListener>[1], status: number, body: unknown): void =>
      void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    return async (req, res) => {
      const { pathname } = new URL(req.url ?? '/', 'http://line');
      if (pathname === '/health') return send(res, 200, { status: 'ok' });
      if (pathname !== '/v1/handback' || req.method !== 'POST') return send(res, 404, { error: 'not found' });
      try {
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
        const job = token ? await jobForToken(this.#o.sql, token) : undefined;
        if (!job) return send(res, 401, { error: 'This is not the token of a job that is running.' });
        const parsed = handbackBody.safeParse(JSON.parse(await readBody(req)));
        if (!parsed.success) {
          return send(res, 400, {
            error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
        }
        const waiting = this.#waiting.get(job.job);
        if (!waiting) return send(res, 409, { error: 'Nothing is waiting for this job to hand back.' });
        this.#waiting.delete(job.job);
        waiting(parsed.data as Handback);
        const { ending, patch } = parsed.data;
        this.#o.log.info(
          { job: job.job, workItem: job.workItem, agent: job.agent, ending, patch: patch.length },
          'handed back',
        );
        send(res, 202, { taken: true });
      } catch (error) {
        if (error instanceof TooLarge) return send(res, 413, { error: `The body is over ${MAX_BODY} bytes.` });
        if (error instanceof SyntaxError) return send(res, 400, { error: 'The body is not JSON.' });
        this.#o.log.error({ err: error }, 'the handback failed');
        send(res, 500, { error: 'The handback failed.' });
      }
    };
  }
}

/** A context's span, as the W3C headers would carry it: none when no span is active or telemetry is off. */
function traceOf(active: Context): { traceparent?: string } {
  const carrier: { traceparent?: string } = {};
  propagation.inject(active, carrier);
  return carrier;
}

/** What the prepare pod prints when the pins wait for Martin: the file he alone may change, and why. */
const HELD = z.strictObject({ path: z.string().min(1).max(200), reason: z.string().min(1).max(4000) });

/** Whether a patch changes a lockfile or pnpm's settings, which the pin step does not resolve a manifest with. */
const touchesSettings = (patch: string): boolean =>
  [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
    .flatMap(([, a = '', b = '']) => [a, b])
    .some((path) => inScope(path, [...LOCKFILES, ...PNPM_SETTINGS]));

/** How a step ended, as its logs are kept with it, and why when it failed. */
function endingOf(outcome: StepOutcome): [StepEnding, string | null] {
  if (outcome.kind === 'failed') return ['failed', outcome.reason];
  // No agent ran: the step stopped at the pins, which wait for Martin.
  if (outcome.kind === 'held') return ['stopped', outcome.reason];
  return [outcome.kind, null];
}

const messageOf = (error: unknown) => cutTo(error instanceof Error ? error.message : String(error), 4000);

const MAX_BODY = 2 * 1024 * 1024;

class TooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Read to the end even when it is too big, keeping none of it, so the refusal can be sent.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  }
  if (size > MAX_BODY) throw new TooLarge();
  return Buffer.concat(chunks).toString('utf-8');
}
