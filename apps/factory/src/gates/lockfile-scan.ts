/**
 * The lockfile gate: Trivy's findings on each tracked lockfile of the change, less those already on the base's. It
 * fails on any vulnerability, at any severity, that the change's lockfiles have and the base's do not.
 *
 *     node apps/factory/src/gates/lockfile-scan.ts <base checkout> <change checkout> --trivy-pin <Dockerfile>
 *
 * - Each lockfile is the daily scan's (`lockfiles` in ../vulnerabilities/inventory.ts: every `pnpm-lock.yaml` git
 *   tracks, outside prose and fixtures), and is scanned alone, from a directory holding only it, development
 *   dependencies included. A lockfile only the change has is compared with none, so all its findings are new.
 * - A vulnerability is known by its lockfile, its advisory, its package, and whether a production dependency reaches
 *   it (Trivy's `Dev` on the package), so a package moved to another vulnerable version brings nothing new, and one a
 *   production dependency newly reaches does. One the base reaches from production and the change from development
 *   alone is less reached, not new.
 * - A lockfile Trivy reads no packages from, on either side, or whose report is empty or cannot be parsed, fails: an
 *   unread lockfile would otherwise pass for one with nothing in it. So does a `pnpm-lock.yaml` git tracks as anything
 *   but a regular file: pnpm follows a symbolic link the list leaves out, so one could stand in for a vulnerable tree.
 * - So does a change whose `pnpm-workspace.yaml` or `.npmrc`, at any depth, sets `lockfileDir` or `lockfile-dir`: pnpm
 *   would then install from a lockfile elsewhere, perhaps one the list leaves out as a fixture.
 * - A lockfile the same on both sides, byte for byte, is scanned once, as both.
 *
 * It excepts nothing: no exception is read from the change, or from anywhere else.
 *
 * Both checkouts are data: nothing in them runs. Trivy runs in its pinned image, the advisory database pulled once,
 * with retries, and both sides read against that one database, so an advisory published during the run cannot make
 * the base look clean. Node alone runs this, from a sparse checkout with no dependencies.
 */
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { isFixture, lockfiles } from '../vulnerabilities/inventory.ts';
import { annotate, cell, summarise } from './report.ts';

const run = promisify(execFile);

// Trivy's own JSON (SchemaVersion 2), as far as the gate reads it. Every field is optional: a report of another shape
// reads as one with no packages, which fails, never as one with no vulnerabilities.
interface TrivyPackage {
  ID?: string;
  Name?: string;
  Version?: string;
  Dev?: boolean | null;
  Identifier?: { UID?: string };
}
interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  PkgIdentifier?: { UID?: string };
}
interface TrivyReport {
  Results?: { Packages?: TrivyPackage[] | null; Vulnerabilities?: TrivyVulnerability[] | null }[] | null;
}

export interface Finding {
  lockfile: string;
  advisory: string;
  pkg: string;
  version: string;
  /** True when only development dependencies reach it. */
  dev: boolean;
  severity: string;
  fixed: string;
  title: string;
}

/** What scanning one lockfile gave: Trivy's report as text, why Trivy failed, or why it was not scanned. */
export type Scanned = { report: string } | { error: string } | { unscannable: string };

/** One lockfile's findings, or why it could not be read. */
export function findingsOf(lockfile: string, scanned: Scanned): Finding[] | string {
  if ('unscannable' in scanned) return scanned.unscannable;
  if ('error' in scanned) return `Trivy could not scan it: ${scanned.error}`;
  let report: TrivyReport;
  try {
    report = JSON.parse(scanned.report) as TrivyReport;
  } catch {
    return "Trivy's report could not be parsed";
  }
  const results = Array.isArray(report?.Results) ? report.Results : [];
  const packages = results.flatMap((result) => (Array.isArray(result?.Packages) ? result.Packages : []));
  if (!packages.length) return 'Trivy read no packages from it';
  // A package is a development dependency only when Trivy says so of every copy of it: one it cannot match is
  // production's, the stricter reading.
  const dev = new Map<string, boolean>();
  for (const p of packages)
    for (const id of [p.Identifier?.UID, p.ID]) if (id) dev.set(id, (dev.get(id) ?? true) && p.Dev === true);
  return results.flatMap((result) =>
    (Array.isArray(result?.Vulnerabilities) ? result.Vulnerabilities : []).map((v) => ({
      lockfile,
      advisory: v.VulnerabilityID ?? 'unknown',
      pkg: v.PkgName ?? 'unknown',
      version: v.InstalledVersion ?? '',
      dev: dev.get(v.PkgIdentifier?.UID ?? '') ?? dev.get(v.PkgID ?? '') ?? false,
      severity: v.Severity ?? 'UNKNOWN',
      fixed: v.FixedVersion ?? '',
      title: v.Title ?? '',
    })),
  );
}

const key = (f: Finding) => JSON.stringify([f.lockfile, f.advisory, f.pkg, f.dev]);

