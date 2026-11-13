/**
 * The dependency sense's pass: ask the GitHub worker for both repositories' moves and open Dependabot pull requests,
 * list what the cluster's pods run, compare the two, and append the day as `patching.read` when it differs from the
 * last. It keeps nothing between passes: the last day is the store's, so a restart appends nothing new unless
 * something changed.
 *
 * A read that fails, of either repository or of the cluster, appends nothing and says so: a day is never made from part
 * of what it says. A pass the worker's door refused outright, as when a deploy restarts the sense and the worker
 * together and the sense reads first, or the store refused it, is taken again shortly, for about five minutes, before it
 * counts as failed. It
 * acts only on a store of real events, or one that holds none yet: samples are not the factory's work.
 */
import { type NewEvent, upcast, VERSIONS } from '@software-factory/events';
import { type EventWriter, storeKind } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { DependencyPull } from '../github/dependabot.ts';
import type { Moves } from '../github/scanning.ts';
import { GitHubWorkerError, READ_AGAIN } from '../github/worker-client.ts';
import type { Outbox } from '../outbox.ts';
import { compare } from './compare.ts';
import { type Day, dayOf, type RepositoryRead, sameDay, scannedOf } from './day.ts';
import type { RunningContainer } from './running.ts';
import { type Next, stale } from './schedule.ts';
import { sendsOf } from './sends.ts';

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
  /**
   * The worker asked for the moves read again (`READ_AGAIN`): a scan finished during it. Nothing failed, and nothing
   * is appended.
   */
  | { pass: 'again'; why: string[] }
  /**
   * The GitHub worker's door refused the connection to every read that failed: it is still starting, as it is for a
   * moment when a deploy restarts it and the sense together. Nothing is appended.
   */
  | { pass: 'refused'; why: string[] }
  | { pass: 'not-real' };

interface SenseOptions {
  sql: Sql;
  events: EventWriter;
  /**
   * Where the app's moves go to triage (`sends.ts`): the inbox, as the sense's role. Without one, as a dry run or a
   * test that needs none, nothing is sent.
   */
  outbox?: Outbox | undefined;
  senses: Senses;
  /** Both repositories, as `owner/name`. */
  repositories: readonly string[];
  log: Logger;
  now?: () => Date;
}

/**
 * Whether the worker asked for the read again: a scan finished while its alerts were read. By its kind alone: GitHub's
 * own 409, which the worker relays as `conflict`, is a failed read.
 */
const readAgain = (error: unknown) => error instanceof GitHubWorkerError && error.kind === READ_AGAIN;

/**
 * Whether the connection was refused: nothing listened at the address. `fetch` gives it as its error's cause, and
 * `node:http` as the error itself.
 */
export function refused(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++)
    if ((e as { code?: unknown }).code === 'ECONNREFUSED') return true;
  return false;
}

/**
 * How many refused passes in a row before they count as a failure: the 21st some five minutes after the first. A
 * worker a deploy recreates pulls its image and listens within that, and on a new cluster the network policy has
 * refused a new pod's connections for up to 2.5 minutes (platform run 43268720731); five is twice that.
 */
export const MOST_REFUSED = 21;

/** How many reads to take again in a row before they count as a failure: the sixth some fifty minutes after the
 * first, at ten minutes apart. */
export const MOST_AGAIN = 6;

/**
 * When the next pass is, after this one (`schedule.ts`), and why when it is sooner than the day's: a read to take
 * again,
 * a read that failed, or a day read from yesterday's scan.
 */
export function nextAfter(result: Pass, now: number): { next: Next; why?: 'again' | 'refused' | 'failed' | 'stale' } {
  if (result.pass === 'again') return { next: 'soon', why: 'again' };
  if (result.pass === 'refused') return { next: 'shortly', why: 'refused' };
  if (result.pass === 'failed') return { next: 'hour', why: 'failed' };
  if (result.pass === 'not-real') return { next: 'daily' };
  return result.day.repositories.some((r) => stale(r.run.finished, now))
    ? { next: 'hour', why: 'stale' }
    : { next: 'daily' };
}

/**
 * What `factory patching --once` exits with: 0 for a day read, 1 for a read that failed, 75 for one to take again or
 * refused.
 */
