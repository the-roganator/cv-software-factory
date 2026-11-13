/**
 * A Critical vulnerability's fix (spec 4.3, ADR 0020): whether a pull request of the factory's App in the app's
 * repository moves one dependency to fix a finding the gate's own scanner rates Critical, and nothing else, proved from
 * its two commits, so the review gate passes it as `critical-fix` (scripts/review-routing.ts). Every condition is a
 * positive proof, in this order, and the first that cannot be proved holds the pull request for Martin, with the
 * reason, which the hold names beside its `dependency-change` tag:
 *
 * 1. **Pins only.** The change is what the merge makes: the head merged onto main's tip, against that tip. Every file it
 *    changes is one of the app's pins, modified in place, regular, with its mode: `pnpm-lock.yaml`; `package.json`, a
 *    dependency's version range alone, of a package already there; the `Dockerfile`'s `FROM` lines, each its image's
 *    tag and digest alone, in the same repository; `mise.toml`'s Node, with its entry in `mise.lock` (the version, the
 *    checksums and nodejs.org's download URLs for that version), forward on its major. The lockfile is read as YAML,
 *    document by document: everything but its importers, packages and snapshots is the same; each importer the same
 *    but in its dependencies' ranges and versions, every version a registry's (never an alias, a `link:`, a `file:`, a
 *    tarball or a git source); every package's entry a registry's integrity alone, and one that stays at a version the
 *    same. No package goes; a package whose versions change moves each forward on its major.
 * 2. **Forward on its line.** Each `FROM` it moves is the same tag at its index digest now, or the newest tag on its line
 *    at its index digest now (`imageForward`, as a pin move's), never a major and never back.
 * 3. **The scans show the fix.** The gate's pinned Trivy, on a fresh database, on the lockfile at both sides and on each
 *    moved image at both sides on each platform we run, and Node's own database on the Node mise pins at both sides, as
 *    the daily scan reads Node: a finding the scanner rates Critical at the base, with a fix, is gone at the head, and
 *    its package is still there at or above its fixed version. The publisher's rating is never read: it can hold a
 *    change, never release one. Every package the base's scan lists is in the head's, and the Node binary where an image
 *    names one: a finding that disappears with its package is not a fix. A report that does not parse, or reads
 *    nothing, holds. The Criticals it fixes are in one package: two is a group.
 * 4. **Nothing new.** No scan of the head finds anything at High or above the base's did not.
 * 5. **Only what the fix needs moves.** For a package: every package whose versions change, and every one the lockfile
 *    adds, is the fixed one or one its new version requires, by the head's snapshots; no image and no Node moves. For
 *    Node: mise's pin and every `FROM` move, nothing in the lockfile, and every image whose Node the scan reads runs the
 *    Node mise pins. For an image's own package: that image's `FROM` lines alone, its Node unchanged.
 * 6. **Every gate passes.** GitHub Actions' latest run at the head of each of the app's required checks but the gate's
 *    own succeeded, made by the workflow that has that job, for this pull request (`workflowsOf`, as a pin move reads
 *    its runs): its gates, its tests (`test/node-pins.test.ts` holds mise's Node to each `FROM`), and `image builds`,
 *    which runs the runtime image's `node --version` against mise's, so the runtime's Node, which its tag does not name
 *    and Trivy does not read, is the one scanned.
 *
 * It trusts nothing the pull request says of itself (its title, label, description, branch or advisory): the fix is
 * read from the gate's own scans of its two commits, and the code that reads them is main's. Its head is data: no
 * line of it is run, built or installed. A fact that could not be read holds.
 */
import { parse as parseYaml } from 'yaml';
import { documents } from '../apps/factory/src/gates/lockfile-scan.ts';
import { repositoryOf } from '../apps/factory/src/vulnerabilities/scan.ts';
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
const sev = (severity: string) => severity.toUpperCase();

// 1. Pins only: each file's lines.

