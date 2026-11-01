/**
 * Releases and the Canary panel (the design system's README, "Shipping"): from the samples' releases, on work items
 * and on the line, and from hand-made ones for the steps the samples do not take.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { ACCESS, STEP_UP as STEP_UP_POLICY } from '../../../../policy/access.ts';
import { release as policy } from '../../../../policy/release.ts';
import { DRAWN } from '../../../factory/src/release/read.ts';
import { FRESH_MINUTES, STEP_UP } from '../../web/src/access.ts';
import { deployCaption } from '../../web/src/projection/fixing.ts';
import { project, upTo } from '../../web/src/projection/index.ts';
import { endsRelease, foldItems, stopsRelease } from '../../web/src/projection/items.ts';
import { type Card, timeline } from '../../web/src/projection/reel.ts';
import {
  BACKGROUND,
  canaryView,
  controlsOf,
  type End,
  type Failed,
  failedLooks,
  type LookVerdict,
  lookVerdict,
  MEASURES,
  measuring,
  ownWords,
  pointsOf,
  type Release,
  releases,
  room,
  SERIES_UNITS,
  sawOf,
  versionsAt,
  written,
} from '../../web/src/projection/release.ts';
import { projectSheet } from '../../web/src/projection/sheet.ts';
import { END, SAMPLES, work } from './support.ts';

const at = (iso: string) => Date.parse(iso);
/** The build of one of Martin's commits that rolled back on Monday evening, as v0.9.9 had (the samples' `line.ts`). */
const EVENING = 'efef168f4eec299dfc27c8fc78477ce28379b38d';
/** The build of another that the analysis could not judge on Monday night. */
const NIGHT = 'b72355f99c4273a86f6f29cc9a0fa089c97a7a0f';
const shown = (t: number) => {
  const view = project(SAMPLES, t);
  return { view, canary: view.canary, station: view.stations.find((s) => s.stage === 'release') };
};