export function exitCode(result: Pass): number {
  return result.pass === 'failed' ? 1 : result.pass === 'again' || result.pass === 'refused' ? 75 : 0;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class PatchingSense {
  readonly #sql: Sql;
  readonly #events: EventWriter;
  readonly #outbox: Outbox | undefined;
  readonly #senses: Senses;
  readonly #repositories: readonly string[];
  readonly #log: Logger;
  readonly #now: () => Date;
  /** How many passes in a row have been reads to take again. */
  #again = 0;
  /** How many passes in a row the worker's door has refused. */
  #refused = 0;

  constructor({ sql, events, outbox, senses, repositories, log, now = () => new Date() }: SenseOptions) {
    // A day holds one or two repositories (`patching.read`): more could never be appended, so it would never read.
    if (repositories.length < 1 || repositories.length > 2)
      throw new Error(`The sense reads one or two repositories, not ${repositories.length}`);
    // Each once, and each owner/name, or every day would fail the schema, or every read GitHub.
    if (new Set(repositories).size !== repositories.length || repositories.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r)))
      throw new Error(`The sense reads each repository once, as owner/name: ${repositories.join(', ')}`);
    this.#sql = sql;
    this.#events = events;
    this.#outbox = outbox;
    this.#senses = senses;
    this.#repositories = repositories;
    this.#log = log;
    this.#now = now;
  }

  async pass(): Promise<Pass> {
    // Reads to take again count only in a row: any other pass, a throw included, starts the count again.
    let result: Pass;
    try {
      result = await this.#pass();
    } catch (error) {
      this.#again = 0;
      // The store refused the connection, as a new pod's are until the network policy admits it: taken again shortly,
      // as the worker's door is.
      if (!refused(error) || this.#refused + 1 >= MOST_REFUSED) {
        this.#refused = 0;
        throw error;
      }
      this.#refused++;
      const why = [`the store: ${message(error)}`];
      this.#log.info({ why }, 'patching: the store refused the connection, so the day is read again shortly');
      return { pass: 'refused', why };
    }
    if (result.pass !== 'again') this.#again = 0;
    if (result.pass !== 'refused') this.#refused = 0;
    return result;
  }

  async #pass(): Promise<Pass> {
    if ((await storeKind(this.#sql)) === 'sample') return { pass: 'not-real' };
    const asked: { what: string; moves?: true; worker?: true; read: () => Promise<unknown> }[] = [
      ...this.#repositories.flatMap((repo) => [
        {
          what: `the moves of ${repo}`,
          moves: true as const,
          worker: true as const,
          read: () => this.#senses.moves(repo),
        },
        {
          what: `the Dependabot pull requests of ${repo}`,
          worker: true as const,
          read: () => this.#senses.dependencyPulls(repo),
        },
      ]),
      { what: "the cluster's pods", read: () => this.#senses.running() },
    ];
    const answers = await Promise.allSettled(asked.map(({ read }) => read()));
    const failed = answers.flatMap((answer, i) =>
      answer.status === 'rejected' ? [`${asked[i]?.what}: ${message(answer.reason)}`] : [],
    );
    // The worker's door refused every read that failed: it is starting, so the pass is taken again shortly, a few times
    // in a row, before it is a failure. A refusal of the cluster's own read is a failure at once.
    const doorRefused =
      failed.length > 0 &&
      answers.every((answer, i) => answer.status === 'fulfilled' || (asked[i]?.worker && refused(answer.reason)));
    if (doorRefused && this.#refused + 1 < MOST_REFUSED) {
      this.#refused++;
      this.#log.info(
        { why: failed },
        "patching: the GitHub worker's door refused the connection, so the day is read again shortly",
      );
      return { pass: 'refused', why: failed };
    }
    // The moves read asked for again is no failure: the scan finished while the alerts were read, and the next read
    // takes it whole. Any other read's refusal is a failure, a `conflict` from GitHub too, and so are the moves read's
    // asks once they have come an hour in a row.
    const again =
      failed.length > 0 &&
      answers.every((answer, i) => answer.status === 'fulfilled' || (asked[i]?.moves && readAgain(answer.reason)));
    if (again && this.#again + 1 < MOST_AGAIN) {
      this.#again++;
      this.#log.info({ why: failed }, 'patching: a scan finished during the read, so the day is read again soon');
      return { pass: 'again', why: failed };
    }
    if (failed.length) {
      const why = again
        ? `, asked for again ${MOST_AGAIN} times in a row`
        : doorRefused
          ? `, refused by the GitHub worker's door ${MOST_REFUSED} times in a row`
          : '';
      this.#log.error({ failed }, `patching: ${failed.length} of the reads failed${why}, so the day is not appended`);
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

    const unchanged = sameDay(day, await this.#last());
    if (!unchanged) await this.#events.append(dayEvent(day, this.#now()));
    // Every pass that reads sends, the day changed or not: the same send has the same id, and the inbox keeps the first,
    // so a sense restarted sends nothing twice, and a send that failed goes again at the next pass.
    const unsent = await this.#send(reads.map((read) => read.moves));
    if (unsent.length) {
      this.#log.error({ failed: unsent }, `patching: ${unsent.length} of the moves were not sent to triage`);
      return { pass: 'failed', failed: unsent };
    }
    return unchanged ? { pass: 'unchanged', day } : { pass: 'appended', day };
  }

  /** Sends each repository's moves for the line to triage (`sends.ts`), and says which could not be sent. */
  async #send(all: Moves[]): Promise<string[]> {
    const outbox = this.#outbox;
    if (!outbox) return [];
    const failed: string[] = [];
    let sent = 0;
    for (const moves of all) {
      for (const { id, signal } of sendsOf(moves, moves.file?.judged ?? moves.run.updatedAt)) {
        try {
          await outbox.send(signal, id);
          sent++;
        } catch (error) {
          failed.push(`a move of ${moves.repository} to triage: ${message(error)}`);
        }
      }
    }
    if (sent) this.#log.info({ sent }, 'patching: the moves for the line sent to triage');
    return failed;
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
function dayEvent(day: Day, now: Date): NewEvent<'patching.read'> {
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
