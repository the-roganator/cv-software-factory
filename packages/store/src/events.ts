/**
 * Appending to the event store and reading from it. The rules that matter are in the database as well as here
 * (0001_events.sql): events are append-only, commit in seq order and are never mixed with samples, and the
 * console's role can read public views and nothing else.
 */
import {
  CATALOGUE,
  type Catalogue,
  type NewEvent,
  type RawEvent,
  type StoredEvent,
  upcast,
} from '@software-factory/events';
import { publicView } from '@software-factory/events/public';
import { validate } from '@software-factory/events/schemas';
import type { Sql, TransactionSql } from 'postgres';
import type { ArtifactStore } from './artifacts.ts';
import type { JSONValue } from './client.ts';
import { fromMartin, openedAsImprovement } from './commands.ts';

/**
 * A flag's own events, which an improvement closed as turned off or as verified still takes: the flag outlives the
 * close.
 */
const FLAG_TYPES: ReadonlySet<string> = new Set(['flag.staged', 'flag.compared', 'flag.checked']);

/** An append the store refused, with every reason it found. Nothing in the batch was stored. */
export class AppendRefused extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`The event store refused the append:\n  ${problems.join('\n  ')}`);
    this.name = 'AppendRefused';
    this.problems = problems;
  }
}

export interface WriterOptions {
  /** Whether this writer appends samples or real events. The store takes one or the other, never both. */
  kind: 'sample' | 'real';
  /** Where the events' artifacts must already be. */
  artifacts: ArtifactStore;
}

/** The factory's side of the store: it appends, as whichever role it connects as. */
export class EventWriter {
  readonly #sql: Sql;
  readonly #options: WriterOptions;

  constructor(sql: Sql, options: WriterOptions) {
    this.#sql = sql;
    this.#options = options;
  }

  /**
   * Validates the events, writes each with its public view and notifies listeners, in one transaction. An event
   * already stored with the same id and the same content is not stored again, so a worker can retry an append that
   * may or may not have committed; the same id with different content is refused.
   */
  async append(events: NewEvent | readonly NewEvent[]): Promise<StoredEvent[]> {
    const batch = await this.#checked(events);
    return this.#sql.begin((tx) => this.#write(tx, batch)) as Promise<StoredEvent[]>;
  }

  /**
   * Appends as `append` does, within a transaction of the caller's, so the events commit with whatever else it does,
   * or not at all. The store's lock on appends is held until it ends: keep it short.
   */
  async appendWithin(tx: TransactionSql, events: NewEvent | readonly NewEvent[]): Promise<StoredEvent[]> {
    return this.#write(tx, await this.#checked(events));
  }

  async #checked(events: NewEvent | readonly NewEvent[]): Promise<readonly NewEvent[]> {
    const batch: readonly NewEvent[] = Array.isArray(events) ? events : [events as NewEvent];
    const problems = [...batch.flatMap(checkShape), ...(await this.#checkArtifacts(batch))];
    if (problems.length) throw new AppendRefused(problems);
    return batch;
  }

  async #write(tx: TransactionSql, batch: readonly NewEvent[]): Promise<StoredEvent[]> {
    // The insert takes this lock too; taking it first means the checks below see what the insert will see.
    await lockAppends(tx);
    const { stored, retried } = await this.#checkRetries(tx, batch);
    if (retried.length) throw new AppendRefused(retried);
    const fresh = batch.filter((event) => !stored.has(event.id));
    const sequence = await this.#checkSequence(tx, fresh);
    if (sequence.length) throw new AppendRefused(sequence);

    const rows = fresh.map((event) => ({
      id: event.id,
      ts: event.ts,
      work_item: event.work_item,
      type: event.type,
      version: event.version,
      actor: event.actor,
      summary: event.summary,
      payload: tx.json(event.payload as JSONValue),
      artifacts: tx.json(event.artifacts as JSONValue),
      public: tx.json(publicView(event.type, event) as unknown as JSONValue),
      sample: this.#options.kind === 'sample',
    }));
    const inserted = rows.length
      ? await tx<{ id: string; seq: string }[]>`insert into events ${tx(rows)} returning id, seq`
      : [];
    const seqs = new Map([...stored, ...inserted.map((row) => [row.id, Number(row.seq)] as const)]);
    return batch.map(
      (event) => ({ ...event, seq: seqs.get(event.id), public: publicView(event.type, event) }) as StoredEvent,
    );
  }

