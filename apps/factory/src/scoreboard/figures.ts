/**
 * The scoreboard's figures: the store's tickets counted against the answer key, by the rule in `policy/scoreboard.ts`.
 * Pure functions of the events and the key, recomputed whole on every pass, so nothing about which ticket found which
 * entry is kept anywhere: it lives for the length of a call.
 *
 * - **found:** entries a ticket has found. A ticket counts once it is before the last boundary of the slow cadence,
 *   and an entry verified fixed counts at once, so found is never below verified, and stays found if its ticket
 *   reopens.
 * - **verified:** entries a ticket that found them is verified fixed, now: the last of its work item's closes and
 *   reopenings is a close as `verified`, and its last verification, if it has one, is not a dry run's. A Verify hold
 *   Martin approved closes as verified with no verification, and counts. A reopened ticket drops out until it is
 *   verified again.
 * - **median:** for each verified entry, the quickest of its verified tickets, from the first signal on the ticket's
 *   work item, or its `ticket.opened` when that is sooner (a ticket Martin approved has no signal until one joins it,
 *   maybe after its close), to its verified close; the median of those, in milliseconds. The signal's time is
 *   triage's, when it made the event: a sense saw it moments before.
 * - **false positives:** tickets that found no entry. A dependency's ticket, a move's, counts for nothing, found or false
 *   positive (`counts`). They are never published as they change, which would say of
 *   each new ticket whether it was real; `factory scoreboard --print` prints them for the results.
 */
import type { PayloadOf } from '@software-factory/events';
import { counts, type Fingerprint, type KeyEntry, matches, SCOREBOARD } from '../../../../policy/scoreboard.ts';

/** The events the figures read, in the store's order: on a work item, each with what the figures need of it. */
export type ScoreEvent = { ts: string; work_item: string } & (
  | { type: 'ticket.opened'; payload: Pick<PayloadOf<'ticket.opened'>, 'fingerprint'> }
  | { type: 'work-item.closed'; payload: Pick<PayloadOf<'work-item.closed'>, 'outcome'> }
  | { type: 'verification.finished'; payload: Pick<PayloadOf<'verification.finished'>, 'dryRun'> }
  | { type: 'signal.rechecked'; payload: Pick<PayloadOf<'signal.rechecked'>, 'outcome'> }
  | { type: 'signal.received' }
  | { type: 'work-item.reopened' }
);

export const SCORE_TYPES = [
  'ticket.opened',
  'signal.received',
  'work-item.closed',
  'work-item.reopened',
  'verification.finished',
  'signal.rechecked',
] as const satisfies readonly ScoreEvent['type'][];

/** A ticket as the figures see it. */
export interface Ticket {
  fingerprint: PayloadOf<'ticket.opened'>['fingerprint'];
  openedAt: number;
  /** Its first signal, or its opening when that is sooner or it has none: where its time to a fix starts. */
  startedAt: number;
  /** Its verified close while it counts as verified, or null. */
  verifiedAt: number | null;
  /** Whether it was ever verified: it found its entry, if any, though it has reopened since. */
  everVerified: boolean;
}

/** Every ticket in the events, as of the last of them. */
export function tickets(events: readonly ScoreEvent[]): Ticket[] {
  interface Life {
    opened?: { at: number; fingerprint: Ticket['fingerprint'] };
    firstSignal?: number;
    end?: { at: number; verified: boolean };
    dryRun: boolean;
    everVerified: boolean;
  }
  const lives = new Map<string, Life>();
  for (const event of events) {
    const life = lives.get(event.work_item) ?? { dryRun: false, everVerified: false };
    lives.set(event.work_item, life);
    const at = Date.parse(event.ts);
    if (event.type === 'ticket.opened') life.opened = { at, fingerprint: event.payload.fingerprint };
    else if (event.type === 'signal.received') life.firstSignal ??= at;
    else if (event.type === 'work-item.closed') life.end = { at, verified: event.payload.outcome === 'verified' };
    else if (event.type === 'work-item.reopened') life.end = { at, verified: false };
    else if (event.type === 'verification.finished') life.dryRun = event.payload.dryRun;
    // A look again that cleared is a real sense's, on a real release, whatever a dry run verified before.
    else if (event.payload.outcome === 'cleared') life.dryRun = false;
    // Judged as each event comes, so a close is read with the verification before it.
    if (life.end?.verified && !life.dryRun) life.everVerified = true;
  }
  return [...lives.values()].flatMap(({ opened, firstSignal, end, dryRun, everVerified }) =>
    opened
      ? [
          {
            fingerprint: opened.fingerprint,
            openedAt: opened.at,
            startedAt: Math.min(firstSignal ?? opened.at, opened.at),
            verifiedAt: end?.verified && !dryRun ? end.at : null,
            everVerified,
          },
        ]
      : [],
  );
}

export interface Figures {
  entries: number;
  found: number;
  verified: number;
  medianMs: number | null;
  falsePositives: number;
}

/** Whether a ticket finds an entry, by the policy's rule: only a ticket that counts (`counts`) finds one. */
const finds = (ticket: Ticket, entry: KeyEntry) =>
  counts(ticket.fingerprint) && matches(ticket.fingerprint as Fingerprint, entry.fingerprint);

/**
 * The figures for the key, counting as found only what tickets opened before `foundBefore` found (and every entry
 * verified). The scoreboard passes the last boundary of its cadence; `--print` passes now.
 */
export function figures(all: readonly Ticket[], key: readonly KeyEntry[], foundBefore: number): Figures {
  let found = 0;
  const fixes: number[] = [];
  for (const entry of key) {
    const finders = all.filter((ticket) => finds(ticket, entry));
    const times = finders.flatMap((t) => (t.verifiedAt === null ? [] : [t.verifiedAt - t.startedAt]));
    if (times.length) fixes.push(Math.min(...times));
    if (times.length || finders.some((t) => t.everVerified || t.openedAt < foundBefore)) found++;
  }
  // A dependency's ticket is neither found nor a false positive: it does not count (`counts`).
  const falsePositives = all.filter((t) => counts(t.fingerprint) && !key.some((entry) => finds(t, entry))).length;
  return { entries: key.length, found, verified: fixes.length, medianMs: median(fixes), falsePositives };
}

/** The last boundary of the cadence at or before `now`: every `foundEveryHours` from midnight UTC. */
export function lastBoundary(now: number, everyHours: number = SCOREBOARD.foundEveryHours): number {
  const every = everyHours * 3_600_000;
  return Math.floor(now / every) * every;
}

/** The median, to the nearest millisecond, or null of nothing. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Math.round(Math.max(0, value ?? 0));
}
