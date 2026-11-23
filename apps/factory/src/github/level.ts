/**
 * The autonomy level and the auto-merge switch Martin set in the console, as the GitHub worker reads them before it
 * adds a move to the merge queue: the one table (`ENQUEUES`, `policy/line.ts`) says what each level queues, only with
 * auto-merge on (`enqueues`), and the worker asks it as the line does, so each control means the same for both.
 *
 * Both are read from the store, as the line reads them: the latest `controls.changed` one of Martin's roles appended
 * (`latestControls`), turned into the controls in force (`controlsInForce`). The worker connects as `factory_github`,
 * which may read those events and nothing else (0054_github-reads-the-level.sql). It reads them afresh each time it is
 * about to add a move, so a level or a switch Martin changes holds from the next pass of the queue, with nothing
 * restarted.
 *
 * Controls it cannot read are Supervised with auto-merge off: a worker with no store (`PGHOST` unset), or one whose
 * read failed, queues no move. Each is said once, and the read's return is said once too.
 */
import { latestControls } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { type Controls, controlsInForce, enqueues } from '../../../../policy/line.ts';
import type { Rule } from '../../../../policy/review-verdict.ts';

/** The two of Martin's controls that decide what is queued: the level, and auto-merge. */
export type Merging = Pick<Controls, 'autonomy' | 'autoMerge'>;

/** The level and auto-merge in force now, or Supervised with auto-merge off when they cannot be read. */
export type LevelReader = () => Promise<Merging>;

/** What a worker that cannot read the controls queues by: nothing. */
const UNREAD: Merging = { autonomy: 'supervised', autoMerge: false };

/** The controls from the store, read each time they are asked for; `UNREAD`, said once, while a read fails. */
export function storeLevel(sql: Sql, log: Pick<Logger, 'info' | 'warn'>): LevelReader {
  let failing = false;
  return async () => {
    try {
      const { autonomy, autoMerge } = controlsInForce(await latestControls(sql));
      if (failing) log.info({ autonomy, autoMerge }, 'reading the autonomy level and auto-merge again');
      failing = false;
      return { autonomy, autoMerge };
    } catch (error) {
      if (!failing) {
        log.warn({ err: error }, 'could not read the autonomy level and auto-merge: queuing as at Supervised');
      }
      failing = true;
      return UNREAD;
    }
  };
}

/** A worker with no store: always `UNREAD`, and it says so when it starts. */
export function noLevel(log: Pick<Logger, 'warn'>): LevelReader {
  log.warn(
    'No store (PGHOST): the worker cannot read the autonomy level or auto-merge, and queues no move, as at Supervised.',
  );
  return async () => UNREAD;
}

/**
 * Which of the two keeps the worker from adding a pull request the gate passed by a rule, or undefined when neither
 * does: the level first, as the line says it (`line/merging.ts`), then the switch. Both by `enqueues`.
 */
export const mergingWait = (merging: Merging, rule: Rule): 'level' | 'auto-merge' | undefined => {
  if (enqueues(merging, rule)) return undefined;
  return enqueues({ ...merging, autoMerge: true }, rule) ? 'auto-merge' : 'level';
};
