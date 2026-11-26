/**
 * The day's findings grouped into moves: a finding is evidence, a move is the unit of work, the pin that moves and
 * everything moving it clears. A pure function of the results deadlines.ts judged and the pins routine.ts found
 * behind, so the same results and pins always give the same moves, and anything that reads the alerts' messages
 * (fixes.ts) can group the findings' moves again the same way.
 *
 * A move is one pin's name and what it pins now: every result with a fix there is one move, wherever it is pinned, to
 * the furthest target (fixes.ts) any of them needs, and a line no longer built is a move apart; so one image in three
 * Dockerfiles is one move of three pins, and a package in two versions one move. A chart's images are the chart's own: two charts that run one image are two moves.
 *
 * The furthest target is one within the pin's major, where any result has a fix there (`withinMajor`): a result only
 * a major clears is then one the move leaves, and the major is listed on a later day, once the pin has moved; until
 * then the move's deadline is the earliest of both, so what waits for the major is still alerted on. Where no result
 * has a fix within the major, the move is the major.
 *
 * A pin that is merely behind, with no finding (routine.ts's `Behind`), is a routine move: it clears nothing, has no
 * deadline and no results, and is listed after the findings' moves, by name, a lockfile's last in an order that says
 * nothing of its package, so a finding's move keeps the place it would have with none listed. One pin is one move: a pin a finding's move has gets no routine move that day. Routine
 * is worked out (`isRoutine`), never a field.
 *
 * Its lane says who moves it, worked out, never chosen, in this order:
 *
 * - `none`: nothing to move to (a line no longer built);
 * - `line`: the app's, which its line moves, an image's under `deploy/` among them;
 * - `cluster`: k3s, which only the cluster's own command applies;
 * - `issue`: what no pull request of the App's can write: a workflow's pin, with a finding or none; and a fix of a
 *   package whose bump waits for a bench run (`BENCHED`, policy/vulnerabilities.ts) that clears no Critical, marked
 *   `bench`: an issue of its own with its deadline, never a part of the lockfile's shared pull request. One that
 *   clears a Critical is a move like any other;
 * - `worker`: every other pin, which the GitHub worker moves: a chart among them, at one Application or several, or
 *   at the Makefile (Argo CD's); and every package of the lockfile, what mise pins (k3d, a tool's release), and an image that brings another pin with
 *   it (Node, or Playwright's library: the pin step's `moveImage`), which the pin step makes in the scan's run for the
 *   worker to commit (github/made.ts).
 *
 * Every move with a fix is the App's, made by the line or the worker: none waits for Dependabot, whose pull request
 * for the same pin closes itself once `main` has moved. No lane says a move waits for Martin. A major is in the lane it
 * would be in without its major: the review gate names it (`major`), and the autonomy level decides whether it is
 * queued (`ENQUEUES`, `policy/line.ts`).
 *
 * `moves.json`, the scan's artifact, is `MovesFile`: what the log prints, no more. A lockfile's move is "a package in
 * `pnpm-lock.yaml`", with neither its versions nor its lines, which name the package in a public lockfile; the alerts
 * hold the rest.
 *
 * A fix that exists and is no move today is in `waiting` (`Waiting`), beside the moves, with why: its target's content
 * has not waited its day (`content`), or no release read is better than the pin (`no-better`); and so is a routine
 * update of an image whose tag has waited and whose content has not. A reader that takes "no move lists it" to mean
 * "fixed" or "gone" reads `waiting` first.
 *
 * Node runs this with no dependencies, from a sparse checkout of this repository.
 */

import { createHash } from 'node:crypto';
import { APP_REPOSITORY } from '../repositories.ts';
import { dayText, type Target, targetText } from './fixes.ts';
import type { Kind } from './inventory.ts';
import { type Finding, fingerprint, SEVERITIES, type Severity } from './sarif.ts';
import { compareTags, compareVersions, majorOf } from './versions.ts';

