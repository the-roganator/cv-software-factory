/**
 * The line's queue in Postgres (0005_line.sql): which work items are on the line, at which stage, and which worker
 * holds each, under a lease as the inbox's signals are held. What a work item has done is in its events; this is
 * only where it waits, who is acting on it, and what the line needs that no event carries.
 *
 * A ticket comes onto the line only when nothing is in Plan or waiting for Build, so the line pulls work at the
 * pace of its slowest step rather than piling up specs: the oldest open ticket of the highest severity, from the
 * real events only. A spec that waits for overlapping work in flight is at a stage of its own (`waiting`, 0016), which
 * may last until that work is verified, so it holds up no ticket. One decision at a time takes it (an advisory lock),
 * so two workers cannot take the same ticket.
 *
 * An improvement Martin asked for (the console's "+") comes onto the line as a ticket does, behind every open ticket
 * not yet taken, the oldest first: a defect in the app goes before something new. Only one he asked for: its opening
 * (`work-item.opened`, kind improvement) and his request (`improvement.requested`) both appended by one of his roles
 * (`MARTINS_ROLES`), as row security lets no other (0035_improvement-requests.sql). A work item is judged by that
 * opening, so a ticket appended to an improvement does not make it one, and a ticket's work item is never taken as an
 * improvement.
 *
 * What the queue takes (`Takes`) is Martin's take from the console's Controls, read each pass, or else the line's own
 * default (LINE_ONLY, LINE_TAKE):
 *
 * - A queue for one work item only (`only`: Just one, or LINE_ONLY) sees nothing else on the line, and takes that
 *   ticket or improvement onto it whatever else is in Plan or Build: every other work item is left as it is, so it
 *   holds up nothing.
 * - A queue with a limit (`take`: The next few, or LINE_TAKE) takes work by the same rule until that many work items
 *   have come onto the line since the limit was set (`since`; LINE_TAKE counts every one there has ever been), and
 *   then no more, while those on it go on to their end. It counts the line's own rows, which are never deleted, by
 *   when each was taken, under the same lock: a restart, or a second worker, takes none beyond the limit. A ticket
 *   whose signal was gone as the line took it, and that closed on that look before its issue opened or any step
 *   started (`closedAtTake`), is one the line looked at, not one it worked on, and counts for neither limit.
 *
 * A work item that closed as verified and reopened (triage reopens it when its signal comes back, and a line running
 * live one a dry run verified) is taken back into Plan for a fresh pass (`revive`), whatever else is on the line and
 * whatever the limit: it is one the line took already, and its defect is in the app. It is taken back once for each reopening, from wherever its row was
 * (ended, or not yet ended when it reopened), and until then the line hands it to nobody.
 */
import { cutTo } from '@software-factory/events';
import { askedByMartin, byMartin, lastEnd, openedAsImprovement } from '@software-factory/store';
import type { JSONValue, Sql, TransactionSql } from 'postgres';
import type { Take } from '../../../../policy/line.ts';
import type { Handback } from '../runners/steps.ts';
import type { Draft } from './gates.ts';
import type { LineAgent, QueueStage } from './machine.ts';
import { leftStage } from './metrics.ts';

/** A handback whose effects are not all done yet, kept so they can be tried again without the agent. */
export interface Pending {
  agent: LineAgent;
  round: number;
  job: string;
  /** The last of the work item's events when the step started. One appended since makes this out of date. */
  since: number;
  commit: string;
  base: string;
  handback: Handback;
  /** The step's `model.called`, appended with the effects' events. */
  called: Draft[];
  /** The writes begun, and what each one done gave back, by name. */
  begun: string[];
  done: Record<string, JSONValue>;
  /** Failed tries at the effects, why the last one failed, and when to try again. */
  tries: number;
  failure: string | null;
  retryAt: string | null;
}

