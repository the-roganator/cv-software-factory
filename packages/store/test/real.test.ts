import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewEvent } from '@software-factory/events';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiskArtifacts } from '../src/artifacts.ts';
import { EventWriter, nextWorkItem, storeKind } from '../src/events.ts';
import { pruneInbox, sendSignal } from '../src/inbox.ts';
import { realStore } from '../src/real-store.ts';
import { type Database, freshDatabase } from './database.ts';

let owner: Sql;
/** Triage numbers work items, reads and records the inbox; the crawler and the log watcher send it signals. */
let triage: Sql;
let crawler: Sql;
let logs: Sql;
let reader: Sql;
let database: Database;
const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
const uuid = () => crypto.randomUUID();

function opened(item: string, sample = false): NewEvent<'work-item.opened'> {
  return {
    id: uuid(),
    ts: '2026-10-04T09:00:00.000Z',
    work_item: item,
    type: 'work-item.opened',
    version: 2,
    actor: 'triage',
    summary: 'The crawler opened a work item',
    payload: { kind: 'defect-fix', title: 'A link on the about page leads nowhere', sample },
    artifacts: [],
  };
}

beforeAll(async () => {
  database = await freshDatabase('real');
  ({ owner, reader } = database);
  ({ triage, crawler, logs } = database.as);
});

afterAll(() => database?.end());

describe('a real store', () => {
  it('is chosen by its first event, and recorded once', async () => {
    expect(await storeKind(triage)).toBeNull();
    await new EventWriter(triage, { kind: 'sample', artifacts }).append(opened('1262', true));
    expect(await storeKind(reader)).toBe('sample');
    await expect(owner`update store set sample = false`).rejects.toThrow('append-only');
  });

  it('replaces a store of samples with an empty one that refuses them', async () => {
    expect(await realStore(owner)).toEqual({ dropped: 1 });
    expect(await storeKind(triage)).toBe('real');
    await expect(new EventWriter(triage, { kind: 'sample', artifacts }).append(opened('1262', true))).rejects.toThrow(
      'this store holds real events, so it refuses samples',
    );
  });

  it('refuses to replace a store that holds real events, unless forced', async () => {
    await new EventWriter(triage, { kind: 'real', artifacts }).append(opened(await nextWorkItem(triage)));
    await expect(realStore(owner)).rejects.toThrow('This store holds 1 real events');
    expect(await realStore(owner, { force: true })).toEqual({ dropped: 1 });
  });

  it('wakes whatever listens, so a console learns the store’s kind with no event to read', async () => {
    const heard: string[] = [];
    const ready = Promise.withResolvers<void>();
    const subscription = await reader.listen('events', (payload) => heard.push(payload), ready.resolve);
    await ready.promise;
    await realStore(owner, { force: true });
    await expect.poll(() => heard).toEqual(['0']);
    await subscription.unlisten();
  });

  it('numbers work items from 1000', async () => {
    expect([await nextWorkItem(triage), await nextWorkItem(triage)]).toEqual(['1000', '1001']);
  });
});

describe('appending again', () => {
  const real = () => new EventWriter(triage, { kind: 'real', artifacts });

  it('stores an event appended twice with the same id and content once', async () => {
    const event = opened(await nextWorkItem(triage));
    const [first] = await real().append(event);
    const [again] = await real().append({ ...event, payload: { ...event.payload } });
    expect(again?.seq).toBe(first?.seq);
    expect(await owner`select count(*)::int as n from events where id = ${event.id}`).toEqual([{ n: 1 }]);
  });

  it('stores the rest of a batch when part of it was stored before', async () => {
    const event = opened(await nextWorkItem(triage));
    await real().append(event);
    const closed: NewEvent<'work-item.closed'> = {
      ...event,
      id: uuid(),
      type: 'work-item.closed',
      version: 3,
      summary: 'Closed with no ticket',
      payload: { outcome: 'discarded', reason: 'Not a defect' },
    };
    const stored = await real().append([event, closed]);
    expect(stored.map((e) => e.seq)).toEqual([stored[0]?.seq, (stored[0]?.seq ?? 0) + 1]);
  });

  it('refuses the same id with different content, saying what differs', async () => {
    const event = opened(await nextWorkItem(triage));
    await real().append(event);
    await expect(real().append({ ...event, summary: 'Something else' })).rejects.toThrow(
      `event ${event.id} is already stored, with a different summary`,
    );
  });
});