/** The app's repository, whose moves its line makes. */
export const APP = APP_REPOSITORY;

/** The shape of `moves.json`: a reader refuses a version it does not know. */
export const MOVES_VERSION = 1;

export type Lane = 'line' | 'worker' | 'cluster' | 'issue' | 'none';
export const LANES: Lane[] = ['line', 'worker', 'cluster', 'issue', 'none'];

/** A pin a move writes: its file and line. */
export interface Pin {
  file: string;
  line: number;
}

/** One result as moves are made from it: what deadlines.ts judged, and the pin that moving it writes. */
export interface Judged {
  finding: Finding;
  severity: Severity;
  excepted: boolean;
  /** Its deadline, where it has one. */
  due?: number | undefined;
  firstSeenToday: boolean;
  /** The kind of item the pin is: an image's, a chart's, a lockfile's… */
  kind: Kind;
  /** What moves: an image's repository, a chart's name, a package, `node`, `k3s`, a tool. */
  name: string;
  /** Where the pin is written. */
  pin: Pin;
  /** What it pins now: a tag, a version, a chart's or k3s's release. */
  from: string;
}

export type Counts = Record<Severity, number>;

export interface Move {
  repository: string;
  name: string;
  /** Every pin it writes, in order of file and line. */
  pins: Pin[];
  from: string;
  /** What fixes it (fixes.ts), or none for a line no longer built. */
  to?: Target | undefined;
  major: boolean;
  /** The results it clears, and the results on the same pin it leaves, by severity; the excepted left out. */
  clears: Counts;
  leaves: Counts;
  /**
   * Its earliest deadline: among those it clears, and those it leaves that only a major clears (`withinMajor`), which
   * are in no move until this one has merged, so the pin's urgency is never hidden behind a move within its major.
   */
  deadline?: number | undefined;
  /** How many of those it clears are new today. */
  newToday: number;
  lane: Lane;
  /** Whether it is a lockfile's: printed as "a package in <file>". */
  lockfile: boolean;
  /** Set for a fix that waits for Martin's bench run (`Context.benched`): its lane is `issue`. */
  bench?: true | undefined;
  /** The results it clears, by their fingerprints (sarif.ts): never printed. */
  results: string[];
}

/** What the lanes are worked out from, besides the results. */
export interface Context {
  repository: string;
  /** Whether it is the app's repository, whose moves its line makes. */
  app: boolean;
  now: number;
  /**
   * The packages whose bump merges only after a bench run (`BENCHED`, policy/vulnerabilities.ts): a fix of one that
   * clears no Critical is lane `issue`. Absent, none is.
   */
  benched?: readonly string[] | undefined;
}

const zero = (): Counts => Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Counts;
const total = (counts: Counts) => SEVERITIES.reduce((sum, s) => sum + counts[s], 0);

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The pin a result's group is keyed by: its name and what it pins now. */
export const pinKey = (each: Pick<Judged, 'name' | 'from' | 'kind'>) =>
  JSON.stringify([each.kind === 'lockfile' ? 'npm' : '', each.name, each.from]);

/** A move's lane, worked out from what it is: see the module's comment for the order. */
export function laneOf(move: Pick<Move, 'to' | 'pins'>, kinds: Set<Kind>, context: Context): Lane {
  const target = move.to;
  if (!target || target.kind === 'unbuilt') return 'none';
  if (context.app) return 'line';
  if (target.kind === 'k3s' || kinds.has('k3s') || kinds.has('k3s-release')) return 'cluster';
  // A workflow's pin no pull request of the App's writes.
  if (move.pins.some((pin) => pin.file.startsWith('.github/workflows/'))) return 'issue';
  return 'worker';
}

/** Whether a move crosses a major: a chart's marked so, or a version whose major no copy now pinned has. */
export function isMajor(target: Target, from: string) {
  if (target.kind === 'chart') return target.major;
  if (target.kind !== 'version') return false;
  const pinnedMajors = new Set(from.split(', ').map(majorOf));
  return target.versions.some((version) => !pinnedMajors.has(majorOf(version)));
}

