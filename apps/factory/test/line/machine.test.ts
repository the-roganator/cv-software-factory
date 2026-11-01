import {
  ANSWERS,
  answersTo,
  HOLD_CAUSES,
  type HoldCause,
  type PayloadOf,
  WORDS_LEAVE_HELD,
} from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import {
  acceptedFindings,
  atTake,
  closesWhenCleared,
  decide,
  dryRunLeft,
  type Facts,
  fold,
  LIMITS,
  type LineEvent,
  needsHold,
  unchangedHold,
} from '../../src/line/machine.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

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
const spec: LineEvent = {
  type: 'spec.written',
  payload: {
    outcome: 'Search answers every query.',
    criteria: [
      { given: 'a query with a quote', when: 'it is searched', expect: 'the page lists matches', from: 'the ticket' },
    ],
    scope: ['src/search.ts', 'test/'],
    risks: [],
    rollout: 'Ships as it is.',
  },
};
const pushed = (attempt = 1): LineEvent => ({
  type: 'pull-request.pushed',
  payload: {
    number: 12,
    title: 'fix(search): escape the query',
    branch: 'factory/1001-server-errors-on-search',
    attempt,
    testsFirst: true,
    files: [{ path: 'src/search.ts', added: 1, removed: 1 }],
    whole: [{ path: 'src/search.ts', added: 1, removed: 1 }],
  },
});
const started = (commit = SHA): LineEvent => ({
  type: 'gates.started',
  payload: { pullRequest: 12, commit, checks: ['test'] },
});
const finished = (conclusion: 'passed' | 'failed', commit = SHA): LineEvent => ({
  type: 'gates.finished',
  payload: { pullRequest: 12, commit, conclusion, passed: 1, failed: conclusion === 'failed' ? ['test'] : [] },
});
const finding = { path: 'src/search.ts', line: 3, blocking: true, rule: 4, comment: 'Escape the query once.' };
const review = (verdict: PayloadOf<'review.submitted'>['verdict']): LineEvent => ({
  type: 'review.submitted',
  payload: {
    pullRequest: 12,
    verdict,
    note: 'One blocking finding.',
    findings: verdict === 'approved' ? [] : [finding],
  },
});
/** The line's record that it answered the blocking threads of a review Martin approved. */
const accepted = (number = 1): LineEvent => ({
  type: 'review.accepted',
  payload: { pullRequest: 12, review: number, findings: 1, suggestions: 0 },
});
const returned = (from: 'gates' | 'review'): LineEvent => ({
  type: 'work.returned',
  payload: { from, to: 'build', reason: 'Put it right' },
});
const summarised: LineEvent = {
  type: 'work-item.summarised',
  payload: { title: 'Search answers every query', description: 'Fixed.', story: 'The factory fixed it.' },
};

const facts: Facts = { issue: 3, failures: 0, failure: null };

