import type { PayloadOf, PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { foldItems } from '../../web/src/projection/items.ts';
import { needsView } from '../../web/src/projection/needs.ts';
import { askRow, PATCHING_ROLE, patchNeeds, takeAskedRow } from '../../web/src/projection/patch-needs.ts';
import { patchingView } from '../../web/src/projection/patching.ts';
import { END, SAMPLES } from './support.ts';

type Day = PayloadOf<'patching.read'>;
const sample = () => {
  const read = SAMPLES.find((e): e is PublicEvent<'patching.read'> => e.type === 'patching.read');
  if (!read) throw new Error('no sample day');
  return read;
};
let seq = 9000;
const readAt = (ts: string, payload: Day, appended_by = PATCHING_ROLE): PublicEvent<'patching.read'> => ({
  ...sample(),
  seq: ++seq,
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  ts,
  appended_by,
  payload,
});
/** The sample day without the move named. */
const without = (day: Day, name: string): Day => ({
  ...day,
  repositories: day.repositories.map((r) => ({ ...r, moves: r.moves.filter((m) => m.name !== name) })),
});

describe('Needs you’s moves, projected from the samples', () => {
  const needs = patchNeeds(SAMPLES);

  it('has a card for each move only Martin moves and each row the sense made, and for no other', () => {
    expect(needs.map((need) => [need.kind, need.name])).toEqual([
      ['issue', 'example-cd'],
      ['approval', 'example-logs'],
      ['cluster', 'k3s'],
      ['unlisted-image', 'example/debug-shell:1.4'],
    ]);
  });

  it('keys each card as the Patching panel keys its row, so the card opens that row', () => {
    const keys = patchingView(SAMPLES, foldItems(SAMPLES), END);
    if (keys.state !== 'read') throw new Error('no day read');
    const waiting = keys.rows.filter((row) => row.waits).map((row) => row.key);
    expect(needs.map((need) => need.key).sort()).toEqual([...waiting].sort());
  });

  it('keys each card as its row when two rows share a key: two pods of one image, and after a restart', () => {
    const day = sample().payload;
    const unlisted = day.rows.find((r) => r.row === 'unlisted-image');
    if (!unlisted) throw new Error('the samples have no unlisted image');
    const twice = { ...day, rows: [...day.rows, { ...unlisted, pod: 'debug-shell-b81d' }] };
    const events = [readAt(sample().ts, twice)];
    const view = patchingView(events, [], END);
    if (view.state !== 'read') throw new Error('no day read');
    const rows = view.rows.filter((row) => row.source.kind === 'unlisted-image').map((row) => row.key);
    const cards = patchNeeds(events)
      .filter((need) => need.kind === 'unlisted-image')
      .map((need) => need.key);
    expect(new Set(rows).size).toBe(2);
    expect([...cards].sort()).toEqual([...rows].sort());
    // A restart renames the pod and keeps the card's key, so its wait is not started again.
    const restarted = patchNeeds([
      readAt(sample().ts, {
        ...day,
        rows: day.rows.map((r) => (r === unlisted ? { ...r, pod: 'debug-shell-0000' } : r)),
      }),
    ]);
    expect(restarted.map((need) => need.key)).toEqual(patchNeeds([readAt(sample().ts, day)]).map((need) => need.key));
  });

  it('says only what the day gives: what it clears at High and Critical, its deadline, where a pod runs', () => {
    const logs = needs.find((need) => need.name === 'example-logs');
    expect(logs?.clears).toEqual({ critical: 1, high: 21 });
    expect(logs?.deadline).toBe(Date.parse('2026-10-07T00:00:00.000Z'));
    const pod = needs.find((need) => need.kind === 'unlisted-image');
    expect(pod?.clears).toBeUndefined();
    expect(pod?.deadline).toBeUndefined();
    expect(pod?.runs).toMatchObject({ namespace: 'default', pod: 'debug-shell-7c9f' });
  });

  it('writes a target as the Patching row does, in its few characters', () => {
    const logs = needs.find((need) => need.name === 'example-logs');
    expect([logs?.from, logs?.to]).toEqual(['18.13.7', '21.1.1, a major']);
    expect(needs.find((need) => need.name === 'k3s')?.to).toBe('v1.34.5+k3s1');
  });

  it('counts each in Needs you’s view, beside the holds', () => {
    const items = foldItems(SAMPLES);
    expect(needsView(items, END, undefined, needs).patches).toHaveLength(4);
    expect(needsView(items, END).patches).toEqual([]);
  });
});

describe('Needs you’s moves, over the days', () => {
  const day = sample().payload;

  it('dates each from the first of an unbroken run of days that had it waiting, and puts the oldest first', () => {
    const later = { ...day, rows: [] };
    const needs = patchNeeds([
      readAt('2026-10-05T04:20:00.000Z', without(later, 'k3s')),
      readAt('2026-10-06T04:20:00.000Z', day),
    ]);
    expect(needs.map((need) => [need.name, new Date(need.since).toISOString()])).toEqual([
      ['example-cd', '2026-10-05T04:20:00.000Z'],
      ['example-logs', '2026-10-05T04:20:00.000Z'],
      ['k3s', '2026-10-06T04:20:00.000Z'],
      ['example/debug-shell:1.4', '2026-10-06T04:20:00.000Z'],
    ]);
  });

  it('starts a move’s wait again when a day without it came between', () => {
    const needs = patchNeeds([
      readAt('2026-10-04T04:20:00.000Z', day),
      readAt('2026-10-05T04:20:00.000Z', without(day, 'k3s')),
      readAt('2026-10-06T04:20:00.000Z', day),
    ]);
    expect(needs.find((need) => need.name === 'k3s')?.since).toBe(Date.parse('2026-10-06T04:20:00.000Z'));
    expect(needs.find((need) => need.name === 'example-cd')?.since).toBe(Date.parse('2026-10-04T04:20:00.000Z'));
  });

  it('keeps a move’s wait through a day whose run judged nothing of its repository', () => {
    const failed: Day = {
      ...day,
      repositories: day.repositories.map((r) => ({ ...r, judged: null, totals: null, moves: [] })),
      compared: false,
      rows: [],
    };
    const needs = patchNeeds([
      readAt('2026-10-04T04:20:00.000Z', day),
      readAt('2026-10-05T04:20:00.000Z', failed),
      readAt('2026-10-06T04:20:00.000Z', day),
    ]);
    expect(needs).toHaveLength(4);
    expect(needs.every((need) => need.since === Date.parse('2026-10-04T04:20:00.000Z'))).toBe(true);
    // The last day judged nothing: its cards are the day before's, not none, with their waits unbroken.
    const last = patchNeeds([readAt('2026-10-04T04:20:00.000Z', day), readAt('2026-10-05T04:20:00.000Z', failed)]);
    expect(last).toEqual(patchNeeds([readAt('2026-10-04T04:20:00.000Z', day)]));
    // A day that judged one repository keeps only the other's: the judged one says what still waits.
    const [factory, ...rest] = day.repositories;
    if (!factory) throw new Error('the sample day has no repository');
    const oneJudged: Day = {
      ...day,
      repositories: [{ ...factory, moves: [] }, ...rest.map((r) => ({ ...r, judged: null, moves: [] }))],
    };
    const cleared = patchNeeds([
      readAt('2026-10-04T04:20:00.000Z', day),
      readAt('2026-10-05T04:20:00.000Z', oneJudged),
    ]);
    expect(cleared.map((need) => need.name)).toEqual(['example/debug-shell:1.4']);
  });

  it('keeps the row a card asks for until the panel takes it, so a click before the panel listens is not lost', () => {
    askRow('a key');
    askRow('the-roganator/cv-software-factory k3s');
    expect(takeAskedRow()).toBe('the-roganator/cv-software-factory k3s');
    expect(takeAskedRow()).toBeUndefined();
  });

  it('reads only the sense’s own role, and has nothing before its first day', () => {
    expect(patchNeeds([readAt('2026-10-06T04:20:00.000Z', day, 'factory_line')])).toEqual([]);
    expect(patchNeeds([])).toEqual([]);
  });

  it('has no card on a day where nothing waits on Martin', () => {
    const quiet: Day = {
      ...day,
      rows: [],
      repositories: day.repositories.map((r) => ({
        ...r,
        moves: r.moves.filter((m) => !['approval', 'cluster', 'issue'].includes(m.lane)),
      })),
    };
    expect(patchNeeds([readAt('2026-10-06T04:20:00.000Z', quiet)])).toEqual([]);
  });
});