/** A target's version, for telling which of two on one pin is further. */
const versionOf = (target: Target) => {
  switch (target.kind) {
    case 'version':
      return target.versions.at(-1) ?? '';
    case 'image':
      return target.tag;
    case 'chart':
    case 'tool':
      return target.version;
    case 'k3s':
      return target.release;
    case 'unbuilt':
      return '';
  }
};

/** Which of two versions is later (versions.ts); two that compare the same, by their text, so the order is whole. */
const later = (a: string, b: string) => compareVersions(a, b) || order(a, b);

/**
 * Which of two targets of one pin is further. An image's tag and k3s's release are tags, whose ending orders them
 * (`+k3s2` after `+k3s1`); a chart's and a tool's are versions, where a pre-release is before its release.
 */
const further = (a: Target, b: Target) => {
  const tags = (target: Target) => target.kind === 'image' || target.kind === 'k3s';
  const compare = tags(a) && tags(b) ? compareTags : compareVersions;
  return compare(versionOf(a), versionOf(b)) || order(versionOf(a), versionOf(b));
};

/**
 * The results of one pin that its move clears. Where any has a fix within the pin's major, those alone: one only a
 * major clears (a chart's next major, a package's version on a major no copy is at) is left, and its major is a later
 * day's move, once the pin has moved. Where none has, all of them, and the move is the major.
 */
export function withinMajor(group: Judged[]): Judged[] {
  const crosses = (each: Judged) => {
    const target = each.finding.fix?.target;
    if (target?.kind === 'chart') return target.major;
    return target?.kind === 'version' && each.kind === 'lockfile' && isMajor(target, each.from);
  };
  const within = group.filter((each) => !crosses(each));
  return within.length ? within : group;
}

/**
 * The furthest of the targets one pin's results need: moving there is the move. A pin's own target (an image, a chart, a
 * k3s release, a tool) is preferred to a bare version, which is Node's own fix in an image: the image's newer tag brings
 * it. Versions alone are joined, the highest on each major, so a package in two versions keeps a fix for each copy.
 * The targets are those of the results the move clears (`withinMajor`).
 */
export function furthest(targets: Target[]): Target | undefined {
  const pinned = targets.filter((target) => target.kind !== 'version');
  if (pinned.length) return [...pinned].sort(further).at(-1);
  const byMajor = new Map<string, string>();
  for (const target of targets)
    if (target.kind === 'version')
      for (const version of target.versions) {
        const major = majorOf(version) ?? version;
        const seen = byMajor.get(major);
        if (seen === undefined || later(version, seen) > 0) byMajor.set(major, version);
      }
  if (!byMajor.size) return undefined;
  return { kind: 'version', versions: [...byMajor.values()].sort(later) };
}

/** A pin that is merely behind: what a routine move is made from (routine.ts finds them). */
export interface Behind {
  /** The kind of item the pin is, as a finding on it would have it. */
  kind: Kind;
  name: string;
  pins: Pin[];
  from: string;
  to: Target;
  /**
   * Set for a package's release its manifest's range does not admit: the move is a major whatever its numbers (below
   * 1.0 a new minor is outside a caret range), since the pin step writes the manifest for it.
   */
  outside?: boolean | undefined;
}

/**
 * Whether a move is routine: it clears nothing and has somewhere to go. Every move made from findings clears at least
 * one result, a line no longer built among them, so the counts alone tell; the lane is asked too, and not `to`, because
 * `moves.json` writes a lockfile's `to` as empty: one test reads a `Move` and a `PublicMove` alike.
 */
export const isRoutine = (move: Pick<Move | PublicMove, 'clears' | 'lane'>) =>
  total(move.clears) === 0 && move.lane !== 'none';