describe('what the line does next', () => {
  it('opens the issue as a ticket enters Plan, then plans it', () => {
    expect(decide([ticket], { ...facts, issue: null })).toEqual({ stage: 'plan', next: { do: 'open-issue' } });
    expect(decide([ticket], facts)).toEqual({ stage: 'plan', next: { do: 'step', agent: 'planner', round: 1 } });
  });

  it('builds a spec, waits for the gates, reviews what passes, describes what review approves, and waits for Martin', () => {
    expect(decide([ticket, spec], facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    expect(decide([ticket, spec, pushed()], facts)).toEqual({ stage: 'gates', next: { do: 'wait', for: 'gates' } });
    expect(decide([ticket, spec, pushed(), started()], facts).next).toEqual({ do: 'wait', for: 'gates' });
    const passed = [ticket, spec, pushed(), started(), finished('passed')];
    expect(decide(passed, facts)).toEqual({ stage: 'review', next: { do: 'step', agent: 'reviewer', round: 1 } });
    expect(decide([...passed, review('approved')], facts).next).toEqual({ do: 'step', agent: 'describer', round: 1 });
    expect(decide([...passed, review('approved'), summarised], facts)).toMatchObject({
      stage: 'held',
      next: { do: 'hold', hold: { stage: 'review', kind: 'approval' } },
    });
  });

  it('sends failing gates back to the coder, whose next round resumes, and holds after the limit', () => {
    const failed = [ticket, spec, pushed(), started(), finished('failed')];
    expect(decide(failed, facts).next).toEqual({
      do: 'return',
      from: 'gates',
      to: 'build',
      reason: 'The gates failed: test',
      failed: ['test'],
    });
    expect(decide([...failed, returned('gates')], facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
    let events = failed;
    for (let round = 1; round <= LIMITS.gateReturns; round++) {
      events = [...events, returned('gates'), pushed(round + 1), started(), finished('failed')];
    }
    expect(decide(events, facts)).toMatchObject({ stage: 'held', next: { do: 'hold', hold: { stage: 'gates' } } });
  });

  it('sends blocking findings back to the coder, reviews its second round, and holds what still blocks', () => {
    const passed = (attempt: number) => [pushed(attempt), started(), finished('passed')];
    // Round 1: the review blocks, and the work goes back to Build.
    const first = [ticket, spec, ...passed(1), review('changes-requested')];
    expect(decide(first, facts)).toEqual({
      stage: 'build',
      next: {
        do: 'return',
        from: 'review',
        to: 'build',
        reason: 'Review asked for changes: One blocking finding.',
        blocking: 1,
      },
    });
    // The coder's round 2, with the findings that sent it back still to hand.
    const back = [...first, returned('review')];
    expect(decide(back, facts)).toEqual({ stage: 'build', next: { do: 'step', agent: 'coder', round: 2 } });
    expect(fold(back).review?.findings).toEqual([finding]);
    // Its push waits for the gates, and a passing run brings the reviewer back for round 2, which knows round 1's.
    expect(decide([...back, pushed(2)], facts).next).toEqual({ do: 'wait', for: 'gates' });
    const reviewing = [...back, ...passed(2)];
    expect(decide(reviewing, facts)).toEqual({ stage: 'review', next: { do: 'step', agent: 'reviewer', round: 2 } });
    expect(fold(reviewing)).toMatchObject({ review: undefined, reviews: [{ findings: [finding] }] });
    // Round 2 still blocks: two reviews are the limit, and Martin decides.
    expect(LIMITS.reviews).toBe(2);
    expect(decide([...reviewing, review('changes-requested')], facts)).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'review',
          kind: 'held',
          cause: 'review',
          reason: 'Review asked for changes: One blocking finding.',
        },
      },
    });
    // Round 2 approves: on to the describer, which reads the whole thread and the way back.
    const approved = [...reviewing, review('approved')];
    expect(decide(approved, facts).next).toEqual({ do: 'step', agent: 'describer', round: 2 });
    expect(fold(approved).reviews.map((r) => r.verdict)).toEqual(['changes-requested', 'approved']);
    expect(fold(approved).returns).toEqual([{ from: 'review', reason: expect.any(String) }]);
    // An escalation holds at once.
    expect(decide([ticket, spec, ...passed(1), review('escalated')], facts)).toMatchObject({ stage: 'held' });
  });

  it('sends an approval’s suggestions back to the coder once in a pass, and goes on after the review that follows', () => {
    const passed = (attempt: number) => [pushed(attempt), started(), finished('passed')];
    const suggestion = { path: 'src/search.ts', line: 5, blocking: false, comment: 'Name it for what it does.' };
    const suggesting = (verdict: 'approved' | 'changes-requested'): LineEvent => ({
      type: 'review.submitted',
      payload: {
        pullRequest: 12,
        verdict,
        note: 'Fine.',
        findings: verdict === 'approved' ? [suggestion] : [finding, suggestion],
      },
    });
    const first = [ticket, spec, ...passed(1), suggesting('approved')];
    const back = {
      do: 'return',
      from: 'review',
      to: 'build',
      reason: 'The review approved, with a suggestion to take or decline',
      suggestions: 1,
    };
    expect(decide(first, facts)).toEqual({ stage: 'build', next: back });
    const sent: LineEvent = { type: 'work.returned', payload: { ...back, from: 'review', to: 'build', round: 2 } };
    expect(decide([...first, sent], facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
    expect(fold([...first, sent]).suggestionReturns).toBe(1);
    // It takes the suggestion: the gates and a fresh reviewer run again, and that review goes on, whatever it suggests.
    const answered = (...declined: number[]): LineEvent => ({
      type: 'suggestions.answered',
      payload: { pullRequest: 12, suggestions: 1, declined: declined.map((n) => ({ suggestion: n, reason: 'No.' })) },
    });
    const taken = [...first, sent, pushed(2), answered(), started(), finished('passed')];
    expect(decide(taken, facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 2 });
    expect(decide([...taken, suggesting('approved')], facts).next).toEqual({
      do: 'step',
      agent: 'describer',
      round: 2,
    });
    // One that blocks is the second review, the last the line allows: Martin decides.
    expect(decide([...taken, suggesting('changes-requested')], facts)).toMatchObject({
      stage: 'held',
      next: { hold: { cause: 'review' } },
    });
    // It declines it: nothing changes, and the approval stands.
    const declined = [...first, sent, answered(1)];
    expect(decide(declined, facts).next).toEqual({ do: 'step', agent: 'describer', round: 2 });
    expect(fold(declined).suggestionsAnswered?.declined).toEqual([{ suggestion: 1, reason: 'No.' }]);
    // A review that blocks sends its suggestions with its findings, and an approval after it has its round.
    const blocked = [ticket, spec, ...passed(1), suggesting('changes-requested')];
    expect(decide(blocked, facts).next).toMatchObject({ do: 'return', blocking: 1 });
    const again = [...blocked, returned('review'), ...passed(2), suggesting('approved')];
    expect(decide(again, facts).next).toMatchObject({ do: 'return', suggestions: 1 });
    // A coder that changes nothing when findings block declines every suggestion, and holds: his answer works as ever.
    const unchanged = [...blocked, returned('review'), answered(1), held('review', 'review')];
    expect(decide(unchanged, facts).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide([...unchanged, answer('approved')], facts).next).toEqual({ do: 'accept', review: 1, answer: 0 });
    expect(decide([...unchanged, answer('approved'), accepted()], facts).next).toEqual({
      do: 'step',
      agent: 'describer',
      round: 2,
    });
    expect(decide([...unchanged, answer('answered', 'Escape it')], facts).next).toMatchObject({ do: 'return' });
    // Once the change is written up, the suggestions stay for Martin.
    expect(decide([...first.slice(0, -1), review('approved'), summarised, suggesting('approved')], facts).next).toEqual(
      { do: 'hold', hold: expect.objectContaining({ cause: 'merge' }) },
    );
  });

  it('sends a patch the scope fence refuses back to the coder once, with its output, and holds at the second', () => {
    const refused = (output = 'scope: src/search.ts, test/\nrefused src/server.ts +1 −1'): LineEvent => ({
      type: 'action.refused',
      payload: {
        mechanism: 'scope-fence',
        guardrails: [11],
        action: 'Push the coder’s round 1 to a new pull request',
        output,
      },
    });
    const once = [ticket, spec, refused()];
    expect(decide(once, facts)).toEqual({ stage: 'build', next: { do: 'step', agent: 'coder', round: 1 } });
    expect(fold(once).fenced).toBe('scope: src/search.ts, test/\nrefused src/server.ts +1 −1');
    expect(decide([...once, refused()], facts)).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'build',
          kind: 'held',
          cause: 'scope',
          reason: 'The scope fence refused the coder’s patch twice: it changed files outside the spec’s scope',
        },
      },
    });
    expect(LIMITS.fenceRefusals).toBe(2);
    // A push clears the refusal it followed, but the count stays: a later round that strays once more holds.
    const pushedAfter = [...once, pushed(), started(), finished('failed'), returned('gates')];
    expect(fold(pushedAfter).fenced).toBeUndefined();
    expect(decide(pushedAfter, facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
    expect(decide([...pushedAfter, refused()], facts)).toMatchObject({ stage: 'held' });
    // Martin's answer to the hold sends the work item back to Plan (below), and the new spec starts the count again.
    const hold: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'build', kind: 'held', cause: 'scope', reason: 'Twice outside its scope' },
    };
    const answered: LineEvent = { type: 'hold.answered', payload: { decision: 'answered', answer: 'Take it in' } };
    const respecified = [...once, refused(), hold, answered, spec];
    expect(decide(respecified, facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    expect(fold(respecified)).toMatchObject({ fenced: undefined, fenceRefusals: 0 });
    // The platform's refusals are not the fence's.
    const ruleset: LineEvent = {
      type: 'action.refused',
      payload: { mechanism: 'ruleset', guardrails: [1], action: 'Push to main', output: 'Protected branch' },
    };
    expect(fold([ticket, spec, ruleset, ruleset]).fenceRefusals).toBe(0);
  });

  it('holds as scope the files a coder needs, says those no scope may name, and tells the planner them, not the fence', () => {
    const needs = [
      { path: 'test/flags-preview.test.ts', reason: 'It assumes / asks no flag;\nevery page now does.' },
      { path: '.github/workflows/ci.yml', reason: 'It runs the old command' },
    ];
    const hold = needsHold(needs, ['.github/', 'deploy/']);
    expect(hold).toEqual({
      stage: 'build',
      kind: 'held',
      cause: 'scope',
      reason:
        'The coder needs 2 files outside the spec’s scope to meet its criteria, and no scope may name .github/workflows/ci.yml: test/flags-preview.test.ts, .github/workflows/ci.yml',
      // Each reason one line, and the protected file marked, for the card and the planner.
      needs: [
        { path: 'test/flags-preview.test.ts', reason: 'It assumes / asks no flag; every page now does.' },
        { path: '.github/workflows/ci.yml', reason: 'It runs the old command', barred: true },
      ],
    });
    // However many it names, the reason fits the hold, says first which no scope may name, and is cut between
    // characters, never inside one, which the store would refuse.
    const many = Array.from({ length: 20 }, (_, i) => ({ path: `test/${'a'.repeat(40)}-${i}.test.ts`, reason: 'x' }));
    const barred = needsHold([{ path: 'deploy/app.yaml', reason: 'x' }, ...many], ['deploy/']).reason;
    expect(barred.length).toBeLessThanOrEqual(300);
    expect(barred.endsWith('…')).toBe(true);
    expect(barred).toContain('no scope may name deploy/app.yaml');
    const prefix = 'The coder needs a file outside the spec’s scope to meet its criteria: test/';
    // An emoji whose first half is the 299th character, where the reason is cut.
    const path = `test/${'a'.repeat(298 - prefix.length)}😀😀`;
    const cut = needsHold([{ path, reason: 'x' }], []).reason;
    expect(cut.endsWith('a…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(300);
    // The fence refused a patch earlier in the round; what the coder said is what Martin approved.
    const refused: LineEvent = {
      type: 'action.refused',
      payload: {
        mechanism: 'scope-fence',
        guardrails: [11],
        action: 'Push',
        output: 'scope: test/\nrefused src/server.ts +1 −1',
      },
    };
    const approved = fold([ticket, spec, refused, { type: 'hold.started', payload: hold }, answer('approved')]);
    expect(approved.spec).toBeUndefined();
    expect(approved.answers).toEqual([
      {
        asked: `${hold.reason}.`,
        said: 'The coder said of test/flags-preview.test.ts: It assumes / asks no flag; every page now does. The coder said of .github/workflows/ci.yml, which no scope may name: It runs the old command.',
        // The line's reading of his approval, which is never his words.
        line: 'Let the scope take in the files the coder needed that a scope may name. A file no scope may name stays out of it: if the fix needs one, reject the ticket.',
        approved: true,
      },
    ]);
    expect(closesWhenCleared(fold([ticket, spec, { type: 'hold.started', payload: hold }]))).toBe(true);
    // Approving files of which one no scope may name tells the planner to leave that one out, or reject the ticket.
    const barredOnly = needsHold([{ path: 'deploy/app.yaml', reason: 'x' }], ['deploy/']);
    const barredLine = 'A file no scope may name stays out of it: if the fix needs one, reject the ticket.';
    const told = fold([ticket, spec, { type: 'hold.started', payload: barredOnly }, answer('approved')]).answers[0];
    expect(told).toMatchObject({
      line: `Let the scope take in the files the coder needed that a scope may name. ${barredLine}`,
    });
    expect(told?.answer).toBeUndefined();
    // His own words with his approval keep what the planner may not do, as the line's beside his.
    const worded = fold([ticket, spec, { type: 'hold.started', payload: barredOnly }, answer('approved', 'Go ahead.')])
      .answers[0];
    expect(worded).toMatchObject({ answer: 'Go ahead.', line: barredLine });
    // So do his words alone, which send it back to the planner too; on a hold with nothing barred, his words stand.
    const words = fold([ticket, spec, { type: 'hold.started', payload: barredOnly }, answer('answered', 'Try again.')]);
    expect(words.answers[0]).toMatchObject({ answer: 'Try again.', line: barredLine });
    expect(words.answers[0]?.approved).toBeUndefined();
    const open = needsHold([{ path: 'test/a.ts', reason: 'x' }], []);
    const plain = fold([ticket, spec, { type: 'hold.started', payload: open }, answer('answered', 'Try again.')]);
    expect(plain.answers[0]?.answer).toBe('Try again.');
    expect(plain.answers[0]?.line).toBeUndefined();
    // A reason cut to fit ends as it was cut, with no full stop after the mark.
    const cutHold = needsHold(many, []);
    const cutTold = fold([ticket, spec, { type: 'hold.started', payload: cutHold }, answer('approved')]).answers[0];
    expect(cutTold?.asked).toBe(cutHold.reason);
    expect(cutTold?.asked.endsWith('…')).toBe(true);
  });

  it('judges the gates on the latest push only, and a later run once it ends: passed gates stand while it runs', () => {
    const passed = [ticket, spec, pushed(), started(), finished('passed')];
    expect(decide([...passed, started(OTHER)], facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 1 });
    expect(decide([...passed, started(OTHER), finished('passed', OTHER)], facts).next).toEqual({
      do: 'step',
      agent: 'reviewer',
      round: 1,
    });
    expect(decide([...passed, started(OTHER), finished('failed', OTHER)], facts).next).toEqual({
      do: 'return',
      from: 'gates',
      to: 'build',
      reason: 'The gates failed: test',
      failed: ['test'],
    });
    const stale = [ticket, spec, pushed(), started(), finished('failed', OTHER)];
    expect(decide(stale, facts).next).toEqual({ do: 'wait', for: 'gates' });
    // A run that ended on an older commit says nothing of the newer one.
    expect(decide([...passed, started(OTHER), finished('failed')], facts).next).toMatchObject({ agent: 'reviewer' });
  });

  it('sends back work held for the merge when its gates fail on a newer commit, and holds after the limit', () => {
    const waiting = [ticket, spec, pushed(), started(), finished('passed'), review('approved'), summarised];
    const mergeHold: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'review', kind: 'approval', cause: 'merge', reason: 'Waits for Martin to merge it' },
    };
    expect(decide([...waiting, mergeHold, started(OTHER)], facts)).toEqual({
      stage: 'held',
      next: { do: 'wait', for: 'martin' },
    });
    expect(decide([...waiting, mergeHold, started(OTHER), finished('passed', OTHER)], facts).next).toEqual({
      do: 'wait',
      for: 'martin',
    });
    const failed = [...waiting, mergeHold, started(OTHER), finished('failed', OTHER)];
    expect(fold(failed).hold).toBeUndefined();
    expect(decide(failed, facts)).toEqual({
      stage: 'build',
      next: { do: 'return', from: 'gates', to: 'build', reason: 'The gates failed: test', failed: ['test'] },
    });
    expect(decide([...failed, returned('gates')], facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
    // The next round is a different change: once it passes its gates and review, the describer writes it up again.
    const again = [...failed, returned('gates'), pushed(2), started(), finished('passed'), review('approved')];
    expect(decide(again, facts).next).toEqual({ do: 'step', agent: 'describer', round: 2 });
    // Answered to wait for the merge, the same: the answer said nothing of gates that fail since.
    const answeredToWait = [...waiting, mergeHold, answer('approved'), started(OTHER)];
    expect(decide(answeredToWait, facts).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide([...answeredToWait, finished('failed', OTHER)], facts).next).toMatchObject({
      do: 'return',
      from: 'gates',
    });
    // Another hold stands: Martin answers it first.
    const escalated = [...waiting.slice(0, -2), review('escalated')];
    const reviewHold: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'review', kind: 'held', cause: 'review', reason: 'Escalated' },
    };
    expect(decide([...escalated, reviewHold, started(OTHER), finished('failed', OTHER)], facts).next).toEqual({
      do: 'wait',
      for: 'martin',
    });
    let events = [ticket, spec, pushed(), started(), finished('failed')];
    for (let round = 1; round < LIMITS.gateReturns; round++) {
      events = [...events, returned('gates'), pushed(round + 1), started(), finished('failed')];
    }
    events = [...events, returned('gates'), pushed(LIMITS.gateReturns + 1), started(), finished('passed')];
    const last = [...events, review('approved'), summarised, mergeHold, started(OTHER), finished('failed', OTHER)];
    expect(decide(last, facts)).toMatchObject({ stage: 'held', next: { do: 'hold', hold: { cause: 'gates' } } });
  });

  it('carries merged work on to Release, whatever the round recorded with its merge said', () => {
    const waiting = [ticket, spec, pushed(), started(), finished('passed'), review('approved'), summarised];
    const mergeHold: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'review', kind: 'approval', cause: 'merge', reason: 'Waits for Martin to merge it' },
    };
    const atMerge = [...waiting, mergeHold, started(OTHER), finished('failed', OTHER), merged];
    expect(decide(atMerge, facts).next).toMatchObject({ do: 'hold', hold: { stage: 'release', cause: 'deploy' } });
  });

  it('holds a step that keeps failing, and waits on any hold until it is answered', () => {
    expect(decide([ticket, spec], { ...facts, failures: LIMITS.failures, failure: 'no result' })).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: { stage: 'build', kind: 'held', cause: 'failures', reason: 'The coder failed 2 times: no result' },
      },
    });
    const hold: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'plan', kind: 'question', cause: 'question', reason: 'Which page?' },
    };
    expect(decide([ticket, hold], facts)).toEqual({ stage: 'held', next: { do: 'wait', for: 'martin' } });
    const answered: LineEvent = { type: 'hold.answered', payload: { decision: 'answered', answer: 'The home page' } };
    expect(decide([ticket, hold, answered], facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
  });

  it('holds a work item that has spent its cap before its next step, with the cap and its spend, and not before', () => {
    const spend = { spentUsd: 5.03, limitUsd: 5 };
    expect(decide([ticket, spec], { ...facts, spend })).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'build',
          kind: 'held',
          cause: 'spend',
          reason: 'The work item has spent $5.03 on models, and may spend $5.00',
          limitUsd: 5,
          spentUsd: 5.03,
        },
      },
    });
    // Under the cap the step runs; waiting for the gates needs no model.
    expect(decide([ticket, spec], { ...facts, spend: { ...spend, spentUsd: 4.99 } }).next).toMatchObject({
      do: 'step',
      agent: 'coder',
    });
    expect(decide([ticket, spec, pushed(), started()], { ...facts, spend }).next).toEqual({
      do: 'wait',
      for: 'gates',
    });
  });

  it('ends a work item that is closed', () => {
    const closed: LineEvent = {
      type: 'work-item.closed',
      payload: { outcome: 'no-change', reason: 'Closed unmerged' },
    };
    expect(decide([ticket, closed], facts)).toEqual({ stage: 'ended', next: { do: 'finish' } });
  });
});

