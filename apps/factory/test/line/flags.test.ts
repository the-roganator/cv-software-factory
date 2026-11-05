/**
 * The line's pass over the feature flags (Verify by variant): what it decides from the flags' state, and the pass
 * against the store, which closes an improvement whose flag Martin turned off, once, as turned off, with his reason.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COLOR_SCHEMES, type NewEvent, type PayloadOf, type Screenshot, VERSIONS } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import {
  DiskArtifacts,
  EventWriter,
  type FlagEvents,
  flagEvents,
  nextWorkItem,
  type StoredFlagCheck,
  type StoredFlagRecord,
} from '@software-factory/store';
import pino from 'pino';
import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { flagsFrom } from '../../../../policy/flag-moves.ts';
import type { Stage } from '../../../../policy/flags.ts';
import { release as RELEASE } from '../../../../policy/release.ts';
import type { Sample } from '../../src/clients/http.ts';
import type { Prometheus } from '../../src/clients/prometheus.ts';
import { sidesOf } from '../../src/line/compare.ts';
import { type CheckAsked, checkedDraft, requestOf } from '../../src/line/flag-checks.ts';
import { type FlagItem, flagsNext, itemsAsked } from '../../src/line/flags.ts';
import type { FlagChecksPort } from '../../src/line/verify.ts';
import { Line, type LineOptions } from '../../src/line/worker.ts';
import { IndexedArtifacts, PictureIndex } from '../../src/pictures/index.ts';
import type { Checked, FlagCheckRequest } from '../../src/probes/flag-check.ts';
import { quiet } from '../github/fake.ts';
import { FakeGitHub, FakeSteps } from './fakes.ts';

const OFF = { stage: 'off' } as const;
const CHECKS = { stage: 'checks' } as const;
const PREVIEW = { stage: 'preview' } as const;
const SHARE = { stage: 'share', share: 50 } as const;
const EVERYONE = { stage: 'everyone' } as const;

let seq = 0;
const staged = (
  flag: string,
  workItem: string,
  from: Stage | null,
  to: Stage,
  reason?: string,
): Extract<StoredFlagRecord, { type: 'flag.staged' }> => ({
  type: 'flag.staged',
  seq: String(++seq),
  ts: new Date(Date.parse('2026-10-27T09:00:00Z') + seq * 60_000).toISOString(),
  flag,
  workItem,
  from,
  to,
  revision: `r${seq}`,
  ...(reason && { reason }),
});

const open: FlagItem = { improvement: true, sample: false, closed: false, dryRun: false };
/** A day after the first move, by when the app has long held every move. */
const LATER = Date.parse('2026-10-28T09:00:00Z');

/** The flags' events as the store tells them, with no checks and no revision unless given. */
const told = (
  named: Record<string, string>,
  records: StoredFlagRecord[],
  more: Partial<Pick<FlagEvents, 'checked' | 'revision'>> = {},
): FlagEvents => ({ named, pages: {}, records, checked: [], revision: null, ...more });

describe('what the flag pass decides', () => {
  /** A flag widened a stage at a time to `at`, then turned off from there. */
  const offFrom = (at: Stage): FlagEvents => {
    const path = [CHECKS, PREVIEW, SHARE, EVERYONE];
    const reached = path.slice(0, path.findIndex((s) => s.stage === at.stage) + 1);
    const records = reached.map((to, i) => staged('dates', '7', i === 0 ? OFF : (reached[i - 1] as Stage), to));
    return told({ dates: '7' }, [...records, staged('dates', '7', at, OFF, 'Wrong on Sundays')]);
  };

  it.each([CHECKS, PREVIEW, SHARE, EVERYONE])('closes the improvement turned off from %o, with the reason', (at) => {
    expect(flagsNext({ flags: offFrom(at), items: { '7': open }, only: null, now: LATER })).toEqual([
      { do: 'close', flag: 'dates', workItem: '7', from: at, reason: 'Wrong on Sundays' },
    ]);
  });

  it('asks of the work items flags were last staged on, and of those whose spec names a flag at Off', () => {
    expect(itemsAsked(offFrom(PREVIEW))).toEqual(['7']);
    expect(itemsAsked(told({ dates: '7' }, []))).toEqual(['7']);
    expect(itemsAsked(told({}, []))).toEqual([]);
  });

  it('closes nothing already closed, so nothing twice: not a flag turned back on and off again', () => {
    expect(
      flagsNext({ flags: offFrom(EVERYONE), items: { '7': { ...open, closed: true } }, only: null, now: LATER }),
    ).toEqual([]);
  });

  it('closes nothing but an open improvement of the factory’s own', () => {
    const flags = offFrom(CHECKS);
    expect(flagsNext({ flags, items: { '7': { ...open, improvement: false } }, only: null, now: LATER })).toEqual([]);
    expect(flagsNext({ flags, items: { '7': { ...open, sample: true } }, only: null, now: LATER })).toEqual([]);
    expect(flagsNext({ flags, items: {}, only: null, now: LATER })).toEqual([]);
  });

  it('closes nothing for a flag on, or turned off and widened again', () => {
    const closing = (flags: FlagEvents) =>
      flagsNext({ flags, items: { '7': open }, only: null, now: LATER }).filter((next) => next.do === 'close');
    expect(closing(told({ dates: '7' }, [staged('dates', '7', OFF, CHECKS)]))).toEqual([]);
    const again = offFrom(CHECKS);
    again.records.push(staged('dates', '7', OFF, CHECKS));
    expect(closing(again)).toEqual([]);
  });

  it('closes a work item once, whichever of its flags was turned off', () => {
    const flags = told({ dates: '7' }, [
      staged('dates', '7', CHECKS, OFF, 'No'),
      staged('old', '7', CHECKS, OFF, 'Nor this'),
    ]);
    expect(flagsNext({ flags, items: { '7': open }, only: null, now: LATER })).toHaveLength(1);
  });

  it('compares a flag at Share, once for each move there, and nothing at any other stage', () => {
    const records = [staged('dates', '7', OFF, CHECKS), staged('dates', '7', CHECKS, SHARE)];
    const move = records[1] as StoredFlagRecord;
    const flags = told({ dates: '7' }, records);
    expect(flagsNext({ flags, items: { '7': open }, only: null, now: LATER })).toEqual([
      {
        do: 'compare',
        flag: 'dates',
        workItem: '7',
        share: 50,
        move: { seq: move.seq, ts: move.ts, revision: `r${move.seq}` },
      },
    ]);
    const compared: StoredFlagRecord = {
      type: 'flag.compared',
      seq: String(++seq),
      ts: move.ts,
      flag: 'dates',
      share: 50,
      outcome: 'passed',
      moveRevision: `r${move.seq}`,
    };
    expect(
      flagsNext({ flags: { ...flags, records: [...records, compared] }, items: { '7': open }, only: null, now: LATER }),
    ).toEqual([]);
    // A narrower share is a move of its own, compared afresh.
    const narrowed = [...records, compared, staged('dates', '7', SHARE, { stage: 'share', share: 25 })];
    expect(
      flagsNext({ flags: { ...flags, records: narrowed }, items: { '7': open }, only: null, now: LATER }),
    ).toMatchObject([{ do: 'compare', share: 25 }]);
    const checks = { ...flags, records: [records[0] as StoredFlagRecord] };
    expect(
      flagsNext({ flags: checks, items: { '7': open }, only: null, now: LATER }).filter((n) => n.do === 'compare'),
    ).toEqual([]);
    // On a closed work item too: a flag back on from Everyone after it closed may be narrowed to Share, and Everyone
    // waits on the comparison.
    expect(flagsNext({ flags, items: { '7': { ...open, closed: true } }, only: null, now: LATER })).toMatchObject([
      { do: 'compare' },
    ]);
  });

  describe('at Everyone', () => {
    /** A flag widened a stage at a time to Everyone, and the time the app has held that move from. */
    const atEveryone = () => {
      const records = [
        staged('dates', '7', OFF, CHECKS),
        staged('dates', '7', CHECKS, SHARE),
        staged('dates', '7', SHARE, EVERYONE),
      ];
      const move = records[2] as StoredFlagRecord;
      return { flags: told({ dates: '7' }, records), move, held: Date.parse(move.ts) + 60_000 };
    };

    it('closes the improvement as verified once the app has had its minute to hold the move, and not before', () => {
      const { flags, move, held } = atEveryone();
      expect(flagsNext({ flags, items: { '7': open }, only: null, now: held - 1 })).toEqual([]);
      expect(flagsNext({ flags, items: { '7': open }, only: null, now: held })).toEqual([
        { do: 'verified', flag: 'dates', workItem: '7', move: { seq: move.seq } },
      ]);
    });

    it('closes nothing closed already: not again after Off, nor back on to Everyone', () => {
      const { flags } = atEveryone();
      const closed = { '7': { ...open, closed: true } };
      expect(flagsNext({ flags, items: closed, only: null, now: LATER })).toEqual([]);
      flags.records.push(staged('dates', '7', EVERYONE, OFF, 'Wrong on Sundays'));
      expect(flagsNext({ flags, items: closed, only: null, now: LATER })).toEqual([]);
      flags.records.push(staged('dates', '7', OFF, EVERYONE));
      expect(flagsNext({ flags, items: closed, only: null, now: LATER })).toEqual([]);
    });

    it('closes nothing but an open improvement of the factory’s own, and respects just one', () => {
      const { flags } = atEveryone();
      expect(flagsNext({ flags, items: { '7': { ...open, sample: true } }, only: null, now: LATER })).toEqual([]);
      expect(flagsNext({ flags, items: { '7': { ...open, improvement: false } }, only: null, now: LATER })).toEqual([]);
      expect(flagsNext({ flags, items: { '7': open }, only: '8', now: LATER })).toEqual([]);
      expect(flagsNext({ flags, items: { '7': open }, only: '7', now: LATER })).toMatchObject([{ do: 'verified' }]);
    });

    it('closes nothing whose change only a dry run made: the line closes that one with no change once it runs live', () => {
      const { flags } = atEveryone();
      expect(flagsNext({ flags, items: { '7': { ...open, dryRun: true } }, only: null, now: LATER })).toEqual([]);
    });

    it('closes a work item once, whether another of its flags is at Everyone or turned off', () => {
      const { flags } = atEveryone();
      flags.records.push(staged('old', '7', CHECKS, OFF, 'No'));
      expect(flagsNext({ flags, items: { '7': open }, only: null, now: LATER })).toHaveLength(1);
    });
  });

  it('with just one, acts on that work item alone', () => {
    const flags = told({ dates: '7', wrap: '8' }, [
      staged('dates', '7', CHECKS, OFF, 'No'),
      staged('wrap', '8', CHECKS, OFF, 'Nor this'),
    ]);
    const items = { '7': open, '8': open };
    expect(flagsNext({ flags, items, only: '8', now: LATER }).map((next) => next.workItem)).toEqual(['8']);
    expect(flagsNext({ flags, items, only: '9', now: LATER })).toEqual([]);
    expect(flagsNext({ flags, items, only: null, now: LATER }).map((next) => next.workItem)).toEqual(['7', '8']);
  });
});