/** The pins the moves given write, as `pinKey` names them: where no routine move is made. */
export const pinsOf = (list: Move[]) =>
  new Set(list.map((move) => pinKey({ kind: move.lockfile ? 'lockfile' : 'third-party', ...move })));

/**
 * The day's moves, from the judged results: the most urgent first (earliest deadline, then most Critical, then name);
 * then a routine move for each pin that is behind and has none, by name.
 */
export function moves(results: Judged[], context: Context, behind: Behind[] = []): Move[] {
  const open = results.filter((each) => !each.excepted);
  const groups = new Map<string, Judged[]>();
  for (const each of open) {
    const target = each.finding.fix?.target;
    if (!target) continue;
    // One pin is one move, to the furthest target any of its results needs within its major, or to the major where
    // none has a fix within it; a line no longer built is a move apart.
    const key = JSON.stringify([pinKey(each), target.kind === 'unbuilt']);
    const group = groups.get(key);
    if (group) group.push(each);
    else groups.set(key, [each]);
  }
  // What each pin has with no move, or another one: what a move on it leaves.
  const byPin = new Map<string, Judged[]>();
  for (const each of open) {
    const key = pinKey(each);
    const list = byPin.get(key);
    if (list) list.push(each);
    else byPin.set(key, [each]);
  }
  const out: Move[] = [];
  for (const group of groups.values()) {
    const members = withinMajor(group);
    const first = members[0];
    const target = furthest(members.flatMap((each) => (each.finding.fix ? [each.finding.fix.target] : [])));
    if (!first || !target) continue;
    const pins = new Map<string, Pin>();
    for (const each of members) pins.set(`${each.pin.file}:${each.pin.line}`, each.pin);
    const clears = zero();
    for (const each of members) clears[each.severity]++;
    const leaves = zero();
    for (const each of byPin.get(pinKey(first)) ?? []) if (!members.includes(each)) leaves[each.severity]++;
    // The whole group's: what a move within the major leaves for the major is due all the same, and is in no other move.
    const dues = group.flatMap((each) => (each.due === undefined ? [] : [each.due]));
    const move: Move = {
      repository: context.repository,
      name: first.name,
      pins: [...pins.values()].sort((a, b) => order(a.file, b.file) || a.line - b.line),
      from: first.from,
      to: target,
      major: isMajor(target, first.from),
      clears,
      leaves,
      deadline: dues.length ? Math.min(...dues) : undefined,
      newToday: members.filter((each) => each.firstSeenToday).length,
      lane: 'none',
      lockfile: first.kind === 'lockfile',
      results: members.map((each) => fingerprint(each.finding)),
    };
    move.lane = laneOf(move, new Set(members.map((each) => each.kind)), context);
    // A benched package's fix waits for the bench run, as an issue of its own, unless it clears a Critical.
    if (move.lockfile && context.benched?.includes(move.name) && move.lane !== 'none' && clears.CRITICAL === 0) {
      move.lane = 'issue';
      move.bench = true;
    }
    out.push(move);
  }
  out.sort(
    (a, b) =>
      (a.deadline ?? Number.POSITIVE_INFINITY) - (b.deadline ?? Number.POSITIVE_INFINITY) ||
      b.clears.CRITICAL - a.clears.CRITICAL ||
      b.clears.HIGH - a.clears.HIGH ||
      order(a.name, b.name) ||
      order(a.from, b.from),
  );
  const taken = pinsOf(out);
  const routine: Move[] = [];
  for (const each of behind) {
    const key = pinKey(each);
    if (taken.has(key)) continue;
    taken.add(key);
    // What the pin has, with no fix the scan can date: the move is not known to clear it.
    const leaves = zero();
    for (const left of byPin.get(key) ?? []) leaves[left.severity]++;
    const move: Move = {
      repository: context.repository,
      name: each.name,
      pins: [...each.pins].sort((a, b) => order(a.file, b.file) || a.line - b.line),
      from: each.from,
      to: each.to,
      major: isMajor(each.to, each.from) || each.outside === true,
      clears: zero(),
      leaves,
      deadline: undefined,
      newToday: 0,
      lane: 'none',
      lockfile: each.kind === 'lockfile',
      results: [],
    };
    move.lane = laneOf(move, new Set([each.kind]), context);
    if (move.lane !== 'none') routine.push(move);
  }
  // By name; then the lockfile's, whose names moves.json withholds, in an order that says nothing of them: by a
  // hash of each one's repository, files, name and version, so a hidden name has no place among the names printed.
  const hidden = (move: Move) =>
    createHash('sha256')
      .update(JSON.stringify([move.repository, move.pins.map((pin) => pin.file), move.name, move.from]))
      .digest('hex');
  const places = new Map(routine.map((move) => [move, move.lockfile ? hidden(move) : '']));
  routine.sort(
    (a, b) =>
      Number(a.lockfile) - Number(b.lockfile) ||
      order(places.get(a) ?? '', places.get(b) ?? '') ||
      order(a.name, b.name) ||
      order(a.from, b.from),
  );
  return [...out, ...routine];
}