const merged: LineEvent = { type: 'pull-request.merged', payload: { number: 12, commit: OTHER, by: 'martin' } };
const RELEASE = '6d8f9c7b54';
const release = (id = RELEASE, version = 'v0.9.4'): LineEvent => ({
  type: 'release.started',
  payload: {
    release: id,
    version,
    previous: 'v0.9.3',
    commit: OTHER,
    image: { digest: `sha256:${'c'.repeat(64)}`, signed: true, admitted: true },
    watched: true,
    steps: null,
    dryRun: false,
  },
});
const promoted = (id = RELEASE, version = 'v0.9.4'): Extract<LineEvent, { type: 'release.promoted' }> => ({
  type: 'release.promoted',
  payload: { release: id, version, previous: 'v0.9.3', commit: OTHER, watched: true, dryRun: false },
});
const rolledBack = (id = RELEASE): LineEvent => ({
  type: 'release.rolled-back',
  payload: {
    release: id,
    version: 'v0.9.4',
    restored: 'v0.9.3',
    weight: 25,
    reason: 'Metric "errors" assessed Failed',
    failed: [{ name: 'errors', phase: 'failed', value: 0.04, limit: 0.01 }],
    dryRun: false,
    by: 'analysis',
  },
});
const aborted = (by: 'stop' | 'martin', id = RELEASE): LineEvent => ({
  type: 'release.aborted',
  payload: { release: id, version: 'v0.9.4', restored: 'v0.9.3', abortedAt: '2026-10-10T09:00:00Z', by },
});
const errored = (id = RELEASE): LineEvent => ({
  type: 'release.errored',
  payload: {
    release: id,
    version: 'v0.9.4',
    restored: 'v0.9.3',
    weight: 25,
    reason: 'Metric "errors" assessed Error',
    errored: [{ name: 'errors', phase: 'error', value: null, limit: 0.01 }],
    abortedAt: '2026-10-10T09:00:00Z',
  },
});
const verified = (outcome: 'cleared' | 'persists'): LineEvent => ({
  type: 'verification.finished',
  payload: { outcome, sense: 'probe', check: 'search', version: 'v0.9.4', against: 'v0.9.3', pages: [], dryRun: false },
});
const deployHold = (events: LineEvent[]): LineEvent => {
  const next = decide(events, facts).next;
  if (next.do !== 'hold') throw new Error(`expected a hold, not ${next.do}`);
  return { type: 'hold.started', payload: next.hold };
};

