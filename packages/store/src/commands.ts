/**
 * Martin's commands, as the workers read them. Row security lets only his roles append an admin event
 * (`0023_martins-commands.sql`), and the store records the role that appended each, so an event that says
 * `actor: martin` proves nothing by itself: the line, triage and the gateway act on an admin event only when one of
 * his roles appended it, and log any other once.
 */
import { ADMIN_TYPES, upcast, VERSIONS } from '@software-factory/events';
import type { Sql, TransactionSql } from 'postgres';
import { MARTINS_ROLES } from '../../../policy/store-grants.ts';

/**
 * SQL, true for an event the factory may act on: any but an admin event, and an admin event that one of Martin's roles
 * appended, or that was stored before the store recorded who appended each (it has none). `alias` names the events in
 * the query around it, such as `a`.
 */
export const fromMartin = (sql: Sql | TransactionSql, alias: string) =>
  sql`(${sql(`${alias}.type`)} <> all(${[...ADMIN_TYPES]})
       or ${sql(`${alias}.appended_by`)} is null
       or ${sql(`${alias}.appended_by`)} = any(${MARTINS_ROLES}))`;

/**
 * SQL, true for an event (`alias`) one of Martin's roles appended, and not a sample: the rule for each of the two
 * events that make an improvement his (`askedByMartin`).
 */
export const byMartin = (sql: Sql | TransactionSql, alias: string) =>
  sql`(not ${sql(`${alias}.sample`)} and coalesce(${sql(`${alias}.appended_by`)} = any(${MARTINS_ROLES}), false))`;

/**
 * SQL, true for a work item (`workItem`, a column such as `t.work_item`) that is an improvement Martin asked for: its
 * opening, of kind improvement, and his request (`improvement.requested`) both appended by one of his roles, and
 * neither a sample, since a sample's improvement is no work of the app's. Row security lets no other role append either
 * (0035_improvement-requests.sql); every reader that acts on an improvement asks this, the line's queue, its flag pass
 * and its worker, the admin service's Just one and `flagEvents`, so none can be told one by a worker.
 */
export const askedByMartin = (sql: Sql | TransactionSql, workItem: string) =>
  sql`(exists (select 1 from events mo where mo.work_item = ${sql(workItem)} and mo.type = 'work-item.opened'
               and mo.payload->>'kind' = 'improvement' and ${byMartin(sql, 'mo')})
       and exists (select 1 from events mr where mr.work_item = ${sql(workItem)} and mr.type = 'improvement.requested'
                   and ${byMartin(sql, 'mr')}))`;

/**
 * SQL, true for a work item (`workItem`, a column) opened as an improvement, by whomever: one that is never a ticket,
 * whatever is appended to it.
 */
export const openedAsImprovement = (sql: Sql | TransactionSql, workItem: string) =>
  sql`exists (select 1 from events io where io.work_item = ${sql(workItem)} and io.type = 'work-item.opened'
              and io.payload->>'kind' = 'improvement')`;

/**
 * The line as Martin left it: the last of `line.started` and `line.stopped` that one of his roles appended decides, and
 * a store with neither has a line not yet started, which waits for his first Start.
 */
export type LineState = 'running' | 'stopped' | 'not-started';

/** The line as Martin left it (`LineState`). */
export async function lineState(sql: Sql | TransactionSql): Promise<LineState> {
  const [last] = await sql<{ type: string }[]>`
    select e.type from events e where e.type in ('line.started', 'line.stopped') and ${fromMartin(sql, 'e')}
    order by e.seq desc limit 1`;
  if (!last) return 'not-started';
  return last.type === 'line.started' ? 'running' : 'stopped';
}

/**
 * Whether the line is stopped: stopped by Martin, or not yet started by him. Every worker asks before it takes work, so
 * on a new store nothing moves, and no model is called, until his first Start.
 */
export async function lineStopped(sql: Sql | TransactionSql): Promise<boolean> {
  return (await lineState(sql)) !== 'running';
}

