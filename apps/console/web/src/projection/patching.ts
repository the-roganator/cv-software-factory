/**
 * Patching, as a pure function of the events: the dependency sense's last `patching.read`, which only its role may
 * append (`PATCHING_ONLY_TYPES`), and Martin's command line's as a sample, the days it read in the 28 before it, and the line's work items, which carry an app's
 * move down the line. One row for each move, each pin that waits and each row the sense made of what the cluster runs:
 * what waits on Martin, grouped by what he does, each group by earliest deadline; then what moves by itself, by earliest
 * deadline; then what was done in the last 28 days, newest first. The day's scan in a line, and when each repository's
 * scan judged and the pull requests were read in another; every open finding and what the moves clear, by severity;
 * and four figures for the findings no row can clear.
 *
 * It says only what the events say. Where a row stands is `patch-needs.ts`'s, which Needs you's card counts by too: its
 * pull request's or issue's state, as the GitHub worker read it, or its lane while nothing carries it. Done is worked
 * out from the days the console already has: the pull requests the last day says settled, and the moves an earlier day
 * listed that the last one does not, with nothing settled that carried them. No event of its own.
 *
 * Patching's summary and its sheet read it, in chunks the first view does not carry: plain TypeScript, which Node
 * tests directly.
 */
import type { MoveLane, PayloadOf, PublicEvent, ScanFailure } from '@software-factory/events';
import { REPOSITORIES } from '../repositories.ts';
import type { ItemState } from './items.ts';
import {
  carriesMove,
  DAY,
  GROUP_OF,
  heldWith,
  isSensesDay,
  PATCH_GROUPS,
  type PatchGroup,
  type Pull,
  readAt,
  rowKeys,
  type ScanJudged,
  type Standing,
  shortDigests,
  standingOf,
  targetWords,
  unbuilt,
  type WaitWhy,
  waitingStanding,
} from './patch-needs.ts';

export {
  dueSoon,
  dueWords,
  PATCH_GROUPS,
  PATCHING_ROLE,
  type PatchGroup,
  type Pull,
  READ_STALE_HOURS,
  readStale,
  SCAN_MAX_AGE_HOURS,
  type ScanJudged,
  staleScans,
  targetWords,
  type WaitWhy,
} from './patch-needs.ts';

/** How far back Done reaches: what the last 28 days of the sense's days finished. */
export const DONE_DAYS = 28;

/** The sense's last day by t, from its own role. */
export function lastRead(events: readonly PublicEvent[], t: number): PublicEvent<'patching.read'> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || !isSensesDay(event)) continue;
    if (Date.parse(event.ts) <= t) return event;
  }
  return undefined;
}

/** The sense's days in the 28 before a day, from its role, oldest first: what Done is worked out from. */
export function daysBefore(events: readonly PublicEvent[], last: PublicEvent<'patching.read'>): Earlier[] {
  const from = Date.parse(last.ts) - DONE_DAYS * DAY;
  const days: Earlier[] = [];
  for (const event of events) {
    if (event === last) break;
    if (!isSensesDay(event)) continue;
    const at = Date.parse(event.ts);
    if (at >= from && at <= Date.parse(last.ts)) days.push({ at, day: event.payload });
  }
  return days;
}

/** An earlier day of the sense's, read at `at`. */
export interface Earlier {
  at: number;
  day: Day;
}

/** The app's repository, whose moves go down the line and whose pins read "the app's". */
export const APP_REPOSITORY = REPOSITORIES.app;

type Day = PayloadOf<'patching.read'>;
type Repository = Day['repositories'][number];
type ScanMove = Repository['moves'][number];
type Waiting = Repository['waiting'][number];
type Running = Day['rows'][number];

/**
 * A row's state, each a glyph and a word in the design system: waiting on Martin, by why; moving by itself (its pull
 * request opened, its checks running, in the merge queue, its day to wait, nothing to move to, its lane while nothing
 * carries it, or its work item's stage on the line); or done (merged, no longer listed, or closed without a merge).
 */
export type MoveState =
  | { kind: 'waits'; why: WaitWhy; group: PatchGroup }
  | { kind: 'opened' | 'checks' | 'queue' | 'day' | 'none' }
  | { kind: 'lane'; lane: Exclude<MoveLane, 'none'> }
  | { kind: 'stage'; stage: 'plan' | 'build' | 'review' }
  | { kind: 'merged' | 'gone' | 'closed' };