  /** The events of the batch already stored, by id with their seq, and a reason for each stored differently. */
  async #checkRetries(tx: TransactionSql, batch: readonly NewEvent[]) {
    const rows = await tx<StoredRow[]>`
      select seq, id, ts, work_item, type, version, actor, summary, payload, artifacts
      from events where id in ${tx(batch.map((event) => event.id))}`;
    const stored = new Map<string, number>();
    const retried: string[] = [];
    for (const row of rows) {
      const i = batch.findIndex((event) => event.id === row.id);
      const event = batch[i] as NewEvent;
      const differ = differences(row, event);
      if (differ.length) {
        retried.push(`${where(batch, i)}: event ${row.id} is already stored, with a different ${differ.join(', ')}`);
      }
      stored.set(row.id, Number(row.seq));
    }
    return { stored, retried };
  }

  async #checkArtifacts(batch: readonly NewEvent[]): Promise<string[]> {
    const problems: string[] = [];
    for (const [i, event] of batch.entries()) {
      for (const artifact of event.artifacts) {
        const size = await this.#options.artifacts.size(artifact.hash);
        if (size === null) problems.push(`${where(batch, i)}: artifact ${artifact.hash} is not in the artifact store`);
        else if (size !== artifact.size) {
          problems.push(`${where(batch, i)}: artifact ${artifact.hash} is ${size} bytes, not ${artifact.size}`);
        }
      }
    }
    return problems;
  }

  /**
   * A work item opens once, before anything else happens to it, and nothing but its summary follows its close, until
   * it reopens; nothing, that is, but a flag's own events (Martin's moves, and the line's judgements of them) on a work
   * item closed as turned off, or on an improvement closed as verified, as a flag outlives those closes: one on for
   * everyone may be turned off and go straight back on, and be narrowed and compared again, on the work item it was
   * staged on. A work item closed any other way, a ticket verified among them, takes nothing more. Only a closed work
   * item reopens. The last of its closes and reopenings says whether it is closed, and how.
   */
  async #checkSequence(tx: TransactionSql, batch: readonly NewEvent[]): Promise<string[]> {
    const items = [...new Set(batch.flatMap((event) => (event.work_item ? [event.work_item] : [])))];
    const known = items.length
      ? await tx<
          { work_item: string; opened: boolean; improvement: boolean; closed: boolean; outcome: string | null }[]
        >`
          select ev.work_item,
                 bool_or(ev.type = 'work-item.opened') as opened,
                 ${openedAsImprovement(tx, 'ev.work_item')} as improvement,
                 coalesce((array_agg(ev.type order by ev.seq desc)
                   filter (where ev.type in ('work-item.closed', 'work-item.reopened')))[1] = 'work-item.closed', false)
                   as closed,
                 (array_agg(ev.payload->>'outcome' order by ev.seq desc)
                   filter (where ev.type in ('work-item.closed', 'work-item.reopened')))[1] as outcome
          from events ev where ev.work_item in ${tx(items)} group by ev.work_item`
      : [];
    const state = new Map(
      known.map((row) => [
        row.work_item,
        { opened: row.opened, closed: row.closed, flagsOutlive: flagsOutlive(row.improvement, row.outcome) },
      ]),
    );
    /** Whether each work item in the batch is an improvement, by its opening, stored or in the batch. */
    const improvement = new Map(known.map((row) => [row.work_item, row.improvement]));
    const problems: string[] = [];
    for (const [i, event] of batch.entries()) {
      if (event.work_item === null) continue;
      const item = state.get(event.work_item) ?? { opened: false, closed: false, flagsOutlive: false };
      const at = where(batch, i);
      if (event.type === 'work-item.opened') {
        if (item.opened) problems.push(`${at}: work item ${event.work_item} is already open`);
        if (event.payload.sample !== (this.#options.kind === 'sample')) {
          problems.push(`${at}: this writer appends ${this.#options.kind === 'sample' ? 'samples' : 'real work'} only`);
        }
        item.opened = true;
        improvement.set(event.work_item, event.payload.kind === 'improvement');
      } else if (!item.opened) {
        problems.push(`${at}: work item ${event.work_item} has not been opened`);
      } else if (event.type === 'work-item.reopened') {
        if (!item.closed) problems.push(`${at}: work item ${event.work_item} is not closed`);
      } else if (
        item.closed &&
        event.type !== 'work-item.summarised' &&
        !(item.flagsOutlive && FLAG_TYPES.has(event.type))
      ) {
        problems.push(`${at}: work item ${event.work_item} is closed`);
      }
      if (event.type === 'work-item.closed') {
        item.closed = true;
        item.flagsOutlive = flagsOutlive(improvement.get(event.work_item) ?? false, event.payload.outcome);
      }
      if (event.type === 'work-item.reopened') item.closed = item.flagsOutlive = false;
      state.set(event.work_item, item);
    }
    return problems;
  }
}