describe('after the merge', () => {
  const approved = [ticket, spec, pushed(), started(), finished('passed'), review('approved'), summarised];
  const mergeHold = deployHold(approved);
  const done = [...approved, mergeHold, merged];

  it('lets go of the hold for the merge once Martin merges', () => {
    expect(mergeHold.payload).toMatchObject({ cause: 'merge' });
    expect(fold(done).hold).toBeUndefined();
    // His answer to the merge's hold, approving it, waits for the merge; the merge moves the work item past it.
    const answered = [...approved, mergeHold, answer('approved')];
    expect(decide(answered, facts)).toEqual({ stage: 'held', next: { do: 'wait', for: 'martin' } });
    expect(decide([...answered, merged], facts).next).toMatchObject({ do: 'hold', hold: { cause: 'deploy' } });
  });

  it('holds a merged change at Release, once, until a release carries it', () => {
    expect(decide(done, facts)).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'release',
          kind: 'approval',
          cause: 'deploy',
          reason: 'The fix in pull request #12 is merged, and waits for a deploy pull request to carry it to the app',
        },
      },
    });
    const holding = [...done, deployHold(done)];
    expect(decide(holding, facts)).toEqual({ stage: 'held', next: { do: 'wait', for: 'martin' } });
    expect(decide([...holding, release()], facts)).toEqual({ stage: 'release', next: { do: 'wait', for: 'release' } });
    expect(fold([...holding, release()]).hold).toBeUndefined();
  });

  it('waits at Release for the dry run’s release of a dry run’s merge, which no deploy pull request carries', () => {
    const dry = (events: LineEvent[]) =>
      events.map(
        (e): LineEvent =>
          e.type === 'pull-request.pushed' || e.type === 'pull-request.merged'
            ? ({ ...e, payload: { ...e.payload, number: 1_000_000_012 } } as LineEvent)
            : e,
      );
    expect(decide(dry(done), facts)).toEqual({ stage: 'release', next: { do: 'wait', for: 'release' } });
    expect(decide(dry([...done, release(), promoted()]), facts).next).toMatchObject({ do: 'verify' });
  });

  it('moves a promoted release’s work item to Verify, and closes it as verified once its signal has cleared', () => {
    const live = [...done, deployHold(done), release(), promoted()];
    expect(decide(live, facts)).toEqual({ stage: 'verify', next: { do: 'verify', release: promoted().payload } });
    expect(decide([...live, verified('cleared')], facts)).toEqual({
      stage: 'verify',
      next: { do: 'verified', verification: verified('cleared').payload },
    });
    const closed: LineEvent = { type: 'work-item.closed', payload: { outcome: 'verified', reason: 'Cleared' } };
    expect(decide([...live, verified('cleared'), closed], facts)).toEqual({ stage: 'ended', next: { do: 'finish' } });
  });

  it('closes a dry run’s work item as verified by the dry run’s word, as any other', () => {
    const dry = (event: LineEvent): LineEvent =>
      ({ ...event, payload: { ...event.payload, dryRun: true } }) as LineEvent;
    const live = [...done, deployHold(done), dry(release()), dry(promoted()), dry(verified('cleared'))];
    expect(decide(live, facts).next).toMatchObject({ do: 'verified', verification: { dryRun: true } });
  });

  it('leaves a live line to close a dry run’s work item, and reopen a ticket the dry run verified', () => {
    const asDryRun = (event: LineEvent): LineEvent =>
      event.type === 'pull-request.pushed' || event.type === 'pull-request.merged'
        ? ({ ...event, payload: { ...event.payload, number: 1_000_000_012 } } as LineEvent)
        : 'dryRun' in event.payload
          ? ({ ...event, payload: { ...event.payload, dryRun: true } } as LineEvent)
          : event;
    const closed = (outcome: 'verified' | 'no-change'): LineEvent => ({
      type: 'work-item.closed',
      payload: { outcome, reason: 'Ended' },
    });
    const dry = done.map(asDryRun);
    // Its pull request, open or merged, at Release or at Verify: none of it is in GitHub.
    const merge = { end: 'close', why: 'merge' };
    expect(dryRunLeft(approved.map(asDryRun), 3)).toEqual({ end: 'close', why: 'pull-request' });
    expect(dryRunLeft(dry, 3)).toEqual(merge);
    expect(dryRunLeft([...dry, ...[release(), promoted()].map(asDryRun)], 3)).toEqual(merge);
    // Martin judged it verified at Verify, where a live line held it: the line closes it as he answered.
    const hold: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'verify', kind: 'approval', cause: 'verify', reason: 'The dry run no longer runs' },
    };
    const atVerify = [...dry, ...[release(), promoted()].map(asDryRun), hold];
    expect(dryRunLeft(atVerify, 3)).toEqual(merge);
    expect(dryRunLeft([...atVerify, answer('approved', 'It looks right')], 3)).toBeUndefined();
    // Taken by the dry run, with no pull request yet: its issue is the dry run's.
    expect(dryRunLeft([ticket, spec], 1_000_000_011)).toEqual({ end: 'close', why: 'issue' });
    // Verified by the dry run's word: the defect it was opened on is still in the app.
    const verifiedDry = [...dry, ...[release(), promoted(), verified('cleared')].map(asDryRun), closed('verified')];
    expect(dryRunLeft(verifiedDry, 1_000_000_011)).toEqual({ end: 'reopen', against: 'v0.9.3' });
    // Nothing left once it is ended either way, nor on a work item the dry run never touched.
    expect(dryRunLeft([...dry, closed('no-change')], 3)).toBeUndefined();
    const reopened: LineEvent = {
      type: 'work-item.reopened',
      payload: { sense: 'probe', check: 'search', route: '/search', version: 'v0.9.3', reason: 'Again', dryRun: true },
    };
    // Reopened, and taken back into Plan with a new issue: nothing is left.
    expect(dryRunLeft([...verifiedDry, reopened], 41)).toBeUndefined();
    expect(dryRunLeft([...verifiedDry, reopened, ticket, spec], 41)).toBeUndefined();
    expect(dryRunLeft(done, 3)).toBeUndefined();
    expect(dryRunLeft([...done, release(), promoted(), verified('cleared'), closed('verified')], 3)).toBeUndefined();
  });

  it('sends the work back to Plan when its signal persists, and holds for Martin the second time', () => {
    const live = [...done, deployHold(done), release(), promoted()];
    const once = [...live, verified('persists')];
    expect(decide(once, facts)).toEqual({
      stage: 'plan',
      next: {
        do: 'return',
        from: 'verify',
        to: 'plan',
        reason: 'The probe still saw “search” on v0.9.4, the release that carried the fix',
      },
    });
    const back: LineEvent = { type: 'work.returned', payload: { from: 'verify', to: 'plan', reason: 'It persists' } };
    // The fresh pass keeps the verification for the planner, and goes round to a release of its own.
    expect(fold([...once, back]).persisted).toEqual([verified('persists').payload]);
    const second = [...once, back, ...done.slice(1), deployHold(done), release('7f5b9c8d6', 'v0.9.5')];
    const again = [...second, promoted('7f5b9c8d6', 'v0.9.5'), verified('persists')];
    expect(fold(again).persisted).toHaveLength(2);
    expect(decide(again, facts)).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'verify',
          kind: 'held',
          cause: 'verify',
          reason: 'The probe still saw “search” on v0.9.4, after 2 fixes were released: it needs Martin',
        },
      },
    });
  });

  it('settles a hold at Verify by his answer: verified, back to Plan with his words, or closed', () => {
    const live = [...done, deployHold(done), release(), promoted()];
    for (const reason of ['No sense can look again', 'The signal persisted twice']) {
      const hold: LineEvent = {
        type: 'hold.started',
        payload: { stage: 'verify', kind: 'approval', cause: 'verify', reason },
      };
      const held = [...live, hold];
      expect(decide(held, facts)).toEqual({ stage: 'held', next: { do: 'wait', for: 'martin' } });
      expect(decide([...held, answer('approved', 'The page is right now')], facts)).toEqual({
        stage: 'verify',
        next: { do: 'verified', verification: undefined, answer: 'The page is right now' },
      });
      expect(decide([...held, answer('answered', 'The banner still overlaps')], facts)).toEqual({
        stage: 'plan',
        next: { do: 'return', from: 'verify', to: 'plan', reason: 'Martin sent it back: The banner still overlaps' },
      });
      // The planner is told what he was asked, and what he said.
      expect(fold([...held, answer('answered', 'The banner still overlaps')]).answers).toEqual([
        { asked: reason, answer: 'The banner still overlaps' },
      ]);
      expect(decide([...held, answer('rejected')], facts).next).toEqual({
        do: 'close',
        reason: 'Martin rejected it',
        merged: true,
      });
    }
  });

  it('starts a fresh pass at Plan when a verified ticket reopens, keeping what the planner should know', () => {
    const closed: LineEvent = { type: 'work-item.closed', payload: { outcome: 'verified', reason: 'Cleared' } };
    const reopened: LineEvent = {
      type: 'work-item.reopened',
      payload: {
        sense: 'probe',
        check: 'search',
        route: '/search',
        version: 'v0.9.6',
        reason: 'It came back',
        dryRun: false,
      },
    };
    const persisted = [...done, deployHold(done), release(), promoted(), verified('persists')];
    const back: LineEvent = { type: 'work.returned', payload: { from: 'verify', to: 'plan', reason: 'It persists' } };
    const second = [...persisted, back, ...done.slice(1), deployHold(done), release('7f5b9c8d6', 'v0.9.5')];
    const ended = [...second, promoted('7f5b9c8d6', 'v0.9.5'), verified('cleared'), closed];
    expect(decide(ended, facts).next).toEqual({ do: 'finish' });

    const again = [...ended, reopened];
    expect(decide(again, facts)).toEqual({ stage: 'plan', next: { do: 'step', agent: 'planner', round: 1 } });
    const state = fold(again);
    expect(state).toMatchObject({ closed: false, merged: false, spec: undefined, pullRequest: undefined });
    expect(state.release).toBeUndefined();
    expect(state.persisted).toEqual([verified('persists').payload]);
    expect(state.reopened).toEqual([reopened.payload]);
    // The planner is told its last spec, and why it is back: the reopening, as a persisting fix's return before it.
    expect(state).toMatchObject({ lastSpec: spec.payload, replan: { cause: 'reopened' } });
    expect(fold([...persisted, back]).replan).toEqual({ cause: 'returned', from: 'verify', reason: 'It persists' });
    // One a dry run verified comes back to a first plan: nothing of its spec shipped.
    const dry: LineEvent = { ...reopened, payload: { ...reopened.payload, dryRun: true } };
    expect(fold([...ended, dry])).toMatchObject({ lastSpec: undefined, replan: undefined });
    // A verification that persists in the new pass sends it back to Plan once more: the limit counts this ticket's
    // regression afresh.
    const live = [...again, ...done.slice(1), deployHold(done), release('8a6c0d9e7', 'v0.9.7')];
    const persists = [...live, promoted('8a6c0d9e7', 'v0.9.7'), verified('persists')];
    expect(decide(persists, facts).next).toMatchObject({ do: 'return', from: 'verify', to: 'plan' });
    // Its fresh pass goes round as any other, to a merge and a release of its own.
    expect(decide([...again, ...done.slice(1)], facts).next).toMatchObject({ do: 'hold', hold: { cause: 'deploy' } });
  });

  it('forgets the answer that closed a work item when it reopens: his word on the last pass is not on this one', () => {
    const hold: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'verify', kind: 'approval', cause: 'verify', reason: 'No sense can look again' },
    };
    const closed: LineEvent = { type: 'work-item.closed', payload: { outcome: 'verified', reason: 'Martin said so' } };
    const reopened: LineEvent = {
      type: 'work-item.reopened',
      payload: {
        sense: 'probe',
        check: 'search',
        route: '/search',
        version: 'v0.9.6',
        reason: 'It came back',
        dryRun: false,
      },
    };
    const live = [...done, deployHold(done), release(), promoted(), hold, answer('approved', 'It looks right')];
    expect(decide(live, facts).next).toMatchObject({ do: 'verified' });
    expect(decide([...live, closed, reopened], facts)).toEqual({
      stage: 'plan',
      next: { do: 'step', agent: 'planner', round: 1 },
    });
  });

  it('keeps the spend cap in force for the fresh pass’s steps after a return from Verify', () => {
    const back: LineEvent = { type: 'work.returned', payload: { from: 'verify', to: 'plan', reason: 'It persists' } };
    const returned = [...done, deployHold(done), release(), promoted(), verified('persists'), back];
    const spend = { spentUsd: 2.5, limitUsd: 2 };
    expect(decide(returned, { ...facts, spend }).next).toMatchObject({ do: 'hold', hold: { cause: 'spend' } });
  });

  it('holds the work item again when its release rolls back, for the next', () => {
    const back = [...done, deployHold(done), release(), rolledBack()];
    expect(decide(back, facts)).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'release',
          kind: 'approval',
          cause: 'deploy',
          reason:
            'The release that carried the fix, v0.9.4, rolled back: it waits for the next deploy pull request to carry it, or for Martin to retry it',
        },
      },
    });
    const next = [...back, deployHold(back), release('7f5b9c8d6', 'v0.9.5')];
    expect(decide(next, facts).next).toEqual({ do: 'wait', for: 'release' });
    expect(decide([...next, promoted('7f5b9c8d6', 'v0.9.5')], facts).stage).toBe('verify');
  });

  it('holds the work item for Martin while its canary is paused for him, until the release ends', () => {
    const canary = (id = RELEASE): LineEvent => ({
      type: 'hold.started',
      payload: {
        stage: 'release',
        kind: 'held',
        cause: 'canary',
        reason: 'With auto-rollback off, the analysis judged the canary of v0.9.4 bad at 50%',
        release: id,
      },
    });
    const inFlight = [...done, deployHold(done), release()];
    const held = [...inFlight, canary()];
    expect(decide(held, facts)).toEqual({ stage: 'held', next: { do: 'wait', for: 'martin' } });
    expect(fold(held).hold).toMatchObject({ cause: 'canary', release: RELEASE });
    // An answer of the holds' settles nothing: the canary is still paused, and Martin's to settle on the Canary panel.
    expect(fold([...held, answer('approved')]).hold).toMatchObject({ cause: 'canary' });
    // Promoted fully past the analysis's verdict: on to Verify.
    expect(decide([...held, promoted()], facts)).toMatchObject({ stage: 'verify', next: { do: 'verify' } });
    // Aborted by Martin, it rolled back by him: it fails Release, and waits for the next deploy or his retry.
    const byMartin: LineEvent = {
      type: 'release.rolled-back',
      payload: {
        release: RELEASE,
        version: 'v0.9.4',
        restored: 'v0.9.3',
        weight: 50,
        reason: 'Metric "errors" assessed Inconclusive due to inconclusive (1) > inconclusiveLimit (0)',
        failed: [{ name: 'errors', phase: 'inconclusive', value: 0.0213, limit: 0.01, failures: 1 }],
        dryRun: false,
        by: 'martin',
        abortedAt: '2026-10-10T09:00:00Z',
      },
    };
    const rolled = [...held, byMartin];
    expect(fold(rolled).hold).toBeUndefined();
    expect(decide(rolled, facts)).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'release',
          kind: 'approval',
          cause: 'deploy',
          reason:
            'Martin aborted the release that carried the fix, v0.9.4, which the analysis judged bad, so it rolled back: it waits for the next deploy pull request to carry it, or for his retry',
        },
      },
    });
    // Stopped with the line, or ended in Error: the hold ends with it, and the release's end holds it as ever.
    expect(decide([...held, aborted('stop')], facts).next).toMatchObject({ do: 'hold', hold: { cause: 'deploy' } });
    expect(decide([...held, errored()], facts).next).toMatchObject({ do: 'hold', hold: { cause: 'deploy' } });
    // Retried after Martin's rollback, the release starts again, and a pause of the new attempt holds it again.
    const retried = [...rolled, deployHold(rolled), release()];
    expect(decide(retried, facts).next).toEqual({ do: 'wait', for: 'release' });
    expect(decide([...retried, canary()], facts).next).toEqual({ do: 'wait', for: 'martin' });
    // A canary's hold of another release, or of one that has ended, holds nothing.
    expect(decide([...inFlight, canary('6c4d2a1f9-7')], facts).next).toEqual({ do: 'wait', for: 'release' });
    expect(decide([...inFlight, promoted(), canary()], facts).stage).toBe('verify');
  });

  it('holds the work item for Martin when its release is aborted, until he retries it', () => {
    const stopped = [...done, deployHold(done), release(), aborted('stop')];
    expect(decide(stopped, facts).next).toMatchObject({
      do: 'hold',
      hold: {
        cause: 'deploy',
        reason:
          'Stop the line aborted the release that carried the fix, v0.9.4: it waits for Martin to retry it, or for the next deploy pull request to carry it',
      },
    });
    expect(decide([...done, release(), aborted('martin')], facts).next).toMatchObject({
      hold: { reason: expect.stringMatching(/^Martin aborted the release that carried the fix, v0\.9\.4:/) },
    });
    // Retried, the same release starts again, which ends the hold.
    const retried = [...stopped, deployHold(stopped), release()];
    expect(decide(retried, facts).next).toEqual({ do: 'wait', for: 'release' });
    expect(decide([...retried, promoted()], facts).stage).toBe('verify');
  });

  it('holds the work item for Martin when its release’s analysis errs, until he retries it', () => {
    const stopped = [...done, deployHold(done), release(), errored()];
    expect(decide(stopped, facts).next).toMatchObject({
      do: 'hold',
      hold: {
        cause: 'deploy',
        reason:
          'The release that carried the fix, v0.9.4, stopped when its analysis could not judge it: it waits for Martin to retry it, or for the next deploy pull request to carry it',
      },
    });
    const retried = [...stopped, deployHold(stopped), release()];
    expect(decide(retried, facts).next).toEqual({ do: 'wait', for: 'release' });
  });

  it('pays no heed to a hold for a deploy decided as a release that carries the change started', () => {
    const late = [...done, release(), deployHold(done), promoted()];
    expect(decide(late, facts).next).toMatchObject({ do: 'verify' });
  });

  it('pays no heed to a release before the merge, which cannot have carried the change', () => {
    const early = [...approved, mergeHold, release(), promoted(), merged];
    expect(decide(early, facts).next).toMatchObject({ do: 'hold', hold: { cause: 'deploy' } });
  });

  it('closes a merged work item when Martin rejects its hold at Release or Verify, saying it merged', () => {
    for (const cause of ['deploy', 'verify'] as const) {
      const hold: LineEvent = {
        type: 'hold.started',
        payload: { stage: cause === 'deploy' ? 'release' : 'verify', kind: 'approval', cause, reason: 'Held' },
      };
      expect(decide([...done, hold, answer('rejected')], facts)).toEqual({
        stage: 'held',
        next: { do: 'close', reason: 'Martin rejected it', merged: true },
      });
    }
    // Approving or answering a deploy's hold waits for him: the deploy he merges moves it on.
    const deploy = deployHold(done);
    expect(decide([...done, deploy, answer('approved')], facts).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide([...done, deploy, answer('answered', 'Soon')], facts).next).toEqual({ do: 'wait', for: 'martin' });
  });

  it('pays no heed to the end of a release other than the latest to carry it', () => {
    const later = [...done, release(), release('7f5b9c8d6', 'v0.9.5')];
    expect(decide([...later, rolledBack()], facts).next).toEqual({ do: 'wait', for: 'release' });
    expect(decide([...later, aborted('martin')], facts).next).toEqual({ do: 'wait', for: 'release' });
    expect(decide([...later, errored()], facts).next).toEqual({ do: 'wait', for: 'release' });
    expect(decide([...later, promoted()], facts).next).toEqual({ do: 'wait', for: 'release' });
  });

  it('carries a release the line found already live on to Verify, as one it watched', () => {
    const found = (event: LineEvent): LineEvent =>
      ({ ...event, payload: { ...event.payload, watched: false } }) as LineEvent;
    const live = [...done, found(release()), found(promoted())];
    expect(decide(live, facts).next).toMatchObject({ do: 'verify', release: { watched: false } });
  });

  it('starts a fresh pass when work goes back to Plan from Verify', () => {
    const live = [...done, deployHold(done), release(), promoted(), verified('persists')];
    const back: LineEvent = {
      type: 'work.returned',
      payload: { from: 'verify', to: 'plan', reason: 'The signal persists after the release' },
    };
    const again = fold([...live, back]);
    expect(again).toMatchObject({
      spec: undefined,
      pullRequest: undefined,
      gates: undefined,
      gatesPassed: false,
      review: undefined,
      reviews: [],
      described: false,
      merged: false,
      release: undefined,
      verification: undefined,
      round: 1,
    });
    expect(decide([...live, back], facts)).toEqual({ stage: 'plan', next: { do: 'step', agent: 'planner', round: 1 } });
    // The fresh pass goes round as the first did, to a merge of its own.
    const pushedAgain: LineEvent = { ...pushed(), payload: { ...pushed().payload, number: 14 } } as LineEvent;
    expect(decide([...live, back, spec], facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    expect(decide([...live, back, spec, pushedAgain], facts).next).toEqual({ do: 'wait', for: 'gates' });
  });
});

const held = (cause: HoldCause, stage: PayloadOf<'hold.started'>['stage']): LineEvent => ({
  type: 'hold.started',
  payload: { stage, kind: cause === 'merge' ? 'approval' : 'held', cause, reason: 'Held for Martin' },
});
const answer = (decision: PayloadOf<'hold.answered'>['decision'], text?: string): LineEvent => ({
  type: 'hold.answered',
  payload: { decision, ...(text ? { answer: text } : {}) },
});