/** Why a pin with somewhere to go has no move today: see `Waiting`. */
export type WaitingWhy = 'content' | 'no-better';

/** One result with no fix today, and why (deadlines.ts's `assess`): what `waiting` is made from. */
export interface Held {
  why: WaitingWhy;
  /** For `content`: the first of its targets to come due, and when. */
  to?: Target | undefined;
  until?: number | undefined;
}

/** A routine update of an image whose tag has waited its days and whose content has not (routine.ts). */
export interface RoutineWait {
  kind: Kind;
  name: string;
  pins: Pin[];
  from: string;
  to: Target;
  until: number;
}

/** A pin that waits, before it is printed: `Waiting`, with the results that wait, by their fingerprints. */
export interface Wait {
  name: string;
  pins: Pin[];
  from: string;
  why: WaitingWhy;
  to?: Target | undefined;
  until?: number | undefined;
  clears: Counts;
  deadline?: number | undefined;
  routine: boolean;
  /** The results that wait (sarif.ts's `fingerprint`): never printed. */
  results: string[];
}

/**
 * The day's pins that wait: each pin whose results have a fix that is no move today, once for each reason, the most
 * urgent first as the moves are; then each routine update that waits for its content, by name. The excepted are left
 * out, as of a move, and a lockfile's, which neither reason holds, is never named. `held` is by the results' index.
 */
export function waiting(results: Judged[], held: (Held | undefined)[], routine: RoutineWait[] = []): Wait[] {
  const groups = new Map<string, { each: Judged; held: Held }[]>();
  for (const [index, each] of results.entries()) {
    const its = held[index];
    if (!its || each.excepted || each.kind === 'lockfile') continue;
    const key = JSON.stringify([pinKey(each), its.why]);
    const group = groups.get(key);
    if (group) group.push({ each, held: its });
    else groups.set(key, [{ each, held: its }]);
  }
  const out: Wait[] = [];
  for (const group of groups.values()) {
    const [first] = group;
    if (!first) continue;
    const pins = new Map<string, Pin>();
    for (const { each } of group) pins.set(`${each.pin.file}:${each.pin.line}`, each.pin);
    const clears = zero();
    for (const { each } of group) clears[each.severity]++;
    const dues = group.flatMap(({ each }) => (each.due === undefined ? [] : [each.due]));
    // The first of its targets to come due, and the furthest of those due then.
    const untils = group.flatMap((one) => (one.held.until === undefined ? [] : [one.held.until]));
    const until = untils.length ? Math.min(...untils) : undefined;
    const to = furthest(group.flatMap((one) => (one.held.to && one.held.until === until ? [one.held.to] : [])));
    out.push({
      name: first.each.name,
      pins: [...pins.values()].sort((a, b) => order(a.file, b.file) || a.line - b.line),
      from: first.each.from,
      why: first.held.why,
      ...(first.held.why === 'content' ? { to, until } : {}),
      clears,
      deadline: dues.length ? Math.min(...dues) : undefined,
      routine: false,
      results: group.map(({ each }) => fingerprint(each.finding)),
    });
  }
  out.sort(
    (a, b) =>
      (a.deadline ?? Number.POSITIVE_INFINITY) - (b.deadline ?? Number.POSITIVE_INFINITY) ||
      b.clears.CRITICAL - a.clears.CRITICAL ||
      b.clears.HIGH - a.clears.HIGH ||
      order(a.name, b.name) ||
      order(a.from, b.from) ||
      order(a.why, b.why),
  );
  const behind = new Map<string, Wait>();
  for (const each of routine) {
    if (each.kind === 'lockfile') continue;
    const key = pinKey(each);
    if (behind.has(key)) continue;
    behind.set(key, {
      name: each.name,
      pins: [...each.pins].sort((a, b) => order(a.file, b.file) || a.line - b.line),
      from: each.from,
      why: 'content',
      to: each.to,
      until: each.until,
      clears: zero(),
      deadline: undefined,
      routine: true,
      results: [],
    });
  }
  return [...out, ...[...behind.values()].sort((a, b) => order(a.name, b.name) || order(a.from, b.from))];
}

