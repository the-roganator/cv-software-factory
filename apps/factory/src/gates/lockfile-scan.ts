/**
 * The lockfile gate: Trivy's findings on each tracked lockfile of the change, less those already on the base's. It
 * fails on any vulnerability, at any severity, that the change's lockfiles have and the base's do not.
 *
 *     node apps/factory/src/gates/lockfile-scan.ts <base checkout> <change checkout> --trivy-pin <Dockerfile>
 *
 * - Each lockfile is every `pnpm-lock.yaml` and `pnpm-lock.<name>.yaml` (a branch's, which pnpm reads or merges) git
 *   tracks, at any depth, fixtures included: whatever points pnpm at one (`lockfileDir` in any spelling, a flag, a
 *   variable), the one a frozen install reads is tracked, so it is read here. Each YAML document in it is scanned
 *   alone, from a directory holding only it, development dependencies included: pnpm reads a lockfile's second
 *   document, where Trivy reads only its first. A lockfile only the change has is compared with none, so all its
 *   findings are new.
 * - A vulnerability is known by its lockfile, its advisory, its package, and whether a production dependency reaches
 *   it (Trivy's `Dev` on the package), so a package moved to another vulnerable version brings nothing new, and one a
 *   production dependency newly reaches does. One the base reaches from production and the change from development
 *   alone is less reached, not new.
 * - A lockfile, or a document of one, Trivy reads no packages from, on either side, fails unless it holds nothing but
 *   its `lockfileVersion`:
 *   an unread lockfile would otherwise pass for one with nothing in it. So does one whose report is empty or cannot be
 *   parsed, and a `pnpm-lock.yaml` git tracks as anything but a regular file: pnpm follows a symbolic link, which
 *   could stand in for a vulnerable tree.
 * - A lockfile the same on both sides, byte for byte, is scanned once, as both.
 * - Its notice gives what each side has in all, by severity, each finding once, excepted ones too (./counts.ts): the
 *   counts the line records. It writes none when any lockfile on either side could not be judged.
 *
 * Its exceptions are the daily scan's: the entries of `policy/vulnerabilities.ts` in force, read from this repository's
 * `main` alone (the workflow puts `main`'s in place of the checkout's), for the repository the gate judges (GITHUB_REPOSITORY), each for one lockfile, package and
 * advisory. A finding one excepts is named in the summary and fails nothing, so a fix whose release also brings in an
 * excepted finding is not held by it. Nothing is read from the change that could except anything.
 *
 * Both checkouts are data: nothing in them runs. Trivy runs in its pinned image, the advisory database pulled once,
 * with retries, and both sides read against that one database, so an advisory published during the run cannot make
 * the base look clean. Node alone runs this, from a sparse checkout with no dependencies.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EXCEPTIONS, type Exception, exceptionFor } from '../../../../policy/vulnerabilities.ts';
import { countBySeverity, countsNote } from './counts.ts';
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
export type Scanned = { report: string; empty?: boolean } | { error: string } | { unscannable: string };

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
  if (!packages.length) return scanned.empty ? [] : 'Trivy read no packages from it';
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
  const based = new Map(read('base', base).map((f) => [key(f), f]));
  const before = new Set(based.keys());
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
  // What each side has in all, by severity: the counts the gate's notice gives, each finding once.
  const counts = {
    before: countBySeverity([...based.values()].map((f) => f.severity)),
    after: countBySeverity([...after.values()].map((f) => f.severity)),
  };
  return { added, unread, total: after.size, counts };
}

/**
 * What the change brings in, split into what fails and what an exception in force for the repository excepts: the
 * entries of policy/vulnerabilities.ts, which the workflow takes from `main`, or others, for the tests.
 */
export function except(
  added: Finding[],
  repository: string,
  entries: readonly Exception[] = EXCEPTIONS,
  today: Date | string = new Date(),
) {
  const excepted: (Finding & { expires: string })[] = [];
  const failing: Finding[] = [];
  for (const f of added) {
    const entry = exceptionFor(entries, { repository, item: f.lockfile, package: f.pkg, advisory: f.advisory }, today);
    if (entry) excepted.push({ ...f, expires: entry.expires });
    else failing.push(f);
  }
  return { excepted, failing };
}

/** The Trivy image a Dockerfile pins, by version and digest, as scripts/workflows.test.ts holds it. */
export function trivyPin(dockerfile: string) {
  return /^FROM (ghcr\.io\/aquasecurity\/trivy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64})$/m.exec(dockerfile)?.[1];
}