/** Where a row points: the work item the line carries it on. */
export type Link = { kind: 'item'; number: string };

/** What a row moves: a pin of the scan's list, a pin that waits, or a row the sense made of what the cluster runs. */
export type RowSource =
  | { kind: 'move'; lane: MoveLane; lockfile: boolean; major: boolean; unbuilt: boolean; routine: boolean }
  | { kind: 'waiting'; why: Waiting['why']; routine: boolean }
  | { kind: 'unlisted-image' }
  | { kind: 'unscanned-digest' }
  | { kind: 'not-running' };

/** One of a line move's scan findings, as its work item's newest signal gives them: never an advisory. */
export interface Finding {
  /** Its package, which only Martin's events carry. */
  package: string | undefined;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
  deadline: number | undefined;
}

export interface PatchingRow {
  /** Unique within the sheet: its repository and name, or the sense's row and where it runs. */
  key: string;
  repository: string | undefined;
  source: RowSource;
  state: MoveState;
  /** Whether it waits on Martin, and in which group. */
  waits: boolean;
  group: PatchGroup | undefined;
  /** The pull request or issue it stands by; undefined while nothing carries it. */
  pull: Pull | undefined;
  /** Whether it would queue but the line is stopped. */
  stopped: boolean;
  /** What moves, as the event names it; undefined for a lockfile's package the public view withholds. */
  name: string | undefined;
  /** Where its pin is, or where it runs. */
  where: { file: string; line: number } | { namespace: string; pod: string } | undefined;
  /** From and to, as the scan writes them, shortened; undefined where the event withholds them. */
  from: string | undefined;
  to: string | undefined;
  /** What it clears, by severity; undefined for a row the sense made, which nothing scanned, or one withheld. */
  clears: Counts | undefined;
  /** What it leaves that only a move across its major clears, where it leaves anything. */
  leaves: Counts | undefined;
  deadline: number | undefined;
  newToday: number;
  link: Link | undefined;
  /** Every pin, with what changes there; or, for a row the sense made, where it runs and what. */
  pins: { at: string; change: string }[];
  /** The moves held with it, made together with it and waiting as it does. */
  held: PatchingRow[];
  /** A line move's scan findings, from its work item's newest signal, and how many in all. */
  findings: { listed: Finding[]; count: number } | undefined;
  /** When a fix waiting its day comes due. */
  until: number | undefined;
  /** The page of the scan's run that judged it. */
  run: string;
  /** For a row of Done: when it was done, and the target its move goes on under, where it is listed still. */
  on: number | undefined;
  goesOn: string | undefined;
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
      /** When the sense last read the pull requests and issues. */
      read: number;
      /** Every row that is not done: what waits on Martin, by group, then what moves by itself. */
      rows: PatchingRow[];
      /** What waits on Martin, grouped by what he does, in the sheet's order, each by earliest deadline. */
      groups: { group: PatchGroup; rows: PatchingRow[] }[];
      /** What moves by itself, by earliest deadline. */
      moving: PatchingRow[];
      /** Done in the last 28 days, newest first. */
      done: PatchingRow[];
      moves: number;
      waiting: number;
      /** How many rows the sense made of each kind. */
      running: Record<Running['row'], number>;
      day: ScanDay;
      /** Each repository's scan, when it judged. */
      scans: ScanJudged[];
      /** The fixes that wait their day: how many, and the one's name where there is one. */
      waitDay: { count: number; name: string | undefined };
      /**
       * Why no row shows, when none does: a run wrote no moves, or judged its moves and itself failed, so nothing can
       * be said cleared; or every finding with a fix was.
       */
      nothing: 'unjudged' | 'failed' | 'cleared' | undefined;
      figures: { noFix: number; cleared: number; excepted: number; overdue: number; clearingMoves: number };
      /**
       * Every open finding by severity, both repositories' together, as the scan counts them: those a move clears and
       * those with no fix yet, not those excepted. Undefined when either repository's day lacks it, a scan made before
       * it counted them: nothing here works it out from anything else.
       */
      open: Counts | undefined;
      /** What the rows still to move clear, by severity: the sum of their counts, but a withheld lockfile move's. */
      clears: Counts;
      /** Whether the cluster was compared with the lists, and how many containers. */
      compared: boolean;
      containers: number;
    };

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
export const total = (counts: Counts) => SEVERITIES.reduce((n, s) => n + counts[s], 0);

