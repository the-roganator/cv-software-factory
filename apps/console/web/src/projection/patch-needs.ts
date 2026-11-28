/**
 * Where each move of the dependency sense's day stands, and what of it waits on Martin, as Needs you shows it: one
 * Patching card at most, counting what waits by what he does, with the first deadline among them, while anything waits
 * or the day is stale. A pure function of the events; the card's staleness and its deadline's words are said at t.
 *
 * It is in the first view, as the rest of `project()` is, so it is kept small: the sense's day, its role, where a move
 * stands and why, a row's key and a deadline's words, which Patching's summary and sheet import from here rather than
 * carrying a second copy. Everything else of the day stays in that chunk (`patching.ts`).
 *
 * Where a move stands is what the day says of it and of the pull requests and issues that carry it (`pulls`, the
 * GitHub worker's read of them): it waits on Martin when he alone can move it on, grouped by what he does; it moves by
 * itself while the factory carries it; and it is done once the pull request that carried it merged. A move is joined to
 * a pull request by its name, and a lockfile's by its package too, which the public view leaves out of both: a visitor's
 * lockfile move is joined to every one of its repository's lockfile pull requests, and one the view withholds, which
 * waits on Martin, makes it wait on him, saying nothing of why.
 */
import type { MoveLane, PayloadOf, PublicEvent } from '@software-factory/events';

/** The role that appends the sense's day. */
export const PATCHING_ROLE = 'factory_patching';
/**
 * Whether an event is the sense's day: a `patching.read` its role appended, or Martin's command line's, which the store
 * lets append one only into a store of samples (`make samples`; migration 0050's restrictive policy). From any other,
 * it is not read.
 */
export const isSensesDay = (event: PublicEvent): event is PublicEvent<'patching.read'> =>
  event.type === 'patching.read' && (event.appended_by === PATCHING_ROLE || event.appended_by === 'factory_operator');

type Day = PayloadOf<'patching.read'>;
type Repository = Day['repositories'][number];
type ScanMove = Repository['moves'][number];
type Waiting = Repository['waiting'][number];
type Running = Day['rows'][number];
export type Pull = Repository['pulls'][number];

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** How old the sense's last read of the pull requests may be before the console says it may be out of date. */
export const READ_STALE_HOURS = 26;
/**
 * How long ago a scan may have been judged and the review gate still pass its moves: policy's `SCAN_MAX_AGE_HOURS`
 * (`policy/vulnerabilities.ts`), which the console's image does not carry; a test holds the two equal.
 */
export const SCAN_MAX_AGE_HOURS = 36;

/** What Martin does about a row that waits on him, in the order the sheet groups them. */
export const PATCH_GROUPS = ['approve', 'bench', 'held', 'stuck', 'hand', 'martin'] as const;
export type PatchGroup = (typeof PATCH_GROUPS)[number];

/**
 * Why a row waits on Martin: the hold of its pull request, the ask of its issue, its lane where nothing carries it yet,
 * what the scan found of a pin that waits, a pull request a person closed, what the sense found running, or, for a
 * visitor, a lockfile's move whose pull request the public view withholds.
 */
export type WaitWhy =
  | 'level'
  | 'held'
  | 'martin'
  | 'bench'
  | 'reverted'
  | 'with-reverted'
  | 'changes-requested'
  | 'dequeued'
  | 'label'
  | 'closed'
  | 'checks-spent'
  | 'queue-spent'
  | 'refused'
  | 'branch-held'
  | 'open-refused'
  | 'history-unread'
  | 'no-better'
  | 'cluster'
  | 'workflow'
  | 'none'
  | 'other'
  | 'issue'
  | Running['row']
  | 'withheld';

/** The group each reason waits in. */
export const GROUP_OF: Record<WaitWhy, PatchGroup> = {
  level: 'approve',
  held: 'approve',
  martin: 'approve',
  bench: 'bench',
  reverted: 'held',
  'with-reverted': 'held',
  'changes-requested': 'held',
  dequeued: 'held',
  label: 'held',
  closed: 'held',
  'checks-spent': 'stuck',
  'queue-spent': 'stuck',
  refused: 'stuck',
  'branch-held': 'stuck',
  'open-refused': 'stuck',
  'history-unread': 'stuck',
  'no-better': 'stuck',
  cluster: 'hand',
  workflow: 'hand',
  none: 'hand',
  other: 'hand',
  issue: 'hand',
  'unlisted-image': 'hand',
  'unscanned-digest': 'hand',
  'not-running': 'hand',
  withheld: 'martin',
};