describe('which checks of a flag the pass asks the probes for', () => {
  /** A check the line recorded, at a place in the store after everything before it. */
  const check = (
    workItem: string,
    payload: Partial<PayloadOf<'flag.checked'>> & Pick<PayloadOf<'flag.checked'>, 'stage'>,
  ): StoredFlagCheck => ({
    seq: String(++seq),
    ts: '2026-10-27T10:00:00.000Z',
    workItem,
    check: { flag: 'dates', version: 'a'.repeat(40), revision: 'r1', ...payload } as PayloadOf<'flag.checked'>,
  });
  const baseline = (version = 'a'.repeat(40)) =>
    check('7', { stage: 'off', version, journeys: { passed: 3, ran: 4 }, notClean: [], pages: [] });

  it('pictures the pages its spec names, the first six, or the front page when it names none', () => {
    const pages = ['/products/blue-mug', '/basket', '/a', '/b', '/c', '/d', '/e'];
    const flags = told({ dates: '7' }, [], { revision: 'r3' });
    expect(
      flagsNext({ flags: { ...flags, pages: { dates: pages } }, items: { '7': open }, only: null, now: LATER }),
    ).toMatchObject([{ do: 'check', stage: 'off', pages: pages.slice(0, 6) }]);
    const staged = told({ dates: '7' }, [
      {
        type: 'flag.staged',
        seq: '5',
        ts: '2026-10-27T10:00:00.000Z',
        flag: 'dates',
        workItem: '7',
        from: OFF,
        to: CHECKS,
        revision: 'r5',
      },
    ]);
    expect(
      flagsNext({ flags: { ...staged, pages: { dates: ['/basket'] } }, items: { '7': open }, only: null, now: LATER }),
    ).toMatchObject([{ do: 'check', stage: 'checks', pages: ['/basket'] }]);
    expect(flagsNext({ flags: staged, items: { '7': open }, only: null, now: LATER })).toMatchObject([
      { pages: ['/'] },
    ]);
  });

  it('takes a baseline at Off, on an open improvement, of each version the probes have not seen it on', () => {
    const flags = told({ dates: '7' }, [], { revision: 'r3' });
    expect(flagsNext({ flags, items: { '7': open }, only: null, now: LATER })).toEqual([
      { do: 'check', flag: 'dates', workItem: '7', stage: 'off', revision: 'r3', move: null, base: null, pages: ['/'] },
    ]);
    const taken = { ...flags, checked: [baseline('a'.repeat(40)), { ...baseline('b'.repeat(40)) }] };
    for (const c of taken.checked) c.check.revision = 'r3';
    expect(flagsNext({ flags: taken, items: { '7': open }, only: null, now: LATER })).toMatchObject([
      { do: 'check', stage: 'off', have: 'b'.repeat(40) },
    ]);
    // Another flag moved since: a new flag set, so the same version is taken again.
    expect(
      flagsNext({ flags: { ...taken, revision: 'r4' }, items: { '7': open }, only: null, now: LATER })[0],
    ).not.toHaveProperty('have');
    // A baseline missing a page's dark picture, as every one taken before Verify pictured dark is, is taken again on
    // the same version; one with no pages is missing none.
    const light = {
      ...taken,
      checked: [
        check('7', {
          stage: 'off',
          version: 'b'.repeat(40),
          revision: 'r3',
          journeys: { passed: 3, ran: 4 },
          notClean: [],
          pages: [{ page: '/', route: '/', scheme: 'light', off: '1'.repeat(64) }],
        }),
      ],
    };
    expect(flagsNext({ flags: light, items: { '7': open }, only: null, now: LATER })[0]).not.toHaveProperty('have');
    // Once only: taken again and still missing a scheme (a page the probes cannot picture in dark), it is not taken a
    // third time on the same version and flag set.
    const again = { ...light, checked: [...light.checked, { ...(light.checked[0] as StoredFlagCheck), seq: '99' }] };
    expect(flagsNext({ flags: again, items: { '7': open }, only: null, now: LATER })).toMatchObject([
      { do: 'check', stage: 'off', have: 'b'.repeat(40) },
    ]);
    // Before Martin's first move of any flag, the app holds no flag set.
    expect(flagsNext({ flags: told({ dates: '7' }, []), items: { '7': open }, only: null, now: LATER })).toMatchObject([
      { revision: 'none' },
    ]);
  });

  it('checks at Checks against the latest baseline with both schemes, as the hold counted, over a later one without', () => {
    const page = (scheme: 'light' | 'dark') => ({ page: '/', route: '/', scheme, off: '1'.repeat(64) });
    const both = check('7', {
      stage: 'off',
      version: 'a'.repeat(40),
      journeys: { passed: 3, ran: 4 },
      notClean: [],
      pages: [page('light'), page('dark')],
    });
    const lightOnly = check('7', {
      stage: 'off',
      version: 'b'.repeat(40),
      journeys: { passed: 3, ran: 4 },
      notClean: [],
      pages: [page('light')],
    });
    const staged = told({ dates: '7' }, [
      {
        type: 'flag.staged',
        seq: String(++seq),
        ts: '2026-10-27T10:00:00.000Z',
        flag: 'dates',
        workItem: '7',
        from: OFF,
        to: CHECKS,
        revision: 'r5',
      },
    ]);
    const next = (checked: StoredFlagCheck[]) =>
      flagsNext({ flags: { ...staged, checked }, items: { '7': open }, only: null, now: LATER });
    expect(next([both, lightOnly])).toMatchObject([{ do: 'check', stage: 'checks', base: both }]);
    // With none in both schemes, the latest.
    expect(next([lightOnly])).toMatchObject([{ do: 'check', stage: 'checks', base: lightOnly }]);
  });

  it('takes no baseline of a closed work item, a sample, a defect, or a flag turned off on its own work item', () => {
    const flags = told({ dates: '7' }, []);
    for (const item of [
      { ...open, closed: true },
      { ...open, sample: true },
      { ...open, improvement: false },
    ]) {
      expect(flagsNext({ flags, items: { '7': item }, only: null, now: LATER })).toEqual([]);
    }
    expect(flagsNext({ flags, items: { '7': open }, only: '8', now: LATER })).toEqual([]);
    const turnedOff = told({ dates: '7' }, [
      staged('dates', '7', OFF, CHECKS),
      staged('dates', '7', CHECKS, OFF, 'No'),
    ]);
    expect(flagsNext({ flags: turnedOff, items: { '7': open }, only: null, now: LATER })).toMatchObject([
      { do: 'close' },
    ]);
    // Turned off on an earlier improvement, and named by this one's spec: this one's baseline.
    const reused = told({ dates: '9' }, [staged('dates', '7', CHECKS, OFF, 'No')]);
    expect(
      flagsNext({ flags: reused, items: { '7': { ...open, closed: true }, '9': open }, only: null, now: LATER }),
    ).toMatchObject([{ do: 'check', stage: 'off', workItem: '9', move: reused.records[0]?.seq }]);
  });

  it('checks a flag at Checks and at Preview once for each move there, against the latest baseline', () => {
    const toChecks = staged('dates', '7', OFF, CHECKS);
    const base = baseline();
    const flags = told({ dates: '7' }, [toChecks], { checked: [base], revision: 'r9' });
    expect(flagsNext({ flags, items: { '7': open }, only: null, now: LATER })).toEqual([
      {
        do: 'check',
        flag: 'dates',
        workItem: '7',
        stage: 'checks',
        revision: 'r9',
        move: toChecks.seq,
        moveRevision: toChecks.revision,
        base,
        pages: ['/'],
      },
    ]);
    // A check that names an earlier move is none of this one's, however late it came.
    const stale = { ...flags, checked: [base, check('7', { stage: 'checks', moveRevision: 'r0' })] };
    expect(flagsNext({ flags: stale, items: { '7': open }, only: null, now: LATER })).toMatchObject([
      { stage: 'checks' },
    ]);
    const done = { ...flags, checked: [base, check('7', { stage: 'checks', moveRevision: toChecks.revision })] };
    expect(flagsNext({ flags: done, items: { '7': open }, only: null, now: LATER })).toEqual([]);
    // Preview is a move of its own; a check at Checks before it is not one at Preview.
    const toPreview = staged('dates', '7', CHECKS, PREVIEW);
    const previewed = { ...done, records: [toChecks, toPreview] };
    expect(flagsNext({ flags: previewed, items: { '7': open }, only: null, now: LATER })).toMatchObject([
      { do: 'check', stage: 'preview', move: toPreview.seq, base },
    ]);
    // Back to Checks from Preview: checked again, as it is a move.
    const back = { ...previewed, records: [toChecks, toPreview, staged('dates', '7', PREVIEW, CHECKS)] };
    expect(flagsNext({ flags: back, items: { '7': open }, only: null, now: LATER })).toMatchObject([
      { stage: 'checks' },
    ]);
    // Another improvement's baseline, which reused the flag's name, is none of this one's.
    const theirs = told({ dates: '7' }, [toChecks], { checked: [{ ...base, workItem: '6' }] });
    expect(flagsNext({ flags: theirs, items: { '7': open }, only: null, now: LATER })).toMatchObject([{ base: null }]);
    // With no baseline, it is still checked, against none.
    expect(
      flagsNext({ flags: told({ dates: '7' }, [toChecks]), items: { '7': open }, only: null, now: LATER }),
    ).toMatchObject([{ stage: 'checks', base: null }]);
  });
});

