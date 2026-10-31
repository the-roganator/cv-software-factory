/**
 * Martin's security events, and the holds that wait for him, counted from the stored events for the alerts that reach
 * his phone (docs/COMPONENTS/ALERTING.md). The line counts them, not the admin service, which appends most of them: a
 * compromised admin service cannot keep its own actions quiet, as it can neither reach the line nor change an event
 * once stored. Each is told from the stored event alone, never from anything the admin service says of it, and counted
 * whatever role appended it, but a guardrail's proof: row security keeps any role but Martin's from appending his
 * commands, and a refused append is no event. A proof is counted only from the proofs' role, which row security holds
 * it to as well, so a hole in that policy is not the only lock.
 *
 * The security events, each a `kind`:
 * - `sign-in`: `admin.signed-in`;
 * - `passkey-enrolled` and `passkey-revoked`;
 * - `setting-changed`: every `settings.changed`;
 * - the actions the access table marks as needing the passkey again, each as the action it is: `release-control` (a
 *   `release.controlled` that promotes or retries), `guardrail-approved` (a `hold.answered` approving a hold whose
 *   cause is a guardrail, read from the hold it answers: the latest on its work item before it, which is the hold the
 *   line takes it to answer, so an approval counts as what it does), `improvement-requested` (every
 *   `improvement.requested`), `improvement-approved` (a `hold.answered` approving a `spec` hold, read as above, on a
 *   work item opened as an improvement, whoever opened it), and `line-started`. Giving the passkey again
 *   (`admin.stepped-up`) is not counted: each action it lets the session take is, and the audit log keeps the event;
 * - `line-stopped`: every `line.stopped`, which tightens and so needs no passkey again, but which Martin is still told of;
 * - every change of the line's controls (`controls.changed`), as the access table's action it is, told from the
 *   stored change's before and after alone (`policy/line.ts`): `autonomy-loosened` and `autonomy-tightened`,
 *   `new-work-on` and `new-work-off`, `auto-merge-on` and `auto-merge-off`, `take-widened` and `take-narrowed`,
 *   `auto-rollback-off` (which overrides a guardrail, and pages) and `auto-rollback-on`. Auto-rollback is counted from
 *   what the event puts in force too, as its two series read it (`auto-rollback.ts`): an event that turns it off or on
 *   while its change names another control counts as that as well (`switchedAutoRollback`), so a role that can append
 *   Martin's controls cannot turn it off under a change that only informs him. What it puts in force is followed, in
 *   order, through the events the series follow alone (`latestControls`: his roles', of any version), so the tally's
 *   "before" is the series' and a switch is neither missed nor counted twice;
 * - every move of a feature flag's stage (`flag.staged`), as the access table's action it is, told from the stored
 *   stages before and after alone (`policy/flag-moves.ts`): `flag-widened` for every widening (Off to Checks, past it,
 *   a larger share, and turning a flag back on for everyone), `flag-narrowed`, and `flag-off`;
 * - every switch of alerts to the phone (`alerts.switched`), by whether they reach it now: `phone-on` and `phone-off`;
 * - `guardrail-not-held`: every guardrail's proof that did not hold (`guardrail.proved`, `held: false`) that the
 *   proofs' role appended, which alone may (`make guardrails`). One that held is not counted: a refusal or a proof
 *   holding is the guardrail working, and tells Martin nothing.
 *
 * And every hold started, by its cause, whoever started it.
 *
 * Both are counts of what the store holds, read each time the SDK collects, as the line's stages are: a line that
 * restarts, or a second replica, reports the same figure, so a count never falls and a reader takes the `max`. Every
 * kind and cause is reported, with none as 0, so the first of each is an increase from 0 and pages too. Events commit
 * in `seq` order (0001_events.sql), so each read counts only those after the last it read, by the primary key: the
 * events table is read whole once, when the line starts. A read that fails counts nothing new, and says so, in a gauge
 * and the log: the alert on the count going stale or missing pages instead.
 */
import { type BatchObservableResult, metrics } from '@opentelemetry/api';
import { HOLD_CAUSES, type HoldCause, type ReleaseControl, upcast } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { fromMartin, openedAsImprovement } from '@software-factory/store';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { GUARDRAIL_HOLDS } from '../../../../policy/access.ts';
import { type FlagAction, flagAction } from '../../../../policy/flag-moves.ts';
import type { Stage } from '../../../../policy/flags.ts';
import { type ControlAction, type ControlChange, controlAction, controlsInForce } from '../../../../policy/line.ts';
import type { STORE_GRANTS } from '../../../../policy/store-grants.ts';
import type { Logger } from '../log.ts';

