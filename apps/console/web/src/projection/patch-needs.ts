/**
 * The moves that wait on Martin, as Needs you shows them: one card for each move of the sense's last day whose lane only
 * he moves (his approval, his cluster's own command, or an issue, where no pull request of the App's can write it), and
 * one for each row the sense made of what the cluster runs, which nothing scanned. A pure function of the events, which
 * needs no time: a card's deadline is said at t by the card.
 *
 * It is in the first view, as Needs you is, so it is kept small: the sense's day, its role, a row's key and a deadline's
 * words, which the Patching panel's chunk imports from here rather than carrying a second copy. Everything else of the
 * day stays in that chunk (`patching.ts`).
 *
 * A card says only what the event gives. The sense's day names each move's lane, its pins, from and to, what it clears
 * and its deadline; the pull request the factory's App opens for a held pin, and the review gate's verdict on it, are on
 * GitHub, and no event records them yet, so a held pin's card names its move and opens its row, and links nowhere.
 */
import type { MoveLane, PayloadOf, PublicEvent } from '@software-factory/events';

/** The role that appends the sense's day: a `patching.read` from any other is not read. */
export const PATCHING_ROLE = 'factory_patching';

type Day = PayloadOf<'patching.read'>;
type Running = Day['rows'][number];

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/**
 * The event a card in Needs you sends to open its row in the Patching panel, which arrives in a chunk of its own, so
 * the two share no state: the panel opens the row the event names, and scrolls to it.
 */
export const OPEN_ROW = 'patching:open-row';

/** The lanes only Martin moves: his approval, his cluster's own command, and what no pull request of the App's can write. */
export const HIS: readonly MoveLane[] = ['approval', 'cluster', 'issue'];

/**
 * Each row's key in a day, the same for Martin and a visitor and while its pull request opens: a move's repository and
 * name, or, for a lockfile's, whose name is the file's for every one of them, its place among the repository's lockfile
 * moves; a row the sense made, by what it found and where.
 */
export function moveKeys(day: Day): string[][] {
  return day.repositories.map((r) => {
    let lockfiles = 0;
    return r.moves.map((move) =>
      move.lockfile ? `${r.repository} lockfile ${++lockfiles}` : `${r.repository} ${move.name}`,
    );
  });
}

export function runningKey(row: Running): string {
  switch (row.row) {
    case 'unlisted-image':
      return `unlisted ${row.namespace}/${row.pod}/${row.container}`;
    case 'unscanned-digest':
      return `unscanned ${row.namespace}/${row.pod}/${row.container}`;
    case 'not-running':
      return `not-running ${row.repository} ${row.item}`;
  }
}

/**
 * A deadline as a row says it: "in 40 min", "in 21 h", "in 1 day 20 h", "in 4 days", or how long past. Each unit is
 * counted down, never rounded up, so a row never says a deadline is further off, or longer past, than it is.
 */
export function dueWords(deadline: number | undefined, t: number): string {
  if (deadline === undefined) return 'none';
  const left = deadline - t;
  const span = Math.abs(left);
  const words =
    span < HOUR
      ? `${Math.max(1, Math.floor(span / 60_000))} min`
      : span < DAY
        ? `${Math.floor(span / HOUR)} h`
        : span < 2 * DAY
          ? `1 day${Math.floor((span - DAY) / HOUR) ? ` ${Math.floor((span - DAY) / HOUR)} h` : ''}`
          : `${Math.floor(span / DAY)} days`;
  return left > 0 ? `in ${words}` : `${words} past`;
}

/** Whether a deadline is within a day or past: the one place a deadline takes the warm colour. */
export const dueSoon = (deadline: number | undefined, t: number) => deadline !== undefined && deadline - t <= DAY;

/** A card for a move that waits on Martin. */
export interface PatchNeed {
  /** Its row's key in the Patching panel, which the card opens. */
  key: string;
  /** What waits: a lane only he moves, or what the sense found running. */
  kind: 'approval' | 'cluster' | 'issue' | Running['row'];
  /** What moves, as the event names it; undefined for a lockfile's package the public view withholds. */
  name: string | undefined;
  /** From and to, as the scan writes them; undefined where the event withholds them or a row has none. */
  from: string | undefined;
  to: string | undefined;
  /** What it clears at the two severities a card names; undefined for a row the sense made, which nothing scanned. */
  clears: { critical: number; high: number } | undefined;
  deadline: number | undefined;
  /** Where it runs, for a row the sense made of a pod. */
  runs: { namespace: string; pod: string; image: string } | undefined;
  /** Since when it has waited: the first of the sense's days in a row that had it. */
  since: number;
}

/** A digest shortened to its first eight, as the console writes a commit's seven. */
const shortDigests = (text: string) => text.replace(/@?sha256:([0-9a-f]{8})[0-9a-f]{56}/g, ' $1').trim();

function needsOf(day: Day): Omit<PatchNeed, 'since'>[] {
  const keys = moveKeys(day);
  const moves = day.repositories.flatMap((r, i) =>
    r.moves.flatMap((move, j): Omit<PatchNeed, 'since'>[] => {
      if (!HIS.includes(move.lane)) return [];
      const shown = move.lockfile ? move.package : undefined;
      return [
        {
          key: keys[i]?.[j] ?? '',
          kind: move.lane as PatchNeed['kind'],
          name: move.lockfile ? shown?.name : move.name,
          from: move.lockfile ? shown?.from : shortDigests(move.from) || undefined,
          to: move.lockfile ? shown?.to || undefined : move.to || undefined,
          clears: { critical: move.clears.critical, high: move.clears.high },
          deadline: move.deadline === undefined ? undefined : Date.parse(move.deadline),
          runs: undefined,
        },
      ];
    }),
  );
  const running = day.rows.map(
    (row): Omit<PatchNeed, 'since'> => ({
      key: runningKey(row),
      kind: row.row,
      name: shortDigests(row.image),
      from: undefined,
      to: undefined,
      clears: undefined,
      deadline: undefined,
      runs:
        row.row === 'not-running'
          ? undefined
          : { namespace: row.namespace, pod: row.pod, image: shortDigests(`${row.image}@${row.digest}`) },
    }),
  );
  return [...moves, ...running];
}

/**
 * Every move of the sense's last day in the events that waits on Martin, each with when it began to: the first of the
 * sense's days, unbroken to the last, that had it waiting. Oldest first.
 */
export function patchNeeds(events: readonly PublicEvent[]): PatchNeed[] {
  const since = new Map<string, number>();
  let last: Omit<PatchNeed, 'since'>[] = [];
  for (const event of events) {
    if (event.type !== 'patching.read' || event.appended_by !== PATCHING_ROLE) continue;
    const at = Date.parse(event.ts);
    last = needsOf(event.payload);
    const now = new Set(last.map((need) => need.key));
    for (const key of since.keys()) if (!now.has(key)) since.delete(key);
    for (const key of now) if (!since.has(key)) since.set(key, at);
  }
  return last.map((need) => ({ ...need, since: since.get(need.key) ?? 0 })).sort((a, b) => a.since - b.since);
}