describe('the Canary panel, from the samples', () => {
  it('draws the release in flight at the step it is measuring, not the last one measured', () => {
    const { canary, station } = shown(END);
    expect(canary.state).toBe('shown');
    if (canary.state !== 'shown') return;
    expect(canary.release).toMatchObject({ version: 'v0.9.13', weight: 50, step: 1, end: undefined });
    expect(canary.release.items.map((i) => i.number)).toEqual(['1314']);
    expect(canary.release.steps.map((s) => s.weight)).toEqual([25, 50, 100]);
    expect(canary.release.until).toBe(at('2026-10-06T14:24:00Z'));
    // The station works on the canary while a merge waits for its deploy, whose checks run: not Martin's yet.
    expect(station).toMatchObject({ status: 'working', beacon: undefined, figure: '50% · 1 waiting', queued: 1 });
    expect(shown(END).view.panels.release.rows).toContainEqual(
      expect.objectContaining({
        item: '1321',
        note: 'Merged · deploy #1331’s checks running',
        tone: 'faint',
        state: 'waiting',
      }),
    );
  });

  it('draws a release with no work item, and Release counts it and lists it by its version', () => {
    const { view, canary, station } = shown(at('2026-10-06T07:04:00Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({ version: 'v0.9.12', items: [], weight: 50 });
    expect(station).toMatchObject({ status: 'working', figure: '50%' });
    expect(view.panels.release.rows[0]).toMatchObject({
      item: 'v0.9.12',
      release: true,
      note: 'canary at 50%',
      state: 'in-hand',
      working: true,
    });
  });

  it('keeps a promoted release in full until the next starts, while its station reads passed for a quarter of an hour', () => {
    expect(shown(at('2026-10-06T07:10:00Z')).canary).toMatchObject({
      state: 'shown',
      release: { end: { kind: 'promoted' } },
    });
    expect(shown(at('2026-10-06T07:10:00Z')).station?.status).toBe('passing');
    // Long after: the station is idle again, and the panel still draws the release in full.
    expect(shown(at('2026-10-06T08:00:00Z')).station?.status).not.toBe('passing');
    expect(shown(at('2026-10-06T08:00:00Z')).canary).toMatchObject({
      state: 'shown',
      release: { version: 'v0.9.12', end: { kind: 'promoted' } },
    });
  });

  it('links a rollback before any step was measured to the ticket its signal opened', () => {
    const { view, canary } = shown(at('2026-10-05T10:25:00Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({
      version: 'v0.9.9',
      measured: [],
      end: {
        kind: 'rolled-back',
        weight: 25,
        ticket: { number: '1308', title: 'Slow responses in a canary release', how: 'opened' },
      },
    });
    expect(view.panels.release.rows).toContainEqual(
      // Gone from the stage, but held: it takes the held row's rule and icon, after what is in the stage.
      expect.objectContaining({
        item: 'v0.9.9',
        note: 'rolled back at 25% · opened #1308',
        tone: 'attn',
        state: 'held',
        left: true,
      }),
    );
  });

  it('links a later rollback whose signal joined that ticket, still open, to it, saying so', () => {
    const { view, canary } = shown(at('2026-10-05T17:45:00Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({
      version: EVENING,
      end: { kind: 'rolled-back', weight: 25, ticket: { number: '1308', how: 'joined' } },
    });
    expect(view.panels.release.rows).toContainEqual(
      expect.objectContaining({ item: EVENING, note: 'rolled back at 25% · added it to #1308', tone: 'attn' }),
    );
  });

  it('draws the abort the line recorded, when Argo Rollouts acted on it, at the step the canary had reached', () => {
    const { view, canary } = shown(at('2026-10-06T06:40:00Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({
      version: 'v0.9.11',
      end: { kind: 'aborted', by: 'stop', at: at('2026-10-06T06:35:11Z'), weight: 50 },
    });
    expect(view.panels.release.rows[0]).toMatchObject({ item: 'v0.9.11', note: 'stopped with the line at 50%' });
    // Starting the line again does not resume it; Martin's retry does, and his own abort ends it again.
    expect(shown(at('2026-10-06T06:50:30Z')).canary).toMatchObject({ release: { end: { by: 'stop' } } });
    const retried = shown(at('2026-10-06T06:55:00Z')).canary;
    expect(retried.state === 'shown' && retried.release).toMatchObject({
      startedAt: at('2026-10-06T06:51:00Z'),
      end: { kind: 'aborted', by: 'martin', at: at('2026-10-06T06:53:02Z'), weight: 25 },
      retried: [{ kind: 'aborted', by: 'stop', weight: 50 }],
    });
  });

  it('draws an analysis that could not judge the canary as its own end, at the step it could not judge', () => {
    const { canary } = shown(at('2026-10-05T20:15:00Z'));
    if (canary.state !== 'shown') throw new Error('No release shown');
    expect(canary.release).toMatchObject({
      version: NIGHT,
      end: { kind: 'errored', at: at('2026-10-05T20:13:11Z'), weight: 25 },
    });
    expect(canary.release.end?.kind === 'errored' && canary.release.end.errored.map((m) => m.name)).toEqual([
      'enough-requests',
      'errors',
      'latency',
    ]);
  });

  it('draws a dry run as the dry run records it, and never moves the app’s version for it', () => {
    const { canary } = shown(at('2026-10-05T13:09:40Z'));
    expect(canary.state === 'shown' && canary.release).toMatchObject({ dryRun: true, image: undefined, weight: 50 });
    const after = project(SAMPLES, at('2026-10-05T13:30:00Z'));
    expect(after.cards.find((c) => c.number === '1310')?.appVersion).toBe('v0.9.10');
  });

  it('draws one release for a release that carries two work items', () => {
    const one = releases(SAMPLES, [], END).filter((r) => r.id === 'tqntrr4wg7-908');
    expect(one).toHaveLength(1);
    expect(one[0]?.items.map((i) => i.number)).toEqual(['1304', '1306']);
    expect(one[0]?.measured.map((m) => m.weight)).toEqual([25, 50]);
  });

  it('says there is no release before the first', () => {
    expect(shown(at('2026-09-29T08:00:00Z')).canary).toEqual({ state: 'none' });
  });
});

describe('the timeline, from the samples', () => {
  const view = project(SAMPLES, END);
  const { cards, timeline } = view;
  const mark = (version: string) => timeline.versions.find((v) => v.version === version);
  const place = (number: string) => timeline.positions[cards.findIndex((c) => c.number === number)] ?? -1;

  it('marks every version the app was left on, in order, a rollback, an analysis error and a stop struck through', () => {
    expect(timeline.versions.map((v) => (v.rolledBack ? `~${v.version}~` : v.version))).toEqual([
      ...['v0.8.4', 'v0.8.5', 'v0.9.0', '~v0.9.1~', 'v0.9.2', 'v0.9.3', 'v0.9.5', 'v0.9.7', 'v0.9.8'],
      ...['~v0.9.9~', 'v0.9.10', `~${EVENING}~`, `~${NIGHT}~`, '~v0.9.11~', 'v0.9.12'],
    ]);
    const places = timeline.versions.map((v) => v.at);
    expect(places).toEqual([...places].sort((a, b) => a - b));
  });

  it('marks a release with no work item at its time, between the cards either side of it', () => {
    // v0.9.9 rolled back after v0.9.8 shipped #1304 and before v0.9.10 shipped #1306, though #1306 opened before it.
    expect(mark('v0.9.9')).toMatchObject({ card: undefined });
    expect(mark('v0.9.9')?.at).toBeGreaterThan(place('1304'));
    expect(mark('v0.9.9')?.at).toBeLessThan(place('1306'));
    // v0.9.11 and v0.9.12 went out on Tuesday morning, before #1314 opened, each in a place of its own.
    const tuesday = timeline.days.at(-1)?.at ?? 0;
    for (const version of ['v0.9.11', 'v0.9.12']) {
      expect(mark(version)?.at).toBeGreaterThanOrEqual(tuesday);
      expect(mark(version)?.at).toBeLessThan(place('1314'));
    }
    expect(mark('v0.9.11')?.at).toBeLessThan(mark('v0.9.12')?.at ?? 0);
    const alone = releases(SAMPLES, [], END).filter((r) => r.end && !r.dryRun && !r.items.length);
    expect(alone.map((r) => r.version)).toEqual(['v0.9.9', EVENING, NIGHT, 'v0.9.11', 'v0.9.12']);
    expect(new Set([...timeline.positions, ...timeline.versions.map((v) => v.at)]).size).toBe(
      cards.length + alone.length,
    );
  });

  it('marks a release under the first card whose latest release it is, whatever came of the card since', () => {
    // v0.9.8 carried #1304 and #1306; #1306 went again in v0.9.10, and has been sent back to Plan since.
    expect(mark('v0.9.8')?.card).toBe(cards.findIndex((c) => c.number === '1304'));
    expect(mark('v0.9.10')?.card).toBe(cards.findIndex((c) => c.number === '1306'));
  });

  it('spans a card width for each step between marks, and half one more between days', () => {
    // The window the console shows of the timeline gives each card width the same room: the closest two marks are one
    // apart, and the whole is as many apart as there are marks after the first and half one for each day after the first.
    const places = [...timeline.positions, ...timeline.versions.filter((v) => v.card === undefined).map((v) => v.at)];
    const steps = places.sort((a, b) => a - b).flatMap((p, i) => (i ? [p - (places[i - 1] ?? 0)] : []));
    expect(Math.min(...steps) * timeline.span).toBeCloseTo(1);
    expect(timeline.span).toBeCloseTo(places.length - 1 + (timeline.days.length - 1) * 0.5);
  });

  it('marks nothing for a dry run, or for a release still in flight', () => {
    const dryRun = releases(SAMPLES, [], END).find((r) => r.dryRun);
    expect(dryRun?.end?.kind).toBe('promoted');
    expect(timeline.versions.map((v) => v.version)).not.toContain(dryRun?.version);
    expect(mark('v0.9.13')).toBeUndefined();
  });

  it('agrees with the line under it: a work item done with is on the last version marked by its place', () => {
    // An open work item's line says the version the app is on now.
    const open = new Set(['in-progress', 'waiting', 'needs-you', 'held']);
    for (const [i, card] of cards.entries()) {
      if (open.has(card.outcome)) continue;
      const kept = timeline.versions.filter((v) => !v.rolledBack && v.at <= (timeline.positions[i] ?? 0)).at(-1);
      expect([card.number, card.appVersion]).toEqual([card.number, kept?.version]);
    }
  });
});

describe('the timeline, from hand-made releases', () => {
  const hour = 3_600_000;
  const monday = at('2026-10-05T09:00:00Z');
  const card = (number: string, hours: number) => ({ number, startedAt: monday + hours * hour }) as Card;
  const shipped = (version: string, items: string[], hours: number, kind = 'promoted') =>
    ({
      version,
      items: items.map((number) => ({ number })),
      dryRun: false,
      end: { kind, at: monday + hours * hour },
    }) as Release;
  const marks = (cards: Card[], all: Release[]) => {
    const { positions, versions } = timeline(cards, all);
    return [
      ...cards.map((c, i) => ({ name: c.number, at: positions[i] ?? -1 })),
      ...versions.map((v) => ({ name: v.rolledBack ? `~${v.version}~` : v.version, at: v.at })),
    ]
      .sort((a, b) => a.at - b.at)
      .map((m) => m.name);
  };

  it('gives a release whose work item went again in a later one a place of its own, at its time', () => {
    const cards = [card('1', 0), card('2', 5)];
    const all = [shipped('v1', ['1'], 1, 'rolled-back'), shipped('v2', ['1'], 2)];
    expect(marks(cards, all)).toEqual(['~v1~', '1', 'v2', '2']);
    // And one whose work items are on no card, as if it carried none.
    expect(marks(cards, [...all, shipped('v3', ['9'], 6)])).toEqual(['~v1~', '1', 'v2', '2', 'v3']);
  });

  it('gives a card’s release a place of its own when it shipped before an earlier card’s', () => {
    // #1 started first and shipped v2 after #2 shipped v1.
    const cards = [card('1', 0), card('2', 1)];
    expect(marks(cards, [shipped('v1', ['2'], 2), shipped('v2', ['1'], 3)])).toEqual(['v1', '1', 'v2', '2']);
    // v1 carried both, and v2 carried #1 again.
    expect(marks(cards, [shipped('v1', ['1', '2'], 2), shipped('v2', ['1'], 3)])).toEqual(['v1', '1', 'v2', '2']);
  });

  it('keeps an attempt’s mark while its retry is in flight', () => {
    const retry = {
      ...shipped('v1', ['1'], 1, 'rolled-back'),
      end: undefined,
      retried: [{ kind: 'rolled-back', at: monday + hour }],
    };
    expect(marks([card('1', 0)], [retry as Release])).toEqual(['1', '~v1~']);
  });

  it('keeps the versions in the order the app’s changed, where a card shipped after one that started later', () => {
    // #1 started first and shipped last; #2 started before the release with no work item, and has not shipped.
    const cards = [card('1', 0), card('2', 1)];
    expect(marks(cards, [shipped('v1', [], 2), shipped('v2', ['1'], 3)])).toEqual(['v1', '1', 'v2', '2']);
  });
});

describe('a release’s steps', () => {
  const started = (steps: PayloadOf<'release.started'>['steps']): PayloadOf<'release.started'> => ({
    release: 'r1',
    version: 'v1.0.1',
    previous: 'v1.0.0',
    image: { digest: `sha256:${'b'.repeat(64)}`, signed: true, admitted: true },
    watched: true,
    steps,
    dryRun: false,
  });
  const stepped = (weight: number): PayloadOf<'canary.stepped'> => ({
    release: 'r1',
    version: 'v1.0.1',
    weight,
    analysis: { phase: 'successful', requests: 225, measures: [] },
    dryRun: false,
  });

  it('moves past a step the analysis does not judge when its pause runs out', () => {
    const one = work('1')
      .open()
      .add(
        1,
        'release.started',
        'rollouts',
        started([
          { weight: 10, pauseSeconds: 120, analysis: false },
          { weight: 50, pauseSeconds: null, analysis: true },
        ]),
      );
    expect(releases(one.events, [], one.at(2))[0]).toMatchObject({ step: 0, weight: 10, until: one.at(3) });
    // Past the pause, at a step that waits for someone: no end to wait for.
    expect(releases(one.events, [], one.at(4))[0]).toMatchObject({ step: 1, weight: 50, until: undefined });
  });

  const rolledBack: PayloadOf<'release.rolled-back'> = {
    release: 'r1',
    version: 'v1.0.1',
    restored: 'v1.0.0',
    weight: 25,
    reason: 'Metric "errors" assessed Failed',
    failed: [],
    dryRun: false,
    by: 'analysis',
  };
  const twoSteps = [
    { weight: 25, pauseSeconds: 180, analysis: true },
    { weight: 50, pauseSeconds: 180, analysis: true },
  ];

  it('lists a merge waiting for a deploy as Martin’s once its checks pass, and after a rollback as waiting for his retry or next', () => {
    const deploy = { stage: 'release', kind: 'approval', cause: 'deploy', reason: 'Waits for a deploy' } as const;
    const changed = (state: 'checking' | 'passed') => ({ pullRequest: 40, commit: 'd'.repeat(40), state });
    const one = work('1')
      .open()
      .add(1, 'pull-request.merged', 'martin', { number: 2, commit: 'b'.repeat(40), by: 'martin' })
      .add(1, 'hold.started', 'factory', deploy)
      .add(2, 'deploy.changed', 'factory', changed('passed'));
    const note = (t: number) => project(one.events, t).panels.release.rows.find((r) => r.item === '1')?.note;
    expect(note(one.at(1))).toBe('Merged · waiting for its deploy pull request');
    expect(note(one.at(2))).toBe('Needs you · waiting for Martin’s deploy');
    one
      .add(3, 'release.started', 'rollouts', started(twoSteps))
      .add(6, 'release.rolled-back', 'rollouts', rolledBack)
      .add(6, 'hold.started', 'factory', deploy);
    // The release that carries it ends the wait.
    expect(note(one.at(4))).not.toMatch(/^Needs you/);
    // Held again, it waits for Martin: his retry of the release carries it on, as another deploy would.
    expect(note(one.at(6))).toBe('Needs you · rolled back, waiting for Martin’s retry or next deploy');
    one.add(7, 'deploy.changed', 'factory', changed('checking'));
    expect(note(one.at(7))).toBe('Needs you · rolled back, waiting for Martin’s retry or next deploy');
    one.add(7, 'deploy.changed', 'factory', changed('passed'));
    expect(note(one.at(7))).toBe('Needs you · rolled back, waiting for Martin’s retry or next deploy');
    // The card and the sheet say so too, with the release that rolled back.
    const picture = (t: number) => project(one.events, t).cards.find((c) => c.number === '1')?.picture;
    expect(picture(one.at(2))).toMatchObject({ type: 'deploy', ended: undefined });
    expect(picture(one.at(7))).toMatchObject({ type: 'deploy', ended: { version: 'v1.0.1', stopped: undefined } });
    // A new fix, merged after the rollback, waits for a deploy as the first did.
    one
      .add(8, 'pull-request.merged', 'martin', { number: 3, commit: 'c'.repeat(40), by: 'martin' })
      .add(8, 'hold.started', 'factory', deploy)
      .add(9, 'deploy.changed', 'factory', changed('passed'));
    expect(note(one.at(9))).toBe('Needs you · waiting for Martin’s deploy');
    expect(picture(one.at(9))).toMatchObject({ type: 'deploy', ended: undefined });
  });

  it('lists a merge whose release Martin aborted as waiting for his retry or his next deploy', () => {
    const deploy = { stage: 'release', kind: 'approval', cause: 'deploy', reason: 'Waits for a deploy' } as const;
    const one = work('1')
      .open()
      .add(1, 'pull-request.merged', 'martin', { number: 2, commit: 'b'.repeat(40), by: 'martin' })
      .add(3, 'release.started', 'rollouts', started(twoSteps));
    const abortedAt = new Date(one.at(5)).toISOString();
    one
      .add(6, 'release.aborted', 'martin', {
        release: 'r1',
        version: 'v1.0.1',
        restored: 'v1.0.0',
        abortedAt,
        by: 'martin',
      })
      .add(6, 'hold.started', 'factory', deploy);
    const view = project(one.events, one.at(7));
    expect(view.panels.release.rows.find((r) => r.item === '1')?.note).toBe(
      'Needs you · aborted by Martin, waiting for his retry or next deploy',
    );
    const card = view.cards.find((c) => c.number === '1');
    expect(card?.picture).toMatchObject({
      type: 'deploy',
      ended: { at: one.at(5), version: 'v1.0.1', stopped: 'martin' },
    });
    expect(card?.versions).toMatchObject({ rolledBack: false, stopped: 'martin', onCanary: false });
  });

  it('draws a release an analysis error stopped, and lists its merge as waiting for Martin’s retry or next deploy', () => {
    const deploy = { stage: 'release', kind: 'approval', cause: 'deploy', reason: 'Waits for a deploy' } as const;
    const errored = { ...stepped(25), analysis: { phase: 'error' as const, requests: null, measures: [] } };
    const one = work('1')
      .open()
      .add(1, 'pull-request.merged', 'martin', { number: 2, commit: 'b'.repeat(40), by: 'martin' })
      .add(3, 'release.started', 'rollouts', started(twoSteps))
      .add(6, 'canary.stepped', 'rollouts', errored);
    const abortedAt = new Date(one.at(6)).toISOString();
    one
      .add(7, 'release.errored', 'rollouts', {
        release: 'r1',
        version: 'v1.0.1',
        restored: 'v1.0.0',
        weight: 25,
        reason: 'Metric "errors" assessed Error due to consecutiveErrors (5) > consecutiveErrorLimit (4)',
        errored: [{ name: 'errors', phase: 'error', value: null, limit: 0.01, message: 'connection refused' }],
        abortedAt,
      })
      .add(7, 'hold.started', 'factory', deploy);
    const view = project(one.events, one.at(8));
    // It ended when Argo Rollouts acted on the Error, at the step it could not judge.
    expect(releases(one.events, [], one.at(8))[0]?.end).toMatchObject({ kind: 'errored', at: one.at(6), weight: 25 });
    expect(view.panels.release.rows.find((r) => r.item === '1')?.note).toBe(
      'Needs you · stopped by an analysis error, waiting for Martin’s retry or next deploy',
    );
    const card = view.cards.find((c) => c.number === '1');
    expect(card?.picture).toMatchObject({
      type: 'deploy',
      ended: { at: one.at(6), version: 'v1.0.1', stopped: 'error' },
    });
    expect(card?.versions).toMatchObject({ rolledBack: false, stopped: 'error', onCanary: false });
    // The sheet names its chapter for the Error.
    expect(projectSheet(project(one.events, one.at(8)), '1')?.chapters.find((c) => c.label === 'ERROR')).toMatchObject({
      tone: 'attn',
      text: 'v1.0.1 stopped by an analysis error at 25%',
    });
    // Retried, it goes again from its first step, and the attempt it replaced is the Error's.
    one.add(10, 'release.started', 'rollouts', started(twoSteps));
    const [r] = releases(one.events, [], one.at(11));
    expect(r).toMatchObject({ startedAt: one.at(10), end: undefined });
    expect(r?.retried).toEqual([expect.objectContaining({ kind: 'errored', weight: 25 })]);
  });

  it('goes again from its first step when it is retried after a rollback', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started(twoSteps))
      .add(3, 'release.rolled-back', 'rollouts', rolledBack)
      .add(10, 'release.started', 'rollouts', started(twoSteps))
      .add(13, 'canary.stepped', 'rollouts', stepped(25));
    const [r] = releases(one.events, [], one.at(14));
    expect(r).toMatchObject({ startedAt: one.at(10), end: undefined, weight: 50, step: 1 });
    expect(r?.items.map((i) => i.number)).toEqual(['1']);
    // The sheet says how the attempt it replaced ended.
    expect(r?.retried).toEqual([expect.objectContaining({ kind: 'rolled-back', at: one.at(3), weight: 25 })]);
  });

  it('holds at a step the analysis could not judge, or left for someone to decide', () => {
    for (const phase of ['error', 'inconclusive'] as const) {
      const one = work('1')
        .open()
        .add(1, 'release.started', 'rollouts', started(twoSteps))
        .add(4, 'canary.stepped', 'rollouts', { ...stepped(25), analysis: { phase, requests: 225, measures: [] } });
      expect(releases(one.events, [], one.at(9))[0]).toMatchObject({ step: 0, weight: 25, until: undefined });
    }
  });

  it('reads an older history’s stop as Stop the line’s abort of the newest release, until it records its own end', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started(twoSteps))
      .add(5, 'release.started', 'rollouts', { ...started(twoSteps), release: 'r2', version: 'v1.0.2' })
      .add(6, 'line.stopped', 'martin', { reason: 'Stopped' });
    const [older, newer] = releases(one.events, [], one.at(7));
    expect(older?.end).toBeUndefined();
    expect(newer?.end).toEqual({ kind: 'aborted', by: 'stop', at: one.at(6), weight: 25 });
    // The abort the line records a pass later is the end, when Argo Rollouts acted on it.
    const abortedAt = new Date(one.at(6) + 1000).toISOString();
    one.add(7, 'release.aborted', 'martin', {
      release: 'r2',
      version: 'v1.0.2',
      restored: 'v1.0.0',
      abortedAt,
      by: 'stop',
    });
    expect(releases(one.events, [], one.at(8))[1]?.end).toEqual({
      kind: 'aborted',
      by: 'stop',
      at: one.at(6) + 1000,
      weight: 25,
    });
    // A history that records aborts reads no stop as one: a release the line recorded no abort for stays unfinished.
    one
      .add(9, 'release.started', 'rollouts', { ...started(twoSteps), release: 'r3', version: 'v1.0.3' })
      .add(10, 'line.stopped', 'martin', { reason: 'Stopped' });
    expect(releases(one.events, [], one.at(11))[2]?.end).toBeUndefined();
  });

  it('matches a step measured to the judged step at its weight, when the plan holds the weight twice', () => {
    const one = work('1')
      .open()
      .add(
        1,
        'release.started',
        'rollouts',
        started([
          { weight: 20, pauseSeconds: 60, analysis: false },
          { weight: 20, pauseSeconds: 180, analysis: true },
          { weight: 60, pauseSeconds: 180, analysis: true },
        ]),
      )
      .add(5, 'canary.stepped', 'rollouts', stepped(20));
    expect(releases(one.events, [], one.at(6))[0]).toMatchObject({ step: 2, weight: 60, until: one.at(8) });
  });

  it('adds all of the traffic after the steps, unless they list it', () => {
    const listed = work('1')
      .open()
      .add(
        1,
        'release.started',
        'rollouts',
        started([
          { weight: 50, pauseSeconds: 60, analysis: true },
          { weight: 100, pauseSeconds: 60, analysis: true },
        ]),
      );
    expect(releases(listed.events, [], listed.at(1))[0]?.steps.map((s) => s.weight)).toEqual([50, 100]);
  });

  it('draws the steps measured, then all of the traffic, for a release that recorded none', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started(null))
      .add(4, 'canary.stepped', 'rollouts', stepped(25));
    const [r] = releases(upTo(one.events, one.at(1)), [], one.at(1));
    expect(r).toMatchObject({ planned: false, weight: 0, step: -1 });
    const [later] = releases(one.events, [], one.at(5));
    expect(later?.steps.map((s) => s.weight)).toEqual([25, 100]);
    expect(later).toMatchObject({ weight: 25, until: undefined });
    expect(project(one.events, one.at(1)).stations.find((s) => s.stage === 'release')?.figure).toBe('starting');
  });
});

