/**
 * The scoreboard's rule and figures, on an invented answer key: none of its entries is a defect the app has.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { counts, type Fingerprint, type KeyEntry, matches } from '../../../../policy/scoreboard.ts';
import { figures, lastBoundary, median, type ScoreEvent, type Ticket, tickets } from '../../src/scoreboard/figures.ts';
import { parseKey } from '../../src/scoreboard/key.ts';

describe('the rule', () => {
  it.each<[string, Fingerprint, Fingerprint, boolean]>([
    [
      'the same class on the same route',
      { route: '/a', class: 'server-error' },
      { route: '/a', class: 'server-error' },
      true,
    ],
    ['another route', { route: '/b', class: 'server-error' }, { route: '/a', class: 'server-error' }, false],
    ['another class', { route: '/a', class: 'slow-response' }, { route: '/a', class: 'server-error' }, false],
    [
      'an entry on every route, from a ticket on one',
      { route: '/a', class: 'missing-alt' },
      { route: '*', class: 'missing-alt' },
      true,
    ],
    [
      'an entry on every route, from a ticket on every route',
      { route: '*', class: 'missing-alt' },
      { route: '*', class: 'missing-alt' },
      true,
    ],
    [
      'an entry on one route, from a ticket on every route',
      { route: '*', class: 'server-error' },
      { route: '/a', class: 'server-error' },
      false,
    ],
    [
      'the passage in the ticket’s, in any case',
      { page: '/p', text: 'The Moon is CHEESE, they say' },
      { page: '/p', text: 'moon is cheese' },
      true,
    ],
    [
      'the passage on another page',
      { page: '/q', text: 'the moon is cheese' },
      { page: '/p', text: 'moon is cheese' },
      false,
    ],
    [
      'more of the passage than the ticket has',
      { page: '/p', text: 'cheese' },
      { page: '/p', text: 'moon is cheese' },
      false,
    ],
    ['a route for a passage', { route: '/p', class: 'wrong-result' }, { page: '/p', text: 'cheese' }, false],
    ['a passage for a route', { page: '/p', text: 'cheese' }, { route: '/p', class: 'wrong-result' }, false],
  ])('%s: %s', (_what, ticket, entry, expected) => {
    expect(matches(ticket, entry)).toBe(expected);
  });
});

const T0 = Date.parse('2026-10-11T00:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** A work item's events, from its first signal at `start` minutes. */
function life(item: string, start: number, fingerprint: Ticket['fingerprint'], ...after: ScoreEvent[]): ScoreEvent[] {
  return [
    { ts: at(start), work_item: item, type: 'signal.received' },
    { ts: at(start), work_item: item, type: 'ticket.opened', payload: { fingerprint } },
    ...after,
  ];
}
const closed = (
  item: string,
  minutes: number,
  outcome: PayloadOf<'work-item.closed'>['outcome'] = 'verified',
): ScoreEvent => ({
  ts: at(minutes),
  work_item: item,
  type: 'work-item.closed',
  payload: { outcome },
});
const verification = (item: string, minutes: number, dryRun = false): ScoreEvent => ({
  ts: at(minutes),
  work_item: item,
  type: 'verification.finished',
  payload: { dryRun },
});
const reopened = (item: string, minutes: number): ScoreEvent => ({
  ts: at(minutes),
  work_item: item,
  type: 'work-item.reopened',
});

