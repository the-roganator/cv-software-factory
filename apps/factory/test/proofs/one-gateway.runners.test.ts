/**
 * Proves `ci:one-gateway` (policy/guardrails.ts, spec 6 guardrail 6), with credentials.test.ts and
 * runner-fences.test.ts: the agent pod a runner starts holds its job token, never a model's key, and calls the gateway.
 * Martin's (CODEOWNERS), as every file here is: a change to what they assert is a change to the proof.
 */
import { describe, expect, it } from 'vitest';
import { agentJob, prepareJob } from '../../src/runners/jobs.ts';
import { STEP } from '../runners-harness.ts';

describe('a runner’s jobs', () => {
  const names = { job: 'coder-1001-1-1', workItem: '1001' };

  it('give only the agent pod its job token, the gateway and the handback', () => {
    const settings = {
      image: 'runner',
      deadlineSeconds: 1200,
      gatewayUrl: 'http://gateway',
      handbackUrl: 'http://line/v1/handback',
      token: 'sfj_x',
      hosts: [{ ip: '10.43.0.9', hostnames: ['gateway'] }],
    };
    const agentEnv = Object.fromEntries(
      agentJob(names, STEP, settings).spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? [],
    );
    const prepareEnv = Object.fromEntries(
      prepareJob(names, STEP, settings).spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? [],
    );
    expect(agentEnv).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://gateway',
      ANTHROPIC_API_KEY: 'sfj_x',
      HANDBACK_URL: 'http://line/v1/handback',
    });
    expect(prepareEnv).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(JSON.parse(agentEnv.RUNNER_STEP ?? '{}')).toEqual(STEP);
  });
});
