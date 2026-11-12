/**
 * Patching, as a pure function of the events and a time: the dependency sense's last `patching.read` by t, which only
 * its role may append (`PATCHING_ONLY_TYPES`), and the line's work items, which carry an app's move down the line. One
 * row for each move and each row the sense made of what the cluster runs, what waits on Martin first, then by earliest
 * deadline, then those with none; the day's scan in a line; and four figures for the findings no row can clear.
 *
 * It says only what the events say. A move nobody has opened a pull request for reads as who moves it; the states a pull
 * request of the factory's own goes through (checks running, in the merge queue, merged and running) arrive with the
 * pin watch's events, and nothing here draws them before then.
 *
 * The Patching panel's chunk carries it, so the first view carries none of it: plain TypeScript, which Node tests
 * directly.
 */
import type { MoveLane, PayloadOf, PublicEvent, ScanFailure } from '@software-factory/events';
import type { ItemState } from './items.ts';
import { DAY, HIS, PATCHING_ROLE, rowKeys, shortDigests, targetWords } from './patch-needs.ts';

export { dueSoon, dueWords, OPEN_ROW, PATCHING_ROLE, targetWords } from './patch-needs.ts';

/** The sense's last day by t, from its own role. */
export function lastRead(events: readonly PublicEvent[], t: number): PublicEvent<'patching.read'> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'patching.read' || event.appended_by !== PATCHING_ROLE) continue;
    if (Date.parse(event.ts) <= t) return event;
  }
  return undefined;
}

/** The app's repository, whose moves go down the line and whose pins read "the app's". */
export const APP_REPOSITORY = 'the-roganator/cv-worlds-worst-website';

type Day = PayloadOf<'patching.read'>;
type Repository = Day['repositories'][number];
type ScanMove = Repository['moves'][number];
type Running = Day['rows'][number];

/** A row's state, each a glyph and a word in the design system: who moves it, or where its pull request is. */
export type MoveState =
  | { kind: 'waits' }
  | { kind: 'lane'; lane: Exclude<MoveLane, 'none'> }
  | { kind: 'opened' }
  | { kind: 'stage'; stage: 'plan' | 'build' | 'review' }
  | { kind: 'no-route' };

/** Where a row points: the pull request Dependabot opened, or the work item the line carries it on. */
export type Link = { kind: 'pull'; number: number; version: string } | { kind: 'item'; number: string };

/** What a row moves: a pin of the scan's list, or a row the sense made of what the cluster runs. */
export type RowSource =
  | { kind: 'move'; lane: MoveLane; lockfile: boolean; major: boolean; unbuilt: boolean }
  | { kind: 'unlisted-image' }
  | { kind: 'unscanned-digest' }
  | { kind: 'not-running' };

export interface PatchingRow {
  /** Unique within the day: its repository and name, or the sense's row and where it runs. */
  key: string;
  repository: string | undefined;
  source: RowSource;
  state: MoveState;
  /** Whether it waits on Martin: a lane only he moves, or a row the sense made. */
  waits: boolean;
  /** What moves, as the event names it; undefined for a lockfile's package the public view withholds. */
  name: string | undefined;
  /** Where its pin is, or where it runs. */
  where: { file: string; line: number } | { namespace: string; pod: string } | undefined;
  /** From and to, as the scan writes them, shortened; undefined where the event withholds them. */
  from: string | undefined;
  to: string | undefined;
  /** What it clears, by severity; undefined for a row the sense made, which nothing scanned. */
  clears: Counts | undefined;
  deadline: number | undefined;
  newToday: number;
  link: Link | undefined;
  /** Every pin, with what changes there; or, for a row the sense made, where it runs and what. */
  pins: { at: string; change: string }[];
}

export interface Counts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

/** How the day's scan went, both repositories' together. */
export interface ScanDay {
  /** Whether either repository's run failed, and why, in the scan's own reasons. */
  passed: boolean;
  failed: ScanFailure[];
  /** When the later of the two runs finished. */
  finished: number;
  newHighWithFix: number;
  newHighWithoutFix: number;
  overdue: number;
  dueWithinDay: number;
  /**
   * How many rows below hold each: moves with something new today that clears a High or a Critical, and by deadline as
   * the run judged it, so a day read long ago still names the rows its counts were made of.
   */
  movesWithNew: number;
  movesOverdue: number;
  movesDueWithinDay: number;
  /** A repository whose run wrote no moves, with its run's page on GitHub to read why. */
  unjudged: RunPage[];
  /** A repository whose run judged its moves and failed for none of the scan's three reasons: the run itself failed. */
  broken: RunPage[];
}

/** A repository's run, by its page on GitHub. */
export interface RunPage {
  repository: string;
  url: string;
}

/** The run's page, built from what the schema holds to a shape, not from the event's own address. */
const runPage = (r: Repository): RunPage => ({
  repository: r.repository,
  url: `https://github.com/${r.repository}/actions/runs/${r.run.id}`,
});