export interface Unread {
  side: 'base' | 'change';
  lockfile: string;
  why: string;
}

/**
 * The judgement: each side's lockfiles, by path, as scanned. What the change has that the base does not, each once,
 * and every lockfile on either side that could not be read.
 */
export function judge(base: Map<string, Scanned>, change: Map<string, Scanned>) {
  const unread: Unread[] = [];
  const read = (side: Unread['side'], scans: Map<string, Scanned>) =>
    [...scans].flatMap(([lockfile, scanned]) => {
      const found = findingsOf(lockfile, scanned);
      if (typeof found === 'string') {
        unread.push({ side, lockfile, why: found });
        return [];
      }
      return found;
    });
  const before = new Set(read('base', base).map(key));
  // Each package and advisory once, naming every version of it the lockfile holds.
  const after = new Map<string, Finding>();
  for (const f of read('change', change)) {
    const seen = after.get(key(f));
    const versions = new Set([...(seen?.version.split(', ') ?? []), f.version].filter(Boolean));
    after.set(key(f), { ...(seen ?? f), version: [...versions].sort().join(', ') });
  }
  // One the base reaches from production covers the change's from development alone: that is less reached, not new.
  const added = [...after.values()].filter(
    (f) => !before.has(key(f)) && !(f.dev && before.has(key({ ...f, dev: false }))),
  );
  return { added, unread, total: after.size };
}

/** The Trivy image a Dockerfile pins, by version and digest, as scripts/workflows.test.ts holds it. */
export function trivyPin(dockerfile: string) {
  return /^FROM (ghcr\.io\/aquasecurity\/trivy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64})$/m.exec(dockerfile)?.[1];
}

/**
 * Every `pnpm-lock.yaml` a checkout tracks, outside prose and fixtures, as anything but a regular file: a symbolic
 * link (120000), which pnpm would follow, or a submodule (160000). The list leaves these out, so the gate names them.
 */
export function irregularLockfiles(root: string) {
  return execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'ls-files', '-s', '-z'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .flatMap((entry) => {
      const [, mode, file] = /^(\d+) \S+ \d+\t(.+)$/s.exec(entry) ?? [];
      return file && /(^|\/)pnpm-lock\.yaml$/.test(file) && !isFixture(file) && mode !== '100644' && mode !== '100755'
        ? [file]
        : [];
    });
}

/** A setting that moves the lockfile pnpm installs from, in either spelling, as a key of YAML or of an `.npmrc`. */
const LOCKFILE_DIR = /^\s*["']?(lockfileDir|lockfile-dir)["']?\s*[:=]/;

/**
 * Each place a checkout's pnpm settings move the lockfile: every tracked `pnpm-workspace.yaml` and `.npmrc`, at any
 * depth, that sets `lockfileDir` or `lockfile-dir`, as `<file>:<line>`. Read as text, so a setting in any shape fails
 * the gate rather than slipping past a parser.
 */
export function lockfileDirSettings(root: string) {
  const files = execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'ls-files', '-z'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => /(^|\/)(pnpm-workspace\.yaml|\.npmrc)$/.test(file) && existsSync(join(root, file)));
  return files.flatMap((file) =>
    readFileSync(join(root, file), 'utf-8')
      .split('\n')
      .flatMap((line, index) => (LOCKFILE_DIR.test(line) ? [`${file}:${index + 1}`] : [])),
  );
}

/** Where the advisory database is pulled from: GHCR, as the daily scan pulls it (../vulnerabilities/scan.ts). */
const DB = 'ghcr.io/aquasecurity/trivy-db:2';

/** Removes what the gate made, and never fails it: the verdict is already given. */
function remove(path: string) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.log(`Could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Trivy in its pinned image, through Docker, with one cache for the database. It runs as this process's user, so
 * what it writes (the database, the report) is ours to read and remove.
 */
function trivy(image: string, cache: string) {
  const user = process.getuid && process.getgid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
  const docker = (mounts: string[], args: string[]) =>
    run(
      'docker',
      [
        'run',
        '--rm',
        ...user,
        '-e',
        'HOME=/tmp',
        '-v',
        `${cache}:/cache`,
        ...mounts.flatMap((m) => ['-v', m]),
        image,
        ...args,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  return {
    async database() {
      let last: unknown;
      for (const wait of [0, 15, 30, 60]) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        try {
          await docker([], ['image', '--cache-dir', '/cache', '--quiet', '--download-db-only', '--db-repository', DB]);
          return;
        } catch (error) {
          last = error;
          console.log(`::warning::Trivy's database could not be pulled; trying again.`);
        }
      }
      throw last;
    },
    /** One lockfile, alone in a directory of its own. */
    async scan(root: string, lockfile: string): Promise<Scanned> {
      const dir = mkdtempSync(join(tmpdir(), 'lockfile-'));
      try {
        mkdirSync(join(dir, 'src'));
        mkdirSync(join(dir, 'out'));
        cpSync(join(root, lockfile), join(dir, 'src', 'pnpm-lock.yaml'));
        await docker(
          [`${join(dir, 'src')}:/src:ro`, `${join(dir, 'out')}:/out`],
          [
            'fs',
            '--cache-dir',
            '/cache',
            '--skip-db-update',
            '--skip-java-db-update',
            '--quiet',
            '--scanners',
            'vuln',
            '--include-dev-deps',
            '--list-all-pkgs',
            '--format',
            'json',
            '--output',
            '/out/report.json',
            '/src',
          ],
        );
        return { report: readFileSync(join(dir, 'out', 'report.json'), 'utf-8') };
      } catch (error) {
        // Trivy's own words, from its stderr, rather than the command line Node's error begins with.
        const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
        const message = stderr || (error instanceof Error ? error.message : String(error));
        return { error: message.split('\n').filter(Boolean).slice(-3).join(' ') || 'failed' };
      } finally {
        remove(dir);
      }
    },
  };
}

