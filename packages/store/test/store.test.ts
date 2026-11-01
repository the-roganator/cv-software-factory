import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewEvent } from '@software-factory/events';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiskArtifacts } from '../src/artifacts.ts';
import { AppendRefused, EventWriter, listen, readPublic } from '../src/events.ts';
import { migrate } from '../src/migrate.ts';
import { readyOperator } from '../src/operator.ts';
import { type Database, freshDatabase } from './database.ts';

let owner: Sql; // the database's owner, as the migration Job connects
let triage: Sql; // a worker's role, which appends events as every worker may
let reader: Sql;
let scoreboard: Sql;
let metrics: Sql;
let database: Database;
const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));

beforeAll(async () => {
  database = await freshDatabase('store');
  ({ owner, reader, scoreboard, metrics } = database);
  triage = database.as.triage;
});

afterAll(() => database?.end());

let n = 0;
/** A fresh work item number for each test, so tests don't trip over each other's items. */
const nextItem = () => String(2000 + ++n);
const uuid = () => crypto.randomUUID();
const at = (minute: number) => new Date(Date.UTC(2026, 9, 2, 12, minute)).toISOString();

function opened(item: string, sample = true): NewEvent<'work-item.opened'> {
  return {
    id: uuid(),
    ts: at(0),
    work_item: item,
    type: 'work-item.opened',
    version: 2,
    actor: 'visitor',
    summary: 'A visitor sent a report',
    payload: { kind: 'visitor-report', title: 'A report on the clock', sample, visitor: { key: 'amber-otter' } },
    artifacts: [],
  };
}

function report(item: string): NewEvent<'signal.received'> {
  return {
    id: uuid(),
    ts: at(1),
    work_item: item,
    type: 'signal.received',
    version: 4,
    actor: 'widget',
    summary: 'Report: the clock says ten past four',
    payload: {
      sense: 'report',
      check: 'report widget',
      route: '/products/:slug',
      version: 'v0.9.2',
      report: { page: '/products/clock-stopped', text: 'the clock says ten past four' },
    },
    artifacts: [],
  };
}

const samples = () => new EventWriter(triage, { kind: 'sample', artifacts });

describe('migrations', () => {
  it('apply once: a second run finds nothing to do', async () => {
    expect(await migrate(owner)).toEqual([]);
    expect(await owner`select version, name from schema_migrations order by version`).toEqual([
      { version: 1, name: 'events' },
      { version: 2, name: 'store-kind-work-items-and-inbox' },
      { version: 3, name: 'model-calls' },
      { version: 4, name: 'job-tokens-and-agent-calls' },
      { version: 5, name: 'line' },
      { version: 6, name: 'line-effects' },
      { version: 7, name: 'planner-findings' },
      { version: 8, name: 'line-release-verify' },
      { version: 9, name: 'reopen-verified' },
      { version: 10, name: 'pictures' },
      { version: 11, name: 'canary-sense' },
      { version: 12, name: 'scoreboard' },
      { version: 13, name: 'forget-pictures' },
      { version: 14, name: 'burst' },
      { version: 15, name: 'environment-holds' },
      { version: 16, name: 'line-waiting' },
      { version: 17, name: 'step-logs' },
      { version: 18, name: 'metrics-reader' },
      { version: 19, name: 'job-tokens-by-work-item' },
      { version: 20, name: 'prune-inbox' },
      { version: 21, name: 'job-token-trace' },
      { version: 22, name: 'worker-roles' },
      { version: 23, name: 'martins-commands' },
      { version: 24, name: 'drop-writer' },
      { version: 25, name: 'admin-service' },
      { version: 26, name: 'admin-stepped-up' },
      { version: 27, name: 'release-controls' },
      { version: 28, name: 'settings' },
      { version: 29, name: 'suggestion-holds' },
      { version: 30, name: 'line-controls' },
      { version: 31, name: 'session-30-minutes' },
      { version: 32, name: 'forget-reports' },
      { version: 33, name: 'flag-stages' },
      { version: 34, name: 'flag-pictures' },
      { version: 35, name: 'improvement-requests' },
      { version: 36, name: 'flag-picture-schemes' },
      { version: 37, name: 'alerts-switched' },
      { version: 38, name: 'line-reads-sign-ins' },
      { version: 39, name: 'release-events-the-lines' },
      { version: 40, name: 'refusals-by-mechanism' },
      { version: 41, name: 'refusals-as-they-read' },
      { version: 42, name: 'refusals-before-guardrails' },
      { version: 43, name: 'guardrail-proofs' },
      { version: 44, name: 'proofs-read-no-refusals' },
    ]);
  });
});

