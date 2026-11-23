/**
 * The pin step: every pin of a dependency's move, and the lockfile after a change to a manifest, written by a step
 * that runs no agent. It runs in the prepare pod, the one of a runner's pods that may reach the internet, on a fresh
 * checkout, and it reads nothing but the registries: the coder, which reaches neither, never writes a lockfile.
 *
 * - **Before the coder**, on a dependency's work item, it writes the move (`writePins`), commits it on the checkout
 *   as the coder's starting point, and prints it as a patch for the line, which hands it to the GitHub worker beside
 *   the coder's own (`PatchCommit.pins`):
 *   - a package (`npm`): `pnpm update <package>` when the range each manifest gives it admits the target, and the
 *     range moved to the target first, with the same operator, when it does not, so the move never crosses a major
 *     the fix does not need. pnpm takes the newest release the range admits under the app's own release age and trust
 *     policy (`pnpm-workspace.yaml`). A package no manifest names is moved where its parents' ranges admit the fix; a
 *     copy left below it needs an override in `pnpm-workspace.yaml`, which is Martin's file, so the step stops and the
 *     work item waits for him (`PinsHeld`). A package at two versions is one move to two (`1.0.0, 2.0.0` to
 *     `1.0.1,2.0.3`, as the scan names them): each copy moves to the target on its own line.
 *   - Node (`node`): `mise.toml`'s version, `mise.lock`'s entry, with the checksum of each platform's download from
 *     Node's own `SHASUMS256.txt`, and each `FROM` of a Node image, its tag moved where it names the version and its
 *     digest the registry's for that tag. Not before the release is as old as `mise.toml`'s `minimum_release_age`.
 *   - a base image (`docker`): each `FROM` of the image at the move's `from`, given its `to`, once the registry says
 *     the tag is that digest. An image that runs Node brings its Node: where the image at that digest runs another
 *     release than `mise.toml` pins, Node moves to it as above, and the image to the move's digest.
 *   - a tool mise pins (`tool`): its version in `mise.lock`, and then `mise lock <tool>`, which writes each
 *     platform's download and checksum for that version, within the range `mise.toml` gives it. Not before the
 *     release, and the newest upload of its downloads, are as old as `mise.toml`'s `minimum_release_age`. Only where
 *     the step is given mise (`PinTools.mise`): the factory's moves, made by its scan and its review gate, never the
 *     runner.
 * - **After a coder's step** that changed a `package.json` (`writeLockfile`), it applies the pins and the coder's
 *   patch to a fresh checkout and writes the lockfile with `pnpm install --lockfile-only`, printing only the
 *   lockfile's change.
 *
 * pnpm runs here on manifests an agent may have written, on a pod with egress, so it runs no lifecycle script and no
 * pnpmfile, reads no `.npmrc` of the checkout's (moved aside while it runs, and the registry given on its command
 * line), and the pod holds no secret. Every dependency must be a version from the registry: a tarball, a git source,
 * an alias, a `file:` or `link:`, or a range the step cannot read is refused before pnpm runs (`registryRange`), and a
 * lockfile that resolves anything but the registry's packages is refused after (`registryOnly`). A change from the
 * coder to pnpm's settings, or to what in a manifest overrides resolution, is refused too.
 *
 * mise is not run, and not in the image: nothing in this repository pins mise's own version, and `mise lock`'s entry
 * for Node is the version, its download for each platform, and that download's checksum, which the step writes from
 * the same file mise reads. So nothing of the app's `mise.toml` runs here either.
 *
 * The factory's own moves are made by the same step, from its scan and its review gate (scripts/derive.ts), on a
 * checkout of its `main`: a workspace whose projects name each other as `workspace:` and its lockfile as `link:`, which
 * the step takes there alone (`PinTools.workspace`), never from a checkout an agent may have written.
 */
import { execFile } from 'node:child_process';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  digestOf,
  type Get,
  libraryOf,
  nodeInImage,
  PinsRefused,
  releaseAge,
  releasedAt,
  runsNode,
} from '../../factory/src/vulnerabilities/registry.ts';
import { git, gitInput } from './git.ts';

export {
  bringsPins,
  digestOf,
  type Get,
  libraryOf,
  nodeInImage,
  nodeInTar,
  PinsRefused,
  registryOf,
  releaseAge,
  runsNode,
} from '../../factory/src/vulnerabilities/registry.ts';

const exec = promisify(execFile);

/** What moves: as the work item names it (`work-item.opened`'s `dependency`). */
export interface Move {
  ecosystem: 'npm' | 'node' | 'docker' | 'tool';
  name: string;
  from: string;
  to: string;
}

/** The move needs a file only Martin may change: the work item waits for him, told the file and why. */
export class PinsHeld extends Error {
  override name = 'PinsHeld';
  readonly path: string;
  constructor(path: string, reason: string) {
    super(reason);
    this.path = path;
  }
}

/**
 * pnpm runs as itself, and does not switch to the version a checkout names, which it would fetch (`prepare.ts`).
 * The registry is npm's, on the command line, where no setting of the checkout's can override it.
 */
export const OWN_PNPM = { npm_config_manage_package_manager_versions: 'false' };
export const OWN_PNPM_FLAG = '--config.manage-package-manager-versions=false';
export const REGISTRY = 'https://registry.npmjs.org/';
const PINNING = [
  OWN_PNPM_FLAG,
  `--config.registry=${REGISTRY}`,
  '--lockfile-only',
  '--ignore-scripts',
  '--ignore-pnpmfile',
  '--reporter=silent',
];

