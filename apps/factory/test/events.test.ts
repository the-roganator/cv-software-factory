import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogEvents } from '@software-factory/events/log';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../packages/store/test/database.ts';
import { endingAt, exportItem, load, play, readLog } from '../src/events.ts';

const SAMPLES = fileURLToPath(new URL('../../../packages/samples/log', import.meta.url));
const NOW = Date.parse('2026-10-03T12:00:00Z');

let database: Database;
const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));

beforeAll(async () => {
  database = await freshDatabase('factory');
});
afterAll(() => database?.end());

describe('factory events', () => {
  it('moves a log’s times so the last event is now, keeping the gaps between them', () => {
    const moved = endingAt([{ ts: '2026-10-01T10:00:00Z' }, { ts: '2026-10-01T10:30:00Z' }], NOW);
    expect(moved.map((e) => e.ts)).toEqual(['2026-10-03T11:30:00.000Z', '2026-10-03T12:00:00.000Z']);
  });

  it('loads the samples, all but one, with the last of them now', async () => {
    const result = await load(database.operator, artifacts, SAMPLES, { except: ['1302'] }, NOW);
    expect(result.events).toBe(readLog(SAMPLES, { except: ['1302'] }).length);
    const [{ last } = { last: new Date(0) }] = await database.owner<
      { last: Date }[]
    >`select max(ts) as last from events`;
    expect(last.getTime()).toBe(NOW);
    expect(readdirSync(artifacts.dir).length).toBe(result.artifacts);
  });

  it('refuses events the store already holds', async () => {
    await expect(load(database.operator, artifacts, SAMPLES, { only: ['1296'] })).rejects.toThrow(
      'The store already holds',
    );
  });

  it('plays a work item at its recorded pace, sped up, each event happening now', async () => {
    const pauses: number[] = [];
    const played: string[] = [];
    const result = await play(database.operator, artifacts, SAMPLES, {
      only: ['1302'],
      speed: 60,
      maxPause: 5000,
      sleep: async (ms) => {
        pauses.push(ms);
      },
      onEvent: (event) => played.push(event.type),
    });
    expect(result.events).toBe(played.length);
    expect(played[0]).toBe('work-item.opened');
    // 3 minutes 20 seconds between opening and injection, at 60 times: 3.33 seconds.
    expect(pauses[0]).toBeCloseTo(200_000 / 60);
    expect(Math.max(...pauses)).toBeLessThanOrEqual(5000);
    const [{ last } = { last: new Date(0) }] = await database.owner<
      { last: Date }[]
    >`select max(ts) as last from events`;
    expect(Date.now() - last.getTime()).toBeLessThan(60_000);
  });

  it('exports a work item’s public events and artifacts to a log of its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'export-'));
    const result = await exportItem(database.reader, artifacts, '1296', dir);
    const events = readLogEvents(dir);
    expect(events).toHaveLength(result.events);
    expect(new Set(events.map((e) => (e as unknown as { work_item: string }).work_item))).toEqual(new Set(['1296']));
    expect(readdirSync(join(dir, 'artifacts'))).toHaveLength(result.artifacts);
  });

  it('refuses samples in a store that holds real events', async () => {
    const real = await freshDatabase('real');
    try {
      await new EventWriter(real.as.triage, { kind: 'real', artifacts }).append({
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        work_item: '1',
        type: 'work-item.opened',
        version: 3,
        actor: 'factory',
        summary: 'Real work',
        payload: { kind: 'defect-fix', title: 'Real work', sample: false },
        artifacts: [],
      });
      await expect(load(real.operator, artifacts, SAMPLES)).rejects.toThrow(
        'This store holds real events, so it takes no samples.',
      );
    } finally {
      await real.end();
    }
  });
});