describe('appending', () => {
  it('stores a work item’s events in order, each with its public view', async () => {
    const item = nextItem();
    const stored = await samples().append([opened(item), report(item)]);
    expect(stored.map((e) => e.seq)).toEqual([stored[0]?.seq, (stored[0]?.seq ?? 0) + 1]);
    expect(stored[1]?.public.summary).toBe('A visitor reported a problem on /products/clock-stopped');

    const read = await readPublic(reader, (stored[0]?.seq ?? 1) - 1);
    expect(read.map(({ event }) => event.type)).toEqual(['work-item.opened', 'signal.received']);
    // With the role that appended each, which the console counts a refusal by.
    expect(read.map(({ event }) => (event as { appended_by?: string }).appended_by)).toEqual([
      'factory_triage',
      'factory_triage',
    ]);
    expect(JSON.stringify(read)).not.toContain('ten past four');
    expect(JSON.stringify(read)).not.toContain('amber-otter');
  });

  it('refuses an invalid event, with the reason, and stores nothing from its batch', async () => {
    const item = nextItem();
    const bad = { ...report(item), payload: { ...report(item).payload, route: 'products' } };
    const error = await samples()
      .append([opened(item), bad])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppendRefused);
    expect((error as AppendRefused).problems).toEqual([
      'event 2 (signal.received): payload.route: a path, such as /products/:slug',
    ]);
    expect(await owner`select 1 from events where work_item = ${item}`).toHaveLength(0);
  });

  it('opens a work item once, before anything else happens to it', async () => {
    const item = nextItem();
    await expect(samples().append(report(item))).rejects.toThrow(`work item ${item} has not been opened`);
    await samples().append(opened(item));
    await expect(samples().append(opened(item))).rejects.toThrow(`work item ${item} is already open`);
  });

  it('accepts nothing after a work item closes but its summary', async () => {
    const item = nextItem();
    const close: NewEvent<'work-item.closed'> = {
      ...opened(item),
      id: uuid(),
      type: 'work-item.closed',
      version: 2,
      actor: 'triage',
      summary: 'Closed: not a defect',
      payload: { outcome: 'no-change', reason: 'The page says the clock is stopped' },
    };
    const summary: NewEvent<'work-item.summarised'> = {
      ...opened(item),
      id: uuid(),
      type: 'work-item.summarised',
      version: 1,
      actor: 'triage',
      summary: 'Summarised',
      payload: { title: 'A visitor says the clock is wrong', description: 'It is sold as stopped.', story: 'It is.' },
    };
    await samples().append([opened(item), close, summary]);
    await expect(samples().append(report(item))).rejects.toThrow(`work item ${item} is closed`);
  });

  it('accepts Martin’s moves of an improvement’s flag after it closes as turned off: back on from Everyone', async () => {
    const item = nextItem();
    const staged = (from: string, to: string, action: string): NewEvent<'flag.staged'> =>
      ({
        ...opened(item),
        id: uuid(),
        type: 'flag.staged',
        version: 1,
        actor: 'martin',
        summary: `Martin moved last-one from ${from} to ${to}`,
        payload: {
          flag: 'last-one',
          from: { stage: from },
          to: { stage: to },
          action,
          revision: `r${uuid().slice(0, 4)}`,
          ...(to === 'off' && { reason: 'Wrong when there are two' }),
          steppedUp: action === 'flag.back-on',
        },
      }) as NewEvent<'flag.staged'>;
    const close: NewEvent<'work-item.closed'> = {
      ...opened(item),
      id: uuid(),
      type: 'work-item.closed',
      version: 2,
      actor: 'factory',
      summary: 'Closed: Martin turned last-one off, from Everyone',
      payload: { outcome: 'turned-off', reason: 'Wrong when there are two' },
    };
    // Martin's moves are his commands, which only his roles may append.
    const martin = new EventWriter(database.admin, { kind: 'sample', artifacts });
    await samples().append(opened(item));
    await martin.append(staged('everyone', 'off', 'flag.off'));
    await samples().append(close);
    await martin.append(staged('off', 'everyone', 'flag.back-on'));
    // Back on, narrowed to Checks, and checked there by the line.
    await martin.append(staged('everyone', 'checks', 'flag.narrow'));
    await samples().append({
      ...opened(item),
      id: uuid(),
      type: 'flag.checked',
      version: 3,
      actor: 'factory',
      summary: 'last-one at Checks: could not tell',
      payload: {
        stage: 'checks',
        flag: 'last-one',
        version: 'v0.9.5',
        revision: 'r1',
        moveRevision: 'r1',
        against: null,
        outcome: 'unsure',
        journeys: { base: null, change: { passed: 1, ran: 1 } },
        regressions: [],
        pages: [],
      },
    } as NewEvent);
    await expect(samples().append(report(item))).rejects.toThrow(`work item ${item} is closed`);

    // Not on a work item closed any other way.
    const other = nextItem();
    await samples().append([
      opened(other),
      { ...close, id: uuid(), work_item: other, payload: { outcome: 'no-change', reason: 'Closed' } },
    ]);
    await expect(martin.append({ ...staged('off', 'checks', 'flag.to-checks'), work_item: other })).rejects.toThrow(
      `work item ${other} is closed`,
    );
  });

  it('accepts Martin’s moves of an improvement’s flag after it closes as verified at Everyone, and of no ticket', async () => {
    const staged = (item: string, from: string, to: string, action: string): NewEvent<'flag.staged'> =>
      ({
        ...opened(item),
        id: uuid(),
        type: 'flag.staged',
        version: 1,
        actor: 'martin',
        summary: `Martin moved last-one from ${from} to ${to}`,
        payload: {
          flag: 'last-one',
          from: from === 'share' ? { stage: from, share: 50 } : { stage: from },
          to: { stage: to },
          action,
          revision: `r${uuid().slice(0, 4)}`,
          ...(to === 'off' && { reason: 'Wrong when there are two' }),
          steppedUp: action !== 'flag.off',
        },
      }) as NewEvent<'flag.staged'>;
    const verified = (item: string): NewEvent<'work-item.closed'> => ({
      ...opened(item),
      id: uuid(),
      type: 'work-item.closed',
      version: 2,
      actor: 'factory',
      summary: 'Closed: last-one is on for everyone',
      payload: {
        outcome: 'verified',
        reason: "Martin widened last-one to Everyone, after Verify's comparison at Share passed",
      },
    });
    // An improvement and Martin's moves are his commands, which only his roles may append.
    const martin = new EventWriter(database.admin, { kind: 'sample', artifacts });
    const item = nextItem();
    await martin.append({
      ...opened(item),
      actor: 'martin',
      payload: { kind: 'improvement', title: 'Last one in stock', sample: true },
    });
    await martin.append(staged(item, 'share', 'everyone', 'flag.widen'));
    await samples().append(verified(item));
    // Off, and straight back on, on the closed improvement; and nothing else.
    await martin.append(staged(item, 'everyone', 'off', 'flag.off'));
    await martin.append(staged(item, 'off', 'everyone', 'flag.back-on'));
    await expect(samples().append(report(item))).rejects.toThrow(`work item ${item} is closed`);

    // Not on a ticket closed as verified, which is no improvement.
    const ticket = nextItem();
    await samples().append([opened(ticket), verified(ticket)]);
    await expect(martin.append(staged(ticket, 'everyone', 'off', 'flag.off'))).rejects.toThrow(
      `work item ${ticket} is closed`,
    );
  });

  it('reopens only a closed work item, which then takes events again until it closes again', async () => {
    const item = nextItem();
    const close: NewEvent<'work-item.closed'> = {
      ...opened(item),
      id: uuid(),
      type: 'work-item.closed',
      version: 2,
      actor: 'factory',
      summary: 'Verified, and closed',
      payload: { outcome: 'verified', reason: 'The probe passed twice in a row' },
    };
    const reopen = (): NewEvent<'work-item.reopened'> => ({
      ...opened(item),
      id: uuid(),
      type: 'work-item.reopened',
      version: 3,
      actor: 'triage',
      summary: 'Reopened: the probe saw it again',
      payload: {
        sense: 'probe',
        check: 'redirects resolve',
        route: '/products/clock-stopped',
        version: 'v0.9.3',
        reason: 'The probe saw it again',
        dryRun: false,
      },
    });
    await samples().append(opened(item));
    await expect(samples().append(reopen())).rejects.toThrow(`work item ${item} is not closed`);
    await samples().append([close, reopen(), report(item)]);
    await samples().append({ ...close, id: uuid() });
    await expect(samples().append(report(item))).rejects.toThrow(`work item ${item} is closed`);
  });

  it('refuses an artifact the artifact store does not have', async () => {
    const item = nextItem();
    const hash = await artifacts.put(new TextEncoder().encode('FAIL test/money.test.ts'));
    const file = { kind: 'file', hash, type: 'text/plain', name: 'output', size: 23 } as const;
    await samples().append({ ...opened(item), artifacts: [file] });
    const missing = { ...file, hash: 'f'.repeat(64) };
    await expect(samples().append({ ...opened(nextItem()), artifacts: [missing] })).rejects.toThrow(
      `artifact ${'f'.repeat(64)} is not in the artifact store`,
    );
  });

  it('notifies listeners when the append commits', async () => {
    const heard: number[] = [];
    const ready = Promise.withResolvers<void>();
    const subscription = await listen(reader, (seq) => heard.push(seq), ready.resolve);
    await ready.promise;
    const item = nextItem();
    const [first] = await samples().append(opened(item));
    await expect.poll(() => heard).toContain(first?.seq);
    await subscription.unlisten();
  });

  it('commits events in seq order, however many writers append at once', async () => {
    const before = Number((await owner`select coalesce(max(seq), 0) as max from events`)[0]?.max);
    const heard: number[] = [];
    const ready = Promise.withResolvers<void>();
    const subscription = await listen(reader, (seq) => heard.push(seq), ready.resolve);
    await ready.promise;
    await Promise.all(Array.from({ length: 12 }, () => samples().append(opened(nextItem()))));
    await expect.poll(() => heard.filter((seq) => seq > before)).toHaveLength(12);
    const after = heard.filter((seq) => seq > before);
    expect(after).toEqual([...after].sort((a, b) => a - b));
    await subscription.unlisten();
  });
});

