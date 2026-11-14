/**
 * A Critical vulnerability's fix (spec 4.3, ADR 0020): whether a pull request of the factory's App in the app's
 * repository moves one dependency to fix a finding the gate's own scanner rates Critical, and nothing else, proved from
 * its two commits, so the review gate passes it as `critical-fix` (scripts/review-routing.ts). Every condition is a
 * positive proof, in this order, and the first that cannot be proved holds the pull request for Martin, with the
 * reason, which the hold names beside its `dependency-change` tag:
 *
 * 1. **Pins only.** The change is what the merge makes: the head merged onto main's tip, against that tip. Every file it
 *    changes is one of the app's pins, modified in place, regular, with its mode: `pnpm-lock.yaml` and `package.json`;
 *    the `Dockerfile`'s `FROM` lines, each its image's tag and digest alone, in the same repository; `mise.toml`'s Node,
 *    with its entry in `mise.lock` (the version, the checksums and nodejs.org's download URLs for that version), forward
 *    on its major. A package's move is never read from the head's lockfile: the gate works out the move (`theMove`: a
 *    package its scanner rates Critical in the base's lockfile, and the version the head gives it, two words, checked),
 *    writes the lockfile for it on the base with the pin step's own code and pnpm (`CriticalFixIO.derive`), and passes
 *    only a head whose `pnpm-lock.yaml` and `package.json` are those bytes (`asDerived`).
 * 2. **Forward on its line.** Each `FROM` it moves is the same tag at its index digest now, or the newest tag on its line
 *    at its index digest now (`imageForward`, as a pin move's), never a major and never back.
 * 3. **The scans show the fix.** The gate's pinned Trivy, on a fresh database, on the lockfile at both sides and on each
 *    moved image at both sides on each platform we run, and Node's own database on the Node mise pins at both sides, as
 *    the daily scan reads Node: a finding the scanner rates Critical at the base, with a fix, is gone at the head, and
 *    its package is still there at or above its fixed version, in its own format's order (`critical-fix-versions.ts`).
 *    The publisher's rating is never read but for Node, whose only rating is its own database's. Every package the
 *    base's scan lists is in the head's, and the Node binary where an image names one: a finding that disappears with
 *    its package is not a fix. A report that does not parse, reads nothing, or has a finding with no package or advisory,
 *    holds. The Criticals it fixes are in one package: two is a group.
 * 4. **Nothing new.** No scan of the head finds anything at High or above the base's did not.
 * 5. **Only what the fix needs moves.** For a package: the package fixed is the move's, and what else its lockfile moves
 *    is what pnpm moved for it (condition 1); no image and no Node moves. For Node: mise's pin and every `FROM` move,
 *    nothing in the lockfile, and every image whose Node the scan reads runs the Node mise pins. For an image's own
 *    package: that image's `FROM` lines alone, its Node unchanged.
 * 6. **Every gate passes.** GitHub Actions' latest run at the head of each of the app's required checks but the gate's
 *    own succeeded, made by the workflow that has that job, for this pull request (`workflowsOf`, as a pin move reads
 *    its runs): its gates, its tests (`test/node-pins.test.ts` holds mise's Node to each `FROM`), and `image builds`,
 *    which runs the runtime image's `node --version` against mise's, so the runtime's Node, which its tag does not name
 *    and Trivy does not read, is the one scanned.
 *
 * It trusts nothing the pull request says of itself (its title, label, description, branch or advisory): the fix is
 * read from the gate's own scans of its two commits, and the code that reads them is main's. Its head is data: no
 * line of it is run, built or installed, and only a package's name and a version cross from it into what runs, pnpm
 * on the base. A fact that could not be read holds.
 */

import { repositoryOf } from '../apps/factory/src/vulnerabilities/scan.ts';
import { compareVersions, lockedVersions, type Move, PinsHeld, PinsRefused } from '../apps/runner/src/pins.ts';
import { compareIn } from './critical-fix-versions.ts';
import { imageForward } from './pin-move-forward.ts';
import { ACTIONS, type Run } from './pin-move-ran.ts';
import { exactOrder, majorOf, sameMajor, short } from './pin-move-shared.ts';
import type { Rewritten } from './pin-move-sides.ts';