export async function main(args: string[]): Promise<number> {
  const at = args.indexOf('--trivy-pin');
  const pinFile = at >= 0 ? args[at + 1] : undefined;
  const [basePath, changePath] = args.filter((_, i) => i !== at && i !== at + 1);
  if (!basePath || !changePath || !pinFile) {
    console.error('Usage: lockfile-scan.ts <base checkout> <change checkout> --trivy-pin <Dockerfile>');
    return 2;
  }
  const image = trivyPin(readFileSync(pinFile, 'utf-8'));
  if (!image) {
    console.error(`::error::${pinFile} pins no Trivy by version and digest.`);
    return 2;
  }
  const cache = mkdtempSync(join(tmpdir(), 'trivy-cache-'));
  try {
    const scanner = trivy(image, cache);
    try {
      await scanner.database();
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
      annotate('error', `Trivy's advisory database could not be pulled: ${stderr.split('\n').at(-1) || String(error)}`);
      return 1;
    }
    const text = (root: string, lockfile: string) => readFileSync(join(root, lockfile), 'utf-8');
    const scanAll = async (root: string, same?: { root: string; scans: Map<string, Scanned> }) => {
      const scans = new Map<string, Scanned>();
      for (const lockfile of lockfiles(root)) {
        const before = same?.scans.get(lockfile);
        scans.set(
          lockfile,
          before && 'report' in before && same && text(same.root, lockfile) === text(root, lockfile)
            ? before
            : await scanner.scan(root, lockfile),
        );
      }
      for (const lockfile of irregularLockfiles(root))
        scans.set(lockfile, {
          unscannable: 'git tracks it as something other than a regular file, which is not scanned',
        });
      return scans;
    };
    const base = await scanAll(basePath);
    const change = await scanAll(changePath, { root: basePath, scans: base });
    for (const setting of lockfileDirSettings(changePath)) {
      const at = setting.lastIndexOf(':');
      change.set(setting.slice(0, at), {
        unscannable: `line ${setting.slice(at + 1)} sets lockfileDir or lockfile-dir, so pnpm would install from a lockfile the gate does not read`,
      });
    }
    if (!change.size) {
      console.error('::error::The change tracks no lockfile to scan.');
      return 1;
    }
    const { added, unread, total } = judge(base, change);
    const rows = added
      .map(
        (f) =>
          `| ${f.severity} | ${f.advisory} | ${cell(f.pkg)} ${cell(f.version)} | ${f.dev ? 'development' : 'production'} | ${cell(f.fixed || 'none yet')} | ${cell(f.lockfile)} | ${cell(f.title)} |`,
      )
      .join('\n');
    await summarise(
      [
        '## Lockfile scan',
        `Scanned ${base.size} lockfile${base.size === 1 ? '' : 's'} of the base and ${change.size} of the change.`,
        unread.length
          ? `${unread.length} could not be judged:\n\n${unread.map((u) => `- ${u.side}: ${cell(u.lockfile)}: ${u.why}`).join('\n')}`
          : '',
        added.length
          ? `This change brings in ${added.length} vulnerabilit${added.length === 1 ? 'y' : 'ies'} the base does not have.\n\n| Severity | Vulnerability | Package | Reached from | Fixed in | Lockfile | Title |\n|---|---|---|---|---|---|---|\n${rows}`
          : `This change brings in no vulnerability. Its lockfiles have ${total} known in all.`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    for (const u of unread)
      annotate('error', `The ${u.side}'s ${u.lockfile} could not be judged: ${u.why}`, u.lockfile);
    for (const f of added)
      annotate(
        'error',
        `${f.severity} ${f.advisory} in ${f.pkg} ${f.version}, reached from ${f.dev ? 'development' : 'production'}`,
        f.lockfile,
      );
    return added.length || unread.length ? 1 : 0;
  } finally {
    remove(cache);
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