/** Whether a work item closed with this outcome still takes its flags' events: turned off, or a verified improvement. */
const flagsOutlive = (improvement: boolean, outcome: string | null): boolean =>
  outcome === 'turned-off' || (improvement && outcome === 'verified');

interface StoredRow {
  seq: string;
  id: string;
  ts: Date;
  work_item: string | null;
  type: string;
  version: number;
  actor: string;
  summary: string;
  payload: unknown;
  artifacts: unknown;
}

/** The fields in which a stored event differs from one appended again with its id. */
function differences(row: StoredRow, event: NewEvent): string[] {
  const fields: [string, unknown, unknown][] = [
    ['ts', row.ts.getTime(), Date.parse(event.ts)],
    ['work_item', row.work_item, event.work_item],
    ['type', row.type, event.type],
    ['version', row.version, event.version],
    ['actor', row.actor, event.actor],
    ['summary', row.summary, event.summary],
    ['payload', canonical(row.payload), canonical(event.payload)],
    ['artifacts', canonical(row.artifacts), canonical(event.artifacts)],
  ];
  return fields.filter(([, a, b]) => a !== b).map(([name]) => name);
}

/** JSON with its keys in order, as Postgres's jsonb keeps them, so two equal values compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

function checkShape(event: NewEvent, i: number, batch: readonly NewEvent[]): string[] {
  const result = validate(event);
  return result.ok ? [] : result.problems.map((problem) => `${where(batch, i)}: ${problem}`);
}

const where = (batch: readonly NewEvent[], i: number) => {
  const event = batch[i];
  return batch.length === 1 ? `${event?.type}` : `event ${i + 1} (${event?.type})`;
};

/** The next work item's number, from the store's sequence: 1000 for the first in a real store. */
export async function nextWorkItem(sql: Sql | TransactionSql): Promise<string> {
  const [row] = await sql<{ next: string }[]>`select nextval('work_items')::text as next`;
  if (!row) throw new Error('The store gave no work item number');
  return row.next;
}

/**
 * The last of a work item's closes and reopenings, as SQL to compare: `work-item.closed` while it is closed, and null
 * for one that never closed. `column` names the work item in the query around it, qualified by its table, such as
 * `t.work_item`: unqualified, it would name the subquery's own.
 */
/**
 * The lock every append takes, in its transaction: one taken by an action that reads the events before it appends
 * (an answer, a save, a stop) lands wholly before or after any other append.
 */
export const lockAppends = (tx: TransactionSql) => tx`select pg_advisory_xact_lock(hashtext('events'))`;

export const lastEnd = (sql: Sql | TransactionSql, column: string) =>
  sql`(select last_end.type from events last_end where last_end.work_item = ${sql(column)}
       and last_end.type in ('work-item.closed', 'work-item.reopened') order by last_end.seq desc limit 1)`;