/**
 * The line's work item that carries an app's move: open, and naming the same package or image. Only the app's moves go
 * down the line, and the line's work items are all the app's, so a move of the factory's is never matched; a lockfile's
 * move whose package the public view withholds has no name to match, and reads as its lane.
 */
function carrying(items: readonly ItemState[], name: string): ItemState | undefined {
  return items.find((item) => item.closedAt === undefined && item.dependency?.name === name);
}

const WORSE = ['critical', 'high', 'medium', 'low', 'unknown'] as const;

/** A work item's scan findings, from its newest signal that carries them, and how many there are in all. */
function findingsOf(item: ItemState): PatchingRow['findings'] {
  for (let i = item.events.length - 1; i >= 0; i--) {
    const event = item.events[i];
    if (event?.type !== 'signal.received') continue;
    const scan = event.payload.evidence?.find((evidence) => evidence.kind === 'scan');
    if (scan?.kind !== 'scan') continue;
    const listed = scan.findings.map(
      (finding): Finding => ({
        package: finding.package,
        // The worse of the scanner's rating and the publisher's, which sets its deadline.
        severity:
          WORSE.find((s) => s === finding.severity.scanner || s === finding.severity.publisher) ??
          finding.severity.scanner,
        deadline: finding.deadline === undefined ? undefined : Date.parse(finding.deadline),
      }),
    );
    const rest = Object.values(scan.rest).reduce((n, c) => n + c, 0);
    return { listed, count: listed.length + rest };
  }
  return undefined;
}

/** Whether a move is a routine update: it clears nothing, and has no deadline. */
const isRoutine = (move: { clears: Counts; deadline?: string | undefined }) =>
  total(move.clears) === 0 && move.deadline === undefined;

const hasAny = (counts: Counts | undefined) => (counts && total(counts) > 0 ? counts : undefined);

/** A row's state, from where it stands, and for the line's moves its work item's stage. */
function stateOf(standing: Standing, lane: MoveLane, item: ItemState | undefined): MoveState {
  switch (standing.place) {
    case 'waits':
      return { kind: 'waits', why: standing.why, group: GROUP_OF[standing.why] };
    case 'done':
      return { kind: 'merged' };
    case 'moves': {
      if (standing.state !== 'lane') return { kind: standing.state };
      const stage = item?.stage;
      if (stage === 'plan' || stage === 'build' || stage === 'review') return { kind: 'stage', stage };
      return { kind: 'lane', lane: lane === 'none' ? 'worker' : lane };
    }
  }
}

/** What a move shows of itself, as the event gives it: its name, versions and pins, withheld where the event is. */
function shownOf(move: ScanMove) {
  const shown = move.lockfile ? move.package : undefined;
  const withheld = move.lockfile && !shown;
  // A version the scan could not read is empty: it is left unsaid, never drawn as an empty side of an arrow.
  const from = (move.lockfile ? shown?.from : shortDigests(move.from).trim()) || undefined;
  const to = move.lockfile ? shown?.to || undefined : move.to && !unbuilt(move) ? targetWords(move.to) : undefined;
  const pins = (move.lockfile ? (shown?.pins ?? []) : move.pins).map((pin) => ({
    at: pinText(pin),
    change: changeWords(from, to),
  }));
  const first = (move.lockfile ? shown?.pins[0] : undefined) ?? move.pins[0];
  return {
    name: move.lockfile ? shown?.name : move.name,
    withheld,
    from: withheld ? undefined : from,
    to: withheld ? undefined : to,
    pins: withheld ? [] : pins,
    where: withheld ? (first ? { file: first.file, line: 0 } : undefined) : first,
  };
}

const NO_DONE = { on: undefined, goesOn: undefined };

/**
 * A move's row. Its key is the same for Martin and a visitor, and while its pull request opens: a move's name, or, for a
 * lockfile's, whose name is the file's for every one of them, its place among the repository's lockfile moves.
 */