const meter = metrics.getMeter('factory-line');

/** The one role whose proofs are trusted (0043_guardrail-proofs.sql). */
const PROOFS_ROLE = 'factory_proofs' satisfies keyof typeof STORE_GRANTS;

/** Every kind of security event counted, as its `kind` label. */
export const SECURITY_KINDS = [
  'sign-in',
  'passkey-enrolled',
  'passkey-revoked',
  'setting-changed',
  'release-control',
  'guardrail-approved',
  'line-started',
  'line-stopped',
  'autonomy-loosened',
  'autonomy-tightened',
  'new-work-on',
  'new-work-off',
  'auto-merge-on',
  'auto-merge-off',
  'take-widened',
  'take-narrowed',
  'auto-rollback-off',
  'auto-rollback-on',
  'flag-widened',
  'flag-narrowed',
  'flag-off',
  'improvement-requested',
  'improvement-approved',
  'phone-on',
  'phone-off',
  'guardrail-not-held',
] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];

/**
 * The controls of a release that need the passkey again, as the access table marks `release.promote` and
 * `release.retry`: a test holds the two to each other.
 */
export const STEPPED_UP_CONTROLS: readonly ReleaseControl[] = ['promote', 'promote-fully', 'retry'];

/** The event types read: each security event's, and a hold's start. */
const TYPES = [
  'admin.signed-in',
  'passkey.enrolled',
  'passkey.revoked',
  'settings.changed',
  'release.controlled',
  'hold.answered',
  'line.started',
  'line.stopped',
  'controls.changed',
  'flag.staged',
  'improvement.requested',
  'alerts.switched',
  'guardrail.proved',
  'hold.started',
] as const;

/** One stored event, as far as counting it goes. */
export interface Stored {
  type: string;
  /** A release control's action. */
  action?: string | null;
  /** An answer's decision. */
  decision?: string | null;
  /** A hold's cause; for an answer, the cause of the hold it answers. */
  cause?: string | null;
  /** A change of the line's controls: the one control, with its value before and after. */
  change?: unknown;
  /** A move of a flag's stage: the stages before and after. */
  staged?: unknown;
  /** For an answer, whether its work item was opened as an improvement. */
  improvement?: boolean | null;
  /** A switch of alerts to the phone: whether they reach it now. */
  phone?: unknown;
  /** A change of the line's controls: whether auto-rollback is on after it, as stored. */
  autoRollback?: unknown;
  /** A guardrail's proof: whether it held. */
  held?: unknown;
  /** The role that appended it, as the store recorded it. */
  appendedBy?: string | null;
}

/** The kind each move of a flag's stage counts as, by the access table's action it is. */
const FLAG_KINDS: Record<FlagAction, SecurityKind> = {
  'flag.to-checks': 'flag-widened',
  'flag.widen': 'flag-widened',
  'flag.back-on': 'flag-widened',
  'flag.narrow': 'flag-narrowed',
  'flag.off': 'flag-off',
};

const { from, to } = PAYLOADS['flag.staged'].shape;
const STAGES_MOVED = z.object({ from, to });

/** A stored move, if it is one as the event's schema has it, so a malformed row is counted as nothing. */
function movedOf(value: unknown): { from: Stage | null; to: Stage } | undefined {
  const read = STAGES_MOVED.safeParse(value);
  return read.success ? (read.data as { from: Stage | null; to: Stage }) : undefined;
}

/** The kind each change of the line's controls counts as, by the access table's action it is. */
const CONTROL_KINDS: Record<ControlAction, SecurityKind> = {
  'autonomy.loosen': 'autonomy-loosened',
  'autonomy.tighten': 'autonomy-tightened',
  'new-work.on': 'new-work-on',
  'new-work.off': 'new-work-off',
  'auto-merge.on': 'auto-merge-on',
  'auto-merge.off': 'auto-merge-off',
  'take.widen': 'take-widened',
  'take.narrow': 'take-narrowed',
  'auto-rollback.off': 'auto-rollback-off',
  'auto-rollback.on': 'auto-rollback-on',
};

/** A stored change, if it is one as the event's schema has it, so a malformed row is counted as nothing. */
function changeOf(value: unknown): ControlChange | undefined {
  const read = PAYLOADS['controls.changed'].shape.change.safeParse(value);
  return read.success ? (read.data as ControlChange) : undefined;
}