/**
 * Where a row stands. It waits on Martin, for a reason; or it moves by itself: its pull request opened and not judged
 * yet, its checks running, in the merge queue, its fix waiting its day, nothing to move to, or no pull request yet,
 * which its lane says (and, for the line's, its work item's stage); `stopped` when it would queue but the line is
 * stopped. Or it is done: the pull request that carried it merged since its scan judged it.
 */
export type Standing =
  | { place: 'waits'; why: WaitWhy; pull: Pull | undefined }
  | {
      place: 'moves';
      state: 'opened' | 'checks' | 'queue' | 'day' | 'none' | 'lane';
      pull: Pull | undefined;
      stopped: boolean;
    }
  | { place: 'done'; pull: Pull };

const waits = (why: WaitWhy, pull?: Pull): Standing => ({ place: 'waits', why, pull });
const moves = (state: Extract<Standing, { place: 'moves' }>['state'], pull?: Pull, stopped = false): Standing => ({
  place: 'moves',
  state,
  pull,
  stopped,
});

/** Whether a pull request or issue carries a move: by its name, and a lockfile's by its package where both have one. */
export function carriesMove(pull: Pull, name: string, lockfile: boolean, pkg: string | undefined): boolean {
  return pull.moves.some(
    (m) =>
      m.lockfile === lockfile && m.name === name && (pkg === undefined || m.package === undefined || m.package === pkg),
  );
}

/**
 * Which of several open ones a row stands by: one withheld; then Dependabot's that is Martin's to merge, as a
 * third-party action's is, before the issue the pin watch opens for the same routine workflow pin; then an issue, then
 * the App's, then Dependabot's.
 */
const RANK = (pull: Pull) =>
  pull.withheld
    ? 0
    : pull.kind === 'dependabot' && pull.hold === 'martin'
      ? 1
      : pull.kind === 'issue'
        ? 2
        : pull.kind === 'pin'
          ? 3
          : 4;

/** The open pull request or issue a row stands by, and the newest settled one, of those that carry it. */
function pullsFor(repository: Repository, name: string, lockfile: boolean, pkg: string | undefined) {
  const carrying = repository.pulls.filter((pull) => carriesMove(pull, name, lockfile, pkg));
  const open = carrying.filter((pull) => pull.state === 'open').sort((a, b) => RANK(a) - RANK(b))[0];
  const settled = carrying
    .filter((pull) => pull.state !== 'open' && !(pull.kind === 'dependabot' && pull.state === 'closed'))
    .sort((a, b) => Date.parse(b.settled ?? '') - Date.parse(a.settled ?? ''))[0];
  return { open, settled };
}

/** An open pull request's or issue's standing. */
function openStanding(pull: Pull, lane: MoveLane): Standing {
  // The public view keeps of a lockfile's pull request that waits on Martin (an issue, or a hold) only what it is and
  // where it stands; one that moves by itself keeps its rule, checks and place in the queue.
  if (pull.withheld) {
    const moving = pull.kind !== 'issue' && (pull.rule || pull.checks || pull.queued);
    if (!moving) return waits('withheld', pull);
    return moves(pull.queued ? 'queue' : pull.checks?.state === 'running' ? 'checks' : 'opened', pull);
  }
  // Only the cluster's own command applies a new k3s, whatever its pull request's checks say.
  if (lane === 'cluster') return waits('cluster', pull);
  if (pull.kind === 'issue') return waits(pull.issue ?? 'other', pull);
  switch (pull.hold) {
    case 'level':
    case 'held':
    case 'martin':
    case 'changes-requested':
    case 'dequeued':
    case 'label':
    case 'checks-spent':
    case 'queue-spent':
      return waits(pull.hold, pull);
    // The pin watch commits the move again on main's head within the hour: nothing for Martin to do.
    case 'conflict':
      return moves('opened', pull);
    case 'verdict':
      return moves('opened', pull);
    case 'stopped':
      return moves(pull.queued ? 'queue' : pull.checks?.state === 'running' ? 'checks' : 'opened', pull, true);
    case 'checks':
      return moves('checks', pull);
    case undefined:
      return moves(pull.queued ? 'queue' : pull.checks?.state === 'running' ? 'checks' : 'opened', pull);
  }
}