function moveRow(
  r: Repository,
  move: ScanMove,
  standing: Standing,
  items: readonly ItemState[],
  key: string,
): PatchingRow {
  const shown = shownOf(move);
  const item =
    move.lane === 'line' && r.repository === APP_REPOSITORY && shown.name ? carrying(items, shown.name) : undefined;
  const state = stateOf(standing, move.lane, item);
  const waits = state.kind === 'waits';
  return {
    key,
    repository: r.repository,
    source: {
      kind: 'move',
      lane: move.lane,
      lockfile: move.lockfile,
      major: move.major,
      unbuilt: unbuilt(move),
      routine: isRoutine(move),
    },
    state,
    waits,
    group: waits ? state.group : undefined,
    pull: standing.pull,
    stopped: standing.place === 'moves' && standing.stopped,
    name: shown.name,
    where: shown.where,
    from: shown.from,
    to: shown.to,
    clears: move.clears,
    leaves: move.major ? undefined : hasAny(move.leaves),
    deadline: move.deadline === undefined ? undefined : Date.parse(move.deadline),
    newToday: move.newToday,
    link: item ? { kind: 'item', number: item.number } : undefined,
    pins: shown.pins,
    held: [],
    findings: item ? findingsOf(item) : undefined,
    until: undefined,
    run: runPage(r).url,
    ...NO_DONE,
  };
}

/** A pin that waits: its content's day, or no release better than it. Never a lockfile's. */
function waitingRow(r: Repository, waiting: Waiting, standing: Standing, key: string): PatchingRow {
  const state = stateOf(standing, 'worker', undefined);
  const waits = state.kind === 'waits';
  const from = shortDigests(waiting.from).trim() || undefined;
  const to = waiting.to ? targetWords(waiting.to) : undefined;
  return {
    key,
    repository: r.repository,
    source: { kind: 'waiting', why: waiting.why, routine: waiting.routine === true },
    state,
    waits,
    group: waits ? state.group : undefined,
    pull: standing.pull,
    stopped: standing.place === 'moves' && standing.stopped,
    name: waiting.name,
    where: waiting.pins[0],
    from,
    to,
    clears: waiting.clears,
    leaves: hasAny(waiting.leaves),
    deadline: waiting.deadline === undefined ? undefined : Date.parse(waiting.deadline),
    newToday: 0,
    link: undefined,
    pins: waiting.pins.map((pin) => ({ at: pinText(pin), change: changeWords(from, to) })),
    held: [],
    findings: undefined,
    until: waiting.until === undefined ? undefined : Date.parse(waiting.until),
    run: runPage(r).url,
    ...NO_DONE,
  };
}

/** What a move changes at a pin: "1.0 → 1.1", or the side the scan read when it could not read the other. */
export const changeWords = (from: string | undefined, to: string | undefined) =>
  from && to ? `${from} → ${to}` : to ? `→ ${to}` : (from ?? '');

/** A pin's place: its file, and its line where it has one (a lockfile's move is the file). */
export const pinText = ({ file, line }: { file: string; line: number }) => (line > 0 ? `${file}:${line}` : file);

