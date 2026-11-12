/**
 * The API versions Argo CD renders the cluster's charts with, as a record the review gate and the vulnerability scan
 * render with too (`deploy/test/api-versions.json`, apps/factory/src/vulnerabilities/scan.ts). platform.yml takes it on
 * its cluster made from the change, and checks it against the record the change carries:
 *
 *   node scripts/api-versions.ts take <file>     # Argo CD's own list, from its cluster cache (`argocd --core`)
 *   node scripts/api-versions.ts check <file>    # the taken list against the record, naming each difference
 *
 * Argo CD passes `helm template` one `--api-versions` for each `group/version` and each `group/version/Kind` of its
 * cluster cache (APIResourcesToStrings), which is also the cluster's `info.apiVersions`: that list is read, never one
 * from `kubectl`, whose discovery has APIs Argo CD's cache leaves out. A record is retaken from the run's artifact,
 * never written by hand.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_VERSIONS_RECORD } from '../apps/factory/src/vulnerabilities/scan.ts';

const ROOT = join(import.meta.dirname, '..');

/** A record: the API versions, sorted, each once. */
export interface Record {
  apiVersions: string[];
}

/** The record of a cluster's `info`, as `argocd cluster get -o json` gives it, or why it says none yet. */
export function recordOf(cluster: unknown): Record | string {
  const info = (cluster as { info?: { apiVersions?: unknown; connectionState?: { status?: unknown } } })?.info;
  if (info?.connectionState?.status !== 'Successful') return 'Argo CD is not connected to its cluster yet';
  const list = info.apiVersions;
  if (!Array.isArray(list) || !list.length) return 'Argo CD lists no API versions for its cluster yet';
  if (!list.every((each) => typeof each === 'string' && /^[\w./-]+$/.test(each)))
    return 'Argo CD lists an API version the gate cannot read';
  return { apiVersions: [...new Set(list as string[])].sort() };
}

/** Each API version only one of the two has, `+` for the taken list's and `-` for the record's. */
export function differences(record: Record, taken: Record): string[] {
  const [had, has] = [new Set(record.apiVersions), new Set(taken.apiVersions)];
  return [
    ...taken.apiVersions.filter((v) => !had.has(v)).map((v) => `+ ${v}`),
    ...record.apiVersions.filter((v) => !has.has(v)).map((v) => `- ${v}`),
  ];
}

/** The command that retakes the record from this run's artifact. */
export const retake = (run: string, repo: string) =>
  `gh run download ${run} -R ${repo} -n refusal-records -D /tmp/records && cp /tmp/records/api-versions.json ${API_VERSIONS_RECORD}`;

function take(out: string) {
  // argocd --core reads the kube context's namespace: a copy of the kubeconfig with Argo CD's.
  const dir = mkdtempSync(join(tmpdir(), 'api-versions-'));
  const kubeconfig = join(dir, 'config');
  writeFileSync(kubeconfig, execFileSync('kubectl', ['config', 'view', '--raw', '--minify'], { encoding: 'utf-8' }));
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  execFileSync('kubectl', ['config', 'set-context', '--current', '--namespace', 'argocd'], { env, stdio: 'ignore' });
  let why = '';
  // Argo CD refreshes its clusters' info every ten seconds: three minutes is enough for a cache that just synced.
  for (let attempt = 0; attempt < 18; attempt++) {
    try {
      const json = execFileSync(
        'argocd',
        ['cluster', 'get', 'https://kubernetes.default.svc', '--core', '-o', 'json'],
        { env, encoding: 'utf-8', timeout: 60_000 },
      );
      const record = recordOf(JSON.parse(json));
      if (typeof record !== 'string') {
        writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
        console.log(`${record.apiVersions.length} API versions, from Argo CD's cluster cache, in ${out}`);
        return;
      }
      why = record;
    } catch (error) {
      why = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
    }
    execFileSync('sleep', ['10']);
  }
  throw new Error(`no API versions from Argo CD: ${why}`);
}

function check(file: string) {
  const taken = JSON.parse(readFileSync(file, 'utf-8')) as Record;
  let record: Record;
  try {
    record = JSON.parse(readFileSync(join(ROOT, API_VERSIONS_RECORD), 'utf-8')) as Record;
  } catch {
    record = { apiVersions: [] };
  }
  const changed = differences(record, taken);
  if (!changed.length) {
    console.log(`${API_VERSIONS_RECORD} is the cluster's: ${taken.apiVersions.length} API versions`);
    return;
  }
  for (const line of changed) console.log(line);
  const command = retake(process.env.GITHUB_RUN_ID ?? '<this run>', process.env.GITHUB_REPOSITORY ?? '<owner/name>');
  console.log(
    `::error::${API_VERSIONS_RECORD} is not this cluster's (${changed.length} differ). Retake it from this run, and commit it: ${command}`,
  );
  process.exitCode = 1;
}

if (import.meta.main) {
  const [verb, file] = process.argv.slice(2);
  if (verb === 'take' && file) take(file);
  else if (verb === 'check' && file) check(file);
  else {
    console.error('usage: node scripts/api-versions.ts take|check <file>');
    process.exitCode = 2;
  }
}