/** Runs pnpm in a checkout, as the pin step does. Injected so tests need no registry. */
export type Pnpm = (dir: string, args: string[]) => Promise<void>;

/** The files pnpm reads its settings or a resolution's override from, which no coder's patch may change. */
export const PNPM_SETTINGS = ['.npmrc', 'pnpm-workspace.yaml', '.pnpmfile.cjs', '.pnpmfile.mjs', 'patches/'];
/** The lockfiles: written by the pin step, and never by an agent. */
export const LOCKFILES = [
  'pnpm-lock.yaml',
  'pnpm-lock.*.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'mise.lock',
];

/** A manifest's fields that name dependencies, by a range of the registry's. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
/** Those whose ranges pin what is installed, which a move moves. */
const PINNED_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
/** A manifest's fields that change how anything resolves: the coder may not change them. */
const RESOLUTION_FIELDS = [
  'pnpm',
  'overrides',
  'resolutions',
  'dependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
  'workspaces',
  'packageManager',
  'devEngines',
];

/** One comparator of a range the step reads: an operator and a version, which may be partial. */
const COMPARATOR = /^(?:[\^~]|[<>]=?|=)?\d+(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** A workspace's own project, as a manifest names it: `workspace:*`, `workspace:^`, or a range after it. */
const WORKSPACE_SPEC = /^workspace:(?:[*^~]|[\^~]?\d+(?:\.\d+){0,2})$/;

/**
 * Whether a manifest's spec is a range of the registry's versions: comparators, joined by spaces or `||`, or `*`.
 * Never a tarball, a git source, an alias (`npm:`), a `file:`, `link:` or `workspace:`, a URL or a dist-tag; with
 * `workspace`, a project of the checkout's own workspace too (`workspace:*`).
 */
export function registryRange(spec: string, workspace = false): boolean {
  if (spec.trim() === '*') return true;
  if (workspace && WORKSPACE_SPEC.test(spec.trim())) return true;
  return spec.split('||').every(
    (part) =>
      part.trim() !== '' &&
      part
        .trim()
        .split(/\s+/)
        .every((token) => COMPARATOR.test(token)),
  );
}

/**
 * Every dependency a checkout's manifests name with a spec that is not a range of the registry's; with `workspace`, a
 * dependency on a project of the checkout's own workspace is one too, and never an override's.
 */
export function notFromRegistry(manifests: readonly { path: string; json: Manifest }[], workspace = false): string[] {
  const refused: string[] = [];
  for (const { path, json } of manifests) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(json[field] ?? {})) {
        if (typeof spec !== 'string' || !registryRange(spec, workspace))
          refused.push(`${path}: ${name} ${JSON.stringify(spec)}`);
      }
    }
    // An override's value is a spec too: one may name a tarball as well as any dependency can.
    for (const overrides of [json.pnpm?.overrides, json.overrides, json.resolutions]) {
      for (const [name, spec] of Object.entries(overrides ?? {})) {
        if (typeof spec !== 'string' || !registryRange(spec))
          refused.push(`${path}: the override of ${name} ${JSON.stringify(spec)}`);
      }
    }
  }
  return refused;
}

/**
 * The lines of a pnpm lockfile that resolve something other than a package of the registry: a tarball, a git source,
 * a folder, or an importer's `link:` or `file:`. pnpm writes a registry package's resolution as its integrity alone.
 * With `workspace`, an importer's `workspace:` specifier and its `link:` to a relative folder are the workspace's own.
 */