describe('the background analysis’s looks', () => {
  const inFlight = (t: number) => {
    const { canary } = shown(t);
    if (canary.state !== 'shown') throw new Error('No release in the panel');
    return canary.release;
  };
  const verdicts = (r: Release) =>
    Object.fromEntries(MEASURES.map(([name]) => [name, lookVerdict(r, name)])) as Record<string, LookVerdict>;
  const said = (words: string, kind: LookVerdict['kind'] = 'running', ruled = false) => ({ words, kind, ruled });

  it('keeps each look of the release in flight, and when the next is due', () => {
    const r = inFlight(END);
    expect(measuring(r)).toBe(true);
    expect(r.looks.map((l) => [new Date(l.at).toISOString().slice(11, 19), l.weight])).toEqual([
      ['14:18:01', 25],
      ['14:19:01', 25],
      ['14:20:01', 25],
      ['14:20:38', 25],
      ['14:21:01', 50],
      ['14:22:01', 50],
      ['14:23:01', 50],
    ]);
    // A minute after the last look that took errors and latency; the step began when the 25% step passed.
    expect(r.nextLook).toBe(at('2026-10-06T14:24:01Z'));
    expect(r).toMatchObject({ since: at('2026-10-06T14:21:00Z'), until: at('2026-10-06T14:24:00Z') });
  });

  it('says how far each measure is from its limit, from the latest look', () => {
    expect(verdicts(inFlight(END))).toEqual({
      'enough-requests': said('enough'),
      // 0.19% against 0.21%: a point above the baseline's is 1.21%.
      errors: said('1.02 pt to spare'),
      // 128 ms against 130 ms: the most is 100 ms above, since a quarter above is less.
      latency: said('102 ms to spare'),
      journeys: said('none worse here'),
    });
  });

  it('counts the requests, and waits for enough of them before errors and latency are judged', () => {
    const r = inFlight(at('2026-10-06T14:19:30Z'));
    expect(r.looks).toHaveLength(2);
    expect(verdicts(r)).toEqual({
      'enough-requests': said('counting'),
      errors: said('waits for 100 requests', 'pending'),
      latency: said('waits for 100 requests', 'pending'),
      journeys: said('waits for its first run', 'pending'),
    });
    expect(r.nextLook).toBe(at('2026-10-06T14:20:01Z'));
  });

  it('says a step passed, in green, until the next look lands', () => {
    const passed = verdicts(inFlight(at('2026-10-06T14:21:05Z')));
    for (const name of ['enough-requests', 'errors', 'latency', 'journeys'])
      expect(passed[name]).toEqual(said('passed at 25%', 'successful'));
    // The 50% step's first look, at 127 ms.
    expect(verdicts(inFlight(at('2026-10-06T14:21:12Z'))).latency).toEqual(said('103 ms to spare'));
  });

  describe('of hand-made releases', () => {
    const started: PayloadOf<'release.started'> = {
      release: 'r1',
      version: 'v1.0.1',
      previous: 'v1.0.0',
      image: { digest: `sha256:${'b'.repeat(64)}`, signed: true, admitted: true },
      watched: true,
      steps: [
        { weight: 25, pauseSeconds: 180, analysis: true },
        { weight: 50, pauseSeconds: 180, analysis: true },
      ],
      dryRun: false,
    };
    const figures = (canary: number, baseline: number) => ({
      canary: { requests: 225, errorRate: 0.002, p99Ms: canary, journeys: null },
      baseline: { requests: 675, errorRate: 0.002, p99Ms: baseline, journeys: null },
    });
    /** A look of latency alone, its value the canary's p99 less the most it may be, in seconds. */
    const look = (minute: number, p99: number, phase: 'successful' | 'failed' = 'successful') => {
      const at = new Date(Date.parse('2026-10-03T09:00:00Z') + minute * 60_000).toISOString();
      return {
        release: 'r1',
        version: 'v1.0.1',
        weight: 25,
        at,
        measures: [{ name: 'latency', phase, value: (p99 - 230) / 1000, limit: 0, at }],
        figures: figures(p99, 130),
        dryRun: false,
      } satisfies PayloadOf<'canary.measuring'>;
    };
    const flying = () => work('1').open().add(1, 'release.started', 'rollouts', started);

    it('keeps a look recorded on each work item the release carries once', () => {
      const one = flying().add(2.2, 'canary.measuring', 'rollouts', look(2, 200));
      const two = work('2')
        .add(1, 'release.started', 'rollouts', started)
        .add(2.4, 'canary.measuring', 'rollouts', look(2, 200));
      const events = [...one.events, ...two.events].sort((a, b) => a.ts.localeCompare(b.ts));
      const [r] = releases(events, [], one.at(3));
      expect(r?.looks).toHaveLength(1);
      expect(r?.nextLook).toBe(one.at(3));
    });

    it('keeps a measurement the line recorded a pass after a look that ended in the same second, as a look of its own', () => {
      const latency = look(2, 200);
      const errors = { name: 'errors', phase: 'successful', value: -0.0002, limit: 0.01, at: latency.at } as const;
      const split = flying()
        .add(2.2, 'canary.measuring', 'rollouts', { ...latency, measures: [errors] })
        .add(2.4, 'canary.measuring', 'rollouts', latency);
      const [r] = releases(split.events, [], split.at(2.5));
      expect(r?.looks.map((l) => l.measures.map((m) => m.name))).toEqual([['errors'], ['latency']]);
      expect(r && lookVerdict(r, 'latency').words).toBe('30 ms to spare');
      expect(r && lookVerdict(r, 'errors').words).toBe('1.02 pt to spare');
    });

    it('keeps each measurement once, however the line grouped it into looks on each work item', () => {
      // On one work item the line read errors and the failed latency together; on another, between the two writes.
      const failed = look(2, 255, 'failed');
      const errors = { name: 'errors', phase: 'successful', value: -0.0002, limit: 0.01, at: look(1.9, 0).at } as const;
      const together = flying().add(2.2, 'canary.measuring', 'rollouts', {
        ...failed,
        measures: [errors, ...failed.measures],
      });
      const apart = work('2')
        .add(1, 'release.started', 'rollouts', started)
        .add(2.1, 'canary.measuring', 'rollouts', { ...failed, at: errors.at, measures: [errors] })
        .add(2.4, 'canary.measuring', 'rollouts', failed);
      for (const events of [
        [...together.events, ...apart.events],
        [...apart.events, ...together.events],
      ]) {
        const [r] = releases(
          events.sort((a, b) => a.ts.localeCompare(b.ts)),
          [],
          together.at(3),
        );
        if (!r) throw new Error('No release');
        expect(r.looks.flatMap((l) => l.measures.map((m) => m.name)).sort()).toEqual(['errors', 'latency']);
        expect(lookVerdict(r, 'latency')).toEqual(said('25 ms over · 1 of 2', 'warm', true));
        expect(pointsOf(r, 'latency')).toHaveLength(1);
      }
    });

    it('places the looks a line that was down records together each at its own time', () => {
      const back = flying()
        .add(10.1, 'canary.measuring', 'rollouts', look(2, 200))
        .add(10.1, 'canary.measuring', 'rollouts', look(3, 210))
        .add(10.1, 'canary.measuring', 'rollouts', look(4, 220));
      const [r] = releases(back.events, [], back.at(11));
      expect(r?.looks.map((l) => l.at)).toEqual([back.at(2), back.at(3), back.at(4)]);
    });

    it('says a failed look in warm words, with how many of the looks that fail the release have failed', () => {
      const over = flying()
        .add(2.2, 'canary.measuring', 'rollouts', look(2, 200))
        .add(3.2, 'canary.measuring', 'rollouts', look(3, 255, 'failed'));
      const [r] = releases(over.events, [], over.at(3.5));
      if (!r) throw new Error('No release');
      expect(lookVerdict(r, 'latency')).toEqual(said('25 ms over · 1 of 2', 'warm', true));
      // Back under its limit, the failed look still counts.
      over.add(4.2, 'canary.measuring', 'rollouts', look(4, 145));
      const [later] = releases(over.events, [], over.at(4.5));
      if (!later) throw new Error('No release');
      expect(lookVerdict(later, 'latency')).toEqual(said('85 ms to spare · 1 of 2', 'warm', true));
      // Each point's limit is where the canary's p99 would fail: 230 ms, a hundred above the baseline's.
      expect(pointsOf(later, 'latency').map((p) => [p.canary, p.baseline, p.limit, p.failed])).toEqual([
        [200, 130, 230, false],
        [255, 130, 230, true],
        [145, 130, 230, false],
      ]);
    });

    it('starts a retry’s looks again, and keeps none after the end, nor a next look', () => {
      const retried = flying()
        .add(2.2, 'canary.measuring', 'rollouts', look(2, 200))
        .add(3, 'release.aborted', 'rollouts', {
          release: 'r1',
          version: 'v1.0.1',
          restored: 'v1.0.0',
          by: 'martin',
          abortedAt: '2026-10-03T09:03:00Z',
        })
        .add(3.2, 'canary.measuring', 'rollouts', look(3, 200));
      const [stopped] = releases(retried.events, [], retried.at(4));
      expect(stopped).toMatchObject({ looks: [{ weight: 25 }], nextLook: undefined });
      if (stopped) expect(measuring(stopped)).toBe(false);
      retried.add(5, 'release.started', 'rollouts', started);
      expect(releases(retried.events, [], retried.at(6))[0]).toMatchObject({ looks: [], nextLook: undefined });
    });

    it('places a look at its event when the log was moved in time and its payload was not', () => {
      // As \`pnpm dev\` serves the samples: every event's time moved to end now, the payloads' times as they were.
      const moved = flying().add(2.2, 'canary.measuring', 'rollouts', { ...look(2, 200), at: '2026-09-01T09:02:00Z' });
      expect(releases(moved.events, [], moved.at(3))[0]?.looks[0]?.at).toBe(moved.at(2.2));
      // Recorded on another work item a pass later, it is still one look, known by its own time.
      const other = work('2')
        .add(1, 'release.started', 'rollouts', started)
        .add(2.7, 'canary.measuring', 'rollouts', { ...look(2, 200), at: '2026-09-01T09:02:00Z' });
      const both = [...moved.events, ...other.events].sort((a, b) => a.ts.localeCompare(b.ts));
      expect(releases(both, [], moved.at(3))[0]?.looks).toHaveLength(1);
      const recorded = flying().add(2.2, 'canary.measuring', 'rollouts', look(2, 200));
      expect(releases(recorded.events, [], recorded.at(3))[0]?.looks[0]?.at).toBe(recorded.at(2));
      // Its later looks move as far as the first, keeping their order and spacing, even recorded in one pass.
      const later = (minute: number, p99: number) => ({
        ...look(minute, p99),
        at: new Date(Date.parse('2026-09-01T09:00:00Z') + minute * 60_000).toISOString(),
      });
      moved
        .add(5.2, 'canary.measuring', 'rollouts', later(3, 200))
        .add(5.2, 'canary.measuring', 'rollouts', later(4, 200));
      expect(releases(moved.events, [], moved.at(6))[0]?.looks.map((l) => l.at)).toEqual([
        moved.at(2.2),
        moved.at(3.2),
        moved.at(4.2),
      ]);
    });

    it('leaves a work item’s latest time where its last change put it', () => {
      const looked = flying().add(2.2, 'canary.measuring', 'rollouts', look(2, 200));
      const item = foldItems(looked.events).find((i) => i.number === '1');
      expect(item?.lastAt).toBe(looked.at(1));
    });

    it('keeps no looks, and no next look, for a dry run, which has no canary to look at', () => {
      const dry = work('1')
        .open()
        .add(1, 'release.started', 'rollouts', { ...started, dryRun: true })
        .add(2.2, 'canary.measuring', 'rollouts', look(2, 200));
      const [r] = releases(dry.events, [], dry.at(3));
      expect(r?.looks).toEqual([]);
      expect(r?.nextLook).toBeUndefined();
    });
  });

  it('says the room to a limit in each figure’s unit, never an excess as none', () => {
    expect(room('errors', -0.0002, 0.01)).toBe('1.02 pt');
    expect(room('errors', 0.0123, 0.01)).toBe('0.23 pt');
    expect(room('latency', -0.085, 0)).toBe('85 ms');
    expect(room('latency', 0.0004, 0)).toBe('1 ms');
    expect(room('latency', 0.025, 0)).toBe('25 ms');
  });
});

