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
 *   day of it is told by `move-fix` alone, which says it is due;
 * - `move-overdue`: a move still in the sense's last day passes its deadline;
 * - `app-fix-merged`: the line merges, without him, the pull request of a work item opened for a vulnerable dependency
 *   of the app (`work-item.opened`'s `dependency.security`), which at Guarded only the review gate's rule for a
 *   Critical fix lets it do.
 *
 * A deadline is judged at the time each day arrives, for the moves of the day before, and at the clock's time for the
 * last day's, so a line that restarts and reads the store again counts what the line before it counted: a move leaves
 * the days only with a day, and each check of the day it left is made at that day's time. Every read of the store, and
 * every count, is the security events' (`security.ts`), whose gauge says when a read fails.
 */
import type { PayloadOf } from '@software-factory/events';

export const PATCHING_KINDS = ['move-fix', 'move-waits', 'move-due-soon', 'move-overdue', 'app-fix-merged'] as const;
export type PatchingKind = (typeof PATCHING_KINDS)[number];

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
 * A move's key across days: its repository and what moves, the package for a lockfile's (the store's day has it), or
 * its place among the repository's lockfile moves where the day gives none.
 */
const moveKey = (repository: string, move: Move, lockfiles: number) =>
  `${repository} ${move.lockfile ? (move.package?.name ?? `lockfile ${lockfiles}`) : move.name}`;

/** A row the sense made, by what it found and where. */
function rowKey(row: Day['rows'][number]): string {
  return row.row === 'not-running'
    ? `not-running ${row.repository} ${row.item}`
    : `${row.row} ${row.namespace}/${row.pod}/${row.container}`;
}

/** Each deadline of the last day's moves judged at t: within a day, or past. */
export function judgeDeadlines(tally: PatchingTally, t: number): void {
  for (const [key, deadline] of tally.deadlines) {
    if (deadline <= t) {
      once(tally, 'move-overdue', key);
      // One past its deadline has passed the day before it too, so it is not told of again as due within a day.
      tally.counted['move-due-soon'].add(key);
    } else if (deadline - t <= DAY) once(tally, 'move-due-soon', key);
  }
}

/** Adds the sense's day, which arrived at `at`: the day before's deadlines judged then, and this day's moves. */
export function addDay(tally: PatchingTally, day: Day, at: number): void {
  judgeDeadlines(tally, at);
  const deadlines = new Map<string, number>();
  for (const repository of day.repositories) {
    let lockfiles = 0;
    for (const move of repository.moves) {
      const key = moveKey(repository.repository, move, move.lockfile ? ++lockfiles : lockfiles);
      const first = !tally.counted['move-fix'].has(key);
      if (move.clears.critical + move.clears.high > 0) once(tally, 'move-fix', key);
      if (HIS.includes(move.lane)) once(tally, 'move-waits', key);
      if (move.deadline === undefined) continue;
      const deadline = Date.parse(move.deadline);
      // A move first seen within a day of its deadline is told of by its fix, which says when it is due.
      if (first && tally.counted['move-fix'].has(key) && deadline - at <= DAY && deadline > at) {
        tally.counted['move-due-soon'].add(key);
      }
      deadlines.set(key, deadline);
    }
  }
  for (const row of day.rows) once(tally, 'move-waits', rowKey(row));
  tally.deadlines = deadlines;
}

/** Adds one of the line's merges: counted when the line merged a vulnerable dependency's fix for the app. */
export function addMerge(tally: PatchingTally, workItem: string, by: unknown, securityFix: unknown): void {
  if (by === 'factory' && securityFix === true) once(tally, 'app-fix-merged', workItem);
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
