/**
 * The moves Martin hears of (line/patching-alerts.ts), on the sense's invented day, with the clock given: each once, a
 * deadline judged when it comes within a day and when it passes, and nothing for a finding with no fix.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import {
  addDay,
  addMerge,
  copyPatchingTally,
  emptyPatchingTally,
  judgeDeadlines,
  type PatchingTally,
} from '../../src/line/patching-alerts.ts';

type Day = PayloadOf<'patching.read'>;
const DAY: Day = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../../packages/events/test/fixtures/patching-day.json'), 'utf8'),
);
const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);
/** The day's scan, a little after it ran. */
const READ = at('2026-11-11T05:10:00Z');

const kinds = (tally: PatchingTally) => ({ ...tally.kinds });
const moved = (day: Day, change: (move: Day['repositories'][number]['moves'][number]) => object): Day => ({
  ...day,
  repositories: day.repositories.map((r) => ({ ...r, moves: r.moves.map((m) => ({ ...m, ...change(m) })) })),
});

describe('the moves Martin hears of, on the sense’s day', () => {
  it('counts a move that first has a High or Critical fix, and one that first waits on him, once each', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    // The sidecar (2 Critical, 3 High), k3s (30 High) and the app's base (1 High) have a fix at High or Critical; the
    // lockfile's move has none. k3s is his cluster's, and the sense made three rows.
    expect(tally.kinds['move-fix']).toBe(3);
    expect(tally.kinds['move-waits']).toBe(4);
    // The sidecar is due at 04:57 tomorrow, within a day of being first seen: its fix says so, and nothing more.
    expect(tally.kinds['move-due-soon']).toBe(0);
    expect(tally.kinds['move-overdue']).toBe(0);
  });

  it('never repeats on a timer: the same day again, or the clock running on, counts nothing new', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    const first = kinds(tally);
    for (let hour = 1; hour <= 20; hour++) judgeDeadlines(tally, READ + hour * H);
    addDay(tally, DAY, READ + 21 * H);
    expect(kinds(tally)).toEqual(first);
  });

  it('tells of a deadline once when it comes within a day, and once when it passes, while the move has not merged', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    // k3s is due 16 Nov 17:49: within a day from 15 Nov 17:49.
    judgeDeadlines(tally, at('2026-11-15T17:48:00Z'));
    expect(tally.kinds['move-due-soon']).toBe(0);
    judgeDeadlines(tally, at('2026-11-15T17:50:00Z'));
    expect(tally.kinds['move-due-soon']).toBe(1);
    judgeDeadlines(tally, at('2026-11-15T23:00:00Z'));
    expect(tally.kinds['move-due-soon']).toBe(1);
    // The sidecar's deadline passed meanwhile, on 12 Nov, and k3s's then does.
    expect(tally.kinds['move-overdue']).toBe(1);
    judgeDeadlines(tally, at('2026-11-16T17:50:00Z'));
    expect(tally.kinds['move-overdue']).toBe(2);
    judgeDeadlines(tally, at('2026-11-17T17:50:00Z'));
    expect(tally.kinds['move-overdue']).toBe(2);
  });

  it('says nothing of a deadline once its move has merged and the next day no longer has it', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    const merged: Day = {
      ...DAY,
      repositories: DAY.repositories.map((r) => ({ ...r, moves: r.moves.filter((m) => m.name !== 'k3s') })),
    };
    addDay(tally, merged, at('2026-11-12T05:10:00Z'));
    judgeDeadlines(tally, at('2026-11-16T18:00:00Z'));
    // The sidecar's deadline passed; the app's base's is two days off; k3s merged before its own came near.
    expect(tally.kinds['move-overdue']).toBe(1);
    expect(tally.kinds['move-due-soon']).toBe(0);
  });

  it('judges a deadline the day it left at that day’s time, so the line restarted counts what it counted', () => {
    // The live line: the day, the clock past the app's base's day before, then the next day without it.
    const live = emptyPatchingTally();
    addDay(live, DAY, READ);
    judgeDeadlines(live, at('2026-11-17T06:00:00Z'));
    const gone: Day = {
      ...DAY,
      repositories: DAY.repositories.map((r) => ({
        ...r,
        moves: r.moves.filter((m) => m.name !== 'ghcr.io/example/base'),
      })),
    };
    addDay(live, gone, at('2026-11-17T09:00:00Z'));
    judgeDeadlines(live, at('2026-11-17T09:00:00Z'));
    // The line restarted after: both days read again, at the clock's time now.
    const again = emptyPatchingTally();
    addDay(again, DAY, READ);
    addDay(again, gone, at('2026-11-17T09:00:00Z'));
    judgeDeadlines(again, at('2026-11-17T09:00:00Z'));
    expect(kinds(again)).toEqual(kinds(live));
  });

  it('counts nothing for a finding with no fix, however many the day has', () => {
    const tally = emptyPatchingTally();
    const noFix: Day = {
      ...DAY,
      rows: [],
      repositories: DAY.repositories.map((r) => ({
        ...r,
        totals: r.totals && { ...r.totals, noFix: 15_000, newHighWithoutFix: 35 },
        moves: [],
      })),
    };
    addDay(tally, noFix, READ);
    judgeDeadlines(tally, READ + 30 * 24 * H);
    expect(Object.values(tally.kinds).every((n) => n === 0)).toBe(true);
  });

  it('has a move’s first High or Critical counted the day it gets one, not before', () => {
    const tally = emptyPatchingTally();
    addDay(
      tally,
      moved(DAY, () => ({ clears: { critical: 0, high: 0, medium: 4, low: 0, unknown: 0 } })),
      READ,
    );
    expect(tally.kinds['move-fix']).toBe(0);
    addDay(tally, DAY, READ + 24 * H);
    expect(tally.kinds['move-fix']).toBe(3);
  });

  it('keeps at most a message or two for a move in a day', () => {
    const tally = emptyPatchingTally();
    // k3s, a move of his cluster's, first seen within a day of its deadline: its fix and its wait, and no third.
    addDay(
      tally,
      moved(DAY, (m) => (m.name === 'k3s' ? { deadline: '2026-11-12T04:00:00Z' } : {})),
      READ,
    );
    judgeDeadlines(tally, READ + 12 * H);
    expect(tally.kinds).toMatchObject({ 'move-fix': 3, 'move-waits': 4, 'move-due-soon': 0, 'move-overdue': 0 });
  });
});

describe('the app’s vulnerable dependency, fixed without Martin', () => {
  it('counts the line’s merge of one, once for its work item, and no merge of his, or of any other work item', () => {
    const tally = emptyPatchingTally();
    addMerge(tally, '1412', 'factory', true);
    addMerge(tally, '1412', 'factory', true);
    addMerge(tally, '1413', 'martin', true);
    addMerge(tally, '1414', 'factory', false);
    addMerge(tally, '1415', 'factory', null);
    expect(tally.kinds['app-fix-merged']).toBe(1);
  });
});

describe('a copy of the tally', () => {
  it('leaves the tally it was copied from as it was', () => {
    const tally = emptyPatchingTally();
    const copy = copyPatchingTally(tally);
    addDay(copy, DAY, READ);
    expect(Object.values(tally.kinds).every((n) => n === 0)).toBe(true);
    expect(tally.deadlines.size).toBe(0);
  });
});
