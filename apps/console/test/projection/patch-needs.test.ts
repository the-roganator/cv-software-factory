import type { PayloadOf, PublicEvent } from '@software-factory/events';
import { SCAN_MAX_AGE_HOURS as POLICY_SCAN_MAX_AGE_HOURS } from '@software-factory/policy/vulnerabilities';
import { describe, expect, it } from 'vitest';
import { own } from '../../e2e/full.ts';
import { foldItems } from '../../web/src/projection/items.ts';
import { needsView } from '../../web/src/projection/needs.ts';
import { PATCHING_ROLE, patchingDay, patchingNeed, SCAN_MAX_AGE_HOURS } from '../../web/src/projection/patch-needs.ts';
import { patchingView } from '../../web/src/projection/patching.ts';
import { END, SAMPLES } from './support.ts';

type Day = PayloadOf<'patching.read'>;
const H = 3_600_000;
const last = () => {
  const read = SAMPLES.findLast((e): e is PublicEvent<'patching.read'> => e.type === 'patching.read');
  if (!read) throw new Error('no sample day');
  return read;
};
let seq = 9000;
const readAt = (ts: string, payload: Day, appended_by = PATCHING_ROLE): PublicEvent<'patching.read'> => ({
  ...last(),
  seq: ++seq,
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
  ts,
  appended_by,
  payload,
});
const FULL = SAMPLES.map((e) => own(e as never) as PublicEvent);
/** A day with nothing that waits on Martin: no moves, no pins that wait, no rows of the sense's. */
const quiet = (day: Day, read?: string): Day => ({
  ...day,
  ...(read ? { read } : {}),
  rows: [],
  repositories: day.repositories.map((r) => ({ ...r, moves: [], waiting: [], pulls: [] })),
});

describe('Needs you’s Patching card, from the samples', () => {
  it('counts what waits on a visitor’s Martin by what he does, the withheld apart, with the first deadline among them', () => {
    const need = patchingNeed(patchingDay(SAMPLES), END);
    expect(need).toMatchObject({
      groups: [
        ['approve', 2],
        ['held', 2],
        ['stuck', 3],
        ['hand', 5],
        ['martin', 4],
      ],
      waiting: 16,
      stale: undefined,
      scanStale: [],
    });
    expect(need?.first).toMatchObject({ name: 'example-cd', deadline: Date.parse('2026-10-06T23:20:00.000Z') });
  });

  it('counts Martin’s by the groups his full events give, a move held with another counted in its row', () => {
    const need = patchingNeed(patchingDay(FULL), END);
    expect(need?.groups).toEqual([
      ['approve', 2],
      ['bench', 1],
      ['held', 3],
      ['stuck', 4],
      ['hand', 5],
    ]);
    expect(need?.waiting).toBe(15);
  });

  it('counts what the sheet shows waiting, group by group', () => {
    for (const events of [SAMPLES, FULL]) {
      const view = patchingView(events, foldItems(events), END);
      if (view.state !== 'read') throw new Error('no day read');
      const need = patchingNeed(patchingDay(events), END);
      expect(need?.waiting).toBe(view.waiting);
      expect(need?.groups).toEqual(view.groups.map(({ group, rows }) => [group, rows.length]));
    }
  });

  it('dates from the first of the sense’s days, unbroken to the last, that had anything waiting', () => {
    const first = SAMPLES.find((e) => e.type === 'patching.read');
    expect(patchingNeed(patchingDay(SAMPLES), END)?.since).toBe(Date.parse(first?.ts ?? ''));
    const broken = [
      readAt('2026-10-04T05:00:00.000Z', last().payload),
      readAt('2026-10-05T05:00:00.000Z', quiet(last().payload)),
      readAt('2026-10-06T05:00:00.000Z', last().payload),
    ];
    expect(patchingNeed(patchingDay(broken), END)?.since).toBe(Date.parse('2026-10-06T05:00:00.000Z'));
  });

  it('looks back no further than 28 days for since when, however many days have waited', () => {
    const days = Array.from({ length: 40 }, (_, i) =>
      readAt(new Date(Date.parse('2026-09-01T05:00:00.000Z') + i * 24 * H).toISOString(), last().payload),
    );
    const lastAt = Date.parse(days.at(-1)?.ts ?? '');
    expect(patchingNeed(patchingDay(days), lastAt)?.since).toBe(lastAt - 28 * 24 * H);
  });

  it('is in Needs you’s view, at the view’s time', () => {
    expect(needsView(foldItems(SAMPLES), END, undefined, patchingDay(SAMPLES)).patching?.waiting).toBe(16);
    expect(needsView(foldItems(SAMPLES), END).patching).toBeUndefined();
  });
});

describe('the card when nothing waits', () => {
  const read = '2026-10-06T05:12:00.000Z';
  const day = () => patchingDay([readAt(read, quiet(last().payload, read))]);

  it('is none while the day is fresh', () => {
    expect(patchingNeed(day(), Date.parse(read) + 25 * H)).toBeUndefined();
  });

  it('is shown once the sense has not read for 26 hours, saying since when', () => {
    const need = patchingNeed(day(), Date.parse(read) + 26 * H);
    expect(need).toMatchObject({ waiting: 0, groups: [], stale: Date.parse(read) });
  });

  it('is shown once a scan was judged more than 36 hours ago, naming it, as the review gate then passes none', () => {
    const judged = Date.parse(last().payload.repositories[0]?.judged ?? '');
    const need = patchingNeed(day(), judged + 36 * H + 60_000);
    expect(need?.scanStale.map((scan) => scan.repository)).toContain('the-roganator/cv-software-factory');
  });

  it('reads a day appended before the sense read pull requests as read when it was appended', () => {
    const { read: _read, ...payload } = quiet(last().payload);
    const at = '2026-10-06T05:12:00.000Z';
    expect(patchingDay([readAt(at, payload as Day)])?.read).toBe(Date.parse(at));
  });
});

describe('the sense’s day, for the card', () => {
  it('is read from Martin’s command line’s role too, which the store lets append one only as a sample', () => {
    expect(patchingDay([readAt('2026-10-06T04:20:00.000Z', last().payload, 'factory_operator')])?.rows.length).toBe(16);
  });

  it('is read only from the sense’s own role, and is none before its first day', () => {
    expect(patchingDay([readAt('2026-10-06T04:20:00.000Z', last().payload, 'factory_line')])).toBeUndefined();
    expect(patchingDay([])).toBeUndefined();
    expect(patchingNeed(undefined, END)).toBeUndefined();
  });

  it('holds a scan too old for its moves as long as policy does', () => {
    expect(SCAN_MAX_AGE_HOURS).toBe(POLICY_SCAN_MAX_AGE_HOURS);
  });
});