/**
 * A hold's cause, as the factory reads it: upcast, so a hold stored before holds had causes reads as the cause its kind
 * and stage imply, as the line itself reads it.
 */
function causeOf(row: { hold_version: number | null; hold_payload: Record<string, unknown> | null }): string | null {
  if (row.hold_version === null || row.hold_payload === null) return null;
  const read = upcast({ type: 'hold.started', version: row.hold_version, payload: row.hold_payload });
  return read.ok ? String((read.event.payload as { cause?: unknown }).cause ?? '') : null;
}

/**
 * Whether auto-rollback is on after a change of the line's controls, as the workers that report it read the event
 * (`controlsInForce`): anything but a boolean is policy's default, on.
 */
export const autoRollbackAfter = (event: Stored): boolean =>
  controlsInForce({ autoRollback: event.autoRollback }).autoRollback;

/**
 * The switch of auto-rollback a change of the line's controls makes that its change does not name, from whether it was
 * on before (the controls in force after the change before it), or nothing: off from on is `auto-rollback-off`, on from
 * off `auto-rollback-on`.
 */
export function switchedAutoRollback(before: boolean, event: Stored): SecurityKind | null {
  const after = autoRollbackAfter(event);
  if (after === before) return null;
  const kind: SecurityKind = after ? 'auto-rollback-on' : 'auto-rollback-off';
  const change = changeOf(event.change);
  return change && CONTROL_KINDS[controlAction(change)] === kind ? null : kind;
}

/** What a stored event counts as: a security event of a kind, a hold of a cause, or nothing. */
export function countAs(event: Stored): { kind: SecurityKind } | { hold: HoldCause } | null {
  switch (event.type) {
    case 'admin.signed-in':
      return { kind: 'sign-in' };
    case 'passkey.enrolled':
      return { kind: 'passkey-enrolled' };
    case 'passkey.revoked':
      return { kind: 'passkey-revoked' };
    case 'settings.changed':
      return { kind: 'setting-changed' };
    case 'line.started':
      return { kind: 'line-started' };
    case 'line.stopped':
      return { kind: 'line-stopped' };
    case 'controls.changed': {
      const change = changeOf(event.change);
      return change ? { kind: CONTROL_KINDS[controlAction(change)] } : null;
    }
    case 'flag.staged': {
      const moved = movedOf(event.staged);
      const action = moved && flagAction(moved.from, moved.to);
      return action ? { kind: FLAG_KINDS[action] } : null;
    }
    case 'release.controlled':
      return STEPPED_UP_CONTROLS.includes(event.action as ReleaseControl) ? { kind: 'release-control' } : null;
    case 'improvement.requested':
      return { kind: 'improvement-requested' };
    case 'alerts.switched':
      return typeof event.phone === 'boolean' ? { kind: event.phone ? 'phone-on' : 'phone-off' } : null;
    // Only the proofs' role may append a proof, and only theirs is trusted: one any other role appended, which only a
    // failure of row security would let happen, is no proof.
    case 'guardrail.proved':
      return event.held === false && event.appendedBy === PROOFS_ROLE ? { kind: 'guardrail-not-held' } : null;
    case 'hold.answered':
      if (event.decision !== 'approved') return null;
      if ((GUARDRAIL_HOLDS as readonly string[]).includes(event.cause ?? '')) return { kind: 'guardrail-approved' };
      return event.cause === 'spec' && event.improvement ? { kind: 'improvement-approved' } : null;
    case 'hold.started':
      return {
        hold: (HOLD_CAUSES as readonly string[]).includes(event.cause ?? '') ? (event.cause as HoldCause) : 'unknown',
      };
    default:
      return null;
  }
}

/** The counts so far, and the last event they have read. */
export interface Tally {
  seq: string;
  /**
   * Whether auto-rollback was on after the last change of the line's controls read that the series follow (one of
   * Martin's roles appended): policy's default before any.
   */
  autoRollback: boolean;
  kinds: Record<SecurityKind, number>;
  holds: Record<HoldCause, number>;
}

export const emptyTally = (): Tally => ({
  seq: '0',
  autoRollback: controlsInForce().autoRollback,
  kinds: Object.fromEntries(SECURITY_KINDS.map((kind) => [kind, 0])) as Record<SecurityKind, number>,
  holds: Object.fromEntries(HOLD_CAUSES.map((cause) => [cause, 0])) as Record<HoldCause, number>,
});

/**
 * The tally with every event stored after its last added, up to the last event stored now. One statement, so what it
 * counts and the last `seq` it says it read are of one snapshot; an answer's hold is read by its work item's index.
 * Read in the order stored, as auto-rollback in force is followed from one change to the next.
 */
