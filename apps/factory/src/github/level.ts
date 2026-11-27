/**
 * The autonomy level Martin set in the console, and whether he has the line stopped, as the GitHub worker reads them
 * before it adds a move to the merge queue: the one table (`ENQUEUES`, `policy/line.ts`) says what each level queues
 * (`enqueues`), and the worker asks it as the line does, so each level means the same for both. While the line is
 * stopped, or not yet started, the worker queues as at Supervised: no move, and no workflow pin of Dependabot's. The
 * local deploy pin is asked none of this (`deploy-queue.ts`).
 *
 * All are read from the store, as the line reads them: the latest `controls.changed` one of Martin's roles appended
 * (`latestControls`), turned into the controls in force (`controlsInForce`), and the latest of his `line.started` and
 * `line.stopped` (`lineStopped`). The worker connects as `factory_github`, which may read those events and nothing
 * else (0054_github-reads-the-level.sql, 0055_github-reads-the-stop.sql). It reads them afresh each time it is about
 * to add a move, so a level Martin changes, or a stop, holds from the next pass of the queue, with nothing
 * restarted.
 *
 * Controls it cannot read are Supervised, and a stop it cannot read is a stop: a worker with no
 * store (`PGHOST` unset), or one whose read failed, queues no move. Each is said once, and the read's return is said
 * once too. A store that does not yet let the role read the stop (one not migrated to 0055) shows it no start, which
 * reads as a line not started: stopped.
 */
import { latestControls, lineStopped } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { type Controls, controlsInForce, enqueues } from '../../../../policy/line.ts';
import type { Rule } from '../../../../policy/review-verdict.ts';

/**
 * What of Martin's decides which moves are queued: the level, and whether the line is stopped (or not yet started),
 * which queues as Supervised does whatever the level.
 */
export type Merging = Pick<Controls, 'autonomy'> & { stopped: boolean };

/** The level and the stop in force now; Supervised, and stopped, when they cannot be read. */
export type LevelReader = () => Promise<Merging>;

/** What a worker that cannot read the controls or the stop queues by: nothing. */
const UNREAD: Merging = { autonomy: 'supervised', stopped: true };

/** The controls and the stop from the store, read each time they are asked for; `UNREAD`, said once, while a read fails. */
export function storeLevel(sql: Sql, log: Pick<Logger, 'info' | 'warn'>): LevelReader {
  let failing = false;
  return async () => {
    try {
      const [{ autonomy }, stopped] = await Promise.all([latestControls(sql).then(controlsInForce), lineStopped(sql)]);
      if (failing) {
        log.info({ autonomy, stopped }, 'reading the autonomy level and the line’s stop again');
      }
      failing = false;
      return { autonomy, stopped };
    } catch (error) {
      if (!failing) {
        log.warn(
          { err: error },
          'could not read the autonomy level and whether the line is stopped: queuing as at Supervised',
        );
      }
      failing = true;
      return UNREAD;
    }
  };
}

/** A worker with no store: always `UNREAD`, and it says so when it starts. */
export function noLevel(log: Pick<Logger, 'warn'>): LevelReader {
  log.warn(
    'No store (PGHOST): the worker cannot read the autonomy level or whether the line is stopped, and queues no move, as at Supervised.',
  );
  return async () => UNREAD;
}

/**
 * Which of the two keeps the worker from adding a pull request the gate passed by a rule, or undefined when neither
 * does: the stop first, which queues only what Supervised does, nothing; then the level, as the line says it
 * (`line/merging.ts`). Each by `enqueues`.
 */
export const mergingWait = (merging: Merging, rule: Rule): 'stopped' | 'level' | undefined => {
  if (merging.stopped && !enqueues({ autonomy: 'supervised' }, rule)) return 'stopped';
  return enqueues(merging, rule) ? undefined : 'level';
};
