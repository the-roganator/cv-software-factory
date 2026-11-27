/**
 * The moves Martin hears of (line/patching-alerts.ts), on the sense's invented day, with the clock given: each once, a
 * deadline judged when it comes within a day and when it passes, and nothing for a finding with no fix.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { SCAN_MAX_AGE_HOURS } from '../../../../policy/vulnerabilities.ts';
import {
  addDay,
  addMerge,
  copyPatchingTally,
  emptyPatchingTally,
  judgeDeadlines,
  type PatchingTally,
  SENSE_MAX_AGE_HOURS,
  senseStaleFor,
  staleScans,
} from '../../src/line/patching-alerts.ts';

type Day = PayloadOf<'patching.read'>;
const DAY: Day = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../../packages/events/test/fixtures/patching-day.json'), 'utf8'),
);
const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);
/** The day's scan, a little after it ran. */
const READ = at('2026-11-11T05:10:00Z');
const READ_ISO = new Date(READ).toISOString();

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
        waiting: [],
        pulls: [],
      })),
    };
    addDay(tally, noFix, READ);
    judgeDeadlines(tally, READ + 30 * 24 * H);
    expect(Object.values(tally.kinds).every((n) => n === 0)).toBe(true);
  });

  it('tells him of no routine update, whoever’s lane it is in: nothing is due, and it clears nothing', () => {
    const none = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    const tally = emptyPatchingTally();
    // Every move of the day merely behind, in each lane in turn: his cluster's, an issue's, the worker's, the line's.
    for (const [day, lane] of (['cluster', 'issue', 'worker', 'line'] as const).entries()) {
      const routine = moved({ ...DAY, rows: [] }, ({ deadline: _, ...move }) => ({
        ...move,
        deadline: undefined,
        clears: none,
        newToday: 0,
        lane,
      }));
      addDay(tally, routine, READ + day * 24 * H);
    }
    judgeDeadlines(tally, READ + 30 * 24 * H);
    expect(kinds(tally)).toEqual({
      'move-fix': 0,
      'move-waits': 0,
      'move-stopped': 0,
      'move-due-soon': 0,
      'move-overdue': 0,
      'app-fix-merged': 0,
    });
    // The same pin with a finding its move clears, in his lane: he hears of it then, once.
    addDay(
      tally,
      moved({ ...DAY, rows: [] }, () => ({ clears: { ...none, medium: 1 }, lane: 'issue' })),
      READ + 31 * 24 * H,
    );
    const moves = DAY.repositories.reduce((sum, r) => sum + r.moves.length, 0);
    expect(tally.kinds['move-waits']).toBe(moves);
    // A k3s the cluster has not moved to is a row of the sense's, which waits on him whatever asked for the move.
    const rows = emptyPatchingTally();
    addDay(
      rows,
      moved(DAY, () => ({ clears: none, deadline: undefined })),
      READ,
    );
    expect(rows.kinds['move-waits']).toBe(DAY.rows.length);
  });

  it('tells him of no move of the Makefile’s as his: it is the worker’s, as any pin the App writes', () => {
    const tally = emptyPatchingTally();
    const makefile = moved({ ...DAY, rows: [] }, () => ({
      name: 'argo-cd',
      pins: [{ file: 'Makefile', line: 9 }],
      lockfile: false,
      clears: { critical: 0, high: 0, medium: 3, low: 0, unknown: 0 },
      lane: 'worker',
    }));
    addDay(tally, makefile, READ);
    expect(tally.kinds['move-waits']).toBe(0);
  });

  it('still tells him of a line no longer built, which has no lane and clears nothing a move can', () => {
    const tally = emptyPatchingTally();
    const unbuilt = moved({ ...DAY, rows: [] }, () => ({
      clears: { critical: 0, high: 2, medium: 0, low: 0, unknown: 0 },
      lane: 'none',
    }));
    addDay(tally, unbuilt, READ);
    expect(tally.kinds['move-fix']).toBeGreaterThan(0);
  });

  it('counts a line no longer built as waiting on him: nobody’s pull request can move it, and its issue asks him', () => {
    const tally = emptyPatchingTally();
    const unbuilt = moved({ ...DAY, rows: [] }, (m) =>
      m.name === 'k3s'
        ? {}
        : { clears: { critical: 0, high: 0, medium: 2, low: 0, unknown: 0 }, lane: 'none', deadline: undefined },
    );
    addDay(tally, unbuilt, READ);
    // k3s, his cluster's, and every other move of the day, each on a line no longer built.
    const moves = unbuilt.repositories.flatMap((r) => r.moves).length;
    expect(moves).toBeGreaterThan(1);
    expect(tally.kinds['move-waits']).toBe(moves);
    addDay(tally, unbuilt, READ + 24 * H);
    expect(tally.kinds['move-waits']).toBe(moves);
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
  const merge = (workItem: string, change: object = {}) => ({
    workItem,
    by: 'factory',
    appendedBy: 'factory_line',
    securityFix: true,
    held: false,
    ...change,
  });

  it('counts the line’s merge of one, once for its work item', () => {
    const tally = emptyPatchingTally();
    addMerge(tally, merge('1412'));
    addMerge(tally, merge('1412'));
    expect(tally.kinds['app-fix-merged']).toBe(1);
  });

  it('counts none Martin merged, approved after a hold, or that any role but the line’s recorded, nor any other work item', () => {
    const tally = emptyPatchingTally();
    addMerge(tally, merge('1413', { by: 'martin' }));
    addMerge(tally, merge('1414', { held: true }));
    addMerge(tally, merge('1415', { appendedBy: 'factory_triage' }));
    addMerge(tally, merge('1416', { securityFix: false }));
    addMerge(tally, merge('1417', { securityFix: null }));
    expect(tally.kinds['app-fix-merged']).toBe(0);
  });
});

