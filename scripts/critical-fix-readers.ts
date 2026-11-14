/**
 * Everything a Critical fix reads (`CriticalFixIO`), and the gate's real readers of it: the two commits fetched and
 * merged as data, as a pin move's are (`realPinMoveIO`); the registries over HTTP; Trivy in its pinned image through
 * Docker, on a fresh database, as the daily scan runs it (`readLockfile`, its image arguments); and Node's own database,
 * as the daily scan reads it. Main's code, on the two commits as data: nothing of the head is run, built or installed.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  advisoriesFor,
  entries,
  NODE_DATABASE,
  nodeInConfig,
  nodeInPackages,
  readable,
} from '../apps/factory/src/vulnerabilities/node.ts';
import {
  DB_MAX_AGE_MS,
  databases,
  readLockfile,
  realTools,
  type TrivyReport,
} from '../apps/factory/src/vulnerabilities/scan.ts';
import { trivyPin } from '../apps/factory/src/vulnerabilities/trivy-pin.ts';
import { lockedPnpm } from '../apps/runner/scripts/install-pnpm.ts';
import { git } from '../apps/runner/src/git.ts';
import { pnpmIn, writePins } from '../apps/runner/src/pins.ts';
import type { CriticalFixIO, Finding, Scan } from './critical-fix.ts';
import { formatOf } from './critical-fix-versions.ts';
import { type RealOptions, realPinMoveIO, removeWork } from './pin-move-readers.ts';
import { ROOT } from './pin-move-shared.ts';
import { tagAndDigest } from './pin-move-sides.ts';

/**
 * What Trivy's report read: every package, every finding by the scanner's own rating, each in the format of the target
 * it was found in (`formatOf`, from the result's class and type), and an image's Node. A finding with no package or no
 * advisory is a report the gate cannot read whole: it throws, and the fix holds.
 */
export function scanOf(reports: readonly TrivyReport[]): Scan {
  const results = reports.flatMap((report) => report.Results ?? []);
  const node = reports.map((r) => nodeInConfig(r.Metadata?.ImageConfig) ?? nodeInPackages(r.Results)).find(Boolean);
  return {
    packages: results.flatMap((result) =>
      (result.Packages ?? []).flatMap((p) => (p.Name ? [{ name: p.Name, version: p.Version ?? '' }] : [])),
    ),
    findings: results.flatMap((result) =>
      (result.Vulnerabilities ?? []).map((v): Finding => {
        if (!v.VulnerabilityID || !v.PkgName)
          throw new Error(
            `Trivy gave a finding with no ${v.PkgName ? 'advisory' : 'package'} in ${result.Target ?? 'a target'}`,
          );
        return {
          id: v.VulnerabilityID,
          pkg: v.PkgName,
          version: v.InstalledVersion ?? '',
          ...(v.FixedVersion ? { fixed: v.FixedVersion } : {}),
          // Trivy's own rating, never `VendorSeverity`'s publisher's (scan.ts's `publisherOf`).
          severity: v.Severity ?? 'UNKNOWN',
          format: formatOf(result.Class, result.Type),
        };
      }),
    ),
    ...(node ? { node } : {}),
  };
}

/** The Trivy image the gate's own checkout pins (deploy/images/trivy/Dockerfile), never the head's. */
function trivyImage() {
  const pinned = trivyPin(readFileSync(join(ROOT, 'deploy/images/trivy/Dockerfile'), 'utf-8'))?.[1];
  if (!pinned) throw new Error("the gate's checkout pins no Trivy it can read");
  return pinned;
}

const exec = promisify(execFile);

/**
 * The pnpm the pin step runs: the version the gate's own mise.lock holds, which is the runner image's
 * (`install-pnpm.ts`), found by mise from the gate's checkout and never from the app's, so neither the app's
 * `packageManager` nor its mise.toml picks it, and refused unless it says it is that version.
 */
export async function pinnedPnpm(root = ROOT): Promise<string> {
  const version = lockedPnpm(readFileSync(join(root, 'mise.lock'), 'utf-8'), 'linux-x64').version;
  const path = (await exec('mise', ['which', 'pnpm'], { cwd: root, timeout: 60_000 })).stdout.trim();
  if (!path.startsWith('/') || basename(path) !== 'pnpm') throw new Error(`mise names no pnpm executable: ${path}`);
  const runs = (await exec(path, ['--version'], { cwd: root, timeout: 60_000 })).stdout.trim();
  if (runs !== version) throw new Error(`the gate's pnpm is ${runs}, and its mise.lock holds ${version}`);
  return path;
}

