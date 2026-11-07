/**
 * Triage's worker through a store it cannot reach for a while: it waits it out, takes its lock again on a new
 * connection before another pass, and never triages alongside another copy.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxSignal } from '@software-factory/events';
import { DiskArtifacts, EventWriter, sendSignal } from '@software-factory/store';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { type Database, freshDatabase } from '../../../store/test/database.ts';
import { startLine } from '../../../store/test/line.ts';
import { PASSWORDS } from '../../../store/test/postgres.ts';
import { idsFor } from '../../src/events.ts';
import type { Judge } from '../../src/judge.ts';
import { type Outage, Triage, type TriageOptions } from '../../src/worker.ts';

let database: Database;
/** A second copy's own connections, as triage's role. */
let other: Sql;
const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
const quiet = { info: () => {}, warn: () => {} };
const brief: Outage = { firstMs: 50, mostMs: 200, tries: 4 };

beforeAll(async () => {
  database = await freshDatabase('triage_outage');
  const server = new URL(inject('databaseUrl'));
  other = postgres({
    host: server.hostname,
    port: Number(server.port),
    database: database.name,
    username: 'factory_triage',
    password: PASSWORDS.triage,
    onnotice: () => {},
  });
  await startLine(database.admin);
});
/** Each test's copies, stopped after it, so a test that fails leaves none running into the next. */
const copies: Promise<void>[] = [];
let abort = new AbortController();
afterEach(async () => {
  abort.abort();
  await Promise.allSettled(copies.splice(0));
  abort = new AbortController();
  // A day back, so that no test's tickets count toward the next one's burst.
  await database.owner`update inbox set received_at = received_at - interval '1 day'`;
});
afterAll(async () => {
  await other?.end();
  await database?.end();
});

const found = (route: string): InboxSignal => ({
  sense: 'crawler',
  check: 'links lead somewhere',
  route,
  version: 'c02efd8',
  symptom: 'broken-link',
  observedAt: new Date().toISOString(),
  artifacts: [],
});

const noJudge: Judge = async () => {
  throw new Error('No report in these tests');
};

/** A copy's options, as triage's role on `sql`, with the waits shortened. */
const options = (sql: Sql, more: Partial<TriageOptions> = {}): TriageOptions => ({
  sql,
  events: new EventWriter(sql, { kind: 'real', artifacts }),
  judge: noJudge,
  read: async () => null,
  log: quiet,
  outage: brief,
  lockAskedMs: 100,
  ...more,
});
const triage = (sql: Sql, more: Partial<TriageOptions> = {}) => new Triage(options(sql, more));

/** Runs a copy until the test ends, or until `abort` stops it. */
const start = (copy: Triage) => {
  const running = copy.run(abort.signal);
  copies.push(running);
  return running;
};

/** Who holds triage's advisory lock, and who waits for it, by backend. */
const lockers = () =>
  database.owner<{ pid: number; granted: boolean }[]>`
    select pid, granted from pg_locks
    where locktype = 'advisory' and objsubid = 1
      and database = (select oid from pg_database where datname = current_database())
      and ((classid::bigint << 32) | objid::bigint) = hashtext('triage')::bigint
    order by granted desc, pid`;
const holder = async () => (await lockers()).find((l) => l.granted)?.pid;

/** Ends a backend, as a dropped connection or a restart of Postgres does. */
const drop = (pid: number) => database.owner`select pg_terminate_backend(${pid})`;

const triaged = async (id: string) =>
  (await database.owner<{ outcome: string | null }[]>`select outcome from inbox where id = ${id}`)[0]?.outcome;