describe('append-only, by mechanism', () => {
  it('lets nobody update, delete or truncate an event, not even its owner', async () => {
    await samples().append(opened(nextItem()));
    await expect(owner`update events set summary = 'rewritten'`).rejects.toThrow('append-only, so update is refused');
    await expect(owner`delete from events`).rejects.toThrow('append-only, so delete is refused');
    await expect(owner`truncate events`).rejects.toThrow('append-only, so truncate is refused');
  });

  it('gives no worker the right to change an event', async () => {
    for (const [name, sql] of Object.entries(database.as)) {
      await expect(sql`update events set summary = 'rewritten'`, name).rejects.toThrow('permission denied');
      await expect(sql`delete from events`, name).rejects.toThrow('permission denied');
      await expect(sql`truncate events`, name).rejects.toThrow('permission denied');
    }
  });

  it('lets the console read public views and nothing else', async () => {
    await expect(reader`select payload from events`).rejects.toThrow('permission denied');
    await expect(reader`select summary from events`).rejects.toThrow('permission denied');
    await expect(reader`select * from events`).rejects.toThrow('permission denied');
    expect(Array.isArray(await reader`select seq, public from events limit 1`)).toBe(true);
  });

  it('lets the console append nothing', async () => {
    const consoleWriter = new EventWriter(reader, { kind: 'sample', artifacts });
    await expect(consoleWriter.append(opened(nextItem()))).rejects.toThrow('permission denied');
    await expect(
      reader`insert into events (id, ts, type, version, actor, summary, payload, artifacts, public, sample)
             values (${uuid()}, now(), 'line.stopped', 1, 'martin', 'Stop', '{}', '[]', '{}', true)`,
    ).rejects.toThrow('permission denied');
  });

  it('lets the scoreboard read the events and append its own figures to a real store, and nothing else', async () => {
    const score: NewEvent<'score.updated'> = {
      id: uuid(),
      ts: at(0),
      work_item: null,
      type: 'score.updated',
      version: 1,
      actor: 'scoreboard',
      summary: 'The scoreboard is off: it has no answer key',
      payload: { keyed: false },
      artifacts: [],
    };
    // This store holds samples: its figures are refused here, by the writer and by SQL alike (the scoreboard's own
    // tests append them to a real store).
    await expect(new EventWriter(scoreboard, { kind: 'sample', artifacts }).append(score)).rejects.toThrow(
      'the scoreboard counts real tickets only',
    );
    await expect(
      scoreboard`insert into events (id, ts, type, version, actor, summary, payload, artifacts, public, sample)
                 values (${uuid()}, now(), 'score.updated', 1, 'scoreboard', 'Off', '{"keyed": false}', '[]', '{}', true)`,
    ).rejects.toThrow('the scoreboard counts real tickets only');
    expect(Array.isArray(await scoreboard`select seq, payload from events limit 1`)).toBe(true);
    // Nothing but its own figures, on the line, as itself.
    const refused = 'the scoreboard appends its own figures and nothing else';
    await expect(new EventWriter(scoreboard, { kind: 'sample', artifacts }).append(opened(nextItem()))).rejects.toThrow(
      refused,
    );
    await expect(
      new EventWriter(scoreboard, { kind: 'sample', artifacts }).append({ ...score, id: uuid(), actor: 'factory' }),
    ).rejects.toThrow(refused);
    await expect(scoreboard`update events set summary = 'rewritten'`).rejects.toThrow('permission denied');
    await expect(scoreboard`delete from events`).rejects.toThrow('permission denied');
    await expect(scoreboard`select nextval('work_items')`).rejects.toThrow('permission denied');
    await expect(scoreboard`create table mine (n integer)`).rejects.toThrow('permission denied');

    // Every privilege it holds is in policy/store-grants.ts, which grants.test.ts holds the store to.
  });

  it('lets the Postgres exporter read the server’s statistics, and nothing of the store', async () => {
    // What the exporter reads: connections against their ceiling, each database's size, each table's rows.
    const [database] = await metrics<{ numbackends: number }[]>`
      select numbackends from pg_stat_database where datname = current_database()`;
    expect(database?.numbackends).toBeGreaterThan(0);
    expect((await metrics`select setting from pg_settings where name = 'max_connections'`).length).toBe(1);
    expect((await metrics`select pg_database_size(current_database())`).length).toBe(1);
    expect((await metrics`select n_live_tup from pg_stat_user_tables where relname = 'events'`).length).toBe(1);
    // Not the events, or any other table, view or sequence; not another session's query; no role but its own.
    await expect(metrics`select seq from events limit 1`).rejects.toThrow('permission denied');
    await expect(metrics`select count(*) from store`).rejects.toThrow('permission denied');
    await triage`select 1`;
    const others = await metrics<{ query: string | null }[]>`
      select distinct query from pg_stat_activity where pid <> pg_backend_pid() and usesysid is not null`;
    expect(others).toEqual([{ query: '<insufficient privilege>' }]);
    const [role] = await owner<{ rolconnlimit: number; member_of: string[] }[]>`
      select rolconnlimit, array(select b.rolname from pg_auth_members m join pg_roles b on b.oid = m.roleid
                                 where m.member = r.oid) as member_of
      from pg_roles r where rolname = 'metrics_reader'`;
    expect(role).toEqual({ rolconnlimit: 4, member_of: [] });
  });

  it('never mixes samples with real events', async () => {
    const real = new EventWriter(triage, { kind: 'real', artifacts });
    await expect(real.append(opened(nextItem(), false))).rejects.toThrow(
      'this store holds sample events, so it refuses real ones',
    );
    await expect(samples().append(opened(nextItem(), false))).rejects.toThrow('this writer appends samples only');
  });
});

