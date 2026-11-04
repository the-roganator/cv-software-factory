/**
 * The console live, against a real store: events appended move an open console within a second, and a stream that
 * drops mid-play resumes with nothing missed and nothing twice. Needs Postgres: TEST_DATABASE_URL, or Docker.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { NewEvent } from '@software-factory/events';
import { logArtifactPath } from '@software-factory/events/log';
import { load, readLog } from '@software-factory/factory/events';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { createDatabase, type Database, PASSWORDS, startPostgres } from '../../../packages/store/test/postgres.ts';
import { startConsole, stopConsole } from './admin.ts';
import { expect, test } from './support.ts';

const PORT = 18_324;
const SAMPLES = fileURLToPath(new URL('../../../packages/samples/log', import.meta.url));

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let postgres: { url: string; stop: () => void };
let database: Database;
let console_: ChildProcess | undefined;
const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));

/** The console, as the cluster runs it: its read-only role, and the artifact store's folder. */
function startLiveConsole(): Promise<ChildProcess> {
  const reader = new URL(postgres.url);
  reader.pathname = `/${database.name}`;
  reader.username = 'console_reader';
  reader.password = PASSWORDS.console;
  return startConsole(PORT, { DATABASE_URL: reader.href, ARTIFACTS_DIR: artifacts.dir });
}

async function stopLiveConsole(): Promise<void> {
  const child = console_;
  console_ = undefined;
  if (child) await stopConsole(child);
}

const received = (page: Page) => page.evaluate(() => (globalThis as { sfReceived?: number[] }).sfReceived ?? []);
const stored = async () =>
  (await database.owner<{ seq: string }[]>`select seq from events order by seq`).map((row) => Number(row.seq));

test.beforeAll(async () => {
  const given = process.env.TEST_DATABASE_URL;
  postgres = given ? { url: given, stop: () => {} } : await startPostgres();
  database = await createDatabase(postgres.url, 'live');
  // Every sample but #1302, which the tests append themselves, once its screenshots are in the store.
  await load(database.operator, artifacts, SAMPLES, { except: ['1302'] });
  for (const event of live())
    for (const { hash } of event.artifacts) await artifacts.put(readFileSync(logArtifactPath(SAMPLES, hash)));
  console_ = await startLiveConsole();
});

test.afterAll(async () => {
  await stopLiveConsole();
  await database?.end();
  postgres?.stop();
});

/** #1302's events, each happening now. */
const live = (): NewEvent[] => readLog(SAMPLES, { only: ['1302'] });
const now = (event: NewEvent) => ({ ...event, ts: new Date().toISOString() }) as NewEvent;

test('moves an open console within a second of an append, with no refresh', async ({ page }) => {
  await page.goto('/?motion=off&debug=events');
  await expect(page.locator('.transport .count')).toHaveText('27 of 27');
  const [opened] = live();
  if (!opened) throw new Error('No events for #1302');
  const writer = new EventWriter(database.operator, { kind: 'sample', artifacts });
  const appended = Date.now();
  await writer.append(now(opened));
  await expect(page.locator('.transport .count')).toHaveText('28 of 28', { timeout: 1000 });
  console.log(`The console showed the new work item ${Date.now() - appended} ms after the append`);
});

test('resumes after the stream drops mid-play, with nothing missed and nothing twice', async ({ page }) => {
  await page.goto('/?motion=off&debug=events');
  await expect(page.locator('.transport .count')).toHaveText('28 of 28');
  const writer = new EventWriter(database.operator, { kind: 'sample', artifacts });
  const rest = live().slice(1);
  const half = Math.floor(rest.length / 2);
  for (const [i, event] of rest.entries()) {
    if (i === half) {
      // The console goes away mid-play, connections and all, and comes back.
      await stopLiveConsole();
      await writer.append(now(event));
      console_ = await startLiveConsole();
      continue;
    }
    await writer.append(now(event));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const all = await stored();
  await expect.poll(() => received(page), { timeout: 10_000 }).toHaveLength(all.length);
  const seqs = await received(page);
  expect(new Set(seqs).size, 'no event sent twice').toBe(seqs.length);
  expect(
    [...seqs].sort((a, b) => a - b),
    'every stored event, and only those',
  ).toEqual(all);
  await expect(page.locator('.card[data-place="centre"] h3')).toHaveText('Search turns away long words');
});
