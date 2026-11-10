/**
 * The daily scan's findings as one SARIF file for code scanning: a rule for each advisory, and a result for each package
 * and advisory in each item, at the line that pins the item.
 *
 * Code scanning keeps only the 5,000 most severe results of a run and drops the rest without refusing the file, so the
 * items are grouped, in the list's order, each run filled to 5,000 results, and each group is a run of its own, in a
 * category of its own: `vulnerabilities/01` to `vulnerabilities/20`, code scanning's 20 runs to a file. An item over
 * 5,000 is cut, its results in order of package and advisory, into full runs of its own, and whole items fill the run
 * its last cut begins. Every one of the 20 is in
 * every file, the unused ones empty: a category that stopped being uploaded would keep its last results open for good,
 * so a result that moves to another run as the counts before it change, or a run no longer needed, leaves nothing
 * stale. An alert is open while any configuration (here, a category) reports it, so a result that moves keeps its
 * alert.
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
  /** The item as the repository's list names it (inventory.ts's `name`), which an exception names. */
  listed?: string | undefined;
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
  /**
   * The publisher's own rating, where it gives one: Trivy's `VendorSeverity` for the advisory's own source (GitHub's
   * advisory for an npm package, the distribution's for an operating system's), or Node's for Node's own. A finding's
   * deadline is at the higher of this and `severity` (deadlines.ts).
   */
  publisher?: Severity | undefined;
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
 * refused, or has results dropped, so the scan uploads nothing instead and fails. A run is refused past 25,000 results
 * but keeps only the 5,000 most severe, so 5,000 is the limit; a file is refused past 20 runs.
 */
export const LIMITS = { gzipBytes: 10 * 1024 * 1024, runs: 20, results: 5_000, rules: 25_000, locations: 1_000 };

/** The categories' common prefix: each run's is this, a slash and its number from 01. */
export const CATEGORY = 'vulnerabilities';

/** A run's category: `vulnerabilities/01` for the first. */
export const category = (index: number) => `${CATEGORY}/${String(index + 1).padStart(2, '0')}`;

/** A run's category from its id, which is the category and a slash. */
export const categoryOf = (run: Pick<Run, 'automationDetails'>) => run.automationDetails.id.replace(/\/$/, '');

/** Strings in code-unit order, the same on every runner whatever its locale. */
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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
    if (
      finding.publisher &&
      (!seen.publisher || SEVERITIES.indexOf(finding.publisher) < SEVERITIES.indexOf(seen.publisher))
    )
      seen.publisher = finding.publisher;
    seen.score = Math.max(seen.score ?? 0, finding.score ?? 0) || undefined;
    // Each copy's fixed versions, so a copy in another version keeps its own.
    const fixes = new Set([...(seen.fixed?.split(', ') ?? []), ...(finding.fixed?.split(', ') ?? [])].filter(Boolean));
    seen.fixed = fixes.size ? [...fixes].join(', ') : undefined;
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
  runs: Run[];
}