/**
 * A pin that has somewhere to go and no move today, as the log, the step summary and `moves.json` give it: a fix that
 * exists and is not listed, or a routine update that is not. Named as a move names its pin; never a lockfile's, whose
 * package would be withheld, and never a result's fingerprint, as of a move.
 */
export interface Waiting {
  name: string;
  pins: Pin[];
  from: string;
  lockfile: false;
  /**
   * `content`: its target's content (an image's digest, a chart's version) has not waited `ROUTINE.contentDays` since
   * the scan first saw it. `no-better`: no release read has fewer findings than the pin, worst severity first, though
   * one no longer has a finding of it.
   */
  why: WaitingWhy;
  /**
   * For `content`: fixes.ts's text of the first of its targets to come due, and when, UTC to the second, the slack
   * of a daily scan taken off (state.ts's `waitMs`). Content pushed again before then waits its own day, and the move
   * lists at the newest that has waited.
   */
  to?: string | undefined;
  until?: string | undefined;
  /** The results that wait, by severity: what its move would clear. All zero for a routine update's. */
  clears: Counts;
  /** Their earliest deadline, where any has one: UTC, to the second. */
  deadline?: string | undefined;
  /** Set for a routine update's wait: no finding asks for it. */
  routine?: true | undefined;
}

/** A pin that waits with nothing in it the log may not print. */
export function publicWaiting(wait: Wait): Waiting {
  return {
    name: wait.name,
    pins: wait.pins,
    from: wait.from,
    lockfile: false,
    why: wait.why,
    ...(wait.to ? { to: targetText(wait.to) } : {}),
    ...(wait.until === undefined ? {} : { until: dayText(wait.until) }),
    clears: wait.clears,
    ...(wait.deadline === undefined ? {} : { deadline: dayText(wait.deadline) }),
    ...(wait.routine ? { routine: true as const } : {}),
  };
}

/** A move as the log, the step summary and `moves.json` give it: a lockfile's named by its file alone. */
export interface PublicMove {
  repository: string;
  name: string;
  pins: Pin[];
  from: string;
  /** fixes.ts's text of the target, or empty for a lockfile's and for one with none. */
  to: string;
  major: boolean;
  clears: Counts;
  leaves: Counts;
  /** UTC, to the second. */
  deadline?: string | undefined;
  newToday: number;
  lane: Lane;
  /** Whether it is a lockfile's, whose package, versions and lines are withheld: its name is "a package in <file>". */
  lockfile: boolean;
  /**
   * Set for a fix that waits for Martin's bench run (`factory line bench`): a package the policy lists as benched,
   * clearing no Critical, in lane `issue`. Optional under the same `MOVES_VERSION`, as `totals.open` is: a file with
   * no such move reads as it did.
   */
  bench?: true | undefined;
}