describe('the flag.checked the pass records', () => {
  const shot = (fill: string): Screenshot => ({
    kind: 'screenshot',
    hash: fill.repeat(64),
    type: 'image/png',
    size: 100,
    route: '/',
    version: 'b'.repeat(40),
    width: 1280,
    height: 1600,
    boxes: [],
  });
  const base: StoredFlagCheck = {
    seq: '5',
    ts: '2026-10-27T10:00:00.000Z',
    workItem: '7',
    check: {
      stage: 'off',
      flag: 'dates',
      version: 'a'.repeat(40),
      revision: 'r1',
      journeys: { passed: 9, ran: 10 },
      notClean: [{ sense: 'probe', check: 'search', route: '/search', failed: true }],
      pages: [
        { page: '/', route: '/', scheme: 'light', off: '1'.repeat(64) },
        { page: '/', route: '/', scheme: 'dark', off: '4'.repeat(64) },
      ],
    },
  };
  const asked = (stage: 'off' | 'checks' | 'preview', withBase = true): CheckAsked => ({
    flag: 'dates',
    workItem: '7',
    stage,
    revision: 'r2',
    move: '6',
    base: stage !== 'off' && withBase ? base : null,
    pages: ['/'],
  });
  const answer = (more: Partial<Checked> = {}): Checked => ({
    kind: 'checked',
    version: 'b'.repeat(40),
    revision: 'r2',
    journeys: { passed: 10, ran: 10 },
    notClean: [],
    regressions: [],
    device: { allowed: [], kept: [] },
    pages: [
      { path: '/', scheme: 'light', route: '/', off: shot('1'), on: shot('2'), changed: 0.04, diff: shot('3') },
      { path: '/', scheme: 'dark', route: '/', off: shot('4'), on: shot('4'), changed: 0 },
    ],
    ...more,
  });
  const valid = (draft: ReturnType<typeof checkedDraft>) => {
    const event = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: '7',
      version: VERSIONS['flag.checked'],
      ...draft,
    };
    expect(validate({ ...event, artifacts: draft.artifacts ?? [] })).toEqual({ ok: true });
    return draft;
  };

  it('asks the probes with the baseline’s checks and pictures', () => {
    expect(requestOf(asked('checks'))).toEqual({
      flag: 'dates',
      stage: 'checks',
      revision: 'r2',
      pages: ['/'],
      base: {
        version: 'a'.repeat(40),
        notClean: [{ sense: 'probe', check: 'search', route: '/search', failed: true }],
        pictures: [
          { path: '/', scheme: 'light', hash: '1'.repeat(64) },
          { path: '/', scheme: 'dark', hash: '4'.repeat(64) },
        ],
      },
    });
    expect(requestOf(asked('checks', false)).base).toBeNull();
    expect(requestOf({ ...asked('off'), have: 'a'.repeat(40) })).toEqual({
      flag: 'dates',
      stage: 'off',
      revision: 'r2',
      pages: ['/'],
      have: 'a'.repeat(40),
    });
  });

  it('cuts a long check’s name and message between characters, the name with no mark', () => {
    // An emoji whose two units sit either side of a bare cut: at 119-120 in the name, at 299-300 in the message.
    const check = `${'c'.repeat(119)}🙂 more`;
    const message = `${'m'.repeat(298)}🙂 more`;
    const draft = valid(
      checkedDraft(
        asked('off'),
        answer({
          journeys: { passed: 9, ran: 10 },
          notClean: [{ sense: 'probe', check, route: '/search', failed: true, message }],
        }),
      ),
    );
    expect(draft.payload).toMatchObject({ notClean: [{ check: 'c'.repeat(119), message: `${'m'.repeat(298)}…` }] });
  });

  it('records the baseline as the probes saw it, with its pictures as artifacts', () => {
    const draft = valid(
      checkedDraft(
        asked('off'),
        answer({
          journeys: { passed: 9, ran: 10 },
          notClean: [{ sense: 'probe', check: 'search', route: '/search', failed: true, message: 'No results' }],
          pages: [
            { path: '/', scheme: 'light', route: '/', off: shot('1') },
            { path: '/', scheme: 'dark', route: '/', off: shot('4') },
          ],
        }),
      ),
    );
    expect(draft).toMatchObject({
      summary: `dates with the flag off, on bbbbbbb: 9 of 10 checks passed`,
      payload: {
        stage: 'off',
        notClean: [{ check: 'search', message: 'No results' }],
        pages: [
          { scheme: 'light', off: '1'.repeat(64) },
          { scheme: 'dark', off: '4'.repeat(64) },
        ],
      },
      artifacts: [shot('1'), shot('4')],
    });
  });

  it('passes Checks with nothing regressed, its pictures off, on and where they differ', () => {
    const draft = valid(checkedDraft(asked('checks'), answer()));
    expect(draft).toMatchObject({
      summary: 'dates at Checks: passed',
      payload: {
        stage: 'checks',
        against: 'a'.repeat(40),
        outcome: 'passed',
        journeys: { base: { passed: 9, ran: 10 }, change: { passed: 10, ran: 10 } },
        pages: [
          { page: '/', scheme: 'light', off: '1'.repeat(64), on: '2'.repeat(64), changed: 0.04, diff: '3'.repeat(64) },
          { page: '/', scheme: 'dark', off: '4'.repeat(64), on: '4'.repeat(64), changed: 0 },
        ],
      },
      // Each screenshot once: in dark the page is the same with the flag on as off, and differs nowhere.
      artifacts: [shot('1'), shot('2'), shot('3'), shot('4')],
    });
    expect((draft.payload as { reason?: string }).reason).toBeUndefined();
  });

  it('fails Checks on a regression, the device check’s too, saying why in words', () => {
    const regression = {
      sense: 'probe' as const,
      check: 'home/device',
      route: '/',
      failed: true,
      message: 'The pages left localStorage cart on the device.',
    };
    const draft = valid(checkedDraft(asked('checks'), answer({ regressions: [regression] })));
    expect(draft.payload).toMatchObject({
      outcome: 'failed',
      regressions: [regression],
      reason:
        'A check that passed with the flag off failed twice with it on: home/device, The pages left localStorage cart on the device.',
    });
    const many = Array.from({ length: 10 }, (_, i) => ({ ...regression, check: `probe-${i}/device` }));
    expect(valid(checkedDraft(asked('checks'), answer({ regressions: many }))).payload).toMatchObject({ more: 2 });
  });

  it('is unsure of a regression when the baseline named fewer of its failing checks than failed', () => {
    const regression = { sense: 'probe' as const, check: 'home', route: '/', failed: true };
    const offCheck = base.check as Extract<PayloadOf<'flag.checked'>, { stage: 'off' }>;
    const cut = { ...asked('checks'), base: { ...base, check: { ...offCheck, journeys: { passed: 5, ran: 10 } } } };
    expect(valid(checkedDraft(cut, answer({ regressions: [regression] }))).payload).toMatchObject({
      outcome: 'unsure',
    });
    expect(valid(checkedDraft(cut, answer())).payload).toMatchObject({ outcome: 'passed' });
  });

  it('is unsure of Checks with no baseline', () => {
    const { regressions: _none, ...unbased } = answer();
    const draft = valid(checkedDraft(asked('checks', false), unbased));
    expect(draft).toMatchObject({
      summary: 'dates at Checks: could not tell',
      payload: { outcome: 'unsure', against: null, journeys: { base: null } },
    });
  });

  it('passes Preview only with the preview cookie allowed and nothing else kept', () => {
    const allowed = { allowed: ['cookie preview'], kept: [] };
    expect(valid(checkedDraft(asked('preview'), answer({ device: allowed }))).payload).toMatchObject({
      stage: 'preview',
      outcome: 'passed',
      device: allowed,
    });
    expect(valid(checkedDraft(asked('preview'), answer())).payload).toMatchObject({
      outcome: 'failed',
      reason: 'The app kept no preview cookie when a probe asked to preview the flag',
    });
    const broken = { allowed: [], kept: ['cookie preview (readable by a script)'] };
    expect(valid(checkedDraft(asked('preview'), answer({ device: broken }))).payload).toMatchObject({
      outcome: 'failed',
      reason: 'The preview cookie breaks its contract: readable by a script',
    });
    // Something else kept that the baseline did not keep is a regression of the device check.
    const regression = { sense: 'probe' as const, check: 'home/device', route: '/', failed: true };
    expect(
      valid(checkedDraft(asked('preview'), answer({ device: allowed, regressions: [regression] }))).payload,
    ).toMatchObject({ outcome: 'failed' });
    // And no baseline to compare with fails on the cookie, or is unsure.
    expect(valid(checkedDraft(asked('preview', false), answer({ device: allowed }))).payload).toMatchObject({
      outcome: 'unsure',
    });
  });
});

