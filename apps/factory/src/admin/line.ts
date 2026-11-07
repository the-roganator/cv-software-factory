/**
 * Stopping and starting the line from the console's header, each with Martin's reason, for the audit log.
 *
 * - **Stop the line** (`POST /admin/line/stop`) appends `line.stopped`, the same event as `make stop-the-line`, which
 *   every worker heeds: each agent stops at the end of its step, and nothing new is taken. Then it aborts the canary in
 *   flight, if there is one, through the admin service's own Role on the app's Rollout (`rollout.ts`), as
 *   `scripts/abort-canaries.sh` does with Martin's credentials. The stop is appended first, so the agents stop even if
 *   Kubernetes cannot be reached; if the abort fails, the line stays stopped, and the answer says that the canary was
 *   not aborted and that `make stop-the-line` will abort it. A canary whose stable version has no pod ready to serve is
 *   left alone, and the answer says so: aborting it would leave nothing to serve the app. It never asks for the passkey
 *   again: it tightens.
 * - **Start the line** (`POST /admin/line/start`) appends `line.started`, and needs the passkey again (`line.start` in
 *   the access table). A release stopped with the line stays stopped until Martin retries it from the Canary panel.
 *
 * Each is refused, having appended nothing, when the line is already as asked: stopped, or running. A new store's line
 * has not started, and waits for Martin's first Start: Start starts it, and Stop is refused, with nothing to stop. They
 * are taken one at a time, under the lock every append takes, so two presses cannot both stop or both start it.
 *
 * `make stop-the-line` keeps its own path, which needs neither the console nor the admin service.
 *
 * **The line's controls** (`POST /admin/line/controls`), from the console's Controls: the autonomy level, whether
 * agents take new work, whether low-risk changes merge by themselves, what the line takes, and auto-rollback, within
 * policy (`policy/line.ts`). One change a request, and one `controls.changed` event, carrying every control as it now stands
 * and the one changed, with its value before and after.
 *
 * - Which action a change is (`autonomy.loosen`, `take.widen`, …) is decided from the controls in force as it is taken,
 *   read from the store under the lock every append takes, never from the request's word: the passkey again for one
 *   that loosens, asked again after the lock.
 * - A change outside policy is refused (422), having changed nothing: the next few beyond its most, or just one work
 *   item that is neither an open ticket nor an open improvement Martin asked for. The line checks what it reads again,
 *   whatever is written here.
 * - The next few count from when Martin chose them: any number chosen, larger, smaller or the same, counts again from
 *   then, so "the next two" are two from now.
 * - A change to what is already so records nothing.
 * - Auto-rollback switched off overrides a guardrail, so it needs the passkey again, and the line pages Martin from its
 *   event. It reaches the canary's analysis only through the two series the admin service and the line report of it
 *   (`auto-rollback.ts`, `release/analysis.ts`). Stopping the line still aborts a canary, whatever it says, as long as
 *   its stable version has a pod to take its traffic back.
 */
import { AUTONOMY } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import {
  askedByMartin,
  byMartin,
  lastEnd,
  latestControls,
  lineState,
  lockAppends,
  openedAsImprovement,
  storeClock,
} from '@software-factory/store';
import type { Logger } from 'pino';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import { ACCESS } from '../../../../policy/access.ts';
import {
  type ControlChange,
  type Controls,
  controlAction,
  controlsInForce,
  TAKE,
  type Take,
} from '../../../../policy/line.ts';
import type { ReleaseControls } from './rollout.ts';
import { type AdminStore, adminEvent, Refused, type Session, steppedUpNow } from './store.ts';

/**
 * Martin's reason, for the audit log: visitors see it, with anything shaped like a secret left out. Held to the
 * events' own rule for it, so a reason the route takes is one the store takes.
 */
export const REASON = z.strictObject({ reason: PAYLOADS['line.stopped'].shape.reason });

/**
 * What stopping the line did: the line is stopped, and the canary in flight was aborted, or there was none, or it could
 * not be aborted, or it was left alone (`kept`).
 */
export interface Stopped {
  stopped: true;
  /** `kept`: left alone, its stable version having no pod ready to serve. */
  canary: 'aborted' | 'none' | 'not-aborted' | 'kept';
  /** The release aborted, or left alone because its stable version has no pod ready to serve. */
  release?: string;
  /**
   * Whether the abort's control was recorded: not for a release the line had not recorded yet, nor when the store did
   * not take it. The line tells the abort by the stop just before, then.
   */
  recorded?: boolean;
  /** What Martin must know: the canary was not aborted, or his pause of it is still set. */
  warning?: string;
}

/** What the answer says when the canary in flight could not be aborted. */
export const NOT_ABORTED =
  'The line is stopped, but a canary in flight was not aborted: the admin service could not read the release or ' +
  'patch the Rollout. Run `make stop-the-line`, which will abort it if its stable version has a pod ready to serve.';

