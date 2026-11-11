/**
 * The day's findings grouped into moves: a finding is evidence, a move is the unit of work, the pin that moves and
 * everything moving it clears. A pure function of the results deadlines.ts judged, so the same results always give the
 * same moves, and anything that reads the alerts' messages (fixes.ts) can group them again the same way.
 *
 * A move is one pin's name and what it pins now: every result with a fix there is one move, wherever it is pinned, to
 * the furthest target (fixes.ts) any of them needs, and a line no longer built is a move apart; so one image in three
 * Dockerfiles is one move of three pins, and a package in two versions one move. A chart's images are the chart's own: two charts that run one image are two moves.
 *
 * Its lane says who moves it, worked out, never chosen, in this order:
 *
 * - `none`: nothing to move to (a line no longer built);
 * - `line`: the app's, which its line moves;
 * - `cluster`: k3s, which only the cluster's own command applies;
 * - `issue`: what no pull request of the App's can write: anything mise or the Makefile pins (k3d, Argo CD's chart with
 *   its CLI, a tool's release), a workflow, an indirect package of the lockfile, a direct one Dependabot has not moved within a
 *   day of its fix, and an image whose other half is in the lockfile;
 * - `approval`: a major, of any kind (a chart's, or a version past every copy's major), which needs more than its pins'
 *   lines written; whether a chart within its major changes
 *   more than its images is the review gate's to prove from the pull request, not the scan's to assume;
 * - `dependabot`: a pin `dependabot.yml`'s docker entries read, with no High or Critical on a deadline, and a direct
 *   package of the lockfile within a day of its fix, which its security update moves;
 * - `worker`: every other pin, which the GitHub worker moves: a chart within its major among them.
 *
 * `moves.json`, the scan's artifact, is `MovesFile`: what the log prints, no more. A lockfile's move is "a package in
 * `pnpm-lock.yaml`", with neither its versions nor its lines, which name the package in a public lockfile; the alerts
 * hold the rest.
 *
 * Node runs this with no dependencies, from a sparse checkout of this repository.
 */

import { dayText, type Target, targetText } from './fixes.ts';
import type { Kind } from './inventory.ts';
import { type Finding, fingerprint, SEVERITIES, type Severity } from './sarif.ts';

/** The app's repository, whose moves its line makes. */
export const APP = 'the-roganator/cv-worlds-worst-website';

/** The shape of `moves.json`: a reader refuses a version it does not know. */
export const MOVES_VERSION = 1;

export type Lane = 'line' | 'worker' | 'dependabot' | 'approval' | 'cluster' | 'issue' | 'none';
export const LANES: Lane[] = ['line', 'worker', 'dependabot', 'approval', 'cluster', 'issue', 'none'];

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
  /** The earliest deadline among those it clears. */
  deadline?: number | undefined;
  /** How many of those it clears are new today. */
  newToday: number;
  lane: Lane;
  /** Whether it is a lockfile's: printed as "a package in <file>". */
  lockfile: boolean;
  /** The results it clears, by their fingerprints (sarif.ts): never printed. */
  results: string[];
}

/** What the lanes are worked out from, besides the results. */
export interface Context {
  repository: string;
  /** Whether it is the app's repository, whose moves its line makes. */
  app: boolean;
  /** The directories `dependabot.yml`'s docker entries read, as it writes them (`/apps/console`). */
  dependabot: string[];
  /** The lockfiles' direct dependencies, by name. */
  direct: Set<string>;
  now: number;
}

const DAY = 86_400_000;

const zero = (): Counts => Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Counts;

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The pin a result's group is keyed by: its name and what it pins now. */
const pinKey = (each: Pick<Judged, 'name' | 'from' | 'kind'>) =>
  JSON.stringify([each.kind === 'lockfile' ? 'npm' : '', each.name, each.from]);

const MISE_FILES = new Set(['mise.toml', 'mise.lock']);