it('keeps the measures’ rules, and the background analysis’s figures, in the policy’s terms', () => {
  const words = Object.fromEntries(MEASURES.map(([name, , rule]) => [name, rule]));
  expect(words['enough-requests']).toBe(`at least ${policy.minRequests} in the window`);
  expect(policy.errors.maxAbove).toBe(0.01); // "a point above"
  expect(words.errors).toBe('5xx share · fails a point above');
  expect(policy.latency).toMatchObject({ percentile: 0.99, maxRatioAbove: 0.25, minSecondsAbove: 0.1 });
  expect(words.latency).toBe('p99 · fails 25% and 100 ms above');
  expect(policy.background.failures).toBe(2);
  expect(words.journeys).toBe('fails on a check failing here alone, twice');
  expect(BACKGROUND).toEqual({
    minRequests: policy.minRequests,
    intervalMs: policy.background.intervalMinutes * 60_000,
    failures: policy.background.failures,
  });
});

it('reads each series in the unit the line draws it in', () => {
  expect(SERIES_UNITS).toEqual(Object.fromEntries(Object.entries(DRAWN).map(([name, d]) => [name, d.unit])));
});

describe('what the analysis saw of a measure that failed', () => {
  const reason = 'Metric "latency" assessed Failed due to failed (2) > failureLimit (1)';
  const failed = (name: string, value: number | null, limit: number | null, message?: string): Failed => ({
    name,
    phase: 'failed',
    value,
    limit,
    ...(message ? { message } : {}),
  });

  it('says each figure against its limit, in the analysis’s terms', () => {
    expect(sawOf(failed('enough-requests', 62, 100), reason)).toBe('62 requests to the canary, against at least 100');
    expect(sawOf(failed('errors', 0.024, 0.01), reason)).toBe(
      '5xx share 2.40 points above the baseline’s, against at most 1.00 points',
    );
    expect(sawOf(failed('latency', 0.273, 0), reason)).toBe('p99 273 ms over its limit');
    // Any excess fails, so a fraction of a millisecond is not said as none.
    expect(sawOf(failed('latency', 0.0004, 0), reason)).toBe('p99 1 ms over its limit');
    // Otherwise to the nearest millisecond, as the figures beside it are, and not misread by a float's last digits.
    expect(sawOf(failed('latency', 0.2731, 0), reason)).toBe('p99 273 ms over its limit');
    expect(sawOf(failed('latency', 1.0005, 0), reason)).toBe('p99 1001 ms over its limit');
    // The limit is what the value is held to: the excess over it is what is said.
    expect(sawOf(failed('latency', 0.273, 0.1), reason)).toBe('p99 173 ms over its limit');
    // A limit the analysis did not record is not said.
    expect(sawOf(failed('errors', 0.024, null), reason)).toBe('5xx share 2.40 points above the baseline’s');
    expect(sawOf(failed('other', 3, null), reason)).toBe('3');
  });

  describe('with the series the line drew', () => {
    const series = (unit: string, canary: (number | null)[], baseline: (number | null)[], at = canary.length - 1) => ({
      label: unit === 'ms' ? 'p99 latency' : 'share of 5xx answers',
      unit,
      stepSeconds: 15,
      canary,
      baseline,
      at,
    });
    const withSeries = (f: Failed, s: ReturnType<typeof series>): Failed => ({ ...f, series: s });

    it('says both versions’ figures at the failure, before how far over its limit it was', () => {
      // A real rollback's latency measure, as the line recorded it: the canary's p99 less the baseline's and its margin.
      const latency = withSeries(failed('latency', 0.27624068397288937, 0), series('ms', [40.1, 415.2], [38.5, 38.96]));
      expect(versionsAt(latency)).toEqual({ canary: 415.2, baseline: 38.96 });
      // Rounded as the figures are, the excess agrees with them: 415 less 39 and its 100 ms margin.
      expect(sawOf(latency, reason)).toBe('p99 415 ms against 39 ms: 276 ms over its limit');
      const errors = withSeries(failed('errors', 0.024, 0.01), series('%', [0.5, 3.4], [0.9, 1]));
      expect(sawOf(errors, reason)).toBe(
        '5xx share 3.40% against 1.00%: 2.40 points above, at most 1.00 points allowed',
      );
      expect(sawOf({ ...errors, limit: null }, reason)).toBe('5xx share 3.40% against 1.00%: 2.40 points above');
    });

    it('reads the figures where the analysis failed, not where the lines end', () => {
      const latency = withSeries(
        failed('latency', 0.173, 0),
        series('ms', [140, 412, 409, null], [138, 139, 137, 139], 1),
      );
      expect(sawOf(latency, reason)).toBe('p99 412 ms against 139 ms: 173 ms over its limit');
    });

    it('keeps today’s wording where a version has no figure, or the series is not the measure’s', () => {
      const gap = withSeries(failed('latency', 0.173, 0), series('ms', [140, null], [138, 139]));
      expect(versionsAt(gap)).toBeUndefined();
      expect(sawOf(gap, reason)).toBe('p99 173 ms over its limit');
      const other = withSeries(failed('latency', 0.173, 0), series('%', [1, 2], [1, 1]));
      expect(sawOf(other, reason)).toBe('p99 173 ms over its limit');
      const errors = withSeries(failed('errors', 0.024, 0.01), series('%', [0.5, 3.4], [0.9, null]));
      expect(sawOf(errors, reason)).toBe('5xx share 2.40 points above the baseline’s, against at most 1.00 points');
      // A measure with no value had nothing to compare, whatever its series.
      const none = withSeries(failed('latency', null, 0), series('ms', [140, 412], [138, 139]));
      expect(sawOf(none, reason)).toBe('no figures to compare, which counts as infinitely worse');
    });
  });

  it('says when there was nothing to compare, and lets the journeys say what they saw', () => {
    // Argo Rollouts' words for an earlier analysis's failure are not the measure's own either.
    const earlier = 'Metric "latency" assessed Failed due to failed (1) > failureLimit (0)';
    expect(sawOf(failed('latency', null, 0, earlier), reason)).toBe(
      'no figures to compare, which counts as infinitely worse',
    );
    // Nor are they said beside what the analysis saw.
    expect(ownWords(earlier, reason)).toBeUndefined();
    expect(ownWords('Prometheus did not answer', reason)).toBe('Prometheus did not answer');
    expect(sawOf(failed('latency', null, 0, reason), reason)).toBe(
      'no figures to compare, which counts as infinitely worse',
    );
    expect(sawOf(failed('journeys', null, null, 'checkout failed on the canary twice'), reason)).toBe(
      'checkout failed on the canary twice',
    );
    expect(sawOf(failed('journeys', null, null, reason), reason)).toBe(
      'a check that passed on the baseline failed here',
    );
  });
});