/** Whether the store holds samples or real events, or null while it holds neither. */
export async function storeKind(sql: Sql): Promise<'sample' | 'real' | null> {
  const [row] = await sql<{ sample: boolean }[]>`select sample from store`;
  return row ? (row.sample ? 'sample' : 'real') : null;
}

interface PublicRow {
  seq: string;
  id: string;
  ts: Date;
  work_item: string | null;
  type: string;
  version: number;
  actor: string;
  public: { summary: string; payload: unknown; artifacts: unknown[] };
  appended_at: Date;
  /** The role that appended it, which the store sets; none for an event from before it did. */
  appended_by: string | null;
}

/** A public event as read, upcast to its current version if this factory knows its type and version. */
export interface ReadEvent {
  event: RawEvent & { seq: number };
  /** When the store took it, for measuring how long it takes to reach a browser. */
  appendedAt: Date;
  /** False when a newer factory wrote it: it is passed on as it is, for the console to say so. */
  understood: boolean;
}

/**
 * Reads public events in seq order, after the one given. Uses only the columns the console's role may read, so
 * the console and the factory read public events the same way.
 */
export async function readPublic(
  sql: Sql,
  after: number,
  { limit = 1000, catalogue = CATALOGUE }: { limit?: number; catalogue?: Catalogue } = {},
): Promise<ReadEvent[]> {
  const rows = await sql<PublicRow[]>`
    select seq, id, ts, work_item, type, version, actor, public, appended_at, appended_by
    from events where seq > ${after} order by seq limit ${limit}`;
  return rows.map((row) => {
    const raw = {
      id: row.id,
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      work_item: row.work_item,
      type: row.type,
      version: row.version,
      actor: row.actor,
      summary: row.public.summary,
      payload: row.public.payload,
      artifacts: row.public.artifacts,
      ...(row.appended_by !== null && { appended_by: row.appended_by }),
    };
    const result = upcast(raw, catalogue);
    return {
      event: result.ok ? (result.event as RawEvent & { seq: number }) : raw,
      appendedAt: row.appended_at,
      understood: result.ok,
    };
  });
}

interface FullRow extends Omit<PublicRow, 'public'> {
  summary: string;
  payload: unknown;
  artifacts: unknown[];
}

/**
 * Reads full events in seq order, after the one given: Martin's view, which the admin service streams to his session
 * and nobody else's. An admin event that none of his roles appended is left out, as the factory ignores it.
 */
export async function readFull(
  sql: Sql,
  after: number,
  { limit = 1000, catalogue = CATALOGUE }: { limit?: number; catalogue?: Catalogue } = {},
): Promise<ReadEvent[]> {
  const rows = await sql<FullRow[]>`
    select e.seq, e.id, e.ts, e.work_item, e.type, e.version, e.actor, e.summary, e.payload, e.artifacts, e.appended_at,
           e.appended_by
    from events e where e.seq > ${after} and ${fromMartin(sql, 'e')} order by e.seq limit ${limit}`;
  return rows.map((row) => {
    const raw = {
      id: row.id,
      seq: Number(row.seq),
      ts: row.ts.toISOString(),
      work_item: row.work_item,
      type: row.type,
      version: row.version,
      actor: row.actor,
      summary: row.summary,
      payload: row.payload,
      artifacts: row.artifacts,
      ...(row.appended_by !== null && { appended_by: row.appended_by }),
    };
    const result = upcast(raw, catalogue);
    return {
      event: result.ok ? (result.event as RawEvent & { seq: number }) : raw,
      appendedAt: row.appended_at,
      understood: result.ok,
    };
  });
}

/**
 * Calls back with each new seq as appends commit. After a dropped connection it listens again and calls `onReady`
 * once more, so the caller can read whatever it missed meanwhile.
 */
export async function listen(sql: Sql, onAppended: (seq: number) => void, onReady: () => void) {
  return sql.listen('events', (payload) => onAppended(Number(payload)), onReady);
}