/** A pin `dependabot.yml`'s docker entries read: one in a directory they name. */
const readByDependabot = (pin: Pin, directories: string[]) => {
  const dir = `/${pin.file.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '') || '/';
  return directories.some((each) => {
    // A glob, as dependabot.yml's `directories` takes one: `*` within a directory's name, `**` across them.
    const pattern = (each.replace(/\/$/, '') || '/')
      .split(/(\*\*|\*)/)
      .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    return new RegExp(`^${pattern}$`).test(dir);
  });
};

const isLockfile = (file: string) => /(^|\/)pnpm-lock\.yaml$/.test(file);

/** A move's lane, worked out from what it is: see the module's comment for the order. */
export function laneOf(
  move: Pick<Move, 'to' | 'major' | 'pins' | 'name' | 'lockfile'>,
  kinds: Set<Kind>,
  members: Judged[],
  context: Context,
): Lane {
  const target = move.to;
  if (!target || target.kind === 'unbuilt') return 'none';
  if (context.app) return 'line';
  if (target.kind === 'k3s' || kinds.has('k3s') || kinds.has('k3s-release')) return 'cluster';
  // What mise or the Makefile pins (Argo CD's chart with its CLI) no pull request of the App's writes, a major or not.
  if (
    target.kind === 'tool' ||
    kinds.has('k3d') ||
    move.pins.some((pin) => MISE_FILES.has(pin.file) || pin.file === 'Makefile')
  )
    return 'issue';
  // A major, of any kind: the one move the scan can tell needs more than its pins' lines written. Whether a chart on its
  // major changes more than its images is the gate's to prove from the pull request, not the scan's to assume.
  if (move.major) return 'approval';
  if (move.pins.some((pin) => pin.file.startsWith('.github/workflows/'))) return 'issue';
  // An Application's chart within its major, the worker's: Dependabot's docker entries read no Application's
  // targetRevision, though they read the directory it is in.
  if (target.kind === 'chart') return 'worker';
  if (move.lockfile) {
    // An image of ours that carries the same package: its other half is the lockfile, which no pin move writes.
    if (move.pins.some((pin) => !isLockfile(pin.file))) return 'issue';
    if (!context.direct.has(move.name)) return 'issue';
    const fixed = Math.min(...members.map((each) => each.finding.fix?.day ?? context.now));
    return context.now - fixed > DAY ? 'issue' : 'dependabot';
  }
  const urgent = members.some(
    (each) => each.due !== undefined && (each.severity === 'CRITICAL' || each.severity === 'HIGH'),
  );
  if (!urgent && move.pins.every((pin) => readByDependabot(pin, context.dependabot))) return 'dependabot';
  return 'worker';
}

/** Whether a move crosses a major: a chart's marked so, or a version whose major no copy now pinned has. */
export function isMajor(target: Target, from: string) {
  if (target.kind === 'chart') return target.major;
  if (target.kind !== 'version') return false;
  const pinnedMajors = new Set(from.split(', ').map((version) => numbers(version)[0]));
  return target.versions.some((version) => !pinnedMajors.has(numbers(version)[0]));
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

const numbers = (version: string) => (version.match(/\d+/g) ?? []).map(Number);

/** Which of two versions is later, by their numbers in order. */
const later = (a: string, b: string) => {
  const x = numbers(a);
  const y = numbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return order(a, b);
};

/**
 * The furthest of the targets one pin's results need: moving there is the move. A pin's own target (an image, a chart, a
 * k3s release, a tool) is preferred to a bare version, which is Node's own fix in an image: the image's newer tag brings
 * it. Versions alone are joined, the highest on each major, so a package in two versions keeps a fix for each copy.
 */
export function furthest(targets: Target[]): Target | undefined {
  const pinned = targets.filter((target) => target.kind !== 'version');
  if (pinned.length) return [...pinned].sort((a, b) => later(versionOf(a), versionOf(b))).at(-1);
  const byMajor = new Map<string, string>();
  for (const target of targets)
    if (target.kind === 'version')
      for (const version of target.versions) {
        const major = String(numbers(version)[0] ?? version);
        const seen = byMajor.get(major);
        if (seen === undefined || later(version, seen) > 0) byMajor.set(major, version);
      }
  if (!byMajor.size) return undefined;
  return { kind: 'version', versions: [...byMajor.values()].sort(later) };
}

/** The day's moves, from the judged results: the most urgent first (earliest deadline, then most Critical, then name). */
export function moves(results: Judged[], context: Context): Move[] {
  const open = results.filter((each) => !each.excepted);
  const groups = new Map<string, Judged[]>();
  for (const each of open) {
    const target = each.finding.fix?.target;
    if (!target) continue;
    // One pin is one move, to the furthest target any of its results needs; a line no longer built is a move apart.
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
  for (const members of groups.values()) {
    const first = members[0];
    const target = furthest(members.flatMap((each) => (each.finding.fix ? [each.finding.fix.target] : [])));
    if (!first || !target) continue;
    const pins = new Map<string, Pin>();
    for (const each of members) pins.set(`${each.pin.file}:${each.pin.line}`, each.pin);
    const clears = zero();
    for (const each of members) clears[each.severity]++;
    const leaves = zero();
    for (const each of byPin.get(pinKey(first)) ?? []) if (!members.includes(each)) leaves[each.severity]++;
    const dues = members.flatMap((each) => (each.due === undefined ? [] : [each.due]));
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
    move.lane = laneOf(move, new Set(members.map((each) => each.kind)), members, context);
    out.push(move);
  }
  return out.sort(
    (a, b) =>
      (a.deadline ?? Number.POSITIVE_INFINITY) - (b.deadline ?? Number.POSITIVE_INFINITY) ||
      b.clears.CRITICAL - a.clears.CRITICAL ||
      b.clears.HIGH - a.clears.HIGH ||
      order(a.name, b.name) ||
      order(a.from, b.from),
  );
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
}

/** The shape of `moves.json`. */
export interface MovesFile {
  version: typeof MOVES_VERSION;
  repository: string;
  /** When the scan judged them, UTC to the second. */
  judged: string;
  /** The run that made it (GITHUB_RUN_ID), which each of its results' messages names after its move's place. */
  run?: string | undefined;
  /** How many results have a fix and are not excepted, how many moves, and the moves in each lane. */
  totals: { fixed: number; moves: number; lanes: Record<Lane, number> };
  moves: PublicMove[];
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
  };
}

export function movesFile(list: Move[], context: Pick<Context, 'repository' | 'now'>, run?: string): MovesFile {
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, list.filter((m) => m.lane === lane).length])) as Record<
    Lane,
    number
  >;
  const fixed = list.reduce((sum, m) => sum + SEVERITIES.reduce((n, s) => n + m.clears[s], 0), 0);
  return {
    version: MOVES_VERSION,
    repository: context.repository,
    judged: dayText(context.now),
    ...(run ? { run } : {}),
    totals: { fixed, moves: list.length, lanes },
    moves: list.map(publicMove),
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
    `Moves: ${file.totals.fixed} results with a fix, in ${file.totals.moves} moves${lanes ? ` (${lanes})` : ''}.`,
  ];
  if (!file.moves.length) return lines;
  lines.push(
    '',
    '| Move | From | To | Clears | Leaves | New today | Deadline | Lane |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const move of file.moves)
    lines.push(
      `| ${move.name} | ${move.from || '–'} | ${move.to || '–'} | ${short(move.clears)} | ${short(move.leaves)} | ${move.newToday} | ${move.deadline ?? '–'} | ${move.lane} |`,
    );
  return lines;
}

/** The directories `dependabot.yml`'s docker entries read, from its text: `directory:` and `directories:` lists. */
export function dependabotDirectories(text: string | undefined) {
  if (!text) return [];
  const found: string[] = [];
  let docker = false;
  let listing = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    const entry = /^ {2}- package-ecosystem:\s*['"]?([\w-]+)['"]?\s*$/.exec(line);
    if (entry) {
      docker = entry[1] === 'docker';
      listing = false;
      continue;
    }
    if (!docker) continue;
    const one = /^ {4}directory:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (one?.[1]) found.push(one[1]);
    if (/^ {4}directories:\s*$/.test(line)) {
      listing = true;
      continue;
    }
    const item = /^ {6}- ['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (listing && item?.[1]) found.push(item[1]);
    else if (listing && /^ {4}\S/.test(line)) listing = false;
  }
  return found;
}

/** The direct dependencies of a pnpm lockfile's importers. */
export function directPackages(lockfile: string | undefined) {
  const found = new Set<string>();
  if (!lockfile) return found;
  let inImporters = false;
  let inDependencies = false;
  for (const line of lockfile.split('\n')) {
    if (/^\S/.test(line)) {
      inImporters = line.startsWith('importers:');
      inDependencies = false;
      continue;
    }
    if (!inImporters) continue;
    if (/^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/.test(line)) {
      inDependencies = true;
      continue;
    }
    if (/^ {4}\S/.test(line) || /^ {2}\S/.test(line)) {
      inDependencies = false;
      continue;
    }
    const name = /^ {6}'?([^':\s][^':]*)'?:\s*$/.exec(line)?.[1];
    if (inDependencies && name) found.add(name);
  }
  return found;
}