/** The readers on two commits of `repo`, fetched into a directory of their own, as data. */
export async function realCriticalFixIO(
  options: RealOptions & { required: () => Promise<string[]> },
): Promise<CriticalFixIO & { close(): void }> {
  const trivy = trivyImage();
  const commits = await realPinMoveIO(options);
  let work: string;
  let tools: ReturnType<typeof realTools>;
  try {
    work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'critical-fix-'));
    mkdirSync(join(work, 'cache'));
    tools = realTools(trivy, join(work, 'cache'), work);
  } catch (error) {
    commits.close();
    throw error;
  }
  let pulled: Promise<unknown> | undefined;
  let nodeDatabase: Promise<ReturnType<typeof entries>> | undefined;
  // As the daily scan refuses one: findings read from a stale or missing database prove nothing is fixed or new.
  const fresh = async () => {
    pulled ??= databases(tools, trivy, join(work, 'cache'));
    const age = await pulled;
    if (typeof age !== 'number' || age > DB_MAX_AGE_MS)
      throw new Error(`the advisory database is refused: ${typeof age === 'string' ? age : 'it is too old'}`);
  };
  let lockfiles = 0;
  return {
    close: () => {
      commits.close();
      removeWork(work);
    },
    diff: () => commits.diff(),
    tags: (repository) => commits.tags(repository),
    // The registry's own list of a package's versions, read anonymously.
    async versions(name) {
      const path = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
      const answer = await tools.retry(async () => {
        const response = await fetch(`https://registry.npmjs.org/${path}`, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`the registry answered ${response.status} for ${name}`);
        return (await response.json()) as { versions?: unknown };
      });
      if (!answer.versions || typeof answer.versions !== 'object') throw new Error(`the registry lists no ${name}`);
      return Object.keys(answer.versions);
    },
    // The pin step's own derivation (apps/runner/src/pins.ts), on a checkout of the base alone, by the pin step's pnpm,
    // with no secret in its environment and a home of its own: the base's package.json and pnpm-workspace.yaml, its
    // .npmrc moved aside as the pin step moves it, and the registry on the command line.
    async derive(move) {
      const [repo, dir, aside, home] = ['derive-repo', 'derive', 'aside', 'home'].map((d) => join(work, d)) as string[];
      for (const d of [repo, aside, home]) mkdirSync(d as string);
      await git(repo as string, 'init', '--quiet');
      await git(
        repo as string,
        'fetch',
        '--quiet',
        '--depth=1',
        '--no-tags',
        options.remote ?? `https://github.com/${options.repo}.git`,
        options.base,
      );
      await git(repo as string, 'worktree', 'add', '--quiet', '--detach', dir as string, options.base);
      const pnpm = await pinnedPnpm();
      const env = { PATH: `${dirname(pnpm)}:${process.env.PATH ?? ''}`, HOME: home as string };
      await writePins(dir as string, move, { pnpm: pnpmIn(env), get: fetch, aside: aside as string });
      await git(dir as string, 'add', '--all');
      const changed = await git(dir as string, 'diff', '--cached', '--name-only', '--no-renames', '-z');
      return Object.fromEntries(
        changed
          .split('\0')
          .filter(Boolean)
          .map((path) => [path, readFileSync(join(dir as string, path), 'utf-8')]),
      );
    },
    digest: (reference) => commits.digest(reference),
    runs: options.runs,
    required: options.required,
    async lockfile(text) {
      await fresh();
      const root = join(work, `lockfile-${++lockfiles}`);
      mkdirSync(root);
      writeFileSync(join(root, 'pnpm-lock.yaml'), text);
      const item = { kind: 'lockfile', name: 'pnpm-lock.yaml', file: 'pnpm-lock.yaml', line: 1 };
      const read = await readLockfile(tools, root, {
        item,
        key: 'pnpm-lock.yaml',
        label: 'pnpm-lock.yaml',
      } as Parameters<typeof readLockfile>[2]);
      if (read.unreadable) throw new Error(`the lockfile scan read nothing whole: ${read.unreadable}`);
      return scanOf(read.reports);
    },
    async image(reference, platform) {
      await fresh();
      const { digest } = tagAndDigest(reference);
      if (!digest) throw new Error(`${reference} is not pinned by digest`);
      const report = await tools.retry(() =>
        tools.trivy([
          'image',
          '--scanners',
          'vuln',
          '--list-all-pkgs',
          '--image-src',
          'remote',
          '--platform',
          platform,
          '--',
          reference,
        ]),
      );
      if (!report.Metadata?.ImageID) throw new Error(`Trivy gave no image it analysed for ${reference}`);
      if (!(report.Results ?? []).some((r) => r.Packages?.length))
        throw new Error(`Trivy read no packages from ${reference} on ${platform}`);
      return scanOf([report]);
    },
    async node(version) {
      nodeDatabase ??= (async () => {
        const database = entries(await tools.retry(() => tools.fetch(NODE_DATABASE)));
        // Every range read now, so one the gate cannot read refuses the database rather than misreading a version.
        readable(database);
        if (!database.length) throw new Error("Node's vulnerability database has no entries");
        return database;
      })();
      return advisoriesFor(version, await nodeDatabase).map((a) => ({
        id: a.advisory,
        pkg: 'node',
        version,
        ...(a.patched ? { fixed: a.patched } : {}),
        // Node's own database is the scan's reading of Node, as the daily scan's: Trivy reads no Node runtime.
        severity: a.severity,
      }));
    },
  };
}