describe('a live figure, as written and counted up', () => {
  it('says the requests are short of the window’s least only while the figure shown is', () => {
    // Counting up from 63 to 140, and down from 140 to 40: each figure it passes is written as it stands.
    expect([63, 99.4, 99.6, 140].map((n) => written('requests', n))).toEqual(['63 / 100', '99 / 100', '100', '140']);
    expect([140, 120, 100, 99, 40].map((n) => written('requests', n))).toEqual([
      '140',
      '120',
      '100',
      '99 / 100',
      '40 / 100',
    ]);
    expect(written('requests', 1234)).toBe('1,234');
    expect(written('share', 0.0042)).toBe('0.42%');
    expect(written('ms', 126.6)).toBe('127 ms');
  });
});

describe('how many looks of a failed measure failed', () => {
  const latency: Failed = { name: 'latency', phase: 'failed', value: 0.276, limit: 0 };
  const back = (...failed: Failed[]): End => ({
    kind: 'rolled-back',
    at: 0,
    weight: 25,
    reason: 'Failed',
    failed,
    ticket: undefined,
    by: 'analysis',
  });

  it('says the count the rollback kept for the one run that failed the measure', () => {
    expect(failedLooks(back({ ...latency, failures: 2 }), 'latency')).toBe(2);
    expect(failedLooks(back({ ...latency, failures: 1 }, { ...latency, name: 'errors', failures: 2 }), 'latency')).toBe(
      1,
    );
  });

  it('says nothing for a rollback that did not count them, a measure it did not fail, or another end', () => {
    expect(failedLooks(back(latency), 'latency')).toBeUndefined();
    // A step's analysis and the background's both failed it: each run's count is its own, so neither is the step's.
    expect(failedLooks(back({ ...latency, failures: 1 }, { ...latency, failures: 2 }), 'latency')).toBeUndefined();
    expect(failedLooks(back({ ...latency, failures: 2 }), 'errors')).toBeUndefined();
    expect(failedLooks({ kind: 'promoted', at: 0, weight: 100 }, 'latency')).toBeUndefined();
    expect(failedLooks(undefined, 'latency')).toBeUndefined();
  });

  it('is in the samples’ rollbacks, as the line records it', () => {
    const ends = releases(SAMPLES, [], END)
      .flatMap((r) => [...r.retried, r.end])
      .filter((end) => end?.kind === 'rolled-back');
    expect(ends.length).toBeGreaterThan(0);
    for (const end of ends) expect(failedLooks(end, 'latency')).toBe(2);
  });
});