describe('a move across days', () => {
  it('counts a deadline passed while the line was down as the line running then would have: due, then past', () => {
    const live = emptyPatchingTally();
    addDay(live, DAY, READ);
    for (let hour = 1; hour <= 6 * 24; hour++) judgeDeadlines(live, READ + hour * H);
    const again = emptyPatchingTally();
    addDay(again, DAY, READ);
    judgeDeadlines(again, READ + 6 * 24 * H);
    expect(kinds(again)).toEqual(kinds(live));
  });

  it('is the same row of the sense’s in a new pod: a rollout is told of no more', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    const waits = tally.kinds['move-waits'];
    const rolled: Day = {
      ...DAY,
      rows: DAY.rows.map((row) => (row.row === 'not-running' ? row : { ...row, pod: `${row.pod}-rolled` })),
    };
    addDay(tally, rolled, READ + 24 * H);
    expect(tally.kinds['move-waits']).toBe(waits);
  });

  it('keeps two lockfiles’ moves of one package apart, each with its own deadline', () => {
    const tally = emptyPatchingTally();
    const lockfile = (file: string, deadline: string) => ({
      name: 'pnpm-lock.yaml',
      pins: [{ file, line: 0 }],
      from: '',
      to: '',
      major: false,
      clears: { critical: 0, high: 2, medium: 0, low: 0, unknown: 0 },
      leaves: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      deadline,
      newToday: 0,
      lane: 'issue' as const,
      lockfile: true,
      package: { name: 'example-parser', from: '1.0.0', to: '1.0.1', pins: [{ file, line: 12 }] },
    });
    const day: Day = {
      ...DAY,
      rows: [],
      repositories: [
        {
          ...(DAY.repositories[0] as Day['repositories'][number]),
          moves: [
            lockfile('pnpm-lock.yaml', '2026-11-13T05:00:00Z'),
            lockfile('docs/pnpm-lock.yaml', '2026-11-21T05:00:00Z'),
          ],
        },
      ],
    };
    addDay(tally, day, READ);
    expect(tally.kinds['move-waits']).toBe(2);
    expect(tally.deadlines.size).toBe(2);
  });

  it('keeps the deadlines of a repository whose run judged nothing, so one passing then is still told', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    const failed: Day = {
      ...DAY,
      rows: [],
      compared: false,
      repositories: DAY.repositories.map((r) => ({ ...r, judged: null, totals: null, moves: [] })),
    };
    addDay(tally, failed, READ + 24 * H);
    judgeDeadlines(tally, at('2026-11-16T18:00:00Z'));
    // The sidecar's and k3s's deadlines passed while the runs judged nothing.
    expect(tally.kinds['move-overdue']).toBe(2);
  });
});

