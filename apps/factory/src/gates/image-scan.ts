/**
 * The image scan gate: Trivy's findings on the change's image, less those already on the base's. The app's image
 * may carry known vulnerabilities in its base image or dependencies that no change made; a change fails this gate
 * only for a high or critical vulnerability it brings in.
 *
 *     node apps/factory/src/gates/image-scan.ts <base trivy.json> <change trivy.json>
 *
 * A vulnerability is known by its id and the package it is in, so moving a package to another version that has the
 * same vulnerability brings nothing new.
 *
 * Its notice gives what each image has in all, by severity, each vulnerability once (./counts.ts): the counts the line
 * records. It writes none unless both reports are Trivy's own, `SchemaVersion` 2 with a list of results: a report of
 * another shape fails nothing here, so it must not count as an image with nothing in it.
 */
import { readFile } from 'node:fs/promises';
import { countBySeverity, countsNote } from './counts.ts';
import { annotate, cell, summarise } from './report.ts';

interface Vulnerability {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  FixedVersion?: string;
  Severity: string;
  Title?: string;
}

interface TrivyReport {
  SchemaVersion?: number;
  Results?: { Target: string; Vulnerabilities?: Vulnerability[] | null }[];
}

export const FAILING = new Set(['HIGH', 'CRITICAL']);

const key = (v: Vulnerability) => `${v.VulnerabilityID} ${v.PkgName}`;

export function vulnerabilities(report: TrivyReport): Vulnerability[] {
  const results = Array.isArray(report?.Results) ? report.Results : [];
  const all = results.flatMap((r) => (Array.isArray(r?.Vulnerabilities) ? r.Vulnerabilities : []));
  return [...new Map(all.map((v) => [key(v), v])).values()];
}

/** A report Trivy wrote, as far as counting it goes: its own schema, with a list of results. */
export const countable = (report: TrivyReport) => report?.SchemaVersion === 2 && Array.isArray(report.Results);

/** What each image has in all, by severity, or nothing when either report cannot be counted. */
export function countsOf(base: TrivyReport, change: TrivyReport) {
  if (!countable(base) || !countable(change)) return undefined;
  const of = (report: TrivyReport) => countBySeverity(vulnerabilities(report).map((v) => v.Severity ?? 'UNKNOWN'));
  return { before: of(base), after: of(change) };
}

export function newIn(base: TrivyReport, change: TrivyReport) {
  const before = new Set(vulnerabilities(base).map(key));
  const after = vulnerabilities(change);
  const added = after.filter((v) => !before.has(key(v)));
  const removed = vulnerabilities(base).filter((v) => !after.some((a) => key(a) === key(v)));
  return { added, failing: added.filter((v) => FAILING.has(v.Severity)), removed, total: after.length };
}

export async function main([basePath, changePath]: string[]): Promise<number> {
  if (!basePath || !changePath) {
    console.error('Usage: image-scan.ts <base trivy.json> <change trivy.json>');
    return 2;
  }
  // Trivy's own JSON, from the same job. Node alone runs this, from a sparse checkout with no Zod, and every field it
  // reads is optional, so a report of another shape reads as no vulnerabilities rather than throwing.
  const read = async (path: string) => JSON.parse(await readFile(path, 'utf-8')) as TrivyReport;
  const [base, change] = [await read(basePath), await read(changePath)];
  const { added, failing, removed, total } = newIn(base, change);
  const rows = added
    .map(
      (v) =>
        `| ${v.Severity} | ${v.VulnerabilityID} | ${cell(v.PkgName)} ${cell(v.InstalledVersion)} | ${cell(v.FixedVersion ?? 'none yet')} | ${cell(v.Title ?? '')} |`,
    )
    .join('\n');
  await summarise(
    [
      '## Image scan',
      failing.length
        ? `This change's image brings in ${failing.length} high or critical vulnerabilit${failing.length === 1 ? 'y' : 'ies'} the base's does not have.`
        : `This change's image brings in no high or critical vulnerability. It has ${total} known in all, ${added.length} of them new and ${removed.length} fewer than the base's.`,
      added.length ? `| Severity | Vulnerability | Package | Fixed in | Title |\n|---|---|---|---|---|\n${rows}` : '',
    ].join('\n\n'),
  );
  const counts = countsOf(base, change);
  if (counts) annotate('notice', countsNote('image scan', counts));
  for (const v of failing)
    annotate('error', `${v.Severity} ${v.VulnerabilityID} in ${v.PkgName} ${v.InstalledVersion}`);
  return failing.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
