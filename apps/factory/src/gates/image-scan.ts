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
 * Its exceptions are the lockfile scan's and dependency review's: the entries of `policy/vulnerabilities.ts` in force,
 * read from this repository's `main` alone (the workflow puts `main`'s in place of the checkout's), for the repository
 * the gate judges (GITHUB_REPOSITORY) and its own image, matched by the same function the other two use
 * (./exceptions.ts). A finding
 * one excepts is named in the summary and fails nothing. Nothing is read from the change that could except anything.
 *
 * Its notice gives what each image has in all, by severity, each vulnerability once (./counts.ts): the counts the line
 * records. It writes none unless both reports are Trivy's own, `SchemaVersion` 2 with a list of results: a report of
 * another shape fails nothing here, so it must not count as an image with nothing in it.
 */
import { readFile } from 'node:fs/promises';
import { EXCEPTIONS, type Exception } from '../../../../policy/vulnerabilities.ts';
import { countBySeverity, countsNote } from './counts.ts';
import { except, ownImage } from './exceptions.ts';
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

const FAILING = new Set(['HIGH', 'CRITICAL']);

const key = (v: Vulnerability) => `${v.VulnerabilityID} ${v.PkgName}`;

export function vulnerabilities(report: TrivyReport): Vulnerability[] {
  const results = Array.isArray(report?.Results) ? report.Results : [];
  const all = results
    .flatMap((r) => (Array.isArray(r?.Vulnerabilities) ? r.Vulnerabilities : []))
    .filter((v): v is Vulnerability => typeof v === 'object' && v !== null);
  return [...new Map(all.map((v) => [key(v), v])).values()];
}

/**
 * A report Trivy wrote, as far as counting it goes: its own schema, with a list of results, each vulnerability in them
 * an object with its severity in words.
 */
function countable(report: TrivyReport): boolean {
  const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
  const results: unknown = report?.Results;
  return (
    report?.SchemaVersion === 2 &&
    Array.isArray(results) &&
    results.every((r) => {
      if (!object(r)) return false;
      const found = r.Vulnerabilities ?? [];
      return Array.isArray(found) && found.every((v) => object(v) && typeof v.Severity === 'string');
    })
  );
}

/** What each image has in all, by severity, or nothing when either report cannot be counted. */
export function countsOf(base: TrivyReport, change: TrivyReport) {
  if (!countable(base) || !countable(change)) return undefined;
  const of = (report: TrivyReport) => countBySeverity(vulnerabilities(report).map((v) => v.Severity));
  return { before: of(base), after: of(change) };
}

/**
 * What the change's image brings in, the high or critical part of it that fails, and what an exception in force for the
 * repository's own image excepts, which fails nothing: the entries of policy/vulnerabilities.ts, or others, for the tests.
 */
export function newIn(
  base: TrivyReport,
  change: TrivyReport,
  repository = '',
  entries: readonly Exception[] = EXCEPTIONS,
  today: Date | string = new Date(),
) {
  const before = new Set(vulnerabilities(base).map(key));
  const after = vulnerabilities(change);
  const added = after.filter((v) => !before.has(key(v)));
  const removed = vulnerabilities(base).filter((v) => !after.some((a) => key(a) === key(v)));
  const item = ownImage(repository);
  const { excepted, failing } = except(
    added,
    repository,
    (v) => ({ item, package: v.PkgName, advisory: v.VulnerabilityID }),
    entries,
    today,
  );
  return { added, failing: failing.filter((v) => FAILING.has(v.Severity)), excepted, removed, total: after.length };
}

/** The run's summary: what the change's image brings in, each excepted finding in a table of its own. */
export function summary({ added, failing, excepted, removed, total }: ReturnType<typeof newIn>) {
  const shown = added.filter((v) => !excepted.some((e) => key(e) === key(v)));
  const rows = shown
    .map(
      (v) =>
        `| ${v.Severity} | ${v.VulnerabilityID} | ${cell(v.PkgName)} ${cell(v.InstalledVersion)} | ${cell(v.FixedVersion ?? 'none yet')} | ${cell(v.Title ?? '')} |`,
    )
    .join('\n');
  return [
    '## Image scan',
    failing.length
      ? `This change's image brings in ${failing.length} high or critical vulnerabilit${failing.length === 1 ? 'y' : 'ies'} the base's does not have.`
      : `This change's image brings in no high or critical vulnerability${excepted.length ? ' but those excepted' : ''}. It has ${total} known in all, ${added.length} of them new and ${removed.length} fewer than the base's.`,
    shown.length ? `| Severity | Vulnerability | Package | Fixed in | Title |\n|---|---|---|---|---|\n${rows}` : '',
    excepted.length
      ? `It brings in ${excepted.length} that policy/vulnerabilities.ts on main excepts, which fail nothing:\n\n| Vulnerability | Package | Excepted until |\n|---|---|---|\n${excepted.map((v) => `| ${v.VulnerabilityID} | ${cell(v.PkgName)} ${cell(v.InstalledVersion)} | ${v.expires} |`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
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
  const judged = newIn(base, change, process.env.GITHUB_REPOSITORY ?? '');
  const { failing } = judged;
  await summarise(summary(judged));
  const counts = countsOf(base, change);
  if (counts) annotate('notice', countsNote('image scan', counts));
  for (const v of failing)
    annotate('error', `${v.Severity} ${v.VulnerabilityID} in ${v.PkgName} ${v.InstalledVersion}`);
  return failing.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
