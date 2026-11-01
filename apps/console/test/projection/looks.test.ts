/**
 * A spec that waits for overlapping work in flight, and a held work item looked at again after a release that did
 * not carry its fix: on the card, the line's rows and the sheet.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { project } from '../../web/src/projection/index.ts';
import { clearanceWords, foldItem } from '../../web/src/projection/items.ts';
import { projectSheet } from '../../web/src/projection/sheet.ts';
import { END, payloads, SAMPLES, work } from './support.ts';

const look = (outcome: PayloadOf<'signal.rechecked'>['outcome'], occasion: 'release' | 'wait' = 'release') =>
  ({
    for: occasion,
    outcome,
    sense: 'probe',
    check: 'products journey',
    release: 'f00dfeed01-3',
    version: 'd728dbe',
    against: 'v0.9.4',
    carried: ['1033'],
    ...(outcome === 'unsure' ? { why: 'the check could not tell' } : {}),
  }) satisfies PayloadOf<'signal.rechecked'>;

const pushed = {
  number: 76,
  title: 'fix(products): load them all',
  branch: 'factory/1-products',
  attempt: 1,
  testsFirst: true,
  files: [{ path: 'src/products.ts', added: 1, removed: 1 }],
  whole: [{ path: 'src/products.ts', added: 1, removed: 1 }],
} satisfies PayloadOf<'pull-request.pushed'>;

describe('a spec waiting for overlapping work', () => {
  it('waits at Build, in the quiet tone, saying what it waits for, at the samples’ end', () => {
    const card = project(SAMPLES, END).cards.find((c) => c.number === '1327');
    expect(card?.outcome).toBe('waits-on-work');
    const sheet = projectSheet(project(SAMPLES, END), '1327');
    expect(sheet?.chapters.slice(-2)).toMatchObject([
      { label: 'WAITS', tone: 'faint' },
      {
        label: 'WAITING · BUILD',
        tone: 'faint',
        waiting: true,
        text: 'Waits for #1325, whose spec also changes src/pages/search.ts and test/search.test.ts',
      },
    ]);
  });

  it('goes on to Build when its look at the end of the wait still sees the signal', () => {
    const item = foldItem(
      work('2')
        .open()
        .add(1, 'signal.received', 'probe', payloads.signal)
        .add(2, 'wait.started', 'factory', { on: ['1'], files: ['src/products.ts'], reason: 'Waits for #1' })
        .add(30, 'signal.rechecked', 'probe', look('persists', 'wait')).events,
    );
    expect(item).toMatchObject({ waitingOn: undefined, stage: 'build' });
  });
});

describe('a held work item looked at again', () => {
  const held = (cause: 'merge' | 'gates') =>
    work('1')
      .open()
      .add(1, 'signal.received', 'probe', payloads.signal)
      .add(2, 'pull-request.pushed', 'coder', pushed)
      .add(3, 'hold.started', 'factory', {
        stage: cause === 'merge' ? 'review' : 'gates',
        kind: cause === 'merge' ? 'approval' : 'held',
        cause,
        reason: 'Held for the test',
      });

  it('says on a hold for Martin that its signal cleared, and that closing its pull request verifies it', () => {
    const item = foldItem(held('merge').add(40, 'signal.rechecked', 'probe', look('cleared')).events);
    expect(item && clearanceWords(item)).toBe(
      'Its signal cleared on d728dbe, a release that carried work item #1033, not this one’s fix: the probe saw “products journey” pass there. Closing its pull request closes it as verified.',
    );
    const sheet = projectSheet(project(item?.events ?? [], Date.parse('2026-10-03T10:00:00Z')), '1');
    expect(sheet?.chapters.map((c) => c.label)).toContain('CLEARED');
  });

  it('says on its row only on which version its signal cleared, the rest on its sheet', () => {
    const item = held('gates').add(40, 'signal.rechecked', 'probe', look('cleared'));
    const row = project(item.events, item.at(41)).panels.gates.rows.find((r) => r.item === '1');
    expect(row?.note).toBe('Needs you · held by a gate · cleared on d728dbe');
  });

  it('forgets the clearance once a signal is seen on that version, or a later look sees it', () => {
    const cleared = held('merge').add(40, 'signal.rechecked', 'probe', look('cleared'));
    const again = foldItem(
      cleared.add(41, 'signal.received', 'probe', { ...payloads.signal, version: 'd728dbe' }).events,
    );
    expect(again?.cleared).toBeUndefined();
    const later = foldItem(
      held('merge')
        .add(40, 'signal.rechecked', 'probe', look('cleared'))
        .add(50, 'signal.rechecked', 'probe', look('persists')).events,
    );
    expect(later?.cleared).toBeUndefined();
  });

  it('ends the story of one closed as verified by its look, saying what the release carried', () => {
    const events = held('gates')
      .add(40, 'signal.rechecked', 'probe', look('cleared'))
      .add(41, 'work-item.closed', 'factory', { outcome: 'verified', reason: 'Cleared on a release' }).events;
    const sheet = projectSheet(project(events, Date.parse('2026-10-03T10:00:00Z')), '1');
    expect(sheet?.closing).toBe(
      'It was verified on d728dbe by the probe’s check “products journey”, on a release that carried work item #1033, not this one’s fix, and closed.',
    );
  });
});

describe('an open ticket looked at as the line took it', () => {
  const taken = (payload: PayloadOf<'signal.rechecked'>) =>
    work('3').open().add(1, 'signal.received', 'probe', payloads.signal).add(30, 'signal.rechecked', 'probe', payload);
  const atTake = {
    ...look('cleared'),
    for: 'take',
    carried: ['1009', '1012'],
    since: 'f5c6b9c',
    merged: [{ workItem: '1009', pullRequest: 120 }],
  } satisfies PayloadOf<'signal.rechecked'>;

  it('ends the story of one closed by it, naming the fixes released since its signal was last seen', () => {
    const events = taken(atTake).add(31, 'work-item.closed', 'factory', {
      outcome: 'verified',
      reason: 'Cleared as the line took it',
    }).events;
    const sheet = projectSheet(project(events, Date.parse('2026-10-03T10:00:00Z')), '3');
    expect(sheet?.closing).toBe(
      'It was verified on d728dbe by the probe’s check “products journey”, on a version released since f5c6b9c, where its signal was last seen, with the fixes of work items #1009 (pull request #120) and #1012, and closed.',
    );
    expect(sheet?.chapters.map((c) => c.label)).toContain('CLEARED');
  });

  it('says so when the releases since carried none of the factory’s fixes', () => {
    const events = taken({ ...atTake, carried: [], merged: undefined }).add(31, 'work-item.closed', 'factory', {
      outcome: 'verified',
      reason: 'Cleared as the line took it',
    }).events;
    expect(projectSheet(project(events, Date.parse('2026-10-03T10:00:00Z')), '3')?.closing).toBe(
      'It was verified on d728dbe by the probe’s check “products journey”, on a version released since f5c6b9c, where its signal was last seen, with none of the factory’s fixes, and closed.',
    );
  });

  it('marks a look that could not tell as unsure, as the work goes on to Plan', () => {
    const { why: _, ...cleared } = atTake;
    const unsure = { ...cleared, outcome: 'unsure', why: 'the check could not tell' } as const;
    const sheet = projectSheet(project(taken(unsure).events, Date.parse('2026-10-03T10:00:00Z')), '3');
    expect(sheet?.chapters.map((c) => c.label)).toContain('UNSURE');
  });
});

describe('a spec on a card', () => {
  const spec = {
    outcome: 'Every product loads',
    criteria: [{ given: 'the products page', when: 'it opens', expect: 'every product is there' }],
    scope: ['src/products.ts'],
    risks: [],
    rollout: 'A normal release.',
  } satisfies PayloadOf<'spec.written'>;
  const planned = () => work('2').open().add(1, 'spec.written', 'planner', spec);
  const pictureOf = (events: ReturnType<typeof work>) => project(events.events, events.at(60)).cards[0]?.picture;

  it('waits for Martin, with the planner’s question, while it holds for his answer', () => {
    const held = planned().add(2, 'hold.started', 'factory', {
      stage: 'plan',
      kind: 'approval',
      cause: 'spec',
      reason: 'The spec waits for Martin',
      question: 'Should sold-out products show?',
    });
    expect(pictureOf(held)).toMatchObject({ type: 'spec', waiting: true, question: 'Should sold-out products show?' });
  });

  it('waits for nobody when Martin is asked something else, and keeps that question off the spec', () => {
    const held = planned().add(2, 'hold.started', 'factory', {
      stage: 'build',
      kind: 'question',
      cause: 'question',
      reason: 'The coder needs an answer',
      question: 'Use the second API?',
    });
    expect(pictureOf(held)).toMatchObject({ type: 'spec', waiting: false, question: undefined });
  });

  it('waits for nobody once the work item closes with nothing better to show', () => {
    const closed = planned().add(2, 'work-item.closed', 'factory', { outcome: 'no-change', reason: 'Nothing to fix' });
    expect(pictureOf(closed)).toMatchObject({ type: 'spec', waiting: false, question: undefined });
  });
});
