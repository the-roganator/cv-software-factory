/**
 * The dependency sense's pass: ask the GitHub worker for both repositories' moves and open Dependabot pull requests,
 * list what the cluster's pods run, compare the two, and append the day as `patching.read` when it differs from the
 * last. It keeps nothing between passes: the last day is the store's, so a restart appends nothing new unless
 * something changed.
 *
 * A read that fails, of either repository or of the cluster, appends nothing and says so: a day is never made from part
 * of what it says. It acts only on a store of real events, or one that holds none yet: samples are not the factory's
 * work.
 */
import { type NewEvent, upcast, VERSIONS } from '@software-factory/events';
import { type EventWriter, storeKind } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { DependencyPull } from '../github/dependabot.ts';
import type { Moves } from '../github/scanning.ts';
import { GitHubWorkerError } from '../github/worker-client.ts';
import { compare } from './compare.ts';
import { type Day, dayOf, type RepositoryRead, sameDay, scannedOf } from './day.ts';
import type { RunningContainer } from './running.ts';
import { type Next, stale } from './schedule.ts';

/** What the sense reads through: the GitHub worker's two reads, and the cluster's pods. */
export interface Senses {
  moves(repo: string): Promise<Moves>;
  dependencyPulls(repo: string): Promise<DependencyPull[]>;
  running(): Promise<RunningContainer[]>;
}

export type Pass =
  | { pass: 'appended'; day: Day }
  | { pass: 'unchanged'; day: Day }
  | { pass: 'failed'; failed: string[] }
  /** The worker answered a read with 409, read again: a scan finished during it. Nothing failed, and nothing is appended. */
  | { pass: 'again'; why: string[] }
  | { pass: 'not-real' };

export interface SenseOptions {
  sql: Sql;
  events: EventWriter;
  senses: Senses;
  /** Both repositories, as `owner/name`. */
  repositories: readonly string[];
  log: Logger;
  now?: () => Date;
}

/** Whether the moves read was answered 409, to be read again: a scan finished while its alerts were read. */
const readAgain = (error: unknown) => error instanceof GitHubWorkerError && error.status === 409;

/** How many reads to take again in a row before they count as a failure: an hour of them, at ten minutes apart. */
export const MOST_AGAIN = 6;

/** When the next pass is, after this one: see `schedule.ts`. A day read from yesterday's scan is read again within the hour. */
export function nextAfter(result: Pass, now: number): Next {
  if (result.pass === 'again') return 'soon';
  if (result.pass === 'failed') return 'hour';
  if (result.pass === 'not-real') return 'daily';
  return result.day.repositories.some((r) => stale(r.run.finished, now)) ? 'hour' : 'daily';
}