/** The pins the change writes, read from its files' text. */
export interface Pins {
  lockfile?: { before: string; after: string };
  /** A dependency's range in package.json, by name: from one range to another. */
  ranges: Map<string, { from: string; to: string }>;
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

/** A package's name as npm writes one, scoped or not. */
const NAME = '(?:@[a-z0-9][\\w.-]*/)?[a-z0-9][\\w.-]*';
/** A version a registry publishes: numbers, and a prerelease or build after them. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
/** A range in package.json the rule moves: a registry version, exact, `^` or `~`. */
const RANGE_LINE = new RegExp(`^(\\s*)"(${NAME})": "([~^]?)(\\d+\\.\\d+\\.\\d+)"(,?)$`);
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** The ranges package.json moves, or why it changes more: each changed line a dependency's version, nothing else. */
export function manifestRanges(before: string, after: string): Map<string, { from: string; to: string }> | Reason {
  const lines = rewritten(MANIFEST, before, after);
  if ('reason' in lines) return lines;
  const ranges = new Map<string, { from: string; to: string }>();
  for (const { line, was, now } of lines) {
    const [a, b] = [RANGE_LINE.exec(was), RANGE_LINE.exec(now)];
    if (!a || !b || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3] || a[5] !== b[5])
      return no(`${MANIFEST}:${line} is not a dependency's version: ${short(now.trim())}`);
    ranges.set(a[2] as string, { from: `${a[3]}${a[4]}`, to: `${b[3]}${b[4]}` });
  }
  // Read as JSON too: the lines changed are those dependencies' ranges, and everything else is the same.
  let was: Record<string, unknown>;
  let now: Record<string, unknown>;
  try {
    [was, now] = [JSON.parse(before), JSON.parse(after)];
  } catch {
    return no(`${MANIFEST} is not JSON the gate reads`);
  }
  const put = { ...now };
  for (const section of SECTIONS) {
    const [x, y] = [was[section], now[section]];
    if (!x || !y || typeof x !== 'object' || typeof y !== 'object') continue;
    const copy: Record<string, unknown> = { ...(y as Record<string, unknown>) };
    for (const [name, range] of Object.entries(x as Record<string, unknown>)) {
      const moved = ranges.get(name);
      if (moved && range === moved.from && copy[name] === moved.to) copy[name] = range;
    }
    put[section] = copy;
  }
  if (JSON.stringify(put) !== JSON.stringify(was))
    return no(`${MANIFEST} changes more than its dependencies' version ranges`);
  return ranges;
}

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
  return { from, to };
}

