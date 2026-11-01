/**
 * A canary paused for Martin (the design system's README, "The Canary panel" and "Needs you"): with auto-rollback off,
 * the analysis judges a canary bad, Argo Rollouts pauses it, and it waits for him to promote it fully or abort it,
 * which counts as a rollback. Drawn from the release's events, at a step or after the background analysis's looks, and
 * from the line's hold when its events say no more; one card in Needs you whether or not it carries a work item.
 */
import type { PayloadOf, PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { project } from '../../web/src/projection/index.ts';
import { foldItem } from '../../web/src/projection/items.ts';
import {
  BACKGROUND,
  canaryView,
  controlsOf,
  judgedWords,
  lookVerdict,
  measuring,
  releases,
} from '../../web/src/projection/release.ts';
import { projectSheet } from '../../web/src/projection/sheet.ts';
import { work } from './support.ts';

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
const FIGURES = {
  canary: { requests: 846, errorRate: 0.0392, p99Ms: 42, journeys: null },
  baseline: { requests: 902, errorRate: 0.0139, p99Ms: 39, journeys: null },
};
const SAID = 'Metric "errors" assessed Inconclusive due to inconclusive (1) > inconclusiveLimit (0)';
/** Errors judged bad, with auto-rollback off: 2.53 points above the baseline, where a point is the most. */
const judged = { name: 'errors', phase: 'inconclusive', value: 0.0253, limit: 0.01, message: SAID } as const;
const passed = (name: string) => ({ name, phase: 'successful', value: 0, limit: 0 }) as const;
const stepped = (weight: number, measures: PayloadOf<'canary.stepped'>['analysis']['measures']) =>
  ({
    release: 'r1',
    version: 'v1.0.1',
    weight,
    analysis: {
      phase: measures.some((m) => m.phase === 'inconclusive') ? 'inconclusive' : 'successful',
      requests: 846,
      measures,
    },
    figures: FIGURES,
    dryRun: false,
  }) satisfies PayloadOf<'canary.stepped'>;
const look = (minute: number, phase: 'inconclusive' | 'successful', at: (m: number) => number) =>
  ({
    release: 'r1',
    version: 'v1.0.1',
    weight: 25,
    at: new Date(at(minute)).toISOString(),
    measures: [
      { ...passed('latency'), at: new Date(at(minute)).toISOString() },
      { ...judged, phase, at: new Date(at(minute)).toISOString() },
    ],
    figures: FIGURES,
    dryRun: false,
  }) satisfies PayloadOf<'canary.measuring'>;
/** The same events on the line: a release that carries no work item. */
const onTheLine = (events: PublicEvent[]): PublicEvent[] => events.map((e) => ({ ...e, work_item: null }));

describe('a canary paused for Martin', () => {
  it('is judged bad at a step the analysis found inconclusive, and waits there with nothing due', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(4, 'canary.stepped', 'rollouts', stepped(25, [passed('enough-requests'), judged, passed('latency')]));
    const [r] = releases(one.events, [], one.at(30));
    expect(r).toMatchObject({
      step: 0,
      weight: 25,
      until: undefined,
      since: undefined,
      end: undefined,
      judgedBad: { at: one.at(4), weight: 25, measures: [judged] },
    });
    if (!r?.judgedBad) throw new Error('not judged');
    // Said as a rollback's measure is: each version's figure, against its limit.
    expect(judgedWords(r.judgedBad)).toBe(
      '5xx share 3.92% against 1.39%: 2.53 points above, at most 1.00 points allowed',
    );
    expect(lookVerdict(r, 'errors')).toEqual({ words: '', kind: 'inconclusive', ruled: true });
  });

  it('offers only Promote fully, past the verdict, and Abort, which counts as a rollback', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(4, 'canary.stepped', 'rollouts', stepped(25, [judged]));
    const [r] = releases(one.events, [], one.at(5));
    if (!r) throw new Error('no release');
    expect(controlsOf(r, false).map((c) => [c.action, c.stepUp, c.what])).toEqual([
      ['promote-fully', true, 'Gives v1.0.1 all the traffic now, past the analysis’s verdict.'],
      [
        'abort',
        false,
        'Sends all the traffic back to v1.0.0. It counts as a rollback: #1 fails Release, and triage gets the analysis’s verdict.',
      ],
    ]);
    // Carrying no work item, it fails none at Release.
    const [line] = releases(onTheLine(one.events), [], one.at(5));
    expect(line && controlsOf(line, false)[1]?.what).toBe(
      'Sends all the traffic back to v1.0.0. It counts as a rollback: triage gets the analysis’s verdict.',
    );
  });

  it('is judged bad by the background analysis only on as many inconclusive looks as fail a release', () => {
    expect(BACKGROUND.failures).toBe(2);
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(
        2,
        'canary.measuring',
        'rollouts',
        look(2, 'successful', (m) => work('1').at(m)),
      )
      .add(
        3,
        'canary.measuring',
        'rollouts',
        look(3, 'inconclusive', (m) => work('1').at(m)),
      );
    // One bad look is warm, and counts towards the pause as a failed look counts towards a rollback.
    const [first] = releases(one.events, [], one.at(3));
    expect(first?.judgedBad).toBeUndefined();
    expect(first && lookVerdict(first, 'errors')).toEqual({
      words: '1.53 pt over · 1 of 2',
      kind: 'warm',
      ruled: true,
    });
    expect(first?.nextLook).toBe(one.at(4));
    one.add(
      4,
      'canary.measuring',
      'rollouts',
      look(4, 'inconclusive', (m) => work('1').at(m)),
    );
    const [r] = releases(one.events, [], one.at(9));
    expect(r?.judgedBad).toMatchObject({
      at: one.at(4),
      weight: 25,
      measures: [expect.objectContaining({ name: 'errors' })],
    });
    expect(r && measuring(r)).toBe(true);
    // Paused, no look is due, and the step's pause does not run out.
    expect(r).toMatchObject({ nextLook: undefined, until: undefined });
    expect(r && lookVerdict(r, 'errors')).toEqual({ words: '', kind: 'inconclusive', ruled: true });
  });

  it('stays at the step it was judged at by the background analysis, past that step’s pause', () => {
    // A step that only waits, so its pause would run out and move the canary on, were it not paused for Martin.
    const waits = {
      ...started,
      steps: [
        { weight: 25, pauseSeconds: 180, analysis: false },
        { weight: 50, pauseSeconds: 180, analysis: true },
      ],
    };
    const at = (m: number) => work('1').at(m);
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', waits)
      .add(2, 'canary.measuring', 'rollouts', look(2, 'inconclusive', at))
      .add(3, 'canary.measuring', 'rollouts', look(3, 'inconclusive', at));
    const [r] = releases(one.events, [], one.at(30));
    expect(r?.judgedBad).toMatchObject({ at: one.at(3), weight: 25 });
    expect(r).toMatchObject({ step: 0, weight: 25, until: undefined, since: undefined });
  });

  it('waits for nobody once a step is measured after the verdict: the canary went on past it', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(4, 'canary.stepped', 'rollouts', stepped(25, [judged]))
      .add(6, 'hold.started', 'rollouts', {
        stage: 'release',
        kind: 'held',
        cause: 'canary',
        reason: 'Paused for Martin',
        release: 'r1',
      })
      // Promoted past it by hand, and the next step passes.
      .add(9, 'canary.stepped', 'rollouts', stepped(50, [passed('errors')]));
    const [r] = releases(one.events, [], one.at(10));
    expect(r?.judgedBad).toBeUndefined();
    expect(project(one.events, one.at(10)).needs.canary).toBeUndefined();
  });

  it('takes the line’s hold for the judgement when the release’s events do not say it', () => {
    const one = work('1').open().add(1, 'release.started', 'rollouts', started).add(6, 'hold.started', 'rollouts', {
      stage: 'release',
      kind: 'held',
      cause: 'canary',
      reason: 'With auto-rollback off, the analysis judged the canary bad',
      release: 'r1',
    });
    const [r] = releases(one.events, [], one.at(7));
    // Where the canary was then: at 25%, its step waiting to be judged.
    expect(r?.judgedBad).toEqual({ at: one.at(6), weight: 25, measures: [], figures: undefined });
  });

  it('ends with Martin’s rollback, which he may retry, and stays in full while it waits', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(4, 'canary.stepped', 'rollouts', stepped(25, [judged]))
      .add(9, 'release.rolled-back', 'martin', {
        release: 'r1',
        version: 'v1.0.1',
        restored: 'v1.0.0',
        weight: 25,
        reason: SAID,
        failed: [{ ...judged, failures: 1 }],
        dryRun: false,
        by: 'martin',
        abortedAt: new Date(work('1').at(9)).toISOString(),
      });
    const all = releases(one.events, [], one.at(300));
    expect(all[0]).toMatchObject({ judgedBad: undefined, end: { kind: 'rolled-back', by: 'martin', weight: 25 } });
    expect(all[0] && controlsOf(all[0], false).map((c) => c.action)).toEqual(['retry']);
    expect(canaryView(all).state).toBe('shown');
  });
});