/** What `factory patching --once` exits with: 0 for a day read, 1 for a read that failed, 75 for one to take again. */
export function exitCode(result: Pass): number {
  return result.pass === 'failed' ? 1 : result.pass === 'again' ? 75 : 0;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class PatchingSense {
  readonly #sql: Sql;
  readonly #events: EventWriter;
  readonly #senses: Senses;
  readonly #repositories: readonly string[];
  readonly #log: Logger;
  readonly #now: () => Date;
  /** How many passes in a row have been reads to take again. */
  #again = 0;

  constructor({ sql, events, senses, repositories, log, now = () => new Date() }: SenseOptions) {
    // A day holds one or two repositories (`patching.read`): more could never be appended, so it would never read.
    if (repositories.length < 1 || repositories.length > 2)
      throw new Error(`The sense reads one or two repositories, not ${repositories.length}`);
    // Each once, and each owner/name, or every day would fail the schema, or every read GitHub.
    if (new Set(repositories).size !== repositories.length || repositories.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r)))
      throw new Error(`The sense reads each repository once, as owner/name: ${repositories.join(', ')}`);
    this.#sql = sql;
    this.#events = events;
    this.#senses = senses;
    this.#repositories = repositories;
    this.#log = log;
    this.#now = now;
  }

  async pass(): Promise<Pass> {
    if ((await storeKind(this.#sql)) === 'sample') return { pass: 'not-real' };
    const asked: { what: string; moves?: true; read: () => Promise<unknown> }[] = [
      ...this.#repositories.flatMap((repo) => [
        { what: `the moves of ${repo}`, moves: true as const, read: () => this.#senses.moves(repo) },
        { what: `the Dependabot pull requests of ${repo}`, read: () => this.#senses.dependencyPulls(repo) },
      ]),
      { what: "the cluster's pods", read: () => this.#senses.running() },
    ];
    const answers = await Promise.allSettled(asked.map(({ read }) => read()));
    const failed = answers.flatMap((answer, i) =>
      answer.status === 'rejected' ? [`${asked[i]?.what}: ${message(answer.reason)}`] : [],
    );
    // The moves read's 409 is no failure: the scan finished while the alerts were read, and the next read takes it whole.
    // Any other read's 409 is a failure, and so are the moves read's once they have come an hour in a row.
    const again =
      failed.length > 0 &&
      answers.every((answer, i) => answer.status === 'fulfilled' || (asked[i]?.moves && readAgain(answer.reason)));
    if (again && ++this.#again < MOST_AGAIN) {
      this.#log.info({ why: failed }, 'patching: a scan finished during the read, so the day is read again soon');
      return { pass: 'again', why: failed };
    }
    if (again) failed.push(`the moves read was answered 409, read again, ${MOST_AGAIN} times in a row`);
    this.#again = 0;
    if (failed.length) {
      this.#log.error({ failed }, `patching: ${failed.length} of the reads failed, so the day is not appended`);
      return { pass: 'failed', failed };
    }
    const values = answers.map((answer) => (answer as PromiseFulfilledResult<unknown>).value);
    const reads: RepositoryRead[] = this.#repositories.map((_, i) => ({
      moves: values[2 * i] as Moves,
      pulls: values[2 * i + 1] as DependencyPull[],
    }));
    const containers = values.at(-1) as RunningContainer[];

    const lists = reads.map(({ moves }) => ({ repository: moves.repository, scanned: scannedOf(moves) }));
    // With a repository's list missing, every image of it would look unlisted: no rows rather than wrong ones.
    const compared = lists.every((list) => list.scanned.length > 0);
    if (!compared)
      this.#log.warn(
        { without: lists.filter((l) => !l.scanned.length).map((l) => l.repository) },
        'patching: a scan wrote no list of what it read, so the cluster is not compared with it',
      );
    const day = dayOf(reads, containers.length, compared ? compare(containers, lists) : null);

    if (sameDay(day, await this.#last())) return { pass: 'unchanged', day };
    await this.#events.append(dayEvent(day, this.#now()));
    return { pass: 'appended', day };
  }

  /** The last day appended, which the sense's role alone appends and reads. */
  async #last(): Promise<Day | null> {
    const [row] = await this.#sql<{ type: string; version: number; payload: unknown }[]>`
      select type, version, payload from events where type = 'patching.read' order by seq desc limit 1`;
    if (!row) return null;
    const read = upcast(row);
    if (!read.ok) throw new Error(`The last patching.read is version ${row.version}, newer than this sense's`);
    return read.event.payload as Day;
  }
}

/** The day's event, with a summary in a line. */
export function dayEvent(day: Day, now: Date): NewEvent<'patching.read'> {
  const moves = day.repositories.map((r) => `${r.moves.length} in ${r.repository.split('/')[1]}`).join(', ');
  const rows = day.compared
    ? day.rows.length
      ? `; ${day.rows.length} ${day.rows.length === 1 ? 'thing' : 'things'} the cluster runs that the list does not say`
      : '; the cluster runs what the list says'
    : '; the cluster not compared';
  return {
    id: crypto.randomUUID(),
    ts: now.toISOString(),
    work_item: null,
    type: 'patching.read',
    version: VERSIONS['patching.read'],
    actor: 'factory',
    summary: `The day's moves: ${moves}${rows}`,
    payload: day,
    artifacts: [],
  };
}