describe('Martin’s answer to a hold', () => {
  const approvedAndDescribed = [ticket, spec, pushed(), started(), finished('passed'), review('approved'), summarised];

  it('writes up again a round sent back by his words while it waits for the merge', () => {
    const waiting = [...approvedAndDescribed, held('merge', 'review'), answer('answered', 'Name the test')];
    expect(decide(waiting, facts).next).toEqual({
      do: 'return',
      from: 'review',
      to: 'build',
      reason: 'Martin sent it back: Name the test',
    });
    const again = [...waiting, returned('review'), pushed(2), started(), finished('passed'), review('approved')];
    expect(decide(again, facts).next).toEqual({ do: 'step', agent: 'describer', round: 2 });
  });

  it('cuts his words to fit the reason, never inside an emoji', () => {
    const lead = 'Martin sent it back: '.length;
    const words = `${'a'.repeat(198 - lead)}😀 and more`;
    const waiting = [...approvedAndDescribed, held('merge', 'review'), answer('answered', words)];
    expect(decide(waiting, facts).next).toMatchObject({ reason: `Martin sent it back: ${'a'.repeat(198 - lead)}…` });
  });

  it('has a rule for every cause and every answer', () => {
    for (const cause of HOLD_CAUSES) {
      expect(Object.keys(ANSWERS[cause]).sort()).toEqual(['answered', 'approved', 'rejected']);
    }
  });

  it('keeps his words on a work item a visitor’s report opened from what it writes and from every agent, and acts on them', () => {
    const own = (decision: PayloadOf<'hold.answered'>['decision'], text: string): LineEvent => ({
      type: 'hold.answered',
      payload: { decision, answer: text, report: true },
    });
    const waiting = [...approvedAndDescribed, held('merge', 'review'), own('answered', 'The visitor at 4 Elm Road')];
    expect(decide(waiting, facts).next).toEqual({
      do: 'return',
      from: 'review',
      to: 'build',
      reason: 'Martin sent it back',
    });
    // No agent reads them either.
    expect(fold(waiting).answer).toMatchObject({ decision: 'answered', resolution: 'return', text: undefined });
    const planned = [ticket, held('question', 'plan'), own('answered', 'The visitor at 4 Elm Road')];
    expect(fold(planned).answers).toEqual([]);
    expect(
      decide([ticket, spec, held('gates', 'build'), own('rejected', 'The visitor at 4 Elm Road')], facts).next,
    ).toEqual({ do: 'close', reason: 'Martin rejected it', merged: false });
    const verify = [...approvedAndDescribed, held('verify', 'verify'), own('approved', 'The visitor at 4 Elm Road')];
    expect(decide(verify, facts).next).toEqual({ do: 'verified', verification: undefined });
  });

  it('closes the work item when he rejects it, whatever the cause, but a canary paused for him', () => {
    // A canary paused for Martin is answered from the Canary panel, never by a hold's answer: the admin service takes
    // none (`answersTo`), and the line would wait after one.
    expect(answersTo('canary')).toEqual([]);
    for (const cause of HOLD_CAUSES.filter((c) => c !== 'canary')) {
      expect(decide([ticket, spec, held(cause, 'build'), answer('rejected', 'Not worth it')], facts)).toEqual({
        stage: 'held',
        next: { do: 'close', reason: 'Martin rejected it: Not worth it', merged: false },
      });
    }
  });

  it('runs the planner again on an answer to its question or its rejection', () => {
    for (const cause of ['question', 'ticket-rejected'] as const) {
      expect(decide([ticket, held(cause, 'plan'), answer('answered', 'The home page')], facts).next).toEqual({
        do: 'step',
        agent: 'planner',
        round: 1,
      });
    }
    // Approving a question asks the planner to carry on as it sees fit.
    expect(decide([ticket, held('question', 'plan'), answer('approved')], facts).next).toMatchObject({
      do: 'step',
      agent: 'planner',
    });
  });

  it('closes the work item when he agrees with the planner’s rejection, or rejects the ticket himself', () => {
    for (const [decision, reason] of [
      ['approved', 'Martin agreed with the planner'],
      ['rejected', 'Martin rejected it'],
    ] as const) {
      expect(decide([ticket, held('ticket-rejected', 'plan'), answer(decision)], facts)).toEqual({
        stage: 'held',
        next: { do: 'close', reason, merged: false },
      });
    }
  });

  it('keeps every answer at Plan, with what he was asked, whatever kind of hold it answered', () => {
    const asked: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'plan', kind: 'question', cause: 'question', reason: 'A question', question: 'Which page?' },
    };
    const events = [
      ticket,
      asked,
      answer('answered', 'The home page'),
      held('ticket-rejected', 'plan'),
      answer('answered', 'It is in src/price.ts'),
      // An answer with no words, and one to a hold after Plan, are not the planner's.
      held('question', 'plan'),
      answer('approved'),
      spec,
      held('failures', 'build'),
      answer('answered', 'Try again'),
    ];
    expect(fold(events).answers).toEqual([
      { asked: 'Which page?', answer: 'The home page' },
      { asked: 'Held for Martin', answer: 'It is in src/price.ts' },
    ]);
  });

  it('holds a spec tagged out-of-scope for his approval before anything is built, whatever the autonomy', () => {
    const wide: LineEvent = {
      type: 'spec.written',
      payload: { ...(spec.payload as PayloadOf<'spec.written'>), risks: ['out-of-scope'] },
    };
    expect(decide([ticket, wide], facts)).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'plan',
          kind: 'approval',
          cause: 'spec',
          reason:
            'The spec is tagged out-of-scope: the fix changes behaviour beyond what the ticket is about, which needs Martin in every autonomy mode',
        },
      },
    });
    const approved = [ticket, wide, held('spec', 'plan'), answer('approved')];
    expect(decide(approved, facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    // Approved once, it stays approved as the work goes on; a new spec is a new question.
    expect(decide([...approved, pushed()], facts).next).toEqual({ do: 'wait', for: 'gates' });
    expect(decide([...approved, wide], facts).next).toMatchObject({ do: 'hold' });
    expect(decide([ticket, wide, held('spec', 'plan'), answer('answered', 'Only the search')], facts).next).toEqual({
      do: 'step',
      agent: 'planner',
      round: 1,
    });
  });

  it('holds a spec tagged out-of-scope written again after a push, then sends the coder to meet it', () => {
    const wide: LineEvent = {
      type: 'spec.written',
      payload: { ...(spec.payload as PayloadOf<'spec.written'>), risks: ['out-of-scope'] },
    };
    // The scope fence kept refusing a later round, and he sent the work back to the planner.
    const replanned = [ticket, spec, pushed(), returned('review'), held('scope', 'build'), answer('answered', 'Wider')];
    expect(decide(replanned, facts).next).toMatchObject({ do: 'step', agent: 'planner' });
    expect(decide([...replanned, wide], facts).next).toMatchObject({ do: 'hold', hold: { cause: 'spec' } });
    // A spec written again after a push, from a review he answered, sends the work back to the coder.
    const rewritten = [ticket, spec, pushed(), started(), finished('passed'), review('escalated'), spec];
    expect(decide(rewritten, facts).next).toEqual({
      do: 'return',
      from: 'review',
      to: 'build',
      reason: 'The planner wrote the spec again: the change is held to the new one',
    });
    expect(decide([...rewritten, returned('review')], facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
  });

  it('reviews the change again against a spec written again, even when he approves a coder that changed nothing', () => {
    const rewritten = [ticket, spec, pushed(), started(), finished('passed'), review('escalated'), spec];
    expect(fold(rewritten).review).toBeUndefined();
    // The coder finds the change already meets the new spec, and holds; he approves.
    const unchanged = [...rewritten, returned('review'), held('review', 'review'), answer('approved')];
    expect(decide(unchanged, facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 2 });
  });

  it('holds only the out-of-scope specs written under the rule, not one in the store from before it', () => {
    const before: LineEvent = {
      type: 'spec.written',
      payload: {
        ...(spec.payload as PayloadOf<'spec.written'>),
        criteria: [{ given: 'a query with a quote', when: 'it is searched', expect: 'the page lists matches' }],
        risks: ['out-of-scope'],
      },
    };
    expect(decide([ticket, before, pushed(), started()], facts).next).toEqual({ do: 'wait', for: 'gates' });
  });

  it('holds a review that cites the ticket as beyond it, and sends his answer to the planner, never the coder', () => {
    const beyond: LineEvent = {
      type: 'review.submitted',
      payload: {
        pullRequest: 12,
        verdict: 'escalated',
        note: 'Criterion 2 is not in the ticket.',
        findings: [{ ...finding, rule: undefined, criterion: 2, ticket: true }],
      },
    };
    const escalated = [ticket, spec, pushed(), started(), finished('passed'), beyond];
    expect(decide(escalated, facts).next).toMatchObject({
      do: 'hold',
      hold: { stage: 'review', cause: 'beyond-ticket' },
    });
    const answered = [...escalated, held('beyond-ticket', 'review'), answer('answered', 'Only the quote')];
    expect(decide(answered, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
    expect(decide([...answered, spec], facts).next).toMatchObject({ do: 'return', from: 'review', to: 'build' });
    const approved = [...escalated, held('beyond-ticket', 'review'), answer('approved')];
    expect(decide(approved, facts).next).toEqual({ do: 'accept', review: 1, answer: 0 });
    expect(decide([...approved, accepted()], facts).next).toEqual({ do: 'step', agent: 'describer', round: 1 });
    // An escalation that does not cite the ticket keeps the review's cause.
    expect(
      decide([ticket, spec, pushed(), started(), finished('passed'), review('escalated')], facts).next,
    ).toMatchObject({
      hold: { cause: 'review' },
    });
  });

  it('leaves a defect the planner alone noticed waiting until he approves it, and plans the ticket triage then opens', () => {
    expect(decide([held('finding', 'triage'), answer('answered')], facts).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide([held('finding', 'triage'), answer('rejected')], facts).next).toMatchObject({ do: 'close' });
    const approved = [held('finding', 'triage'), answer('approved'), ticket];
    expect(decide(approved, { ...facts, issue: null })).toEqual({ stage: 'plan', next: { do: 'open-issue' } });
    expect(decide(approved, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
  });

  it('keeps a hold of triage’s standing when he answers it in words, so Needs you still lists it', () => {
    for (const cause of WORDS_LEAVE_HELD) {
      expect(ANSWERS[cause].answered).toBe('wait');
      const words = [held(cause, 'triage'), answer('answered', 'Leave it for a sense')];
      expect(fold(words)).toMatchObject({ hold: { cause }, answer: undefined });
      expect(decide(words, facts)).toEqual({ stage: 'held', next: { do: 'wait', for: 'martin' } });
      // Words do not use up the hold: his approval after them still settles it.
      expect(fold([...words, answer('approved')])).toMatchObject({ hold: undefined, answer: { decision: 'approved' } });
    }
    // Every other cause's answer in words settles the hold.
    for (const cause of HOLD_CAUSES.filter((c) => !WORDS_LEAVE_HELD.includes(c))) {
      expect(fold([ticket, spec, held(cause, 'build'), answer('answered', 'Go on')]).hold).toBeUndefined();
    }
  });

  it('has the planner write a spec again when he answers it, and builds it when he approves', () => {
    expect(decide([ticket, spec, held('spec', 'plan'), answer('answered', 'Smaller')], facts).next).toMatchObject({
      do: 'step',
      agent: 'planner',
    });
    expect(decide([ticket, spec, held('spec', 'plan'), answer('approved')], facts).next).toMatchObject({
      do: 'step',
      agent: 'coder',
    });
  });

  it('runs a step that kept failing again, with his words', () => {
    const events = [ticket, spec, held('failures', 'build'), answer('answered', 'The tests are in test/')];
    expect(decide(events, facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    // The coder's input takes them (`answerOf`), until the work item moves on.
    expect(fold(events).answer?.text).toBe('The tests are in test/');
    expect(fold([...events, pushed()]).answer).toBeUndefined();
  });

  it('keeps the last spec and why the work came back to Plan, for the planner, until it writes another', () => {
    const needs = needsHold([{ path: 'test/flags-preview.test.ts', reason: 'It assumes no flag.' }], []);
    const hold: LineEvent = { type: 'hold.started', payload: needs };
    const approved = fold([ticket, spec, pushed(), hold, answer('approved')]);
    expect(approved).toMatchObject({ spec: undefined, lastSpec: spec.payload, pullRequest: { number: 12 } });
    expect(approved.replan).toEqual({
      cause: 'scope',
      approved: true,
      answered: false,
      reason: needs.reason,
      needs: needs.needs,
    });
    // His words, when he answers in them, are told as his.
    expect(fold([ticket, spec, pushed(), hold, answer('answered', 'Take it in.')]).replan).toMatchObject({
      approved: false,
      answered: true,
    });
    // The fence's output, for a hold the fence made.
    const fence: LineEvent = {
      type: 'action.refused',
      payload: {
        mechanism: 'scope-fence',
        guardrails: [11],
        action: 'Push',
        output: 'scope: test/\nrefused src/server.ts +1 −1',
      },
    };
    expect(fold([ticket, spec, fence, fence, held('scope', 'build'), answer('approved')]).replan).toMatchObject({
      cause: 'scope',
      fenced: 'scope: test/\nrefused src/server.ts +1 −1',
    });
    // The reviewer's findings beyond the ticket, for its escalation.
    const beyond = { ...finding, criterion: 1, ticket: true as const, comment: 'No signal asks for it.' };
    const escalated: LineEvent = {
      type: 'review.submitted',
      payload: { pullRequest: 12, verdict: 'escalated', note: 'Beyond the ticket', findings: [finding, beyond] },
    };
    const beyondHeld = [ticket, spec, pushed(), escalated, held('beyond-ticket', 'review')];
    expect(fold([...beyondHeld, answer('answered', 'Drop it.')]).replan).toMatchObject({
      cause: 'beyond-ticket',
      beyond: [beyond],
    });
    // A new spec answers it; the last spec is the new one.
    const rewritten: LineEvent = {
      ...spec,
      payload: { ...spec.payload, scope: ['src/search.ts', 'test/', 'src/x.ts'] },
    };
    const after = fold([ticket, spec, pushed(), hold, answer('approved'), rewritten]);
    expect(after).toMatchObject({ replan: undefined, lastSpec: rewritten.payload });
    // A hold that carries on at Plan sends nothing back.
    expect(fold([ticket, held('question', 'plan'), answer('answered', 'Yes')]).replan).toBeUndefined();
  });

  it('sends a scope the coder kept straying from back to Plan, with what the fence printed and what he said', () => {
    const fenced = 'scope: src/search.ts, test/\nallowed src/search.ts +1 −1\nrefused src/cards.ts +2 −0';
    const refused: LineEvent = {
      type: 'action.refused',
      payload: {
        mechanism: 'scope-fence',
        guardrails: [11],
        action: 'Push the coder’s round 1 to a new pull request',
        output: fenced,
      },
    };
    const strayed = [ticket, spec, refused, refused, held('scope', 'build')];
    const asked =
      'Held for Martin. The scope fence printed: scope: src/search.ts, test/; allowed src/search.ts +1 −1; refused src/cards.ts +2 −0.';
    const answered = [...strayed, answer('answered', 'The cards share the bug: take them in')];
    expect(decide(answered, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
    expect(fold(answered).answers).toEqual([{ asked, answer: 'The cards share the bug: take them in' }]);
    // Approving says the coder needed those files, in the line's words, not his.
    const approved = [...strayed, answer('approved')];
    expect(decide(approved, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
    expect(fold(approved).answers).toEqual([
      { asked, line: 'The coder needed those files: let the scope take them in.', approved: true },
    ]);
    expect(decide([...strayed, answer('rejected')], facts).next).toMatchObject({ do: 'close' });
  });

  it('sends the work back to the coder, with his words, from gates that kept failing', () => {
    const gates = [ticket, spec, pushed(), started(), finished('failed'), held('gates', 'gates')];
    expect(decide([...gates, answer('answered', 'The test is wrong')], facts).next).toEqual({
      do: 'return',
      from: 'gates',
      to: 'build',
      reason: 'Martin sent it back: The test is wrong',
    });
    // Once it has gone back, the coder works the next round.
    const back = [...gates, answer('answered', 'The test is wrong'), returned('gates')];
    expect(decide(back, facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
  });

  it('takes his approval of a held review in place of the reviewer’s', () => {
    const escalated = [
      ticket,
      spec,
      pushed(),
      started(),
      finished('passed'),
      review('escalated'),
      held('review', 'review'),
    ];
    // The threads of what it blocked on are answered first, saying he accepted them; then the describer writes it up.
    expect(decide([...escalated, answer('approved')], facts)).toEqual({
      stage: 'review',
      next: { do: 'accept', review: 1, answer: 0 },
    });
    expect(decide([...escalated, answer('approved'), accepted()], facts).next).toEqual({
      do: 'step',
      agent: 'describer',
      round: 1,
    });
    // His approval sends the change on as it is: the review's suggestions have no round of their own.
    const suggestion = { path: 'src/search.ts', line: 5, blocking: false, comment: 'Name it for what it does.' };
    const withSuggestion = escalated.map((e) =>
      e.type === 'review.submitted' ? { ...e, payload: { ...e.payload, findings: [finding, suggestion] } } : e,
    );
    expect(decide([...withSuggestion, answer('approved'), accepted()], facts).next).toEqual({
      do: 'step',
      agent: 'describer',
      round: 1,
    });
    expect(decide([...escalated, answer('answered', 'Rename it')], facts).next).toMatchObject({
      do: 'return',
      from: 'review',
    });
    // His words with his approval are said on the threads, unless a visitor's report opened the work item.
    expect(decide([...escalated, answer('approved', 'The test covers it')], facts).next).toEqual({
      do: 'accept',
      review: 1,
      answer: 0,
      words: 'The test covers it',
    });
    const fromReport: LineEvent = {
      type: 'hold.answered',
      payload: { decision: 'approved', answer: 'As the visitor said', report: true },
    };
    expect(decide([...escalated, fromReport], facts).next).toEqual({ do: 'accept', review: 1, answer: 0 });
    // It names his answer among all his answers to the work item's holds, by its place, for when he gave it.
    const earlier = answer('answered', 'Before the review');
    expect(decide([ticket, earlier, ...escalated.slice(1), answer('approved')], facts).next).toEqual({
      do: 'accept',
      review: 1,
      answer: 1,
    });
    // A suggestion alone has a thread to answer too, as his approval gives it no round; a review with no findings has
    // none.
    const suggests = escalated.map((e) =>
      e.type === 'review.submitted' ? { ...e, payload: { ...e.payload, findings: [suggestion] } } : e,
    );
    expect(decide([...suggests, answer('approved')], facts).next).toEqual({ do: 'accept', review: 1, answer: 0 });
    const bare = escalated.map((e) =>
      e.type === 'review.submitted' ? { ...e, payload: { ...e.payload, findings: [] } } : e,
    );
    expect(decide([...bare, answer('approved')], facts).next).toEqual({ do: 'step', agent: 'describer', round: 1 });
    // The findings his approval answers: what blocked, and the suggestions the coder has not declined.
    expect(acceptedFindings(fold(withSuggestion))).toEqual({ blocking: [finding], suggestions: [suggestion] });
    const declined: LineEvent = {
      type: 'suggestions.answered',
      payload: { pullRequest: 12, suggestions: 1, declined: [{ suggestion: 1, reason: 'No.' }] },
    };
    expect(acceptedFindings(fold([...withSuggestion, declined]))).toEqual({ blocking: [finding], suggestions: [] });
  });

  it('moves a review still blocking after the last round on by his answer: another round, his approval, or a close', () => {
    const second = [ticket, spec, pushed(1), started(), finished('passed'), review('changes-requested')];
    const last = [
      ...second,
      returned('review'),
      pushed(2),
      started(OTHER),
      finished('passed', OTHER),
      review('changes-requested'),
    ];
    const holding = decide(last, facts).next;
    expect(holding).toMatchObject({ do: 'hold', hold: { cause: 'review' } });
    const heldAtLast = [...last, held('review', 'review')];

    // An answer is another round: back to the coder with his words, then the gates and a fresh reviewer.
    const answered = [...heldAtLast, answer('answered', 'Escape it in the query builder')];
    expect(decide(answered, facts).next).toEqual({
      do: 'return',
      from: 'review',
      to: 'build',
      reason: 'Martin sent it back: Escape it in the query builder',
    });
    const third = [...answered, returned('review')];
    expect(decide(third, facts).next).toEqual({ do: 'step', agent: 'coder', round: 3 });
    expect(fold(third).rebuild).toEqual({ from: 'review', reason: 'Put it right' });
    expect(fold(third).review?.findings.filter((f) => f.blocking)).toEqual([finding]);
    const reviewed = [...third, pushed(3), started(SHA), finished('passed', SHA)];
    expect(decide(reviewed, facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 3 });
    expect(decide([...reviewed, review('approved')], facts).next).toMatchObject({ agent: 'describer' });

    // His approval stands in for the reviewer's; rejecting closes the work item.
    expect(decide([...heldAtLast, answer('approved')], facts).next).toEqual({ do: 'accept', review: 2, answer: 0 });
    expect(decide([...heldAtLast, answer('approved'), accepted(2)], facts).next).toEqual({
      do: 'step',
      agent: 'describer',
      round: 2,
    });
    expect(decide([...heldAtLast, answer('rejected')], facts).next).toMatchObject({ do: 'close' });
  });

  it('runs a reviewer that kept failing again when he answers, and closes it when he rejects', () => {
    const failed = [ticket, spec, pushed(), started(), finished('passed'), held('failures', 'review')];
    expect(decide([...failed, answer('approved')], facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 1 });
    expect(decide([...failed, answer('answered', 'Try again')], facts).next).toEqual({
      do: 'step',
      agent: 'reviewer',
      round: 1,
    });
    expect(decide([...failed, answer('rejected')], facts).next).toMatchObject({ do: 'close' });
  });

  it('runs a describer that kept failing again when he answers, and closes it when he rejects', () => {
    const failed = [
      ticket,
      spec,
      pushed(),
      started(),
      finished('passed'),
      review('approved'),
      held('failures', 'review'),
    ];
    for (const decision of [answer('approved'), answer('answered', 'Keep it short')]) {
      expect(decide([...failed, decision], facts).next).toEqual({ do: 'step', agent: 'describer', round: 1 });
    }
    expect(fold([...failed, answer('answered', 'Keep it short')]).answer?.text).toBe('Keep it short');
    expect(decide([...failed, answer('rejected')], facts).next).toMatchObject({ do: 'close' });
  });

  it('waits for his merge when he approves it, and sends it back when he answers', () => {
    const merge = [...approvedAndDescribed, held('merge', 'review')];
    expect(decide([...merge, answer('approved')], facts)).toEqual({
      stage: 'held',
      next: { do: 'wait', for: 'martin' },
    });
    expect(decide([...merge, answer('answered', 'Add a test')], facts).next).toMatchObject({
      do: 'return',
      from: 'review',
      reason: 'Martin sent it back: Add a test',
    });
  });

  it('carries on from a spend hold when he approves, and holds again while the cap stands', () => {
    const spend = { spentUsd: 5.03, limitUsd: 5 };
    const capped = [ticket, spec, held('spend', 'build'), answer('approved')];
    expect(decide(capped, facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    expect(decide(capped, { ...facts, spend }).next).toMatchObject({ do: 'hold', hold: { cause: 'spend' } });
  });

  it('accepts tests that pass without the fix when he approves, and sends them back when he answers', () => {
    const tests = [ticket, spec, pushed(), started(), finished('passed'), held('tests-first', 'gates')];
    expect(decide([...tests, answer('approved')], facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 1 });
    expect(decide([...tests, answer('answered', 'Test the Friday case')], facts).next).toEqual({
      do: 'return',
      from: 'gates',
      to: 'build',
      reason: 'Martin sent it back: Test the Friday case',
    });
  });

  it('reviews a change whose gates pass after they sent it back, on a branch the coder did not move', () => {
    // Main was merged into the branch while the coder found nothing to change, and held.
    const returnedThenHeld = [ticket, spec, pushed(), started(), finished('failed'), returned('gates')];
    expect(decide(returnedThenHeld, facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
    const passed = [...returnedThenHeld, started(OTHER), finished('passed', OTHER)];
    expect(decide(passed, facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 2 });
    const waiting = [...returnedThenHeld, held('failures', 'build'), started(OTHER), finished('passed', OTHER)];
    expect(decide([...waiting, answer('approved')], facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 2 });
    // A return from review stands, whatever the gates do.
    const fromReview = [
      ticket,
      spec,
      pushed(),
      started(),
      finished('passed'),
      review('changes-requested'),
      returned('review'),
    ];
    expect(decide([...fromReview, started(OTHER), finished('passed', OTHER)], facts).next).toMatchObject({
      agent: 'coder',
    });
  });

  it('ignores an answer when nothing is held', () => {
    expect(decide([ticket, spec, answer('rejected')], facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
  });
});

describe('a coder that changes nothing, and says why', () => {
  const why = 'The journeys fail on the basket’s total, which this change leaves alone.';
  const unchanged = (events: LineEvent[]): LineEvent => ({
    type: 'hold.started',
    payload: unchangedHold(fold(events), why),
  });

  it('holds where the work came back from, under that stage’s cause, with its reason', () => {
    const back = [ticket, spec, pushed(), started(), finished('failed'), returned('gates')];
    expect(unchangedHold(fold(back), why)).toEqual({
      stage: 'gates',
      kind: 'held',
      cause: 'gates',
      reason: `The coder changed nothing when the work came back from gates: ${why}`,
    });
    const reviewed = [ticket, spec, pushed(), started(), finished('passed'), review('changes-requested')];
    expect(unchangedHold(fold([...reviewed, returned('review')]), why)).toMatchObject({
      stage: 'review',
      cause: 'review',
    });
    // A first round has nothing returned to it: the code already does what the spec asks, which questions the spec.
    expect(unchangedHold(fold([ticket, spec]), why)).toEqual({
      stage: 'build',
      kind: 'held',
      cause: 'nothing-to-fix',
      reason: `The coder found nothing to fix: ${why}`,
    });
    expect(unchangedHold(fold([ticket, spec]), 'x'.repeat(400)).reason).toHaveLength(300);
  });

  it('waits for Martin, then does as he answers a hold of the gates’: back to the coder, or closed', () => {
    const back = [ticket, spec, pushed(), started(), finished('failed'), returned('gates')];
    const holding = [...back, unchanged(back)];
    expect(decide(holding, facts)).toEqual({ stage: 'held', next: { do: 'wait', for: 'martin' } });
    expect(decide([...holding, answer('answered', 'Fix the total too')], facts).next).toEqual({
      do: 'return',
      from: 'gates',
      to: 'build',
      reason: 'Martin sent it back: Fix the total too',
    });
    expect(decide([...holding, answer('approved')], facts).next).toMatchObject({ do: 'return', from: 'gates' });
    expect(decide([...holding, answer('rejected')], facts).next).toMatchObject({ do: 'close' });
    // Sent back, the coder's next round starts.
    const again = [...holding, answer('answered', 'Fix the total too'), returned('gates')];
    expect(decide(again, facts).next).toEqual({ do: 'step', agent: 'coder', round: 3 });
  });

  it('takes his approval of a hold after review in place of the reviewer’s: the coder has nothing left to do', () => {
    const reviewed = [ticket, spec, pushed(), started(), finished('passed'), review('changes-requested')];
    const back = [...reviewed, returned('review')];
    const holding = [...back, unchanged(back)];
    expect(decide([...holding, answer('approved')], facts).next).toEqual({ do: 'accept', review: 1, answer: 0 });
    expect(decide([...holding, answer('approved'), accepted()], facts).next).toEqual({
      do: 'step',
      agent: 'describer',
      round: 2,
    });
    expect(fold([...holding, answer('approved')]).rebuild).toBeUndefined();
    expect(decide([...holding, answer('answered', 'Do as the reviewer asks')], facts).next).toMatchObject({
      do: 'return',
      from: 'review',
      reason: 'Martin sent it back: Do as the reviewer asks',
    });
  });

  it('closes a first round that found nothing to fix when he agrees, and has the planner write the spec again when he answers', () => {
    const holding = [ticket, spec, unchanged([ticket, spec])];
    expect(decide([...holding, answer('approved')], facts)).toEqual({
      stage: 'held',
      next: { do: 'close', reason: 'Martin agreed with the coder', merged: false },
    });
    const answered = [...holding, answer('answered', 'It breaks on a basket of one')];
    expect(decide(answered, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
    expect(fold(answered).answers).toEqual([
      { asked: `The coder found nothing to fix: ${why}`, answer: 'It breaks on a basket of one' },
    ]);
  });
});

const signal = (version = 'c'.repeat(7)): LineEvent => ({
  type: 'signal.received',
  payload: { sense: 'probe', check: 'search answers', route: '/search', version },
});
const look = (
  outcome: PayloadOf<'signal.rechecked'>['outcome'],
  release = 'r2',
  occasion: PayloadOf<'signal.rechecked'>['for'] = 'release',
): LineEvent => ({
  type: 'signal.rechecked',
  payload: {
    for: occasion,
    outcome,
    sense: 'probe',
    check: 'search answers',
    release,
    version: 'd728dbe',
    against: 'c'.repeat(7),
    carried: ['1033'],
    ...(outcome === 'unsure' ? { why: 'the check could not tell' } : {}),
  },
});
const holdOf = (cause: HoldCause, stage: PayloadOf<'hold.started'>['stage'] = 'build') => held(cause, stage);
const stable = { release: 'r2', version: 'd728dbe', due: true };

describe('an open ticket looked at again as the line takes it', () => {
  const opened = [ticket, signal()];
  const fresh = { ...facts, issue: null };

  it('looks before its issue opens or the planner starts, when its signal is not seen on the stable version', () => {
    expect(decide(opened, { ...fresh, stable })).toEqual({ stage: 'plan', next: { do: 'recheck', for: 'take' } });
    expect(decide(opened, { ...facts, stable }).next).toEqual({ do: 'recheck', for: 'take' });
    // Seen on that version, or with no release known, it goes on to Plan as it did.
    expect(decide([...opened, signal('d728dbe')], { ...fresh, stable }).next).toEqual({ do: 'open-issue' });
    expect(decide(opened, fresh).next).toEqual({ do: 'open-issue' });
    // A visitor's report alone has no sense to look again.
    const report: LineEvent = {
      type: 'signal.received',
      payload: { sense: 'report', check: 'search answers', route: '/search', version: 'c'.repeat(7) },
    };
    expect(decide([ticket, report], { ...fresh, stable }).next).toEqual({ do: 'open-issue' });
  });

  it('closes as verified, with no issue opened, when its signal cleared', () => {
    const decision = decide([...opened, look('cleared', 'r2', 'take')], { ...fresh, stable });
    expect(decision.stage).toBe('plan');
    expect(decision.next).toMatchObject({ do: 'verified', verification: undefined, rechecked: { for: 'take' } });
  });

  it('goes on to Plan once the look still sees it or cannot tell, and does not look at that release again', () => {
    for (const outcome of ['persists', 'unsure'] as const) {
      expect(decide([...opened, look(outcome, 'r2', 'take')], { ...fresh, stable }).next).toEqual({
        do: 'open-issue',
      });
      expect(decide([...opened, look(outcome, 'r2', 'take')], { ...facts, stable }).next).toMatchObject({
        do: 'step',
        agent: 'planner',
      });
    }
  });

  it('never looks at a ticket planned before, reopened, held or waiting as a take', () => {
    const reopened: LineEvent = {
      type: 'work-item.reopened',
      payload: {
        sense: 'probe',
        check: 'search answers',
        route: '/search',
        version: 'c'.repeat(7),
        reason: 'Back',
        dryRun: false,
      },
    };
    expect(atTake(fold(opened))).toBe(true);
    expect(atTake({ ...fold(opened), lastSpec: fold([spec]).spec })).toBe(false);
    expect(atTake(fold([...opened, holdOf('failures', 'plan')]))).toBe(false);
    expect(decide([...opened, reopened], { ...facts, stable }).next).not.toMatchObject({ do: 'recheck' });
  });
});

describe('a held work item looked at again', () => {
  const opened = [ticket, signal()];

  it('closes by itself only for a hold the line made because its steps, gates or cap stopped the work', () => {
    const closes = (cause: HoldCause, events: LineEvent[] = []) =>
      closesWhenCleared(fold([...opened, spec, ...events, holdOf(cause)]));
    const self = HOLD_CAUSES.filter((cause) => closes(cause));
    expect(new Set(self)).toEqual(new Set(['scope', 'failures', 'gates', 'spend']));
    // A review hold is the line's when the reviewer asked for changes once too often, and Martin's when it escalated.
    const reviewed = (verdict: 'changes-requested' | 'escalated') => [
      pushed(),
      started(),
      finished('passed'),
      review(verdict),
    ];
    expect(closes('review', reviewed('changes-requested'))).toBe(true);
    expect(closes('review', reviewed('escalated'))).toBe(false);
    expect(closes('review')).toBe(false);
  });

  it('looks again once at each release, not at one a signal was seen on, and not past the window', () => {
    const events = [...opened, spec, holdOf('gates', 'gates')];
    expect(decide(events, { ...facts, stable })).toEqual({ stage: 'held', next: { do: 'recheck', for: 'release' } });
    expect(decide(events, facts).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide(events, { ...facts, stable: { ...stable, due: false } }).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide([...events, signal('d728dbe')], { ...facts, stable }).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide([...events, look('persists')], { ...facts, stable }).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide([...events, look('unsure')], { ...facts, stable }).next).toEqual({ do: 'wait', for: 'martin' });
    // A later release is looked at again, and a new hold looks at the same one again.
    expect(decide([...events, look('persists')], { ...facts, stable: { ...stable, release: 'r3' } }).next).toEqual({
      do: 'recheck',
      for: 'release',
    });
    expect(decide([...events, look('persists'), holdOf('gates', 'gates')], { ...facts, stable }).next).toMatchObject({
      do: 'recheck',
    });
  });

  it('never looks again once a release of its own fix is out: that is Verify’s look', () => {
    const merged: LineEvent = { type: 'pull-request.merged', payload: { number: 12, commit: OTHER, by: 'martin' } };
    const release = { release: 'r1', version: 'v0.9.4', previous: 'v0.9.3', watched: true, dryRun: false };
    const events = [...opened, spec, pushed(), merged, holdOf('deploy', 'release')];
    expect(decide(events, { ...facts, stable }).next).toEqual({ do: 'recheck', for: 'release' });
    const shipped = [
      ...opened,
      spec,
      pushed(),
      merged,
      { type: 'release.started', payload: { ...release, steps: null, image: undefined } } as unknown as LineEvent,
      { type: 'release.promoted', payload: release } as LineEvent,
      holdOf('verify', 'verify'),
    ];
    expect(decide(shipped, { ...facts, stable }).next).toEqual({ do: 'wait', for: 'martin' });
  });

  it('never looks again at a ticket no sense can look at, nor at one of triage’s holds', () => {
    const report: LineEvent = {
      type: 'signal.received',
      payload: { sense: 'report', check: 'a visitor’s report', route: '/search', version: 'c'.repeat(7) },
    };
    expect(decide([ticket, report, spec, holdOf('gates')], { ...facts, stable }).next).toEqual({
      do: 'wait',
      for: 'martin',
    });
    for (const cause of WORDS_LEAVE_HELD) {
      expect(decide([...opened, holdOf(cause, 'triage')], { ...facts, stable }).next).toEqual({
        do: 'wait',
        for: 'martin',
      });
    }
  });

  it('closes a hold of the line’s own as verified when the signal cleared, saying what cleared it', () => {
    const events = [
      ...opened,
      spec,
      pushed(),
      started(),
      finished('failed'),
      holdOf('gates', 'gates'),
      look('cleared'),
    ];
    const decision = decide(events, { ...facts, stable });
    expect(decision).toMatchObject({ stage: 'held', next: { do: 'verified', verification: undefined } });
    expect(decision.next.do === 'verified' && decision.next.rechecked?.carried).toEqual(['1033']);
  });

  it('only records the clearance on a hold that waits on Martin’s judgement, until a signal on that version ends it', () => {
    const events = [...opened, spec, pushed(), started(), finished('passed'), review('approved'), summarised];
    const merge = [...events, holdOf('merge', 'review'), look('cleared')];
    expect(decide(merge, { ...facts, stable }).next).toEqual({ do: 'wait', for: 'martin' });
    expect(fold(merge).cleared?.version).toBe('d728dbe');
    expect(fold([...merge, signal('d728dbe')]).cleared).toBeUndefined();
    // A signal late from the version before the look says nothing of it; one from a later version ends it too.
    expect(fold([...merge, signal('c'.repeat(7))]).cleared).toBeDefined();
    expect(fold([...merge, signal('e'.repeat(7))]).cleared).toBeUndefined();
    expect(fold([...merge, look('persists', 'r3')]).cleared).toBeUndefined();
  });

  it('forgets a look once the hold is answered, or another starts', () => {
    const events = [...opened, spec, holdOf('spec', 'plan'), look('cleared')];
    expect(fold([...events, { type: 'hold.answered', payload: { decision: 'approved' } }]).cleared).toBeUndefined();
    expect(fold([...events, holdOf('question', 'plan')]).rechecked).toBeUndefined();
  });
});

describe('a spec that overlaps work in flight', () => {
  const opened = [ticket, signal()];
  const overlaps = [{ workItem: '1028', files: ['src/search.ts'] }];
  const waits: LineEvent = {
    type: 'wait.started',
    payload: {
      on: ['1028'],
      files: ['src/search.ts'],
      reason: 'Waits for #1028, whose spec also changes src/search.ts',
    },
  };

  it('waits after Plan, before the coder and before a spec that needs Martin is held for him', () => {
    expect(decide([...opened, spec], { ...facts, overlaps })).toEqual({
      stage: 'waiting',
      next: { do: 'wait-on', on: ['1028'], files: ['src/search.ts'] },
    });
    const risky: LineEvent = {
      type: 'spec.written',
      payload: { ...(spec.payload as PayloadOf<'spec.written'>), risks: ['out-of-scope'] },
    };
    expect(decide([...opened, risky], { ...facts, overlaps }).next).toMatchObject({ do: 'wait-on' });
    expect(decide([...opened, spec], facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
  });

  it('does not wait once there is a pull request, or the coder is sent back', () => {
    expect(decide([...opened, spec, pushed()], { ...facts, overlaps }).next).toEqual({ do: 'wait', for: 'gates' });
  });

  it('waits until every work item it waits on has closed, then looks again', () => {
    const events = [...opened, spec, waits];
    expect(decide(events, { ...facts, overlaps })).toEqual({ stage: 'waiting', next: { do: 'wait', for: 'overlap' } });
    expect(decide(events, { ...facts, waitedOn: { '1028': null } }).next).toEqual({ do: 'wait', for: 'overlap' });
    // With nothing known of the work it waits on, it waits on.
    expect(decide(events, facts).next).toEqual({ do: 'wait', for: 'overlap' });
    const closed = { '1028': { closedAt: '2026-10-17T13:30:00Z' } };
    expect(decide(events, { ...facts, waitedOn: closed })).toEqual({
      stage: 'waiting',
      next: { do: 'recheck', for: 'wait' },
    });
    // A release while it waits is looked at as for a hold.
    expect(decide(events, { ...facts, waitedOn: { '1028': null }, stable }).next).toEqual({
      do: 'recheck',
      for: 'release',
    });
  });

  it('closes as verified on a look that clears, and goes on to Build on one that persists or cannot tell', () => {
    const events = [...opened, spec, waits];
    expect(decide([...events, look('cleared', 'r2', 'wait')], facts)).toMatchObject({
      stage: 'waiting',
      next: { do: 'verified' },
    });
    expect(decide([...events, look('cleared')], facts).next).toMatchObject({ do: 'verified' });
    for (const outcome of ['persists', 'unsure'] as const) {
      expect(decide([...events, look(outcome, 'r2', 'wait')], { ...facts, overlaps }).next).toEqual({
        do: 'step',
        agent: 'coder',
        round: 1,
      });
    }
    // A release's look that persists does not end the wait.
    expect(decide([...events, look('persists')], facts).next).toEqual({ do: 'wait', for: 'overlap' });
  });

  it('checks a spec written again before a push again', () => {
    const events = [...opened, spec, waits, look('persists', 'r2', 'wait'), spec];
    expect(decide(events, { ...facts, overlaps }).next).toMatchObject({ do: 'wait-on' });
  });
});

describe('an improvement Martin asked for', () => {
  const requested: LineEvent = {
    type: 'improvement.requested',
    payload: { words: 'Show each product’s delivery date on its page.', steppedUp: true },
  };
  const specHold = (events: readonly LineEvent[]) => {
    const decision = decide(events, facts);
    if (decision.next.do !== 'hold') throw new Error(`no hold: ${JSON.stringify(decision)}`);
    return { stage: decision.stage, hold: decision.next.hold };
  };
  const approve = answer('approved');
  const built = [requested, spec, held('spec', 'plan'), approve, pushed(), started(), finished('passed')];
  const approvedAndDescribed = [...built, review('approved'), summarised];
  const mergedImprovement = [...approvedAndDescribed, held('merge', 'review'), merged];

  it('opens its issue and plans it, as a ticket', () => {
    expect(decide([requested], { ...facts, issue: null })).toEqual({ stage: 'plan', next: { do: 'open-issue' } });
    expect(decide([requested], facts)).toEqual({ stage: 'plan', next: { do: 'step', agent: 'planner', round: 1 } });
  });

  it('holds every spec for Martin before any code, whatever its risks', () => {
    expect(specHold([requested, spec])).toEqual({
      stage: 'held',
      hold: {
        stage: 'plan',
        kind: 'approval',
        cause: 'spec',
        reason:
          'The spec of an improvement Martin asked for: it waits for his approval before any code is written, in every autonomy mode',
      },
    });
    // A spec from before the planner named where each criterion is from is held too: no ticket's rule lets it by.
    const old: LineEvent = {
      type: 'spec.written',
      payload: { ...(spec.payload as PayloadOf<'spec.written'>), criteria: [{ given: 'a', when: 'b', expect: 'c' }] },
    };
    expect(specHold([requested, old]).hold.cause).toBe('spec');
    // A ticket whose request a worker appended would never be read: the line reads Martin's commands from his roles.
    expect(decide([ticket, spec], facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
  });

  it('builds once he approves, closes when he rejects, and plans again, held again, when he answers', () => {
    const holding = [requested, spec, held('spec', 'plan')];
    expect(decide(holding, facts)).toEqual({ stage: 'held', next: { do: 'wait', for: 'martin' } });
    expect(decide([...holding, approve], facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    expect(decide([...holding, answer('rejected')], facts).next).toMatchObject({ do: 'close', merged: false });
    const answered = [...holding, answer('answered', 'Only on the product page')];
    expect(decide(answered, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
    expect(specHold([...answered, spec]).hold.cause).toBe('spec');
    // A spec written again after his approval is held again.
    expect(specHold([...holding, approve, pushed(), spec]).hold.cause).toBe('spec');
  });

  it('holds the spec the planner widens for the files its coder needs, so he sees the wider scope before any code', () => {
    const needs = [{ path: 'test/flags-preview.test.ts', reason: 'It assumes / asks no flag; every page now does.' }];
    const needing: LineEvent = { type: 'hold.started', payload: needsHold(needs, []) };
    const back = [requested, spec, held('spec', 'plan'), approve, needing, approve];
    expect(decide(back, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
    const wider: LineEvent = {
      type: 'spec.written',
      payload: { ...(spec.payload as PayloadOf<'spec.written'>), scope: ['src/', 'test/flags-preview.test.ts'] },
    };
    expect(specHold([...back, wider]).hold.cause).toBe('spec');
  });

  it('holds a spec written while the last was held afresh: his answer to the old card approves nothing', () => {
    const swapped: LineEvent = {
      type: 'spec.written',
      payload: { ...(spec.payload as PayloadOf<'spec.written'>), scope: ['src/'] },
    };
    const events = [requested, spec, held('spec', 'plan'), swapped];
    expect(specHold(events).hold.cause).toBe('spec');
    expect(specHold([...events, approve]).hold.cause).toBe('spec');
    expect(decide([...events, held('spec', 'plan'), approve], facts).next).toEqual({
      do: 'step',
      agent: 'coder',
      round: 1,
    });
  });

  it('waits on overlapping work until it closes, with no look again, and goes on to the hold', () => {
    const overlaps = [{ workItem: '1028', files: ['src/search.ts'] }];
    expect(decide([requested, spec], { ...facts, overlaps }).next).toMatchObject({ do: 'wait-on' });
    const waits: LineEvent = {
      type: 'wait.started',
      payload: { on: ['1028'], files: ['src/search.ts'], reason: 'Waits for #1028' },
    };
    const events = [requested, spec, waits];
    expect(decide(events, { ...facts, waitedOn: { '1028': null }, stable }).next).toEqual({
      do: 'wait',
      for: 'overlap',
    });
    const closed = { '1028': { closedAt: '2026-10-17T13:30:00Z' } };
    const over = decide(events, { ...facts, waitedOn: closed });
    expect(over.next).toMatchObject({ do: 'hold', hold: { cause: 'spec' } });
    // Once it has moved on, the wait is over for good, whatever the work it waited on does next.
    const moved = [...events, held('spec', 'plan'), approve];
    expect(fold(moved).waiting?.ended).toBe(true);
    expect(decide(moved, { ...facts, waitedOn: { '1028': null } }).next).toEqual({
      do: 'step',
      agent: 'coder',
      round: 1,
    });
  });

  it('never looks again at a held improvement: it has no signal', () => {
    const holding = [requested, signal(), spec, held('spec', 'plan'), approve, pushed(), held('gates', 'gates')];
    expect(decide(holding, { ...facts, stable }).next).toEqual({ do: 'wait', for: 'martin' });
    expect(closesWhenCleared(fold(holding))).toBe(false);
  });

  it('waits for Martin’s merge in every mode, saying so', () => {
    expect(specHold(approvedAndDescribed)).toEqual({
      stage: 'held',
      hold: {
        stage: 'review',
        kind: 'approval',
        cause: 'merge',
        reason:
          'The improvement in pull request #12 has passed its gates and review, and waits for Martin to merge it, as an improvement does in every mode',
      },
    });
  });

  it('is handed over once a release that carries it is promoted, never verified by a sense', () => {
    expect(specHold(mergedImprovement)).toMatchObject({
      hold: {
        cause: 'deploy',
        reason:
          'The improvement in pull request #12 is merged, and waits for a deploy pull request to carry it to the app',
      },
    });
    const live = [...mergedImprovement, held('deploy', 'release'), release()];
    expect(decide(live, facts)).toEqual({ stage: 'release', next: { do: 'wait', for: 'release' } });
    expect(decide([...live, promoted()], facts)).toEqual({
      stage: 'ended',
      next: { do: 'hand-over', release: promoted().payload },
    });
  });

  it('holds for the next deploy when the release that carried it rolled back', () => {
    const rolled = [...mergedImprovement, release(), rolledBack()];
    expect(specHold(rolled)).toMatchObject({
      stage: 'held',
      hold: {
        stage: 'release',
        cause: 'deploy',
        reason:
          'The release that carried the improvement, v0.9.4, rolled back: it waits for the next deploy pull request to carry it, or for Martin to retry it',
      },
    });
    expect(decide([...rolled, held('deploy', 'release'), release('r9'), promoted('r9')], facts).next).toMatchObject({
      do: 'hand-over',
    });
  });

  it('waits for a dry run’s release, then is handed over; a live line closes what the dry run left', () => {
    const dryNumber = (event: LineEvent): LineEvent =>
      event.type === 'pull-request.pushed' || event.type === 'pull-request.merged'
        ? ({ ...event, payload: { ...event.payload, number: 1_000_000_012 } } as LineEvent)
        : event;
    const dryRun = (event: LineEvent): LineEvent =>
      ({ ...event, payload: { ...event.payload, dryRun: true } }) as LineEvent;
    const dry = mergedImprovement.map(dryNumber);
    expect(decide(dry, facts)).toEqual({ stage: 'release', next: { do: 'wait', for: 'release' } });
    const handed = [...dry, dryRun(release()), dryRun(promoted())];
    expect(decide(handed, facts).next).toMatchObject({ do: 'hand-over', release: { dryRun: true } });
    expect(dryRunLeft(handed, 1_000_000_011)).toEqual({ end: 'close', why: 'merge' });
  });
});
