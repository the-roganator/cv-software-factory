/**
 * The day, as `patching.read` holds it: a pure function of what the GitHub worker read for each repository (its moves,
 * checked against its alerts, and its open Dependabot pull requests) and of the rows the cluster's comparison made.
 *
 * A move keeps what `moves.json` says of it. A lockfile's move, which the artifact names by its file alone, carries its
 * package apart (`package`), from its alerts, for the public view to leave out until a pull request moving it is open.
 * A move whose pin an open Dependabot pull request moves names it (`pullRequest`), matched by the dependency its branch
 * names and the directory of one of the move's pins.
 *
 * Why a scan failed is what its moves show: one past its deadline, one due within a day of when it judged them, a new
 * High or Critical with a fix; and `other` when none does, or it wrote no moves at all. The scan's log is the reason's
 * own words; the sense reads no log.
 */
import type { MoveLane, PayloadOf, ScanFailure, ScanSeverity } from '@software-factory/events';
import type { DependencyPull } from '../github/dependabot.ts';
import type { Moves, ReadMove } from '../github/scanning.ts';
import type { Counts } from '../vulnerabilities/moves.ts';
import type { Row } from './compare.ts';

export type Day = PayloadOf<'patching.read'>;
type DayMove = Day['repositories'][number]['moves'][number];

/** What the worker read for one repository. */
export interface RepositoryRead {
  moves: Moves;
  pulls: DependencyPull[];
}

const DAY_MS = 86_400_000;

const counts = (from: Counts): Record<ScanSeverity, number> => ({
  critical: from.CRITICAL,
  high: from.HIGH,
  medium: from.MEDIUM,
  low: from.LOW,
  unknown: from.UNKNOWN,
});

/** A Dependabot branch's dependency as a move names it: an image without its registry's defaults. */
const bare = (name: string) => name.replace(/^docker\.io\//, '').replace(/^library\//, '');

/** A pin's directory as `dependabot.yml` writes one: `/` for the root. */
const directoryOf = (file: string) => `/${file.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '') || '/';

/** The open Dependabot pull request that moves a move's pin, if one does. */
function pullFor(move: ReadMove, pulls: DependencyPull[]): DayMove['pullRequest'] {
  const name = bare(move.withheld?.package ?? move.name.split(/[:@]/)[0] ?? move.name);
  const directories = new Set((move.withheld?.pins ?? move.pins).map((pin) => directoryOf(pin.file)));
  const pull = pulls.find(
    (p) => p.dependency !== null && bare(p.dependency) === name && p.directory !== null && directories.has(p.directory),
  );
  return pull?.version ? { number: pull.number, version: pull.version } : undefined;
}

function dayMove(move: ReadMove, pulls: DependencyPull[]): DayMove {
  const pullRequest = pullFor(move, pulls);
  return {
    name: move.name,
    pins: move.pins,
    from: move.from,
    to: move.to,
    major: move.major,
    clears: counts(move.clears),
    leaves: counts(move.leaves),
    ...(move.deadline ? { deadline: move.deadline } : {}),
    newToday: move.newToday,
    lane: move.lane as MoveLane,
    lockfile: move.lockfile,
    ...(move.lockfile && move.withheld
      ? {
          package: {
            name: move.withheld.package,
            from: move.withheld.from,
            to: move.withheld.to,
            pins: move.withheld.pins,
          },
        }
      : {}),
    ...(pullRequest ? { pullRequest } : {}),
  };
}

/** Why a scan that did not pass failed, as its moves show it. */
export function failures(conclusion: string | null, judged: string | null, moves: DayMove[]): ScanFailure[] {
  if (conclusion === 'success') return [];
  const at = judged ? Date.parse(judged) : Number.NaN;
  const found: ScanFailure[] = [];
  const due = moves.map((m) => (m.deadline ? Date.parse(m.deadline) : Number.POSITIVE_INFINITY));
  if (!Number.isNaN(at)) {
    if (due.some((d) => d <= at)) found.push('overdue');
    if (due.some((d) => d > at && d <= at + DAY_MS)) found.push('due-within-a-day');
  }
  if (moves.some((m) => m.newToday > 0 && m.to && m.clears.critical + m.clears.high > 0))
    found.push('new-high-or-critical');
  return found.length ? found : ['other'];
}

/** One repository's day. */
function repositoryDay({ moves, pulls }: RepositoryRead): Day['repositories'][number] {
  const list = moves.moves.map((move) => dayMove(move, pulls));
  const judged = moves.file?.judged ?? null;
  return {
    repository: moves.repository,
    run: {
      id: moves.run.id,
      event: moves.run.event as 'schedule' | 'push' | 'workflow_dispatch',
      conclusion: moves.run.conclusion,
      commit: moves.run.headSha,
      finished: moves.run.updatedAt,
      url: moves.run.url,
    },
    judged,
    failed: failures(moves.run.conclusion, judged, list),
    totals: moves.file ? moves.file.totals : null,
    scanned: scannedOf(moves).length,
    moves: list,
  };
}

/** The images a repository's scan read, from its `moves.json`; none when the run wrote none. */
export function scannedOf(moves: Moves) {
  return (moves.file as { scanned?: import('./compare.ts').ScannedImage[] } | null)?.scanned ?? [];
}

/** The day: each repository, in order, the containers compared, and the rows, or null when none could be made. */
export function dayOf(reads: RepositoryRead[], containers: number, rows: Row[] | null): Day {
  return {
    repositories: reads
      .map(repositoryDay)
      .sort((a, b) => (a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0)),
    compared: rows !== null,
    containers,
    rows: (rows ?? []).slice(0, 1000),
  };
}

/**
 * Whether two days say the same: the same runs, moves and rows. A pod's name and how many containers ran are left out,
 * so a pod made again, or a Deployment scaled, is no new day while its row stands.
 */
export function sameDay(a: Day, b: Day | null): boolean {
  if (!b) return false;
  const plain = ({ containers: _, rows, ...day }: Day) => ({
    ...day,
    rows: rows.map((row) =>
      row.row === 'not-running' ? { ...row, running: row.running.map(withoutPod) } : withoutPod(row),
    ),
  });
  return canonical(plain(a)) === canonical(plain(b));
}

/** JSON with every object's keys in order: the store's `jsonb` keeps its own order, not the writer's. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const withoutPod = <T extends { pod: string }>({ pod: _, ...rest }: T) => rest;
