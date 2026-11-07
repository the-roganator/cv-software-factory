/**
 * `factory line take` (`make take-the-line`): what the line takes, set from Martin's own command line, as the console's
 * Controls set it, through the same check, keeping every other control as it stands.
 */
import { type NewEvent, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, latestControls, nextWorkItem } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { controlsInForce } from '../../../../policy/line.ts';
import { run, takeAsked } from '../../src/commands/line.ts';

describe('what take asks for', () => {
  it('is every ticket, the next few, or just one work item, and nothing else', () => {
    expect(takeAsked(['every'])).toEqual({ take: { kind: 'every' } });
    expect(takeAsked(['next', '3'])).toEqual({ take: { kind: 'next-few', count: 3 } });
    expect(takeAsked(['one', '1001'])).toEqual({ take: { kind: 'just-one', workItem: '1001' } });
    expect(takeAsked(['one', '#1001'])).toEqual({ take: { kind: 'just-one', workItem: '1001' } });
    for (const args of [
      [],
      ['every', '3'],
      ['next'],
      ['next', 'three'],
      ['one'],
      ['one', '10a'],
      ['all'],
      ['one', '1', '2'],
    ]) {
      expect(takeAsked(args), JSON.stringify(args)).toBeUndefined();
    }
  });
});

describe('take, against the store', () => {
  let database: Database;
  const said: string[] = [];
  beforeEach(async () => {
    database = await freshDatabase('take_command');
    const url = new URL(inject('databaseUrl'));
    url.pathname = `/${database.name}`;
    url.username = 'factory_operator';
    url.password = 'operator-test';
    vi.stubEnv('DATABASE_URL', url.toString());
    said.length = 0;
    vi.spyOn(console, 'log').mockImplementation((line: string) => void said.push(line));
    vi.spyOn(console, 'error').mockImplementation((line: string) => void said.push(line));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await database?.end();
  });

  const changes = () =>
    database.owner<{ appended_by: string; summary: string; payload: { autonomy: string; take: unknown } }[]>`
      select appended_by, summary, payload from events where type = 'controls.changed' order by seq`;

  /** A ticket as triage opens one. */
  async function ticket(): Promise<string> {
    const workItem = await nextWorkItem(database.as.triage);
    const event = (type: 'work-item.opened' | 'ticket.opened', payload: object) =>
      ({
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        work_item: workItem,
        type,
        version: VERSIONS[type],
        actor: 'triage',
        summary: `${type} for the test`,
        payload,
        artifacts: [],
      }) as NewEvent;
    await new EventWriter(database.as.triage, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }).append([
      event('work-item.opened', { kind: 'defect-fix', title: 'Server errors', sample: false }),
      event('ticket.opened', {
        title: 'Server errors on /search',
        category: 'errors',
        severity: 'broken',
        fingerprint: { route: '/search', class: 'server-error' },
        traces: [],
      }),
    ]);
    return workItem;
  }

  it('sets the take as Martin’s, keeping every other control, and refuses one outside policy, changing nothing', async () => {
    expect(await run(['take', 'every'])).toBe(0);
    expect(said.at(-1)).toBe('The line takes that already: nothing changed.');
    expect(await changes()).toEqual([]);

    expect(await run(['take', 'next', '3'])).toBe(0);
    expect(said.at(-1)).toBe('Martin narrowed what the line takes to the next 3 from now.');
    const [next] = await changes();
    expect(next).toMatchObject({
      appended_by: 'factory_operator',
      payload: { autonomy: 'supervised', take: { kind: 'next-few', count: 3 } },
    });
    expect(controlsInForce(await latestControls(database.as.line)).take).toMatchObject({ kind: 'next-few', count: 3 });

    // Just one work item that has no open ticket is refused, as the console's is.
    expect(await run(['take', 'one', '999'])).toBe(2);
    expect(said.at(-1)).toBe('#999 has no open ticket or improvement for the line to take.');
    expect(await run(['take', 'next', '50'])).toBe(2);
    expect(said.at(-1)).toBe('That is outside policy: the next few are 1 to 20 work items.');
    expect(await changes()).toHaveLength(1);

    const workItem = await ticket();
    expect(await run(['take', 'one', workItem])).toBe(0);
    expect(said.at(-1)).toBe(`Martin narrowed what the line takes to just #${workItem}.`);
    expect(await run(['take', 'every'])).toBe(0);
    expect(said.at(-1)).toBe('Martin widened what the line takes to every ticket.');
    expect((await changes()).map((c) => c.appended_by)).toEqual(Array(3).fill('factory_operator'));
  });

  it('says how to use it when asked for anything else', async () => {
    expect(await run(['take', 'all'])).toBe(2);
    expect(said.at(-1)).toContain('factory line take (every | next <how many> | one <work item>)');
  });
});