export interface Run {
  tool: { driver: { name: string; informationUri: string; version?: string; rules: Rule[] } };
  /** The category is the id up to its last slash: `vulnerabilities/01/` is `vulnerabilities/01`. */
  automationDetails: { id: string };
  results: Result[];
  /** The items whose results the run carries, by their keys, in the list's order, a cut of one named as such. */
  properties: { items: string[] };
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

/** An item's results, or a cut of them, as a run carries them. */
export interface Part {
  findings: Finding[];
  /** For a cut of an item over the limit: which cut, from 1, and how many. */
  cut?: { at: number; of: number };
}

/** A part as the run's properties and the log name it: the item's key, and its cut where it has one. */
export const partName = (part: Part) =>
  `${part.findings[0]?.item ?? ''}${part.cut ? ` (cut ${part.cut.at} of ${part.cut.of})` : ''}`;

/**
 * The items, in the order of their first finding (the list's order), grouped so that no group carries more than
 * `limit` results: each group filled in turn with whole items. An item over the limit is cut, its results in order of
 * package and advisory, into full groups of its own, and its last cut begins a group that whole items after it fill.
 */
export function groups(merged: Finding[], limit = LIMITS.results): Part[][] {
  const byItem = new Map<string, Finding[]>();
  for (const finding of merged) {
    const seen = byItem.get(finding.item);
    if (seen) seen.push(finding);
    else byItem.set(finding.item, [finding]);
  }
  const out: Part[][] = [];
  let current: Part[] = [];
  let size = 0;
  const close = () => {
    if (current.length) out.push(current);
    current = [];
    size = 0;
  };
  for (const item of byItem.values()) {
    if (item.length > limit) {
      close();
      const sorted = [...item].sort(
        (a, b) => order(a.package, b.package) || order(a.advisory, b.advisory) || order(a.type, b.type),
      );
      const of = Math.ceil(sorted.length / limit);
      for (let at = 0; at < of; at++) {
        const findings = sorted.slice(at * limit, (at + 1) * limit);
        current = [{ findings, cut: { at: at + 1, of } }];
        size = findings.length;
        // Every cut but the last is full; the last stays open, for whole items after it.
        if (at < of - 1) close();
      }
      continue;
    }
    if (size + item.length > limit) close();
    current.push({ findings: item });
    size += item.length;
  }
  close();
  return out;
}

/** A result's message, which its alert's latest instance carries: the package, its version, the item and the advisory. */
export const messageOf = (finding: Finding) =>
  `${finding.package} ${finding.installed} in ${finding.label}: ${finding.advisory} (${finding.severity.toLowerCase()}), ${finding.fixed ? `fixed in ${finding.fixed}` : 'no fix yet'}.`;

/**
 * What tells a result's alert apart, as code scanning's API gives it back: the advisory (its rule), the file and line,
 * and the message. The fingerprint itself is not in the API's answer.
 */
export const alertKey = (finding: Finding) =>
  JSON.stringify([finding.advisory, finding.file, Math.max(1, finding.line), messageOf(finding)]);

/** One run: a group's results and the rules they name, in its category. */
function run(group: Part[], index: number, trivyVersion?: string): Run {
  const merged = group
    .flatMap((part) => part.findings)
    .sort((a, b) => order(a.advisory, b.advisory) || order(a.item, b.item) || order(a.package, b.package));
  const rules: Rule[] = [];
  const ruleAt = new Map<string, number>();
  for (const finding of merged) {
    const at = ruleAt.get(finding.advisory);
    const score = Math.max(finding.score ?? 0, SCORE[finding.severity]);
    if (at !== undefined) {
      // One rule per advisory, at the highest severity any of its results has.
      const rule = rules[at];
      if (rule && Number(rule.properties['security-severity']) < score)
        rule.properties['security-severity'] = score.toFixed(1);
      continue;
    }
    ruleAt.set(finding.advisory, rules.length);
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
    ruleIndex: ruleAt.get(finding.advisory) ?? 0,
    level: LEVEL[finding.severity],
    message: { text: messageOf(finding) },
    locations: [
      {
        physicalLocation: { artifactLocation: { uri: finding.file }, region: { startLine: Math.max(1, finding.line) } },
      },
    ],
    partialFingerprints: { [FINGERPRINT]: fingerprint(finding) },
  }));
  return {
    tool: {
      driver: {
        name: 'Trivy',
        informationUri: 'https://github.com/aquasecurity/trivy',
        ...(trivyVersion ? { version: trivyVersion } : {}),
        rules,
      },
    },
    automationDetails: { id: `${category(index)}/` },
    results,
    properties: { items: group.map(partName) },
  };
}

/**
 * The SARIF for a repository's findings, the proof's left out by the caller: a run for each group of items, and an
 * empty one for each category up to the limit on runs, so every category is uploaded every time.
 */
export function sarif(findings: Finding[], trivyVersion?: string, limits = LIMITS): Sarif {
  const grouped = groups(merge(findings), limits.results);
  const runs = grouped.map((group, index) => run(group, index, trivyVersion));
  for (let index = runs.length; index < limits.runs; index++) runs.push(run([], index, trivyVersion));
  return { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs };
}

/** Each of code scanning's limits the file passes, named; none when it can be uploaded whole. */
export function overLimits(file: Sarif, limits = LIMITS): string[] {
  const problems: string[] = [];
  const bytes = gzipSync(JSON.stringify(file)).length;
  if (bytes > limits.gzipBytes) problems.push(`${bytes} bytes gzipped, over ${limits.gzipBytes}`);
  if (file.runs.length > limits.runs) problems.push(`${file.runs.length} runs, over ${limits.runs}`);
  // Code scanning refuses a file with two runs of one tool in one category.
  const names = file.runs.map(categoryOf);
  const twice = [...new Set(names.filter((name, at) => names.indexOf(name) !== at))];
  if (twice.length) problems.push(`more than one run in ${twice.join(', ')}`);
  for (const run of file.runs) {
    const name = categoryOf(run);
    if (run.results.length > limits.results)
      problems.push(`${name}: ${run.results.length} results, over ${limits.results}`);
    if (run.tool.driver.rules.length > limits.rules)
      problems.push(`${name}: ${run.tool.driver.rules.length} rules, over ${limits.rules}`);
    if (run.results.some((result) => result.locations.length > limits.locations))
      problems.push(`${name}: a result with more than ${limits.locations} locations`);
  }
  return problems;
}