describe('a canary paused for Martin, in Needs you', () => {
  const paused = () =>
    work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(4, 'canary.stepped', 'rollouts', stepped(25, [judged]));

  it('has one card for a release that carries no work item, named by its version', () => {
    const events = onTheLine(paused().events.filter((e) => e.type !== 'work-item.opened'));
    const { needs } = project(events, paused().at(7));
    expect(needs.holds).toEqual([]);
    expect(needs.canary).toMatchObject({
      kicker: 'A canary paused for you',
      label: 'v1.0.1',
      workItem: undefined,
      title: 'v1.0.1, which carries no work item',
      waited: '3min',
      said: [SAID],
      bad: '5xx share 3.92% against 1.39%: 2.53 points above, at most 1.00 points allowed',
    });
  });

  it('has the same one card for a release that carries work items, whose holds it stands for, and on their sheets', () => {
    const hold = {
      stage: 'release',
      kind: 'held',
      cause: 'canary',
      reason: 'Paused for Martin',
      release: 'r1',
    } as const;
    const one = paused().add(4, 'hold.started', 'rollouts', hold);
    const two = work('2')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(4, 'hold.started', 'rollouts', hold);
    const events = [...one.events, ...two.events].sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
    const { needs } = project(events, one.at(7));
    expect(needs.holds).toEqual([]);
    expect(needs.canary).toMatchObject({ label: '#1', workItem: '1', title: 'Item 1 and 1 more' });
    expect(projectSheet(project(events, one.at(7)), '2')?.needs).toMatchObject({
      hold: undefined,
      canary: { label: '#1' },
    });
    // Ended, it waits on nobody.
    const ended = [
      ...events,
      {
        ...events.at(-1),
        id: 'end',
        seq: 1e6,
        ts: new Date(one.at(8)).toISOString(),
        type: 'release.promoted',
        payload: { release: 'r1', version: 'v1.0.1', dryRun: false },
      },
    ] as PublicEvent[];
    expect(project(ended, one.at(9)).needs.canary).toBeUndefined();
  });
});

