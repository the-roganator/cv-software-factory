/**
 * The smoke run: one runner, end to end, on a defect seeded in a scratch copy of the app. The prepare pod applies
 * the seed to a checkout of the app's main and commits it as the base; the coder writes a failing test and the fix
 * on the local model or Claude; the scope fence checks the patch; and the GitHub worker, in a dry run, applies it to
 * the seeded base outside the sandbox and records the commit it would have made. Nothing reaches GitHub.
 *
 * The seed is a module of its own, so the run touches none of the app's own defects.
 *
 * Each run is a work item of its own, which no ticket has (`oneRunWorkItem`): the gateway caps what a work item
 * spends over all time, so runs that shared one would soon use up its cap, and from then on every run would be
 * refused.
 */
import { randomBytes } from 'node:crypto';
import { cutTo } from '@software-factory/events';
import type { Logger } from 'pino';
import type { GitHubWorker } from '../github/worker-client.ts';
import { APP_REPOSITORY } from '../repositories.ts';
import { type Fenced, fence } from './scope.ts';
import type { Runners, StepOutcome } from './steps.ts';

/** The smoke run's repository: the app's. */
export const SMOKE_REPOSITORY = APP_REPOSITORY;
export const SMOKE_BRANCH = 'factory/smoke';

/** A new module with an off-by-one in it, as a patch. */
export const SMOKE_SEED = `diff --git a/src/smoke.ts b/src/smoke.ts
new file mode 100644
--- /dev/null
+++ b/src/smoke.ts
@@ -0,0 +1,4 @@
+/** The index of a list's last item. */
+export function lastIndex(items: readonly unknown[]): number {
+  return items.length;
+}
`;

export const SMOKE_SCOPE = ['src/smoke.ts', 'test/smoke.test.ts'];

export const SMOKE_PROMPT = `\`lastIndex\` in src/smoke.ts should return the index of a list's last item, but it returns one past it.

Fix it, test first: add test/smoke.test.ts with a Vitest test that fails because of the bug, and run it to see it fail; then fix src/smoke.ts and run the test again to see it pass. Change no other file.`;

/**
 * A work item for one run of the smoke run or the bench: no ticket's, since a ticket's is a number, and new each
 * time, so the work-item cap is each run's own. It names the run's Jobs and volume, so it fits a Kubernetes name.
 */
export const oneRunWorkItem = (kind: 'smoke' | 'bench') =>
  `${kind}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

export interface SmokeResult {
  outcome: StepOutcome;
  fence: Fenced | null;
  /** The commit the dry-run worker recorded, when the patch was in scope. */
  commit: string | null;
}

export async function smoke({
  runners,
  github,
  commit,
  workItem = oneRunWorkItem('smoke'),
  round = 1,
  log,
}: {
  runners: Runners;
  github: GitHubWorker;
  commit: string;
  workItem?: string;
  round?: number;
  log: Logger;
}): Promise<SmokeResult> {
  const repo = SMOKE_REPOSITORY;
  // The scratch copy's base, as the dry-run worker remembers it: main with the seed on it.
  await github.act('setBranch', repo, { branch: SMOKE_BRANCH, sha: commit, force: true }, { workItem });
  const base = await github.act(
    'applyPatch',
    repo,
    {
      branch: SMOKE_BRANCH,
      expectedHead: commit,
      patch: SMOKE_SEED,
      message: 'chore: the smoke run’s seeded defect',
    },
    { workItem },
  );
  const outcome = await runners.run({
    workItem,
    round,
    agent: 'coder',
    repository: `https://github.com/${repo}.git`,
    commit,
    seed: SMOKE_SEED,
    prompt: SMOKE_PROMPT,
    maxTurns: 40,
    deadlineSeconds: 30 * 60,
  });
  // One step is the whole smoke run's work item.
  await runners.finish(workItem).catch((error: Error) => log.warn({ err: error }, 'could not delete the work volume'));
  if (outcome.kind !== 'handed-back' || !outcome.handback.patch) return { outcome, fence: null, commit: null };
  const fenced = fence(outcome.handback.patch, SMOKE_SCOPE);
  log.info({ ok: fenced.ok, paths: fenced.paths }, 'the smoke run’s patch, fenced');
  if (!fenced.ok) return { outcome, fence: fenced, commit: null };
  const made = await github.act(
    'applyPatch',
    repo,
    {
      branch: SMOKE_BRANCH,
      expectedHead: base,
      patch: outcome.handback.patch,
      message: cutTo(`fix(smoke): count the last index from zero\n\n${outcome.handback.note}`, 9_000),
    },
    { workItem, agent: 'coder' },
  );
  return { outcome, fence: fenced, commit: made };
}