/** A lockfile pnpm may install from: `pnpm-lock.yaml`, or a branch's `pnpm-lock.<name>.yaml`. */
export const LOCKFILE = /(^|\/)pnpm-lock(\.[^/]+)?\.yaml$/;

/**
 * A lockfile's YAML documents, each that holds more than blank lines and comments, split where a line is a document's
 * start (`---`, alone or before a space) or end (`...`).
 */
export function documents(text: string) {
  const docs: string[][] = [[]];
  for (const line of text.split(/\r?\n|\r/)) {
    if (/^(---|\.\.\.)([ \t].*)?$/.test(line)) docs.push([]);
    else docs.at(-1)?.push(line);
  }
  return docs
    .map((lines) => lines.join('\n').trimEnd())
    .filter((doc) => doc.split('\n').some((line) => line.trim() && !line.trim().startsWith('#')));
}

/**
 * Every package a document lists under `packages:`, as `name@version`: what pnpm installs from it, whatever Trivy
 * reads. Read from the text, so it fails (a string, the reason) on any document it cannot read plainly: a key at the
 * top level that is not a plain word, a document indented as a whole, `packages` written as a flow mapping, or a line
 * in its block that is not a package's key at two spaces or deeper under one.
 */
export function packageKeys(doc: string): string[] | string {
  const lines = doc.split('\n');
  const plain = (line: string) => !line.trim() || line.trim().startsWith('#');
  // The document's mapping starts at the first column: one indented as a whole would hide its keys from what follows.
  const first = lines.find((line) => !plain(line));
  if (first !== undefined && /^\s/.test(first)) return 'it is indented as a whole';
  for (const line of lines)
    if (!plain(line) && !/^\s/.test(line) && !/^[A-Za-z][A-Za-z0-9]*:(\s.*)?$/.test(line))
      return `its top-level line \`${line.slice(0, 40)}\` is not a plain key`;
  const at = lines.findIndex((line) => /^packages:/.test(line));
  if (at < 0) return [];
  if (!/^packages:\s*(#.*)?$/.test(lines[at] ?? '')) return '`packages` is not written as a block';
  const keys: string[] = [];
  // Each package's key at exactly two spaces, its fields deeper and only after it: keys written deeper would read as
  // fields of none.
  for (const line of lines.slice(at + 1)) {
    if (plain(line)) continue;
    if (/^\S/.test(line)) break;
    if (/^ {4}/.test(line)) {
      if (!keys.length) return 'the keys under `packages` are not at two spaces';
      continue;
    }
    const key = /^ {2}(['"]?)([^\s'"#].*?)\1:(\s.*)?$/.exec(line)?.[2];
    if (!key) return `a line under \`packages\` is not a package's key: \`${line.trim().slice(0, 40)}\``;
    keys.push(key);
  }
  return keys;
}

/**
 * A document as Trivy can read it. pnpm writes its env lockfile, pnpm itself and its config dependencies, as a
 * document of its own before the main one, under `packageManagerDependencies` and `configDependencies`, which Trivy
 * does not read: in a document with no dependencies of the usual names, they are given those names, so Trivy reads
 * them as production's. Anything else is left as it is, and a document Trivy still reads nothing from fails.
 */
export function forTrivy(doc: string) {
  const lines = doc.split('\n');
  // The importers' block alone: from `importers:` to the next key at the top level.
  const start = lines.indexOf('importers:');
  if (start < 0) return doc;
  const next = lines.findIndex((line, i) => i > start && /^\S/.test(line));
  const end = next < 0 ? lines.length : next;
  const block = lines.slice(start, end);
  if (block.some((line) => /^ {4}(dependencies|optionalDependencies|devDependencies):/.test(line))) return doc;
  const renamed = block.map((line) =>
    line
      .replace(/^ {4}configDependencies:/, '    dependencies:')
      .replace(/^ {4}packageManagerDependencies:/, '    optionalDependencies:'),
  );
  return [...lines.slice(0, start), ...renamed, ...lines.slice(end)].join('\n');
}

/**
 * Every lockfile a checkout tracks, at any depth, fixtures included: the regular files, which are scanned, and
 * the rest (a symbolic link, 120000, which pnpm would follow, or a submodule, 160000), which fail.
 */
export function trackedLockfiles(root: string) {
  const regular: string[] = [];
  const irregular: string[] = [];
  for (const entry of execFileSync('git', ['-C', root, '-c', 'core.fsmonitor=false', 'ls-files', '-s', '-z'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  }).split('\0')) {
    const [, mode, file] = /^(\d+) \S+ \d+\t(.+)$/s.exec(entry) ?? [];
    if (!file || !LOCKFILE.test(file)) continue;
    (mode === '100644' || mode === '100755' ? regular : irregular).push(file);
  }
  return { regular, irregular };
}

/** A lockfile that holds nothing but its version: pnpm installs nothing from it, and Trivy rightly reads nothing. */
export function isEmptyLockfile(text: string) {
  return text
    .split(/\r?\n|\r/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .every((line) => /^(---|lockfileVersion:\s*\S+)\s*$/.test(line));
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
    /** One lockfile, each YAML document of it alone in a directory of its own, the reports as one. */
    async scan(root: string, lockfile: string): Promise<Scanned> {
      const text = readFileSync(join(root, lockfile), 'utf-8');
      const docs = documents(text);
      const results: unknown[] = [];
      for (const [index, doc] of docs.entries()) {
        const one = await this.scanDocument(doc);
        if (!('report' in one)) return one;
        let report: TrivyReport;
        try {
          report = JSON.parse(one.report) as TrivyReport;
        } catch {
          return { unscannable: `Trivy's report on its document ${index + 1} could not be parsed` };
        }
        const read = Array.isArray(report?.Results) ? report.Results : [];
        if (!read.some((r) => Array.isArray(r?.Packages) && r.Packages.length) && !isEmptyLockfile(doc))
          return { unscannable: `Trivy read no packages from its document ${index + 1} of ${docs.length}` };
        // Every package the document lists, Trivy must have read: it builds its list from other sections, which a
        // lockfile can leave a package out of while pnpm still installs it.
        const listed = packageKeys(doc);
        if (typeof listed === 'string')
          return { unscannable: `its document ${index + 1} of ${docs.length} cannot be read plainly: ${listed}` };
        const seen = new Set(
          read.flatMap((r) => (Array.isArray(r?.Packages) ? r.Packages : []).map((p) => `${p.Name}@${p.Version}`)),
        );
        const unread = listed.filter((key) => !seen.has(key));
        if (unread.length)
          return {
            unscannable: `Trivy did not read ${unread.length} of the packages its document ${index + 1} lists: ${unread.slice(0, 5).join(', ')}${unread.length > 5 ? ', …' : ''}`,
          };
        results.push(...read);
      }
      return { report: JSON.stringify({ Results: results }), empty: isEmptyLockfile(text) };
    },
    /** One YAML document, as a lockfile alone in a directory of its own. */
    async scanDocument(doc: string): Promise<Scanned> {
      const dir = mkdtempSync(join(tmpdir(), 'lockfile-'));
      try {
        mkdirSync(join(dir, 'src'));
        mkdirSync(join(dir, 'out'));
        writeFileSync(join(dir, 'src', 'pnpm-lock.yaml'), `${forTrivy(doc)}\n`);
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
  const repository = process.env.GITHUB_REPOSITORY ?? '';
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
      const { regular, irregular } = trackedLockfiles(root);
      for (const lockfile of regular) {
        if (!existsSync(join(root, lockfile))) {
          scans.set(lockfile, { unscannable: 'it is tracked but was not checked out' });
          continue;
        }
        const before = same?.scans.get(lockfile);
        scans.set(
          lockfile,
          before && 'report' in before && same && text(same.root, lockfile) === text(root, lockfile)
            ? before
            : await scanner.scan(root, lockfile),
        );
      }
      for (const lockfile of irregular)
        scans.set(lockfile, {
          unscannable: 'git tracks it as something other than a regular file, which is not scanned',
        });
      return scans;
    };
    const base = await scanAll(basePath);
    const change = await scanAll(changePath, { root: basePath, scans: base });
    if (!change.size) {
      console.error('::error::The change tracks no lockfile to scan.');
      return 1;
    }
    const { added: brought, unread, total, counts } = judge(base, change);
    const { excepted, failing: added } = except(brought, repository);
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
          : `This change brings in no vulnerability${excepted.length ? ' but those excepted' : ''}. Its lockfiles have ${total} known in all.`,
        excepted.length
          ? `It brings in ${excepted.length} that policy/vulnerabilities.ts on main excepts, which fail nothing:\n\n| Vulnerability | Package | Lockfile | Excepted until |\n|---|---|---|---|\n${excepted.map((f) => `| ${f.advisory} | ${cell(f.pkg)} ${cell(f.version)} | ${cell(f.lockfile)} | ${f.expires} |`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    // What it counted, which the line records (./counts.ts): only when it read every lockfile on both sides.
    if (!unread.length) annotate('notice', countsNote('lockfile scan', counts));
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
