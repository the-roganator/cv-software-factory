/**
 * Milestone 5's states (the design system's README, "Fixing"), projected from the samples' milestone 5 work items:
 * the spec and its scope, the rounds, the review thread, the gates by attempt, a round on the line, the wait for
 * Martin's merge, the four holds, a local model, and the describer's step; and a merge waiting for a release, which
 * only a dry run's merge does now, at the moment #1310's does.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { attempts } from '../../web/src/projection/fixing.ts';
import { project, projectSheet } from '../../web/src/projection/index.ts';
import { foldItem } from '../../web/src/projection/items.ts';
import { END, MERGE_WAITING, payloads, SAMPLES, work } from './support.ts';

const view = project(SAMPLES, END);
const card = (number: string) => view.cards.find((c) => c.number === number);
const sheet = (number: string) => projectSheet(SAMPLES, number, END);

describe('the wait for Martin’s merge', () => {
  it('shows the pull request he is asked to merge, not the spec', () => {
    expect(card('1311')).toMatchObject({ outcome: 'needs-you', pullRequest: 1312 });
    expect(card('1311')?.picture).toEqual({
      type: 'merge',
      pullRequest: 1312,
      title: 'fix(basket): take quantities of any length',
      checks: { passed: 12, total: 12 },
      testsFirst: { failedOnBase: true, figure: '3 of 3' },
      // The first review's suggestion went back with its blocking findings, and the coder took it.
      review: { suggestions: 0, number: 2 },
      // The whole change a merge brings in, both rounds together; the second round's own files were fewer.
      files: 2,
      added: 30,
      removed: 5,
      inScope: true,
    });
  });

  it('counts the suggestions of the approval it waits on, even one the coder declined', () => {
    const hold = SAMPLES.find(
      (e) => e.work_item === '1304' && e.type === 'hold.started' && e.payload.cause === 'merge',
    );
    const waiting = project(SAMPLES, Date.parse(hold?.ts ?? '')).cards.find((c) => c.number === '1304');
    expect(waiting?.picture).toMatchObject({ type: 'merge', review: { suggestions: 1, number: 1 } });
  });

  it('keeps the problem’s own evidence in the sheet', () => {
    expect(sheet('1311')?.evidence.type).toBe('http');
  });

  it('is a row in Review’s panel, waiting for the merge', () => {
    expect(view.panels.review.rows.find((row) => row.item === '1311')).toMatchObject({
      note: 'Needs you · waiting for Martin’s merge',
      tone: 'attn',
    });
  });

  it('ends the rounds, saying since when', () => {
    expect(sheet('1311')?.after).toMatchObject({ outcome: 'needs-you' });
    expect(sheet('1311')?.after?.text).toMatch(/^Described, ready, and waiting for Martin’s merge since \d\d:\d\d$/);
  });
});

describe('a merged fix', () => {
  // Every merge waits for Martin's deploy now, but for a dry run's, which no deploy can carry: #1310's waits at
  // Release, unheld, for the minute until the dry run releases it.
  const at = MERGE_WAITING;
  const then = project(SAMPLES, at);

  it('waits at Release for a release, in the quiet tone, with Review passed', () => {
    expect(then.cards.find((c) => c.number === '1310')).toMatchObject({
      outcome: 'merged',
      segments: [...Array(6).fill('passed'), 'queued', 'none'],
    });
    expect(then.stations.find((s) => s.stage === 'release')).toMatchObject({
      status: 'idle',
      figure: '1 waiting',
      queued: 1,
    });
    expect(then.panels.release.rows).toContainEqual(
      expect.objectContaining({ item: '1310', note: 'Merged · waiting for release', tone: 'faint' }),
    );
  });

  it('ends its story at the merge, drawn as work waiting', () => {
    const story = projectSheet(SAMPLES, '1310', at)?.chapters;
    expect(story?.at(-1)).toMatchObject({ label: 'MERGED', waiting: true, tone: 'faint' });
    expect(story?.map((c) => c.label)).not.toContain('NOW');
  });

  it('is merged by the merge alone: the line writes no answer to the wait', () => {
    const events = work('1')
      .open()
      .add(1, 'hold.started', 'factory', {
        stage: 'review',
        kind: 'approval',
        cause: 'merge',
        reason: 'Waits for the merge',
      })
      .add(2, 'pull-request.merged', 'martin', { number: 2, commit: 'b'.repeat(40), by: 'martin' }).events;
    const [merged] = project(events, work('1').at(3)).cards;
    expect(merged?.outcome).toBe('merged');
  });

  it('is not asked of Martin again by a later hold that said it was', () => {
    const merge = 'Waiting for Martin to merge';
    const events = work('1')
      .open()
      .add(1, 'hold.started', 'factory', { stage: 'review', kind: 'approval', cause: 'merge', reason: 'Merge' }, merge)
      .add(2, 'pull-request.merged', 'martin', { number: 2, commit: 'b'.repeat(40), by: 'martin' })
      .add(3, 'hold.started', 'factory', { stage: 'release', kind: 'approval', cause: 'deploy', reason: 'D' }, merge)
      .add(4, 'hold.started', 'factory', { stage: 'verify', kind: 'approval', cause: 'verify', reason: 'V' }, merge)
      .add(
        5,
        'hold.started',
        'factory',
        { stage: 'verify', kind: 'approval', cause: 'verify', reason: 'V' },
        'Own words',
      ).events;
    const waits = projectSheet(events, '1', work('1').at(6))
      ?.chapters.filter((c) => c.label === 'WAITING')
      .map((c) => c.text);
    expect(waits).toEqual([
      merge,
      'Waiting for a deploy pull request to carry the fix',
      'Waiting for Martin to judge whether the fix cleared it',
      'Own words',
    ]);
    const held = events.slice(0, -1);
    expect(project(held, work('1').at(6)).cards[0]?.description).toBe(
      'Waiting for Martin to judge whether the fix cleared it',
    );
  });
});

describe('a fix whose branch was brought up to date while it waited for the merge', () => {
  const updated = 'd'.repeat(40);
  const story = work('1')
    .open()
    .add(0, 'pull-request.pushed', 'coder', {
      number: 7,
      title: 'fix(products): load them all',
      branch: 'factory/1-products',
      attempt: 1,
      testsFirst: true,
      files: [{ path: 'src/products.ts', added: 1, removed: 1 }],
      whole: [{ path: 'src/products.ts', added: 1, removed: 1 }],
    })
    .add(1, 'gates.started', 'actions', payloads.gatesStarted)
    .add(3, 'gates.finished', 'actions', payloads.gatesPassed)
    .add(4, 'review.submitted', 'reviewer', { pullRequest: 7, verdict: 'approved', note: 'Fine', findings: [] })
    .add(5, 'hold.started', 'factory', { stage: 'review', kind: 'approval', cause: 'merge', reason: 'Waits' })
    .add(6, 'gates.started', 'actions', { ...payloads.gatesStarted, commit: updated })
    .add(9, 'gates.finished', 'actions', { ...payloads.gatesPassed, commit: updated })
    .add(10, 'pull-request.merged', 'martin', { number: 7, commit: 'c'.repeat(40), by: 'martin' });

  it('waits at Review while its gates run again, as the line does, and leaves Review for Release', () => {
    expect(foldItem(story.events.slice(0, 7))?.stage).toBe('review');
    const merged = foldItem(story.events);
    expect(merged?.stage).toBe('release');
    expect(merged?.visits.gates?.leftAt).toBe(story.at(4));
    expect(merged?.visits.review?.leftAt).toBe(story.at(10));
  });

  it('shows its round on the newer commit, with the gates that passed there', () => {
    const item = foldItem(story.events);
    expect(item && attempts(item)).toMatchObject([{ attempt: 1, commit: updated, gates: { state: 'passed' } }]);
  });
});

describe('a fix whose branch was brought up to date while the reviewer had it', () => {
  const updated = 'e'.repeat(40);
  const story = work('1')
    .open()
    .add(0, 'pull-request.pushed', 'coder', {
      number: 7,
      title: 'fix(products): load them all',
      branch: 'factory/1-products',
      attempt: 1,
      testsFirst: true,
      files: [{ path: 'src/products.ts', added: 1, removed: 1 }],
      whole: [{ path: 'src/products.ts', added: 1, removed: 1 }],
    })
    .add(1, 'gates.started', 'actions', payloads.gatesStarted)
    .add(3, 'gates.finished', 'actions', payloads.gatesPassed)
    .add(4, 'gates.started', 'actions', { ...payloads.gatesStarted, commit: updated })
    .add(7, 'gates.finished', 'actions', { ...payloads.gatesFailed, commit: updated });

  it('shows the gates running again and the review still in hand, as the gates that passed stand until they end', () => {
    const running = projectSheet(story.events, '1', story.at(5));
    expect(running?.rounds.map((a) => a.gates?.state)).toEqual(['running']);
    expect(running?.roundsNow.reviewing).toBe(true);
  });

  it('takes the review out of hand once the newer run fails', () => {
    const failed = projectSheet(story.events, '1', story.at(8));
    expect(failed?.rounds.map((a) => a.gates?.state)).toEqual(['failed']);
    expect(failed?.roundsNow.reviewing).toBe(false);
  });
});

describe('a fix whose gates fail on a branch brought up to date while it waited for the merge', () => {
  const updated = 'd'.repeat(40);
  const story = work('1')
    .open()
    .add(0, 'pull-request.pushed', 'coder', {
      number: 7,
      title: 'fix(products): load them all',
      branch: 'factory/1-products',
      attempt: 1,
      testsFirst: true,
      files: [{ path: 'src/products.ts', added: 1, removed: 1 }],
      whole: [{ path: 'src/products.ts', added: 1, removed: 1 }],
    })
    .add(1, 'gates.started', 'actions', payloads.gatesStarted)
    .add(3, 'gates.finished', 'actions', payloads.gatesPassed)
    .add(4, 'review.submitted', 'reviewer', { pullRequest: 7, verdict: 'approved', note: 'Fine', findings: [] })
    .add(5, 'hold.started', 'factory', { stage: 'review', kind: 'approval', cause: 'merge', reason: 'Waits' })
    .add(6, 'gates.started', 'actions', { ...payloads.gatesStarted, commit: updated })
    .add(9, 'gates.finished', 'actions', { ...payloads.gatesFailed, commit: updated })
    .add(9, 'work.returned', 'factory', {
      from: 'gates',
      to: 'build',
      reason: 'The gates failed: Unit tests',
      round: 2,
      failed: ['Unit tests'],
    });

  it('stops waiting for the merge and goes back through Gates to Build, as the line sends it', () => {
    expect(foldItem(story.events.slice(0, 7))).toMatchObject({ stage: 'review', outcome: 'needs-you' });
    const failed = foldItem(story.events.slice(0, 8));
    expect(failed).toMatchObject({ stage: 'gates', hold: undefined, outcome: 'in-progress' });
    expect(failed?.failure?.stage).toBe('gates');
    expect(foldItem(story.events)).toMatchObject({ stage: 'build', hold: undefined, outcome: 'in-progress' });
  });

  it('stays at Build when the work already went back there before the run failed', () => {
    const returned = work('1').add(7, 'work.returned', 'reviewer', {
      from: 'review',
      to: 'build',
      reason: 'Martin sent it back: Name the test',
      round: 2,
    }).events;
    const item = foldItem([...story.events.slice(0, 5), ...returned, ...story.events.slice(6, 8)]);
    expect(item).toMatchObject({ stage: 'build' });
  });

  it('leaves Review for Release when Martin merged over the failure, recorded with the merge', () => {
    const merged = foldItem([
      ...story.events.slice(0, 8),
      ...work('1').add(9, 'pull-request.merged', 'martin', { number: 7, commit: 'c'.repeat(40), by: 'martin' }).events,
    ]);
    expect(merged).toMatchObject({ stage: 'release', hold: undefined });
    expect(merged?.visits.review?.leftAt).toBe(story.at(9));
  });
});

describe('a refusal, by its mechanism', () => {
  const refused = (mechanism: 'gateway' | 'review-gate', guardrails: number[]) =>
    ({
      mechanism,
      guardrails,
      action: 'The coder’s call',
      output: 'refused',
    }) satisfies PayloadOf<'action.refused'>;
  const built = () =>
    work('1')
      .open()
      .add(2, 'pull-request.pushed', 'coder', {
        number: 7,
        title: 'fix(products): load them all',
        branch: 'factory/1-products',
        attempt: 1,
        testsFirst: true,
        files: [{ path: 'src/products.ts', added: 1, removed: 1 }],
        whole: [{ path: 'src/products.ts', added: 1, removed: 1 }],
      });

  it('fails the work item at the stage it was at, for the gateway, and leaves it there', () => {
    const item = foldItem(built().add(3, 'action.refused', 'factory', refused('gateway', [7])).events);
    expect(item?.stage).toBe('build');
    expect(item?.failure?.stage).toBe('build');
  });

  it('fails it at the stage it was at, for admission control refusing a runner’s step, and leaves it there', () => {
    const runner = {
      mechanism: 'admission-control',
      guardrails: [3],
      action: 'Create a pod for Job runners/coder-1-1-1-agent',
      output: 'admission webhook "ivpol.kyverno.svc-fail" denied the request',
      subject: { namespace: 'runners', kind: 'Job', name: 'coder-1-1-1-agent' },
    } satisfies PayloadOf<'action.refused'>;
    const item = foldItem(built().add(3, 'action.refused', 'factory', runner).events);
    expect(item?.stage).toBe('build');
    expect(item?.failure?.stage).toBe('build');
  });

  it('moves it to its mechanism’s stage, and fails it there, for every other mechanism', () => {
    const item = foldItem(built().add(3, 'action.refused', 'factory', refused('review-gate', [2])).events);
    expect(item?.stage).toBe('gates');
    expect(item?.failure?.stage).toBe('gates');
  });
});

describe('a fix held for a human', () => {
  it('by the scope fence: its own output, and the refusal before it', () => {
    expect(card('1315')?.picture).toMatchObject({
      type: 'scope',
      patch: 2,
      refusals: 2,
      earlier: { patch: 1, same: true },
      reachedGitHub: false,
    });
    expect(card('1315')?.picture).toHaveProperty('output', expect.stringContaining('refused src/catalogue.ts +9 −3'));
  });

  it('by the tests-first check: its own output, run on the base', () => {
    expect(card('1317')?.picture).toMatchObject({
      type: 'tests-pass',
      output: expect.stringContaining('0 of 2 new tests fail before the fix'),
    });
  });

  it('at its spend cap: what it spent, by agent, and the step it stopped', () => {
    const picture = card('1319')?.picture;
    expect(picture).toMatchObject({ type: 'spend', stage: 'build', cap: 5, stopped: { agent: 'coder', step: 2 } });
    if (picture?.type !== 'spend') throw new Error('not a spend picture');
    expect(picture.spent).toBeCloseTo(5.03, 2);
    expect(picture.agents.map((a) => [a.agent, a.steps])).toEqual([
      ['planner', 1],
      ['coder', 2],
      ['reviewer', 1],
    ]);
  });

  it('still blocking after two reviews: the open finding, its rule, and the reviews it blocked', () => {
    expect(card('1323')?.picture).toEqual({
      type: 'blocking',
      reviews: 2,
      findings: [
        {
          where: 'test/discount.test.ts:16',
          cites: 'rule 3, test at the seams',
          comment: 'The test still calls matchCode() directly instead of applying the code through the shop.',
          reviews: [1, 2],
        },
      ],
    });
  });

  it('still blocking: counts the reviews of its pass, which the line bounds alone, by their numbers in the thread', () => {
    const finding = { path: 'src/money.ts', line: 3, blocking: true, rule: 3, comment: 'Test through the shop.' };
    const review: PayloadOf<'review.submitted'> = {
      pullRequest: 7,
      verdict: 'changes-requested',
      note: 'Not yet.',
      findings: [finding],
    };
    const events = work('3002')
      .open()
      .add(1, 'review.submitted', 'reviewer', review)
      .add(2, 'work.returned', 'factory', { from: 'verify', to: 'plan', reason: 'It persists' })
      .add(3, 'review.submitted', 'reviewer', { ...review, pullRequest: 8 })
      .add(3.1, 'hold.started', 'factory', {
        stage: 'review',
        kind: 'held',
        cause: 'review',
        reason: 'Not yet.',
      }).events;
    expect(project(events, Date.parse(events.at(-1)?.ts ?? '')).cards[0]?.picture).toMatchObject({
      type: 'blocking',
      reviews: 1,
      findings: [{ where: 'src/money.ts:3', reviews: [2] }],
    });
  });

  it('beyond its ticket: the blocking finding that cites the ticket, as a held review shows its own', () => {
    const finding = { path: 'src/money.ts', line: 3, blocking: true, criterion: 2, ticket: true as const };
    const events = work('3001')
      .open()
      .add(1, 'review.submitted', 'reviewer', {
        pullRequest: 7,
        verdict: 'escalated',
        note: 'Criterion 2 is not in the ticket.',
        findings: [{ ...finding, comment: 'No evidence asks for thousands separators.' }],
      })
      .add(1.1, 'hold.started', 'factory', {
        stage: 'review',
        kind: 'held',
        cause: 'beyond-ticket',
        reason: 'Criterion 2 is not in the ticket.',
      }).events;
    expect(project(events, Date.parse(events.at(-1)?.ts ?? '')).cards[0]?.picture).toEqual({
      type: 'blocking',
      reviews: 1,
      findings: [
        {
          where: 'src/money.ts:3',
          cites: 'the ticket',
          comment: 'No evidence asks for thousands separators.',
          reviews: [1],
        },
      ],
    });
  });
});

describe('the sheet of a fix', () => {
  it('says the describer wrote its story', () => {
    expect(sheet('1311')?.storyBy).toBe('describer');
    expect(sheet('1315')?.storyBy).toBeUndefined();
  });

  it('shows the spec’s scope with what the pull request changes in it, every round together', () => {
    expect(sheet('1311')?.scope).toEqual({
      of: { pullRequest: 1312 },
      rows: [
        { path: 'src/pages/basket.ts', added: 3, removed: 5, outside: false },
        { path: 'test/basket.test.ts', added: 27, removed: 0, outside: false },
        { path: 'test/support/shop.ts', added: undefined, removed: undefined, outside: false },
      ],
    });
  });

  it('shows a path cut to what an event records outside the scope unless a folder the scope allows holds it', () => {
    const cut = `docs/${'a'.repeat(194)}…`;
    const pushes = SAMPLES.filter((e) => e.work_item === '1311' && e.type === 'pull-request.pushed');
    const withScope = (entry: string) =>
      SAMPLES.map((e) => {
        if (e.work_item !== '1311') return e;
        if (e.type === 'spec.written') return { ...e, payload: { ...e.payload, scope: [...e.payload.scope, entry] } };
        if (e === pushes.at(-1) && e.type === 'pull-request.pushed')
          return {
            ...e,
            payload: {
              ...e.payload,
              whole: [...e.payload.whole, { path: cut, added: 1, removed: 0, cut: true as const }],
            },
          };
        return e;
      });
    // `docs/*` takes in what was kept, one segment, but what was cut off may hold more.
    const pattern = withScope('docs/*');
    expect(projectSheet(pattern, '1311', END)?.scope?.rows.slice(-2)).toEqual([
      { path: 'docs/*', added: undefined, removed: undefined, outside: false },
      { path: cut, added: 1, removed: 0, outside: true },
    ]);
    expect(project(pattern, END).cards.find((c) => c.number === '1311')?.picture).toMatchObject({
      type: 'merge',
      files: 3,
      inScope: false,
    });
    const folder = withScope('docs/');
    expect(projectSheet(folder, '1311', END)?.scope?.rows.at(-1)).toEqual({
      path: 'docs/',
      added: 1,
      removed: 0,
      outside: false,
    });
    expect(project(folder, END).cards.find((c) => c.number === '1311')?.picture).toMatchObject({ inScope: true });
  });

  it('shows a refused patch’s path outside the scope', () => {
    expect(sheet('1315')?.scope?.rows.at(-1)).toEqual({
      path: 'src/catalogue.ts',
      added: 9,
      removed: 3,
      outside: true,
    });
  });

  it('lists each attempt with its gates, its review, and the return between them', () => {
    const rounds = sheet('1311')?.rounds ?? [];
    // Each attempt's own files: the second round's are what it changed on top of the first.
    expect(rounds.map((a) => [a.attempt, a.how, a.files, a.added, a.removed])).toEqual([
      [1, 'tests first', 2, 22, 3],
      [2, 'resumed', 2, 17, 9],
    ]);
    expect(rounds[0]?.gates).toMatchObject({
      state: 'passed',
      passed: 12,
      total: 12,
      testsFirst: { failedOnBase: true, figure: '2 of 2' },
    });
    expect(rounds[0]?.review).toEqual({ number: 1, verdict: 'changes-requested', blocking: 2, suggestions: 1 });
    expect(rounds[0]?.returned).toEqual({ from: 'review', detail: '2 blocking' });
    expect(rounds[1]?.review).toMatchObject({ number: 2, verdict: 'approved' });
    expect(rounds[1]?.returned).toBeUndefined();
    expect(sheet('1311')?.facts.reviews).toEqual({ done: 2, of: 2 });
  });

  it('ends a round whose suggestions the coder declined in full with its return, and no attempt after it', () => {
    const rounds = sheet('1304')?.rounds ?? [];
    expect(rounds.map((a) => a.attempt)).toEqual([1]);
    expect(rounds[0]?.review).toEqual({ number: 1, verdict: 'approved', blocking: 0, suggestions: 1 });
    expect(rounds[0]?.returned).toEqual({ from: 'review', detail: '1 suggestion, declined', declined: true });
    expect(sheet('1304')?.facts.reviews).toEqual({ done: 1, of: 2 });
    // The coder pushed nothing for it, so no round follows the return.
    expect(sheet('1304')?.roundsNow.next).toBeUndefined();
  });

  it('prints each finding’s rule in full, and a criterion in the spec’s words', () => {
    const [first] = sheet('1311')?.review ?? [];
    expect(first).toMatchObject({ number: 1, attempt: 1, verdict: 'changes-requested' });
    expect(first?.findings[0]?.rule).toEqual({
      number: 3,
      title: 'Test at the seams',
      text: expect.stringContaining('Tests go through the app over HTTP'),
    });
    const [criterion] = sheet('1319')?.review[0]?.findings ?? [];
    expect(criterion?.criterion).toEqual({
      number: 2,
      text: 'GIVEN a wishlist of three WHEN one is removed THEN the other two stay',
    });
  });

  it('shows the gates of the attempt that counts, with the signals apart and a line for the one before', () => {
    const shown = sheet('1311');
    expect(shown?.gatesAttempt).toBe(2);
    expect(shown?.gates).toHaveLength(12);
    expect(shown?.gates.every((g) => g.required)).toBe(true);
    expect(shown?.signals.map((g) => [g.check, g.conclusion, g.summary])).toEqual([
      ['Tests first', 'success', '3 of 3 new tests fail on the base'],
      ['factory review', 'success', 'approved, review 2'],
    ]);
    expect(shown?.earlier).toEqual(['Attempt 1 passed every required check; the reviewer sent it back.']);
  });
});

describe('agents and models', () => {
  it('counts an agent’s steps, and puts the describer last', () => {
    const agents = sheet('1311')?.agents ?? [];
    expect(agents.map((a) => [a.agent, a.steps])).toEqual([
      ['planner', 1],
      ['coder', 2],
      ['reviewer', 2],
      ['describer', 1],
    ]);
    expect(agents[1]?.details).toEqual(['effort medium · ≤ 40 turns · 2 steps']);
  });

  it('says a local model served every call, at no cost', () => {
    expect(card('1304')).toMatchObject({ local: true, spend: 0 });
    expect(sheet('1304')?.agents.every((a) => a.provider === 'local' && a.model === 'qwen/qwen3.8-27b')).toBe(true);
    expect(card('1311')?.local).toBe(false);
  });
});

describe('a round on the line', () => {
  it('draws only the return whose work has not moved on since', () => {
    expect(view.returns.map((r) => r.text)).toEqual(['#1325 · round 3 · 1 blocking']);
  });

  it('keeps each return as a row in Review’s panel, one row per work item', () => {
    const rows = view.panels.review.rows.map((r) => [r.item, r.earlier, r.note.slice(0, 26)]);
    expect(rows).toEqual([
      ['1323', ['sent back'], 'Needs you · held by review'],
      ['1311', [], 'Needs you · waiting for Ma'],
      ['1325', [], 'Sent back to Build · round'],
      ['1321', [], 'passed on to release'],
      ['1319', [], 'Sent back to Build · round'],
      ['1314', [], 'passed on to release'],
    ]);
  });
});

describe('a fix sent back by the gates and then by the reviewer', () => {
  it('counts reviews, not attempts, against the limit', () => {
    expect(sheet('1325')?.facts.reviews).toEqual({ done: 1, of: 2 });
    expect(sheet('1325')?.rounds.map((a) => [a.attempt, a.returned])).toEqual([
      [1, { from: 'gates', detail: '1 check failed' }],
      [2, { from: 'review', detail: '1 blocking' }],
    ]);
  });

  it('draws the round a return sends it into at once, the coder at work on it, before it pushes', () => {
    // The gates sent round 1 back at 14:15:55; the coder pushed round 2 at 14:19:00.
    const between = projectSheet(SAMPLES, '1325', Date.parse('2026-10-06T14:17:00Z'));
    expect(between?.rounds.map((a) => a.attempt)).toEqual([1]);
    expect(between?.roundsNow).toEqual({ next: { attempt: 2, building: true }, reviewing: false });
    // And at the end, the reviewer's return waits for round 3.
    expect(sheet('1325')?.roundsNow.next).toEqual({ attempt: 3, building: true });
  });

  it('draws no next round once a return to Plan starts a new pass', () => {
    const end = Date.parse('2026-10-06T14:24:00Z');
    const events = SAMPLES.filter((e) => e.work_item === '1325' && Date.parse(e.ts) <= end);
    const back = events.at(-1);
    if (back?.type !== 'work.returned') throw new Error('expected #1325 to end on its return');
    const replanned = [
      ...events,
      {
        ...back,
        id: `${back.id}-plan`,
        ts: '2026-10-06T14:24:00.000Z',
        payload: { ...back.payload, from: 'build' as const, to: 'plan' as const },
      },
    ];
    expect(projectSheet(replanned, '1325', end)?.roundsNow.next).toBeUndefined();
    // And back at Build in the new pass, the coder at work before its first push: no round 3 from the pass before.
    const coding = events.find((e) => e.type === 'model.called' && e.actor === 'coder');
    if (!coding) throw new Error('expected #1325 to have the coder’s call');
    const rebuilding = [...replanned, { ...coding, id: `${coding.id}-again`, ts: '2026-10-06T14:25:00.000Z' }];
    const later = Date.parse('2026-10-06T14:25:00Z');
    expect(projectSheet(rebuilding, '1325', later)?.card.segments[3]).toBe('now');
    expect(projectSheet(rebuilding, '1325', later)?.roundsNow.next).toBeUndefined();
  });

  it('knows each round by its pass and its number, as each pass starts again at round 1', () => {
    // #1306 went round twice: Verify sent it back to Plan, and its second pass began again at round 1.
    const rounds = sheet('1306')?.rounds ?? [];
    expect(rounds.map((a) => [a.pass, a.attempt])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(new Set(rounds.map((a) => `${a.pass}-${a.attempt}`)).size).toBe(rounds.length);
  });

  it('says which step of the last round is in hand: its gates, then its review', () => {
    const at = (time: string) => projectSheet(SAMPLES, '1325', Date.parse(time));
    const gating = at('2026-10-06T14:20:00Z');
    expect(gating?.rounds.at(-1)?.gates?.state).toBe('running');
    expect(gating?.roundsNow).toEqual({ next: undefined, reviewing: false });
    expect(at('2026-10-06T14:22:00Z')?.roundsNow).toEqual({ next: undefined, reviewing: true });
  });

  it('names the review apart from the attempt it reviewed', () => {
    expect(sheet('1325')?.review.map((r) => [r.number, r.attempt])).toEqual([[1, 2]]);
  });

  it('draws its last return from what the event records', () => {
    expect(view.returns.find((r) => r.item === '1325')).toMatchObject({
      text: '#1325 · round 3 · 1 blocking',
      detail: 'round 3 · 1 blocking',
    });
  });
});

describe('a fix sent back for an approval’s suggestions', () => {
  const FILES = [{ path: 'src/price.ts', added: 2, removed: 1 }];
  const pushed = (attempt: number) =>
    ({
      number: 9,
      title: 'fix(price): show pence',
      branch: 'factory/3-price',
      attempt,
      testsFirst: attempt === 1,
      files: FILES,
      whole: FILES,
    }) satisfies PayloadOf<'pull-request.pushed'>;
  const finding = (blocking: boolean) => ({ path: 'src/price.ts', line: 4, blocking, comment: 'Test 5 pence too.' });
  const reviewed = (verdict: 'approved' | 'changes-requested', blocking: number, suggestions: number) =>
    ({
      pullRequest: 9,
      verdict,
      note: 'Reviewed.',
      findings: [
        ...Array.from({ length: blocking }, () => finding(true)),
        ...Array.from({ length: suggestions }, () => finding(false)),
      ],
    }) satisfies PayloadOf<'review.submitted'>;
  const back = (round: number, figures: { blocking: number } | { suggestions: number }) =>
    ({ from: 'review', to: 'build', reason: 'Sent back', round, ...figures }) satisfies PayloadOf<'work.returned'>;
  const sheetOf = (events: ReturnType<typeof work>) => projectSheet(events.events, '3', events.at(60));
  const fix = () => work('3').open().add(1, 'pull-request.pushed', 'coder', pushed(1));

  it('counts the review after the suggestions round against the most there may now be', () => {
    const events = fix()
      .add(2, 'review.submitted', 'reviewer', reviewed('changes-requested', 1, 0))
      .add(3, 'work.returned', 'factory', back(2, { blocking: 1 }))
      .add(4, 'pull-request.pushed', 'coder', pushed(2))
      .add(5, 'review.submitted', 'reviewer', reviewed('approved', 0, 2))
      .add(6, 'work.returned', 'factory', back(3, { suggestions: 2 }))
      .add(7, 'pull-request.pushed', 'coder', pushed(3))
      .add(8, 'suggestions.answered', 'coder', { pullRequest: 9, suggestions: 2, declined: [] })
      .add(9, 'review.submitted', 'reviewer', reviewed('approved', 0, 0));
    expect(sheetOf(events)?.facts.reviews).toEqual({ done: 3, of: 3 });
    expect(sheetOf(events)?.rounds.map((a) => a.returned?.detail)).toEqual(['1 blocking', '2 suggestions', undefined]);
  });

  it('keeps the limit when the suggestions round comes first, since a review that blocks after it holds', () => {
    const events = fix()
      .add(2, 'review.submitted', 'reviewer', reviewed('approved', 0, 1))
      .add(3, 'work.returned', 'factory', back(2, { suggestions: 1 }))
      .add(4, 'pull-request.pushed', 'coder', pushed(2))
      .add(5, 'review.submitted', 'reviewer', reviewed('changes-requested', 1, 0));
    expect(sheetOf(events)?.facts.reviews).toEqual({ done: 2, of: 2 });
  });

  it('says the coder declined them all when no attempt follows the return', () => {
    const reason = 'Its callers are outside the scope.';
    const events = fix()
      .add(2, 'review.submitted', 'reviewer', reviewed('approved', 0, 2))
      .add(3, 'work.returned', 'factory', back(2, { suggestions: 2 }))
      .add(4, 'suggestions.answered', 'coder', {
        pullRequest: 9,
        suggestions: 2,
        declined: [
          { suggestion: 1, reason },
          { suggestion: 2, reason },
        ],
      });
    expect(sheetOf(events)?.rounds.map((a) => a.returned)).toEqual([
      { from: 'review', detail: '2 suggestions, declined', declined: true },
    ]);
    expect(sheetOf(events)?.facts.reviews).toEqual({ done: 1, of: 2 });
  });
});

/** A fix the line holds, from its events: the four holds whose pictures once were guessed from the evidence. */
describe('a hold’s picture, by its cause', () => {
  const SPEC = {
    outcome: 'Search takes any word',
    criteria: [{ given: 'a long word', when: 'it is searched', expect: 'it is found' }],
    scope: ['src/search.ts', 'test/'],
    risks: [],
    rollout: 'A normal release.',
  } satisfies PayloadOf<'spec.written'>;
  const FILES = [{ path: 'src/search.ts', added: 1, removed: 1 }];
  const PUSHED = {
    number: 9,
    title: 'fix(search): take any word',
    branch: 'factory/2-search',
    attempt: 1,
    testsFirst: false,
    files: FILES,
    whole: FILES,
  } satisfies PayloadOf<'pull-request.pushed'>;
  const refused = (path: string) =>
    ({
      mechanism: 'scope-fence',
      guardrails: [11],
      action: 'Push the coder’s round 1',
      output: `scope: src/search.ts, test/\nrefused ${path} +1 −1`,
      files: [{ path, added: 1, removed: 1, allowed: false }],
    }) satisfies PayloadOf<'action.refused'>;
  const held = (stage: PayloadOf<'hold.started'>['stage'], cause: PayloadOf<'hold.started'>['cause']) =>
    ({ stage, kind: 'held', cause, reason: 'Held for Martin' }) satisfies PayloadOf<'hold.started'>;
  const pictureOf = (events: ReturnType<typeof work>) => project(events.events, events.at(60)).cards[0]?.picture;
  const fix = () => work('2').open().add(1, 'spec.written', 'planner', SPEC);

  it('counts the fence’s refusals since Martin last answered, as the line does, not since the last push', () => {
    const events = fix()
      .add(2, 'action.refused', 'factory', refused('src/server.ts'))
      .add(3, 'pull-request.pushed', 'coder', PUSHED)
      .add(4, 'action.refused', 'factory', refused('src/server.ts'))
      .add(5, 'hold.started', 'factory', held('build', 'scope'));
    expect(pictureOf(events)).toMatchObject({
      type: 'scope',
      patch: 3,
      refusals: 2,
      earlier: { patch: 1, same: true },
    });
  });

  it('draws no fence for a scope hold the coder asked for, after a refusal in its round', () => {
    const needs = [{ path: 'src/server.ts', reason: 'Its test assumes a search asks nothing.' }];
    const events = fix()
      .add(2, 'action.refused', 'factory', refused('src/server.ts'))
      .add(5, 'hold.started', 'coder', { ...held('build', 'scope'), needs });
    expect(pictureOf(events)?.type).not.toBe('scope');
  });

  it('draws no fence for a step that failed after a refusal', () => {
    const events = fix()
      .add(2, 'action.refused', 'factory', refused('src/server.ts'))
      .add(5, 'hold.started', 'factory', held('build', 'failures'));
    expect(pictureOf(events)?.type).not.toBe('scope');
  });

  it('draws no tests-first picture for a required check that kept failing', () => {
    const commit = 'c'.repeat(40);
    const run = { pullRequest: 9, commit, durationMs: 1000 };
    const events = fix()
      .add(3, 'pull-request.pushed', 'coder', PUSHED)
      .add(4, 'gates.started', 'actions', { pullRequest: 9, commit, checks: ['Unit tests', 'Tests first'] })
      .add(5, 'gate.finished', 'actions', { ...run, check: 'Unit tests', conclusion: 'failure', required: true })
      .add(5, 'gate.finished', 'actions', { ...run, check: 'Tests first', conclusion: 'failure', required: false })
      .add(6, 'gates.finished', 'actions', {
        pullRequest: 9,
        commit,
        conclusion: 'failed',
        passed: 0,
        failed: ['Unit tests'],
      })
      .add(7, 'hold.started', 'factory', held('gates', 'gates'));
    expect(pictureOf(events)?.type).not.toBe('tests-pass');
  });

  it('draws no findings still blocking for a reviewer that kept failing', () => {
    const events = fix()
      .add(3, 'pull-request.pushed', 'coder', PUSHED)
      .add(4, 'review.submitted', 'reviewer', {
        pullRequest: 9,
        verdict: 'changes-requested',
        note: 'One thing to change.',
        findings: [{ path: 'src/search.ts', line: 3, blocking: true, rule: 3, comment: 'Test through the shop.' }],
      })
      .add(5, 'hold.started', 'factory', held('review', 'failures'));
    expect(pictureOf(events)?.type).not.toBe('blocking');
  });

  it('draws the spend cap the hold records, and nothing without one', () => {
    const events = fix().add(5, 'hold.started', 'factory', { ...held('build', 'spend'), limitUsd: 2 });
    expect(pictureOf(events)).toMatchObject({ type: 'spend', cap: 2 });
    expect(pictureOf(fix().add(5, 'hold.started', 'factory', held('build', 'spend')))?.type).not.toBe('spend');
  });
});