export interface QueueItem {
  workItem: string;
  stage: QueueStage;
  /** The number of its last step started: how many it has started, unless its row was made afresh. */
  steps: number;
  failures: number;
  failure: string | null;
  issue: number | null;
  session: string | null;
  effects: Pending | null;
}

interface Row {
  work_item: string;
  stage: QueueStage;
  steps: number;
  failures: number;
  failure: string | null;
  issue: number | null;
  session: string | null;
  effects: Pending | null;
}

const item = (row: Row): QueueItem => ({
  workItem: row.work_item,
  stage: row.stage,
  steps: row.steps,
  failures: row.failures,
  failure: row.failure,
  issue: row.issue,
  session: row.session,
  effects: row.effects,
});

const COLUMNS = ['work_item', 'stage', 'steps', 'failures', 'failure', 'issue', 'session', 'effects'];

/** Where a moved row was, and for how long, as the update that moved it saw it before (`was`). */
interface Left {
  was: QueueStage;
  seconds: number;
}

const LEFT = (sql: Sql) =>
  sql`was.stage as was, extract(epoch from clock_timestamp() - was.moved_at)::float8 as seconds`;

/** A row (`l`) whose work item reopened since the line last took it back, and is open still. */
const reopenedSince = (sql: Sql) =>
  sql`coalesce(${lastEnd(sql, 'l.work_item')} = 'work-item.reopened'
       and coalesce(l.reopened, 0) < (select max(r.seq) from events r
                                      where r.work_item = l.work_item and r.type = 'work-item.reopened'), false)`;

/**
 * A row (`l`) whose work item the line only looked at: it ended before its issue opened, with no agent's step ever
 * started, as a ticket does that closes on the look as the line takes it (its signal gone, a `signal.rechecked` for the
 * take, cleared), or that the line took while a look beside a fix cleared it, and closes on that clearance (one not
 * taken closes beside the fix with no row at all). A limit does not count it. One still seen as it was taken, or that
 * the sense could not tell, has its issue opened and goes on to the planner, and counts; so does one that reopens and
 * is taken back, while it is on the line again. The row says it all, so the count reads no event.
 */
const closedAtTake = (sql: Sql | TransactionSql) => sql`(l.stage = 'ended' and l.steps = 0 and l.issue is null)`;

/** A row (`l`) under nobody's lease. */
const unheld = (sql: Sql) => sql`(l.held_until is null or l.held_until < clock_timestamp())`;

/**
 * How long after its end a reopened work item waits before it comes back: its runners' volume went at its merge, or
 * as it ended if deleting it then failed, and a step that made it again while the old one was still going would mount
 * one being deleted.
 */
const VOLUME_GONE_SECONDS = 60;

/** What the queue takes. */
export interface Takes {
  /** The one work item it sees, if it sees only one. */
  only: string | null;
  /**
   * How many work items the line takes, if it takes only so many: counted from `since`, or, with none, every one it has
   * ever taken.
   */
  take: { most: number; since: string | null } | null;
}

/**
 * What the line takes, from Martin's take (`policy/line.ts`), or, with none in force, from its own default: LINE_ONLY's
 * one work item, and LINE_TAKE's count of every work item it has ever taken.
 */
export function takesOf(take: Take | null, defaults: { only: string | null; take: number | null }): Takes {
  if (take === null) {
    return { only: defaults.only, take: defaults.take === null ? null : { most: defaults.take, since: null } };
  }
  switch (take.kind) {
    case 'every':
      return { only: null, take: null };
    case 'next-few':
      return { only: null, take: { most: take.count, since: take.since } };
    case 'just-one':
      return { only: take.workItem, take: null };
  }
}

export class Queue {
  readonly #sql: Sql;
  /** Who this worker is, as its leases name it. */
  readonly #me: string;
  #only: string | null;
  #take: Takes['take'];

  constructor(sql: Sql, me: string, { only = null, take = null }: { only?: string | null; take?: number | null } = {}) {
    this.#sql = sql;
    this.#me = me;
    this.#only = only;
    this.#take = take === null ? null : { most: take, since: null };
  }

