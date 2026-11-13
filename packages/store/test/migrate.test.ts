import { execFile } from 'node:child_process';
import { connect as connectTcp, createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { connect } from '../src/client.ts';
import { waitForStore } from '../src/migrate.ts';
import { type Database, freshDatabase } from './database.ts';

const MIGRATE = fileURLToPath(new URL('../src/migrate.ts', import.meta.url));

/** A port nothing listens on, until `relay` is started on it. */
async function freePort() {
  const server = createServer();
  const { port } = await listenLocal(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A relay on `port` to the test's Postgres, as a store that starts listening late. */
function relay(port: number): Promise<Server> {
  const store = new URL(inject('databaseUrl'));
  const server = createServer((client) => {
    const upstream = connectTcp(Number(store.port), store.hostname);
    for (const socket of [client, upstream]) socket.on('error', () => {});
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const through = (port: number, database?: string) => {
  const url = new URL(inject('databaseUrl'));
  url.port = String(port);
  if (database) url.pathname = `/${database}`;
  return url.href;
};

const servers: Server[] = [];
let database: Database | undefined;
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  await database?.end();
  database = undefined;
});

describe('waiting for the store before migrating', () => {
  it('tries again while the store refuses, saying the code once, and goes on once it listens', async () => {
    const port = await freePort();
    const said: string[] = [];
    const sql = connect(through(port), { max: 1, connect_timeout: 1 });
    try {
      setTimeout(() => void relay(port).then((s) => servers.push(s)), 1_000);
      const failed = await waitForStore(sql, { withinMs: 10_000, everyMs: 100, say: (line) => said.push(line) });
      expect(failed).toBeGreaterThan(1);
      expect(said.filter((line) => line.startsWith('Waiting for the store: ECONNREFUSED'))).toHaveLength(1);
      expect(said.at(-1)).toMatch(
        new RegExp(`^The store answered after ${failed} failed attempts, \\d+\\.\\d s after the first\\.$`),
      );
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it('says it is still waiting at each report, and the code each time', async () => {
    const port = await freePort();
    const said: string[] = [];
    const sql = connect(through(port), { max: 1, connect_timeout: 1 });
    try {
      setTimeout(() => void relay(port).then((s) => servers.push(s)), 1_200);
      await waitForStore(sql, { withinMs: 10_000, everyMs: 100, reportMs: 500, say: (line) => said.push(line) });
      const still = said.filter((line) => line.startsWith('Still waiting for the store: ECONNREFUSED at '));
      expect(still.length).toBeGreaterThanOrEqual(1);
      // One a report apart, never one an attempt.
      const at = still.map((line) => Number(/ at (\d+\.\d) s/.exec(line)?.[1]));
      for (let i = 1; i < at.length; i++) expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(0.5);
      expect(still[0]).toMatch(/at \d+\.\d s, \d+ attempts failed\.$/);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it('gives up within its bound on a store that never listens, naming the last code', async () => {
    const port = await freePort();
    const said: string[] = [];
    const sql = connect(through(port), { max: 1, connect_timeout: 1 });
    try {
      const start = performance.now();
      await expect(
        waitForStore(sql, { withinMs: 1_000, everyMs: 100, say: (line) => said.push(line) }),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(performance.now() - start).toBeLessThan(2_000);
      expect(said.at(-1)).toBe('The store did not answer within 1 s: the last attempt was ECONNREFUSED.');
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it('fails at once on a wrong password, which no wait puts right', async () => {
    const url = new URL(inject('databaseUrl'));
    url.password = 'not-the-password';
    const said: string[] = [];
    const sql = connect(url.href, { max: 1 });
    try {
      const start = performance.now();
      await expect(
        waitForStore(sql, { withinMs: 10_000, everyMs: 1_000, say: (line) => said.push(line) }),
      ).rejects.toMatchObject({ code: '28P01' });
      expect(performance.now() - start).toBeLessThan(1_000);
      expect(said).toEqual([]);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it('is what the migrate command does first: a store that listens a second late costs a second', async () => {
    database = await freshDatabase('migrate_waits');
    const port = await freePort();
    setTimeout(() => void relay(port).then((s) => servers.push(s)), 1_000);
    const { stdout } = await promisify(execFile)(process.execPath, [MIGRATE], {
      env: { ...process.env, DATABASE_URL: through(port, database.name) },
      timeout: 20_000,
    });
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^Waiting for the store: ECONNREFUSED at 0\.\d s/);
    expect(lines.at(-2)).toMatch(/^The store answered after \d+ failed attempts?, \d+\.\d s after the first\.$/);
    expect(lines.at(-1)).toBe('Nothing to apply: the schema is current.');
  }, 30_000);
});
