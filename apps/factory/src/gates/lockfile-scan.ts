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
 *   unread lockfile would otherwise pass for one with nothing in it.
 *
 * It excepts nothing. Exceptions, once there are any, are read from this repository's `main` (`policy/vulnerabilities.ts`,
 * the plan's task 30), never from the change.
 *
 * Both checkouts are data: nothing in them runs. Trivy runs in its pinned image, the advisory database pulled once,
 * with retries, and both sides read against that one database, so an advisory published during the run cannot make
 * the base look clean. Node alone runs this, from a sparse checkout with no dependencies.
 */
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { lockfiles } from '../vulnerabilities/inventory.ts';
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

/** What scanning one lockfile gave: Trivy's report as text, or why there is none. */
export type Scanned = { report: string } | { error: string };

/** One lockfile's findings, or why it could not be read. */
export function findingsOf(lockfile: string, scanned: Scanned): Finding[] | string {
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
  const after = new Map(read('change', change).map((f) => [key(f), f]));
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

/** Trivy in its pinned image, through Docker, with one cache for the database. */
function trivy(image: string, cache: string) {
  const docker = (mounts: string[], args: string[]) =>
    run('docker', ['run', '--rm', '-v', `${cache}:/cache`, ...mounts.flatMap((m) => ['-v', m]), image, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
  return {
    async database() {
      let last: unknown;
      for (const wait of [0, 15, 30, 60]) {
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        try {
          await docker([], ['image', '--cache-dir', '/cache', '--quiet', '--download-db-only']);
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
        return { error: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'failed' };
      } finally {
        rmSync(dir, { recursive: true, force: true });
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
  const scanner = trivy(image, cache);
  await scanner.database();
  const scanAll = async (root: string) => {
    const scans = new Map<string, Scanned>();
    for (const lockfile of lockfiles(root)) scans.set(lockfile, await scanner.scan(root, lockfile));
    return scans;
  };
  const base = await scanAll(basePath);
  const change = await scanAll(changePath);
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
        ? `${unread.length} could not be read:\n\n${unread.map((u) => `- ${u.side}: ${cell(u.lockfile)}: ${u.why}`).join('\n')}`
        : '',
      added.length
        ? `This change brings in ${added.length} vulnerabilit${added.length === 1 ? 'y' : 'ies'} the base does not have.\n\n| Severity | Vulnerability | Package | Reached from | Fixed in | Lockfile | Title |\n|---|---|---|---|---|---|---|\n${rows}`
        : `This change brings in no vulnerability. Its lockfiles have ${total} known in all.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  for (const u of unread) annotate('error', `The ${u.side}'s ${u.lockfile} could not be read: ${u.why}`, u.lockfile);
  for (const f of added)
    annotate(
      'error',
      `${f.severity} ${f.advisory} in ${f.pkg} ${f.version}, reached from ${f.dev ? 'development' : 'production'}`,
      f.lockfile,
    );
  rmSync(cache, { recursive: true, force: true });
  return added.length || unread.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