/** A finding, by the scanner's own rating: its advisory, its package and the version it was found at. */
export interface Finding {
  id: string;
  pkg: string;
  version: string;
  /** The fixed versions the advisory names, as the scanner writes them; none when there is no fix. */
  fixed?: string;
  /** The scanner's rating, never the publisher's. */
  severity: string;
  /**
   * The order its versions are in, from what Trivy says of the target it scanned (`formatOf`): `npm` where none is
   * given (a lockfile's packages, and Node's), `dpkg` or `apk` for an OS's, `unread:…` for one the gate does not order.
   */
  format?: string;
}

/** What one scan read: every package, by name and version, and every finding. */
export interface Scan {
  packages: { name: string; version: string }[];
  findings: Finding[];
  /** The Node version the image names, where the scan reads one (`NODE_VERSION`, or an OS package's). */
  node?: string;
}

/** Everything the rule reads, so the tests give it answers instead. Each may throw: a fact not read holds. */
export interface CriticalFixIO {
  /** The change from main's tip to the merge: git's `--raw` list, and each modified file's text at both commits. */
  diff(): Promise<{ raw: string; files: Rewritten[] }>;
  /** The pinned Trivy's scan of a lockfile's text; throws when it cannot read it whole. */
  lockfile(text: string): Promise<Scan>;
  /** The pinned Trivy's scan of an image on one platform; throws when it cannot pull or read it. */
  image(reference: string, platform: string): Promise<Scan>;
  /** Node's own advisories that a Node version has, from Node's database, as the daily scan reads them. */
  node(version: string): Promise<Finding[]>;
  /** The versions the registry publishes of a package. */
  versions(name: string): Promise<string[]>;
  /**
   * The pin step's own derivation of a move on the base (`writePins`, apps/runner/src/pins.ts, run by the same pnpm):
   * each file it changes, with the text it writes. Throws `PinsRefused` or `PinsHeld` where the pin step would.
   */
  derive(move: PackageMove): Promise<Record<string, string>>;
  /** The checks the app's ruleset requires of `main`, by name. */
  required(): Promise<string[]>;
  /** Every tag of an image's repository. */
  tags(repository: string): Promise<string[]>;
  /** An image's index digest now. */
  digest(reference: string): Promise<string>;
  /** The check runs at the head, each with the workflow that made it (`workflowsOf`). */
  runs(): Promise<Run[]>;
}

/** The platforms an image is scanned on: CI's (amd64) and the local cluster's (arm64), as a pin move's. */
export const PLATFORMS = ['linux/amd64', 'linux/arm64'];

/** The app's files that hold its dependencies' pins, and nothing else a fix may change. */
export const LOCKFILE = 'pnpm-lock.yaml';
export const MANIFEST = 'package.json';
export const DOCKERFILE = 'Dockerfile';
export const MISE = 'mise.toml';
export const MISE_LOCK = 'mise.lock';
export const PIN_FILES: readonly string[] = [LOCKFILE, MANIFEST, DOCKERFILE, MISE, MISE_LOCK];

/**
 * The app's required checks the fix must pass, each with the workflow that has its job: every one its ruleset requires
 * but `review`, which is this gate's own. `test/node-pins.test.ts`, in `lint, types, tests`, holds mise's Node to each
 * `FROM`; `image builds` runs the runtime image's `node --version` against mise's.
 */
export const APP_GATES: Readonly<Record<string, string>> = {
  'lint, types, tests': '.github/workflows/check.yml',
  'image builds': '.github/workflows/check.yml',
  'title / pull request title': '.github/workflows/pr-title.yml',
  'gates / journeys': '.github/workflows/gates.yml',
  'gates / test integrity': '.github/workflows/gates.yml',
  'gates / dependency review': '.github/workflows/gates.yml',
  'gates / image scan': '.github/workflows/gates.yml',
  'gates / lockfile scan': '.github/workflows/gates.yml',
};

const HIGH = new Set(['HIGH', 'CRITICAL']);
/** The ratings the scanner gives that the rule reads: any other, or none, holds. */
const RATED = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const sev = (severity: string) => severity.toUpperCase();

// 1. Pins only: each file's lines.

/** The pins the change writes, read from its files' text. */
export interface Pins {
  /** The lockfile and the manifest, each as text: proved only by being what the gate writes itself (`asDerived`). */
  lockfile?: { before: string; after: string };
  manifest?: { before: string; after: string };
  /** Each `FROM` the Dockerfile moves, by line, and how many `FROM` lines it has. */
  images: { line: number; from: string; to: string }[];
  froms: number;
  /** mise's Node, from one version to another. */
  node?: { from: string; to: string };
}

type Reason = { reason: string };
const no = (reason: string): Reason => ({ reason });