/** Whether a move is a line nobody builds any more: the scan's grammar for its target says so. */
export const unbuilt = (move: Pick<ScanMove, 'to'>) => move.to.startsWith('another line');

/**
 * Where a move of the day stands, from its lane and the pull requests and issues that carry it. A merged one is done
 * once it merged after its scan judged the move, which a later scan then no longer lists; a scan judged after the merge
 * that still lists it lists it again, at a new target. One a person closed holds it, for the worker opens none again
 * for the same edits.
 */
export function standingOf(repository: Repository, move: ScanMove): Standing {
  const pkg = move.lockfile ? move.package?.name : undefined;
  const { open, settled } = pullsFor(repository, move.name, move.lockfile, pkg);
  if (open) return openStanding(open, move.lane);
  const judged = repository.judged === null ? Number.NEGATIVE_INFINITY : Date.parse(repository.judged);
  if (settled?.state === 'merged' && Date.parse(settled.settled ?? '') >= judged)
    return { place: 'done', pull: settled };
  if (settled?.state === 'closed' && settled.closedByPerson) return waits('closed', settled);
  switch (move.lane) {
    case 'cluster':
      return waits('cluster');
    case 'issue':
      return waits('issue');
    case 'none':
      return unbuilt(move) ? waits('none') : moves('none');
    case 'line':
    case 'worker':
      return moves('lane');
  }
}

/** Where a pin that waits stands: its content's day, by itself; no release better than the pin, on Martin. */
export function waitingStanding(repository: Repository, waiting: Waiting): Standing {
  const { open } = pullsFor(repository, waiting.name, false, undefined);
  if (open) return openStanding(open, 'worker');
  return waiting.why === 'content' ? moves('day') : waits('no-better');
}

/**
 * Each row's key in a day, the same for Martin and a visitor, while its pull request opens, and in the sheet's address
 * (`?move=`): a move's repository and name, or, for a lockfile's, whose name is the file's for every one of them, its
 * place among the repository's lockfile moves; a pin that waits by its repository and name; a row the sense made, by
 * what runs and where, not by its pod, whose name a restart changes. Rows with one key are told apart by their place
 * among them, the first keeping it: two pods of one workload running the same image, or two moves of one name from two
 * pins, as the scan groups by name and what it pins now.
 */
export function rowKeys(day: Day): { moves: string[][]; waiting: string[][]; running: string[] } {
  const seen = new Map<string, number>();
  const told = (key: string) => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? key : `${key} ${n}`;
  };
  const moves = day.repositories.map((r) => {
    let lockfiles = 0;
    return r.moves.map((move) =>
      told(move.lockfile ? `${r.repository} lockfile ${++lockfiles}` : `${r.repository} ${move.name}`),
    );
  });
  const waiting = day.repositories.map((r) => r.waiting.map((w) => told(`${r.repository} waits ${w.name}`)));
  return { moves, waiting, running: day.rows.map((row) => told(runningKey(row))) };
}

function runningKey(row: Running): string {
  switch (row.row) {
    case 'unlisted-image':
      return `unlisted ${row.namespace} ${row.container} ${row.image}@${row.digest}`;
    case 'unscanned-digest':
      return `unscanned ${row.namespace} ${row.container} ${row.image}@${row.digest}`;
    case 'not-running':
      return `not-running ${row.repository} ${row.item}`;
  }
}

/**
 * A move made with another undone on main is held with it: the row of the one undone holds the rest its issue
 * carries, and a move made with it whose issue is its own joins the row of its repository's undone move that writes the
 * same file. Each row of the day, by its place, and the place of the row it is held with, where it is.
 */
