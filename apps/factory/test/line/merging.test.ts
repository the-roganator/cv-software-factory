import { AUTONOMY, type Autonomy, type PayloadOf } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { ENQUEUES } from '../../../../policy/line.ts';
import { RULES, type Rule } from '../../../../policy/review-verdict.ts';
import { TEST_INTEGRITY_CHECK } from '../../../../scripts/review-routing.ts';
import { TEST_INTEGRITY } from '../../src/line/gates.ts';
import { atMerge, decide, type Facts, fold, type LineEvent } from '../../src/line/machine.ts';
import type { MergeFacts } from '../../src/line/merging.ts';

const HEAD = 'a'.repeat(40);
const PUSHED = 'b'.repeat(40);

const ticket: LineEvent = {
  type: 'ticket.opened',
  payload: {
    title: 'Server errors on /search',
    category: 'errors',
    severity: 'broken',
    fingerprint: { route: '/search', class: 'server-error' },
    traces: [],
  },
};
const spec = (risks: PayloadOf<'spec.written'>['risks'] = []): LineEvent => ({
  type: 'spec.written',
  payload: {
    outcome: 'Search answers every query.',
    criteria: [{ given: 'a quote', when: 'it is searched', expect: 'the page lists matches' }],
    scope: ['src/search.ts', 'test/'],
    risks,
    rollout: 'Ships as it is.',
  },
});
const pushed = (branch = 'factory/1001-server-errors-on-search'): LineEvent => ({
  type: 'pull-request.pushed',
  payload: {
    number: 12,
    title: 'fix(search): escape the query',
    branch,
    attempt: 1,
    testsFirst: true,
    files: [{ path: 'src/search.ts', added: 1, removed: 1 }],
    whole: [{ path: 'src/search.ts', added: 1, removed: 1 }],
  },
});
const gates = (commit = HEAD): LineEvent[] => [
  { type: 'gates.started', payload: { pullRequest: 12, commit, checks: ['test'] } },
  { type: 'gates.finished', payload: { pullRequest: 12, commit, conclusion: 'passed', passed: 1, failed: [] } },
];
const reviewed = (commit: string | null = HEAD): LineEvent => ({
  type: 'review.submitted',
  payload: { pullRequest: 12, ...(commit ? { commit } : {}), verdict: 'approved', note: 'Fine.', findings: [] },
});
const summarised: LineEvent = {
  type: 'work-item.summarised',
  payload: { title: 'Search answers every query', description: 'Fixed.', story: 'The factory fixed it.' },
};
const ready = [ticket, spec(), pushed(), ...gates(), reviewed(), summarised];

const REFUSAL: PayloadOf<'action.refused'> = {
  mechanism: 'review-gate',
  action: 'Merge pull request #12 at aaaaaaa in the-roganator/cv-worlds-worst-website',
  output: '#12: held for its risk tags: dependency-change',
  guardrails: [2],
  subject: { kind: 'commit', name: HEAD },
  record: 'f'.repeat(64),
  signature: `${'A'.repeat(86)}==`,
};

/** Test integrity finishing on the head, and the gate judging it after, as it does once the gates finish. */
const INTEGRITY_AT = '2026-11-05T10:00:00Z';
const JUDGED_AT = '2026-11-05T10:02:00Z';

const merge = (over: Partial<MergeFacts> & { rule?: Rule; tags?: string[] } = {}): MergeFacts => {
  const { rule = 'low-risk', tags = [], ...rest } = over;
  const head = rest.head ?? HEAD;
  return {
    autonomy: 'guarded',
    autoMerge: true,
    head,
    check: {
      status: 'completed',
      conclusion: rule === 'held' ? 'failure' : 'success',
      title: 'The gate',
      url: null,
      completedAt: JUDGED_AT,
    },
    judged: { number: 12, head, rule, tags: tags.map((tag) => ({ tag, because: ['pnpm-lock.yaml'] })) },
    problem: null,
    conflicts: false,
    integrityAt: INTEGRITY_AT,
    rejudgeDue: true,
    ...(rule === 'held' ? { refusal: REFUSAL } : {}),
    ...rest,
  } as MergeFacts;
};

const facts = (m?: MergeFacts | null): Facts => ({
  issue: 3,
  failures: 0,
  failure: null,
  ...(m !== undefined ? { merge: m } : {}),
});