describe('a scan that stops', () => {
  const FACTORY = 'the-roganator/cv-software-factory';
  const APP = 'the-roganator/cv-worlds-worst-website';
  /** The fixture's scans judged at 04:57 and 05:01 on the 11th. */
  const JUDGED = { [FACTORY]: at('2026-11-11T04:57:00Z'), [APP]: at('2026-11-11T05:01:00Z') };
  const stale = (tally: PatchingTally, t: number, since = READ) =>
    Object.fromEntries(staleScans(tally, t, since).map((each) => [each.repository, each.staleFor > 0]));
  const scanned = (day: Day, judged: Record<string, string | null>): Day => ({
    ...day,
    repositories: day.repositories.map((r) => ({ ...r, judged: judged[r.repository] ?? r.judged })),
  });

  it('is the policy’s age: a day and a half, so a scan GitHub starts hours late is not one', () => {
    expect(SCAN_MAX_AGE_HOURS).toBe(36);
  });

  it('says nothing before the sense’s first day: a new cluster has no scan to be old', () => {
    expect(staleScans(emptyPatchingTally(), READ + 365 * 24 * H, READ)).toEqual([]);
  });

  it('is stale for each repository once its newest scan judged more than the age ago, by the clock, with no day since', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    expect(stale(tally, READ)).toEqual({ [FACTORY]: false, [APP]: false });
    // No day arrives: the scan did not run, or the sense could not read it. Each is told from its own scan's time.
    expect(stale(tally, JUDGED[FACTORY] + 36 * H)).toEqual({ [FACTORY]: false, [APP]: false });
    expect(stale(tally, JUDGED[FACTORY] + 36 * H + 1)).toEqual({ [FACTORY]: true, [APP]: false });
    expect(stale(tally, JUDGED[APP] + 36 * H + 1)).toEqual({ [FACTORY]: true, [APP]: true });
  });

  it('ends for a repository when a day arrives with a scan judged since, and not for the other', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    const later = READ + 48 * H;
    expect(stale(tally, later)).toEqual({ [FACTORY]: true, [APP]: true });
    addDay(tally, scanned(DAY, { [APP]: '2026-11-13T05:01:00Z' }), later);
    expect(stale(tally, later)).toEqual({ [FACTORY]: true, [APP]: false });
  });

  it('is not ended by a day whose run judged nothing, nor set back by a day read from an older scan', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    const failed: Day = { ...DAY, repositories: DAY.repositories.map((r) => ({ ...r, judged: null, totals: null })) };
    addDay(tally, failed, READ + 24 * H);
    addDay(tally, scanned(DAY, { [APP]: '2026-11-10T05:01:00Z' }), READ + 25 * H);
    expect(stale(tally, JUDGED[APP] + 36 * H)).toEqual({ [FACTORY]: true, [APP]: false });
    expect(stale(tally, JUDGED[APP] + 36 * H + 1)).toEqual({ [FACTORY]: true, [APP]: true });
  });

  it('measures a repository no scan has judged from the first day that said so', () => {
    const tally = emptyPatchingTally();
    const never: Day = { ...DAY, repositories: DAY.repositories.map((r) => ({ ...r, judged: null, totals: null })) };
    addDay(tally, never, READ);
    addDay(tally, never, READ + 24 * H);
    expect(stale(tally, READ + 36 * H)).toEqual({ [FACTORY]: false, [APP]: false });
    expect(stale(tally, READ + 36 * H + 1)).toEqual({ [FACTORY]: true, [APP]: true });
    // Its first scan to judge ends it, though it judged before that first day.
    addDay(tally, DAY, READ + 40 * H);
    expect(stale(tally, JUDGED[FACTORY] + 36 * H)).toEqual({ [FACTORY]: false, [APP]: false });
  });

  it('says how long it has been stale, from its age or from when the line began reading, if later', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    const age = JUDGED[FACTORY] + 36 * H;
    const of = (t: number, since: number) =>
      staleScans(tally, t, since).find((e) => e.repository === FACTORY)?.staleFor;
    expect(of(age + 10 * 60_000, READ)).toBe(600);
    // A cluster that wakes days later: measured from the line's start, so the sense has its minutes to read.
    expect(of(age + 72 * H, age + 72 * H - 60_000)).toBe(60);
    expect(of(age + 72 * H, age + 72 * H)).toBe(0);
  });

  it('is copied with the tally', () => {
    const tally = emptyPatchingTally();
    const copy = copyPatchingTally(tally);
    addDay(copy, DAY, READ);
    expect(tally.scans.size).toBe(0);
    expect(copyPatchingTally(copy).scans).toEqual(copy.scans);
  });
});