/** What the answer says when the canary was left alone, its stable version having no pod to take its traffic back. */
export const NO_STABLE =
  'The line is stopped, but the canary in flight was not aborted: its stable version has no pod ready to serve, so ' +
  'aborting it would leave nothing to serve the app. Whether it goes out is yours: promote it fully or pause it from ' +
  'the Canary panel, or with `kubectl argo rollouts` while the panel has no record of it.';

/** What the answer says when the admin service has no Rollout to control. */
export const NO_ROLLOUT =
  'The line is stopped. The admin service controls no Rollout, so it aborted no canary: if one is in flight, ' +
  '`make stop-the-line` will abort it.';

/** Stops the line with Martin's reason, then aborts the canary in flight; or refuses a line already stopped. */
export async function stopLine(
  store: AdminStore,
  controls: ReleaseControls | undefined,
  log: Logger,
  reason: string,
): Promise<Stopped> {
  await store.record(
    async (tx) => {
      await lockAppends(tx);
      const state = await lineState(tx);
      if (state === 'stopped') throw new Refused('line', 409, 'The line is stopped already.');
      if (state === 'not-started')
        throw new Refused('line', 409, 'The line has not started: there is nothing to stop.');
    },
    () => [adminEvent('line.stopped', 'Martin stopped the line', { reason })],
  );
  if (!controls) return { stopped: true, canary: 'not-aborted', warning: NO_ROLLOUT };
  try {
    const abort = await controls.stop();
    if (abort.canary === 'none') return { stopped: true, canary: 'none' };
    if (abort.canary === 'kept') {
      return { stopped: true, canary: 'kept', release: abort.release, warning: NO_STABLE };
    }
    return {
      stopped: true,
      canary: 'aborted',
      release: abort.release,
      recorded: abort.recorded,
      ...(abort.warning && { warning: abort.warning }),
    };
  } catch (error) {
    // With no Rollout of the app, there is no canary to abort.
    if (error instanceof Refused && error.refused === 'rollout') return { stopped: true, canary: 'none' };
    log.error({ err: error }, 'the line stopped, and the canary in flight could not be aborted');
    return { stopped: true, canary: 'not-aborted', warning: NOT_ABORTED };
  }
}

/** Starts the line with Martin's reason, the passkey given again; or refuses a line already running. */
export async function startLine(store: AdminStore, session: Session, reason: string): Promise<{ started: true }> {
  await store.record(
    async (tx) => {
      await lockAppends(tx);
      if ((await lineState(tx)) === 'running') throw new Refused('line', 409, 'The line is running already.');
      // Asked again as the start is taken, after the lock: the passkey given may have gone stale while it waited.
      if (!(await steppedUpNow(tx, session))) throw new Refused('step-up', 403, 'This needs your passkey again.');
    },
    () => [adminEvent('line.started', 'Martin started the line', { reason })],
  );
  return { started: true };
}

/** One change of one control, as Controls sends it. */
export const CHANGE = z.union([
  z.strictObject({ autonomy: z.enum(AUTONOMY) }),
  z.strictObject({ newWork: z.boolean() }),
  z.strictObject({ autoMerge: z.boolean() }),
  z.strictObject({ autoRollback: z.boolean() }),
  z.strictObject({
    take: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('every') }),
      z.strictObject({ kind: z.literal('next-few'), count: z.number() }),
      z.strictObject({ kind: z.literal('just-one'), workItem: z.string().max(20) }),
    ]),
  }),
]);
export type Change = z.infer<typeof CHANGE>;

/** What a change did: the controls now in force, and the change, or none when it was so already. */
export interface Changed {
  controls: Controls;
  change: ControlChange | null;
}

const AUTONOMY_WORDS = { supervised: 'Supervised', guarded: 'Guarded', 'lights-out': 'Lights-out' } as const;

/** A take in words, as the summary says it: the next few count from the change, whatever came before. */
const takeWords = (take: Take) =>
  take.kind === 'every'
    ? 'every ticket'
    : take.kind === 'next-few'
      ? `the next ${take.count === 1 ? 'one' : `${take.count}`} from now`
      : `just #${take.workItem}`;

/** The summary of a change, in the console's words. */
export function changeSummary(change: ControlChange): string {
  switch (change.control) {
    case 'autonomy': {
      const how = controlAction(change) === 'autonomy.loosen' ? 'loosened' : 'tightened';
      return `Martin ${how} autonomy from ${AUTONOMY_WORDS[change.before]} to ${AUTONOMY_WORDS[change.after]}`;
    }
    case 'new-work':
      return change.after ? 'Martin let agents take new work again' : 'Martin stopped agents taking new work';
    case 'auto-merge':
      return change.after
        ? 'Martin turned on auto-merge of low-risk changes'
        : 'Martin turned off auto-merge of low-risk changes';
    case 'take': {
      const how = controlAction(change) === 'take.widen' ? 'widened' : 'narrowed';
      return `Martin ${how} what the line takes to ${takeWords(change.after)}`;
    }
    case 'auto-rollback':
      return change.after
        ? 'Martin turned on auto-rollback: a canary judged bad rolls back by itself'
        : 'Martin turned off auto-rollback: a canary whose errors or latency are judged bad pauses for him';
  }
}

