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
 *     work item waits for him (`PinsHeld`).
 *   - Node (`node`): `mise.toml`'s version, `mise.lock`'s entry, with the checksum of each platform's download from
 *     Node's own `SHASUMS256.txt`, and each `FROM` of a Node image, its tag moved where it names the version and its
 *     digest the registry's for that tag. Not before the release is as old as `mise.toml`'s `minimum_release_age`.
 *   - a base image (`docker`): each `FROM` of the image at the move's `from`, given its `to`, once the registry says
 *     the tag is that digest.
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
 */
import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { git, gitInput } from './git.ts';

const exec = promisify(execFile);

/** What moves: as the work item names it (`work-item.opened`'s `dependency`). */
export interface Move {
  ecosystem: 'npm' | 'node' | 'docker';
  name: string;
  from: string;
  to: string;
}

/** The step will not write this move, and says why: the work item fails its step, as any other failure. */
export class PinsRefused extends Error {
  override name = 'PinsRefused';
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
export const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'mise.lock'];

/** A manifest's fields that name dependencies, by a range of the registry's. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
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

/**
 * Whether a manifest's spec is a range of the registry's versions: comparators, joined by spaces or `||`, or `*`.
 * Never a tarball, a git source, an alias (`npm:`), a `file:`, `link:` or `workspace:`, a URL or a dist-tag.
 */
export function registryRange(spec: string): boolean {
  if (spec.trim() === '*') return true;
  return spec.split('||').every(
    (part) =>
      part.trim() !== '' &&
      part
        .trim()
        .split(/\s+/)
        .every((token) => COMPARATOR.test(token)),
  );
}