describe('a sense that stops', () => {
  it('is two of the days it keeps missed, and two hours’ reads more', () => {
    expect(SENSE_MAX_AGE_HOURS).toBe(26);
  });

  it('says nothing before the sense’s first day', () => {
    expect(senseStaleFor(emptyPatchingTally(), READ + 365 * 24 * H, READ)).toBeNull();
  });

  it('is stale once no day has arrived in that age, by the clock, and ends when one does', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    expect(senseStaleFor(tally, READ + 26 * H, READ)).toBe(0);
    expect(senseStaleFor(tally, READ + 26 * H + 15 * 60_000, READ)).toBe(900);
    // The same day again, as the sense appends it every 12 hours though nothing changed, ends it.
    addDay(tally, DAY, READ + 27 * H);
    expect(senseStaleFor(tally, READ + 27 * H + 60_000, READ)).toBe(0);
    expect(senseStaleFor(tally, READ + 53 * H + 1000, READ)).toBe(1);
  });

  it('is measured from when the line began reading, for a cluster that wakes with an old day', () => {
    const tally = emptyPatchingTally();
    addDay(tally, DAY, READ);
    const woke = READ + 4 * 24 * H;
    expect(senseStaleFor(tally, woke, woke)).toBe(0);
    expect(senseStaleFor(tally, woke + 20 * 60_000, woke)).toBe(1200);
  });

  it('is copied with the tally', () => {
    const tally = emptyPatchingTally();
    const copy = copyPatchingTally(tally);
    addDay(copy, DAY, READ);
    expect(tally.lastDay).toBeNull();
    expect(copyPatchingTally(copy).lastDay).toBe(READ);
  });
});