/**
 * The change asked for, against the controls in force: the next few start now, whatever came before. Unchecked: a
 * number outside policy stays as given, and is refused.
 */
function changeOf(before: Controls, asked: Change, now: string): ControlChange {
  if ('autonomy' in asked) return { control: 'autonomy', before: before.autonomy, after: asked.autonomy };
  if ('newWork' in asked) return { control: 'new-work', before: before.newWork, after: asked.newWork };
  if ('autoMerge' in asked) return { control: 'auto-merge', before: before.autoMerge, after: asked.autoMerge };
  if ('autoRollback' in asked) {
    return { control: 'auto-rollback', before: before.autoRollback, after: asked.autoRollback };
  }
  const { take } = asked;
  const after: Take = take.kind === 'next-few' ? { kind: 'next-few', count: take.count, since: now } : take;
  return { control: 'take', before: before.take, after };
}

/** Whether a change leaves its control as it was. */
const same = (change: ControlChange) => JSON.stringify(change.before) === JSON.stringify(change.after);

/** The controls with a change made. */
function withChange(controls: Controls, change: ControlChange): Controls {
  switch (change.control) {
    case 'autonomy':
      return { ...controls, autonomy: change.after };
    case 'new-work':
      return { ...controls, newWork: change.after };
    case 'auto-merge':
      return { ...controls, autoMerge: change.after };
    case 'take':
      return { ...controls, take: change.after };
    case 'auto-rollback':
      return { ...controls, autoRollback: change.after };
  }
}

/**
 * Whether a work item is real work the line can take, and has not closed: one with a ticket, as `Queue.admit` reads it,
 * or an improvement Martin asked for, its opening and his request both appended by one of his roles.
 */
async function openWork(tx: TransactionSql, workItem: string): Promise<boolean> {
  const [row] = await tx`
    select 1 from events t
    where t.work_item = ${workItem} and not t.sample
      and ((t.type = 'ticket.opened' and not ${openedAsImprovement(tx, 't.work_item')})
           or (t.type = 'improvement.requested' and ${byMartin(tx, 't')} and ${askedByMartin(tx, 't.work_item')}))
      and ${lastEnd(tx, 't.work_item')} is distinct from 'work-item.closed'
    limit 1`;
  return row !== undefined;
}

/**
 * The change asked for, decided against the controls in force, read under the lock every append takes: the controls
 * after it and the change, or none when it is so already; or refused, as outside policy, having changed nothing. Whether
 * it needs the passkey again is the caller's to ask: the console's change asks it, and `make take-the-line`, from
 * Martin's own command line, needs none, as `make start-the-line` needs none.
 */
export async function decideChange(tx: TransactionSql, asked: Change): Promise<Changed> {
  await lockAppends(tx);
  const { outside: _, ...before } = controlsInForce(await latestControls(tx));
  // The store's clock, to the microsecond, as the line counts the next few by when each work item came onto it.
  const change = changeOf(before, asked, await storeClock(tx));
  if (same(change)) return { controls: before, change: null };
  const after = withChange(before, change);
  // Only a take can be: the request's shape holds the rest to what policy allows.
  if (controlsInForce(after).outside.length) {
    const why =
      change.control === 'take' && change.after.kind === 'next-few'
        ? `the next few are 1 to ${TAKE.most} work items`
        : 'just one is a work item, by its number';
    throw new Refused('policy', 422, `That is outside policy: ${why}.`);
  }
  if (change.control === 'take' && change.after.kind === 'just-one' && !(await openWork(tx, change.after.workItem))) {
    const why = `#${change.after.workItem} has no open ticket or improvement for the line to take.`;
    throw new Refused('policy', 422, why);
  }
  return { controls: after, change };
}

/** The event that records a change: every control as it now stands, and the one changed. */
export const changedEvent = (controls: Controls, change: ControlChange) =>
  adminEvent('controls.changed', changeSummary(change), { ...controls, change });

/** Makes one change of the line's controls, or refuses having changed nothing. */
export async function changeControls(store: AdminStore, session: Session, asked: Change): Promise<Changed> {
  return store.record(
    async (tx) => {
      const decided = await decideChange(tx, asked);
      // Asked as the change is taken, after the lock, from the controls in force: the passkey given may have gone
      // stale while it waited.
      if (decided.change && ACCESS[controlAction(decided.change)].stepUp && !(await steppedUpNow(tx, session))) {
        throw new Refused('step-up', 403, 'This needs your passkey again.');
      }
      return decided;
    },
    ({ controls, change }) => (change ? [changedEvent(controls, change)] : []),
  );
}
