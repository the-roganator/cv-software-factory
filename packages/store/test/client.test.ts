import { connect as connectTcp, createServer, type Socket } from 'node:net';
import { metrics } from '@opentelemetry/api';
import { type DataPoint, type Histogram, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { listenLocal } from '@software-factory/testing';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect } from '../src/client.ts';
import { listen } from '../src/events.ts';

// Collected on demand, as Prometheus would scrape them.
class Reader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}
const reader = new Reader();

beforeAll(() => {
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
});
afterAll(() => {
  metrics.disable();
});

async function series(name: string): Promise<DataPoint<number | Histogram>[]> {
  const { resourceMetrics } = await reader.collect();
  const found = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).find((m) => m.descriptor.name === name);
  return (found?.dataPoints ?? []) as DataPoint<number | Histogram>[];
}
const count = (point: DataPoint<number | Histogram> | undefined) =>
  typeof point?.value === 'number' ? point.value : (point?.value.count ?? 0);
const find = (points: DataPoint<number | Histogram>[], attributes: Record<string, string>) =>
  points.find((p) => JSON.stringify(p.attributes) === JSON.stringify(attributes));

describe("the store's client", () => {
  it('times each query by its first word and how it ended, and holds no text of it', async () => {
    // Without the read of the server's own types, which postgres.js makes when it needs them.
    const sql = connect(inject('databaseUrl'), { max: 1, fetch_types: false });
    try {
      const secret = 'a visitor wrote this';
      await sql`select ${secret}::text as said`;
      await sql`select ${sql`1`} as fragment`;
      await sql.begin((tx) => tx`select 1`);
      // A cursor settles the query through what it puts in place of the query's own answer.
      const batches = [];
      for await (const rows of sql`select generate_series(1, 5)`.cursor(2)) batches.push(rows.length);
      expect(batches).toEqual([2, 2, 1]);
      await expect(sql`select 1 / 0`).rejects.toThrow(/division by zero/);
      await expect(sql.unsafe('selec nothing')).rejects.toThrow();

      const points = await series('store.query.duration');
      // Four selects, the transaction's and the cursor's included; a fragment inside another query is never a query of
      // its own.
      expect(count(find(points, { operation: 'select', outcome: 'ok' }))).toBe(4);
      expect(count(find(points, { operation: 'begin', outcome: 'ok' }))).toBe(1);
      expect(count(find(points, { operation: 'commit', outcome: 'ok' }))).toBe(1);
      expect(count(find(points, { operation: 'select', outcome: 'error', code: '22012' }))).toBe(1);
      expect(count(find(points, { operation: 'other', outcome: 'error', code: '42601' }))).toBe(1);
      const attributes = JSON.stringify(points.map((p) => p.attributes));
      expect(attributes).not.toContain(secret);
      expect(attributes).not.toMatch(/division|selec |::text/);
    } finally {
      await sql.end();
    }
  });

  it('counts the connections it holds open, and each it opened', async () => {
    const before = count(find(await series('store.connection.attempts'), { outcome: 'connected' }));
    const sql = connect(inject('databaseUrl'), { max: 2 });
    try {
      await Promise.all([sql`select pg_sleep(0.05)`, sql`select pg_sleep(0.05)`]);
      expect(count((await series('store.connections'))[0])).toBe(2);
      expect(count(find(await series('store.connection.attempts'), { outcome: 'connected' }))).toBe(before + 2);
    } finally {
      await sql.end();
    }
    expect(count((await series('store.connections'))[0])).toBe(0);
  });

  it('counts a connection that never opened, and the query that waited for it fails with its code', async () => {
    // A port that was free a moment ago, and that nothing listens on.
    const server = createServer();
    const { port } = await listenLocal(server);
    await new Promise((resolve) => server.close(resolve));

    const sql = connect(`postgres://nobody:nothing@127.0.0.1:${port}/none`, { max: 1, connect_timeout: 2 });
    try {
      await expect(sql`select 1`).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      // The socket closes just after its error fails the query.
      await vi.waitFor(async () =>
        expect(count(find(await series('store.connection.attempts'), { outcome: 'failed' }))).toBe(1),
      );
      expect(
        count(
          find(await series('store.query.duration'), { operation: 'select', outcome: 'error', code: 'ECONNREFUSED' }),
        ),
      ).toBe(1);
      expect(count((await series('store.connections'))[0])).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it('answers every query and opens every connection when counting them throws', async () => {
    const broken = () => {
      throw new Error('the meter is broken');
    };
    const meter = {
      createHistogram: () => ({ record: broken }),
      createUpDownCounter: () => ({ add: broken }),
      createCounter: () => ({ add: broken }),
    };
    const spy = vi.spyOn(metrics, 'getMeterProvider').mockReturnValue({ getMeter: () => meter } as never);
    const sql = connect(inject('databaseUrl'), { max: 1, connect_timeout: 2 });
    try {
      await expect(sql`select 1 as one`).resolves.toEqual([{ one: 1 }]);
      await expect(sql`select 1 / 0`).rejects.toThrow(/division by zero/);
    } finally {
      await sql.end();
      spy.mockRestore();
    }
  });

  it('counts the connections of a client given more than one address', async () => {
    const store = new URL(inject('databaseUrl'));
    const address = `${store.hostname}:${store.port}`;
    const before = count(find(await series('store.connection.attempts'), { outcome: 'connected' }));
    const sql = connect(
      `${store.protocol}//${store.username}:${store.password}@${address},${address}${store.pathname}`,
      {
        max: 1,
      },
    );
    try {
      await sql`select 1`;
      expect(count((await series('store.connections'))[0])).toBe(1);
      expect(count(find(await series('store.connection.attempts'), { outcome: 'connected' }))).toBe(before + 1);
    } finally {
      await sql.end();
    }
    expect(count((await series('store.connections'))[0])).toBe(0);
  });

  it('listens again after its connection drops, however long the store turns it away meanwhile', async () => {
    // A relay to the store that can cut its connections, and close each new one at once, as a restarting store does.
    const store = new URL(inject('databaseUrl'));
    const sockets = new Set<Socket>();
    let refusing = false;
    const relay = createServer((client) => {
      if (refusing) return void client.destroy();
      const upstream = connectTcp(Number(store.port), store.hostname);
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => {
          sockets.delete(socket);
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    const { port } = await listenLocal(relay);
    const through = new URL(store);
    through.port = String(port);
    // Trying again soon, and for longer than one attempt's timeout, so a client that gives up shows here.
    const sql = connect(through.href, { backoff: () => 0.05, connect_timeout: 1 });
    const notifier = connect(inject('databaseUrl'), { max: 1 });
    try {
      const heard: number[] = [];
      let ready = 0;
      const listening = await listen(
        sql,
        (seq) => heard.push(seq),
        () => ready++,
      );
      expect(ready).toBe(1);
      refusing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      refusing = false;
      // Ready again, so its caller reads what it missed, and hearing what is notified from then on.
      await vi.waitFor(() => expect(ready).toBe(2), { timeout: 5_000 });
      await notifier`select pg_notify('events', '7')`;
      await vi.waitFor(() => expect(heard).toEqual([7]));
      await listening.unlisten();
    } finally {
      await Promise.all([sql.end({ timeout: 0 }), notifier.end()]);
      await new Promise((resolve) => relay.close(resolve));
    }
  }, 15_000);
});
