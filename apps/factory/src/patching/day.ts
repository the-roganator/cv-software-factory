/**
 * The day, as `patching.read` holds it: a pure function of what the GitHub worker read for each repository (its moves,
 * checked against its scan's state, the pins that wait, and the pull requests and issues that carry its moves), of the
 * rows the cluster's comparison made, and of when the sense read.
 *
 * A move keeps what `moves.json` says of it. A lockfile's move, which the artifact names by its file alone, carries its
 * package apart (`package`), from the scan's state, for the public view to leave out.
 *
 * Why a scan failed is what its own totals count: one past its deadline, one due within a day, a new High or Critical
 * with a fix; and `other` when none does, or it wrote no totals at all. The scan's log is the reason's own words; the
 * sense reads no log.
 */
import type { MoveLane, PayloadOf, ScanFailure, ScanSeverity } from '@software-factory/events';
import { MOST_MOVES, MOST_PINS, MOST_PULLS, MOST_ROWS, SETTLED_DAYS } from '@software-factory/events/schemas';
import type { Moves, ReadMove, ReadWaiting } from '../github/scanning.ts';
import type { Counts, MovesFile } from '../vulnerabilities/moves.ts';
import type { Row } from './compare.ts';

export type Day = PayloadOf<'patching.read'>;
type DayMove = Day['repositories'][number]['moves'][number];
type DayWaiting = Day['repositories'][number]['waiting'][number];
/** A pull request or issue that carries a move, as the GitHub worker's `pulls` read gives it. */
export type PatchPull = Day['repositories'][number]['pulls'][number];

/** What the worker read for one repository: its moves, and the pull requests and issues that carry them. */
export interface RepositoryRead {
  moves: Moves;
  pulls: PatchPull[];
}

const counts = (from: Counts): Record<ScanSeverity, number> => ({
  critical: from.CRITICAL,
  high: from.HIGH,
  medium: from.MEDIUM,
  low: from.LOW,
  unknown: from.UNKNOWN,
});

function dayMove(move: ReadMove): DayMove {
  return {
    name: move.name,
    pins: move.pins.slice(0, MOST_PINS),
    from: move.from,
    to: move.to,
    major: move.major,
    clears: counts(move.clears),
    leaves: counts(move.leaves),
    ...(move.deadline ? { deadline: move.deadline } : {}),
    newToday: move.newToday,
    lane: move.lane as MoveLane,
    lockfile: move.lockfile,
    ...(move.lockfile && move.withheld
      ? {
          package: {
            name: move.withheld.package,
            from: move.withheld.from,
            to: move.withheld.to,
            pins: move.withheld.pins.slice(0, MOST_PINS),
          },
        }
      : {}),
  };
}

/** A pin that waits, as the day holds it: what `moves.json` says of it, without its findings or its place there. */
function dayWaiting(wait: ReadWaiting): DayWaiting {
  return {
    name: wait.name,
    pins: wait.pins.slice(0, MOST_PINS),
    from: wait.from,
    why: wait.why,
    ...(wait.to === undefined ? {} : { to: wait.to }),
    ...(wait.until === undefined ? {} : { until: wait.until }),
    clears: counts(wait.clears),
    ...(wait.leaves ? { leaves: counts(wait.leaves) } : {}),
    ...(wait.deadline === undefined ? {} : { deadline: wait.deadline }),
    ...(wait.routine ? { routine: true as const } : {}),
  };
}

const DAY_MS = 24 * 3_600_000;

/**
 * The pull requests and issues a day holds: the open ones, and those settled within `SETTLED_DAYS` of the read; past
 * the cap the open ones first, then the latest settled.
 */
function pullsOf(pulls: PatchPull[], read: number): PatchPull[] {
  const kept = pulls.filter((pull) => !pull.settled || read - Date.parse(pull.settled) <= SETTLED_DAYS * DAY_MS);
  if (kept.length <= MOST_PULLS) return kept;
  const open = kept.filter((pull) => !pull.settled);
  const settled = kept
    .filter((pull) => pull.settled)
    .sort((a, b) => Date.parse(b.settled as string) - Date.parse(a.settled as string));
  return [...open, ...settled].slice(0, MOST_PULLS);
}

/** The conclusions GitHub gives a run that failed. */
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * Why a scan that did not pass failed, read from its own totals, which count what it fails on: a finding past its
 * deadline, one due within a day, a new High or Critical with a fix. `other` when it failed with none of those, or
 * wrote
 * no totals at all.
 */