describe('a move tried and stopped', () => {
  type Pull = Day['repositories'][number]['pulls'][number];
  type Waiting = Day['repositories'][number]['waiting'][number];
  const none = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  const open = (number: number, change: Partial<Pull>): Pull => ({
    kind: 'pin',
    number,
    moves: [{ name: 'ghcr.io/example/sidecar' }],
    opened: '2026-11-10T05:10:00Z',
    state: 'open',
    ...change,
  });
  const wait = (name: string, change: Partial<Waiting>): Waiting => ({
    name,
    pins: [{ file: 'deploy/base/cache/statefulset.yaml', line: 21 }],
    from: '8.2.1',
    why: 'no-better',
    clears: { ...none, high: 1 },
    deadline: '2026-11-25T04:57:00Z',
    ...change,
  });
  /** The day, its first repository's pull requests and waits as given, and nothing else of the day's to count. */
  const withPulls = (pulls: Pull[], waiting: Waiting[] = []): Day => ({
    ...DAY,
    rows: [],
    repositories: DAY.repositories.map((r, i) => ({
      ...r,
      moves: [],
      pulls: i === 0 ? pulls : [],
      waiting: i === 0 ? waiting : [],
    })),
  });
  const STOPPED = [
    open(1224, { hold: 'checks-spent', checks: { state: 'failed', try: 3, of: 3, failed: [] } }),
    open(1225, { hold: 'queue-spent' }),
    open(1226, { kind: 'dependabot', hold: 'conflict' }),
    open(1211, { kind: 'issue', issue: 'refused', refusal: 'provenance' }),
    open(1212, { kind: 'issue', issue: 'branch-held' }),
    open(1213, { kind: 'issue', issue: 'open-refused' }),
    open(1214, { kind: 'issue', issue: 'history-unread' }),
  ];

  it('counts each pull request and issue the factory stopped trying, and a pin no release is better than, once each', () => {
    const tally = emptyPatchingTally();
    const day = withPulls(STOPPED, [wait('docker.io/example/cache', {})]);
    addDay(tally, day, READ);
    expect(tally.kinds['move-stopped']).toBe(8);
    // Each hour the sense reads them again, and the 12th appends the day again: nothing new.
    addDay(tally, day, READ + 12 * H);
    addDay(tally, day, READ + 24 * H);
    expect(tally.kinds['move-stopped']).toBe(8);
    expect({ ...tally.kinds, 'move-stopped': 0 }).toEqual(kinds(emptyPatchingTally()));
  });

  it('counts none that waits for anything else, has settled, or is a routine update’s wait', () => {
    const tally = emptyPatchingTally();
    const day = withPulls(
      [
        open(1300, { hold: 'verdict' }),
        open(1301, { hold: 'held' }),
        open(1302, { hold: 'changes-requested' }),
        open(1303, { hold: 'level' }),
        open(1304, { hold: 'stopped' }),
        open(1305, { hold: 'checks' }),
        open(1306, { hold: 'dequeued' }),
        open(1307, { hold: 'label' }),
        open(1308, { kind: 'dependabot', hold: 'martin' }),
        open(1309, { queued: true }),
        open(1310, { kind: 'issue', issue: 'bench' }),
        open(1311, { kind: 'issue', issue: 'none' }),
        open(1312, { kind: 'issue', issue: 'workflow' }),
        open(1313, { kind: 'issue', issue: 'cluster' }),
        open(1314, { kind: 'issue', issue: 'reverted' }),
        open(1315, { kind: 'issue', issue: 'other' }),
        { ...open(1316, { kind: 'issue', issue: 'refused', refusal: 'young' }), state: 'closed', settled: READ_ISO },
        { ...open(1317, {}), state: 'merged', settled: READ_ISO },
      ],
      [
        wait('docker.io/example/routine', { clears: none, deadline: undefined, routine: true }),
        wait('docker.io/example/undated', { deadline: undefined }),
        wait('docker.io/example/queue', { why: 'content', to: 'image 7.4.1', until: '2026-11-12T04:57:00Z' }),
      ],
    );
    addDay(tally, day, READ);
    expect(tally.kinds['move-stopped']).toBe(0);
  });

  it('counts the same pull request again for a new reason, and the same reason on another', () => {
    const tally = emptyPatchingTally();
    addDay(tally, withPulls([open(1224, { hold: 'checks-spent' })]), READ);
    addDay(tally, withPulls([open(1224, { hold: 'conflict' })]), READ + H);
    addDay(tally, withPulls([open(1224, { hold: 'checks-spent' })]), READ + 2 * H);
    addDay(tally, withPulls([open(1227, { hold: 'checks-spent' })]), READ + 3 * H);
    expect(tally.kinds['move-stopped']).toBe(3);
  });

  it('counts the same after a restart that reads the days again', () => {
    const days = [withPulls(STOPPED.slice(0, 3)), withPulls(STOPPED)];
    const live = emptyPatchingTally();
    days.forEach((day, i) => {
      addDay(live, day, READ + i * H);
    });
    const again = emptyPatchingTally();
    days.forEach((day, i) => {
      addDay(again, day, READ + i * H);
    });
    expect(kinds(again)).toEqual(kinds(live));
    expect(live.kinds['move-stopped']).toBe(STOPPED.length);
  });

  it('says nothing of a routine update tried and stopped, as of a routine wait: nothing is due', () => {
    const none = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    const routine = moved(DAY, ({ deadline: _, ...move }) => ({ ...move, deadline: undefined, clears: none }));
    const tally = emptyPatchingTally();
    addDay(tally, routine, READ);
    expect(tally.kinds['move-stopped']).toBe(0);
    // The same pull request carrying a fix is said once.
    addDay(tally, DAY, READ + H);
    expect(tally.kinds['move-stopped']).toBe(1);
  });

  it('reads a day stored before the sense read pull requests, which has none', () => {
    const tally = emptyPatchingTally();
    const before = {
      ...DAY,
      repositories: DAY.repositories.map(({ pulls: _p, waiting: _w, ...r }) => r),
    } as unknown as Day;
    addDay(tally, before, READ);
    expect(tally.kinds['move-stopped']).toBe(0);
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