describe('triage through a store it cannot reach', () => {
  it('takes its lock again on a new connection when the old one drops, before the next signal', async () => {
    const running = start(triage(database.as.triage));
    await expect.poll(holder).toBeDefined();
    const first = (await holder()) as number;
    await drop(first);
    // Idle, it finds the lock gone when it next wakes: here for a signal.
    const id = await sendSignal(database.owner, found('/after-the-drop'));
    await expect.poll(() => triaged(id), { timeout: 4000 }).toBe('opened');
    expect(await holder()).not.toBe(first);
    abort.abort();
    await running;
    expect(await lockers()).toEqual([]);
  });

  it('never has two copies hold the lock, and the one waiting may take it when the other loses it', async () => {
    /** The signals each copy triaged. */
    const took = { one: [] as string[], two: [] as string[] };
    const logged = (copy: keyof typeof took) => ({
      info: (fields: { signal?: string }, message: string) => {
        if (message === 'triaged a signal' && fields.signal) took[copy].push(fields.signal);
      },
      warn: () => {},
    });
    const one = start(triage(database.as.triage, { log: logged('one') }));
    await expect.poll(holder).toBeDefined();
    const first = (await holder()) as number;
    const two = start(triage(other, { log: logged('two') }));
    const watch = { granted: 0, stop: false };
    const watching = (async () => {
      while (!watch.stop) {
        watch.granted = Math.max(watch.granted, (await lockers()).filter((l) => l.granted).length);
        await new Promise((tick) => setTimeout(tick, 10));
      }
    })();
    // The second copy waits: the first triages.
    const before = await sendSignal(database.owner, found('/two-copies/before'));
    await expect.poll(() => triaged(before)).toBe('opened');
    expect(took).toEqual({ one: [before], two: [] });
    await drop(first);
    // The first finds its lock gone when it next wakes, here for a signal, and asks for it again on a new connection.
    // Whichever copy has it then triages the signal, once.
    const after = await sendSignal(database.owner, found('/two-copies/after'));
    await expect.poll(() => triaged(after), { timeout: 4000 }).toBe('opened');
    expect([...took.one, ...took.two].filter((id) => id === after)).toHaveLength(1);
    expect(await holder()).not.toBe(first);
    watch.stop = true;
    await watching;
    expect(watch.granted).toBe(1);
    // Stopping ends the copy that waits for the lock too.
    abort.abort();
    await Promise.all([one, two]);
    expect(await lockers()).toEqual([]);
  });

  it('waits out a store it cannot listen to as it starts', async () => {
    const sql = database.as.triage;
    let refused = 2;
    // The store refuses the first two tries to listen, as one restarting does.
    const starting = new Proxy(sql, {
      get(target, key, receiver) {
        if (key !== 'listen') return Reflect.get(target, key, receiver);
        return (...args: Parameters<Sql['listen']>) =>
          refused-- > 0
            ? Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }))
            : target.listen(...args);
      },
    });
    start(triage(starting));
    const id = await sendSignal(database.owner, found('/starting'));
    await expect.poll(() => triaged(id), { timeout: 4000 }).toBe('opened');
    expect(refused).toBeLessThan(0);
  });

  it('rides out a store that fails a few times, of either shape, and takes the signal after', async () => {
    let failing = 2;
    const warnings: string[] = [];
    class Flaky extends Triage {
      override async takeOne() {
        if (failing-- === 2)
          throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
        if (failing >= 0) throw new TypeError("Cannot read properties of null (reading 'write')");
        return super.takeOne();
      }
    }
    const sql = database.as.triage;
    const running = start(
      new Flaky(options(sql, { log: { info: () => {}, warn: (_fields, message) => warnings.push(message) } })),
    );
    const id = await sendSignal(database.owner, found('/flaky'));
    await expect.poll(() => triaged(id), { timeout: 5000 }).toBe('opened');
    expect(warnings.filter((w) => w.startsWith('triage could not reach the store'))).toHaveLength(2);
    abort.abort();
    await running;
  });

  it('gives up on a store that keeps failing, so the restarts say so, waiting each time however often it is woken', async () => {
    let tried = 0;
    class Down extends Triage {
      override async takeOne(): Promise<never> {
        tried += 1;
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      }
    }
    const outage: Outage = { firstMs: 200, mostMs: 1000, tries: 4 };
    const sql = database.as.triage;
    const began = Date.now();
    const running = start(new Down(options(sql, { outage })));
    // Signals keep arriving while it waits: none brings the next try forward.
    let flooding = true;
    const flood = (async () => {
      while (flooding) {
        await database.owner`select pg_notify('inbox', 'a signal')`;
        await new Promise((tick) => setTimeout(tick, 20));
      }
    })();
    await expect(running).rejects.toThrow('ECONNREFUSED');
    const took = Date.now() - began;
    flooding = false;
    await flood;
    expect(tried).toBe(outage.tries);
    // 200, 400 and 800 ms between the four tries.
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(await lockers()).toEqual([]);
  });

  it('appends nothing once the lock is lost in the middle of a signal, and gives the signal back with its attempt', async () => {
    const held = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    let reads = 0;
    // A sense's signal is looked at before it is decided: the look waits here while the lock goes.
    const look = async (at: Date) => {
      reads += 1;
      if (reads === 1) {
        reading.resolve();
        await held.promise;
      }
      return { at: at.toISOString(), dependencies: [] };
    };
    const running = start(triage(database.as.triage, { look }));
    await expect.poll(holder).toBeDefined();
    const first = (await holder()) as number;
    const id = await sendSignal(database.owner, found('/mid-signal'));
    await reading.promise;
    await drop(first);
    held.resolve();
    // Its first try appended nothing and gave the signal back, with its attempt: the lock taken again, it is decided
    // again, looked at a second time, and triaged once, with no failure.
    await expect.poll(() => triaged(id), { timeout: 4000 }).toBe('opened');
    expect(reads).toBe(2);
    expect(await holder()).not.toBe(first);
    const [row] = await database.owner<{ attempts: number; failure: string | null }[]>`
      select attempts, failure from inbox where id = ${id}`;
    expect(row).toEqual({ attempts: 1, failure: null });
    expect(await database.owner`select 1 from events where id = ${idsFor(id)()}`).toHaveLength(1);
    abort.abort();
    await running;
  });
});
