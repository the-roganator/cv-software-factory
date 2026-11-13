/**
 * The exceptions as the daily scan reads them: which entries of `policy/vulnerabilities.ts` a repository's findings
 * meet, which of its entries except nothing and why, and the `osv-scanner.toml` the policy gives a repository.
 *
 * Node runs this with no dependencies, from a sparse checkout of this repository, whose policy the workflow replaces
 * with `main`'s before anything runs, so the caller's pinned commit cannot hold an exception `main` does not.
 */

import type * as POLICY from '../../../../policy/vulnerabilities.ts';
import type { Exception } from '../../../../policy/vulnerabilities.ts';
import { alertKey, type Finding, fingerprint, merge } from './sarif.ts';

/** policy/vulnerabilities.ts, or the same functions over other entries, for the tests. */
export type Policy = typeof POLICY;

/** An entry as the log names it: never its reason, which is Martin's to read in the file. */
const entryName = (entry: Exception) => `${entry.item}: ${entry.package} ${entry.advisory}`;

/**
 * Each of a repository's entries that excepts nothing, and why: one that has expired or is further off than the policy
 * allows, or whose item is not on the repository's list (`names`, the list's names). The scan logs each, to be removed.
 */
export function idle(policy: Policy, repository: string, names: string[], today: Date | string = new Date()) {
  const listed = new Set(names.map(policy.withoutDigest));
  return policy.EXCEPTIONS.filter((entry) => entry.repository === repository).flatMap((entry) => {
    const why =
      policy.lapsed(entry, today) ??
      (listed.has(policy.withoutDigest(entry.item)) ? undefined : 'its item is not on the list');
    return why ? [{ entry, why }] : [];
  });
}

const HEADER = [
  "# Generated from policy/vulnerabilities.ts on cv-software-factory's main by scripts/osv-scanner.ts: do not edit.",
  '# Each advisory excepted for an item of this repository, until its earliest expiry, for Scorecard. The daily scan',
  '# warns when this file and the policy differ.',
];

/** A string as TOML writes it, in double quotes. */
const quoted = (text: string) => JSON.stringify(text);

/**
 * The `osv-scanner.toml` the policy gives a repository: an `IgnoredVulns` for each advisory an entry in force excepts
 * there, until the earliest expiry among them, its reason each item's. OSV-Scanner ignores an advisory across the
 * repository, so this is Scorecard's view alone: the scan and the gate match each entry to its item.
 */
export function osvScannerToml(policy: Policy, repository: string, today: Date | string = new Date()) {
  const byAdvisory = new Map<string, Exception[]>();
  for (const entry of policy.EXCEPTIONS)
    if (entry.repository === repository && !policy.lapsed(entry, today))
      byAdvisory.set(entry.advisory, [...(byAdvisory.get(entry.advisory) ?? []), entry]);
  const blocks = [...byAdvisory.keys()].sort().map((advisory) => {
    const entries = byAdvisory.get(advisory) ?? [];
    const until = entries.map((entry) => entry.expires).sort()[0];
    const reason = entries.map((entry) => `${entry.item} (${entry.package}): ${entry.reason}`).join(' ');
    return [
      '',
      '[[IgnoredVulns]]',
      `id = ${quoted(advisory)}`,
      `ignoreUntil = ${until}T23:59:59Z`,
      `reason = ${quoted(reason)}`,
    ].join('\n');
  });
  return `${[...HEADER, ...blocks].join('\n')}\n`;
}

/**
 * What the policy makes of a repository's findings on the day given: the comment each excepted result's alert is
 * dismissed with, by its alert's key (sarif.ts), the log's lines, and its warnings: each entry that excepts nothing,
 * and an `osv-scanner.toml` (`current`, the checkout's, or undefined for none) that differs from the policy's.
 */