describe('Martin’s controls of the canary', () => {
  const started: PayloadOf<'release.started'> = {
    release: 'r1',
    version: 'v1.0.1',
    previous: 'v1.0.0',
    image: { digest: `sha256:${'b'.repeat(64)}`, signed: true, admitted: true },
    watched: true,
    steps: [
      { weight: 25, pauseSeconds: 180, analysis: true },
      { weight: 50, pauseSeconds: 180, analysis: true },
    ],
    dryRun: false,
  };
  const control = (
    action: PayloadOf<'release.controlled'>['action'],
    weight: number,
    to?: number,
  ): PayloadOf<'release.controlled'> => ({ action, release: 'r1', version: 'v1.0.1', weight, ...(to && { to }) });
  const flying = () => work('1').open().add(1, 'release.started', 'rollouts', started);

  it('holds a paused canary at the weight it kept, with no end to wait for, until he resumes it', () => {
    const paused = flying().add(2, 'release.controlled', 'martin', control('pause', 25));
    // Long past its pause's end, it is still where he paused it.
    expect(releases(paused.events, [], paused.at(30))[0]).toMatchObject({
      step: 0,
      weight: 25,
      until: undefined,
      paused: { at: paused.at(2), weight: 25 },
    });
    // A step measured after he paused it moves it no further.
    const measured = paused.add(4, 'canary.stepped', 'rollouts', {
      release: 'r1',
      version: 'v1.0.1',
      weight: 25,
      analysis: { phase: 'successful', requests: 225, measures: [] },
      dryRun: false,
    });
    expect(releases(measured.events, [], measured.at(5))[0]).toMatchObject({ step: 0, weight: 25 });
    const resumed = paused.add(5, 'release.controlled', 'martin', control('resume', 25));
    expect(releases(resumed.events, [], resumed.at(5))[0]).toMatchObject({ paused: undefined });
  });

  it('counts a step’s pause from where it was, after he resumes it, not from before he held it', () => {
    // Paused a minute into the 25% step's three, held for ten, resumed: two minutes of its pause are left.
    const resumed = flying()
      .add(2, 'release.controlled', 'martin', control('pause', 25))
      .add(12, 'release.controlled', 'martin', control('resume', 25));
    expect(releases(resumed.events, [], resumed.at(13))[0]).toMatchObject({
      step: 0,
      weight: 25,
      until: resumed.at(14),
      paused: undefined,
    });
  });

  it('moves a canary he promoted to the step it went to, and on from there', () => {
    const promoted = flying().add(2, 'release.controlled', 'martin', control('promote', 25, 50));
    expect(releases(promoted.events, [], promoted.at(3))[0]).toMatchObject({ step: 1, weight: 50 });
  });

  it('offers what each state takes: in flight, paused, stopped, and nothing once it ended or for a dry run', () => {
    const [inFlight] = releases(flying().events, [], flying().at(2));
    if (!inFlight) throw new Error('no release');
    expect(controlsOf(inFlight, false).map((c) => [c.action, c.label, c.stepUp])).toEqual([
      ['promote', 'Promote to 50%', true],
      ['promote-fully', 'Promote fully', true],
      ['pause', 'Pause', false],
      ['abort', 'Abort', false],
    ]);
    const paused = flying().add(2, 'release.controlled', 'martin', control('pause', 25));
    const [held] = releases(paused.events, [], paused.at(3));
    expect(held && controlsOf(held, false).map((c) => c.action)).toContain('resume');
    // At 50%, the next step is all of the traffic: promote fully alone.
    const at50 = { ...inFlight, step: 1, weight: 50 };
    expect(controlsOf(at50, false).map((c) => c.action)).toEqual(['promote-fully', 'pause', 'abort']);
    const aborted: Release = { ...inFlight, end: { kind: 'aborted', at: 0, weight: 25, by: 'martin' } };
    expect(controlsOf(aborted, false)).toMatchObject([{ action: 'retry', stepUp: true }]);
    expect(controlsOf(aborted, true)).toMatchObject([
      { action: 'retry', off: 'Start the line first: a stopped line starts no canary.' },
    ]);
    const errored: Release = {
      ...inFlight,
      end: { kind: 'errored', at: 0, weight: 25, reason: 'r', errored: [] },
    };
    expect(controlsOf(errored, false).map((c) => c.action)).toEqual(['retry']);
    expect(controlsOf({ ...inFlight, end: { kind: 'promoted', at: 0, weight: 100 } }, false)).toEqual([]);
    // A rollback is retried too, judged by its analysis afresh.
    const rolled: Release = {
      ...inFlight,
      end: { kind: 'rolled-back', at: 0, weight: 25, reason: 'r', failed: [], ticket: undefined, by: 'analysis' },
    };
    expect(controlsOf(rolled, false)).toMatchObject([{ action: 'retry', stepUp: true }]);
    expect(controlsOf({ ...inFlight, dryRun: true }, false)).toEqual([]);
  });

  it('keeps a stopped release in full while it waits for his retry', () => {
    const aborted = flying().add(3, 'release.aborted', 'martin', {
      release: 'r1',
      version: 'v1.0.1',
      restored: 'v1.0.0',
      abortedAt: new Date(flying().at(3)).toISOString(),
      by: 'martin',
    });
    const all = releases(aborted.events, [], aborted.at(300));
    expect(canaryView(all).state).toBe('shown');
  });

  it('asks for the passkey where the access table does, and counts it fresh as long', () => {
    for (const [action, stepUp] of Object.entries(STEP_UP)) {
      const name = action === 'promote-fully' ? 'release.promote' : (`release.${action}` as const);
      expect(stepUp, action).toBe(ACCESS[name as keyof typeof ACCESS].stepUp);
    }
    expect(FRESH_MINUTES).toBe(STEP_UP_POLICY.minutes);
  });
});