/**
 * An image the scan read, whatever it found: every image target of the list, so what a cluster runs can be compared with
 * what was scanned. Public: references from public files, with no package, advisory or count.
 */
export interface ScannedImage {
  /** The item's kind (inventory.ts). */
  kind: Kind;
  /** The item as the list names it: an image's reference, a chart's Application, `k3s v1.37.2+k3s1`. */
  item: string;
  /** The image's reference as pinned or rendered, tag and digest as written. */
  image: string;
  /** Its index digest (or its one manifest's), then every platform manifest the index lists, `sha256:<64 hex>`. */
  digests: string[];
  /** The pin: the item's, or a values file's line for a chart's image one pins. */
  pin: Pin;
}

/** The day's counts, as deadlines.ts's verdict counts them for the log: never computed a second time. */
export interface DayCounts {
  /** Open results with no fix installable. */
  noFix: number;
  /** Results an exception in force excepts. */
  excepted: number;
  /** Open results past their deadline. */
  overdue: number;
  /** Open results due within a day. */
  dueWithinDay: number;
  /** New High or Critical today (first seen today) with a fix to install, and with none the scan can date. */
  newHighWithFix: number;
  newHighWithoutFix: number;
}

const NO_COUNTS: DayCounts = {
  noFix: 0,
  excepted: 0,
  overdue: 0,
  dueWithinDay: 0,
  newHighWithFix: 0,
  newHighWithoutFix: 0,
};

/** The shape of `moves.json`. */
export interface MovesFile {
  version: typeof MOVES_VERSION;
  repository: string;
  /** When the scan judged them, UTC to the second. */
  judged: string;
  /** The run that made it (GITHUB_RUN_ID), which each of its results' messages names after its move's place. */
  run?: string | undefined;
  /**
   * How many results have a fix and are not excepted, how many moves, and the moves in each lane; and the day's counts
   * the scan's log prints (`DayCounts`), plain numbers, by no package or advisory; and every open result (not excepted)
   * by severity, as the log's line of deadlines gives them, fix or none. It is optional, under the same `MOVES_VERSION`,
   * so a file from a scan that predates it (the app's, at an older commit of the workflow) reads as it did; a reader
   * built before it refuses a file that has it, so the worker reads this repository's moves again once it is deployed.
   * `routine` is how many of the moves are routine, and `routineUnread` how many pins the routine listing could not
   * read that day (a registry that gave no answer): both are written by a scan that made a routine listing, zero
   * included, and neither by one that made none, so a reader takes "absent" as "this scan made no routine listing",
   * and a move no longer listed as made only where `routineUnread` is zero. Optional as `open` is.
   */
  totals: {
    fixed: number;
    moves: number;
    lanes: Record<Lane, number>;
    open?: Counts;
    routine?: number;
    routineUnread?: number;
  } & DayCounts;
  moves: PublicMove[];
  /**
   * Each pin with somewhere to go and no move today, and why (`Waiting`). Optional under the same `MOVES_VERSION`, as
   * `totals.open` is, and by the rule `totals.routine` keeps: written by every scan that judges what waits, an empty
   * list included, and by none that predates it, so a reader takes "absent" as "this scan does not say what waits",
   * and reads its moves as it did; and a pin no move lists as moved or fixed only where none here names it.
   */
  waiting?: Waiting[];
  /** Every image the scan read, in order of pin and reference. */
  scanned: ScannedImage[];
}