/** The lines two texts differ in, at the same place, or why they are not the same lines rewritten. */
function rewritten(path: string, before: string, after: string): { line: number; was: string; now: string }[] | Reason {
  const [a, b] = [before.split('\n'), after.split('\n')];
  if (a.length !== b.length)
    return no(`${path} adds or removes a line rather than rewriting one (${a.length} lines before, ${b.length} after)`);
  const lines = a.flatMap((was, i) => (was === b[i] ? [] : [{ line: i + 1, was, now: b[i] as string }]));
  if (!lines.length) return no(`${path} rewrites no line`);
  return lines;
}

/** A version a registry publishes: numbers, and a prerelease or build after them. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
/** A `FROM` line the rule moves: an image by tag and digest, and its stage's name if it has one. */
const FROM_LINE = /^FROM\s+([^\s@]+)@(sha256:[0-9a-f]{64})((?:\s+AS\s+[\w.-]+)?)\s*$/i;

/** The `FROM` lines the Dockerfile moves, or why it changes more: each the same image's tag and digest alone. */
export function dockerfileMoves(before: string, after: string): { images: Pins['images']; froms: number } | Reason {
  const lines = rewritten(DOCKERFILE, before, after);
  if ('reason' in lines) return lines;
  const images: Pins['images'] = [];
  for (const { line, was, now } of lines) {
    const [a, b] = [FROM_LINE.exec(was), FROM_LINE.exec(now)];
    if (!a || !b) return no(`${DOCKERFILE}:${line} is not an image's FROM, by tag and digest: ${short(now.trim())}`);
    if (a[3] !== b[3]) return no(`${DOCKERFILE}:${line} renames its stage`);
    const [from, to] = [`${a[1]}@${a[2]}`, `${b[1]}@${b[2]}`];
    if (repositoryOf(from) !== repositoryOf(to))
      return no(`${DOCKERFILE}:${line} swaps ${repositoryOf(from)} for another image, ${repositoryOf(to)}`);
    images.push({ line, from, to });
  }
  return { images, froms: after.split('\n').filter((l) => /^FROM\s/i.test(l)).length };
}