/**
 * The payload of the latest `controls.changed` one of Martin's roles appended, or undefined: the line's controls as he
 * chose them, read as the current version (one from before auto-rollback had a switch has it on), and otherwise
 * unchecked. `policy/line.ts`'s `controlsInForce` says what is in force, control by control.
 *
 * One of a version newer than this code knows, appended by a newer image while an upgrade is under way, is still his
 * latest, and is read as it stands: `controlsInForce` keeps each control whose value it can read and takes policy's
 * default for the rest. Passing over it to the last one this code knows would put back a setting he has since
 * changed, such as auto-rollback off after he switched it on again.
 */
export async function latestControls(sql: Sql | TransactionSql): Promise<unknown> {
  const [row] = await sql<{ version: number; payload: unknown }[]>`
    select e.version, e.payload from events e
    where e.type = 'controls.changed' and ${fromMartin(sql, 'e')}
    order by e.seq desc limit 1`;
  if (!row) return undefined;
  if (row.version > VERSIONS['controls.changed']) return row.payload;
  const read = upcast({ type: 'controls.changed', version: row.version, payload: row.payload });
  return read.ok ? read.event.payload : row.payload;
}

/**
 * The payload of the latest `alerts.switched` one of Martin's roles appended, that this code can read, or undefined:
 * whether alerts reach his phone as he chose it, unchecked. `policy/phone.ts`'s `phoneInForce` says what is in force.
 */
export async function latestPhone(sql: Sql | TransactionSql): Promise<unknown> {
  const [row] = await sql<{ payload: unknown }[]>`
    select e.payload from events e
    where e.type = 'alerts.switched' and e.version <= ${VERSIONS['alerts.switched']} and ${fromMartin(sql, 'e')}
    order by e.seq desc limit 1`;
  return row?.payload;
}

/**
 * The store's clock now, to the microsecond, as an ISO timestamp: the moment the next few are counted from, by the
 * clock and to the precision the line stamps each work item it takes with (`line.taken_at`). A `Date` keeps only
 * milliseconds, which would put the moment up to one earlier, and count a work item taken just before it as one of them.
 */
export async function storeClock(sql: Sql | TransactionSql): Promise<string> {
  const [row] = await sql<{ now: string }[]>`
    select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`;
  if (!row) throw new Error('The store did not say what time it is.');
  return row.now;
}

interface Log {
  warn(details: object, message: string): void;
}

/** An admin event a role not Martin's appended, which the factory ignores. */
export interface Ignored {
  seq: number;
  type: string;
  actor: string;
  appendedBy: string;
}

/**
 * Logs each admin event a role not Martin's appended, once, from the first it has not looked at. Row security refuses
 * them, so one here means that guard failed.
 */
export class IgnoredCommands {
  readonly #sql: Sql;
  readonly #log: Log;
  #after = 0;
  /** The look in progress: calls at once share it, so none logs an event another is logging. */
  #looking: Promise<Ignored[]> | undefined;

  constructor(sql: Sql, log: Log) {
    this.#sql = sql;
    this.#log = log;
  }

  /** Looks at the events appended since it last looked, and returns those it ignored. */
  check(): Promise<Ignored[]> {
    this.#looking ??= this.#look().finally(() => {
      this.#looking = undefined;
    });
    return this.#looking;
  }

  async #look(): Promise<Ignored[]> {
    const sql = this.#sql;
    const [top] = await sql<{ seq: string | null }[]>`select max(seq) as seq from events`;
    const upTo = Number(top?.seq ?? 0);
    if (upTo <= this.#after) return [];
    const rows = await sql<{ seq: string; type: string; actor: string; appended_by: string }[]>`
      select e.seq, e.type, e.actor, e.appended_by from events e
      where e.seq > ${this.#after} and e.seq <= ${upTo} and not ${fromMartin(sql, 'e')}
      order by e.seq`;
    this.#after = upTo;
    const ignored = rows.map((row) => ({
      seq: Number(row.seq),
      type: row.type,
      actor: row.actor,
      appendedBy: row.appended_by,
    }));
    for (const event of ignored) {
      this.#log.warn(
        event,
        `ignored ${event.type}: ${event.appendedBy} appended it, and it is not one of Martin's roles`,
      );
    }
    return ignored;
  }
}