/** A move with nothing in it the log may not print. */
export function publicMove(move: Move): PublicMove {
  const lockfiles = [...new Set(move.pins.map((pin) => pin.file))];
  const hidden = move.lockfile;
  return {
    repository: move.repository,
    name: hidden ? `a package in ${lockfiles.map((file) => `\`${file}\``).join(' and ')}` : move.name,
    pins: hidden ? lockfiles.map((file) => ({ file, line: 0 })) : move.pins,
    from: hidden ? '' : move.from,
    to: hidden || !move.to ? '' : targetText(move.to),
    major: move.major,
    clears: move.clears,
    leaves: move.leaves,
    deadline: move.deadline === undefined ? undefined : dayText(move.deadline),
    newToday: move.newToday,
    lane: move.lane,
    lockfile: hidden,
    ...(move.bench ? { bench: true as const } : {}),
  };
}

export function movesFile(
  list: Move[],
  context: Pick<Context, 'repository' | 'now'>,
  run?: string,
  scanned: ScannedImage[] = [],
  day: DayCounts = NO_COUNTS,
  open?: Counts,
  /** The day's routine listing, where the scan made one: how many pins it could not read. */
  listing?: { unread: number },
  /** The day's pins that wait (`waiting`), from a scan that judged them: none is an empty list. */
  waits?: Wait[],
): MovesFile {
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, list.filter((m) => m.lane === lane).length])) as Record<
    Lane,
    number
  >;
  const fixed = list.reduce((sum, m) => sum + total(m.clears), 0);
  const routine = list.filter(isRoutine).length;
  return {
    version: MOVES_VERSION,
    repository: context.repository,
    judged: dayText(context.now),
    ...(run ? { run } : {}),
    totals: {
      fixed,
      moves: list.length,
      lanes,
      ...(open ? { open: { ...open } } : {}),
      ...(listing || routine ? { routine } : {}),
      ...(listing ? { routineUnread: listing.unread } : {}),
      ...day,
    },
    moves: list.map(publicMove),
    ...(waits ? { waiting: waits.map(publicWaiting) } : {}),
    scanned: [...scanned].sort(
      (a, b) => order(a.pin.file, b.pin.file) || a.pin.line - b.pin.line || order(a.image, b.image),
    ),
  };
}

const short = (counts: Counts) =>
  SEVERITIES.filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s.toLowerCase()}`)
    .join(', ') || 'nothing';

/** The table of moves, as the log and the step summary print it. */
export function table(file: MovesFile): string[] {
  const lanes = LANES.filter((lane) => file.totals.lanes[lane])
    .map((lane) => `${lane} ${file.totals.lanes[lane]}`)
    .join(', ');
  const lines = [
    `Moves: ${file.totals.fixed} results with a fix, in ${file.totals.moves} moves${file.totals.routine ? `, ${file.totals.routine} of them routine` : ''}${lanes ? ` (${lanes})` : ''}.`,
  ];
  if (file.moves.length) {
    lines.push(
      '',
      '| Move | From | To | Clears | Leaves | New today | Deadline | Lane |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const move of file.moves)
      lines.push(
        `| ${move.name} | ${move.from || '–'} | ${move.to || '–'} | ${short(move.clears)} | ${short(move.leaves)} | ${move.newToday} | ${move.deadline ?? '–'} | ${move.lane} |`,
      );
  }
  if (file.waiting?.length) {
    lines.push('', `Waiting: ${file.waiting.length} with somewhere to go and no move today.`, '');
    for (const each of file.waiting) lines.push(`- ${waitingLine(each)}`);
  }
  return lines;
}

/** One pin that waits, in a line: what it is, why it has no move, and what waits with it. */
export function waitingLine(each: Waiting): string {
  const what = each.routine ? 'a routine update' : `a fix of ${short(each.clears)}`;
  const due = each.deadline ? `, due ${each.deadline}` : '';
  return each.why === 'content'
    ? `${each.name} ${each.from}: ${what}${due}, to ${each.to ?? 'a release'}, waits for its content's day, until ${each.until ?? 'the next scan'}.`
    : `${each.name} ${each.from}: ${what}${due} is not listed: no release read is better than the pin.`;
}