/** The table a TOML line is in: the last header above it. */
const tableOf = (lines: readonly string[], index: number) =>
  lines
    .slice(0, index)
    .findLast((l) => /^\s*\[/.test(l))
    ?.trim();

const NODE_LINE = /^node = "(\d+\.\d+\.\d+)"(\s*#.*)?$/;

/** mise.toml's Node, moved, or why it changes more: its `[tools]` table's `node` line alone. */
export function miseNode(before: string, after: string): { from: string; to: string } | Reason {
  const lines = rewritten(MISE, before, after);
  if ('reason' in lines) return lines;
  const [only, ...more] = lines;
  if (!only || more.length) return no(`${MISE} changes more than its Node`);
  const [a, b] = [NODE_LINE.exec(only.was), NODE_LINE.exec(only.now)];
  if (!a || !b || a[2] !== b[2] || tableOf(before.split('\n'), only.line - 1) !== '[tools]')
    return no(`${MISE}:${only.line} is not its Node: ${short(only.now.trim())}`);
  return { from: a[1] as string, to: b[1] as string };
}

/** A line of mise.lock's Node entry: its version, its specifier, a download's checksum or nodejs.org's URL for it. */
function lockLine(line: string, table: string): { version?: string; checksum?: true } | undefined {
  const platform = /^\[tools\.node\."platforms\.([\w-]+)"\]$/.exec(table)?.[1];
  if (table === '[[tools.node]]') {
    const version =
      /^version = "(\d+\.\d+\.\d+)"$/.exec(line)?.[1] ?? /^specifiers = \["(\d+\.\d+\.\d+)"\]$/.exec(line)?.[1];
    return version ? { version } : undefined;
  }
  if (!platform) return undefined;
  if (/^checksum = "sha256:[0-9a-f]{64}"$/.test(line)) return { checksum: true };
  const os = platform.replace(/^macos-/, 'darwin-');
  const url = /^url = "https:\/\/nodejs\.org\/dist\/v(\d+\.\d+\.\d+)\/node-v(\d+\.\d+\.\d+)-([\w-]+)\.tar\.gz"$/.exec(
    line,
  );
  if (url && url[1] === url[2] && url[3] === os) return { version: url[1] as string };
  return undefined;
}

/** mise.lock's Node, moved, or why it changes more: only its Node entry's lines, each naming the new version. */
export function miseLockNode(before: string, after: string): { from: string; to: string } | Reason {
  const lines = rewritten(MISE_LOCK, before, after);
  if ('reason' in lines) return lines;
  const [was, now] = [new Set<string>(), new Set<string>()];
  for (const { line, was: a, now: b } of lines) {
    const table = tableOf(before.split('\n'), line - 1) ?? '';
    const [x, y] = [lockLine(a, table), lockLine(b, table)];
    if (!x || !y || Boolean(x.checksum) !== Boolean(y.checksum))
      return no(`${MISE_LOCK}:${line} is not its Node's version, checksum or download: ${short(b.trim())}`);
    if (x.version) was.add(x.version);
    if (y.version) now.add(y.version);
  }
  const [from, ...others] = was;
  const [to, ...more] = now;
  if (!from || !to || others.length || more.length) return no(`${MISE_LOCK} moves its Node to no one version`);
  // Every line of the entry, changed or not, names the new version: none is left downloading the old one.
  const text = after.split('\n');
  for (const [i, line] of text.entries()) {
    const table = tableOf(text, i) ?? '';
    if (table !== '[[tools.node]]' && !table.startsWith('[tools.node."platforms.')) continue;
    const read = lockLine(line, table);
    const names = /\d+\.\d+\.\d+/.test(line) && !/^(backend|checksum) = /.test(line);
    if ((read?.version && read.version !== to) || (names && !read))
      return no(`${MISE_LOCK}:${i + 1} is left on another Node than ${to}: ${short(line.trim())}`);
  }
  return { from, to };
}

/** The pins a change writes, or why it is not a change of pins alone. */
export function pinsOnly(raw: string, files: readonly Rewritten[]): Pins | Reason {
  const entries = raw.split('\n').filter((line) => line.startsWith(':'));
  if (!entries.length) return no('it changes no file');
  const pins: Pins = { images: [], froms: 0 };
  let [node, locked]: ({ from: string; to: string } | undefined)[] = [];
  for (const entry of entries) {
    const [meta = '', ...rest] = entry.split('\t');
    const [modeA, modeB, , , status] = meta.slice(1).split(' ');
    const path = rest.join('\t');
    if (!PIN_FILES.includes(path)) return no(`it changes ${short(path)}, which is not one of the app's pins`);
    if (status !== 'M') return no(`${path} is not modified in place (${status})`);
    if (modeA !== modeB || !/^100(644|755)$/.test(modeA ?? ''))
      return no(`${path} changes its mode, or is not a regular file`);
    const file = files.find((f) => f.path === path);
    if (!file) return no(`the gate did not read ${path} at both commits`);
    if (file.before.includes('\0') || file.after.includes('\0')) return no(`${path} is binary`);
    if (path === LOCKFILE) pins.lockfile = { before: file.before, after: file.after };
    else if (path === MANIFEST) pins.manifest = { before: file.before, after: file.after };
    else if (path === DOCKERFILE) {
      const moved = dockerfileMoves(file.before, file.after);
      if ('reason' in moved) return moved;
      Object.assign(pins, moved);
    } else {
      const moved = path === MISE ? miseNode(file.before, file.after) : miseLockNode(file.before, file.after);
      if ('reason' in moved) return moved;
      if (path === MISE) node = moved;
      else locked = moved;
    }
  }
  if (node || locked) {
    if (!node || !locked || node.from !== locked.from || node.to !== locked.to)
      return no(`${MISE} and ${MISE_LOCK} do not move Node together, to one version`);
    if (exactOrder(node.to, node.from) !== 1 || !sameMajor(node.to, node.from))
      return no(`Node moves from ${node.from} to ${node.to}, not forward on its major`);
    pins.node = node;
  }
  if (pins.manifest && !pins.lockfile) return no(`${MANIFEST} changes, and ${LOCKFILE} does not`);
  return pins;
}

// 1. Pins only: a package's move, and the lockfile the gate writes for it.

/** The hold's words when the head's lockfile is not the gate's own. */
export const NOT_DERIVED = 'the lockfile is not the one this move writes';

/** A package's move, as the pin step takes one: the words that cross from the head, each checked. */
export type PackageMove = Move & { ecosystem: 'npm' };

/** A version as the pin step moves to one: numbers, and a prerelease after them, never a build or a range. */
const MOVE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** The fields of package.json whose range pins what is installed, as the pin step moves them. */
const PINNED = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** The range package.json gives a package, where it gives one: a word, read from JSON, never a fact about the graph. */
function rangeOf(manifest: string | undefined, name: string): string | undefined {
  if (manifest === undefined) return undefined;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(manifest) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const field of PINNED) {
    const range = record(json[field])[name];
    if (typeof range === 'string') return range;
  }
  return undefined;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fixed versions an advisory names on a version's major, as the scanner writes them. */
const fixesOnMajor = (fixed: string, version: string) =>
  fixed
    .split(/[\s,|]+/)
    .map((v) => v.replace(/^(>=|\^|~|=|v)+/, ''))
    .filter((v) => VERSION.test(v) && majorOf(v) !== undefined && majorOf(v) === majorOf(version));

/**
 * The one move a package's change makes, worked out by the gate: a package its own scanner rates Critical in the base's
 * lockfile, with a fix, and the version the head gives it, from its manifest's range where that moves and its
 * lockfile's keys where it does not (`lockedVersions`, the pin step's own reading). Only those two words cross from the
 * head, and each is checked here: a version as the pin step takes one, forward, at or above every Critical's fix, never
 * across a major the fix does not need. They steer the derivation and decide nothing: the head passes only if its files
 * are what the derivation writes (`asDerived`).
 */
export function theMove(
  was: Scan,
  lock: { before: string; after: string },
  manifest?: { before: string; after: string },
): PackageMove | Reason {
  const criticals = new Map<string, Finding[]>();
  for (const f of was.findings)
    if (sev(f.severity) === 'CRITICAL' && f.fixed && (f.format ?? 'npm') === 'npm')
      criticals.set(f.pkg, [...(criticals.get(f.pkg) ?? []), f]);
  const moves = (name: string) =>
    !same(lockedVersions(lock.before, name), lockedVersions(lock.after, name)) ||
    rangeOf(manifest?.before, name) !== rangeOf(manifest?.after ?? manifest?.before, name);
  const moved = [...criticals.keys()].filter(moves);
  // The scanner's rating alone: a package it rates High, whatever its publisher says, is no Critical's move.
  const high = was.findings.find((f) => sev(f.severity) === 'HIGH' && f.fixed && moves(f.pkg));
  if (!moved.length && high)
    return no(
      `the scans show no Critical fixed: the worst it fixes is ${high.pkg}'s ${high.id}, which the gate's scanner rates HIGH`,
    );
  if (!moved.length)
    return no(
      `the scans show no fix: it moves no package the gate's scanner rates Critical in the base's ${LOCKFILE}${criticals.size ? ` (${[...criticals.keys()].join(', ')})` : ''}`,
    );
  if (moved.length > 1) return no(`a group: it moves ${moved.join(' and ')}, each Critical, one move at a time`);
  const name = moved[0] as string;
  const findings = criticals.get(name) ?? [];
  const from = findings.map((f) => f.version).sort(compareVersions)[0] ?? '';
  const range = rangeOf(manifest?.after, name);
  let to: string | undefined;
  if (range !== undefined && range !== rangeOf(manifest?.before, name)) {
    to = /^[\^~]?(.*)$/.exec(range)?.[1];
    if (!to || !MOVE_VERSION.test(to))
      return no(`pins only: ${MANIFEST} gives ${name} ${short(range)}, not a version the pin step moves a range to`);
  } else {
    const base = new Set(lockedVersions(lock.before, name));
    to = lockedVersions(lock.after, name).find((v) => !base.has(v));
    if (!to) return no(`pins only: the head gives ${name} no version its base does not have`);
  }
  if (!MOVE_VERSION.test(from)) return no(`pins only: ${name} is found at ${short(from)}, not a version it moves from`);
  if (compareVersions(to, from) <= 0) return no(`pins only: ${name} goes from ${from} to ${to}, not forward`);
  for (const f of findings) {
    if (!atOrAbove(to, f.fixed as string))
      return no(`pins only: ${name} ${to} is not at or above ${short(f.fixed as string)}, its fix for ${f.id}`);
    if (fixesOnMajor(f.fixed as string, from).length && !sameMajor(to, from))
      return no(`pins only: ${name} goes from ${from} to ${to}, across a major its fix for ${f.id} does not need`);
  }
  return { ecosystem: 'npm', name, from, to };
}

/**
 * Whether the head's lockfile files are, byte for byte, those the pin step's derivation wrote from the base for the
 * move: every one either changes is changed by both, to the same text. A lockfile or manifest of any other kind is no
 * pin (`pinsOnly`), so with this the only lockfile that passes is the gate's own.
 */
export function asDerived(files: readonly Rewritten[], derived: Readonly<Record<string, string>>): string | undefined {
  const head = new Map(files.filter((f) => f.path === LOCKFILE || f.path === MANIFEST).map((f) => [f.path, f.after]));
  for (const path of new Set([...head.keys(), ...Object.keys(derived)].sort())) {
    const [ours, theirs] = [derived[path], head.get(path)];
    if (ours === undefined) return `the head changes ${path}, and the move does not`;
    if (theirs === undefined) return `the move changes ${path}, and the head does not`;
    if (ours === theirs) continue;
    const [a, b] = [ours.split('\n'), theirs.split('\n')];
    const line = a.findIndex((text, i) => text !== b[i]);
    return `${path} differs from the gate's own at line ${(line < 0 ? a.length : line) + 1}`;
  }
  return undefined;
}

// 3 and 4. The scans.

/** One scan of each side of one target: the lockfile, an image on one platform, or mise's Node. */
export interface Target {
  label: string;
  was: Scan;
  now: Scan;
}

/**
 * Whether a version is at or above an advisory's fixed version, in the format the scanner read it in: for npm's, one on
 * its major, or every one it names; for an OS's, any one it names, each by its package manager's order. Nothing when
 * the format is not one the gate orders, or no version parses in it.
 */
export function atOrAbove(version: string, fixed: string, format = 'npm'): boolean | undefined {
  if (format !== 'npm') {
    const orders = fixed
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((f) => compareIn(format, version, f));
    if (!orders.length || orders.some((o) => o === undefined)) return undefined;
    return orders.some((o) => (o as number) >= 0);
  }
  const named = fixed
    .split(/[\s,|]+/)
    .map((v) => v.replace(/^(>=|\^|~|=|v)+/, ''))
    .filter((v) => VERSION.test(v));
  if (!named.length) return undefined;
  const onMajor = named.filter((f) => majorOf(f) !== undefined && majorOf(f) === majorOf(version));
  const against = onMajor.length ? onMajor : named;
  return onMajor.length
    ? against.some((f) => (exactOrder(version, f) ?? -1) >= 0)
    : against.every((f) => (exactOrder(version, f) ?? -1) >= 0);
}

/** A Critical the scans show fixed: its package, its advisories, and where. */
export interface Fixed {
  pkg: string;
  ids: string[];
  where: string[];
}

/** Whether the scans show one package's Critical fixed, and nothing new at High or above: the fix, or why not. */
export function scansShow(targets: readonly Target[]): Fixed | Reason {
  const fixed = new Map<string, Fixed>();
  // Each Critical a head scan still has, wherever: one fixed on one platform and not the other is not fixed.
  const remains = new Map<string, string>();
  const key = (f: Finding) => `${f.id}\0${f.pkg}`;
  let best = '';
  for (const { label, was, now } of targets) {
    const after = new Set(now.findings.map(key));
    const names = new Set(now.packages.map((p) => p.name));
    // A finding that disappears with its package is not a fix: everything the base lists is still listed.
    const gone = was.packages.find((p) => !names.has(p.name));
    if (gone) return no(`the scans show no fix: ${gone.name} is in the base's scan of ${label} and not the head's`);
    if (was.node && !now.node)
      return no(`the scans show no fix: ${label} names no Node at the head, and did at the base`);
    for (const f of was.findings) {
      if (after.has(key(f))) remains.set(key(f), label);
      if (!f.fixed || after.has(key(f))) continue;
      if (!HIGH.has(sev(f.severity))) continue;
      if (sev(f.severity) !== 'CRITICAL') {
        best ||= `${f.pkg}'s ${f.id}, which the gate's scanner rates ${sev(f.severity)}`;
        continue;
      }
      const at = now.packages.filter((p) => p.name === f.pkg).map((p) => p.version);
      const orders = at.map((v) => atOrAbove(v, f.fixed as string, f.format));
      if (orders.includes(undefined)) {
        const format = f.format ?? 'npm';
        return no(
          format.startsWith('unread:')
            ? `the scans show no fix the gate reads: ${f.pkg}'s ${f.id} in ${label} is in ${format.slice(7)}'s versions, an order the gate does not read`
            : `the scans show no fix the gate reads: ${f.pkg} at ${at.join(', ')}, or its fix ${short(f.fixed as string)} for ${f.id}, is not a version in ${format}'s format`,
        );
      }
      if (!at.length || orders.some((ok) => !ok))
        return no(
          `the scans show no fix: ${f.pkg} is at ${at.join(', ') || 'no version'} in ${label} at the head, not at or above ${short(f.fixed)}, its fix for ${f.id}`,
        );
      const one = fixed.get(f.pkg) ?? { pkg: f.pkg, ids: [], where: [] };
      if (!one.ids.includes(f.id)) one.ids.push(f.id);
      if (!one.where.includes(label)) one.where.push(label);
      fixed.set(f.pkg, one);
    }
    const unrated = now.findings.find((f) => !RATED.has(sev(f.severity)));
    if (unrated)
      return no(
        `it brings something new: ${unrated.pkg}'s ${unrated.id} in ${label}, which the scanner gives no rating it reads`,
      );
    const before = new Set(was.findings.map(key));
    const brought = now.findings.find((f) => HIGH.has(sev(f.severity)) && !before.has(key(f)));
    if (brought)
      return no(`it brings something new: ${brought.pkg}'s ${brought.id}, ${sev(brought.severity)}, in ${label}`);
  }
  for (const one of fixed.values())
    for (const id of one.ids) {
      const still = remains.get(`${id}\0${one.pkg}`);
      if (still)
        return no(
          `the scans show no fix: ${one.pkg}'s ${id} is gone from ${one.where.join(', ')} and still in ${still}`,
        );
    }
  if (fixed.size === 0)
    return no(
      best
        ? `the scans show no Critical fixed: the worst it fixes is ${best}`
        : 'the scans show no Critical fixed: the finding it claims to fix is still there, or never was',
    );
  if (fixed.size > 1)
    return no(`a group: it fixes Criticals in ${[...fixed.keys()].join(' and ')}, one move at a time`);
  return [...fixed.values()][0] as Fixed;
}

// 5. Only what the fix needs.

/** Whether only what the fix needs moves, or what else does. A package's graph is pnpm's, proved by `asDerived`. */
export function onlyTheFix(fixed: Fixed, pins: Pins, move: PackageMove | undefined): string | undefined {
  if (fixed.where.includes(LOCKFILE)) {
    if (pins.images.length || pins.node) return "it moves an image or Node too, which a package's fix does not need";
    if (!move || move.name !== fixed.pkg) return `it fixes ${fixed.pkg}, and moves ${move?.name ?? 'no package'}`;
    return undefined;
  }
  if (pins.lockfile || pins.manifest) return "it moves a package too, which an image's fix does not need";
  if (fixed.pkg === 'node') {
    if (!pins.node) return "Node is fixed in an image, and mise's Node does not move with it";
    if (pins.images.length !== pins.froms)
      return `it moves ${pins.images.length} of the Dockerfile's ${pins.froms} FROM lines: every image runs Node`;
    return undefined;
  }
  if (pins.node) return `it moves Node too, which ${fixed.pkg}'s fix does not need`;
  const repositories = new Set(pins.images.map((i) => repositoryOf(i.from)));
  if (repositories.size !== 1) return `it moves ${repositories.size} images, where ${fixed.pkg}'s fix needs one`;
  return undefined;
}

// 6. Every gate passes.

/**
 * Whether each of the app's gates ran at the head and succeeded: every run of each name at the head, from the workflow
 * that has its job, at its latest attempt, completed, a success. A run of the same name from anywhere else, or another
 * app's, counts for nothing.
 */
export function gatesPass(
  runs: readonly Run[],
  head: string,
  required: readonly string[],
  gates = APP_GATES,
): string | undefined {
  // The app's ruleset, read when the fix is: a check it requires that the gate does not know holds it.
  if (!required.includes('review')) return "the app's ruleset, as the gate read it, does not require review";
  const unknown = required.find((name) => name !== 'review' && !(name in gates));
  if (unknown) return `the app requires ${unknown}, which the gate does not know`;
  for (const [name, workflow] of Object.entries(gates)) {
    const named = runs.filter((run) => run.name === name && run.head_sha === head && run.app?.slug === ACTIONS);
    const bySuite = new Map<number | string, Run>();
    for (const run of named.filter((each) => each.workflow === workflow)) {
      const suite = run.check_suite?.id ?? `run ${run.id}`;
      const seen = bySuite.get(suite);
      if (!seen || run.id > seen.id) bySuite.set(suite, run);
    }
    const latest = [...bySuite.values()];
    const at = head.slice(0, 7);
    if (!latest.length)
      return named.length
        ? `${name} at ${at} ran in no run of ${workflow} for this pull request that the gate could read`
        : `${name} has not run at ${at}`;
    if (latest.some((run) => run.status !== 'completed')) return `${name} has not finished at ${at}`;
    const failed = latest.find((run) => run.conclusion !== 'success');
    if (failed) return `${name} at ${at} is ${failed.conclusion ?? 'unfinished'}, not a success`;
  }
  return undefined;
}

// The rule.

export type CriticalFixResult = { fixed: Fixed; title: string } | Reason;

/** The fix a change makes, proved, or the first condition that could not be proved, named. */
export async function criticalFix(io: CriticalFixIO, head: string): Promise<CriticalFixResult> {
  // 1. Pins only: the text first, so nothing scans a head that changes more than versions and digests.
  const { raw, files } = await io.diff();
  const pins = pinsOnly(raw, files);
  if ('reason' in pins) return no(`pins only: ${pins.reason}`);
  // 2. Forward on its line.
  for (const { from, to } of pins.images) {
    const back = await imageForward(from, to, io);
    if (back) return no(`forward on its line: ${back}`);
  }
  // 3 and 4. The scans, each side of each target.
  const targets: Target[] = [];
  let move: PackageMove | undefined;
  if (pins.lockfile) {
    // The base's scan names the move; the gate writes the lockfile for it; the head passes only as those bytes.
    const was = await io.lockfile(pins.lockfile.before);
    const found = theMove(was, pins.lockfile, pins.manifest);
    if ('reason' in found) return found;
    move = found;
    if (!(await io.versions(move.name)).includes(move.to))
      return no(`pins only: ${move.to} is not a version the registry publishes of ${move.name}`);
    let derived: Record<string, string>;
    try {
      derived = await io.derive(move);
    } catch (error) {
      if (!(error instanceof PinsRefused || error instanceof PinsHeld)) throw error;
      return no(
        `pins only: ${NOT_DERIVED} (the pin step would not write ${move.name} ${move.to}: ${short(error.message)})`,
      );
    }
    const differs = asDerived(files, derived);
    if (differs) return no(`pins only: ${NOT_DERIVED} (${differs})`);
    // The head's lockfile is now the gate's own bytes: the scan reads what pnpm wrote, and no hand shaped.
    targets.push({ label: LOCKFILE, was, now: await io.lockfile(pins.lockfile.after) });
  }
  const scanned = await Promise.all(
    pins.images.flatMap(({ from, to }) =>
      PLATFORMS.map(async (platform) => {
        const [was, now] = await Promise.all([io.image(from, platform), io.image(to, platform)]);
        return { label: `${repositoryOf(to)} (${platform})`, to, was, now };
      }),
    ),
  );
  for (const { label, to, was, now } of scanned) {
    targets.push({ label, was, now });
    // Node moves only with mise's pin; where the image names its Node, it is mise's.
    if (pins.node ? now.node !== undefined && now.node !== pins.node.to : now.node !== was.node)
      return no(
        `only what the fix needs: ${repositoryOf(to)} runs Node ${now.node ?? 'unread'} at the head, and mise pins ${pins.node?.to ?? was.node ?? 'another'}`,
      );
  }
  if (pins.node) {
    const [was, now] = await Promise.all([io.node(pins.node.from), io.node(pins.node.to)]);
    targets.push({
      label: 'Node',
      was: { packages: [{ name: 'node', version: pins.node.from }], findings: was, node: pins.node.from },
      now: { packages: [{ name: 'node', version: pins.node.to }], findings: now, node: pins.node.to },
    });
  }
  const shown = scansShow(targets);
  if ('reason' in shown)
    return no(shown.reason.startsWith('it brings') ? `nothing new: ${shown.reason}` : shown.reason);
  // 5. Only what the fix needs moves.
  const stray = onlyTheFix(shown, pins, move);
  if (stray) return no(`only what the fix needs: ${stray}`);
  // 6. Every gate passes, last: a fix that waits only on its gates says so with every other condition proved.
  const gates = gatesPass(await io.runs(), head, await io.required());
  if (gates) return no(`every gate passes: ${gates}`);
  const ids =
    shown.ids.length > 3
      ? `${shown.ids.slice(0, 3).join(', ')} and ${shown.ids.length - 3} more`
      : shown.ids.join(', ');
  return {
    fixed: shown,
    title: `A Critical vulnerability's fix: ${shown.pkg}'s ${ids} gone from ${shown.where.length > 1 ? `${shown.where.length} scans` : shown.where[0]}, at or above its fix, nothing new at High, every gate passed`,
  };
}
