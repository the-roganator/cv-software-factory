/**
 * The day, as `patching.read` holds it: a pure function of what the GitHub worker read for each repository (its moves,
 * checked against its alerts, and its open Dependabot pull requests) and of the rows the cluster's comparison made.
 *
 * A move keeps what `moves.json` says of it. A lockfile's move, which the artifact names by its file alone, carries its
 * package apart (`package`), from its alerts, for the public view to leave out until a pull request moving it is open.
 * A move whose pin an open Dependabot pull request moves names it (`pullRequest`), matched by the dependency its branch
 * names and the directory of one of the move's pins.
 *
 * Why a scan failed is what its own totals count: one past its deadline, one due within a day, a new High or Critical
 * with a fix; and `other` when none does, or it wrote no totals at all. The scan's log is the reason's own words; the
 * sense reads no log.
 */
import type { MoveLane, PayloadOf, ScanFailure, ScanSeverity } from '@software-factory/events';
import { MOST_MOVES, MOST_PINS, MOST_ROWS } from '@software-factory/events/schemas';
import type { DependencyPull } from '../github/dependabot.ts';
import type { Moves, ReadMove } from '../github/scanning.ts';
import type { Counts, MovesFile } from '../vulnerabilities/moves.ts';
import { parseReference } from '../vulnerabilities/reference.ts';
import type { Row } from './compare.ts';

export type Day = PayloadOf<'patching.read'>;
type DayMove = Day['repositories'][number]['moves'][number];

/** What the worker read for one repository. */
export interface RepositoryRead {
  moves: Moves;
  pulls: DependencyPull[];
}

const counts = (from: Counts): Record<ScanSeverity, number> => ({
  critical: from.CRITICAL,
  high: from.HIGH,
  medium: from.MEDIUM,
  low: from.LOW,
  unknown: from.UNKNOWN,
});

/**
 * An image's path as Dependabot's branch names it: its repository without the registry, and without Docker Hub's
 * `library/`, so `node`, `docker.io/library/node` and `gcr.io/distroless/static` match `node` and `distroless/static`.
 */