const refused: LineEvent = { type: 'action.refused', payload: REFUSAL };
const holdOf = (events: LineEvent[], m: MergeFacts) => {
  const { next } = decide(events, facts(m));
  if (next.do !== 'hold') throw new Error(`no hold: ${JSON.stringify(next)}`);
  return next.hold;
};
const enqueued = (commit = HEAD, rule: Rule = 'low-risk'): LineEvent => ({
  type: 'pull-request.enqueued',
  payload: { number: 12, commit, rule, position: 1 },
});

describe('the line’s merge, by the review gate’s verdict, the autonomy level and auto-merge', () => {
  it('adds a change to the queue only by a rule its level allows, with auto-merge on, and holds it otherwise', () => {
    for (const autonomy of AUTONOMY) {
      for (const rule of RULES.filter((r) => r !== 'held')) {
        for (const autoMerge of [true, false]) {
          const { next } = decide(ready, facts(merge({ autonomy, autoMerge, rule })));
          const allowed = autoMerge && ENQUEUES[autonomy].includes(rule);
          const at = `${autonomy}, ${rule}, auto-merge ${autoMerge}`;
          if (allowed) expect(next, at).toEqual({ do: 'enqueue', number: 12, head: HEAD, rule });
          else {
            expect(next, at).toMatchObject({ do: 'hold', hold: { cause: 'merge', merge: { rule, approving: false } } });
            const why = !ENQUEUES[autonomy].includes(rule) ? 'level' : 'auto-merge';
            expect(next, at).toMatchObject({ hold: { merge: { why } } });
          }
        }
      }
    }
  });

  it('merges by Guarded’s rules at Guarded and Lights-out, Lights-out’s at Lights-out alone, and never Martin’s own', () => {
    const rules = (autonomy: Autonomy) =>
      RULES.filter((rule) => decide(ready, facts(merge({ autonomy, rule }))).next.do === 'enqueue');
    expect(rules('supervised')).toEqual([]);
    expect(rules('guarded')).toEqual(['martin-approved-head', 'exact-pin', 'low-risk']);
    expect(rules('lights-out')).toEqual(['martin-approved-head', 'exact-pin', 'low-risk', 'lights-out']);
  });

  it('records the gate’s refusal of a head once, then holds it for its tags, saying Martin’s approval queues it', () => {
    const held = merge({ rule: 'held', tags: ['dependency-change'] });
    expect(decide(ready, facts(held)).next).toEqual({ do: 'refused', head: HEAD, refusal: REFUSAL });
    const hold = holdOf([...ready, refused], held);
    expect(hold).toMatchObject({
      stage: 'review',
      kind: 'approval',
      cause: 'merge',
      reason: expect.stringContaining(
        'held #12 for dependency-change: Martin’s approval of its head on GitHub sends it',
      ),
      merge: { pullRequest: 12, head: HEAD, why: 'held', rule: 'held', approving: true, said: 'The gate' },
    });
    expect(hold.merge?.tags).toEqual([{ tag: 'dependency-change', because: ['pnpm-lock.yaml'] }]);
    // Held, it is not held again, nor refused again, on the next read.
    const holding = [...ready, refused, { type: 'hold.started', payload: hold } as LineEvent];
    expect(decide(holding, facts(held)).next).toEqual({ do: 'wait', for: 'martin' });
    // Where his approval would not queue it, the hold does not say so.
    for (const m of [merge({ ...held, autonomy: 'supervised' }), merge({ ...held, autoMerge: false })]) {
      expect(holdOf([...ready, refused], { ...m, rule: undefined } as MergeFacts).merge?.approving).toBe(false);
    }
  });

  it('adds it to the queue once Martin approves the head, and holds it again after a push since', () => {
    const held = merge({ rule: 'held', tags: ['test-loosening'] });
    const hold = holdOf([...ready, refused], held);
    const holding = [...ready, refused, { type: 'hold.started', payload: hold } as LineEvent];
    // His approval on GitHub: the gate judges again, as Martin's approved head.
    expect(decide(holding, facts(merge({ rule: 'martin-approved-head' }))).next).toEqual({
      do: 'enqueue',
      number: 12,
      head: HEAD,
      rule: 'martin-approved-head',
    });
    // A push after it: the gate holds the new head, which is refused once in its turn, and is not the head reviewed.
    const after = merge({
      rule: 'held',
      head: PUSHED,
      refusal: { ...REFUSAL, subject: { kind: 'commit', name: PUSHED } },
    });
    expect(decide(holding, facts(after)).next).toMatchObject({ do: 'refused', head: PUSHED });
    const again = [...holding, { type: 'action.refused', payload: after.refusal } as LineEvent];
    expect(holdOf(again, after).merge).toMatchObject({ why: 'unreviewed', head: PUSHED, approving: false });
    // The same with Martin's approval of the moved head: not the head the line's reviewer passed.
    expect(holdOf(again, merge({ rule: 'martin-approved-head', head: PUSHED })).merge?.why).toBe('unreviewed');
  });

  it('never queues on review alone: the line’s own review must have passed that head', () => {
    const unreviewed = [ticket, spec(), pushed(), ...gates(), reviewed(PUSHED), summarised];
    expect(holdOf(unreviewed, merge()).merge?.why).toBe('unreviewed');
    // A review recorded before reviews named their head.
    const unnamed = [ticket, spec(), pushed(), ...gates(), reviewed(null), summarised];
    expect(holdOf(unnamed, merge())).toMatchObject({
      reason: expect.stringContaining('reviewed before the line recorded which head'),
      merge: { why: 'unreviewed' },
    });
    // Gates that passed on another head.
    const elsewhere = [ticket, spec(), pushed(), ...gates(PUSHED), reviewed(), summarised];
    expect(holdOf(elsewhere, merge()).merge?.why).toBe('unreviewed');
  });

  it('keeps the gate’s tags as the hold’s schema takes them, however long the lines it quotes', () => {
    const long = `src/${'deeply/nested/'.repeat(8)}headers.ts: res.setHeader('Content-Security-Policy', "${'x'.repeat(120)}")`;
    const because = [long, '  ', ...Array.from({ length: 22 }, (_, i) => `src/f${i}.ts`)];
    const m = merge({ rule: 'held' });
    const judged = { ...m.judged, tags: [{ tag: 'security-headers', because, more: 3 }] } as MergeFacts['judged'];
    const hold = holdOf([...ready, refused], { ...m, judged, check: { ...m.check, title: '  ' } } as MergeFacts);
    const [tag] = hold.merge?.tags ?? [];
    expect(tag?.because).toHaveLength(20);
    expect(tag?.because[0]?.length).toBeLessThanOrEqual(200);
    expect(tag?.more).toBe(3 + 1 + 3);
    expect(hold.merge?.said).toBeUndefined();
    expect(PAYLOADS['hold.started'].safeParse(hold).success).toBe(true);
  });

  it('never queues an improvement, a release, a red-team branch or work whose spec was out of scope', () => {
    const request: LineEvent = {
      type: 'improvement.requested',
      payload: { words: 'Sort the products by price, cheapest first.', steppedUp: true },
    };
    const never = {
      improvement: [
        request,
        spec(),
        { type: 'hold.started', payload: { stage: 'plan', kind: 'approval', cause: 'spec', reason: 'An improvement' } },
        { type: 'hold.answered', payload: { decision: 'approved' } },
        ...ready.slice(2),
      ] as LineEvent[],
      'out of scope': [ticket, spec(['out-of-scope']), pushed(), ...gates(), reviewed(), summarised],
      'red team': [ticket, spec(), pushed('factory/red-team-test-1a2b3c4d'), ...gates(), reviewed(), summarised],
    };
    for (const [what, events] of Object.entries(never)) {
      for (const rule of ['low-risk', 'lights-out', 'martin-approved-head'] as const) {
        const m = merge({ autonomy: 'lights-out', rule });
        expect(holdOf(events, m).merge, `${what}, ${rule}`).toMatchObject({ why: 'never', approving: false });
      }
    }
    for (const tag of ['release', 'improvement']) {
      expect(holdOf(ready, merge({ autonomy: 'lights-out', rule: 'lights-out', tags: [tag] })).merge?.why).toBe(
        'never',
      );
    }
    // Held by the gate as well, it is held for its tags, and his approval would not queue it.
    const held = merge({ rule: 'held', tags: ['improvement'] });
    expect(holdOf([...never.improvement, refused], held).merge).toMatchObject({ why: 'held', approving: false });
  });

  it('times the gate’s verdict against the check the gate reads', () => {
    expect(TEST_INTEGRITY).toBe(TEST_INTEGRITY_CHECK);
  });

  it('waits for the gate to judge again when its verdict came before test integrity finished, refusing nothing', () => {
    // The gate judged the head as the pull request opened, before test integrity had run, and held it for want of it.
    const early = {
      completedAt: '2026-11-05T09:55:00Z',
      status: 'completed',
      conclusion: 'failure',
      title: 'Held',
      url: null,
    };
    const stale = merge({ rule: 'held', tags: ['dependency-change'], check: early });
    expect(decide(ready, facts(stale))).toEqual({ stage: 'review', next: { do: 'wait', for: 'gates' } });
    // A passing verdict from then counts nothing test integrity found either: nothing is queued on it.
    const passing = merge({ check: { ...early, conclusion: 'success' } });
    expect(decide(ready, facts(passing)).next).toEqual({ do: 'wait', for: 'gates' });
    // A check that does not say when it concluded cannot be told to be after it.
    expect(decide(ready, facts(merge({ check: { ...early, completedAt: null } }))).next).toEqual({
      do: 'wait',
      for: 'gates',
    });
    // The gate judges again once the gates finish: a pass is queued on, and a hold refused once, then held.
    expect(decide(ready, facts(merge())).next).toEqual({ do: 'enqueue', number: 12, head: HEAD, rule: 'low-risk' });
    const judged = merge({ rule: 'held', tags: ['dependency-change'] });
    expect(decide(ready, facts(judged)).next).toEqual({ do: 'refused', head: HEAD, refusal: REFUSAL });
    expect(holdOf([...ready, refused], judged).merge).toMatchObject({ why: 'held', rule: 'held' });
    // Judged at the very moment test integrity finished, it counts it.
    expect(
      decide(ready, facts(merge({ check: { ...early, completedAt: INTEGRITY_AT, conclusion: 'success' } }))).next,
    ).toMatchObject({ do: 'enqueue' });
    // With no run of test integrity on the head, the verdict is the gate's word on it, held or passing.
    expect(decide(ready, facts(merge({ ...stale, integrityAt: null }))).next).toMatchObject({ do: 'refused' });
    // The gate not judging again in time: held for Martin as no verdict to trust, with none of the early one's rule,
    // and still no refusal.
    const overdue = holdOf(ready, merge({ ...stale, rejudgeDue: false }));
    expect(overdue).toMatchObject({
      cause: 'merge',
      reason: expect.stringContaining('has not judged #12 at aaaaaaa since test integrity finished there'),
      merge: { why: 'no-verdict', approving: false },
    });
    expect(overdue.merge).not.toHaveProperty('rule');
    expect(overdue.merge).not.toHaveProperty('tags');
    // A hold in force stands while the gate judges again.
    const holding = [...ready, { type: 'hold.started', payload: overdue } as LineEvent];
    expect(decide(holding, facts(merge({ ...stale, rejudgeDue: false }))).next).toEqual({ do: 'wait', for: 'martin' });
  });

  it('waits while the gate has not judged the head, and holds when it gave no verdict to trust', () => {
    expect(decide(ready, facts(merge({ check: null, judged: null, problem: 'none' })))).toEqual({
      stage: 'review',
      next: { do: 'wait', for: 'gates' },
    });
    const running = merge({
      check: { status: 'in_progress', conclusion: null, title: null, url: null, completedAt: null },
      judged: null,
    });
    expect(decide(ready, facts(running)).next).toEqual({ do: 'wait', for: 'gates' });
    const none = merge({ judged: null, problem: 'the summary carries no verdict' });
    expect(holdOf(ready, none)).toMatchObject({
      reason: expect.stringContaining('the summary carries no verdict'),
      merge: { why: 'no-verdict' },
    });
    // GitHub could not be read: it waits, and holds nothing.
    expect(decide(ready, facts(null)).next).toEqual({ do: 'wait', for: 'gates' });
    // Nothing read at all: held for Martin's merge, as before the line merged anything.
    expect(decide(ready, facts()).next).toMatchObject({ do: 'hold', hold: { cause: 'merge' } });
    expect(decide(ready, facts()).next).not.toHaveProperty('hold.merge');
  });

  it('holds a pull request that conflicts with main, saying so, and queues it once it does not', () => {
    const hold = holdOf(ready, merge({ conflicts: true }));
    expect(hold).toMatchObject({ reason: expect.stringContaining('conflicts with main'), merge: { why: 'conflict' } });
    const holding = [...ready, { type: 'hold.started', payload: hold } as LineEvent];
    expect(decide(holding, facts(merge())).next).toMatchObject({ do: 'enqueue' });
    // Not known yet, it is not held for it.
    expect(decide(ready, facts(merge({ conflicts: null }))).next).toMatchObject({ do: 'enqueue' });
  });

  it('waits on the queue once queued, and holds when the queue takes it out, until the head moves', () => {
    const queued = [...ready, enqueued()];
    expect(decide(queued, facts())).toEqual({ stage: 'review', next: { do: 'wait', for: 'queue' } });
    expect(atMerge(fold(queued), queued, facts())).toBe(false);
    const out: LineEvent = {
      type: 'pull-request.dequeued',
      payload: { number: 12, commit: HEAD, reason: 'failed_checks', by: 'github-merge-queue', failed: ['test'] },
    };
    const dequeued = [...queued, out];
    expect(atMerge(fold(dequeued), dequeued, facts())).toBe(true);
    const hold = holdOf(dequeued, merge());
    expect(hold).toMatchObject({
      reason: expect.stringContaining('The merge queue took #12 out (failed_checks): test failed'),
      merge: { why: 'queue', queue: { reason: 'failed_checks', failed: ['test'] } },
    });
    // The line does not add that head again.
    const holding = [...dequeued, { type: 'hold.started', payload: hold } as LineEvent];
    expect(decide(holding, facts(merge())).next).toEqual({ do: 'wait', for: 'martin' });
    // A queue's word on another head says nothing of this one.
    const other: LineEvent = { ...out, payload: { ...out.payload, commit: PUSHED } } as LineEvent;
    expect(fold([...queued, other]).enqueued).toBeDefined();
  });

  it('ends the hold for the merge when the line queues it, and goes on to Release once it merges', () => {
    const hold = holdOf(ready, merge({ autoMerge: false }));
    const holding = [...ready, { type: 'hold.started', payload: hold } as LineEvent];
    expect(fold(holding).hold?.cause).toBe('merge');
    expect(fold([...holding, enqueued()]).hold).toBeUndefined();
    const merged: LineEvent = { type: 'pull-request.merged', payload: { number: 12, commit: PUSHED, by: 'factory' } };
    expect(decide([...holding, enqueued(), merged], facts()).next).toMatchObject({ hold: { cause: 'deploy' } });
  });

  it('holds again, with what the gate says now, when what it says changes, and not when it says the same', () => {
    const level = holdOf(ready, merge({ autonomy: 'supervised' }));
    const holding = [...ready, { type: 'hold.started', payload: level } as LineEvent];
    expect(decide(holding, facts(merge({ autonomy: 'supervised' }))).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide(holding, facts(merge({ autoMerge: false }))).next).toMatchObject({
      do: 'hold',
      hold: { merge: { why: 'auto-merge' } },
    });
    // A pending check on a hold in force leaves it standing.
    expect(decide(holding, facts(merge({ check: null, judged: null }))).next).toEqual({ do: 'wait', for: 'martin' });
  });

  it('queues it after Martin’s console answer to wait for the merge, when the gate and the controls allow', () => {
    const hold = holdOf(ready, merge({ autoMerge: false }));
    const answered = [
      ...ready,
      { type: 'hold.started', payload: hold } as LineEvent,
      { type: 'hold.answered', payload: { decision: 'approved' } } as LineEvent,
    ];
    expect(decide(answered, facts(merge({ autoMerge: false }))).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide(answered, facts(merge())).next).toMatchObject({ do: 'enqueue', rule: 'low-risk' });
  });

  it('is at the merge just as a change ready to merge is held for it, or answered to wait for it', () => {
    expect(atMerge(fold(ready), ready, facts())).toBe(true);
    const building = [ticket, spec(), pushed()];
    expect(atMerge(fold(building), building, facts())).toBe(false);
  });
});