export function judge(
  policy: Policy,
  repository: string,
  names: string[],
  findings: Finding[],
  current: string | undefined,
  today: Date | string = new Date(),
) {
  const excepted = new Map<string, string>();
  const lines: string[] = [];
  const warnings: string[] = [];
  const entries = policy.EXCEPTIONS.filter((entry) => entry.repository === repository);
  const used = new Set<Exception>();
  // A result is every finding with its fingerprint (sarif.ts's `merge`): two stages of one Dockerfile on two tags of
  // one image are one result. It is excepted only when an entry in force covers every one of them, so an exception for
  // one stage's image never dismisses the other's finding.
  const byResult = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = fingerprint(finding);
    byResult.set(key, [...(byResult.get(key) ?? []), finding]);
  }
  const results = new Map(merge(findings).map((result) => [fingerprint(result), result]));
  for (const [key, group] of byResult) {
    const found = group.map((finding) =>
      policy.exceptionFor(
        entries,
        { repository, item: finding.listed ?? '', package: finding.package, advisory: finding.advisory },
        today,
      ),
    );
    const [entry] = found;
    const result = results.get(key);
    if (!entry || !result || found.some((each) => !each)) continue;
    for (const each of found) if (each) used.add(each);
    excepted.set(alertKey(result), policy.dismissal(entry));
  }
  const unused = idle(policy, repository, names, today);
  lines.push(
    `Exceptions: ${entries.length} for ${repository} in policy/vulnerabilities.ts on main, ${entries.length - unused.length} in force, excepting ${excepted.size} ${excepted.size === 1 ? 'result' : 'results'}.`,
  );
  for (const { entry, why } of unused)
    warnings.push(
      `The exception for ${entryName(entry)} excepts nothing, ${why}: remove it from policy/vulnerabilities.ts.`,
    );
  for (const entry of entries)
    if (!used.has(entry) && !unused.some((idle) => idle.entry === entry))
      lines.push(`  The exception for ${entryName(entry)} met no finding today.`);
  const wanted = osvScannerToml(policy, repository, today);
  if (current !== wanted)
    warnings.push(
      current === undefined
        ? `The repository has no osv-scanner.toml: \`node scripts/osv-scanner.ts ${repository}\` writes the one the policy gives it.`
        : `osv-scanner.toml differs from the policy's: \`node scripts/osv-scanner.ts ${repository} > osv-scanner.toml\` writes it again.`,
    );
  return { excepted, lines, warnings };
}

/**
 * What is wrong with the entries, as `make check` holds them, on the day given: an entry with no reason, an expiry not
 * a day or more than the policy's days away, a repository not among `repositories`, an advisory that is not a CVE or GHSA
 * id, or an item not on its repository's list (`lists`, the list's names by repository; one with no list given is not
 * checked against it), or on it more than once. An expired entry is the scan's to report, not a fault here.
 */
export function problems(
  policy: Policy,
  repositories: readonly string[],
  lists: Record<string, string[] | undefined>,
  today: Date | string = new Date(),
) {
  const found: string[] = [];
  for (const entry of policy.EXCEPTIONS) {
    const name = entryName(entry);
    if (!entry.reason?.trim()) found.push(`${name}: it gives no reason`);
    // An expired entry is the scan's to report; every other lapse is a fault in the entry.
    const day = typeof today === 'string' ? today : today.toISOString().slice(0, 10);
    const why = policy.lapsed(entry, today);
    if (why && !(entry.expires < day && !policy.lapsed(entry, entry.expires))) found.push(`${name}: ${why}`);
    const same = policy.EXCEPTIONS.filter(
      (other) =>
        other.repository === entry.repository &&
        policy.withoutDigest(other.item) === policy.withoutDigest(entry.item) &&
        other.package === entry.package &&
        other.advisory === entry.advisory,
    );
    if (same.length > 1 && same[0] === entry)
      found.push(`${name}: it is excepted by ${same.length} entries: renew one by its expiry, and remove the rest`);
    if (!repositories.includes(entry.repository))
      found.push(`${name}: ${entry.repository} is not one of the repositories`);
    if (!policy.ADVISORY.test(entry.advisory)) found.push(`${name}: ${entry.advisory} is not a CVE or GHSA id`);
    if (!entry.package?.trim()) found.push(`${name}: it names no package`);
    const list = lists[entry.repository];
    if (list) {
      const on = list.filter((item) => policy.withoutDigest(item) === policy.withoutDigest(entry.item)).length;
      if (!on) found.push(`${name}: ${entry.item} is not on ${entry.repository}'s list`);
      if (on > 1) found.push(`${name}: ${entry.item} names ${on} items on ${entry.repository}'s list, not one`);
    }
  }
  return found;
}