export type PatchingView =
  | { state: 'unread' }
  | {
      state: 'read';
      at: number;
      rows: PatchingRow[];
      moves: number;
      waiting: number;
      /** How many rows the sense made of each kind. */
      running: Record<Running['row'], number>;
      day: ScanDay;
      /**
       * Why no row shows, when none does: a run wrote no moves, or judged its moves and itself failed, so nothing can
       * be said cleared; or every finding with a fix was.
       */
      nothing: 'unjudged' | 'failed' | 'cleared' | undefined;
      figures: { noFix: number; cleared: number; excepted: number; overdue: number; clearingMoves: number };
      /** Whether the cluster was compared with the lists, and how many containers. */
      compared: boolean;
      containers: number;
    };

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
export const total = (counts: Counts) => SEVERITIES.reduce((n, s) => n + counts[s], 0);

/**
 * The line's work item that carries an app's move: open, and naming the same package or image. Only the app's moves go
 * down the line, and the line's work items are all the app's, so a move of the factory's is never matched; a lockfile's
 * move whose package the public view withholds has no name to match, and reads as its lane until its pull request opens.
 */
function carrying(items: readonly ItemState[], name: string): ItemState | undefined {
  return items.find((item) => item.closedAt === undefined && item.dependency?.name === name);
}

/**
 * A move's row. Its key is the same for Martin and a visitor, and while its pull request opens: a move's name, or, for a
 * lockfile's, whose name is the file's for every one of them, its place among the repository's lockfile moves.
 */
function moveRow(repository: string, move: ScanMove, items: readonly ItemState[], key: string): PatchingRow {
  const shown = move.lockfile ? move.package : undefined;
  const name = move.lockfile ? shown?.name : move.name;
  const waits = HIS.includes(move.lane);
  const item = move.lane === 'line' && repository === APP_REPOSITORY && name ? carrying(items, name) : undefined;
  const stage = item?.stage === 'plan' || item?.stage === 'build' || item?.stage === 'review' ? item.stage : undefined;
  const link: Link | undefined = move.pullRequest
    ? { kind: 'pull', ...move.pullRequest, number: move.pullRequest.number }
    : item
      ? { kind: 'item', number: item.number }
      : undefined;
  const state: MoveState = waits
    ? { kind: 'waits' }
    : move.lane === 'none'
      ? { kind: 'no-route' }
      : stage
        ? { kind: 'stage', stage }
        : move.pullRequest
          ? { kind: 'opened' }
          : { kind: 'lane', lane: move.lane };
  // A version the scan could not read is empty: it is left unsaid, never drawn as an empty side of an arrow.
  const from = (move.lockfile ? shown?.from : shortDigests(move.from).trim()) || undefined;
  const unbuilt = move.to.startsWith('another line');
  const to = move.lockfile ? shown?.to || undefined : move.to && !unbuilt ? targetWords(move.to) : undefined;
  const pins = (move.lockfile ? (shown?.pins ?? []) : move.pins).map((pin) => ({
    at: pinText(pin),
    change: changeWords(from, to),
  }));
  const first = (move.lockfile ? shown?.pins[0] : undefined) ?? move.pins[0];
  return {
    key,
    repository,
    source: { kind: 'move', lane: move.lane, lockfile: move.lockfile, major: move.major, unbuilt },
    state,
    waits,
    name,
    where: move.lockfile && !shown ? (first ? { file: first.file, line: 0 } : undefined) : first,
    from: move.lockfile && !shown ? undefined : from,
    to: move.lockfile && !shown ? undefined : to,
    clears: move.clears,
    deadline: move.deadline === undefined ? undefined : Date.parse(move.deadline),
    newToday: move.newToday,
    link,
    pins: move.lockfile && !shown ? [] : pins,
  };
}

/** What a move changes at a pin: "1.0 → 1.1", or the side the scan read when it could not read the other. */
export const changeWords = (from: string | undefined, to: string | undefined) =>
  from && to ? `${from} → ${to}` : to ? `→ ${to}` : (from ?? '');

/** A pin's place: its file, and its line where it has one (a lockfile's move is the file). */
export const pinText = ({ file, line }: { file: string; line: number }) => (line > 0 ? `${file}:${line}` : file);

function runningRow(row: Running, key: string): PatchingRow {
  const base = {
    source: { kind: row.row } as RowSource,
    state: { kind: 'waits' } as const,
    waits: true,
    clears: undefined,
  };
  const none = { deadline: undefined, newToday: 0, link: undefined };
  switch (row.row) {
    case 'unlisted-image':
      return {
        ...base,
        ...none,
        key,
        repository: undefined,
        name: shortDigests(row.image).trim(),
        where: { namespace: row.namespace, pod: row.pod },
        from: undefined,
        to: undefined,
        pins: [{ at: `${row.namespace}/${row.pod}`, change: shortDigests(`${row.image}@${row.digest}`).trim() }],
      };
    case 'unscanned-digest':
      return {
        ...base,
        ...none,
        key,
        repository: row.repository,
        name: shortDigests(row.image).trim(),
        where: { namespace: row.namespace, pod: row.pod },
        from: undefined,
        to: undefined,
        pins: [
          { at: `${row.namespace}/${row.pod}`, change: shortDigests(`${row.image}@${row.digest}`).trim() },
          { at: pinText(row.pin), change: row.item },
        ],
      };
    case 'not-running':
      return {
        ...base,
        ...none,
        key,
        repository: row.repository,
        name: shortDigests(row.image).trim(),
        where: row.pin,
        from: shortDigests(row.running[0]?.image ?? '').trim() || undefined,
        to: shortDigests(row.image).trim(),
        pins: [
          { at: pinText(row.pin), change: shortDigests(row.image).trim() },
          ...row.running.map((r) => ({ at: `${r.namespace}/${r.pod}`, change: shortDigests(r.image).trim() })),
        ],
      };
  }
}