describe('a canary’s hold on a work item', () => {
  const hold = { stage: 'release', kind: 'held', cause: 'canary', reason: 'Paused for Martin', release: 'r1' } as const;
  const held = () =>
    work('1').open().add(1, 'release.started', 'rollouts', started).add(4, 'hold.started', 'rollouts', hold);
  const AT = new Date(work('1').at(9)).toISOString();
  const ends: { [K in 'promoted' | 'rolled-back' | 'aborted' | 'errored']: PayloadOf<`release.${K}`> } = {
    promoted: { release: 'r1', version: 'v1.0.1', previous: 'v1.0.0', watched: true, dryRun: false },
    'rolled-back': {
      release: 'r1',
      version: 'v1.0.1',
      restored: 'v1.0.0',
      weight: 25,
      reason: SAID,
      failed: [{ ...judged, failures: 1 }],
      dryRun: false,
      by: 'analysis',
    },
    aborted: { release: 'r1', version: 'v1.0.1', restored: 'v1.0.0', abortedAt: AT, by: 'stop' },
    errored: {
      release: 'r1',
      version: 'v1.0.1',
      restored: 'v1.0.0',
      weight: 25,
      reason: 'Could not judge',
      errored: [],
      abortedAt: AT,
    },
  };

  it('waits on Martin while its release is in flight, whatever an answer of the holds’ says', () => {
    const item = foldItem(
      held().add(5, 'hold.answered', 'martin', { hold: '00000000-0000-4000-8000-000000000000', decision: 'approved' })
        .events,
    );
    expect(item).toMatchObject({ hold: { cause: 'canary' }, outcome: 'held' });
  });

  const ended = {
    promoted: () => held().add(9, 'release.promoted', 'rollouts', ends.promoted),
    'rolled-back': () => held().add(9, 'release.rolled-back', 'rollouts', ends['rolled-back']),
    aborted: () => held().add(9, 'release.aborted', 'factory', ends.aborted),
    errored: () => held().add(9, 'release.errored', 'rollouts', ends.errored),
  };
  for (const [end, events] of Object.entries(ended)) {
    it(`ends when its release is ${end}, as the line reads it`, () => {
      const item = foldItem(events().events);
      expect(item?.hold).toBeUndefined();
      expect(item?.outcome).not.toBe('held');
    });
  }

  it('holds nothing for a release that has ended or is not the one in flight', () => {
    const after = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', started)
      .add(3, 'release.promoted', 'rollouts', ends.promoted)
      .add(4, 'hold.started', 'rollouts', hold)
      .add(5, 'hold.started', 'rollouts', { ...hold, release: 'r0' });
    expect(foldItem(after.events)?.hold).toBeUndefined();
  });
});