describe('the inbox', () => {
  const signal = {
    check: 'links lead somewhere',
    route: '/about',
    version: 'v0.9.6',
    symptom: 'broken-link',
  };

  it('takes signals from the factory and tells listeners', async () => {
    const heard: string[] = [];
    const ready = Promise.withResolvers<void>();
    const subscription = await triage.listen('inbox', (id) => heard.push(id), ready.resolve);
    await ready.promise;
    const id = uuid();
    await crawler`insert into inbox (id, sense, fingerprint, signal)
                  values (${id}, 'crawler', '/about broken-link', ${crawler.json(signal)})`;
    await expect.poll(() => heard).toEqual([id]);
    await subscription.unlisten();
  });

  it('keeps a report without a fingerprint, and a sense’s signal only with one', async () => {
    await logs`insert into inbox (id, sense, signal) values (${uuid()}, 'report', '{}')`;
    await expect(crawler`insert into inbox (id, sense, signal) values (${uuid()}, 'crawler', '{}')`).rejects.toThrow(
      'check constraint',
    );
  });

  it('lets triage record what it made of a signal, and nothing else', async () => {
    const id = uuid();
    await crawler`insert into inbox (id, sense, fingerprint, signal)
                  values (${id}, 'crawler', '/about broken-link', ${crawler.json(signal)})`;
    await triage`update inbox set triaged_at = now(), outcome = 'opened', work_item = '1000' where id = ${id}`;
    await expect(triage`update inbox set signal = '{}' where id = ${id}`).rejects.toThrow('permission denied');
  });

  it('lets triage delete a signal it counted, and no other', async () => {
    const ids = { counted: uuid(), opened: uuid(), held: uuid(), waiting: uuid() };
    for (const [outcome, id] of Object.entries(ids)) {
      const triaged = outcome === 'waiting' ? null : outcome;
      await owner`insert into inbox (id, sense, fingerprint, signal, triaged_at, outcome)
                  values (${id}, 'crawler', '/about broken-link', ${owner.json(signal)},
                          ${triaged ? new Date() : null}, ${triaged})`;
    }
    const deleted = await triage`delete from inbox where id in ${triage(Object.values(ids))}`;
    expect(deleted.count).toBe(1);
    const left = await owner<{ id: string }[]>`select id from inbox where id in ${owner(Object.values(ids))}`;
    expect(left.map((row) => row.id).sort()).toEqual([ids.opened, ids.held, ids.waiting].sort());
  });

  describe('pruning', () => {
    const now = Date.parse('2026-10-19T12:00:00.000Z');
    const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000);
    let keep: string[];
    let go: string[];

    /** A signal from `sense`, received and observed `days` ago, that triage made `outcome` of. */
    async function received(sense: string, days: number, outcome: string | null): Promise<string> {
      const id = uuid();
      const at = daysAgo(days);
      await owner`insert into inbox (id, sense, fingerprint, signal, received_at, triaged_at, outcome)
                  values (${id}, ${sense}, '/about broken-link',
                          ${owner.json({ ...signal, sense, observedAt: at.toISOString() })}, ${at},
                          ${outcome ? at : null}, ${outcome})`;
      return id;
    }

    beforeAll(async () => {
      go = [await received('crawler', 5, 'counted'), await received('crawler', 4, 'counted')];
      keep = [
        await received('crawler', 2, 'counted'), // not old enough
        await received('crawler', 6, 'opened'), // triage's burst read looks at what opened
        await received('crawler', 6, 'held'), // and at what a hold holds
        await received('crawler', 6, null), // and at what still waits
        await received('canary', 6, 'counted'), // its row is what drops it when the line sends it again
        await received('probe', 7, 'counted'), // the probes' newest, which a restarted watcher takes up from
      ];
      go.push(await received('probe', 8, 'counted'));
    });

    it('deletes the repeats triage counted before then, and nothing else', async () => {
      expect(await pruneInbox(triage, daysAgo(3))).toBe(go.length);
      const mine = [...keep, ...go];
      const left = await triage<{ id: string }[]>`select id from inbox where id in ${triage(mine)}`;
      expect(left.map((row) => row.id).sort()).toEqual([...keep].sort());
    });

    it('deletes nothing more the second time', async () => {
      expect(await pruneInbox(triage, daysAgo(3))).toBe(0);
    });
  });

  it('checks what a sense sends, and files it by fingerprint', async () => {
    const found = { sense: 'crawler' as const, ...signal, symptom: 'broken-link' as const };
    const id = await sendSignal(crawler, { ...found, observedAt: '2026-10-04T09:00:00.000Z', artifacts: [] });
    expect(await triage`select fingerprint from inbox where id = ${id}`).toEqual([
      { fingerprint: '/about broken-link' },
    ]);
    await expect(
      sendSignal(crawler, { ...found, route: 'about', observedAt: '2026-10-04T09:00:00.000Z', artifacts: [] }),
    ).rejects.toThrow('route: a path');
  });

  it('is closed to the console, because reports are in it', async () => {
    await expect(reader`select signal from inbox`).rejects.toThrow('permission denied');
  });
});
