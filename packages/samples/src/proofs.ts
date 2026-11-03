/**
 * `make guardrails`, run once from a clean checkout of main on the last morning: each proof the catalogue lists
 * (`policy/guardrails.ts`), as the proofs' role appends it. Those read from CI name the merge-group run of main's tests
 * they read. Every one held but the egress proof: an outside address by number answered from the runners, so
 * guardrail 5 reads "did not hold" until that same proof holds again. Guardrail 8 has no proof but its attack, which
 * cannot be launched yet, so it reads "not proved".
 */
import type { NewEvent } from '@software-factory/events';
import { PROOFS as CATALOGUE, CI_PROOFS, guardrailsProvedBy, type ProofId } from '../../../policy/guardrails.ts';
import { commitFor, digestFor, uuidFor } from './build.ts';

const MAIN = commitFor('main/2026-10-06');
/** The hash of the policies and Roles the proofs were taken against (`policyHash`). */
const POLICIES = digestFor('policies/2026-10-06').slice('sha256:'.length);

/** What each proof printed, in a line or two, as its script does. */
const OUTPUT: Record<ProofId, string> = {
  'workflow-refusal':
    "PUT .github/workflows/check.yml as the factory's App: 403 refusing to allow a GitHub App to create or update workflow without `workflows` permission\nheld",
  'app-permissions':
    '2 Apps installed in the-roganator, each with exactly its declared permissions; none writes Variables, Administration, Workflows, secrets or environments\nheld',
  bypass: 'main: 1 ruleset, bypass list seen and empty; no push bypassed a ruleset in the last 7 days\nheld',
  'ci:gates-deterministic':
    'tests passed: scripts/github-settings.test.ts, scripts/merge-decisions.test.ts, scripts/review-gate.test.ts',
  admission:
    'unsigned image: refused · signed by another identity: refused · third-party image not named by digest: refused\nheld',
  'production-writes':
    'rollout patch, flag write, flag stage, share key, route and mark: each refused · telemetry proxy: reads only\nheld',
  egress:
    'runners → example.com, api.anthropic.com: refused · runners → 93.184.215.14: allowed · runners → gateway, line: allowed\nnot held',
  'ci:one-gateway': 'tests passed: credentials.test.ts, runner-fences.test.ts, one-gateway.runners.test.ts',
  'ci:spend-caps': 'tests passed: spend-caps.gateway.test.ts',
  'ci:public-hostile': 'tests passed: workflows.test.ts, public-hostile.issues.test.ts, review-gate.test.ts',
  'ci:scope-fence': 'tests passed: scope-fence.runners.test.ts, scope-fence.coder.test.ts, scope-fence.line.test.ts',
  'ci:stopped-line':
    'tests passed: stopped-line.gateway.test.ts, stopped-line.line.test.ts, stopped-line.runners.test.ts',
  'stop-the-line': 'stopped: no step running, no new take, agents refused; started again\nheld',
  rollback: 'the last rollback: v0.9.10 at 12:26, by its analysis: latency failed twice\nheld',
};

const START = Date.parse('2026-10-06T12:00:00.000Z');

export const PROOFS: NewEvent<'guardrail.proved'>[] = (Object.keys(CATALOGUE) as ProofId[]).map((proof, i) => {
  const ts = new Date(START + i * 4000).toISOString();
  const ci = proof in CI_PROOFS;
  return {
    id: uuidFor(`proofs/${proof}`),
    ts,
    work_item: null,
    type: 'guardrail.proved',
    version: 1,
    actor: 'factory',
    summary: `make guardrails: ${proof} ${proof === 'egress' ? 'did not hold' : 'held'}`,
    payload: {
      guardrails: guardrailsProvedBy(proof),
      proof,
      mechanism: CATALOGUE[proof].mechanism,
      held: proof !== 'egress',
      output: OUTPUT[proof],
      commit: MAIN,
      ...(ci
        ? {
            run: {
              url: 'https://github.com/the-roganator/cv-software-factory/actions/runs/1834402',
              at: '2026-10-06T11:20:00.000Z',
            },
          }
        : { policyHash: POLICIES }),
    },
    artifacts: [],
  };
});
