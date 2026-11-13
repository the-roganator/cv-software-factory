/**
 * What the dependency sense sends triage (milestone 7, task 35): one `dependency` signal for each of the app's moves in
 * the lane `line` that has a target, which triage makes a ticket of. A move with no target sends nothing, and nor does
 * any other lane's: those are the GitHub worker's, Dependabot's or Martin's.
 *
 * A pure function of the read, the same read always giving the same signals under the same ids. **The same send** is
 * one move of one repository from one run of the scan: its id is derived from those three (`sendId`), so a sense
 * restarted on the same day, as every deploy of the `factory` image restarts it, sends each again under the same id, and
 * the inbox keeps the first. The inbox's id alone cannot say so for long: the hourly prune deletes counted signals, so
 * triage says it too, counting a signal that says what its ticket's last said once more at most, and appending nothing
 * (`moveSays`). A new run of the scan is a new send, which counts on the ticket, or joins it when its target or findings
 * changed.
 *
 * A lockfile's move is sent by its package, which the read takes from the alerts (`withheld`), in the `npm` ecosystem,
 * and only it: the public views withhold the name of an `npm` move. An image's move is `docker`, and Node's own binary
 * `node`. An advisory's text never reaches a signal: only the fixed fields the alerts' grammar reads, each checked
 * against the signal's own shape, and a finding that does not fit is counted with the rest, never sent.
 */
import type { InboxSignal } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import { uuidFrom } from '@software-factory/triage/events';
import type { MoveFinding, Moves, ReadMove } from '../github/scanning.ts';
import { readTarget, type Target } from '../vulnerabilities/fixes.ts';
import type { Severity } from '../vulnerabilities/sarif.ts';

/** A signal for the inbox, with the id that makes a send the same send. */
export interface Send {
  id: string;
  signal: InboxSignal;
}

type Move = NonNullable<InboxSignal['move']>;
type Scan = Extract<NonNullable<InboxSignal['evidence']>[number], { kind: 'scan' }>;
type Rating = Scan['findings'][number]['severity']['scanner'];

/** The most findings a signal names, worst first: the rest are counted (`signal.received`'s scan evidence). */
const MOST_FINDINGS = 8;
/** The most pins a signal's move names. */
const MOST_PINS = 40;

const RATING: Record<Severity, Rating> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'unknown',
};
const ORDER: Rating[] = ['critical', 'high', 'medium', 'low', 'unknown'];

/** The id of a move's send: its repository, the scan's run and the move's name and ecosystem. */
export const sendId = (repository: string, run: number, move: Pick<Move, 'name' | 'ecosystem'>) =>
  uuidFrom(`dependency:${repository}:${run}:${move.ecosystem}:${move.name}`);

/** A target as one word: a version, or several joined; an image's tag and digest; a tool's version. */
function targetWord(target: Target | undefined): string | undefined {
  switch (target?.kind) {
    case 'version':
      return target.versions.join(',');
    case 'image':
      return `${target.tag}@${target.digest}`;
    case 'tool':
      return target.version;
    default:
      // A chart, k3s, or a line no longer built: no pin of the app's moves to one.
      return undefined;
  }
}

/** The versions a finding's fix names, as a signal's finding gives them. */
function fixedOf(fix: string): string | undefined {
  const target = readTarget(fix);
  if (target?.kind === 'version') return target.versions.join(', ');
  if (target?.kind === 'image') return target.tag;
  if (target?.kind === 'tool') return target.version;
  return undefined;
}

/** A read move as the signal names it, or undefined when it has no target to move to. */
function moveOf(repository: string, read: ReadMove): Move | undefined {
  if (read.lockfile) {
    const withheld = read.withheld;
    // The alerts give the package's target in the scan's grammar (`version 1.0.1`).
    const to = withheld && targetWord(readTarget(withheld.to));
    if (!withheld || !to || !withheld.from) return undefined;
    return { repository, name: withheld.package, ecosystem: 'npm', from: withheld.from, to, pins: withheld.pins };
  }
  const target = readTarget(read.to);
  const to = targetWord(target);
  if (!to || !read.from) return undefined;
  const ecosystem = target?.kind === 'image' ? 'docker' : read.name === 'node' ? 'node' : undefined;
  if (!ecosystem) return undefined;
  return { repository, name: read.name, ecosystem, from: read.from, to, pins: read.pins };
}

/** The scan's evidence of a move: its findings worst first, at most eight, and the rest, the move leaves among them. */
function scanOf(read: ReadMove, fits: (finding: Scan['findings'][number]) => boolean): Scan {
  const rest = Object.fromEntries(ORDER.map((r) => [r, 0])) as Scan['rest'];
  const findings: Scan['findings'] = [];
  const sorted = [...read.findings].sort(
    (a, b) => ORDER.indexOf(RATING[a.severity]) - ORDER.indexOf(RATING[b.severity]) || a.alert - b.alert,
  );
  for (const finding of sorted) {
    const made = findingOf(finding);
    if (findings.length < MOST_FINDINGS && fits(made)) findings.push(made);
    else rest[made.severity.scanner] += 1;
  }
  for (const [rating, count] of Object.entries(read.leaves))
    rest[RATING[rating as Severity] ?? 'unknown'] += count as number;
  return { kind: 'scan', findings, rest };
}

function findingOf(finding: MoveFinding): Scan['findings'][number] {
  const fixed = fixedOf(finding.fix);
  return {
    advisory: finding.advisory,
    package: finding.package,
    severity: { scanner: RATING[finding.severity] ?? 'unknown' },
    ...(fixed && { fixed }),
  };
}

/** The signals one repository's read sends: its moves in the lane `line` with a target, each once. */
export function sendsOf(moves: Moves, observedAt: string): Send[] {
  const sends: Send[] = [];
  const seen = new Set<string>();
  for (const read of moves.moves) {
    if (read.lane !== 'line') continue;
    const move = moveOf(moves.repository, read);
    if (!move) continue;
    const id = sendId(moves.repository, moves.run.id, move);
    if (seen.has(id)) continue;
    const base = {
      sense: 'dependency',
      check: 'the vulnerability scan',
      version: moves.run.headSha,
      symptom: 'vulnerable-dependency',
      move: { ...move, pins: move.pins.slice(0, MOST_PINS) },
      observedAt,
      artifacts: [],
    } satisfies InboxSignal;
    // Each finding is checked against the signal's shape on its own: one that does not fit is counted, not sent.
    const fits = (finding: Scan['findings'][number]) =>
      validateSignal({
        ...base,
        evidence: [
          { kind: 'scan', findings: [finding], rest: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } },
        ],
      }).ok;
    const scan = scanOf(read, fits);
    if (!scan.findings.length) continue;
    const signal: InboxSignal = { ...base, evidence: [scan] };
    if (!validateSignal(signal).ok) continue;
    seen.add(id);
    sends.push({ id, signal });
  }
  return sends;
}