/** The pins a change writes, or why it is not a change of pins alone. */
export function pinsOnly(raw: string, files: readonly Rewritten[]): Pins | Reason {
  const entries = raw.split('\n').filter((line) => line.startsWith(':'));
  if (!entries.length) return no('it changes no file');
  const pins: Pins = { ranges: new Map(), images: [], froms: 0 };
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
    else if (path === MANIFEST) {
      const ranges = manifestRanges(file.before, file.after);
      if ('reason' in ranges) return ranges;
      pins.ranges = ranges;
    } else if (path === DOCKERFILE) {
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
  if (pins.ranges.size && !pins.lockfile) return no(`${MANIFEST} moves a range the lockfile does not`);
  return pins;
}

// 1. Pins only: the lockfile, as YAML.

/** A package's `name@version` key, split: the name may start with `@`. */
export function splitKey(key: string): { name: string; version: string } | undefined {
  const at = key.lastIndexOf('@');
  if (at <= 0) return undefined;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/** A version an importer or a snapshot resolves to, with its peers' suffix: a registry's, or none. */
const registryVersion = (version: unknown) =>
  typeof version === 'string' && VERSION.test(version.replace(/\(.*\)$/, ''))
    ? version.replace(/\(.*\)$/, '')
    : undefined;

/** What the lockfile moves, read from both sides. */
export interface LockMoves {
  /** By name: the versions it no longer has and those it gains, each a package already there. */
  moved: Map<string, { removed: string[]; added: string[] }>;
  /** Packages it adds that were not there at any version, each with its versions. */
  added: Map<string, string[]>;
  /** The ranges its importers change, by name. */
  ranges: Map<string, { from: string; to: string }>;
  /** The head's snapshots: each `name@version` and the `name@version`s it requires. */
  requires: Map<string, string[]>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** An importer with every dependency's version and range set aside, after each version is read as a registry's. */
function importerShape(
  importer: Record<string, unknown>,
  seen: (name: string, entry: Record<string, unknown>) => string | undefined,
): Record<string, unknown> | string {
  const shape: Record<string, unknown> = {};
  for (const [section, deps] of Object.entries(importer)) {
    if (!/[dD]ependencies$/.test(section)) {
      shape[section] = deps;
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(record(deps))) {
      const entry = record(value);
      const wrong = seen(name, entry);
      if (wrong) return wrong;
      const { version: _v, specifier: _s, ...rest } = entry;
      kept[name] = rest;
    }
    shape[section] = kept;
  }
  return shape;
}

/** What the lockfile moves between the two sides, or why it is not a move of registry versions alone. */
export function lockMoves(before: string, after: string): LockMoves | Reason {
  const [a, b] = [documents(before), documents(after)];
  if (a.length !== b.length) return no(`${LOCKFILE} has ${b.length} documents at the head and ${a.length} at the base`);
  const parse = (doc: string) => record(parseYaml(doc, { uniqueKeys: true, prettyErrors: false }));
  const result: LockMoves = { moved: new Map(), added: new Map(), ranges: new Map(), requires: new Map() };
  const versions = (side: Record<string, unknown>[]) => {
    const all = new Map<string, Set<string>>();
    for (const doc of side)
      for (const key of Object.keys(record(doc.packages))) {
        const split = splitKey(key);
        if (split) all.set(split.name, new Set([...(all.get(split.name) ?? []), split.version]));
      }
    return all;
  };
  let docs: [Record<string, unknown>[], Record<string, unknown>[]];
  try {
    docs = [a.map(parse), b.map(parse)];
  } catch (error) {
    return no(`${LOCKFILE} is not YAML the gate reads (${short(String(error).split('\n')[0] ?? '')})`);
  }
  for (const [i, was] of docs[0].entries()) {
    const now = docs[1][i] as Record<string, unknown>;
    const which = a.length > 1 ? `${LOCKFILE}'s document ${i + 1}` : LOCKFILE;
    if (!same(Object.keys(was), Object.keys(now))) return no(`${which} has other sections at the head`);
    for (const key of Object.keys(was))
      if (!['importers', 'packages', 'snapshots'].includes(key) && !same(was[key], now[key]))
        return no(`${which} changes its ${key}, which is not a package's version`);
    // Importers: the same, but in each dependency's range and its version, which is a registry's on both sides.
    const [wi, ni] = [record(was.importers), record(now.importers)];
    if (!same(Object.keys(wi), Object.keys(ni))) return no(`${which} has other importers at the head`);
    for (const id of Object.keys(wi)) {
      const ranges = new Map<string, string>();
      const look = (side: 'base' | 'head') => (name: string, entry: Record<string, unknown>) => {
        if (!registryVersion(entry.version))
          return `${which} resolves ${name} to ${short(String(entry.version))} at the ${side}: not a registry's version (an alias, a link, a file, a tarball or git)`;
        if (side === 'base') ranges.set(name, String(entry.specifier));
        else if (ranges.get(name) !== String(entry.specifier))
          result.ranges.set(name, { from: ranges.get(name) ?? '', to: String(entry.specifier) });
        return undefined;
      };
      const [x, y] = [importerShape(record(wi[id]), look('base')), importerShape(record(ni[id]), look('head'))];
      if (typeof x === 'string') return no(x);
      if (typeof y === 'string') return no(y);
      if (!same(x, y)) return no(`${which}'s importer ${id} changes more than its dependencies' versions`);
    }
    // Packages: a registry's integrity alone at the head, and the same entry at a version both sides have.
    const [wp, np] = [record(was.packages), record(now.packages)];
    for (const [key, entry] of Object.entries(np)) {
      const split = splitKey(key);
      if (!split || !VERSION.test(split.version))
        return no(`${which} has a package that is no registry's version: ${short(key)}`);
      const resolution = record(record(entry).resolution);
      if (!same(Object.keys(resolution), ['integrity']) || typeof resolution.integrity !== 'string')
        return no(`${which} resolves ${short(key)} from somewhere other than the registry, by its integrity`);
      if (key in wp && !same(wp[key], entry)) return no(`${which} changes ${short(key)}'s entry at the same version`);
    }
    for (const [key, entry] of Object.entries(record(now.snapshots))) {
      const deps = { ...record(record(entry).dependencies), ...record(record(entry).optionalDependencies) };
      result.requires.set(
        key.replace(/\(.*\)$/, ''),
        Object.entries(deps).flatMap(([name, version]) => {
          const v = registryVersion(version);
          return v ? [`${name}@${v}`] : [`${name}@${String(version)}`];
        }),
      );
    }
  }
  const [was, now] = [versions(docs[0]), versions(docs[1])];
  for (const [name, at] of was) {
    const then = now.get(name);
    if (!then) return no(`${name} is gone from the lockfile: a package removed is no fix`);
    const removed = [...at].filter((v) => !then.has(v));
    const added = [...then].filter((v) => !at.has(v));
    if (!removed.length && !added.length) continue;
    // Each version it no longer has is replaced by one forward of it on its major, so nothing is left behind.
    for (const v of removed)
      if (!added.some((n) => sameMajor(n, v) && exactOrder(n, v) === 1))
        return no(`${name} ${v} goes, with nothing forward of it on its major in its place`);
    result.moved.set(name, { removed, added });
  }
  for (const [name, at] of now) if (!was.has(name)) result.added.set(name, [...at]);
  return result;
}

// 3 and 4. The scans.

/** One scan of each side of one target: the lockfile, an image on one platform, or mise's Node. */
export interface Target {
  label: string;
  was: Scan;
  now: Scan;
}

/** Whether a version is at or above an advisory's fixed version: one on its major, or every one it names. */
export function atOrAbove(version: string, fixed: string): boolean | undefined {
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
  let best = '';
  for (const { label, was, now } of targets) {
    const key = (f: Finding) => `${f.id}\0${f.pkg}`;
    const after = new Set(now.findings.map(key));
    const names = new Set(now.packages.map((p) => p.name));
    // A finding that disappears with its package is not a fix: everything the base lists is still listed.
    const gone = was.packages.find((p) => !names.has(p.name));
    if (gone) return no(`the scans show no fix: ${gone.name} is in the base's scan of ${label} and not the head's`);
    if (was.node && !now.node)
      return no(`the scans show no fix: ${label} names no Node at the head, and did at the base`);
    for (const f of was.findings) {
      if (!f.fixed || after.has(key(f))) continue;
      if (!HIGH.has(sev(f.severity))) continue;
      if (sev(f.severity) !== 'CRITICAL') {
        best ||= `${f.pkg}'s ${f.id}, which the gate's scanner rates ${sev(f.severity)}`;
        continue;
      }
      const at = now.packages.filter((p) => p.name === f.pkg).map((p) => p.version);
      if (!at.length || at.some((v) => !atOrAbove(v, f.fixed as string)))
        return no(
          `the scans show no fix: ${f.pkg} is at ${at.join(', ') || 'no version'} in ${label} at the head, not at or above ${short(f.fixed)}, its fix for ${f.id}`,
        );
      const one = fixed.get(f.pkg) ?? { pkg: f.pkg, ids: [], where: [] };
      if (!one.ids.includes(f.id)) one.ids.push(f.id);
      if (!one.where.includes(label)) one.where.push(label);
      fixed.set(f.pkg, one);
    }
    const before = new Set(was.findings.map(key));
    const brought = now.findings.find((f) => HIGH.has(sev(f.severity)) && !before.has(key(f)));
    if (brought)
      return no(`it brings something new: ${brought.pkg}'s ${brought.id}, ${sev(brought.severity)}, in ${label}`);
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

/** Every `name@version` a package's versions require, by the head's snapshots, followed to the end. */
export function required(name: string, versions: readonly string[], requires: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = versions.map((v) => `${name}@${v}`);
  while (queue.length) {
    const next = queue.shift() as string;
    for (const dep of requires.get(next) ?? [])
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
  }
  return seen;
}

/** Whether only what the fix needs moves, or what else does. */
export function onlyTheFix(fixed: Fixed, pins: Pins, lock: LockMoves | undefined): string | undefined {
  const inLockfile = fixed.where.includes(LOCKFILE);
  if (inLockfile) {
    if (pins.images.length || pins.node) return "it moves an image or Node too, which a package's fix does not need";
    if (!lock) return 'the lockfile does not move';
    const moved = lock.moved.get(fixed.pkg);
    if (!moved) return `the lockfile does not move ${fixed.pkg}`;
    const needs = required(fixed.pkg, moved.added, lock.requires);
    const needed = (name: string, version: string) => name === fixed.pkg || needs.has(`${name}@${version}`);
    for (const [name, { added }] of lock.moved)
      for (const v of added)
        if (!needed(name, v)) return `it moves ${name} to ${v} too, which ${fixed.pkg}'s fix does not need`;
    for (const [name, at] of lock.added)
      for (const v of at)
        if (!needed(name, v)) return `it adds ${name} ${v}, which ${fixed.pkg}'s new version does not require`;
    for (const [name, range] of [...pins.ranges, ...lock.ranges])
      if (name !== fixed.pkg)
        return `it moves ${name}'s range to ${range.to} too, which ${fixed.pkg}'s fix does not need`;
    const [manifest, locked] = [pins.ranges.get(fixed.pkg)?.to, lock.ranges.get(fixed.pkg)?.to];
    if (manifest !== locked) return `${MANIFEST} and ${LOCKFILE} do not move ${fixed.pkg}'s range alike`;
    return undefined;
  }
  if (pins.lockfile || pins.ranges.size) return "it moves a package too, which an image's fix does not need";
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
export function gatesPass(runs: readonly Run[], head: string, gates = APP_GATES): string | undefined {
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
  const lock = pins.lockfile ? lockMoves(pins.lockfile.before, pins.lockfile.after) : undefined;
  if (lock && 'reason' in lock) return no(`pins only: ${lock.reason}`);
  if (lock)
    for (const [name] of pins.ranges)
      if (!lock.ranges.has(name)) return no(`pins only: ${MANIFEST} moves ${name}'s range, and the lockfile does not`);
  // 2. Forward on its line.
  for (const { from, to } of pins.images) {
    const back = await imageForward(from, to, io);
    if (back) return no(`forward on its line: ${back}`);
  }
  // 3 and 4. The scans, each side of each target.
  const targets: Target[] = [];
  if (pins.lockfile) {
    const [was, now] = await Promise.all([io.lockfile(pins.lockfile.before), io.lockfile(pins.lockfile.after)]);
    targets.push({ label: LOCKFILE, was, now });
  }
  for (const { from, to } of pins.images)
    for (const platform of PLATFORMS) {
      const [was, now] = await Promise.all([io.image(from, platform), io.image(to, platform)]);
      targets.push({ label: `${repositoryOf(to)} (${platform})`, was, now });
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
  const stray = onlyTheFix(shown, pins, lock);
  if (stray) return no(`only what the fix needs: ${stray}`);
  // 6. Every gate passes, last: a fix that waits only on its gates says so with every other condition proved.
  const gates = gatesPass(await io.runs(), head);
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