export function heldWith(day: Day, standings: readonly (readonly Standing[])[]): (number | undefined)[][] {
  return day.repositories.map((r, i) => {
    const mine = standings[i] ?? [];
    const why = (j: number) => {
      const s = mine[j];
      return s?.place === 'waits' ? s : undefined;
    };
    // The first move each issue of an undone move carries heads its row.
    const heads = new Map<number, number>();
    r.moves.forEach((_, j) => {
      const s = why(j);
      if (s?.why === 'reverted' && s.pull?.number !== undefined && !heads.has(s.pull.number))
        heads.set(s.pull.number, j);
    });
    const headRows = new Set(heads.values());
    return r.moves.map((move, j) => {
      const s = why(j);
      if (s?.pull?.number === undefined) return undefined;
      if (s.why === 'reverted') {
        const head = heads.get(s.pull.number);
        return head === j ? undefined : head;
      }
      if (s.why !== 'with-reverted') return undefined;
      const files = new Set(move.pins.map((pin) => pin.file));
      const into = [...headRows].find((k) => r.moves[k]?.pins.some((pin) => files.has(pin.file)));
      return into;
    });
  });
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

/** A digest shortened to its first eight, as the console writes a commit's seven. */
export const shortDigests = (text: string) => text.replace(/@?sha256:([0-9a-f]{8})[0-9a-f]{56}/g, ' $1');

/**
 * A target in a row's few characters, from the scan's grammar (`apps/factory/src/vulnerabilities/fixes.ts`): the
 * version, the image's tag and its digest's first eight, the chart's version and whether it is a major, the tool's.
 * What the grammar does not read is shown as it is.
 */
export function targetWords(to: string): string {
  let m = /^versions? (.+)$/.exec(to);
  if (m?.[1]) return m[1].split(' and ').join(', ');
  m = /^image (\S+)$/.exec(to);
  if (m?.[1]) return shortDigests(m[1]).trim();
  m = /^chart \S+ (\S+)( \(a major\))?$/.exec(to);
  if (m?.[1]) return m[2] ? `${m[1]}, a major` : m[1];
  m = /^k3s (\S+)$/.exec(to);
  if (m?.[1]) return m[1];
  m = /^tool (\S+) (\S+)$/.exec(to);
  if (m?.[1] && m[2]) return `${m[1]} ${m[2]}`;
  return shortDigests(to).trim();
}

/** A row that waits on Martin, as the card counts it: its group, its deadline, and what to call it. */
export interface WaitingRow {
  group: PatchGroup;
  deadline: number | undefined;
  /** What moves; undefined for a lockfile's package the public view withholds. */
  name: string | undefined;
  repository: string;
  lockfile: boolean;
}

/** Every row of a day that waits on Martin, a move held with another counted in that one's row. */
export function waitingRows(day: Day): WaitingRow[] {
  const standings = day.repositories.map((r) => r.moves.map((move) => standingOf(r, move)));
  const folded = heldWith(day, standings);
  const deadline = (at: string | undefined) => (at === undefined ? undefined : Date.parse(at));
  const rows = day.repositories.flatMap((r, i) => [
    ...r.moves.flatMap((move, j): WaitingRow[] => {
      const standing = standings[i]?.[j];
      if (standing?.place !== 'waits' || folded[i]?.[j] !== undefined) return [];
      const name = move.lockfile ? move.package?.name : move.name;
      return [
        {
          group: GROUP_OF[standing.why],
          deadline: deadline(move.deadline),
          name,
          repository: r.repository,
          lockfile: move.lockfile,
        },
      ];
    }),
    ...r.waiting.flatMap((w): WaitingRow[] => {
      const standing = waitingStanding(r, w);
      if (standing.place !== 'waits') return [];
      return [
        {
          group: GROUP_OF[standing.why],
          deadline: deadline(w.deadline),
          name: w.name,
          repository: r.repository,
          lockfile: false,
        },
      ];
    }),
  ]);
  const running = day.rows.map(
    (row): WaitingRow => ({
      group: 'hand',
      deadline: undefined,
      name: shortDigests(row.image).trim(),
      repository: row.row === 'unlisted-image' ? '' : row.repository,
      lockfile: false,
    }),
  );
  return [...rows, ...running];
}

/** When the sense last read the pull requests: its day's `read`, or, for a day read before it read them, the day's. */
export const readAt = (event: PublicEvent<'patching.read'>) => Date.parse(event.payload.read ?? event.ts);

/** Each repository's scan, as the day had it judged: when, and its run's page. */
export interface ScanJudged {
  repository: string;
  judged: number | undefined;
  run: string;
}

/** The sense's last day, as Needs you's card reads it, with since when something of it has waited on Martin. */
export interface PatchingDay {
  read: number;
  rows: WaitingRow[];
  scans: ScanJudged[];
  /** The first of the sense's days, unbroken to the last, that had anything waiting on Martin. */
  since: number | undefined;
}

/** How far back the card looks for since when something has waited: Done's 28 days. */
const SINCE_DAYS = 28;

/**
 * The sense's last day in the events, from its role, for Needs you. Since when something has waited is found walking
 * back from it, day by day, to the first with nothing waiting, and no further back than 28 days: the sense appends a
 * day each hour that anything changes, so the whole history is never read again.
 */
export function patchingDay(events: readonly PublicEvent[]): PatchingDay | undefined {
  let i = events.length - 1;
  while (i >= 0 && !isSensesDay(events[i] as PublicEvent)) i--;
  const lastEvent = events[i] as PublicEvent<'patching.read'> | undefined;
  if (!lastEvent) return undefined;
  const rows = waitingRows(lastEvent.payload);
  let since: number | undefined;
  if (rows.length > 0) {
    since = Date.parse(lastEvent.ts);
    const from = since - SINCE_DAYS * DAY;
    for (let j = i - 1; j >= 0; j--) {
      const event = events[j] as PublicEvent;
      if (!isSensesDay(event)) continue;
      const at = Date.parse(event.ts);
      if (at < from || waitingRows(event.payload).length === 0) break;
      since = at;
    }
  }
  const day = lastEvent.payload;
  return {
    read: readAt(lastEvent),
    rows,
    scans: day.repositories.map((r) => ({
      repository: r.repository,
      judged: r.judged === null ? undefined : Date.parse(r.judged),
      run: `https://github.com/${r.repository}/actions/runs/${r.run.id}`,
    })),
    since,
  };
}

/** Whether the sense's read is old enough to say so, at t. */
export const readStale = (read: number, t: number) => t - read >= READ_STALE_HOURS * HOUR;
/** The scans judged too long ago for the review gate to pass their moves, at t. */
export const staleScans = (scans: readonly ScanJudged[], t: number) =>
  scans.filter((scan) => scan.judged !== undefined && t - scan.judged > SCAN_MAX_AGE_HOURS * HOUR);

/** Patching's one card in Needs you, at t. */
export interface PatchingNeed {
  since: number;
  /** How many wait in each group, in the sheet's order, those with none left out. */
  groups: [PatchGroup, number][];
  waiting: number;
  /** The first deadline among them, and what is due. */
  first: WaitingRow | undefined;
  /** When the sense last read, while that is long enough ago to say so. */
  stale: number | undefined;
  /** Each scan judged too long ago for its moves to pass. */
  scanStale: ScanJudged[];
}

/** The card, while anything waits on Martin or the day is stale; none before the sense's first day. */
export function patchingNeed(day: PatchingDay | undefined, t: number): PatchingNeed | undefined {
  if (!day) return undefined;
  const stale = readStale(day.read, t) ? day.read : undefined;
  const scanStale = staleScans(day.scans, t);
  if (day.rows.length === 0 && stale === undefined && scanStale.length === 0) return undefined;
  let first: WaitingRow | undefined;
  for (const row of day.rows) {
    if (row.deadline !== undefined && (first?.deadline === undefined || row.deadline < first.deadline)) first = row;
  }
  return {
    since: day.since ?? day.read,
    groups: PATCH_GROUPS.map((g): [PatchGroup, number] => [g, day.rows.filter((row) => row.group === g).length]).filter(
      ([, n]) => n > 0,
    ),
    waiting: day.rows.length,
    first,
    stale,
    scanStale,
  };
}