describe('the flag pass, against the store', () => {
  let database: Database;
  let events: EventWriter;
  let now = Date.parse('2026-10-27T09:00:00Z');
  const writer = (sql: Sql) =>
    new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))) });

  beforeEach(async () => {
    database = await freshDatabase('flags');
    events = writer(database.as.line);
    now = Date.parse('2026-10-27T09:00:00Z');
  });
  afterEach(() => database?.end());

  const event = <K extends NewEvent['type']>(
    workItem: string | null,
    type: K,
    payload: PayloadOf<K>,
    actor: NewEvent['actor'] = 'factory',
  ): NewEvent =>
    ({
      id: crypto.randomUUID(),
      ts: new Date(now).toISOString(),
      work_item: workItem,
      type,
      version: VERSIONS[type],
      actor,
      summary: `${type} for the test`,
      payload,
      artifacts: [],
    }) as NewEvent;

  /**
   * An improvement Martin asked for, as the admin service opens it with his request, whose spec, as the line records
   * it, names the flag; or a work item of another kind, as triage opens one; or, with `request: false`, an improvement
   * his command line opened with no request.
   */
  async function improvement(
    flag: string,
    kind: PayloadOf<'work-item.opened'>['kind'] = 'improvement',
    { request = true, pages }: { request?: boolean; pages?: string[] } = {},
  ) {
    const opener = kind !== 'improvement' ? database.as.triage : request ? database.admin : database.operator;
    const workItem = await nextWorkItem(opener === database.operator ? database.as.triage : opener);
    await writer(opener).append([
      event(workItem, 'work-item.opened', { kind, title: 'Delivery dates', sample: false }, 'martin'),
      ...(kind === 'improvement' && request
        ? [event(workItem, 'improvement.requested', { words: 'Delivery dates, please.', steppedUp: true }, 'martin')]
        : []),
    ]);
    await events.append([
      event(
        workItem,
        'spec.written',
        {
          outcome: 'Each product says when it would arrive',
          criteria: [{ given: 'a product page', when: 'it is shown', expect: 'it says when it would arrive' }],
          scope: ['src/pages/product.ts'],
          risks: [],
          rollout: 'Behind its flag',
          flag,
          ...(pages && { pages }),
        },
        'planner',
      ),
    ]);
    return workItem;
  }

  /** Martin's move of a flag, as the admin service appends it. */
  const move = (workItem: string, flag: string, from: Stage | null, to: Stage, reason?: string, sql = database.admin) =>
    writer(sql).append([
      event(
        workItem,
        'flag.staged',
        {
          flag,
          from,
          to,
          action: to.stage === 'off' ? 'flag.off' : from?.stage === 'off' ? 'flag.to-checks' : 'flag.widen',
          revision: `r${++seq}`,
          ...(reason && { reason }),
          steppedUp: false,
        },
        'martin',
      ),
    ]);

  const line = (options: Partial<LineOptions> = {}) => {
    const it = new Line({
      sql: database.as.line,
      events,
      steps: new FakeSteps(database.as.gateway, {}),
      github: new FakeGitHub(),
      log: quiet,
      me: 'test',
      now: () => new Date(now),
      ...options,
    });
    return {
      pass: async () => {
        await it.tick();
        await it.idle();
      },
    };
  };

  const closes = (workItem: string) =>
    database.owner<{ actor: string; appended_by: string; summary: string; payload: PayloadOf<'work-item.closed'> }[]>`
      select actor, appended_by, summary, payload from events
      where work_item = ${workItem} and type = 'work-item.closed' order by seq`;

  it('closes an improvement turned off as turned off, with Martin’s reason, once', async () => {
    const workItem = await improvement('dates');
    await move(workItem, 'dates', OFF, CHECKS);
    await move(workItem, 'dates', CHECKS, PREVIEW);
    const { pass } = line();
    await pass();
    expect(await closes(workItem)).toEqual([]);

    await move(workItem, 'dates', PREVIEW, OFF, 'The date is wrong on Sundays');
    now += 30_000;
    await pass();
    expect(await closes(workItem)).toEqual([
      {
        actor: 'factory',
        appended_by: 'factory_line',
        summary: 'Closed: Martin turned dates off, from Preview',
        payload: { outcome: 'turned-off', reason: 'The date is wrong on Sundays' },
      },
    ]);
    now += 30_000;
    await pass();
    expect(await closes(workItem)).toHaveLength(1);
  });

  it('closes the issue of an improvement turned off as not planned, saying why, before the work item', async () => {
    const workItem = await improvement('dates');
    await database.owner`insert into line (work_item, stage, issue) values (${workItem}, 'ended', 41)`;
    await move(workItem, 'dates', CHECKS, OFF, 'Not on Sundays, ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    const github = new FakeGitHub();
    github.failing.set('closeIssue', 1);
    const { pass } = line({ github });
    await pass();
    // GitHub failed: nothing is closed, and the next pass tries again.
    expect(await closes(workItem)).toEqual([]);
    now += 30_000;
    await pass();
    const closing = github.acts.filter((a) => a.action === 'closeIssue');
    expect(closing).toEqual([
      {
        action: 'closeIssue',
        args: {
          number: 41,
          reason: 'not_planned',
          comment: expect.stringMatching(/^Martin turned `dates` off, from Checks: Not on Sundays, (?!ghp_)/),
        },
      },
    ]);
    expect(String(closing[0]?.args.comment)).toContain(
      `The change stays in the app, behind its flag, off. The factory’s improvement #${workItem} is closed.`,
    );
    expect((await closes(workItem)).map((c) => c.payload.outcome)).toEqual(['turned-off']);
  });

  it('leaves out, and logs once, an improvement Martin did not ask for that a flag was staged on', async () => {
    const workItem = await improvement('unasked', 'improvement', { request: false });
    await move(workItem, 'unasked', CHECKS, OFF, 'Off');
    const logged: string[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => logged.push(line) });
    const { pass } = line({ log });
    await pass();
    now += 30_000;
    await pass();
    expect(await closes(workItem)).toEqual([]);
    const left = logged.filter((line) => line.includes('Martin did not ask for'));
    expect(left).toHaveLength(1);
    expect(JSON.parse(left[0] ?? '{}')).toMatchObject({ workItem });
  });

  it('closes one turned off from Everyone too, which may still go straight back on, and closes nothing more', async () => {
    const workItem = await improvement('wrap');
    await move(workItem, 'wrap', SHARE, EVERYONE);
    await move(workItem, 'wrap', EVERYONE, OFF, 'Wrapped the wrong way');
    const { pass } = line();
    await pass();
    expect((await closes(workItem)).map((c) => c.payload.outcome)).toEqual(['turned-off']);
    // Back on from Everyone after it closed, then off again: the work item is closed, and stays closed once.
    await move(workItem, 'wrap', OFF, EVERYONE);
    await move(workItem, 'wrap', EVERYONE, OFF, 'Still the wrong way');
    now += 30_000;
    await pass();
    expect(await closes(workItem)).toHaveLength(1);
  });

  it('closes an improvement at Everyone as verified once the app has had its minute, and its issue as completed', async () => {
    const workItem = await improvement('wrap');
    await database.owner`insert into line (work_item, stage, issue) values (${workItem}, 'ended', 42)`;
    await move(workItem, 'wrap', SHARE, EVERYONE);
    const github = new FakeGitHub();
    const { pass } = line({ github });
    await pass();
    expect(await closes(workItem)).toEqual([]);
    now += 60_000;
    await pass();
    expect(await closes(workItem)).toEqual([
      {
        actor: 'factory',
        appended_by: 'factory_line',
        summary: 'Closed: wrap is on for everyone',
        payload: {
          outcome: 'verified',
          reason: "Martin widened wrap to Everyone, after Verify's comparison at Share passed",
        },
      },
    ]);
    expect(github.acts.filter((a) => a.action === 'closeIssue')).toEqual([
      {
        action: 'closeIssue',
        args: {
          number: 42,
          reason: 'completed',
          comment: expect.stringMatching(/^Martin widened `wrap` to Everyone: it is on for every visitor/),
        },
      },
    ]);
    // The flag stays Martin's: off, and back on, on the closed improvement, close nothing more.
    await move(workItem, 'wrap', EVERYONE, OFF, 'Wrapped the wrong way');
    now += 30_000;
    await pass();
    await move(workItem, 'wrap', OFF, EVERYONE);
    now += 90_000;
    await pass();
    expect((await closes(workItem)).map((c) => c.payload.outcome)).toEqual(['verified']);
    expect(github.acts.filter((a) => a.action === 'closeIssue')).toHaveLength(1);
  });

  it('closes nothing at Everyone whose latest pull request is a dry run’s', async () => {
    const workItem = await improvement('dry');
    await events.append([
      event(
        workItem,
        'pull-request.pushed',
        {
          number: 1_000_000_001,
          title: 'feat: dates',
          branch: 'factory/dry',
          attempt: 1,
          testsFirst: true,
          files: [{ path: 'src/dates.ts', added: 1, removed: 0 }],
          whole: [],
        },
        'coder',
      ),
    ]);
    await move(workItem, 'dry', SHARE, EVERYONE);
    now += 60_000;
    await line().pass();
    expect(await closes(workItem)).toEqual([]);
  });

  it('closes nothing at Everyone for a move a role not Martin’s appended', async () => {
    const workItem = await improvement('forged');
    await database.owner`alter table events disable row level security`;
    try {
      await move(workItem, 'forged', SHARE, EVERYONE, undefined, database.as.line);
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    now += 60_000;
    await line().pass();
    expect(await closes(workItem)).toEqual([]);
  });

  it('reads the flags no oftener than every thirty seconds', async () => {
    const workItem = await improvement('soon');
    const { pass } = line();
    await pass();
    await move(workItem, 'soon', CHECKS, OFF, 'Not yet');
    now += 10_000;
    await pass();
    expect(await closes(workItem)).toEqual([]);
    now += 20_000;
    await pass();
    expect(await closes(workItem)).toHaveLength(1);
  });

  it('ignores a move a role not Martin’s appended', async () => {
    const workItem = await improvement('forged');
    // Row security refuses it from the line's role; were that guard to fail, the pass would still not believe it.
    await database.owner`alter table events disable row level security`;
    try {
      await move(workItem, 'forged', CHECKS, OFF, 'Forged', database.as.line);
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    await line().pass();
    expect(await closes(workItem)).toEqual([]);
    expect((await flagEvents(database.as.line)).records).toEqual([]);
  });

  it('takes a flag’s pages from the spec that names it last, which may name none', async () => {
    await improvement('dates', 'improvement', { pages: ['/products/blue-mug'] });
    const later = await improvement('dates');
    const { named, pages } = await flagEvents(database.as.line);
    expect(named.dates).toBe(later);
    expect(pages).toEqual({});
  });

  it('names a flag only for an improvement Martin asked for, with the pages its spec names', async () => {
    const asked = await improvement('dates', 'improvement', { pages: ['/products/blue-mug'] });
    await improvement('plain');
    // His command line's improvement with no request, and one a worker opened before row security refused it.
    await improvement('unasked', 'improvement', { request: false });
    const forged = await nextWorkItem(database.as.triage);
    await database.owner`alter table events disable row level security`;
    try {
      await writer(database.as.triage).append([
        event(forged, 'work-item.opened', { kind: 'improvement', title: 'Forged', sample: false }, 'martin'),
        event(forged, 'improvement.requested', { words: 'Forged.', steppedUp: true }, 'martin'),
      ]);
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    await events.append([
      event(
        forged,
        'spec.written',
        {
          outcome: 'Forged',
          criteria: [{ given: 'a page', when: 'it is shown', expect: 'it is forged' }],
          scope: ['src/pages/product.ts'],
          risks: [],
          rollout: 'Behind its flag',
          flag: 'forged',
        },
        'planner',
      ),
    ]);
    const { named, pages } = await flagEvents(database.as.line);
    expect(Object.keys(named).sort()).toEqual(['dates', 'plain']);
    expect(named.dates).toBe(asked);
    expect(pages).toEqual({ dates: ['/products/blue-mug'] });
  });

  it('closes nothing but an improvement', async () => {
    const workItem = await improvement('fix', 'defect-fix');
    await move(workItem, 'fix', CHECKS, OFF, 'Not an improvement');
    await line().pass();
    expect(await closes(workItem)).toEqual([]);
  });

  it('with just one, acts on that work item alone', async () => {
    const one = await improvement('one');
    const other = await improvement('other');
    await move(one, 'one', CHECKS, OFF, 'This one');
    await move(other, 'other', CHECKS, OFF, 'The other');
    await line({ only: one }).pass();
    expect(await closes(one)).toHaveLength(1);
    expect(await closes(other)).toEqual([]);
  });

  it('judges the flags in a dry run too', async () => {
    const workItem = await improvement('dry');
    await move(workItem, 'dry', CHECKS, OFF, 'Off in a dry run');
    await line({ dryRun: true }).pass();
    expect(await closes(workItem)).toHaveLength(1);
  });

  describe('comparing a flag at Share', () => {
    const MINUTE = 60_000;
    /** Past the minute the app has to hold the move, and the window the comparison needs. */
    const enough = (1 + RELEASE.flags.windowMinutes + 1) * MINUTE;

    /**
     * Prometheus, as the line asks it for the generator's figures: each id five requests a second shared by 101, for
     * as long as each piece asked for, all fast; the ids `worse` names answer a tenth of them 5xx.
     */
    function prometheus(worse: readonly string[] = []) {
      const asked: { seconds: number; at: number }[] = [];
      const fake = {
        async instant(query: string, at?: Date): Promise<Sample[]> {
          const seconds = Number(/\[(\d+)s\]/.exec(query)?.[1]);
          asked.push({ seconds, at: at?.getTime() ?? Number.NaN });
          const each = (seconds * RELEASE.traffic.requestsPerSecond) / 101;
          return Array.from({ length: 101 }, (_, i) => `traffic-${String(i).padStart(3, '0')}`).flatMap((id) => {
            const errors = worse.includes(id) ? each / 10 : 0;
            const bucket = (status_class: string, le: string, value: number) => ({
              labels: { share_id: id, status_class, le },
              value,
            });
            return [
              bucket('2xx', '0.1', each - errors),
              bucket('2xx', '+Inf', each - errors),
              ...(errors ? [bucket('5xx', '0.1', errors), bucket('5xx', '+Inf', errors)] : []),
            ];
          });
        },
      };
      return { fake: fake as unknown as Prometheus, asked };
    }

    const compared = (workItem: string) =>
      database.owner<{ actor: string; appended_by: string; summary: string; payload: PayloadOf<'flag.compared'> }[]>`
        select actor, appended_by, summary, payload from events
        where work_item = ${workItem} and type = 'flag.compared' order by seq`;

    /** A release in the line's record, on the line. */
    const released = (type: 'release.started' | 'release.promoted', id: string, dryRun = false, watched = true) =>
      events.append([
        type === 'release.started'
          ? event(null, type, {
              release: id,
              version: 'v0.9.8',
              previous: 'v0.9.7',
              watched,
              steps: null,
              dryRun,
              ...(!dryRun && { image: { digest: `sha256:${'c'.repeat(64)}`, signed: true, admitted: true } }),
            })
          : event(null, type, { release: id, version: 'v0.9.8', previous: 'v0.9.7', watched: true, dryRun }),
      ]);

    /** An improvement at Share 50%, moved there now. */
    async function atShare(flag: string) {
      const workItem = await improvement(flag);
      await move(workItem, flag, OFF, CHECKS);
      await move(workItem, flag, CHECKS, SHARE);
      return { workItem, movedAt: now };
    }

    it('waits for the window, then compares once, passed, from a minute after Martin’s move', async () => {
      const { workItem, movedAt } = await atShare('dates');
      const { fake, asked } = prometheus();
      const { pass } = line({ verify: { prometheus: fake } });
      now += enough - 2 * MINUTE;
      await pass();
      expect(await compared(workItem)).toEqual([]);
      expect(asked).toEqual([]);

      now += 2 * MINUTE;
      await pass();
      const [one, ...more] = await compared(workItem);
      expect(more).toEqual([]);
      expect(one).toMatchObject({
        actor: 'factory',
        appended_by: 'factory_line',
        summary: 'dates at Share 50%: flag on against off passed',
        payload: {
          flag: 'dates',
          share: 50,
          window: { from: new Date(movedAt + MINUTE).toISOString(), to: new Date(now).toISOString() },
          setAsideMinutes: 0,
          outcome: 'passed',
          sides: { on: { errorRate: 0, p99Ms: 99 }, off: { errorRate: 0, p99Ms: 99 } },
        },
      });
      expect(one?.payload.reason).toBeUndefined();
      const sides = sidesOf('dates', 50);
      expect(one?.payload.sides.on.requests).toBe(Math.round(((enough - MINUTE) / 1000) * 5 * (sides.on.length / 101)));
      expect(asked).toEqual([{ seconds: (enough - MINUTE) / 1000, at: now }]);

      now += 30_000;
      await pass();
      expect(await compared(workItem)).toHaveLength(1);
    });

    it('fails a side with more errors, with the reason in words', async () => {
      const { workItem } = await atShare('dates');
      const { fake } = prometheus(sidesOf('dates', 50).on);
      now += enough;
      await line({ verify: { prometheus: fake } }).pass();
      expect(await compared(workItem)).toMatchObject([
        {
          summary: 'dates at Share 50%: flag on against off failed',
          payload: { outcome: 'failed', reason: 'Errors 10.00% with the flag on against 0.00% off' },
        },
      ]);
    });

    it('sets a canary’s time in flight aside, padded by how often the line reads releases, and counts it', async () => {
      const { workItem, movedAt } = await atShare('dates');
      const { fake, asked } = prometheus();
      const { pass } = line({ verify: { prometheus: fake } });
      now += 5 * MINUTE;
      await released('release.started', 'canary-1');
      now += 10 * MINUTE;
      await released('release.promoted', 'canary-1');
      now += enough - 15 * MINUTE;
      await pass();
      // Eleven minutes of the window were a canary's, so it is not yet long enough.
      expect(await compared(workItem)).toEqual([]);

      now += 11 * MINUTE;
      await pass();
      expect(await compared(workItem)).toMatchObject([{ payload: { outcome: 'passed', setAsideMinutes: 11 } }]);
      // One question for each piece: from the minute after the move to the canary's start, padded, and from its
      // promotion, padded, to now.
      expect(asked.slice(-2)).toEqual([
        { seconds: 3.5 * 60, at: movedAt + 4.5 * MINUTE },
        { seconds: (now - movedAt - 15.5 * MINUTE) / 1000, at: now },
      ]);
    });

    it('runs a canary still in flight to now, and leaves out a dry run’s and a version found live', async () => {
      const inFlight = await atShare('dates');
      const { fake } = prometheus();
      now += 5 * MINUTE;
      await released('release.started', 'canary-2');
      now += enough;
      await line({ verify: { prometheus: fake } }).pass();
      expect(await compared(inFlight.workItem)).toEqual([]);

      await released('release.promoted', 'canary-2');
      const dry = await atShare('wraps');
      // Only one flag is at Share at a time; the other is turned off, and closes.
      await move(inFlight.workItem, 'dates', SHARE, OFF, 'Not now');
      await released('release.started', 'dry-1', true);
      // A version found live is recorded started and promoted at once: no canary.
      await released('release.started', 'found-1', false, false);
      await released('release.promoted', 'found-1');
      now += enough;
      await line({ verify: { prometheus: fake } }).pass();
      expect(await compared(dry.workItem)).toMatchObject([{ payload: { outcome: 'passed', setAsideMinutes: 0 } }]);
    });

    it('sets aside each attempt of a retried release, and a retry still in flight runs to now', async () => {
      const { workItem } = await atShare('dates');
      const { fake } = prometheus();
      const { pass } = line({ verify: { prometheus: fake } });
      now += 5 * MINUTE;
      await released('release.started', 'canary-3');
      now += 5 * MINUTE;
      await events.append([
        event(null, 'release.aborted', {
          release: 'canary-3',
          version: 'v0.9.8',
          restored: 'v0.9.7',
          abortedAt: new Date(now).toISOString(),
          by: 'martin',
        }),
      ]);
      now += 10 * MINUTE;
      await released('release.started', 'canary-3');
      now += enough;
      await pass();
      // The retry is still in flight: the window is only what came before it, less the first attempt.
      expect(await compared(workItem)).toEqual([]);
      await released('release.promoted', 'canary-3');
      now += enough;
      await pass();
      // Six minutes for the first attempt and the retry's span for the second, each padded by a minute in all.
      expect(await compared(workItem)).toMatchObject([
        { payload: { outcome: 'passed', setAsideMinutes: 6 + enough / MINUTE + 1 } },
      ]);
    });

    it('waits without Prometheus', async () => {
      const { workItem } = await atShare('dates');
      now += enough;
      await line().pass();
      expect(await compared(workItem)).toEqual([]);
    });
  });

  describe('checking a flag with the probes', () => {
    const V1 = '1'.repeat(40);
    const V2 = '2'.repeat(40);
    const shot = (fill: string, version: string): Screenshot => ({
      kind: 'screenshot',
      hash: fill.repeat(64),
      type: 'image/png',
      size: 100,
      route: '/',
      version,
      width: 1280,
      height: 1600,
      boxes: [],
    });

    /**
     * The probes worker, answering each flag's check as the app stands: the version it runs, and whether it holds the
     * flag set asked for. Each answer comes on the second ask, as a run takes longer than a pass; the pictures it takes
     * are in the index, as the probes worker records them.
     */
    function probes() {
      const app = { version: V1, holds: true, regress: false };
      const asked: FlagCheckRequest[] = [];
      const running = new Set<string>();
      const index = new PictureIndex(database.as.probes);
      let fill = 0;
      const port: FlagChecksPort = {
        async flagCheck(request) {
          asked.push(request);
          const key = JSON.stringify(request);
          if (!running.has(key)) {
            running.add(key);
            return null;
          }
          running.delete(key);
          if (request.have === app.version) return { kind: 'have', version: app.version };
          if (!app.holds) return { kind: 'not-held', version: app.version, message: 'The app holds the flag set r0' };
          const pictures =
            request.stage === 'preview'
              ? []
              : COLOR_SCHEMES.map((scheme) => ({
                  scheme,
                  picture: shot((++fill).toString(16), app.version),
                }));
          for (const { scheme, picture } of pictures) {
            await index.recordFlagPicture({
              flag: request.flag,
              stage: request.stage === 'off' ? 'off' : 'checks',
              revision: request.revision,
              version: app.version,
              path: '/',
              scheme,
              route: '/',
              shot: picture,
              changed: null,
              diff: null,
            });
          }
          const regressions = app.regress
            ? [{ sense: 'probe' as const, check: 'home/device', route: '/', failed: true, message: 'Kept a cookie.' }]
            : [];
          return {
            kind: 'checked',
            version: app.version,
            revision: request.revision,
            journeys: { passed: 4, ran: 5 },
            notClean: [{ sense: 'probe', check: 'search', route: '/search', failed: true }],
            ...(request.stage !== 'off' && request.base && { regressions }),
            device: { allowed: request.stage === 'preview' ? ['cookie preview'] : [], kept: [] },
            pages: pictures.map(({ scheme, picture }) => ({
              path: '/',
              scheme,
              route: '/',
              ...(request.stage === 'off' ? { off: picture } : { on: picture }),
            })),
          };
        },
      };
      return { app, asked, port };
    }

    const checks = (workItem: string) =>
      database.owner<
        { appended_by: string; summary: string; payload: PayloadOf<'flag.checked'>; artifacts: Screenshot[] }[]
      >`
        select appended_by, summary, payload, artifacts from events
        where work_item = ${workItem} and type = 'flag.checked' order by seq`;

    const vouched = () =>
      new EventWriter(database.as.line, { kind: 'real', artifacts: new IndexedArtifacts(database.as.line) });

    it('takes the baseline only at Off, once for each version, and checks Checks against it once for the move', async () => {
      const workItem = await improvement('dates');
      const { app, asked, port } = probes();
      const { pass } = line({ events: vouched(), flagChecks: port });
      const passes = async (n: number) => {
        for (let i = 0; i < n; i++) {
          now += 30_000;
          await pass();
        }
      };
      await passes(2);
      expect(await checks(workItem)).toMatchObject([
        {
          appended_by: 'factory_line',
          summary: 'dates with the flag off, on 1111111: 4 of 5 checks passed',
          payload: {
            stage: 'off',
            version: V1,
            revision: 'none',
            pages: [
              { page: '/', scheme: 'light', off: '1'.repeat(64) },
              { page: '/', scheme: 'dark', off: '2'.repeat(64) },
            ],
          },
          artifacts: [{ hash: '1'.repeat(64) }, { hash: '2'.repeat(64) }],
        },
      ]);
      // The same version again: the probes say so, and nothing more is recorded.
      await passes(4);
      expect(await checks(workItem)).toHaveLength(1);
      expect(asked.at(-1)).toMatchObject({ stage: 'off', have: V1 });
      // A new version: a new baseline.
      app.version = V2;
      await passes(2);
      expect((await checks(workItem)).map((c) => c.payload.version)).toEqual([V1, V2]);

      // At Checks: no baseline more, and one check against the latest.
      await move(workItem, 'dates', OFF, CHECKS);
      await passes(4);
      const recorded = await checks(workItem);
      expect(recorded.map((c) => c.payload.stage)).toEqual(['off', 'off', 'checks']);
      expect(recorded[2]).toMatchObject({
        summary: 'dates at Checks: passed',
        payload: { outcome: 'passed', against: V2, revision: `r${seq}`, journeys: { base: { passed: 4, ran: 5 } } },
      });
      expect(asked.filter((r) => r.stage === 'checks').at(-1)?.base).toMatchObject({
        version: V2,
        notClean: [{ check: 'search' }],
        pictures: [
          { path: '/', scheme: 'light', hash: '3'.repeat(64) },
          { path: '/', scheme: 'dark', hash: '4'.repeat(64) },
        ],
      });
      // Each scheme's page with the flag on.
      expect(recorded[2]?.payload).toMatchObject({ pages: [{ scheme: 'light' }, { scheme: 'dark' }] });
      expect(asked.filter((r) => r.stage === 'off' && r.revision !== 'none')).toEqual([]);
    });

    it('fails a check at Preview on a regression of the device check', async () => {
      const workItem = await improvement('wraps');
      const { app, port } = probes();
      const { pass } = line({ events: vouched(), flagChecks: port });
      for (let i = 0; i < 2; i++, now += 30_000) await pass();
      await move(workItem, 'wraps', OFF, CHECKS);
      await move(workItem, 'wraps', CHECKS, PREVIEW);
      app.regress = true;
      for (let i = 0; i < 2; i++, now += 30_000) await pass();
      expect((await checks(workItem)).at(-1)).toMatchObject({
        summary: 'wraps at Preview: failed',
        payload: { stage: 'preview', outcome: 'failed', device: { allowed: ['cookie preview'] } },
      });
    });

    it('records nothing of a run that did not see the stage, and asks again on the next pass', async () => {
      const workItem = await improvement('dates');
      const { app, asked, port } = probes();
      app.holds = false;
      const { pass } = line({ events: vouched(), flagChecks: port });
      for (let i = 0; i < 4; i++, now += 30_000) await pass();
      expect(await checks(workItem)).toEqual([]);
      expect(asked).toHaveLength(4);
      app.holds = true;
      for (let i = 0; i < 2; i++, now += 30_000) await pass();
      expect(await checks(workItem)).toHaveLength(1);
    });

    it('records nothing of a check Martin moved the flag away from while it ran', async () => {
      const workItem = await improvement('dates');
      const { port } = probes();
      // Martin widens it while the baseline runs: its answer arrives with the flag at Checks, and is not recorded.
      const moving: FlagChecksPort = {
        async flagCheck(request) {
          const answer = await port.flagCheck(request);
          if (answer && request.stage === 'off') await move(workItem, 'dates', OFF, CHECKS);
          return answer;
        },
      };
      const { pass } = line({ events: vouched(), flagChecks: moving });
      await pass();
      now += 30_000;
      await pass();
      expect(await checks(workItem)).toEqual([]);
      expect((await flagEvents(database.as.line)).records).toMatchObject([{ type: 'flag.staged', to: CHECKS }]);
    });

    it('records nothing of a check another flag’s move made stale while it ran', async () => {
      const workItem = await improvement('dates');
      const other = await improvement('wraps');
      const { port } = probes();
      const moving: FlagChecksPort = {
        async flagCheck(request) {
          const answer = await port.flagCheck(request);
          if (answer && request.flag === 'dates') await move(other, 'wraps', OFF, CHECKS);
          return answer;
        },
      };
      const { pass } = line({ events: vouched(), flagChecks: moving });
      await pass();
      now += 30_000;
      await pass();
      expect(await checks(workItem)).toEqual([]);
    });

    it('believes only the line’s checks, and reads the revision of Martin’s latest move of any flag', async () => {
      const workItem = await improvement('dates');
      const off = (sql: Sql) =>
        writer(sql).append([
          event(workItem, 'flag.checked', {
            stage: 'off',
            flag: 'dates',
            version: V1,
            revision: 'none',
            journeys: { passed: 1, ran: 1 },
            notClean: [],
            pages: [],
          }),
        ]);
      await off(database.as.triage);
      expect((await flagEvents(database.as.line)).checked).toEqual([]);
      await off(database.as.line);
      expect((await flagEvents(database.as.line, 'dates')).checked).toMatchObject([
        { workItem, check: { stage: 'off', version: V1 } },
      ]);
      expect((await flagEvents(database.as.line)).revision).toBeNull();
      const other = await improvement('wraps');
      await move(other, 'wraps', OFF, CHECKS);
      // Asked of one flag, the flag set is still the one the latest move of any wrote.
      expect((await flagEvents(database.as.line, 'dates')).revision).toBe(`r${seq}`);
      // A check at Checks is a record a widening waits on, as a comparison is; a baseline lets Checks be taken.
      await writer(database.as.line).append([
        event(other, 'flag.checked', {
          stage: 'checks',
          flag: 'wraps',
          version: V1,
          revision: `r${seq}`,
          moveRevision: `r${seq}`,
          against: null,
          outcome: 'unsure',
          journeys: { base: null, change: { passed: 1, ran: 1 } },
          regressions: [],
          pages: [],
        }),
      ]);
      const { records } = await flagEvents(database.as.line);
      expect(records.filter((r) => r.type === 'flag.checked')).toMatchObject([
        { flag: 'dates', stage: 'off', workItem },
        { flag: 'wraps', stage: 'checks', outcome: 'unsure', moveRevision: `r${seq}` },
      ]);
      expect(flagsFrom(records, { dates: workItem }).dates?.baseline).toBe(true);
      expect(flagsFrom(records).wraps?.checked).toEqual({ stage: 'checks', outcome: 'unsure' });
    });

    it('waits without the probes', async () => {
      const workItem = await improvement('dates');
      await line({ events: vouched() }).pass();
      expect(await checks(workItem)).toEqual([]);
    });
  });
});
