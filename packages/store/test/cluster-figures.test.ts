import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Figures, storeQuery } from '../../../scripts/cluster-figures.ts';
import { type Database, freshDatabase } from './database.ts';

/*
 * The store's figures `make upgrade-cluster` holds a moved cluster to (scripts/cluster-figures.ts), taken by its query
 * from a migrated store, as psql takes them in the store's pod.
 */
let database: Database;
type Store = Pick<Figures, 'lastSeq' | 'events' | 'kept' | 'counts' | 'line'>;

async function take(upto?: number): Promise<Store> {
  const [row] = await database.owner.unsafe<{ json_build_object: Store }[]>(storeQuery(upto));
  if (!row) throw new Error('no figures');
  return row.json_build_object;
}

async function event(type: string) {
  await database.owner.unsafe(
    `insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
     values (gen_random_uuid(), now(), 'WI-1', $1, 1, 'proof', 'an invented event', '{"n": 1}', '[]', '{}', false)`,
    [type],
  );
}

beforeAll(async () => {
  database = await freshDatabase('cluster_figures');
  await database.owner.unsafe(`
    insert into store (sample) values (false);
    insert into enrolment_codes (code_sha256) values (repeat('a', 64));
    insert into passkeys (id, public_key, name, enrolled_with) values ('invented-passkey-0000', '\\x0102', 'Mac', repeat('a', 64));
    insert into sessions (id_sha256, passkey, expires_at) values (repeat('c', 64), 'invented-passkey-0000', now() + interval '20 minutes');
    insert into line (work_item, stage) values ('WI-1', 'held');
  `);
});

afterAll(async () => {
  await database?.end();
});

describe("the store's figures", () => {
  it('say a store whose line never started so, and count every table', async () => {
    const figures = await take();
    expect(figures).toMatchObject({ lastSeq: 0, events: { upto: 0, count: 0 }, line: 'never started' });
    expect(figures.kept).toMatchObject({
      passkeys: { count: 1 },
      sessions: { count: 1 },
      line: { count: 1 },
      store: { count: 1 },
    });
    expect(figures.counts).toMatchObject({ events: 0, passkeys: 1, inbox: 0, schema_migrations: expect.any(Number) });
  });

  it('keep the digest of the events to a seq when more come after it, and say whether the line runs', async () => {
    await event('invented.step');
    await event('line.started');
    const before = await take();
    expect(before).toMatchObject({ lastSeq: 2, events: { upto: 2, count: 2 }, line: 'started' });

    await event('line.stopped');
    const after = await take(before.lastSeq);
    expect(after.lastSeq).toBe(3);
    expect(after.line).toBe('stopped');
    expect(after.events).toEqual(before.events);
    expect((await take()).events.digest).not.toBe(before.events.digest);
  });

  it('leave a kept table as it was when only a sign-in moves it', async () => {
    const before = await take();
    await database.owner.unsafe(`update passkeys set sign_count = sign_count + 1, last_used_at = now()`);
    expect((await take()).kept.passkeys).toEqual(before.kept.passkeys);
  });
  it("move a kept table's digest when a row of it changes, though its count does not", async () => {
    const before = await take();
    await database.owner.unsafe(`update passkeys set revoked_at = now()`);
    const after = await take();
    expect(after.kept.passkeys?.count).toBe(1);
    expect(after.kept.passkeys?.digest).not.toBe(before.kept.passkeys?.digest);
  });
});