  /** What it takes from now on: the line sets it each pass, from Martin's take or its own default. */
  takes({ only, take }: Takes): void {
    this.#only = only;
    this.#take = take;
  }

  /**
   * Takes the next work item into Plan, if nothing is in Plan or waiting for Build: the oldest open ticket of the
   * highest severity that has never been on the line, or, with none, the oldest improvement Martin asked for that has
   * never been on it. Returns its work item, or undefined. A queue of one takes its own ticket or improvement, if it
   * is open and not yet on the line, and no other. A queue with a limit takes none once the line has taken that many
   * work items since it was set, whichever they were, but for those that closed on the look as they were taken.
   */
  async admit(): Promise<string | undefined> {
    const only = this.#only;
    const take = this.#take;
    return this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('line'))`;
      if (take !== null) {
        // `since` goes as text, for Postgres to read to the microsecond: as a timestamptz, postgres.js would make a
        // `Date` of it first, which keeps only milliseconds.
        const [row] = await tx<{ taken: number }[]>`
          select count(*)::int as taken from line l
          where not ${closedAtTake(tx)}
            ${take.since === null ? tx`` : tx`and l.taken_at >= ${take.since}::text::timestamptz`}`;
        if ((row?.taken ?? 0) >= take.most) return undefined;
      }
      const [busy] = only ? [] : await tx`select 1 from line where stage in ('plan', 'build') limit 1`;
      if (busy) return undefined;
      // Tickets first (0), by severity; then improvements (1). Within each, the oldest first.
      const [taken] = await tx<{ work_item: string }[]>`
        insert into line (work_item, stage)
        select t.work_item, 'plan' from events t
        where not t.sample ${only ? tx`and t.work_item = ${only}` : tx``}
          and ((t.type = 'ticket.opened' and not ${openedAsImprovement(tx, 't.work_item')})
               or (t.type = 'improvement.requested' and ${byMartin(tx, 't')} and ${askedByMartin(tx, 't.work_item')}))
          and ${lastEnd(tx, 't.work_item')} is distinct from 'work-item.closed'
          and not exists (select 1 from line l where l.work_item = t.work_item)
        order by case t.type when 'ticket.opened' then 0 else 1 end,
                 case t.payload->>'severity' when 'broken' then 3 when 'degraded' then 2 else 1 end desc, t.seq
        limit 1
        returning work_item`;
      return taken?.work_item;
    }) as Promise<string | undefined>;
  }

  /**
   * The work items that reopened since the line last took them back, nobody holds, and are ready to come back into
   * Plan (`VOLUME_GONE_SECONDS` after an end): only the one, for a queue of one.
   */
  async reopened(): Promise<QueueItem[]> {
    const sql = this.#sql;
    const rows = await sql<Row[]>`
      select ${sql(COLUMNS)} from line l
      where ${reopenedSince(sql)} and ${unheld(sql)}
        and (l.stage <> 'ended' or l.moved_at < clock_timestamp() - make_interval(secs => ${VOLUME_GONE_SECONDS}))
        ${this.#only ? sql`and l.work_item = ${this.#only}` : sql``}
      order by l.taken_at`;
    return rows.map(item);
  }

  /**
   * Takes a reopened work item back into Plan, if it has reopened since the line last took it back and nobody holds
   * it, for a fresh pass: nothing of its last step carries over, nor the coder's session. Its count of steps does, since
   * it names the next step's job. Without its issue (`forgetIssue`), the line opens a new one.
   */
  async revive(workItem: string, { forgetIssue = false } = {}): Promise<boolean> {
    const sql = this.#sql;
    const rows = await sql<Left[]>`
      with was as (select work_item, stage, moved_at from line where work_item = ${workItem} for update)
      update line l set stage = 'plan', moved_at = clock_timestamp(), failures = 0, failure = null, effects = null,
                        session = null, ${forgetIssue ? sql`issue = null,` : sql``}
                        reopened = (select max(r.seq) from events r
                                    where r.work_item = l.work_item and r.type = 'work-item.reopened')
      from was
      where l.work_item = was.work_item and ${reopenedSince(sql)} and ${unheld(sql)}
      returning ${LEFT(sql)}`;
    // Its time in Plan starts again, so a row already there has left it too.
    for (const row of rows) leftStage(row.was, 'plan', row.seconds, true);
    return rows.length > 0;
  }

  /**
   * Every work item the line has taken, ended or not, longest on it first, and whether it reopened and waits to come
   * back into Plan: only the one, for a queue of one.
   */
  async all(): Promise<(QueueItem & { waiting: boolean })[]> {
    const sql = this.#sql;
    const rows = await sql<(Row & { waiting: boolean })[]>`
      select ${sql(COLUMNS)}, ${reopenedSince(sql)} as waiting from line l
      ${this.#only ? sql`where l.work_item = ${this.#only}` : sql``}
      order by l.taken_at`;
    return rows.map((row) => ({ ...item(row), waiting: row.waiting }));
  }

  /** The work items on the line that nobody holds, longest on it first: only the one, for a queue of one. */
  async free(): Promise<QueueItem[]> {
    const rows = await this.#sql<Row[]>`
      select ${this.#sql(COLUMNS)} from line l
      where l.stage <> 'ended' and ${unheld(this.#sql)} and not ${reopenedSince(this.#sql)}
        ${this.#only ? this.#sql`and l.work_item = ${this.#only}` : this.#sql``}
      order by l.taken_at`;
    return rows.map(item);
  }

  /**
   * Holds a work item for this worker for a while, so no other acts on it meanwhile. Undefined if another holds it,
   * it has ended, or it reopened and waits to come back into Plan. A step's lease outlasts the step's deadline; a crash
   * leaves it to run out. With `ended`, one that has ended too: an improvement handed over, whose dry run a line going
   * live ends, so that two lines never both end it.
   */
  async claim(workItem: string, seconds: number, { ended = false } = {}): Promise<QueueItem | undefined> {
    const [row] = await this.#sql<Row[]>`
      update line l set held_by = ${this.#me}, held_until = clock_timestamp() + make_interval(secs => ${seconds})
      where l.work_item = ${workItem} and (${ended} or l.stage <> 'ended') and not ${reopenedSince(this.#sql)}
        and (l.held_until is null or l.held_until < clock_timestamp() or l.held_by = ${this.#me})
      returning ${this.#sql(COLUMNS)}`;
    return row && item(row);
  }

  /** A work item on the line, ended or not. */
  async get(workItem: string): Promise<QueueItem | undefined> {
    const [row] = await this.#sql<Row[]>`
      select ${this.#sql(COLUMNS)} from line where work_item = ${workItem}`;
    return row && item(row);
  }

  /** Records where a work item this worker holds now is, keeping hold of it. */
  async move(workItem: string, stage: QueueStage): Promise<void> {
    await this.#moveTo(workItem, stage, false);
  }

  /** Lets go of a work item, recording where it now is. */
  async release(workItem: string, stage: QueueStage): Promise<void> {
    await this.#moveTo(workItem, stage, true);
  }

  /**
   * Moves a work item this worker holds to `stage`, letting go of it if `letGo`, and records the time at the stage it
   * left. Its row is locked as it is read, so the stage it left is the one the update replaces.
   */
  async #moveTo(workItem: string, stage: QueueStage, letGo: boolean): Promise<void> {
    const sql = this.#sql;
    const rows = await sql<Left[]>`
      with was as (select work_item, stage, moved_at from line where work_item = ${workItem} for update)
      update line l set ${letGo ? sql`held_by = null, held_until = null,` : sql``} stage = ${stage},
                        moved_at = case when l.stage = ${stage} then l.moved_at else clock_timestamp() end
      from was where l.work_item = was.work_item and l.held_by = ${this.#me}
      returning ${LEFT(sql)}`;
    for (const row of rows) leftStage(row.was, stage, row.seconds);
  }

  /**
   * Counts a step started, and returns its number within the work item, which names the step's job and job token: no
   * earlier job of the work item has had that number. It comes after both the row's count and the last number in a
   * job token's name (`runners/jobs.ts`), so a work item whose row was made afresh, as by a hand edit, never reuses
   * one. A name that does not end in a number of up to nine digits is not one of the line's, and counts for nothing.
   */
  async startStep(workItem: string): Promise<number> {
    const [row] = await this.#sql<{ steps: number }[]>`
      update line l set steps = 1 + greatest(l.steps, coalesce(
        (select max(substring(t.job from '-([0-9]{1,9})$')::int) from job_tokens t where t.work_item = l.work_item), 0))
      where l.work_item = ${workItem} returning l.steps`;
    if (!row) throw new Error(`Work item ${workItem} is not on the line.`);
    return row.steps;
  }

  /** Counts a failed attempt at the step in hand, with why: its handback, if one was kept, is over. */
  async failed(workItem: string, reason: string): Promise<void> {
    await this.#sql`update line set failures = failures + 1, failure = ${cutTo(reason, 500)}, effects = null
                    where work_item = ${workItem}`;
  }

  /** The work item moved on: its step in hand has not failed yet, and no handback waits for its effects. */
  async moved(workItem: string): Promise<void> {
    await this.#sql`update line set failures = 0, failure = null, effects = null where work_item = ${workItem}`;
  }

  /** Keeps a handback until its effects are done. */
  async keep(workItem: string, pending: Pending): Promise<void> {
    await this.#sql`update line set effects = ${this.#sql.json(pending as unknown as JSONValue)}
                    where work_item = ${workItem}`;
  }

  /** Lets go of a handback whose effects will not be tried again. */
  async drop(workItem: string): Promise<void> {
    await this.#sql`update line set effects = null where work_item = ${workItem}`;
  }

  /** Records that one of a kept handback's writes has begun, before it is made. */
  async begun(workItem: string, name: string): Promise<void> {
    await this.#sql`
      update line set effects = jsonb_set(effects, '{begun}', (effects->'begun') || to_jsonb(${name}::text))
      where work_item = ${workItem} and effects is not null`;
  }

  /**
   * Records what one of a kept handback's writes gave back, once it is made. A write that gave back nothing is kept
   * as JSON's null: SQL's null would make `jsonb_set` lose the whole handback.
   */
  async done(workItem: string, name: string, result: JSONValue): Promise<void> {
    await this.#sql`
      update line set effects = jsonb_set(
        effects, array['done', ${name}::text], coalesce(${this.#sql.json(result)}::jsonb, 'null'::jsonb))
      where work_item = ${workItem} and effects is not null`;
  }

  /** Counts a failed try at a kept handback's effects, with why and when to try again. */
  async effectsFailed(workItem: string, reason: string, retryAt: Date): Promise<void> {
    await this.#sql`
      update line set effects = effects || jsonb_build_object(
        'tries', (effects->>'tries')::int + 1, 'failure', ${cutTo(reason, 500)}::text,
        'retryAt', ${retryAt.toISOString()}::text)
      where work_item = ${workItem} and effects is not null`;
  }

  async setIssue(workItem: string, issue: number): Promise<void> {
    await this.#sql`update line set issue = ${issue} where work_item = ${workItem}`;
  }

  async setSession(workItem: string, session: string | null): Promise<void> {
    await this.#sql`update line set session = ${session} where work_item = ${workItem}`;
  }

  /** Lets go of everything this worker holds, as it stops. */
  async releaseAll(): Promise<void> {
    await this.#sql`update line set held_by = null, held_until = null where held_by = ${this.#me}`;
  }
}
