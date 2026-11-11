/**
 * The advisories dependency review allows: the GHSA id of each entry of `policy/vulnerabilities.ts` in force for one of
 * the repository's lockfiles (./exceptions.ts), as the lockfile scan excepts each for its own lockfile.
 *
 *     node apps/factory/src/gates/dependency-allow.ts
 *
 * It reads GITHUB_REPOSITORY, the repository the gate judges, and writes `ghsas`, the ids comma-separated, to
 * GITHUB_OUTPUT, for the action's `allow-ghsas`. Dependency review knows a vulnerability by its GHSA id alone, where an
 * entry names the advisory as Trivy does, often by its CVE id, so each entry's id is looked up in GitHub's advisory
 * database (`GET /advisories`, with GITHUB_TOKEN), for the entry's package in npm: an advisory that does not affect
 * that package allows nothing, and an id the database does not hold is named in a warning. The action allows an id
 * whatever package and lockfile it is found in; the lockfile scan, beside it, still holds each entry to its own.
 *
 * The workflow puts `main`'s policy in place of the checkout's before this runs, so nothing in the change allows
 * anything. Node alone runs this, from a sparse checkout with no dependencies.
 */
import { appendFileSync } from 'node:fs';
import { ADVISORY, EXCEPTIONS, type Exception } from '../../../../policy/vulnerabilities.ts';
import { lockfileEntries } from './exceptions.ts';
import { annotate, summarise } from './report.ts';

/** The GHSA ids of the advisories with an id (a CVE or GHSA id) that affect a package in npm. */
export type Lookup = (advisory: string, pkg: string) => Promise<string[]>;

const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GitHub's global advisory database, asked once for each entry, three times before it gives up: a second, then four,
 * apart, or as long as a rate limit's `retry-after` asks, up to a minute.
 */
export function githubLookup(
  token: string | undefined,
  fetcher: typeof fetch = fetch,
  wait: (ms: number) => Promise<unknown> = pause,
): Lookup {
  return async (advisory, pkg) => {
    const query = new URLSearchParams({
      [advisory.startsWith('GHSA-') ? 'ghsa_id' : 'cve_id']: advisory,
      ecosystem: 'npm',
      affects: pkg,
      per_page: '100',
    });
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      let after = 1000 * 4 ** attempt;
      try {
        const response = await fetcher(`https://api.github.com/advisories?${query}`, {
          headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        });
        if (response.ok) {
          const body: unknown = await response.json();
          return Array.isArray(body) ? body.map((a) => (a as { ghsa_id?: unknown })?.ghsa_id).map(String) : [];
        }
        last = `${response.status} ${response.statusText}`;
        const asked = Number(response.headers.get('retry-after'));
        if (Number.isFinite(asked) && asked > 0) after = Math.min(asked, 60) * 1000;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      if (attempt < 2) await wait(after);
    }
    throw new Error(`GitHub's advisory database could not be read for ${advisory} in ${pkg}: ${last}`);
  };
}

/**
 * The GHSA ids the entries in force for the repository's lockfiles allow, on the day given, and each entry the
 * database holds no advisory for: only ids GitHub writes, so nothing else reaches the action's input.
 */
export async function allowed(
  repository: string,
  lookup: Lookup,
  entries: readonly Exception[] = EXCEPTIONS,
  today: Date | string = new Date(),
) {
  const ghsas = new Set<string>();
  const unknown: Exception[] = [];
  const used: Exception[] = [];
  const inForce = lockfileEntries(repository, entries, today);
  // Each entry asked at once; an id that is not a CVE or GHSA id is not asked for, and allows nothing.
  const answers = await Promise.all(
    inForce.map(async (entry) =>
      ADVISORY.test(entry.advisory) ? (await lookup(entry.advisory, entry.package)).filter((id) => GHSA.test(id)) : [],
    ),
  );
  inForce.forEach((entry, at) => {
    const found = answers[at] ?? [];
    (found.length ? used : unknown).push(entry);
    for (const id of found) ghsas.add(id);
  });
  return { ghsas: [...ghsas].sort(), used, unknown };
}

export async function main(): Promise<number> {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  let result: Awaited<ReturnType<typeof allowed>>;
  try {
    result = await allowed(repository, githubLookup(process.env.GITHUB_TOKEN));
  } catch (error) {
    annotate('error', error instanceof Error ? error.message : String(error));
    return 1;
  }
  const { ghsas, used, unknown } = result;
  for (const entry of unknown)
    annotate(
      'warning',
      `GitHub's advisory database holds no advisory ${entry.advisory} for ${entry.package} in npm, or it is not a CVE or GHSA id: dependency review allows nothing for the exception for ${entry.item}.`,
    );
  const line = `Dependency review allows ${ghsas.length} ${ghsas.length === 1 ? 'advisory' : 'advisories'}, for ${used.length} ${used.length === 1 ? 'exception' : 'exceptions'} in force for ${repository || 'no repository'}'s lockfiles in policy/vulnerabilities.ts on main${ghsas.length ? `: ${ghsas.join(', ')}` : ''}.`;
  console.log(line);
  await summarise(`## Dependency review's exceptions\n\n${line}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ghsas=${ghsas.join(',')}\n`);
  return 0;
}

if (import.meta.main) process.exitCode = await main();
