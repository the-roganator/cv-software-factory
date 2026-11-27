/**
 * The branches the automation writes, in either repository, as ruleset patterns (`*` stops at a `/`, `**` does not):
 * the factory's App's, which it writes with its key (everything under `factory/`: a fix's branch, the pin watch's
 * `factory/pin/…` and `factory/pin-next/…`, the deploy watch's `factory/deploy/local`, the smoke run's and the red
 * team's; each repository's deploy branch; release-please's, which runs with the App's token), the merge queue's own,
 * which GitHub makes, and main, which the `main` ruleset holds. The `branches` ruleset leaves them alone
 * (`scripts/github-settings.ts`, where a test holds these to the names the code writes), so whoever holds the App's
 * key can still write them: what is on one is judged by the review gate as the App's change, never passed as Martin's
 * (`automationBranch`, `scripts/review-routing.ts`).
 *
 * It imports nothing: the review gate and the settings' drift check each read it in a sparse checkout.
 */
export const AUTOMATION_BRANCHES = [
  '~DEFAULT_BRANCH',
  'refs/heads/factory/**/*',
  'refs/heads/deploy/local',
  'refs/heads/release-please--*',
  'refs/heads/gh-readonly-queue/**/*',
];

const BRANCH_PATTERNS = AUTOMATION_BRANCHES.filter((p) => p.startsWith('refs/heads/')).map(
  (p) =>
    new RegExp(
      `^${p
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replaceAll('\u0000', '.+')}$`,
    ),
);

/** Whether a branch, by its name, is one the automation writes: any of AUTOMATION_BRANCHES but the default branch. */
export const automationBranch = (branch: string): boolean =>
  BRANCH_PATTERNS.some((pattern) => pattern.test(`refs/heads/${branch}`));