describe('a story’s end', () => {
  it('is the console’s own sentence once the work item closes after its summary: verified on which version, by what', () => {
    expect(sheet('1304')?.closing).toBe(
      'It was verified on v0.9.8 by the probe’s check “the contact form sends”, and closed.',
    );
    // #1306 closed verified, and the same error came back: open again, its story has no end until it closes again.
    const closed = Date.parse(SAMPLES.find((e) => e.work_item === '1306' && e.type === 'work-item.closed')?.ts ?? '');
    expect(projectSheet(SAMPLES, '1306', closed)?.closing).toBe(
      'It was verified on v0.9.10 by the log watcher’s check “new error pattern”, and closed.',
    );
    expect(sheet('1306')?.closing).toBeUndefined();
    expect(sheet('1310')?.closing).toBe(
      'It closed on the dry run’s word: its release never shipped, so no sense looked.',
    );
  });

  it('is none while the work item is open, nor when its summary was written at its close', () => {
    expect(sheet('1311')?.closing).toBeUndefined();
    expect(sheet('1262')?.closing).toBeUndefined();
    expect(sheet('1268')?.closing).toBeUndefined();
  });

  const summarised = { title: 'Wrong words on /about', description: 'Two lines.', story: 'What happened.' };
  const changed = [{ path: 'src/pages/about.ts', added: 1, removed: 1 }];
  const pushed = { number: 5101, title: 'fix: the words', branch: 'fix/5100', attempt: 1, testsFirst: true };
  const fix = () =>
    work('5100')
      .open()
      .add(1, 'work-item.summarised', 'describer', summarised)
      .add(2, 'pull-request.pushed', 'coder', { ...pushed, files: changed, whole: changed });

  it('says Martin closed it, with his reason, or that its pull request closed unmerged', () => {
    const answered = fix().add(9, 'work-item.closed', 'factory', {
      outcome: 'no-change',
      reason: 'Martin agreed with the coder, saying: nothing to fix',
    }).events;
    expect(projectSheet(answered, '5100', Date.parse('2026-10-04T00:00:00Z'))?.closing).toBe(
      'It closed: Martin agreed with the coder, saying: nothing to fix.',
    );
    const unmerged = fix().add(9, 'work-item.closed', 'martin', {
      outcome: 'no-change',
      reason: 'Pull request #5101 was closed without being merged',
    }).events;
    expect(projectSheet(unmerged, '5100', Date.parse('2026-10-04T00:00:00Z'))?.closing).toBe(
      'It closed with pull request #5101 unmerged.',
    );
  });

  it('says how a metric verified it, and that Martin judged it cleared when Verify held it for him', () => {
    const verify = (outcome: 'cleared' | 'persists') => ({
      outcome,
      sense: 'metrics' as const,
      check: 'error rate',
      version: 'v0.9.12',
      against: 'v0.9.11',
      pages: [],
      dryRun: false,
    });
    const t = Date.parse('2026-10-04T00:00:00Z');
    const cleared = fix()
      .add(5, 'verification.finished', 'metrics', verify('cleared'))
      .add(6, 'work-item.closed', 'factory', {
        outcome: 'verified',
        reason: 'The error rate stayed inside its objective',
      });
    expect(projectSheet(cleared.events, '5100', t)?.closing).toBe(
      'It was verified on v0.9.12 by the metrics’ check “error rate”, and closed.',
    );
    const judged = fix()
      .add(5, 'verification.finished', 'metrics', verify('persists'))
      .add(6, 'hold.started', 'factory', {
        stage: 'verify',
        kind: 'approval',
        cause: 'verify',
        reason: 'Verify could not settle it',
      })
      .add(7, 'work-item.closed', 'factory', {
        outcome: 'verified',
        reason: 'Martin judged it cleared, saying: it is fine',
      });
    expect(projectSheet(judged.events, '5100', t)?.closing).toBe(
      'It closed: Martin judged it cleared, saying: it is fine.',
    );
  });

  it('drops the words triage once ended its summary with, where the work item stood then, and no one else’s', () => {
    const story = 'The probes found it. Triage opened ticket #5200 with the evidence the sense captured.';
    const stored = (actor: 'triage' | 'describer') =>
      work('5200')
        .open()
        .add(1, 'work-item.summarised', actor, {
          title: 'Server errors on /contact',
          description:
            'The probes found it: the contact form sends. Triage opened a ticket, errors and broken, which waits for the planner.',
          story: `${story} Nothing has been fixed yet: the ticket waits at Plan.`,
        }).events;
    const t = Date.parse('2026-10-04T00:00:00Z');
    expect(projectSheet(stored('triage'), '5200', t)?.story).toBe(story);
    expect(projectSheet(stored('triage'), '5200', t)?.card.description).toBe(
      'The probes found it: the contact form sends. Triage opened a ticket, errors and broken.',
    );
    expect(projectSheet(stored('describer'), '5200', t)?.story).toBe(
      `${story} Nothing has been fixed yet: the ticket waits at Plan.`,
    );
  });
});