/** What waits on Martin first, then by earliest deadline, then those with none; ties keep the day's order. */
export function ordered(rows: readonly PatchingRow[]): PatchingRow[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort(
      (a, b) =>
        Number(b.row.waits) - Number(a.row.waits) ||
        (a.row.deadline ?? Number.POSITIVE_INFINITY) - (b.row.deadline ?? Number.POSITIVE_INFINITY) ||
        a.i - b.i,
    )
    .map(({ row }) => row);
}

const sum = (repositories: readonly Repository[], field: 'noFix' | 'excepted' | 'overdue' | 'dueWithinDay') =>
  repositories.reduce((n, r) => n + (r.totals?.[field] ?? 0), 0);

/** Patching at t, from the sense's last day and the line's work items. */
export function patchingView(events: readonly PublicEvent[], items: readonly ItemState[], t: number): PatchingView {
  const read = lastRead(events, t);
  if (!read) return { state: 'unread' };
  return dayView(read.payload, Date.parse(read.ts), items);
}

/** One day's view, read at `at`: what it says holds whatever the time, and the deadlines' colour is the panel's, at t. */
export function dayView(day: Day, at: number, items: readonly ItemState[]): PatchingView {
  // Each move with the time its repository's run judged it: the day's line counts its reasons as the scan did then,
  // so the rows it says hold each are found by the same clock, not by the viewer's.
  const keys = rowKeys(day);
  const judgedMoves = day.repositories.flatMap((r, i) => {
    const judged = r.judged === null ? at : Date.parse(r.judged);
    return r.moves.map((move, j) => ({ judged, row: moveRow(r.repository, move, items, keys.moves[i]?.[j] ?? '') }));
  });
  const moves = judgedMoves.map(({ row }) => row);
  const rows = ordered([...moves, ...day.rows.map((row, i) => runningRow(row, keys.running[i] ?? ''))]);
  const running = { 'unscanned-digest': 0, 'unlisted-image': 0, 'not-running': 0 };
  for (const row of day.rows) running[row.row]++;
  const failed = [...new Set(day.repositories.flatMap((r) => r.failed))];
  const conclusions = day.repositories.map((r) => r.run.conclusion);
  const clearing = moves.filter((row) => row.clears && total(row.clears) > 0);
  const scanDay: ScanDay = {
    passed: failed.length === 0 && conclusions.every((c) => c === 'success'),
    failed,
    finished: Math.max(...day.repositories.map((r) => Date.parse(r.run.finished))),
    newHighWithFix: day.repositories.reduce((n, r) => n + (r.totals?.newHighWithFix ?? 0), 0),
    newHighWithoutFix: day.repositories.reduce((n, r) => n + (r.totals?.newHighWithoutFix ?? 0), 0),
    overdue: sum(day.repositories, 'overdue'),
    dueWithinDay: sum(day.repositories, 'dueWithinDay'),
    movesWithNew: moves.filter((row) => row.newToday > 0 && row.clears && row.clears.critical + row.clears.high > 0)
      .length,
    movesOverdue: judgedMoves.filter(({ row, judged }) => row.deadline !== undefined && row.deadline <= judged).length,
    movesDueWithinDay: judgedMoves.filter(
      ({ row, judged }) => row.deadline !== undefined && row.deadline > judged && row.deadline - judged <= DAY,
    ).length,
    unjudged: day.repositories.filter((r) => r.judged === null).map(runPage),
    broken: day.repositories
      .filter(
        (r) =>
          r.judged !== null && r.run.conclusion !== 'success' && (r.failed.length === 0 || r.failed.includes('other')),
      )
      .map(runPage),
  };
  return {
    state: 'read',
    at,
    rows,
    moves: moves.length,
    waiting: rows.filter((row) => row.waits).length,
    running,
    day: scanDay,
    nothing:
      rows.length > 0
        ? undefined
        : scanDay.unjudged.length > 0
          ? 'unjudged'
          : scanDay.broken.length > 0
            ? 'failed'
            : 'cleared',
    figures: {
      noFix: sum(day.repositories, 'noFix'),
      cleared: clearing.reduce((n, row) => n + (row.clears ? total(row.clears) : 0), 0),
      excepted: sum(day.repositories, 'excepted'),
      overdue: sum(day.repositories, 'overdue'),
      clearingMoves: clearing.length,
    },
    compared: day.compared,
    containers: day.containers,
  };
}