function imagePath(name: string): string {
  // parseReference always names the registry (Docker Hub's as docker.io): the path is what follows it.
  const [, ...path] = parseReference(name).repository.split('/');
  return path.join('/').replace(/^library\//, '');
}

/** An Action as Dependabot names it: its owner and repository, without a subpath or a ref (`github/codeql-action`). */
const actionPath = (name: string) => (name.split('@')[0] ?? name).split('/').slice(0, 2).join('/').toLowerCase();

/** A pin's directory as `dependabot.yml` writes one: `/` for the root. */
const directoryOf = (file: string) => `/${file.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '') || '/';

/**
 * The ecosystem a move's pins belong to, as Dependabot names it, and the directories its pull request may name: a
 * lockfile's is npm's, a workflow's is GitHub Actions', which `dependabot.yml` reads from `/`, and any other a
 * Dockerfile
 * or a manifest's image, docker's, in the pin's own directory.
 */
function ecosystemOf(move: ReadMove): { ecosystems: string[]; directories: Set<string> } {
  const pins = move.withheld?.pins ?? move.pins;
  if (move.lockfile) return { ecosystems: ['npm'], directories: new Set(pins.map((p) => directoryOf(p.file))) };
  if (pins.every((p) => p.file.startsWith('.github/')))
    return { ecosystems: ['github-actions'], directories: new Set(['/']) };
  return { ecosystems: ['docker', 'devcontainers'], directories: new Set(pins.map((p) => directoryOf(p.file))) };
}

/** The open Dependabot pull request that moves a move's pin, if one does: same ecosystem, dependency and directory. */
function pullFor(move: ReadMove, pulls: DependencyPull[]): DayMove['pullRequest'] {
  const { ecosystems, directories } = ecosystemOf(move);
  const action = ecosystems.includes('github-actions');
  // Each side read the same way: a package by its name, an Action by its owner and repository, an image by its path.
  // A lockfile's move with no package from its alerts names none, so it matches nothing.
  const key = (name: string) => (move.lockfile ? name : action ? actionPath(name) : imagePath(name));
  if (move.lockfile && !move.withheld) return undefined;
  const name = key(move.withheld?.package ?? move.name);
  const pull = pulls.find(
    (p) =>
      p.version !== null &&
      p.dependency !== null &&
      p.ecosystem !== null &&
      ecosystems.includes(p.ecosystem) &&
      key(p.dependency) === name &&
      p.directory !== null &&
      directories.has(p.directory),
  );
  return pull?.version ? { number: pull.number, version: pull.version } : undefined;
}

function dayMove(move: ReadMove, pulls: DependencyPull[]): DayMove {
  const pullRequest = pullFor(move, pulls);
  return {
    name: move.name,
    pins: move.pins.slice(0, MOST_PINS),
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
            pins: move.withheld.pins.slice(0, MOST_PINS),
          },
        }
      : {}),
    ...(pullRequest ? { pullRequest } : {}),
  };
}

/** The conclusions GitHub gives a run that failed. */
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * Why a scan that did not pass failed, read from its own totals, which count what it fails on: a finding past its
 * deadline, one due within a day, a new High or Critical with a fix. `other` when it failed with none of those, or
 * wrote
 * no totals at all.
 */
export function failures(conclusion: string | null, totals: ScanTotals | null): ScanFailure[] {
  // A run cancelled, skipped or not finished judged nothing: it did not fail, and its conclusion says what it did.
  if (!conclusion || !FAILED.has(conclusion)) return [];
  const found: ScanFailure[] = [];
  if (totals?.overdue) found.push('overdue');
  if (totals?.dueWithinDay) found.push('due-within-a-day');
  if (totals?.newHighWithFix) found.push('new-high-or-critical');
  return found.length ? found : ['other'];
}

/** The scan's totals, as `moves.json` gives them (moves.ts's `MovesFile`). */
type ScanTotals = MovesFile['totals'];

/** The scan's totals, copied: the sense computes none of them. */
const totalsOf = (t: ScanTotals): ScanTotals => ({
  fixed: t.fixed,
  moves: t.moves,
  lanes: t.lanes,
  noFix: t.noFix,
  excepted: t.excepted,
  overdue: t.overdue,
  dueWithinDay: t.dueWithinDay,
  newHighWithFix: t.newHighWithFix,
  newHighWithoutFix: t.newHighWithoutFix,
});

/** One repository's day. */
function repositoryDay({ moves, pulls }: RepositoryRead): Day['repositories'][number] {
  const list = moves.moves.slice(0, MOST_MOVES).map((move) => dayMove(move, pulls));
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
    failed: failures(moves.run.conclusion, moves.file?.totals ?? null),
    totals: moves.file ? totalsOf(moves.file.totals) : null,
    scanned: scannedOf(moves).length,
    moves: list,
  };
}

/** The images a repository's scan read, from its `moves.json`; none when the run wrote none. */
export function scannedOf(moves: Moves) {
  return moves.file?.scanned ?? [];
}

/** The day: each repository, in order, the containers compared, and the rows, or null when none could be made. */
export function dayOf(reads: RepositoryRead[], containers: number, rows: Row[] | null): Day {
  return {
    repositories: reads
      .map(repositoryDay)
      .sort((a, b) => (a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0)),
    compared: rows !== null,
    containers,
    rows: capped(rows ?? []),
  };
}

/**
 * The rows a day holds: all of them, or past the cap one of each row as it reads without its pod, in that order, so
 * which rows a full day keeps does not hang on the pods' names.
 */
function capped(rows: Row[]): Row[] {
  if (rows.length <= MOST_ROWS) return rows;
  const byRow = new Map<string, Row>();
  for (const row of rows) {
    const k = canonical(row.row === 'not-running' ? { ...row, running: [] } : withoutPod(row));
    if (!byRow.has(k)) byRow.set(k, row);
  }
  return [...byRow.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MOST_ROWS)
    .map(([, row]) => row);
}

/**
 * Whether two days say the same: the same runs, moves and rows. A pod's name and how many containers ran are left out,
 * and so is how many copies make a row, so a pod made again, or a Deployment scaled, is no new day while its row
 * stands.
 */
export function sameDay(a: Day, b: Day | null): boolean {
  if (!b) return false;
  // Without the pods' names the rows may come in another order and repeat, so they are compared as a sorted set.
  const set = (items: string[]) => [...new Set(items)].sort();
  const plain = ({ containers: _, rows, ...day }: Day) => ({
    ...day,
    rows: set(
      rows.map((row) =>
        canonical(
          row.row === 'not-running'
            ? { ...row, running: set(row.running.map(withoutPod).map(canonical)) }
            : withoutPod(row),
        ),
      ),
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