function runningRow(row: Running, key: string, run: string): PatchingRow {
  const base = {
    source: { kind: row.row } as RowSource,
    state: { kind: 'waits', why: row.row, group: 'hand' } as const,
    waits: true,
    group: 'hand' as const,
    pull: undefined,
    stopped: false,
    clears: undefined,
    leaves: undefined,
    deadline: undefined,
    newToday: 0,
    link: undefined,
    held: [],
    findings: undefined,
    until: undefined,
    run,
    ...NO_DONE,
  };
  switch (row.row) {
    case 'unlisted-image':
      return {
        ...base,
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

/** By earliest deadline, then those with none; ties keep their order. */
export function byDeadline(rows: readonly PatchingRow[]): PatchingRow[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort(
      (a, b) =>
        (a.row.deadline ?? Number.POSITIVE_INFINITY) - (b.row.deadline ?? Number.POSITIVE_INFINITY) || a.i - b.i,
    )
    .map(({ row }) => row);
}

const NONE: Counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
const plus = (a: Counts, b: Counts): Counts => ({
  critical: a.critical + b.critical,
  high: a.high + b.high,
  medium: a.medium + b.medium,
  low: a.low + b.low,
  unknown: a.unknown + b.unknown,
});

/** Every open finding, both repositories' together, or undefined if either's day did not count them. */
function openOf(repositories: readonly Repository[]): Counts | undefined {
  let open = NONE;
  for (const r of repositories) {
    const counted = r.totals?.open;
    if (!counted) return undefined;
    open = plus(open, counted);
  }
  return open;
}

/** The row whose deadline comes first, met or past: what the summary names as next due. */
export function nextDue(rows: readonly PatchingRow[]): PatchingRow | undefined {
  let first: PatchingRow | undefined;
  for (const row of rows) {
    if (row.deadline !== undefined && (first?.deadline === undefined || row.deadline < first.deadline)) first = row;
  }
  return first;
}

const sum = (repositories: readonly Repository[], field: 'noFix' | 'excepted' | 'overdue' | 'dueWithinDay') =>
  repositories.reduce((n, r) => n + (r.totals?.[field] ?? 0), 0);

/** A move across days: its repository, name, and a lockfile's package where the day gives it. */
const identity = (repository: string, move: { name: string; package?: { name: string } | undefined }) =>
  `${repository}\u0000${move.name}\u0000${move.package?.name ?? ''}`;

/** Where a settled pull request or issue leaves its move: merged, closed by a person or the issue's, or no longer listed. */
const doneState = (pull: Pull): MoveState['kind'] =>
  pull.state === 'merged' ? 'merged' : pull.kind === 'issue' || pull.closedByPerson ? 'closed' : 'gone';

/** A row of Done, from the move as the last day that listed it had it. */
function doneRow(
  repository: string,
  move: ScanMove | undefined,
  name: string,
  pull: Pull | undefined,
  on: number,
  key: string,
  run: string,
  goesOn: string | undefined,
  lockfile = false,
): PatchingRow {
  const shown = move ? shownOf(move) : undefined;
  const withheld = shown?.withheld ?? lockfile;
  const kind = pull ? doneState(pull) : 'gone';
  return {
    key,
    repository,
    source: {
      kind: 'move',
      lane: move?.lane ?? 'worker',
      lockfile: move?.lockfile ?? lockfile,
      major: move?.major ?? false,
      unbuilt: move ? unbuilt(move) : false,
      routine: move ? isRoutine(move) : false,
    },
    state: { kind } as MoveState,
    waits: false,
    group: undefined,
    pull,
    stopped: false,
    name: shown ? shown.name : lockfile ? undefined : name,
    where: shown?.where ?? (lockfile ? { file: 'pnpm-lock.yaml', line: 0 } : undefined),
    from: shown?.from,
    to: shown?.to,
    // A withheld lockfile's move is not joined to what it cleared, which another of its file's might have.
    clears: withheld ? undefined : move?.clears,
    leaves: undefined,
    deadline: undefined,
    newToday: 0,
    link: undefined,
    pins: shown?.pins ?? [],
    held: [],
    findings: undefined,
    until: undefined,
    run,
    on,
    goesOn,
  };
}

/**
 * Done in the last 28 days, newest first: each pull request or issue the day says settled in them, by each move it
 * carried, but Dependabot's closed ones, which the factory's own made; and each move an earlier day listed that the
 * last one lists no more, which nothing settled carried, as no longer listed from the first day without it.
 */
function doneOf(day: Day, at: number, earlier: readonly Earlier[]): PatchingRow[] {
  const from = at - DONE_DAYS * DAY;
  const days = [...earlier, { day, at }];
  /**
   * A move as the last day that listed it by a time had it: by its name, and its package where both give one. A
   * visitor's lockfile move has no package to tell it from the others of its file: it is withheld, joined to none.
   */
  const find = (repository: string, name: string, lockfile: boolean, pkg: string | undefined, by: number) => {
    for (const { day: d, at: when } of [...days].reverse()) {
      if (when > by) continue;
      const r = d.repositories.find((each) => each.repository === repository);
      const move = r?.moves.find(
        (m) =>
          m.name === name && m.lockfile === lockfile && (!lockfile || (pkg !== undefined && m.package?.name === pkg)),
      );
      if (move) return move;
      if (lockfile && r?.moves.some((m) => m.name === name && m.lockfile)) return 'lockfile' as const;
    }
    return lockfile ? ('lockfile' as const) : undefined;
  };
  const rows: PatchingRow[] = [];
  const carried = new Set<string>();
  // A withheld pull request has no number to key it by: its place among them does.
  let unnumbered = 0;
  for (const r of day.repositories) {
    const run = runPage(r).url;
    for (const pull of r.pulls) {
      if (pull.state === 'open' || pull.settled === undefined) continue;
      if (pull.kind === 'dependabot' && pull.state === 'closed') continue;
      const settled = Date.parse(pull.settled);
      if (settled < from) continue;
      const which = pull.number ?? `withheld ${++unnumbered}`;
      pull.moves.forEach((m, i) => {
        carried.add(identity(r.repository, { name: m.name, package: m.package ? { name: m.package } : undefined }));
        // The move as it was listed before it settled, or as the last day lists it.
        const found =
          find(r.repository, m.name, m.lockfile, m.package, settled) ??
          find(r.repository, m.name, m.lockfile, m.package, at);
        const move = found === 'lockfile' ? undefined : found;
        // A move the worker closed for a newer target goes on under it, where the day lists it still.
        const now = r.moves.find((each) => !each.lockfile && carriesMove(pull, each.name, false, undefined));
        const goesOn =
          pull.state === 'closed' && now?.to && move && now.to !== move.to ? targetWords(now.to) : undefined;
        const key = `done ${r.repository} #${which} ${i}`;
        rows.push(doneRow(r.repository, move, m.name, pull, settled, key, run, goesOn, found === 'lockfile'));
      });
    }
  }
  // A move an earlier day listed that the last does not, nor carries in a pin that waits, where the last day judged
  // its repository: a day that judged nothing of it is not a day without its moves.
  const judged = new Set(day.repositories.filter((r) => r.judged !== null).map((r) => r.repository));
  const today = new Set(
    day.repositories.flatMap((r) => [
      ...r.moves.map((move) => identity(r.repository, move)),
      ...r.waiting.map((w) => identity(r.repository, w)),
    ]),
  );
  const names = new Set(day.repositories.flatMap((r) => r.moves.map((move) => `${r.repository}\u0000${move.name}`)));
  const gone = new Map<string, { repository: string; move: ScanMove; on: number; run: string }>();
  for (let i = 0; i < earlier.length; i++) {
    const before = earlier[i];
    if (!before) continue;
    const next = earlier[i + 1]?.at ?? at;
    for (const r of before.day.repositories) {
      if (!judged.has(r.repository)) continue;
      for (const move of r.moves) {
        const id = identity(r.repository, move);
        // A visitor's lockfile moves have no package to tell them apart: one of them listed today keeps them all.
        if (today.has(id) || carried.has(id) || (!move.package && names.has(`${r.repository}\u0000${move.name}`)))
          continue;
        gone.set(id, { repository: r.repository, move, on: next, run: runPage(r).url });
      }
    }
  }
  for (const [id, { repository, move, on, run }] of gone) {
    const key = `done ${id.replaceAll('\u0000', ' ').trim()}`;
    rows.push(doneRow(repository, move, move.name, undefined, on, key, run, undefined));
  }
  return rows.sort((a, b) => (b.on ?? 0) - (a.on ?? 0));
}

/** Patching at t, from the sense's last day, the days before it and the line's work items. */
export function patchingView(events: readonly PublicEvent[], items: readonly ItemState[], t: number): PatchingView {
  const read = lastRead(events, t);
  if (!read) return { state: 'unread' };
  return dayView(read.payload, Date.parse(read.ts), items, daysBefore(events, read), readAt(read));
}

/** One day's view, appended at `at` and its pull requests read at `read`: what it says holds whatever the time. */
export function dayView(
  day: Day,
  at: number,
  items: readonly ItemState[],
  earlier: readonly Earlier[] = [],
  read = at,
): PatchingView {
  const keys = rowKeys(day);
  const standings = day.repositories.map((r) => r.moves.map((move) => standingOf(r, move)));
  const folded = heldWith(day, standings);
  // Each move with the time its repository's run judged it: the day's line counts its reasons as the scan did then,
  // so the rows it says hold each are found by the same clock, not by the viewer's.
  const judgedMoves = day.repositories.flatMap((r, i) => {
    const judged = r.judged === null ? at : Date.parse(r.judged);
    return r.moves.map((move, j) => ({
      judged,
      folded: folded[i]?.[j],
      i,
      row: moveRow(r, move, standings[i]?.[j] as Standing, items, keys.moves[i]?.[j] ?? ''),
    }));
  });
  // A move held with another is in that one's row.
  for (const { i, folded: into, row } of judgedMoves) {
    if (into === undefined) continue;
    judgedMoves
      .find((m) => m.i === i && m.folded === undefined && m.row.key === keys.moves[i]?.[into])
      ?.row.held.push(row);
  }
  const moveRows = judgedMoves.map(({ row }) => row);
  const waitingRows = day.repositories.flatMap((r, i) =>
    r.waiting.map((w, j) => waitingRow(r, w, waitingStanding(r, w), keys.waiting[i]?.[j] ?? '')),
  );
  const firstRun = day.repositories[0] ? runPage(day.repositories[0]).url : '';
  const live = [
    ...judgedMoves.filter((m) => m.folded === undefined && m.row.state.kind !== 'merged').map(({ row }) => row),
    ...waitingRows,
    ...day.rows.map((row, i) => runningRow(row, keys.running[i] ?? '', firstRun)),
  ];
  const groups = PATCH_GROUPS.map((group) => ({
    group,
    rows: byDeadline(live.filter((row) => row.group === group)),
  })).filter(({ rows }) => rows.length > 0);
  const moving = byDeadline(live.filter((row) => !row.waits));
  const rows = [...groups.flatMap(({ rows }) => rows), ...moving];
  const running = { 'unscanned-digest': 0, 'unlisted-image': 0, 'not-running': 0 };
  for (const row of day.rows) running[row.row]++;
  const failed = [...new Set(day.repositories.flatMap((r) => r.failed))];
  const conclusions = day.repositories.map((r) => r.run.conclusion);
  const scanned = rows.filter((row) => row.source.kind === 'move' || row.source.kind === 'waiting');
  const counted = [...scanned, ...scanned.flatMap((row) => row.held)];
  // A lockfile's move whose package the events withhold is left out of every sum, so nothing it clears can be
  // worked out from them: a visitor never reads what a lockfile's package clears.
  const summed = counted.filter(
    (row) => !(row.source.kind === 'move' && row.source.lockfile && row.name === undefined),
  );
  const clearing = summed.filter((row) => row.clears && total(row.clears) > 0);
  const scanDay: ScanDay = {
    passed: failed.length === 0 && conclusions.every((c) => c === 'success'),
    failed,
    finished: Math.max(...day.repositories.map((r) => Date.parse(r.run.finished))),
    newHighWithFix: day.repositories.reduce((n, r) => n + (r.totals?.newHighWithFix ?? 0), 0),
    newHighWithoutFix: day.repositories.reduce((n, r) => n + (r.totals?.newHighWithoutFix ?? 0), 0),
    overdue: sum(day.repositories, 'overdue'),
    dueWithinDay: sum(day.repositories, 'dueWithinDay'),
    movesWithNew: moveRows.filter((row) => row.newToday > 0 && row.clears && row.clears.critical + row.clears.high > 0)
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
  const days = waitingRows.filter((row) => row.state.kind === 'day');
  return {
    state: 'read',
    at,
    read,
    rows,
    groups,
    moving,
    done: doneOf(day, at, earlier),
    moves: counted.length,
    waiting: rows.filter((row) => row.waits).length,
    running,
    day: scanDay,
    scans: day.repositories.map((r) => ({
      repository: r.repository,
      judged: r.judged === null ? undefined : Date.parse(r.judged),
      run: runPage(r).url,
    })),
    waitDay: { count: days.length, name: days.length === 1 ? days[0]?.name : undefined },
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
    open: openOf(day.repositories),
    clears: summed.reduce((n, row) => (row.clears ? plus(n, row.clears) : n), NONE),
    compared: day.compared,
    containers: day.containers,
  };
}