export function registryOnly(lock: string, workspace = false): string[] {
  const own = (line: string) =>
    workspace &&
    (/^\s+specifier: ['"]?workspace:[^\s'"]*['"]?$/.test(line) ||
      /^\s+version: ['"]?link:(?!\/)[\w@./-]+['"]?$/.test(line));
  return lock
    .split('\n')
    .filter(
      (line) =>
        (/\bresolution: \{/.test(line) &&
          (!/\bintegrity: /.test(line) || /\b(tarball|type|repo|directory):/.test(line))) ||
        (/^\s+(version|specifier): ['"]?(link|file|git|git\+[a-z]+|https?|npm|github|workspace):/.test(line) &&
          !own(line)),
    )
    .map((line) => line.trim());
}

export interface Manifest {
  name?: string;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  resolutions?: Record<string, unknown>;
  pnpm?: { overrides?: Record<string, unknown> };
  [field: string]: unknown;
}

/** A checkout's manifests, as git tracks them: the root's, and any below it. */
export async function manifestsOf(dir: string): Promise<{ path: string; json: Manifest }[]> {
  const paths = (await git(dir, 'ls-files', '-z', '--', 'package.json', '**/package.json')).split('\0').filter(Boolean);
  return Promise.all(
    paths.map(async (path) => ({ path, json: JSON.parse(await readFile(join(dir, path), 'utf8')) as Manifest })),
  );
}

/** The versions a pnpm lockfile resolves a package at, from its `packages:` keys. */
export function lockedVersions(lock: string, name: string): string[] {
  const key = new RegExp(`^ {2}'?${escaped(name)}@(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)'?:`, 'gm');
  return [...new Set([...lock.matchAll(key)].map((m) => m[1] as string))].sort(compareVersions);
}

/** The packages whose dependencies resolve `name` at `version`, from a pnpm lockfile's `snapshots:`: its parents. */
export function parentsAt(lock: string, name: string, version: string): string[] {
  const snapshots = lock
    .split(/^snapshots:$/m)
    .slice(1)
    .join('\n');
  const parents = new Set<string>();
  let current = '';
  const dependency = new RegExp(`^ {6}'?${escaped(name)}'?: ${escaped(version)}(\\(|$)`);
  for (const line of snapshots.split('\n')) {
    const key = /^ {2}'?([^\s'][^']*?)'?:\s*(\{\})?$/.exec(line);
    if (key) current = key[1] as string;
    else if (current && dependency.test(line)) parents.add(current);
  }
  return [...parents].sort();
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A version's release and its pre-release, split at its first hyphen, as semver reads it. */
const parts = (version: string): [string, string | undefined] => {
  const at = version.indexOf('-');
  return at < 0 ? [version, undefined] : [version.slice(0, at), version.slice(at + 1)];
};

/**
 * Orders two versions as semver does: by release, then a pre-release before its release, its identifiers compared
 * one by one, a number's as a number and before any word.
 */
export function compareVersions(a: string, b: string): number {
  const [mainA, preA] = parts(a);
  const [mainB, preB] = parts(b);
  const partsA = mainA.split('.').map(Number);
  const partsB = mainB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (d) return d;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  const idsA = preA.split('.');
  const idsB = preB.split('.');
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const x = idsA[i];
    const y = idsB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = /^\d+$/;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (numeric.test(x)) return -1;
    if (numeric.test(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a manifest's range admits a version, for the ranges the step moves: `^`, `~` or an exact version. Any other
 * range is not one the step moves, and says so.
 */
export function admits(spec: string, version: string): boolean {
  const m = /^([\^~]?)(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(spec.trim());
  if (!m) throw new PinsRefused(`The range ${JSON.stringify(spec)} is not one the pin step moves: ^, ~ or a version.`);
  const [, op, ...floor] = m;
  const base = `${floor[0]}.${floor[1]}.${floor[2]}${floor[3] ?? ''}`;
  if (op === '') return compareVersions(version, base) === 0;
  if (compareVersions(version, base) < 0) return false;
  const [major, minor] = version.split('.').map(Number);
  if (op === '~') return major === Number(floor[0]) && minor === Number(floor[1]);
  if (Number(floor[0]) > 0) return major === Number(floor[0]);
  if (Number(floor[1]) > 0) return major === 0 && minor === Number(floor[1]);
  return compareVersions(version, base) === 0;
}

/** The line a caret range keeps a version on: its major, or below 1.0 its minor. */
const lineOf = (version: string) => {
  const [major, minor] = version.split('.');
  return major === '0' ? `0.${minor}` : major;
};

/** The same range, moved to a version: its operator kept, so it never admits a major the version does not need. */
export const movedRange = (spec: string, version: string): string =>
  `${/^[\^~]?/.exec(spec.trim())?.[0] ?? ''}${version}`;

/**
 * Moves a package: each manifest's range that does not admit the target first, then `pnpm update` at every depth,
 * under the app's own policy. A copy the parents' ranges hold below the target holds the work item for an override:
 * the copy the move names, and any on the target's line (its major, or below 1.0 its minor); one on another line is no
 * part of the move.
 */
export async function movePackage(dir: string, move: Move, pnpm: Pnpm): Promise<void> {
  // A package at two versions: each copy to the target on its own line, the older line first.
  const tos = move.to.split(',').map((each) => each.trim());
  const froms = move.from.split(',').map((each) => each.trim());
  if (tos.length > 1 || froms.length > 1) {
    for (const to of [...tos].sort(compareVersions)) {
      if (!VERSION.test(to)) throw new PinsRefused(`${to} is not a version, so ${move.name} cannot move to it.`);
      const from = froms.find((each) => VERSION.test(each) && lineOf(each) === lineOf(to));
      if (!from) throw new PinsRefused(`${move.name} is at no version on the line of ${to}: ${move.from}.`);
      await movePackage(dir, { ...move, from, to }, pnpm);
    }
    return;
  }
  if (!VERSION.test(move.to)) throw new PinsRefused(`${move.to} is not a version, so ${move.name} cannot move to it.`);
  const lockPath = join(dir, 'pnpm-lock.yaml');
  const before = await readFile(lockPath, 'utf8');
  const versions = lockedVersions(before, move.name);
  if (!versions.length) throw new PinsRefused(`The lockfile resolves no ${move.name}.`);
  // A copy on another major that the move does not name has no advisory this move fixes: it stays where it is.
  const itsOwn = (version: string) => version === move.from || lineOf(version) === lineOf(move.to);
  const own = versions.filter(itsOwn);
  // Already made: every copy is at the target or past it, or every copy of the move's own is, and there is one.
  const there = (list: string[]) => list.every((v) => compareVersions(v, move.to) >= 0);
  if (there(versions) || (own.length > 0 && there(own))) return;
  if (!versions.includes(move.from)) {
    throw new PinsRefused(`The lockfile has ${move.name} at ${versions.join(', ')}, not at ${move.from}.`);
  }
  const manifests = await manifestsOf(dir);
  for (const { path, json } of manifests) {
    let moved = false;
    // A peer's range says what the package works with, and pins nothing: it is never moved.
    for (const field of PINNED_FIELDS) {
      const spec = json[field]?.[move.name];
      if (typeof spec !== 'string' || admits(spec, move.to)) continue;
      (json[field] as Record<string, string>)[move.name] = movedRange(spec, move.to);
      moved = true;
    }
    if (moved) await writeJson(join(dir, path), json);
  }
  // Every project of a workspace, when the checkout is one, so a nested project's copy moves too.
  const workspace = /^packages:/m.test(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8').catch(() => ''));
  await pnpm(dir, ['update', ...(workspace ? ['--recursive'] : []), move.name, '--depth', 'Infinity']);
  const after = await readFile(lockPath, 'utf8');
  const below = lockedVersions(after, move.name).filter((v) => itsOwn(v) && compareVersions(v, move.to) < 0);
  if (below.length) {
    const parents = below.flatMap((v) => parentsAt(after, move.name, v));
    throw new PinsHeld(
      'pnpm-workspace.yaml',
      `${move.name} stays at ${below.join(', ')}: ${parents.length ? parents.join(', ') : 'its parents'} admit no ${move.to}, so it needs an override in pnpm-workspace.yaml`,
    );
  }
}

/** Writes a manifest as pnpm does: two spaces, and the newline at the end it had. */
async function writeJson(path: string, json: unknown): Promise<void> {
  const text = await readFile(path, 'utf8');
  await writeFile(path, `${JSON.stringify(json, null, 2)}${text.endsWith('\n') ? '\n' : ''}`);
}

/** The platforms' file names a `SHASUMS256.txt` gives, with each checksum. */
export function shasums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (m) sums.set(m[2] as string, m[1] as string);
  }
  return sums;
}

/**
 * `mise.lock`'s entry for Node, moved: its version, its specifiers where they name the version, and each platform's
 * download and the checksum `SHASUMS256.txt` gives it. Every other entry is as it was.
 */
export function nodeLockMoved(lock: string, from: string, to: string, sums: Map<string, string>): string {
  const entry = /^\[\[tools\.node\]\]\n[\s\S]*?(?=^\[\[|(?![\s\S]))/m.exec(lock);
  if (!entry) throw new PinsRefused('mise.lock has no entry for node.');
  if (!entry[0].includes(`version = "${from}"`)) throw new PinsRefused(`mise.lock's node is not ${from}.`);
  const sections = entry[0].replaceAll(from, to).split(/(?=^\[tools\.node\.)/m);
  const moved = sections.map((section) => {
    if (!section.startsWith('[tools.node.')) return section;
    const url = /^url = "https:\/\/nodejs\.org\/dist\/v[^/"]+\/([^/"]+)"$/m.exec(section);
    const sum = url && sums.get(url[1] as string);
    if (!sum)
      throw new PinsRefused(`Node ${to}'s SHASUMS256.txt has no checksum for ${url?.[1] ?? section.split('\n')[0]}.`);
    if (!/^checksum = "sha256:[0-9a-f]{64}"$/m.test(section))
      throw new PinsRefused(`mise.lock's ${section.split('\n')[0]} has no checksum to move.`);
    return section.replace(/^checksum = "sha256:[0-9a-f]{64}"$/m, `checksum = "sha256:${sum}"`);
  });
  return lock.replace(entry[0], moved.join(''));
}

/** A `FROM` line of a Dockerfile that pins an image by its tag and digest, in parts. */
const FROM =
  /^(\s*FROM\s+(?:--platform=\S+\s+)?)([^\s:@/]+(?::\d+)?(?:\/[^\s:@/]+)*):([\w][\w.-]{0,127})@(sha256:[0-9a-f]{64})(.*)$/i;

/** The Dockerfiles git tracks in a checkout. */
async function dockerfilesOf(dir: string): Promise<string[]> {
  const listed = await git(
    dir,
    'ls-files',
    '-z',
    '--',
    'Dockerfile',
    '**/Dockerfile',
    'Dockerfile.*',
    '**/Dockerfile.*',
    '*.Dockerfile',
    '**/*.Dockerfile',
  );
  return listed.split('\0').filter(Boolean);
}

/**
 * How the step learns the digest a tag of an image has: its registry's answer now (`digestOf`), or, where the step is
 * made again to be compared, the answer the one who made it first had (scripts/derive.ts).
 */
export type DigestOf = (image: string, tag: string) => Promise<string>;

/** The registry's answer now. */
const asRegistry =
  (get: Get): DigestOf =>
  (image, tag) =>
    digestOf(image, tag, get);

/** The key of a tag's answer among those a step was given (`remembering`): `image:tag`. */
export const askedKey = (image: string, tag: string) => `${image}:${tag}`;

/**
 * A tag's digest from `asked` where it holds the tag's answer, and otherwise its registry's now, kept in `asked`: so a
 * step made again with the answers the first was given is given the same, and the first keeps each it was given.
 */
export function remembering(asked: Map<string, string> | undefined, get: Get): DigestOf {
  return async (image, tag) => {
    const known = asked?.get(askedKey(image, tag));
    if (known) return known;
    const answer = await digestOf(image, tag, get);
    asked?.set(askedKey(image, tag), answer);
    return answer;
  };
}

/** One tag of an image a step asked its registry for, and the digest it was given. */
export interface Asked {
  image: string;
  tag: string;
  digest: string;
}

/** The answers `remembering` kept, each as its image, tag and digest, in the order of their keys. */
export const askedList = (asked: Map<string, string>): Asked[] =>
  [...asked]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, digest]) => {
      const at = key.lastIndexOf(':');
      return { image: key.slice(0, at), tag: key.slice(at + 1), digest };
    });

/**
 * How the scan made a move, for the line's pin step to make it so: as of when (`at`, the scan's `judged`, an ISO time),
 * and with the digest the scan's step was given for each tag it asked (its artifact `pins`,
 * apps/factory/src/github/made.ts). The review gate makes the move again from the same (scripts/moves.ts).
 */
export interface MadeAs {
  at: string;
  asked: Asked[];
}

/** pnpm's own release age, in minutes, where its settings name none: a day. */
export const PNPM_RELEASE_AGE = 24 * 60;

/** A checkout's pnpm release age, in minutes: its `pnpm-workspace.yaml`'s `minimumReleaseAge`, or pnpm's own. */
export function pnpmAge(workspace: string): number {
  if (!/^minimumReleaseAge\b/m.test(workspace)) return PNPM_RELEASE_AGE;
  const set = /^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/m.exec(workspace);
  if (!set) throw new PinsRefused("pnpm-workspace.yaml's minimumReleaseAge is not a number of minutes.");
  return Number(set[1]);
}

/**
 * pnpm, made to resolve as of a time: told on its command line, over any setting of the checkout's, to take no
 * release younger than the checkout's own release age at `asOf`, which is that age and the time since. Never less
 * than the checkout's age now, and rounded up to pnpm's minute. The scan and the line's pin step each make a move so,
 * and the review gate makes it again as of the same time (scripts/derive.ts).
 */
export function pnpmAsOf(pnpm: Pnpm, asOf: number, now: () => number = Date.now): Pnpm {
  return async (dir, args) => {
    const workspace = await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf-8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      },
    );
    const minutes = pnpmAge(workspace) + Math.ceil(Math.max(0, now() - asOf) / 60_000);
    await pnpm(dir, [`--config.minimum-release-age=${minutes}`, ...args]);
  };
}

/**
 * Each `FROM` of a checkout's Dockerfiles that `change` gives a new tag, pinned again at that tag's digest (`digest`).
 * `change` gives back the tag a line's image and tag move to, or nothing to leave the line as it is.
 */
async function moveFroms(
  dir: string,
  change: (image: string, tag: string, digest: string) => { tag: string; digest?: string } | undefined,
  digest: DigestOf,
): Promise<number> {
  let moved = 0;
  // Each image's tag is asked of its registry once, so every line that names it is pinned to the same answer.
  const digests = new Map<string, Promise<string>>();
  for (const path of await dockerfilesOf(dir)) {
    const text = await readFile(join(dir, path), 'utf8');
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      const m = FROM.exec(line);
      if (!m) continue;
      const [, start, image = '', tag = '', pinned = '', rest] = m;
      const next = change(image, tag, pinned);
      if (next === undefined) continue;
      const key = `${image}:${next.tag}`;
      if (!digests.has(key)) digests.set(key, next.digest ? Promise.resolve(next.digest) : digest(image, next.tag));
      lines[i] = `${start}${image}:${next.tag}@${await digests.get(key)}${rest}`;
      moved++;
    }
    const written = lines.join('\n');
    if (written !== text) await writeFile(join(dir, path), written);
  }
  return moved;
}

/** The exact Node release `mise.toml` pins, or nothing where it pins none, or a range. */
const pinnedNode = (miseToml: string) => /^node\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m.exec(miseToml)?.[1];

/** The release `mise.lock`'s entry for Node is at, or nothing where it has none. */
const lockedNode = (lock: string) => /^\[\[tools\.node\]\]\nversion = "([^"]+)"$/m.exec(lock)?.[1];

/**
 * What of Node's move to `to` a checkout does not have, in words, or nothing where it has it all: `mise.lock`'s entry
 * at another release, or a `FROM` of a Node image, but `except`'s, that runs another, by the release its tag names or,
 * where its tag names none (distroless's `nonroot`), as the image at its digest does (`nodeInImage`).
 */
async function nodeBehind(dir: string, to: string, get: Get, except?: string): Promise<string | undefined> {
  const locked = lockedNode(await readFile(join(dir, 'mise.lock'), 'utf8'));
  if (locked !== to) return `mise.lock pins node at ${locked ?? 'no release'}, not ${to}.`;
  for (const path of await dockerfilesOf(dir)) {
    for (const line of (await readFile(join(dir, path), 'utf8')).split('\n')) {
      const [, , image = '', tag = '', pinned = ''] = FROM.exec(line) ?? [];
      if (!runsNode(image) || image === except) continue;
      const runs = /\d+\.\d+\.\d+/.exec(tag)?.[0] ?? (await nodeInImage(image, pinned, get));
      if (runs !== to) return `${path}'s ${image}:${tag} runs Node ${runs}, not ${to}.`;
    }
  }
  return undefined;
}

/**
 * Moves Node: `mise.toml`, `mise.lock`, and each `FROM` of a Node image, the build's to the version's own tag and the
 * runtime's, whose tag names no version, to the digest its tag has now; but `except`'s, which a base image's move pins
 * itself (`moveImage`). A checkout whose `mise.toml` pins the target already has the move, and writes nothing, when
 * every other pin is at the target too (`nodeBehind`). One that has part of it, a Dockerfile edited by hand or a revert
 * of part of a move, gets the rest, as the move from `from` writes it; and where the rest still leaves a pin behind (a
 * tag that names a third release), the move is refused, never taken for made.
 */
export async function moveNode(
  dir: string,
  move: Move,
  get: Get,
  now = Date.now(),
  except?: string,
  digest: DigestOf = asRegistry(get),
): Promise<void> {
  if (!VERSION.test(move.from) || !VERSION.test(move.to))
    throw new PinsRefused('Node moves from a version to a version.');
  const miseToml = await readFile(join(dir, 'mise.toml'), 'utf8');
  const pinned = pinnedNode(miseToml) === move.to;
  if (pinned && !(await nodeBehind(dir, move.to, get, except))) return;
  const pin = new RegExp(`^node\\s*=\\s*"${escaped(move.from)}"\\s*$`, 'm');
  if (!pinned && !pin.test(miseToml)) throw new PinsRefused(`mise.toml does not pin node at ${move.from}.`);
  const releases = (await json(get, 'https://nodejs.org/dist/index.json')) as { version: string; date: string }[];
  const release = releases.find((r) => r.version === `v${move.to}`);
  if (!release) throw new PinsRefused(`Node ${move.to} is not a release of nodejs.org's.`);
  const age = releaseAge(miseToml);
  if (now - Date.parse(release.date) < age) {
    throw new PinsRefused(`Node ${move.to} came out on ${release.date}, within mise.toml's minimum_release_age.`);
  }
  const lock = await readFile(join(dir, 'mise.lock'), 'utf8');
  const lockMoved =
    lockedNode(lock) === move.to
      ? undefined
      : nodeLockMoved(
          lock,
          move.from,
          move.to,
          shasums(await text(get, `https://nodejs.org/dist/v${move.to}/SHASUMS256.txt`)),
        );
  if (!pinned)
    await writeFile(
      join(dir, 'mise.toml'),
      miseToml.replace(pin, (line) => line.replace(move.from, move.to)),
    );
  if (lockMoved !== undefined) await writeFile(join(dir, 'mise.lock'), lockMoved);
  await moveFroms(
    dir,
    (image, tag) => {
      if (!runsNode(image) || image === except) return undefined;
      return { tag: tag.includes(move.from) ? tag.replace(move.from, move.to) : tag };
    },
    digest,
  );
  const left = pinned ? await nodeBehind(dir, move.to, get, except) : undefined;
  if (left) throw new PinsRefused(`Node's move to ${move.to} leaves a pin behind: ${left}`);
}

/**
 * Moves a base image: each `FROM` of it at `from` to `to`, a tag and its digest, once its registry agrees (`digest`:
 * made again to be compared, the answer the one who made it first had). `from` is
 * what the image is pinned at now: a tag with its digest, or the tag alone, as the daily scan names a pin
 * (`moves.json`'s `from`), which then moves each `FROM` of the image at that tag, whatever its digest.
 *
 * An image that runs Node brings its Node with it, where `mise.toml` pins one release for every image of Node: when the
 * image at `to` runs another, Node moves to it first (`moveNode`), and the image is pinned at `to`. A Node behind the
 * one pinned is refused: a move goes forward.
 */
export async function moveImage(
  dir: string,
  move: Move,
  get: Get,
  now = Date.now(),
  digest: DigestOf = asRegistry(get),
): Promise<void> {
  const [toTag, toDigest] = move.to.split('@');
  if (!toTag || !toDigest || !DIGEST.test(toDigest))
    throw new PinsRefused(`${move.to} is not a tag with its digest, so ${move.name} cannot move to it.`);
  const registry = await digest(move.name, toTag);
  if (registry !== toDigest) {
    throw new PinsRefused(`${move.name}:${toTag} is ${registry} in its registry, not ${toDigest}.`);
  }
  const pinned = runsNode(move.name)
    ? await readFile(join(dir, 'mise.toml'), 'utf8').then(pinnedNode, () => undefined)
    : undefined;
  if (pinned) {
    const runs = await nodeInImage(move.name, toDigest, get);
    if (compareVersions(runs, pinned) < 0)
      throw new PinsRefused(`${move.name}@${toDigest} runs Node ${runs}, behind the ${pinned} mise.toml pins.`);
    await moveNode(dir, { ecosystem: 'node', name: 'node', from: pinned, to: runs }, get, now, move.name, digest);
  }
  const moved = await moveFroms(
    dir,
    // The digest the registry was just asked for, and agreed was the move's: never a second answer.
    (image, tag, pinned) =>
      image === move.name && (move.from.includes('@') ? `${tag}@${pinned}` : tag) === move.from
        ? { tag: toTag, digest: toDigest }
        : undefined,
    digest,
  );
  if (!moved) throw new PinsRefused(`No FROM pins ${move.name} at ${move.from}.`);
}

/**
 * Moves an image's library to the release its tag names (`v1.65.1-noble` is 1.65.1), the image's other half: every
 * package of it a manifest names, with `pnpm update <package>@<release>`, which moves its range there too and the rest of
 * the library with it, in every project of a workspace. Every copy the lockfile then resolves of any of its packages
 * must be at that release, or the move is refused. A lockfile that resolves none of them has nothing to move, and one
 * whose every copy is at the release has the move already.
 */
export async function moveLibrary(dir: string, image: string, tag: string, pnpm: Pnpm): Promise<void> {
  const library = libraryOf(image);
  if (!library) return;
  const release = /^v?(\d+\.\d+\.\d+)(?![\d.])/.exec(tag)?.[1];
  if (!release) throw new PinsRefused(`${image}:${tag} names no release of its library, ${library.join(', ')}.`);
  const lockPath = join(dir, 'pnpm-lock.yaml');
  const copies = (lock: string) => library.flatMap((name) => lockedVersions(lock, name).map((v) => ({ name, v })));
  const before = copies(await readFile(lockPath, 'utf8').catch(() => ''));
  if (before.every(({ v }) => v === release)) return;
  const named = new Set(
    (await manifestsOf(dir)).flatMap(({ json }) =>
      PINNED_FIELDS.flatMap((field) => library.filter((name) => typeof json[field]?.[name] === 'string')),
    ),
  );
  if (!named.size)
    throw new PinsRefused(`No manifest names ${library.join(', ')}, so ${image}'s library cannot move to ${release}.`);
  const workspace = /^packages:/m.test(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8').catch(() => ''));
  await pnpm(dir, [
    'update',
    ...(workspace ? ['--recursive'] : []),
    ...[...named].sort().map((n) => `${n}@${release}`),
  ]);
  const left = copies(await readFile(lockPath, 'utf8')).filter(({ v }) => v !== release);
  if (left.length)
    throw new PinsRefused(
      `${image}:${tag} is ${release}, and the lockfile keeps ${left.map(({ name, v }) => `${name}@${v}`).join(', ')}.`,
    );
}

/** Runs mise in a checkout, as the factory's scan and review gate do. Injected so tests need no mise. */
export type Mise = (dir: string, args: string[]) => Promise<void>;

/**
 * Moves a tool mise pins: its entry's version in `mise.lock`, then `mise lock <tool>`, which writes that version's
 * download and checksum for each platform the lockfile keeps. Within the range `mise.toml` gives the tool, which is
 * left as it is: a version outside it is refused, as `mise upgrade` would not take it. Not before the release, on the
 * repository mise.lock's aqua backend names, and the newest upload of its downloads (`releasedAt`), are as old as
 * `mise.toml`'s `minimum_release_age`, which mise holds only its own resolution to, never a version written into the
 * lockfile. A lockfile that already pins the target has the move, and nothing is written.
 */
export async function moveTool(
  dir: string,
  move: Move,
  mise: Mise | undefined,
  get: Get,
  now = Date.now(),
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(move.name)) throw new PinsRefused(`${move.name} is not a tool's name in mise.`);
  if (!VERSION.test(move.from) || !VERSION.test(move.to))
    throw new PinsRefused(`A tool moves from a version to a version, not ${move.from} to ${move.to}.`);
  if (!mise) throw new PinsRefused(`The pin step runs no mise here, so ${move.name} cannot move.`);
  const path = join(dir, 'mise.lock');
  const lock = await readFile(path, 'utf8');
  const entry = new RegExp(`^\\[\\[tools\\.${escaped(move.name)}\\]\\]\\nversion = "([^"]+)"\\n`, 'm').exec(lock);
  if (!entry) throw new PinsRefused(`mise.lock has no entry for ${move.name}.`);
  if (entry[1] === move.to) return;
  if (entry[1] !== move.from) throw new PinsRefused(`mise.lock's ${move.name} is ${entry[1]}, not ${move.from}.`);
  const miseToml = await readFile(join(dir, 'mise.toml'), 'utf8');
  const range = new RegExp(`^${escaped(move.name)}\\s*=\\s*"([^"]+)"\\s*$`, 'm').exec(miseToml)?.[1];
  if (range === undefined) throw new PinsRefused(`mise.toml names no ${move.name}.`);
  if (move.to !== range && !move.to.startsWith(`${range}.`))
    throw new PinsRefused(`${move.name} ${move.to} is outside the range mise.toml gives it, ${range}.`);
  const age = releaseAge(miseToml);
  if (age) {
    const next = lock.indexOf('\n[[', entry.index + 1);
    const section = lock.slice(entry.index, next < 0 ? undefined : next);
    const repository = /^backend = "aqua:([\w.-]+\/[\w.-]+)"$/m.exec(section)?.[1];
    if (!repository)
      throw new PinsRefused(`mise.lock names no repository for ${move.name}, so its release has no day.`);
    // As the scan reads a tool's releases (deadlines.ts's `toolReleases`): a published release, not a draft or a
    // prerelease, by its tag with or without its `v`, as old as its downloads (`releasedAt`).
    const releases = await json(get, `https://api.github.com/repos/${repository}/releases?per_page=100`);
    const release = (Array.isArray(releases) ? (releases as Record<string, unknown>[]) : []).find(
      (each) =>
        typeof each.tag_name === 'string' &&
        each.tag_name.replace(/^v/, '') === move.to &&
        each.draft !== true &&
        each.prerelease !== true,
    );
    const published = release && releasedAt(release);
    if (!published) throw new PinsRefused(`${move.name} ${move.to} is not a published release of ${repository}'s.`);
    if (now - Date.parse(published) < age)
      throw new PinsRefused(
        `${move.name} ${move.to} came out on ${published}, within mise.toml's minimum_release_age.`,
      );
  }
  await writeFile(path, lock.replace(entry[0], entry[0].replace(`"${move.from}"`, `"${move.to}"`)));
  await mise(dir, ['lock', move.name]);
}

async function text(get: Get, url: string): Promise<string> {
  const response = await get(url);
  if (!response.ok) throw new PinsRefused(`${url}: ${response.status}`);
  return response.text();
}

const json = async (get: Get, url: string): Promise<unknown> => JSON.parse(await text(get, url));

/** pnpm, as the pin step runs it: the image's own, with the registry, no scripts and no pnpmfile. */
export function pnpmIn(env: NodeJS.ProcessEnv): Pnpm {
  return async (dir, args) => {
    await exec('pnpm', [...PINNING, ...args], {
      cwd: dir,
      env: { ...env, ...OWN_PNPM, CI: 'true' },
      maxBuffer: 64 * 1024 * 1024,
    });
  };
}

/**
 * Runs `work` with the checkout's own `.npmrc` moved aside into the prepare pod's folder, and puts it back however
 * `work` ends, so pnpm reads none of its settings and the step's patch shows none of it moved.
 */
async function withoutNpmrc<T>(dir: string, aside: string, work: () => Promise<T>): Promise<T> {
  const npmrc = join(dir, '.npmrc');
  // Copied, not renamed: the checkout and the pod's own folder are volumes of their own.
  const moved = await copyFile(npmrc, aside).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (moved) await rm(npmrc);
  try {
    return await work();
  } finally {
    if (moved) {
      await copyFile(aside, npmrc);
      await rm(aside);
    }
  }
}

/** What the step needs to run: pnpm, a way to the registries, and a folder of its own for what it moves aside. */
export interface PinTools {
  pnpm: Pnpm;
  get: Get;
  /** The prepare pod's own folder, which the agent never sees. */
  aside: string;
  now?: number;
  /** mise, for a tool's move: given by the factory's scan and review gate alone. */
  mise?: Mise;
  /** How a tag's digest is learnt: its registry's answer now when not given (scripts/derive.ts gives another). */
  digestOf?: DigestOf;
  /**
   * Whether the checkout's own workspace projects may be named (`workspace:`, and `link:` in the lockfile): the
   * factory's `main`, which its scan and review gate check out, and never a checkout an agent may have written.
   */
  workspace?: boolean;
}

/**
 * Writes every pin of a move in the checkout, as a change not yet committed. Refuses a checkout whose manifests name
 * anything but the registry's versions, before pnpm runs, and a lockfile after it that resolves anything else.
 */
export async function writePins(dir: string, move: Move, tools: PinTools): Promise<void> {
  const digest = tools.digestOf ?? asRegistry(tools.get);
  if (move.ecosystem === 'node') return moveNode(dir, move, tools.get, tools.now, undefined, digest);
  if (move.ecosystem === 'tool') return moveTool(dir, move, tools.mise, tools.get, tools.now);
  const workspace = tools.workspace ?? false;
  const withPnpm = async (work: () => Promise<void>) => {
    await refuseUnlessRegistry(dir, workspace);
    await withoutNpmrc(dir, join(tools.aside, 'checkout.npmrc'), work);
    await refuseUnlessRegistryLock(dir, workspace);
  };
  if (move.ecosystem === 'docker') {
    await moveImage(dir, move, tools.get, tools.now, digest);
    // An image one release with a library brings it: the lockfile's copies, to the release its tag names.
    if (libraryOf(move.name)) {
      const tag = move.to.split('@')[0] ?? '';
      await withPnpm(() => moveLibrary(dir, move.name, tag, tools.pnpm));
    }
    return;
  }
  await withPnpm(() => movePackage(dir, move, tools.pnpm));
}

async function refuseUnlessRegistry(dir: string, workspace = false): Promise<void> {
  const refused = notFromRegistry(await manifestsOf(dir), workspace);
  if (refused.length)
    throw new PinsRefused(`Only versions from the registry are pinned, and the manifests name ${refused.join('; ')}.`);
}

async function refuseUnlessRegistryLock(dir: string, workspace = false): Promise<void> {
  const lines = registryOnly(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8'), workspace);
  if (lines.length)
    throw new PinsRefused(`The lockfile resolves something not from the registry: ${lines.slice(0, 5).join('; ')}.`);
}

/** Whether a path is one of `entries`: a file at any depth by its name, or under a folder ending in `/`. */
const among = (path: string, entries: readonly string[]) =>
  entries.some((entry) => {
    if (entry.endsWith('/')) return path.startsWith(entry) || path.includes(`/${entry}`);
    // A `*` in a name is any characters but a slash: `pnpm-lock.*.yaml`, pnpm's lockfile for a branch.
    const name = new RegExp(`(^|/)${entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`);
    return name.test(path);
  });

/** The files a unified diff changes, by its `diff --git` headers. */
export const changedIn = (patch: string): string[] =>
  [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].flatMap(([, a = '', b = '']) => (a === b ? [a] : [a, b]));

/** Whether a patch changes a manifest, so the pin step writes the lockfile after it. */
export const changesManifest = (patch: string): boolean =>
  changedIn(patch).some((path) => path === 'package.json' || path.endsWith('/package.json'));

/**
 * Writes the lockfile for the manifests a coder's patch changed, on a checkout that has the patch applied on the
 * pins, as a change not yet committed. Refuses a patch that changes a lockfile or pnpm's settings, or what in a
 * manifest overrides resolution, and a manifest that names anything but the registry's versions.
 */
export async function writeLockfile(dir: string, change: string, tools: PinTools): Promise<void> {
  const touched = changedIn(change).filter((path) => among(path, [...LOCKFILES, ...PNPM_SETTINGS]));
  if (touched.length)
    throw new PinsRefused(`The change writes ${touched.join(', ')}, which only the pin step writes, or no step does.`);
  const before = await manifestsOf(dir);
  // Into the index too, so a manifest the change adds is one `manifestsOf` reads and refuses as any other, and the
  // files it changed are git's to say, whatever its headers look like.
  // The checkout's files were given the seed's time (`prepare.ts`): the index learns it first, or git takes them for changed.
  await git(dir, 'update-index', '-q', '--refresh').catch(() => {});
  await gitInput(change, dir, 'apply', '--index', '--whitespace=nowarn', '-');
  const applied = (await git(dir, 'diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD'))
    .split('\0')
    .filter((path) => path && among(path, [...LOCKFILES, ...PNPM_SETTINGS]));
  if (applied.length)
    throw new PinsRefused(`The change writes ${applied.join(', ')}, which only the pin step writes, or no step does.`);
  const after = await manifestsOf(dir);
  for (const { path, json } of after) {
    const was = before.find((m) => m.path === path)?.json ?? {};
    const changed = RESOLUTION_FIELDS.filter((field) => JSON.stringify(was[field]) !== JSON.stringify(json[field]));
    if (changed.length)
      throw new PinsRefused(`The change moves ${changed.join(', ')} in ${path}, which overrides how pnpm resolves.`);
  }
  await refuseUnlessRegistry(dir);
  await withoutNpmrc(dir, join(tools.aside, 'checkout.npmrc'), () => tools.pnpm(dir, ['install']));
  await refuseUnlessRegistryLock(dir);
}