describe('a ticket’s life', () => {
  it('counts as verified while its last end is a verified close and its last verification is not a dry run’s', () => {
    const fp = { route: '/a', class: 'server-error' } as const;
    const events = [
      ...life('1', 0, fp, verification('1', 30), closed('1', 30)),
      ...life('2', 0, fp, verification('2', 30, true), closed('2', 30)),
      ...life('3', 0, fp, closed('3', 30)), // Martin approved a Verify hold: no verification
      ...life('4', 0, fp, verification('4', 30), closed('4', 30), reopened('4', 60)),
      ...life('5', 0, fp, closed('5', 30, 'no-change')),
      ...life(
        '6',
        0,
        fp,
        verification('6', 30),
        closed('6', 30),
        reopened('6', 60),
        verification('6', 90),
        closed('6', 90),
      ),
    ];
    expect(tickets(events).map((t) => t.everVerified)).toEqual([true, false, true, true, false, true]);
    expect(tickets(events).map((t) => t.verifiedAt && (t.verifiedAt - t.startedAt) / 60_000)).toEqual([
      30,
      null,
      30,
      null,
      null,
      90,
    ]);
  });

  it('reads a move’s reopening as any other, by its type alone, and counts the move’s ticket for nothing', () => {
    const move = { name: 'node', ecosystem: 'docker' } as const;
    const events = life('9', 0, move, closed('9', 30), reopened('9', 60));
    expect(tickets(events).map((t) => t.verifiedAt)).toEqual([null]);
    expect(figures(tickets(events), KEY, T0 + 90 * 60_000)).toMatchObject({ found: 0, verified: 0, falsePositives: 0 });
  });

  it('counts an improvement Martin asked for as nothing: it has no ticket, whichever way it closes', () => {
    // Of an improvement, the figures read only its closes: its opening, request and flag's events are no ticket's.
    const events: ScoreEvent[] = [closed('7', 30, 'turned-off'), closed('8', 30, 'verified')];
    expect(tickets(events)).toEqual([]);
    expect(figures(tickets(events), KEY, T0 + 60 * 60_000)).toMatchObject({ found: 0, verified: 0, falsePositives: 0 });
  });

  it('counts a ticket a dry run verified as verified once a look again cleared it on a real release', () => {
    const fp = { route: '/a', class: 'server-error' } as const;
    const looked = (item: string, minutes: number, outcome: 'cleared' | 'persists'): ScoreEvent => ({
      ts: at(minutes),
      work_item: item,
      type: 'signal.rechecked',
      payload: { outcome },
    });
    const events = [
      ...life('1', 0, fp, verification('1', 30, true), closed('1', 30), reopened('1', 60), looked('1', 90, 'cleared')),
      closed('1', 90),
      ...life('2', 0, fp, verification('2', 30, true), closed('2', 30), reopened('2', 60), looked('2', 90, 'persists')),
      closed('2', 120),
    ];
    expect(tickets(events).map((t) => t.verifiedAt && (t.verifiedAt - t.startedAt) / 60_000)).toEqual([90, null]);
  });

  it('starts at its first signal, or at its opening when that is sooner or it has none', () => {
    const fp = { route: '/a', class: 'server-error' } as const;
    const events: ScoreEvent[] = [
      { ts: at(0), work_item: '1', type: 'signal.received' },
      { ts: at(5), work_item: '1', type: 'signal.received' },
      { ts: at(20), work_item: '1', type: 'ticket.opened', payload: { fingerprint: fp } },
      { ts: at(7), work_item: '2', type: 'ticket.opened', payload: { fingerprint: fp } },
      { ts: at(9), work_item: '3', type: 'signal.received' }, // a work item with no ticket is not one
      // A ticket Martin approved, with no signal until one joins it after its close.
      { ts: at(10), work_item: '4', type: 'ticket.opened', payload: { fingerprint: fp } },
      { ts: at(30), work_item: '4', type: 'work-item.closed', payload: { outcome: 'verified' } },
      { ts: at(50), work_item: '4', type: 'signal.received' },
    ];
    expect(tickets(events).map((t) => [t.startedAt, t.openedAt].map((ms) => (ms - T0) / 60_000))).toEqual([
      [0, 20],
      [7, 7],
      [10, 10],
    ]);
  });
});

const KEY: KeyEntry[] = [
  { id: 'a', fingerprint: { route: '/a', class: 'server-error' } },
  { id: 'b', fingerprint: { route: '/b', class: 'slow-response' } },
  { id: 'c', fingerprint: { route: '*', class: 'missing-alt' } },
  { id: 'd', fingerprint: { page: '/d', text: 'moon is cheese' } },
];

