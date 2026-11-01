/**
 * Proves `ci:stopped-line` (policy/guardrails.ts, spec 6 guardrail 9), with the gateway's and the line's tests beside
 * it: a step in hand when the line stops is ended, its jobs deleted and its token ended. Martin's (CODEOWNERS), as
 * every file here is: a change to what they assert is a change to the proof.
 */
import { jobForToken } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import { database, line, STEP, withRunnersStore } from '../runners-harness.ts';

withRunnersStore();

describe('a step, when the line stops', () => {
  it('stops a step in hand when the line stops: its jobs go, and its token ends', async () => {
    let token = '';
    const { runners, calls, close } = await line((env) => {
      token = env.ANTHROPIC_API_KEY ?? '';
      // An agent still working, that would never hand back.
      return new Promise<void>(() => {});
    });
    const running = runners.run({ ...STEP, workItem: '1007', round: 1, deadlineSeconds: 60 });
    while (!token) await new Promise((resolve) => setTimeout(resolve, 5));
    await runners.cancel();
    const outcome = await running;
    await close();
    expect(outcome).toEqual({ kind: 'stopped', job: 'coder-1007-1-1' });
    expect(calls).toContain('DELETE /apis/batch/v1/namespaces/runners/jobs/coder-1007-1-1-agent');
    expect(await jobForToken(database.as.line, token)).toBeUndefined();
  });
});
