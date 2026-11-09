/**
 * The dependency graph's snapshot (`dependency-graph.yml`): every package each lockfile on the scanned repository's
 * list resolves, indirect ones included, for GitHub's dependency submission API, so the graph and Dependabot's alerts
 * hold what the lockfile holds and not only what a manifest names.
 *
 *     node apps/factory/src/vulnerabilities/graph.ts <checkout> --syft-pin <Dockerfile> --out <dir> \
 *       --sha <commit> --ref <ref> --run <id> [--prove]
 *
 * Each lockfile alone is copied, at its path, into an empty directory, which Syft's image (by digest, from its one pin)
 * reads, read-only and with no network, for its `github-json` snapshot. Syft names every package, but marks every one
 * direct and at runtime, and gives as a package's dependencies the packages that depend on it, so this sets each
 * package's relationship, scope and dependencies from the lockfile: direct when an importer names it, at runtime when an
 * importer's dependencies or optional dependencies reach it, development when only development dependencies do, and
 * depending on what its entry in the lockfile's snapshots names. It writes `<dir>/snapshot.json`, with the commit, the
 * ref and a correlator naming the workflow, so the next snapshot replaces it; the workflow submits it.
 *
 * With `--prove` it submits nothing and installs each lockfile as the scan's coverage does (`coverage.ts`), and fails
 * unless every package `pnpm list --depth Infinity` names is in the snapshot, each direct or indirect as pnpm lists it.
 *
 * The checkout is data: nothing in it runs, but for the proof's install, which runs no script of the checkout's.
 */
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type Listed, listed, missing, pnpmIn } from './coverage.ts';
import { lockfiles as listedLockfiles } from './inventory.ts';

const run = promisify(execFile);

/** The snapshot's correlator: the workflow's, so each submission replaces the one before it. */
export const CORRELATOR = 'dependency-graph.yml';

/** The Syft image a Dockerfile pins by version and digest, and its version. */
export function syftPin(dockerfile: string) {
  return /^FROM (ghcr\.io\/anchore\/syft:v(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64})$/m.exec(dockerfile);
}

type Deps = Record<string, string | { version?: string }>;
interface Lockfile {
  lockfileVersion?: string | number;
  importers?: Record<
    string,
    {
      dependencies?: Deps;
      devDependencies?: Deps;
      optionalDependencies?: Deps;
      configDependencies?: Deps;
      packageManagerDependencies?: Deps;
    }
  >;
  snapshots?: Record<string, { dependencies?: Deps; optionalDependencies?: Deps } | null>;
}

