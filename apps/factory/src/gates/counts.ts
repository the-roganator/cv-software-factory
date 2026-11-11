/**
 * What a scan gate counted, before and after the change, by severity: the notice the lockfile scan and the image scan
 * each write on their check run, and the only place the line takes the counts it records on `gate.finished` from
 * (`../line/gates.ts`), never a number a pull request or an agent states of itself.
 *
 * The notice is counts alone, never a package or an advisory, so it says nothing on a public run that code scanning
 * does not already. It is written and parsed here, by one fixed grammar:
 *
 *     Lockfile scan counted, before: critical 0, high 2, medium 5, low 11, unknown 0; after: critical 0, high 0, …
 *
 * A message that does not fit it exactly is no counts, never zero. A gate writes it only when it read every side it
 * compares: a lockfile it could not judge, or a report it could not read, leaves the run with no notice at all.
 *
 * Node alone: the gates run from a sparse checkout with no dependencies.
 */

/** Trivy's severities, as the counts name them: a finding of any other rating is counted as `unknown`. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Counts = Record<Severity, number>;

/** GitHub Actions, as GitHub names the app behind a check run: the only app whose runs' notices are taken. */
export const ACTIONS_APP = 'github-actions';

/** The scans that count, by the name of their job, and the word their notice starts with. */
export const SCANS = { 'lockfile scan': 'Lockfile scan', 'image scan': 'Image scan' } as const;
export type Scan = keyof typeof SCANS;

export interface ScanCounts {
  before: Counts;
  after: Counts;
}

/** Each finding's severity, as Trivy rates it (`CRITICAL`, `HIGH`, …), counted. */
export function countBySeverity(severities: readonly string[]): Counts {
  const counts: Counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const rated of severities) {
    const severity = rated.toLowerCase();
    const known = (SEVERITIES as readonly string[]).includes(severity) ? (severity as Severity) : 'unknown';
    counts[known] += 1;
  }
  return counts;
}

const side = (counts: Counts) => SEVERITIES.map((s) => `${s} ${counts[s]}`).join(', ');

/** The notice a scan writes of what it counted. */
export function countsNote(scan: Scan, { before, after }: ScanCounts): string {
  return `${SCANS[scan]} counted, before: ${side(before)}; after: ${side(after)}`;
}

// Each count is at most six digits, 999,999: more than any scan finds, and few enough to read plainly.
const SIDE = SEVERITIES.map((s) => `${s} (0|[1-9]\\d{0,5})`).join(', ');
const NOTE = new RegExp(`^(${Object.values(SCANS).join('|')}) counted, before: ${SIDE}; after: ${SIDE}$`);

/** The scan and counts a notice gives, or nothing when it does not fit the grammar exactly. */
export function parseCounts(message: string): { scan: Scan; counts: ScanCounts } | undefined {
  const match = NOTE.exec(message);
  if (!match) return undefined;
  const scan = (Object.keys(SCANS) as Scan[]).find((s) => SCANS[s] === match[1]);
  const numbers = match.slice(2).map(Number);
  if (!scan) return undefined;
  const of = (offset: number) =>
    Object.fromEntries(SEVERITIES.map((s, i) => [s, numbers[offset + i] as number])) as Counts;
  return { scan, counts: { before: of(0), after: of(SEVERITIES.length) } };
}

/**
 * The scan a check is, by its name: the job's own (`lockfile scan`), or the app's call of it (`gates / lockfile scan`).
 */
export function scanOfCheck(name: string): Scan | undefined {
  return (Object.keys(SCANS) as Scan[]).find((scan) => name === scan || name.endsWith(` / ${scan}`));
}

/**
 * A check run's counts, from the notices on it: those its own scan wrote, all alike. A run of another scan's, or of
 * no scan, gives none; so do two notices that disagree, one in the scan's words that does not parse, and a run with
 * no notice of its scan's at all.
 */
export function countsOfCheck(name: string, notices: readonly string[]): ScanCounts | undefined {
  const scan = scanOfCheck(name);
  if (!scan) return undefined;
  const ours = notices.filter((message) => message.startsWith(`${SCANS[scan]} counted`));
  const read = ours.map(parseCounts);
  const [first] = read;
  if (!first || read.some((p) => p?.scan !== scan || countsNote(scan, p.counts) !== countsNote(scan, first.counts)))
    return undefined;
  return first.counts;
}
