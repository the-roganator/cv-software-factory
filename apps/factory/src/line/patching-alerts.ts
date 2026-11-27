/**
 * The moves Martin hears of, counted from the dependency sense's days (`patching.read`) and the line's merges, for the
 * alerts that reach his phone (docs/COMPONENTS/ALERTING.md). He hears of a move, never of a finding: a finding with no
 * fix is nothing he can act on, and no move carries one, so nothing here counts it. Nor does he hear of a routine
 * update, a pin merely behind that no finding asks to move (`routine`): nothing is due, whoever's lane it is in, and
 * its pull request or its issue is where it waits. Each kind is counted once for each
 * move, ever, so nothing repeats on a timer, and a day has at most a message or two for a move:
 *
 * - `move-fix`: a move first clears a High or a Critical, which a fix the scan found has given it;
 * - `move-waits`: a move a finding asks for first waits on him: its lane is his cluster's own command, an issue, or no
 *   one's (`none`, a line no longer built, whose issue asks him to mend or remove it), or it is a row the sense made of
 *   what the cluster runs (a k3s the cluster has not moved to, a routine update's too);
 * - `move-stopped`: the factory tried a move and stopped (`stopped`), once for each pull request, issue or pin and
 *   why: a pull request whose required checks failed on every try, that the merge queue took out on every try, or that
 *   conflicts with `main`; an issue for a move the scan's pin step refused, whose branch another's pull request stands
 *   on, whose pull request GitHub refused, or whose branch's closed pull requests the watch could not all read; or a pin
 *   a finding with a deadline asks to move that no release is better than. A routine update's never is;
 * - `move-due-soon`: a move still in the sense's last day comes within a day of its deadline. One first seen within a
 *   day of it, or past it, is told by `move-fix` alone, which says it is due; one that passes its deadline unjudged
 *   before (the line was down) is counted here as it is counted overdue, so a line that reads the store again counts
 *   the same;
 * - `move-overdue`: a move still in the sense's last day passes its deadline. The sense's day is the scan's, once a
 *   day: a move merged since the last is still in it until the next, and may be told of until then;
 * - `app-fix-merged`: the line merges (its role's `pull-request.merged`, queued by it) the pull request of a work item
 *   opened for a vulnerable dependency of the app (`work-item.opened`'s `dependency.security`), with no merge hold on
 *   that work item before it: a merge Martin approved after a hold is his, and not told. At Guarded the review gate's
 *   `move` rule lets the line do so; a `major` waits for Lights-out.
 *
 * A deadline is judged at the time each day arrives, for the moves of the day before, and at the clock's time for the
 * last day's, so a line that restarts and reads the store again counts what the line before it counted: a move leaves
 * the days only with a day, and each check of the day it left is made at that day's time. Every read of the store, and
 * every count, is the security events' (`security.ts`), whose gauge says when a read fails.
 *
 * And he hears when the scan stops (`staleScans`): a repository whose newest scan in the sense's days judged its moves
 * more than `SCAN_MAX_AGE_HOURS` ago, by the clock. No day arriving is the same to it as a day with no newer scan, so
 * it says so whether the scan has stopped running, fails before it judges, or the sense can no longer read it. And
 * he hears when the sense stops (`senseStaleFor`): no day has arrived in `SENSE_MAX_AGE_HOURS`, though the sense
 * appends one at least every `KEEP_DAY_HOURS`. Each is a condition, not a count, given as how long it has stood, so its
 * rule tells him once: it ends when a day arrives with a scan judged since, or a day at all. A repository no scan has
 * judged yet is measured from the first day that says so, and a store with no day at all, as a new cluster's is until
 * the sense's first read, has nothing to measure from: nothing is stale there.
 */
import type { PayloadOf } from '@software-factory/events';
import { SCAN_MAX_AGE_HOURS } from '../../../../policy/vulnerabilities.ts';
import { KEEP_DAY_HOURS } from '../patching/schedule.ts';

export const PATCHING_KINDS = [
  'move-fix',
  'move-waits',
  'move-stopped',
  'move-due-soon',
  'move-overdue',
  'app-fix-merged',
] as const;
export type PatchingKind = (typeof PATCHING_KINDS)[number];

/** The one role whose merges are read: the line's (0023's `line_only_event`). */
export const LINE_ROLE = 'factory_line';

/** The one role whose days are read (0050_patching.sql). */
export const PATCHING_ROLE = 'factory_patching';

