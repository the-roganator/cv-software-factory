/**
 * The daily scan's findings as one SARIF file for code scanning, category `vulnerabilities`: a rule for each advisory,
 * and a result for each package and advisory in each item, at the line that pins the item.
 *
 * A result's `partialFingerprints` are the item, the package and the advisory, never the line, the version or the
 * image's digest, so moving a pin that leaves the finding keeps its alert, and moving it past the fix closes it. An
 * image's copy of a package is its own result, never folded into a lockfile's, so a finding excepted in one place is
 * still seen in another, and the same package in an image's two platforms is one result.
 *
 * Node runs this with no dependencies, from a sparse checkout of this repository.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** A package and an advisory in one item, as the scan read it from Trivy's JSON. */
export interface Finding {
  /** The item, as its alerts know it: what stays the same when its pin moves (scan.ts's `itemKey`). */
  item: string;
  /** The item as the message names it: an image with its digest, a lockfile's path, a chart's image. */
  label: string;
  /** The line that pins it, where the alert is located. */
  file: string;
  line: number;
  /** Trivy's type of the result the package was in: `pnpm`, `debian`, `node-pkg`, `nodejs`… */
  type: string;
  package: string;
  installed: string;
  fixed?: string | undefined;
  advisory: string;
  severity: Severity;
  title?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  /** The highest CVSS base score any source gives, for code scanning's own severity. */
  score?: number | undefined;
}

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

/**
 * Code scanning's limits for one upload (GitHub's "SARIF support for code scanning"): an upload past any of them is
 * refused, or has results dropped, so the scan uploads nothing instead and fails.
 */
export const LIMITS = { gzipBytes: 10 * 1024 * 1024, results: 25_000, rules: 25_000, locations: 1_000 };

const FINGERPRINT = 'vulnerabilities/v1';

/** The alert a finding is: its item, its package (with the kind of result it is in) and its advisory. */
export function fingerprint(finding: Pick<Finding, 'item' | 'type' | 'package' | 'advisory'>) {
  return createHash('sha256')
    .update(JSON.stringify([finding.item, finding.type, finding.package, finding.advisory]))
    .digest('hex');
}

/**
 * Findings with the same fingerprint, as one: an image's two platforms, or two copies of a package in one image, give
 * one result, naming each version found, with the worst severity and the highest score.
 */
export function merge(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = fingerprint(finding);
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...finding });
      continue;
    }
    const versions = new Set([...seen.installed.split(', '), finding.installed]);
    seen.installed = [...versions].sort().join(', ');
    if (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(seen.severity)) seen.severity = finding.severity;
    seen.score = Math.max(seen.score ?? 0, finding.score ?? 0) || undefined;
    seen.fixed ??= finding.fixed;
  }
  return [...byKey.values()];
}

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  CRITICAL: 'error',
  HIGH: 'error',
  MEDIUM: 'warning',
  LOW: 'note',
  UNKNOWN: 'note',
};

/** Code scanning's own severity reads `security-severity`, a CVSS score: Trivy's rating where no score is given. */
const SCORE: Record<Severity, number> = { CRITICAL: 9.5, HIGH: 8.0, MEDIUM: 5.5, LOW: 2.0, UNKNOWN: 0.0 };

export interface Sarif {
  version: '2.1.0';
  $schema: string;
  runs: {
    tool: { driver: { name: string; informationUri: string; version?: string; rules: Rule[] } };
    results: Result[];
  }[];
}

interface Rule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri?: string;
  help: { text: string; markdown: string };
  properties: { tags: string[]; precision: 'very-high'; 'security-severity': string };
}

interface Result {
  ruleId: string;
  ruleIndex: number;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[];
  partialFingerprints: Record<string, string>;
}

/** The SARIF for a repository's findings, the proof's left out by the caller. */
export function sarif(findings: Finding[], trivyVersion?: string): Sarif {
  const merged = merge(findings).sort(
    (a, b) =>
      a.advisory.localeCompare(b.advisory) || a.item.localeCompare(b.item) || a.package.localeCompare(b.package),
  );
  const rules: Rule[] = [];
  const index = new Map<string, number>();
  for (const finding of merged) {
    const at = index.get(finding.advisory);
    const score = Math.max(finding.score ?? 0, SCORE[finding.severity]);
    if (at !== undefined) {
      // One rule per advisory, at the highest severity any of its results has.
      const rule = rules[at];
      if (rule && Number(rule.properties['security-severity']) < score)
        rule.properties['security-severity'] = score.toFixed(1);
      continue;
    }
    index.set(finding.advisory, rules.length);
    const title = finding.title ?? finding.advisory;
    rules.push({
      id: finding.advisory,
      name: finding.advisory,
      shortDescription: { text: `${finding.advisory}: ${title}`.slice(0, 1024) },
      fullDescription: { text: (finding.description ?? title).slice(0, 4096) },
      ...(finding.url ? { helpUri: finding.url } : {}),
      help: {
        text: `${finding.advisory}: ${title}${finding.url ? `\n${finding.url}` : ''}`,
        markdown: `**${finding.advisory}**: ${title}${finding.url ? `\n\n[${finding.url}](${finding.url})` : ''}`,
      },
      properties: {
        tags: ['security', 'vulnerability'],
        precision: 'very-high',
        'security-severity': score.toFixed(1),
      },
    });
  }
  const results: Result[] = merged.map((finding) => ({
    ruleId: finding.advisory,
    ruleIndex: index.get(finding.advisory) ?? 0,
    level: LEVEL[finding.severity],
    message: {
      text: `${finding.package} ${finding.installed} in ${finding.label}: ${finding.advisory} (${finding.severity.toLowerCase()}), ${finding.fixed ? `fixed in ${finding.fixed}` : 'no fix yet'}.`,
    },
    locations: [
      {
        physicalLocation: { artifactLocation: { uri: finding.file }, region: { startLine: Math.max(1, finding.line) } },
      },
    ],
    partialFingerprints: { [FINGERPRINT]: fingerprint(finding) },
  }));
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'Trivy',
            informationUri: 'https://github.com/aquasecurity/trivy',
            ...(trivyVersion ? { version: trivyVersion } : {}),
            rules,
          },
        },
        results,
      },
    ],
  };
}

/** Each of code scanning's limits the file passes, named; none when it can be uploaded whole. */
export function overLimits(file: Sarif, limits = LIMITS): string[] {
  const problems: string[] = [];
  const bytes = gzipSync(JSON.stringify(file)).length;
  if (bytes > limits.gzipBytes) problems.push(`${bytes} bytes gzipped, over ${limits.gzipBytes}`);
  for (const run of file.runs) {
    if (run.results.length > limits.results) problems.push(`${run.results.length} results, over ${limits.results}`);
    if (run.tool.driver.rules.length > limits.rules)
      problems.push(`${run.tool.driver.rules.length} rules, over ${limits.rules}`);
    if (run.results.some((result) => result.locations.length > limits.locations))
      problems.push(`a result with more than ${limits.locations} locations`);
  }
  return problems;
}
