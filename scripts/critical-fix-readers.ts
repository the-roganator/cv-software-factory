/**
 * Everything a Critical fix reads (`CriticalFixIO`), and the gate's real readers of it: the two commits fetched and
 * merged as data, as a pin move's are (`realPinMoveIO`); the registries over HTTP; Trivy in its pinned image through
 * Docker, on a fresh database, as the daily scan runs it (`readLockfile`, its image arguments); and Node's own database,
 * as the daily scan reads it. Main's code, on the two commits as data: nothing of the head is run, built or installed.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { CriticalFixIO, Finding, Scan } from './critical-fix.ts';
import { type RealOptions, realPinMoveIO, removeWork } from './pin-move-readers.ts';
import { ROOT } from './pin-move-shared.ts';
import { tagAndDigest } from './pin-move-sides.ts';

/** What Trivy's report read: every package, every finding by the scanner's own rating, and an image's Node. */
export function scanOf(reports: readonly TrivyReport[]): Scan {
  const results = reports.flatMap((report) => report.Results ?? []);
  const node = reports.map((r) => nodeInConfig(r.Metadata?.ImageConfig) ?? nodeInPackages(r.Results)).find(Boolean);
  return {
    packages: results.flatMap((result) =>
      (result.Packages ?? []).flatMap((p) => (p.Name ? [{ name: p.Name, version: p.Version ?? '' }] : [])),
    ),
    findings: results.flatMap((result) =>
      (result.Vulnerabilities ?? []).flatMap((v): Finding[] =>
        v.VulnerabilityID && v.PkgName
          ? [
              {
                id: v.VulnerabilityID,
                pkg: v.PkgName,
                version: v.InstalledVersion ?? '',
                ...(v.FixedVersion ? { fixed: v.FixedVersion } : {}),
                // Trivy's own rating, never `VendorSeverity`'s publisher's (scan.ts's `publisherOf`).
                severity: v.Severity ?? 'UNKNOWN',
              },
            ]
          : [],
      ),
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

/** The readers on two commits of `repo`, fetched into a directory of their own, as data. */
export async function realCriticalFixIO(options: RealOptions): Promise<CriticalFixIO & { close(): void }> {
  const commits = await realPinMoveIO(options);
  const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'critical-fix-'));
  mkdirSync(join(work, 'cache'));
  const tools = realTools(trivyImage(), join(work, 'cache'), work);
  let pulled: Promise<unknown> | undefined;
  let nodeDatabase: Promise<ReturnType<typeof entries>> | undefined;
  // As the daily scan refuses one: findings read from a stale or missing database prove nothing is fixed or new.
  const fresh = async () => {
    pulled ??= databases(tools, trivyImage(), join(work, 'cache'));
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
    digest: (reference) => commits.digest(reference),
    runs: options.runs,
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