type Day = PayloadOf<'patching.read'>;
type Move = Day['repositories'][number]['moves'][number];
type Pull = Day['repositories'][number]['pulls'][number];
type Waiting = Day['repositories'][number]['waiting'][number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The lanes only Martin moves: his cluster's own command, what no pull request of the App's can write, and a line no
 * longer built, which nobody's pull request can move.
 */
const HIS: readonly Move['lane'][] = ['cluster', 'issue', 'none'];

/** Why an open pull request stopped: its checks spent, the queue's tries spent, or a conflict with `main`. */
const STOPPED_HOLDS: readonly NonNullable<Pull['hold']>[] = ['checks-spent', 'queue-spent', 'conflict'];

/** Why the App opened an issue for a move it tried: refused, a branch held, GitHub refusing, or history unread. */
const STOPPED_ISSUES: readonly NonNullable<Pull['issue']>[] = [
  'refused',
  'branch-held',
  'open-refused',
  'history-unread',
];

/**
 * Why a pull request or issue that carries a move was tried and stopped, as a key that is the same on every day it
 * stands: its repository, its number and why; nothing for one that waits for anything else, or has settled.
 */
function stopped(repository: string, pull: Pull): string | null {
  if (pull.state !== 'open') return null;
  const which = `${repository} #${pull.number ?? pull.moves.map((move) => move.name).join(' ')}`;
  if (pull.kind === 'issue')
    return pull.issue && STOPPED_ISSUES.includes(pull.issue)
      ? `${which} ${pull.issue}${pull.refusal ? ` ${pull.refusal}` : ''}`
      : null;
  return pull.hold && STOPPED_HOLDS.includes(pull.hold) ? `${which} ${pull.hold}` : null;
}

/** A pin a finding with a deadline asks to move that no release is better than; never a routine update's. */
const noBetter = (repository: string, wait: Waiting) =>
  wait.why === 'no-better' && wait.deadline !== undefined && !wait.routine
    ? `${repository} ${wait.name} no-better`
    : null;

/**
 * How long without a day before Martin hears that the sense has stopped: it reads each hour, and appends a day at least
 * every 12 hours (`KEEP_DAY_HOURS`), so two of those missed, and two hours' reads more.
 */
export const SENSE_MAX_AGE_HOURS = 2 * KEEP_DAY_HOURS + 2;

/**
 * Whether a day's move is a routine update, as moves.ts's `isRoutine` says of the scan's own: it clears nothing and has
 * a lane. A move with no lane (`none`) is a line no longer built, which a finding found.
 */
const routine = (move: Move) => Object.values(move.clears).every((count) => count === 0) && move.lane !== 'none';

/**
 * The counts so far, what each has counted, and the deadlines of the last day's moves, by move; for each repository
 * the days have named, when its newest scan judged its moves, or, while none has, when the first day arrived that said
 * so; and when the last day arrived, or null before the first.
 */
export interface PatchingTally {
  kinds: Record<PatchingKind, number>;
  counted: Record<PatchingKind, Set<string>>;
  deadlines: Map<string, number>;
  scans: Map<string, { judged: boolean; at: number }>;
  lastDay: number | null;
}

export const emptyPatchingTally = (): PatchingTally => ({
  kinds: Object.fromEntries(PATCHING_KINDS.map((kind) => [kind, 0])) as Record<PatchingKind, number>,
  counted: Object.fromEntries(PATCHING_KINDS.map((kind) => [kind, new Set<string>()])) as Record<
    PatchingKind,
    Set<string>
  >,
  deadlines: new Map(),
  scans: new Map(),
  lastDay: null,
});

/** Counts a kind for a key, once ever. */
function once(tally: PatchingTally, kind: PatchingKind, key: string) {
  if (tally.counted[kind].has(key)) return;
  tally.counted[kind].add(key);
  tally.kinds[kind] += 1;
}

/**
 * A move's key across days: its repository and what moves; for a lockfile's, its file and package (the store's day has
 * it), or its place among the repository's lockfile moves where the day gives none.
 */
const moveKey = (repository: string, move: Move, lockfiles: number) =>
  `${repository} ${
    move.lockfile ? `${move.pins[0]?.file ?? ''} ${move.package?.name ?? `lockfile ${lockfiles}`}` : move.name
  }`;

/**
 * A row the sense made, by what it found and what runs, never by its pod, whose name a rollout changes: the same image
 * in a new pod is the same thing to move.
 */
function rowKey(row: Day['rows'][number]): string {
  return row.row === 'not-running'
    ? `not-running ${row.repository} ${row.item}`
    : `${row.row} ${row.namespace} ${row.image}@${row.digest}`;
}

/** Each deadline of the last day's moves judged at t: within a day, or past. */
export function judgeDeadlines(tally: PatchingTally, t: number): void {
  for (const [key, deadline] of tally.deadlines) {
    if (deadline <= t) {
      // Past it is past the day before it too: counted now if it was not, as a line running then would have.
      once(tally, 'move-due-soon', key);
      once(tally, 'move-overdue', key);
    } else if (deadline - t <= DAY) once(tally, 'move-due-soon', key);
  }
}

/**
 * Adds the sense's day, which arrived at `at`: the day before's deadlines judged then, and this day's moves. A
 * repository whose run judged no moves (it failed early) keeps the deadlines it had: its moves did not go.
 */
export function addDay(tally: PatchingTally, day: Day, at: number): void {
  judgeDeadlines(tally, at);
  tally.lastDay = Math.max(tally.lastDay ?? at, at);
  const deadlines = new Map<string, number>();
  for (const repository of day.repositories) {
    // What was tried and stopped, whether or not the scan judged its moves today: its pull requests stand apart. A day
    // stored before the sense read them has neither its pull requests nor its waits.
    const { pulls = [], waiting = [] }: Partial<Pick<typeof repository, 'pulls' | 'waiting'>> = repository;
    // A routine update tried and stopped sends nothing, as a routine wait does: nothing is due. A pull request carries
    // a routine move alone when every move of the day it names is one; one it names that the day no longer lists, or a
    // lockfile's the day names by its file, counts as not routine, so a stop is said rather than missed.
    const routineNames = new Set(repository.moves.filter(routine).map((move) => move.name));
    const notRoutine = new Set(repository.moves.filter((move) => !routine(move)).map((move) => move.name));
    const routineAlone = (pull: Pull) =>
      pull.moves.every((move) => routineNames.has(move.name) && !notRoutine.has(move.name));
    for (const pull of pulls) {
      const key = stopped(repository.repository, pull);
      if (key && !routineAlone(pull)) once(tally, 'move-stopped', key);
    }
    for (const wait of waiting) {
      const key = noBetter(repository.repository, wait);
      if (key) once(tally, 'move-stopped', key);
    }
    const scan = tally.scans.get(repository.repository);
    if (repository.judged !== null) {
      const judged = Date.parse(repository.judged);
      if (!scan?.judged || judged > scan.at) tally.scans.set(repository.repository, { judged: true, at: judged });
    } else if (!scan) tally.scans.set(repository.repository, { judged: false, at });
    if (repository.judged === null) {
      for (const [key, deadline] of tally.deadlines) {
        if (key.startsWith(`${repository.repository} `)) deadlines.set(key, deadline);
      }
      continue;
    }
    let lockfiles = 0;
    for (const move of repository.moves) {
      const key = moveKey(repository.repository, move, move.lockfile ? ++lockfiles : lockfiles);
      const first = !tally.counted['move-fix'].has(key);
      if (move.clears.critical + move.clears.high > 0) once(tally, 'move-fix', key);
      if (HIS.includes(move.lane) && !routine(move)) once(tally, 'move-waits', key);
      if (move.deadline === undefined) continue;
      const deadline = Date.parse(move.deadline);
      // A move first seen within a day of its deadline, or past it, is told of by its fix, which says when it is due.
      if (first && tally.counted['move-fix'].has(key) && deadline - at <= DAY) {
        tally.counted['move-due-soon'].add(key);
      }
      deadlines.set(key, deadline);
    }
  }
  for (const row of day.rows) once(tally, 'move-waits', rowKey(row));
  tally.deadlines = deadlines;
}

/**
 * How long, at t, something last seen at `at` has been older than `hours`, in seconds rounded up, as this line has
 * seen it: measured from that age, or from `since` (when this line began reading) if later, so a cluster that wakes
 * with an old day is measured from its waking, as the sense reads within minutes of starting; 0 while it is not that
 * old.
 */
function staleFor(at: number, hours: number, t: number, since: number): number {
  if (t - at <= hours * HOUR) return 0;
  return Math.max(0, Math.ceil((t - Math.max(at + hours * HOUR, since)) / 1000));
}

/**
 * Each repository the days have named, and how long its scan has been stale at t (`staleFor`): its newest judged its
 * moves more than `SCAN_MAX_AGE_HOURS` before, or none has in that long since the first day that named it.
 */
export function staleScans(tally: PatchingTally, t: number, since: number): { repository: string; staleFor: number }[] {
  return [...tally.scans].map(([repository, scan]) => ({
    repository,
    staleFor: staleFor(scan.at, SCAN_MAX_AGE_HOURS, t, since),
  }));
}

/**
 * How long the sense has been stale at t (`staleFor`): its last day arrived more than `SENSE_MAX_AGE_HOURS` before.
 * Null before any day, when there is nothing to measure from.
 */
export function senseStaleFor(tally: PatchingTally, t: number, since: number): number | null {
  return tally.lastDay === null ? null : staleFor(tally.lastDay, SENSE_MAX_AGE_HOURS, t, since);
}

/**
 * Adds one of the line's merges: counted when the line queued and merged a vulnerable dependency's fix for the app that
 * no merge hold had waited on Martin for.
 */
export function addMerge(
  tally: PatchingTally,
  merge: { workItem: string; by: unknown; appendedBy: unknown; securityFix: unknown; held: unknown },
): void {
  const { workItem, by, appendedBy, securityFix, held } = merge;
  if (by === 'factory' && appendedBy === LINE_ROLE && securityFix === true && held === false) {
    once(tally, 'app-fix-merged', workItem);
  }
}

/** A copy that a read can change and drop, so a read that fails leaves the tally as it was. */
export const copyPatchingTally = (tally: PatchingTally): PatchingTally => ({
  kinds: { ...tally.kinds },
  counted: Object.fromEntries(PATCHING_KINDS.map((kind) => [kind, new Set(tally.counted[kind])])) as Record<
    PatchingKind,
    Set<string>
  >,
  deadlines: new Map(tally.deadlines),
  scans: new Map(tally.scans),
  lastDay: tally.lastDay,
});