export function failures(conclusion: string | null, totals: ScanTotals | null): ScanFailure[] {
  // A run cancelled, skipped or not finished judged nothing: it did not fail, and its conclusion says what it did.
  if (!conclusion || !FAILED.has(conclusion)) return [];
  const found: ScanFailure[] = [];
  if (totals?.overdue) found.push('overdue');
  if (totals?.dueWithinDay) found.push('due-within-a-day');
  if (totals?.newHighWithFix) found.push('new-high-or-critical');
  return found.length ? found : ['other'];
}

/** The scan's totals, as `moves.json` gives them (moves.ts's `MovesFile`). */
type ScanTotals = MovesFile['totals'];

/** The scan's totals, copied: the sense computes none of them, and has no open count by severity for a scan without. */
const totalsOf = (t: ScanTotals): NonNullable<Day['repositories'][number]['totals']> => ({
  fixed: t.fixed,
  moves: t.moves,
  lanes: t.lanes,
  noFix: t.noFix,
  excepted: t.excepted,
  overdue: t.overdue,
  dueWithinDay: t.dueWithinDay,
  newHighWithFix: t.newHighWithFix,
  newHighWithoutFix: t.newHighWithoutFix,
  ...(t.open ? { open: counts(t.open) } : {}),
});

/** One repository's day. */
function repositoryDay({ moves, pulls }: RepositoryRead, read: number): Day['repositories'][number] {
  const list = moves.moves.slice(0, MOST_MOVES).map(dayMove);
  const judged = moves.file?.judged ?? null;
  return {
    repository: moves.repository,
    run: {
      id: moves.run.id,
      event: moves.run.event as 'schedule' | 'push' | 'workflow_dispatch',
      conclusion: moves.run.conclusion,
      commit: moves.run.headSha,
      finished: moves.run.updatedAt,
      url: moves.run.url,
    },
    judged,
    failed: failures(moves.run.conclusion, moves.file?.totals ?? null),
    totals: moves.file ? totalsOf(moves.file.totals) : null,
    scanned: scannedOf(moves).length,
    moves: list,
    waiting: (moves.waiting ?? []).slice(0, MOST_MOVES).map(dayWaiting),
    pulls: pullsOf(pulls, read),
  };
}

/** The images a repository's scan read, from its `moves.json`; none when the run wrote none. */
export function scannedOf(moves: Moves) {
  return moves.file?.scanned ?? [];
}

/**
 * The day read at `read`: each repository, in order, the containers compared, and the rows, or null when none could be
 * made.
 */
export function dayOf(reads: RepositoryRead[], containers: number, rows: Row[] | null, read: Date): Day {
  return {
    repositories: reads
      .map((each) => repositoryDay(each, read.getTime()))
      .sort((a, b) => (a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0)),
    read: read.toISOString(),
    compared: rows !== null,
    containers,
    rows: capped(rows ?? []),
  };
}

/**
 * The rows a day holds: all of them, or past the cap one of each row as it reads without its pod, in that order, so
 * which rows a full day keeps does not hang on the pods' names.
 */
function capped(rows: Row[]): Row[] {
  if (rows.length <= MOST_ROWS) return rows;
  const byRow = new Map<string, Row>();
  for (const row of rows) {
    const k = canonical(row.row === 'not-running' ? { ...row, running: [] } : withoutPod(row));
    if (!byRow.has(k)) byRow.set(k, row);
  }
  return [...byRow.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MOST_ROWS)
    .map(([, row]) => row);
}

/**
 * Whether two days say the same: the same runs, moves, waits, pull requests and rows. When each was read is left out,
 * and so are a pod's name, how many containers ran and how many copies make a row, so a pod made again, or a
 * Deployment scaled, is no new day while its row stands.
 */
export function sameDay(a: Day, b: Day | null): boolean {
  if (!b) return false;
  // Without the pods' names the rows may come in another order and repeat, so they are compared as a sorted set.
  const set = (items: string[]) => [...new Set(items)].sort();
  const plain = ({ containers: _, read: __, rows, ...day }: Day) => ({
    ...day,
    rows: set(
      rows.map((row) =>
        canonical(
          row.row === 'not-running'
            ? { ...row, running: set(row.running.map(withoutPod).map(canonical)) }
            : withoutPod(row),
        ),
      ),
    ),
  });
  return canonical(plain(a)) === canonical(plain(b));
}

/** JSON with every object's keys in order: the store's `jsonb` keeps its own order, not the writer's. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const withoutPod = <T extends { pod: string }>({ pod: _, ...rest }: T) => rest;
