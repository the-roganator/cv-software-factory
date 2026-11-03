import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import type { AttackDoor, DoorResult } from '../../src/red-team/github.ts';
import { testAttempt, workflowAttempt } from '../../src/red-team/github.ts';
import type { AttemptContext } from '../../src/red-team/worker.ts';
import type { SignedRefusal } from '../../src/signed-refusals.ts';
import { fakeEvents, fakeSql, never, silent } from './fakes.ts';

function ctx(events = fakeEvents()): AttemptContext {
  return {
    sql: fakeSql(() => []),
    events,
    workItem: '1274',
    launchedAt: new Date(),
    limitMs: 1000,
    log: silent,
    signal: never,
  };
}

const refusal = (
  mechanism: 'github-guard' | 'token-permission' | 'review-gate',
  number: number | null,
): SignedRefusal => ({
  repo: number === null ? 'the-roganator/cv-software-factory' : 'the-roganator/cv-worlds-worst-website',
  number,
  at: '2026-11-03T12:00:00.000Z',
  payload: { mechanism, action: `${mechanism} action`, output: `${mechanism} output`, guardrails: [1] },
  record: 'a'.repeat(64),
  signature: `${'c2ln'.repeat(22).slice(0, 86)}==`,
});

const door =
  (result: DoorResult): AttackDoor =>
  async () =>
    result;

describe('attack 2 (workflow)', () => {
  it('relays the guard’s refusal then GitHub’s, in order, and is refused', async () => {
    const events = fakeEvents();
    const result = await workflowAttempt({
      door: door({ refusals: [refusal('github-guard', null), refusal('token-permission', null)] }),
    })(ctx(events));
    expect(result.outcome).toBe('refused');
    expect(result.refusals).toEqual([100, 101]);
    // Each relayed refusal carries the signed record and signature, on the attack's work item.
    const payloads = events.appended.map((e) => e.payload as PayloadOf<'action.refused'>);
    expect(payloads.map((p) => p.mechanism)).toEqual(['github-guard', 'token-permission']);
    expect(payloads.every((p) => p.record && p.signature)).toBe(true);
  });

  it('is not refused when GitHub accepted the workflow', async () => {
    const result = await workflowAttempt({
      door: door({ refusals: [refusal('github-guard', null)], gotThrough: { what: 'GitHub accepted the workflow' } }),
    })(ctx());
    expect(result.outcome).toBe('not-refused');
  });
});

describe('attack 3 (test)', () => {
  const pullRequest = { repository: 'the-roganator/cv-worlds-worst-website', number: 5, head: 'a'.repeat(40) };
  it('relays the review check’s refusal and names the pull request it opened', async () => {
    const events = fakeEvents();
    const result = await testAttempt({ door: door({ refusals: [refusal('review-gate', 5)], pullRequest }) })(
      ctx(events),
    );
    expect(result.outcome).toBe('refused');
    expect(result.refusals).toEqual([100]);
    expect(result.subject).toEqual({ pullRequest });
  });

  it('is unfinished, not a finding, when the review check never concluded', async () => {
    const result = await testAttempt({
      door: door({ refusals: [], pullRequest, unconcluded: { what: 'the review check did not conclude' } }),
    })(ctx());
    expect(result.outcome).toBe('unfinished');
    expect(result.subject).toEqual({ pullRequest });
  });

  it('is not refused when the review check did not hold the pull request', async () => {
    const result = await testAttempt({
      door: door({ refusals: [], pullRequest, gotThrough: { what: 'the review check passed' } }),
    })(ctx());
    expect(result.outcome).toBe('not-refused');
    expect(result.subject).toEqual({ pullRequest });
  });
});