describe('a release’s end', () => {
  it('is one of four events, and all but a promotion stop the release short', () => {
    const of = (type: string) => ({ type }) as Parameters<typeof endsRelease>[0];
    const ends = ['release.promoted', 'release.rolled-back', 'release.errored', 'release.aborted'];
    for (const type of ends) expect(endsRelease(of(type)), type).toBe(true);
    for (const type of ['release.started', 'canary.stepped', 'canary.measuring']) {
      expect(endsRelease(of(type)), type).toBe(false);
      expect(stopsRelease(of(type)), type).toBe(false);
    }
    expect(ends.filter((type) => stopsRelease(of(type)))).toEqual(ends.slice(1));
  });
});

describe('a merged fix held for its deploy', () => {
  const ended = (stopped?: 'stop' | 'martin' | 'error') => ({ at: 0, version: 'v0.9.3', stopped });
  const deploy = { pullRequest: 1412, state: 'checking' as const };

  it('says what became of the merge and what it waits for, in one place for its row and its picture', () => {
    expect(deployCaption(undefined, undefined, false)).toEqual(['merged', 'waiting for its deploy pull request']);
    expect(deployCaption(ended(), deploy, false)).toEqual(['rolled back', 'deploy #1412’s checks running']);
    expect(deployCaption(undefined, deploy, true)).toEqual(['merged', 'waiting for Martin’s deploy']);
    expect(deployCaption(ended(), deploy, true)).toEqual(['rolled back', 'waiting for Martin’s retry or next deploy']);
  });

  it('names what stopped the release that carried it, whoever it waits for', () => {
    expect(deployCaption(ended('martin'), deploy, false)).toEqual([
      'aborted by Martin',
      'waiting for his retry or next deploy',
    ]);
    expect(deployCaption(ended('stop'), deploy, true)).toEqual([
      'stopped with the line',
      'waiting for Martin’s retry or next deploy',
    ]);
  });
});