export async function readOn(sql: Sql, tally: Tally): Promise<Tally> {
  const rows = await sql<
    {
      last: string | null;
      type: string | null;
      action: string | null;
      decision: string | null;
      change: unknown;
      staged: unknown;
      improvement: boolean | null;
      phone: unknown;
      auto_rollback: unknown;
      held: unknown;
      appended_by: string | null;
      in_force: boolean | null;
      hold_version: number | null;
      hold_payload: Record<string, unknown> | null;
    }[]
  >`
    with upto as (select max(seq) as last from events)
    select upto.last::text as last, e.type, e.payload->>'action' as action, e.payload->>'decision' as decision,
           e.payload->'change' as change, e.payload->'phone' as phone, e.payload->'autoRollback' as auto_rollback,
           e.payload->'held' as held, e.appended_by,
           e.type = 'controls.changed' and ${fromMartin(sql, 'e')} as in_force,
           case when e.type = 'flag.staged' then jsonb_build_object('from', e.payload->'from', 'to', e.payload->'to')
           end as staged,
           case when e.type = 'hold.answered' then ${openedAsImprovement(sql, 'e.work_item')} end as improvement,
           h.version as hold_version, h.payload as hold_payload
    from upto
    left join events e
      on e.seq > ${tally.seq}::bigint and e.seq <= upto.last and e.type in ${sql([...TYPES])} and not e.sample
    left join lateral (
      select e.version, e.payload where e.type = 'hold.started'
      union all
      (select a.version, a.payload from events a
       where e.type = 'hold.answered' and a.work_item = e.work_item and a.type = 'hold.started' and a.seq < e.seq
       order by a.seq desc limit 1)
    ) h on true
    order by e.seq`;
  const next: Tally = {
    seq: rows[0]?.last ?? tally.seq,
    autoRollback: tally.autoRollback,
    kinds: { ...tally.kinds },
    holds: { ...tally.holds },
  };
  for (const row of rows) {
    if (!row.type) continue;
    const stored: Stored = {
      type: row.type,
      action: row.action,
      decision: row.decision,
      change: row.change,
      staged: row.staged,
      improvement: row.improvement,
      phone: row.phone,
      autoRollback: row.auto_rollback,
      held: row.held,
      appendedBy: row.appended_by,
      cause: causeOf(row),
    };
    const counted = countAs(stored);
    if (counted && 'kind' in counted) next.kinds[counted.kind] += 1;
    else if (counted) next.holds[counted.hold] += 1;
    if (row.in_force) {
      const switched = switchedAutoRollback(next.autoRollback, stored);
      if (switched) next.kinds[switched] += 1;
      next.autoRollback = autoRollbackAfter(stored);
    }
  }
  return next;
}

const securityEvents = meter.createObservableCounter('line.security_events', {
  description:
    'Martin’s security events the store holds, by kind: sign-ins, passkeys, settings, the line’s controls and the actions that need the passkey again',
});

const holdsStored = meter.createObservableCounter('line.holds.stored', {
  description: 'Holds for Martin the store holds, by cause, whoever started them',
});

const counting = meter.createObservableGauge('line.security_events.counting', {
  description: 'Whether the last read of Martin’s security events from the store succeeded: 1 if it did, 0 if not',
});

/**
 * Reports the counts from the store each time the SDK collects, until the function it gives back is called. A read
 * that fails reports no new count, and says so: `line.security_events.counting` is 0, and the log says it once until a
 * read succeeds again. The SDK goes on sending the last count it had, so the gauge, not the count, says it is stale.
 */
export function observeSecurity(sql: Sql, log: Logger): () => void {
  let tally = emptyTally();
  let failing = false;
  const callback = async (result: BatchObservableResult) => {
    try {
      tally = await readOn(sql, tally);
    } catch (error) {
      if (!failing) log.warn({ err: error }, 'could not count Martin’s security events: the count is stale');
      failing = true;
      result.observe(counting, 0);
      return;
    }
    if (failing) log.info('counting Martin’s security events again');
    failing = false;
    result.observe(counting, 1);
    for (const kind of SECURITY_KINDS) result.observe(securityEvents, tally.kinds[kind], { kind });
    for (const cause of HOLD_CAUSES) result.observe(holdsStored, tally.holds[cause], { cause });
  };
  const observed = [securityEvents, holdsStored, counting];
  meter.addBatchObservableCallback(callback, observed);
  return () => meter.removeBatchObservableCallback(callback, observed);
}