/** A package's id, `name@version`, with no peers: a key of the lockfile's snapshots, or a dependency's name and value. */
export function packageId(name: string, value: string) {
  const version = value.replace(/\(.*$/, '');
  if (/^(link|file|workspace|portal):/.test(version)) return undefined;
  // An alias names the package it stands for: `string-width-cjs: string-width@4.2.3`.
  const alias = /^(@?[^@]+)@(.+)$/.exec(version);
  return alias ? `${alias[1]}@${alias[2]}` : `${name}@${version}`;
}

/** The id of a snapshot's key, `@scope/name@1.2.3(peer@4)`. */
function keyId(key: string) {
  const bare = key.replace(/\(.*$/, '');
  const at = bare.lastIndexOf('@');
  return at > 0 ? packageId(bare.slice(0, at), bare.slice(at + 1)) : undefined;
}

const versionOf = (value: string | { version?: string }) => (typeof value === 'string' ? value : (value.version ?? ''));

/**
 * Which packages of a pnpm lockfile (version 9) an importer names, and which its runtime dependencies reach. pnpm 11 and
 * later write two documents: the first resolves pnpm itself and its configuration's dependencies (development, as
 * tools are), the second the project's.
 */
export function relationships(documents: Lockfile[]) {
  if (!documents.length || !documents.every((doc) => /^9\./.test(String(doc.lockfileVersion ?? '')))) return undefined;
  const edges = new Map<string, string[]>();
  for (const [key, entry] of documents.flatMap((doc) => Object.entries(doc.snapshots ?? {}))) {
    const id = keyId(key);
    if (!id) continue;
    const to = Object.entries({ ...entry?.dependencies, ...entry?.optionalDependencies })
      .map(([name, value]) => packageId(name, versionOf(value)))
      .filter((dep): dep is string => dep !== undefined);
    edges.set(id, [...(edges.get(id) ?? []), ...to]);
  }
  const ids = (deps: Deps | undefined) =>
    Object.entries(deps ?? {})
      .map(([name, value]) => packageId(name, versionOf(value)))
      .filter((id): id is string => id !== undefined);
  const importers = documents.flatMap((doc) => Object.values(doc.importers ?? {}));
  const runtimeRoots = importers.flatMap((importer) => [
    ...ids(importer.dependencies),
    ...ids(importer.optionalDependencies),
  ]);
  const direct = new Set([
    ...runtimeRoots,
    ...importers.flatMap((importer) => [
      ...ids(importer.devDependencies),
      ...ids(importer.configDependencies),
      ...ids(importer.packageManagerDependencies),
    ]),
  ]);
  const runtime = new Set<string>();
  const queue = [...runtimeRoots];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (runtime.has(id)) continue;
    runtime.add(id);
    queue.push(...(edges.get(id) ?? []));
  }
  return { direct, runtime, edges, known: new Set([...direct, ...edges.keys()]) };
}

/** `name@version` of an npm package URL, or undefined. */
export function fromPurl(purl: string) {
  const match = /^pkg:npm\/(.+)@([^@?#]+)(?:[?#].*)?$/.exec(purl);
  return match?.[1] && match[2] ? `${decodeURIComponent(match[1])}@${decodeURIComponent(match[2])}` : undefined;
}

interface Resolved {
  package_url?: string;
  relationship?: string;
  scope?: string;
  dependencies?: string[];
}
interface Manifest {
  name?: string;
  file?: { source_location?: string };
  metadata?: unknown;
  resolved?: Record<string, Resolved>;
}
export interface Snapshot {
  version: number;
  sha?: string | null;
  ref?: string | null;
  job?: { correlator?: string; id?: string };
  detector?: { name: string; url: string; version: string };
  scanned?: string;
  manifests?: Record<string, Manifest>;
}

/**
 * Syft's snapshot of lockfiles copied at their paths under `/src`, made the one to submit: each manifest named by its
 * lockfile's path in the repository, each package's relationship, scope and dependencies the lockfile's. Throws when a lockfile has
 * no manifest, a manifest names no package, or the lockfile cannot be read.
 */
export function snapshot(
  syft: Snapshot,
  lockfiles: Record<string, Lockfile[]>,
  job: { sha: string; ref: string; run: string },
): Snapshot {
  const manifests: Record<string, Manifest> = {};
  const byPath = new Map(
    Object.entries(syft.manifests ?? {}).map(([key, manifest]) => [
      (manifest.file?.source_location ?? key).replace(/^\/src\//, ''),
      manifest,
    ]),
  );
  for (const [file, lockfile] of Object.entries(lockfiles)) {
    const manifest = byPath.get(file);
    const resolvedByName = Object.entries(manifest?.resolved ?? {});
    if (!manifest || !resolvedByName.length) throw new Error(`Syft names no package in ${file}.`);
    const known = relationships(lockfile);
    if (!known)
      throw new Error(
        `${file} is not a pnpm lockfile of version 9 (${lockfile.map((doc) => String(doc.lockfileVersion)).join(', ')}).`,
      );
    // Every package the lockfile resolves is in the snapshot, or Syft did not read the whole lockfile: a registry's
    // version exactly, any other (a tarball's or a git repository's) by name, as Syft may write its version another way.
    const named = new Set(resolvedByName.map(([key, entry]) => fromPurl(entry.package_url ?? key)));
    const namedNames = new Set([...named].map((id) => id?.slice(0, id.lastIndexOf('@'))));
    const unread = [...known.known].filter((id) => {
      const at = id.lastIndexOf('@');
      return /^\d+\.\d+\.\d+/.test(id.slice(at + 1)) ? !named.has(id) : !namedNames.has(id.slice(0, at));
    });
    if (unread.length) throw new Error(`Syft did not read all of ${file}: ${unread.slice(0, 10).join(', ')}`);
    const names = (set: Set<string>) => new Set([...set].map((id) => id.slice(0, id.lastIndexOf('@'))));
    const directNames = names(known.direct);
    const runtimeNames = names(known.runtime);
    // Each package's key in the manifest, by its id, for its dependents' lists.
    const keys = new Map<string, string>();
    for (const [key, entry] of resolvedByName) {
      const id = fromPurl(entry.package_url ?? key);
      if (id) keys.set(id, key);
    }
    const resolved: Record<string, Resolved> = {};
    for (const [key, entry] of resolvedByName) {
      const id = fromPurl(entry.package_url ?? key);
      const name = id?.slice(0, id.lastIndexOf('@'));
      // A version that is not a registry's (a tarball's or a git repository's URL) is matched by name alone, as Syft may
      // write it another way; a registry's version is matched exactly, so one version's place is never another's.
      const exact = id !== undefined && known.known.has(id);
      const byName = !exact && name !== undefined && !/^\d+\.\d+\.\d+/.test(id?.slice(name.length + 1) ?? '');
      const direct = exact ? known.direct.has(id) : byName && directNames.has(name);
      const runtime = exact ? known.runtime.has(id) : byName && runtimeNames.has(name);
      const dependencies = [
        ...new Set(
          (exact ? (known.edges.get(id) ?? []) : [])
            .map((dep) => keys.get(dep))
            .filter((dep): dep is string => dep !== undefined),
        ),
      ];
      const { dependencies: _dependents, ...rest } = entry;
      resolved[key] = {
        ...rest,
        relationship: direct ? 'direct' : 'indirect',
        scope: runtime ? 'runtime' : 'development',
        ...(dependencies.length ? { dependencies } : {}),
      };
    }
    manifests[file] = {
      name: file,
      file: { source_location: file },
      ...(manifest.metadata ? { metadata: manifest.metadata } : {}),
      resolved,
    };
  }
  return {
    version: 0,
    sha: job.sha,
    ref: job.ref,
    job: { correlator: CORRELATOR, id: job.run },
    ...(syft.detector ? { detector: syft.detector } : {}),
    scanned: syft.scanned ?? new Date().toISOString(),
    manifests,
  };
}

/** pnpm's top-level packages of each project, as `name@version`: what it lists as direct. */
export function listedDirect(projects: (Listed & { name?: string })[]) {
  const own = new Set(projects.map((project) => project.name));
  const found = new Set<string>();
  for (const project of projects)
    for (const deps of [project.dependencies, project.devDependencies, project.optionalDependencies])
      for (const [alias, entry] of Object.entries(deps ?? {})) {
        const name = entry.from ?? alias;
        const version = (entry.version ?? '').replace(/\(.*$/, '');
        if (!own.has(name) && !/^(link|file|workspace|portal):/.test(version)) found.add(`${name}@${version}`);
      }
  return found;
}

/**
 * What the proof finds wrong with one manifest against `pnpm list`: packages it lists that the manifest lacks, and
 * packages the manifest calls direct or indirect where pnpm lists them the other way. Empty when it holds.
 */
export function compare(manifest: Manifest, projects: (Listed & { name?: string })[]) {
  const all = listed(projects);
  const direct = listedDirect(projects);
  const named = new Map<string, Resolved>();
  for (const [key, entry] of Object.entries(manifest.resolved ?? {})) {
    const id = fromPurl(entry.package_url ?? key);
    if (id) named.set(id, entry);
  }
  const absent = missing(all, new Set(named.keys()));
  const misplaced = [...all].filter((id) => {
    const entry = named.get(id);
    return entry && entry.relationship !== (direct.has(id) ? 'direct' : 'indirect');
  });
  const indirect = [...all].filter((id) => !direct.has(id) && named.get(id)?.relationship === 'indirect');
  return { all, direct, named, absent, misplaced, indirect };
}

export async function main(args: string[]): Promise<number> {
  const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const valued = /^--(syft-pin|out|sha|ref|run)$/;
  const [root] = args.filter((arg, i) => !arg.startsWith('--') && !valued.test(args[i - 1] ?? ''));
  const pinFile = option('--syft-pin');
  const out = option('--out');
  const sha = option('--sha');
  const ref = option('--ref');
  const runId = option('--run');
  const syft = pinFile ? syftPin(readFileSync(pinFile, 'utf-8'))?.[1] : undefined;
  if (!root || !syft || !out || !sha || !ref || !runId) {
    console.error(
      'Usage: graph.ts <checkout> --syft-pin <Dockerfile> --out <dir> --sha <commit> --ref <ref> --run <id> [--prove]',
    );
    return 2;
  }
  const checkout = resolve(root);
  const files = listedLockfiles(checkout);
  if (!files.length) {
    console.error('::error::The list names no lockfile.');
    return 1;
  }
  mkdirSync(resolve(out), { recursive: true });
  const work = mkdtempSync(join(resolve(out), 'graph-'));
  // Each lockfile alone, at its path, in a directory with nothing else in it.
  const alone = join(work, 'lockfiles');
  for (const file of files) {
    mkdirSync(dirname(join(alone, file)), { recursive: true });
    cpSync(join(checkout, file), join(alone, file));
  }
  let made: Snapshot;
  try {
    const { stdout } = await run(
      'docker',
      [
        'run',
        '--rm',
        '--read-only',
        '--tmpfs',
        '/tmp',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '-e',
        'SYFT_CHECK_FOR_APP_UPDATE=false',
        '-v',
        `${alone}:/src:ro`,
        syft,
        'scan',
        '--quiet',
        'dir:/src',
        '--output',
        'github-json',
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    const lockfiles = Object.fromEntries(
      files
        .map((file) => [
          file,
          JSON.parse(
            execFileSync('yq', ['eval-all', '--output-format=json', '--indent=0', '[.]', join(alone, file)], {
              encoding: 'utf-8',
              maxBuffer: 256 * 1024 * 1024,
            }),
          ) as (Lockfile | null)[],
        ])
        .map(([file, docs]) => [file, (docs as (Lockfile | null)[]).filter((doc): doc is Lockfile => doc !== null)]),
    );
    made = snapshot(JSON.parse(stdout) as Snapshot, lockfiles, { sha, ref, run: runId });
  } catch (error) {
    const message = String((error as { stderr?: string }).stderr || (error as Error).message)
      .trim()
      .split('\n')
      .slice(-3)
      .join(' ');
    console.error(`::error::No snapshot of the lockfiles: ${message}`);
    return 1;
  }
  writeFileSync(join(resolve(out), 'snapshot.json'), JSON.stringify(made));
  for (const [file, manifest] of Object.entries(made.manifests ?? {})) {
    const entries = Object.values(manifest.resolved ?? {});
    const count = (relationship: string) => entries.filter((entry) => entry.relationship === relationship).length;
    console.log(
      `${file}: the snapshot names ${entries.length} packages, ${count('direct')} direct and ${count('indirect')} indirect.`,
    );
  }
  if (!args.includes('--prove')) return 0;

  let failed = false;
  const pnpm = await pnpmIn(checkout, work);
  for (const [file, manifest] of Object.entries(made.manifests ?? {})) {
    try {
      const found = compare(manifest, await pnpm(join(checkout, dirname(file))));
      console.log(
        `${file}: pnpm list --depth Infinity names ${found.all.size} packages, ${found.direct.size} direct; the snapshot names ${found.named.size}; ${found.absent.length} not in it, ${found.misplaced.length} direct or indirect where pnpm lists them the other way, ${found.indirect.length} indirect as pnpm lists them${found.indirect[0] ? `, ${found.indirect[0]} among them` : ''}.`,
      );
      if (!found.all.size || found.absent.length || found.misplaced.length || !found.indirect.length) {
        failed = true;
        const list = (ids: string[]) => `${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ', …' : ''}`;
        console.error(
          !found.all.size
            ? `::error::pnpm lists no package from ${file}.`
            : found.absent.length
              ? `::error::The snapshot of ${file} lacks ${list(found.absent)}`
              : found.misplaced.length
                ? `::error::The snapshot of ${file} calls these the opposite of what pnpm does: ${list(found.misplaced)}`
                : `::error::The snapshot of ${file} names no indirect package.`,
        );
      }
    } catch (error) {
      failed = true;
      const message = String((error as { stderr?: string }).stderr || (error as Error).message)
        .trim()
        .split('\n')
        .slice(-3)
        .join(' ');
      console.error(`::error::${file} could not be compared: ${message}`);
    }
  }
  console.log(failed ? 'The proof fails.' : 'The snapshot names every package pnpm lists, in every lockfile.');
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