describe('reading', () => {
  it('upcasts an event stored at an older version', async () => {
    const item = nextItem();
    const [first] = await samples().append(opened(item));
    // As if a test-only version 2 of work-item.opened had called its title `name`; version 3 renamed it.
    const catalogue = {
      versions: { 'work-item.opened': 3 },
      upcasters: {
        'work-item.opened': { 2: ({ title, ...rest }: Record<string, unknown>) => ({ ...rest, name: title }) },
      },
    };
    const [read] = await readPublic(reader, (first?.seq ?? 1) - 1, { limit: 1, catalogue });
    expect(read?.understood).toBe(true);
    expect(read?.event).toMatchObject({ version: 3, payload: { name: 'A report on the clock' } });
  });

  it('passes on an event written by a newer factory, marked as not understood', async () => {
    const item = nextItem();
    const [first] = await samples().append(opened(item));
    const catalogue = { versions: {}, upcasters: {} };
    const [read] = await readPublic(reader, (first?.seq ?? 1) - 1, { limit: 1, catalogue });
    expect(read).toMatchObject({ understood: false, event: { type: 'work-item.opened', version: 2 } });
  });

  it('returns events after a seq, in order, up to a limit', async () => {
    const items = [nextItem(), nextItem(), nextItem()];
    const stored = await samples().append(items.map((item) => opened(item)));
    const from = stored[0]?.seq ?? 0;
    const read = await readPublic(reader, from, { limit: 1 });
    expect(read.map(({ event }) => event.seq)).toEqual([from + 1]);
  });
});

describe("Martin's command line", () => {
  // Neither readies his role here, so neither changes the password the run's setup gave it (postgres.ts) while other
  // files connect as it.
  it('connects as the owner on a store not yet migrated to his role, and fails on one migrated without it', async () => {
    const old = await freshDatabase('before_0023');
    try {
      // His role, made by another database on the server, may not append here.
      await old.owner`revoke insert on events from factory_operator`;
      await expect(readyOperator(old.owner, 'operator-test')).rejects.toThrow("Martin's role cannot append events");
      // As a store before 0023 has it.
      await old.owner`delete from schema_migrations where version >= 23`;
      const [me] = await old.owner<{ me: string }[]>`select current_user as me`;
      expect(await readyOperator(old.owner, 'operator-test')).toBe(me?.me);
    } finally {
      await old.end();
    }
  });
});