/** Every dependency a checkout's manifests name with a spec that is not a range of the registry's. */
export function notFromRegistry(manifests: readonly { path: string; json: Manifest }[]): string[] {
  const refused: string[] = [];
  for (const { path, json } of manifests) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(json[field] ?? {})) {
        if (typeof spec !== 'string' || !registryRange(spec)) refused.push(`${path}: ${name} ${JSON.stringify(spec)}`);
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
 */
export function registryOnly(lock: string): string[] {
  return lock
    .split('\n')
    .filter(
      (line) =>
        (/\bresolution: \{/.test(line) &&
          (!/\bintegrity: /.test(line) || /\b(tarball|type|repo|directory):/.test(line))) ||
        /^\s+(version|specifier): ['"]?(link|file|git|git\+[a-z]+|https?|npm|github|workspace):/.test(line),
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

/** Orders two versions as semver does, a pre-release before its release. */
export function compareVersions(a: string, b: string): number {
  const [mainA = '', preA] = a.split('-', 2);
  const [mainB = '', preB] = b.split('-', 2);
  const partsA = mainA.split('.').map(Number);
  const partsB = mainB.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (d) return d;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
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

/** The same range, moved to a version: its operator kept, so it never admits a major the version does not need. */
export const movedRange = (spec: string, version: string): string =>
  `${/^[\^~]?/.exec(spec.trim())?.[0] ?? ''}${version}`;

/**
 * Moves a package: each manifest's range that does not admit the target first, then `pnpm update` at every depth,
 * under the app's own policy. A copy the parents' ranges hold below the target holds the work item for an override.
 */
export async function movePackage(dir: string, move: Move, pnpm: Pnpm): Promise<void> {
  if (!VERSION.test(move.to)) throw new PinsRefused(`${move.to} is not a version, so ${move.name} cannot move to it.`);
  const lockPath = join(dir, 'pnpm-lock.yaml');
  const before = await readFile(lockPath, 'utf8');
  const versions = lockedVersions(before, move.name);
  if (!versions.length) throw new PinsRefused(`The lockfile resolves no ${move.name}.`);
  if (versions.every((v) => compareVersions(v, move.to) >= 0)) return;
  if (!versions.includes(move.from)) {
    throw new PinsRefused(`The lockfile has ${move.name} at ${versions.join(', ')}, not at ${move.from}.`);
  }
  const manifests = await manifestsOf(dir);
  for (const { path, json } of manifests) {
    let moved = false;
    for (const field of DEPENDENCY_FIELDS) {
      const spec = json[field]?.[move.name];
      if (typeof spec !== 'string' || admits(spec, move.to)) continue;
      (json[field] as Record<string, string>)[move.name] = movedRange(spec, move.to);
      moved = true;
    }
    if (moved) await writeJson(join(dir, path), json);
  }
  await pnpm(dir, ['update', move.name, '--depth', 'Infinity']);
  const after = await readFile(lockPath, 'utf8');
  const below = lockedVersions(after, move.name).filter((v) => compareVersions(v, move.to) < 0);
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

/** How the step reaches a registry: `fetch`, or a test's. */
export type Get = (url: string, init?: RequestInit) => Promise<Response>;

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

/** `mise.toml`'s `minimum_release_age`, in milliseconds: none when it sets none. */
export function releaseAge(miseToml: string): number {
  const m = /^minimum_release_age\s*=\s*"(\d+)([dhm])"\s*$/m.exec(miseToml);
  if (!m) return 0;
  return Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as 'd' | 'h' | 'm'];
}

/** A `FROM` line of a Dockerfile that pins an image by its tag and digest, in parts. */
const FROM =
  /^(\s*FROM\s+(?:--platform=\S+\s+)?)([^\s:@]+(?::\d+)?(?:\/[^\s:@]+)*):([\w][\w.-]{0,127})@(sha256:[0-9a-f]{64})(.*)$/i;

/** The Dockerfiles git tracks in a checkout. */
async function dockerfilesOf(dir: string): Promise<string[]> {
  const listed = await git(
    dir,
    'ls-files',
    '-z',
    '--',
    'Dockerfile',
    '**/Dockerfile',
    '*.Dockerfile',
    '**/*.Dockerfile',
  );
  return listed.split('\0').filter(Boolean);
}

/**
 * Each `FROM` of a checkout's Dockerfiles that `change` gives a new tag, pinned again at that tag's digest from its
 * registry. `change` gives back the tag a line's image and tag move to, or nothing to leave the line as it is.
 */
async function moveFroms(
  dir: string,
  change: (image: string, tag: string, digest: string) => string | undefined,
  get: Get,
): Promise<number> {
  let moved = 0;
  for (const path of await dockerfilesOf(dir)) {
    const text = await readFile(join(dir, path), 'utf8');
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      const m = FROM.exec(line);
      if (!m) continue;
      const [, start, image = '', tag = '', digest = '', rest] = m;
      const next = change(image, tag, digest);
      if (next === undefined) continue;
      lines[i] = `${start}${image}:${next}@${await digestOf(image, next, get)}${rest}`;
      moved++;
    }
    const written = lines.join('\n');
    if (written !== text) await writeFile(join(dir, path), written);
  }
  return moved;
}

/**
 * Moves Node: `mise.toml`, `mise.lock`, and each `FROM` of a Node image, the build's to the version's own tag and the
 * runtime's, whose tag names no version, to the digest its tag has now.
 */
export async function moveNode(dir: string, move: Move, get: Get, now = Date.now()): Promise<void> {
  if (!VERSION.test(move.from) || !VERSION.test(move.to))
    throw new PinsRefused('Node moves from a version to a version.');
  const miseToml = await readFile(join(dir, 'mise.toml'), 'utf8');
  const pin = new RegExp(`^node\\s*=\\s*"${escaped(move.from)}"\\s*$`, 'm');
  if (!pin.test(miseToml)) throw new PinsRefused(`mise.toml does not pin node at ${move.from}.`);
  const releases = (await json(get, 'https://nodejs.org/dist/index.json')) as { version: string; date: string }[];
  const release = releases.find((r) => r.version === `v${move.to}`);
  if (!release) throw new PinsRefused(`Node ${move.to} is not a release of nodejs.org's.`);
  const age = releaseAge(miseToml);
  if (now - Date.parse(release.date) < age) {
    throw new PinsRefused(`Node ${move.to} came out on ${release.date}, within mise.toml's minimum_release_age.`);
  }
  const sums = shasums(await text(get, `https://nodejs.org/dist/v${move.to}/SHASUMS256.txt`));
  await writeFile(
    join(dir, 'mise.toml'),
    miseToml.replace(pin, (line) => line.replace(move.from, move.to)),
  );
  const lock = await readFile(join(dir, 'mise.lock'), 'utf8');
  await writeFile(join(dir, 'mise.lock'), nodeLockMoved(lock, move.from, move.to, sums));
  await moveFroms(
    dir,
    (image, tag) => {
      if (!/^node/.test(image.split('/').at(-1) ?? '')) return undefined;
      return tag.includes(move.from) ? tag.replace(move.from, move.to) : tag;
    },
    get,
  );
}

/** Moves a base image: each `FROM` of it at `from` to `to`, a tag and its digest, once its registry agrees. */
export async function moveImage(dir: string, move: Move, get: Get): Promise<void> {
  const [toTag, toDigest] = move.to.split('@');
  if (!toTag || !toDigest || !DIGEST.test(toDigest))
    throw new PinsRefused(`${move.to} is not a tag with its digest, so ${move.name} cannot move to it.`);
  const registry = await digestOf(move.name, toTag, get);
  if (registry !== toDigest) {
    throw new PinsRefused(`${move.name}:${toTag} is ${registry} in its registry, not ${toDigest}.`);
  }
  const moved = await moveFroms(
    dir,
    (image, tag, digest) => (image === move.name && `${tag}@${digest}` === move.from ? toTag : undefined),
    get,
  );
  if (!moved) throw new PinsRefused(`No FROM pins ${move.name} at ${move.from}.`);
}

const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** An image's registry and repository there: Docker Hub's, by its own names, when the first part names no host. */
export function registryOf(image: string): { host: string; repository: string } {
  const [first = '', ...rest] = image.split('/');
  if (rest.length && (first.includes('.') || first.includes(':') || first === 'localhost'))
    return { host: first, repository: rest.join('/') };
  return { host: 'registry-1.docker.io', repository: rest.length ? image : `library/${image}` };
}

/**
 * The digest a tag of an image has in its registry now, as the registry's API gives it, asking for a token where the
 * registry asks for one, as an anonymous reader. A digest that is not a SHA-256's is refused.
 */
export async function digestOf(image: string, tag: string, get: Get): Promise<string> {
  const { host, repository } = registryOf(image);
  const url = `https://${host}/v2/${repository}/manifests/${tag}`;
  const headers: Record<string, string> = { accept: MANIFESTS };
  let response = await get(url, { method: 'HEAD', headers });
  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate') ?? '';
    const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!/^Bearer /i.test(challenge) || !fields.realm?.startsWith('https://'))
      throw new PinsRefused(`${host} asks for a sign-in the pin step does not make.`);
    const query = new URLSearchParams({
      ...(fields.service ? { service: fields.service } : {}),
      scope: `repository:${repository}:pull`,
    });
    const answer = (await json(get, `${fields.realm}?${query}`)) as { token?: string; access_token?: string };
    headers.authorization = `Bearer ${answer.token ?? answer.access_token ?? ''}`;
    response = await get(url, { method: 'HEAD', headers });
  }
  if (!response.ok) throw new PinsRefused(`${image}:${tag} is not in its registry (${response.status}).`);
  const digest = response.headers.get('docker-content-digest') ?? '';
  if (!DIGEST.test(digest)) throw new PinsRefused(`${image}:${tag}'s registry gives no SHA-256 digest.`);
  return digest;
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
  const moved = await rename(npmrc, aside).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  try {
    return await work();
  } finally {
    if (moved) await rename(aside, npmrc);
  }
}

/** What the step needs to run: pnpm, a way to the registries, and a folder of its own for what it moves aside. */
export interface PinTools {
  pnpm: Pnpm;
  get: Get;
  /** The prepare pod's own folder, which the agent never sees. */
  aside: string;
  now?: number;
}

/**
 * Writes every pin of a move in the checkout, as a change not yet committed. Refuses a checkout whose manifests name
 * anything but the registry's versions, before pnpm runs, and a lockfile after it that resolves anything else.
 */
export async function writePins(dir: string, move: Move, tools: PinTools): Promise<void> {
  if (move.ecosystem === 'node') return moveNode(dir, move, tools.get, tools.now);
  if (move.ecosystem === 'docker') return moveImage(dir, move, tools.get);
  await refuseUnlessRegistry(dir);
  await withoutNpmrc(dir, join(tools.aside, 'checkout.npmrc'), () => movePackage(dir, move, tools.pnpm));
  await refuseUnlessRegistryLock(dir);
}

async function refuseUnlessRegistry(dir: string): Promise<void> {
  const refused = notFromRegistry(await manifestsOf(dir));
  if (refused.length)
    throw new PinsRefused(`Only versions from the registry are pinned, and the manifests name ${refused.join('; ')}.`);
}

async function refuseUnlessRegistryLock(dir: string): Promise<void> {
  const lines = registryOnly(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8'));
  if (lines.length)
    throw new PinsRefused(`The lockfile resolves something not from the registry: ${lines.slice(0, 5).join('; ')}.`);
}

/** Whether a path is one of `entries`: a file at any depth by its name, or under a folder ending in `/`. */
const among = (path: string, entries: readonly string[]) =>
  entries.some((entry) =>
    entry.endsWith('/')
      ? path.startsWith(entry) || path.includes(`/${entry}`)
      : path === entry || path.endsWith(`/${entry}`),
  );

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
  await gitInput(change, dir, 'apply', '--whitespace=nowarn', '-');
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
