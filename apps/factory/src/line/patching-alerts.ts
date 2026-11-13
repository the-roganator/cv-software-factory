/**
 * The moves Martin hears of, counted from the dependency sense's days (`patching.read`) and the line's merges, for the
 * alerts that reach his phone (docs/COMPONENTS/ALERTING.md). He hears of a move, never of a finding: a finding with no
 * fix is nothing he can act on, and no move carries one, so nothing here counts it. Each kind is counted once for each
 * move, ever, so nothing repeats on a timer, and a day has at most a message or two for a move:
 *
 * - `move-fix`: a move first clears a High or a Critical, which a fix the scan found has given it;
 * - `move-waits`: a move first waits on him: its lane is his approval, his cluster's own command or an issue, or it is a
 *   row the sense made of what the cluster runs;
 * - `move-due-soon`: a move still in the sense's last day comes within a day of its deadline. One first seen within a
 *   day of it, or past it, is told by `move-fix` alone, which says it is due; one that passes its deadline unjudged
 *   before (the line was down) is counted here as it is counted overdue, so a line that reads the store again counts
 *   the same;
 * - `move-overdue`: a move still in the sense's last day passes its deadline. The sense's day is the scan's, once a
 *   day: a move merged since the last is still in it until the next, and may be told of until then;
 * - `app-fix-merged`: the line merges (its role's `pull-request.merged`, queued by it) the pull request of a work item
 *   opened for a vulnerable dependency of the app (`work-item.opened`'s `dependency.security`), with no merge hold on
 *   that work item before it: a merge Martin approved after a hold is his, and not told. At Guarded only the review
 *   gate's rule for a Critical fix lets the line do so.
 *
 * A deadline is judged at the time each day arrives, for the moves of the day before, and at the clock's time for the
 * last day's, so a line that restarts and reads the store again counts what the line before it counted: a move leaves
 * the days only with a day, and each check of the day it left is made at that day's time. Every read of the store, and
 * every count, is the security events' (`security.ts`), whose gauge says when a read fails.
 */
import type { PayloadOf } from '@software-factory/events';

export const PATCHING_KINDS = ['move-fix', 'move-waits', 'move-due-soon', 'move-overdue', 'app-fix-merged'] as const;
export type PatchingKind = (typeof PATCHING_KINDS)[number];

/** The one role whose merges are read: the line's (0023's `line_only_event`). */
export const LINE_ROLE = 'factory_line';

/** The one role whose days are read (0050_patching.sql). */
export const PATCHING_ROLE = 'factory_patching';

type Day = PayloadOf<'patching.read'>;
type Move = Day['repositories'][number]['moves'][number];

const DAY = 24 * 3_600_000;

/** The lanes only Martin moves: his approval, his cluster's own command, and what no pull request of the App's can write. */
const HIS: readonly Move['lane'][] = ['approval', 'cluster', 'issue'];

/** The counts so far, what each has counted, and the deadlines of the last day's moves, by move. */
export interface PatchingTally {
  kinds: Record<PatchingKind, number>;
  counted: Record<PatchingKind, Set<string>>;
  deadlines: Map<string, number>;
}

export const emptyPatchingTally = (): PatchingTally => ({
  kinds: Object.fromEntries(PATCHING_KINDS.map((kind) => [kind, 0])) as Record<PatchingKind, number>,
  counted: Object.fromEntries(PATCHING_KINDS.map((kind) => [kind, new Set<string>()])) as Record<
    PatchingKind,
    Set<string>
  >,
  deadlines: new Map(),
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
  const deadlines = new Map<string, number>();
  for (const repository of day.repositories) {
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
      if (HIS.includes(move.lane)) once(tally, 'move-waits', key);
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
});