describe('the figures', () => {
  const ticket = (fingerprint: Fingerprint, opened: number, verified: number | null = null): Ticket => ({
    fingerprint: fingerprint as Ticket['fingerprint'],
    openedAt: T0 + opened * 60_000,
    startedAt: T0 + opened * 60_000,
    verifiedAt: verified === null ? null : T0 + verified * 60_000,
    everVerified: verified !== null,
  });

  it('count entries found and verified, the quickest fix of each, and tickets that found nothing', () => {
    const all = [
      ticket({ route: '/a', class: 'server-error' }, 0, 40),
      ticket({ route: '/a', class: 'server-error' }, 10, 30), // the same entry, fixed quicker
      ticket({ route: '/c', class: 'missing-alt' }, 0, 60),
      ticket({ page: '/d', text: 'The moon is cheese.' }, 0),
      ticket({ route: '/z', class: 'server-error' }, 0), // found nothing
      ticket({ route: '*', class: 'server-error' }, 0), // nor this: no entry on every route of its class
    ];
    expect(figures(all, KEY, T0 + 1)).toEqual({
      entries: 4,
      found: 3,
      verified: 2,
      medianMs: 40 * 60_000, // the median of 20 and 60 minutes
      falsePositives: 2,
    });
  });

  it('count a dependency’s ticket for nothing, found or false positive, open or verified', () => {
    const move = (verified: number | null) => ({
      ...ticket({ route: '/a', class: 'server-error' }, 0, verified),
      fingerprint: { name: 'node', ecosystem: 'docker' } as Ticket['fingerprint'],
    });
    expect(counts({ name: 'node', ecosystem: 'docker' })).toBe(false);
    expect(counts({ route: '/a', class: 'server-error' })).toBe(true);
    expect(counts({ page: '/d', text: 'cheese' })).toBe(true);
    expect(figures([move(null), move(20)], KEY, T0 + 1)).toEqual({
      entries: 4,
      found: 0,
      verified: 0,
      medianMs: null,
      falsePositives: 0,
    });
  });

  it('count a ticket found only once it is before the cadence’s boundary, and a verified one at once', () => {
    const all = [
      ticket({ route: '/a', class: 'server-error' }, 10),
      ticket({ route: '/b', class: 'slow-response' }, 10, 20),
    ];
    expect(figures(all, KEY, T0 + 10 * 60_000)).toMatchObject({ found: 1, verified: 1 });
    expect(figures(all, KEY, T0 + 10 * 60_000 + 1)).toMatchObject({ found: 2, verified: 1 });
  });

  it('keep an entry found when its ticket reopens before the boundary', () => {
    const reopened = { ...ticket({ route: '/a', class: 'server-error' }, 10), everVerified: true };
    expect(figures([reopened], KEY, T0)).toMatchObject({ found: 1, verified: 0, medianMs: null });
  });

  it('have no median before an entry is verified', () => {
    expect(figures([], KEY, T0)).toEqual({ entries: 4, found: 0, verified: 0, medianMs: null, falsePositives: 0 });
    expect(figures([], [], T0)).toMatchObject({ entries: 0 });
  });

  it('move found on fixed boundaries, every six hours from midnight UTC', () => {
    expect(new Date(lastBoundary(Date.parse('2026-10-11T05:59:59Z'))).toISOString()).toBe('2026-10-11T00:00:00.000Z');
    expect(new Date(lastBoundary(Date.parse('2026-10-11T06:00:00Z'))).toISOString()).toBe('2026-10-11T06:00:00.000Z');
    expect(new Date(lastBoundary(Date.parse('2026-10-11T23:10:00Z'))).toISOString()).toBe('2026-10-11T18:00:00.000Z');
  });

  it('take the median of an odd or even count', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 2, 3])).toBe(3); // 2.5, to the nearest millisecond
    expect(median([])).toBeNull();
  });
});

describe('the key', () => {
  it('reads entries of an id and a fingerprint', () => {
    expect(parseKey(JSON.stringify(KEY))).toEqual(KEY);
  });

  it('refuses a key that is not valid, saying where and never what', () => {
    const secret = 'a-passage-nobody-may-see';
    const cases = [
      `[{"id": "x", "fingerprint": {"page": "/p", "text": "${secret}"}, "title": "${secret}"}]`,
      `[{"id": "x", "fingerprint": {"route": "/p", "class": "${secret}"}}]`,
      `[{"id": "${secret}", "fingerprint": {"route": "/p", "class": "server-error"}},
        {"id": "${secret}", "fingerprint": {"route": "/q", "class": "server-error"}}]`,
      `[{"id": "${secret}", `,
    ];
    for (const text of cases) {
      expect(() => parseKey(text)).toThrow(/^The answer key is not/);
      expect(() => parseKey(text)).not.toThrow(new RegExp(secret));
    }
  });

  it('refuses an id or a fingerprint twice, naming the entries, and a fingerprint no ticket could have', () => {
    const entry = (id: string, fingerprint: Fingerprint) => ({ id, fingerprint });
    const twice =
      (...entries: KeyEntry[]) =>
      () =>
        parseKey(JSON.stringify(entries));
    expect(twice(KEY[0] as KeyEntry, { ...(KEY[1] as KeyEntry), id: 'a' })).toThrow(
      "The answer key is not valid: 1.id repeats entry 0's id.",
    );
    expect(
      twice(entry('x', { page: '/d', text: 'Moon is cheese' }), entry('y', { page: '/d', text: 'moon IS cheese' })),
    ).toThrow("The answer key is not valid: 1.fingerprint repeats entry 0's fingerprint.");
    expect(
      twice(entry('x', { route: '/a', class: 'server-error' }), entry('y', { route: '/a', class: 'server-error' })),
    ).toThrow('repeats entry 0');
    expect(twice(entry('x', { page: '/d', text: 'a'.repeat(201) }))).toThrow('0.fingerprint');
    expect(twice(entry('x', { route: `/${'a'.repeat(200)}`, class: 'server-error' }))).toThrow('0.fingerprint');
  });
});
