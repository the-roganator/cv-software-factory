/**
 * The review gate's Critical fixes (ADR 0020), worked out where no secret is: review.yml's `critical fix` job runs this,
 * in the app's repository alone, with read-only permissions, from main's whole checkout, and hands the gate one answer
 * for each pull request it would judge. It judges the same pull requests the gate does, by the gate's own code
 * (`review-gate.ts`), and works out a fix for each pull request of the factory's App's there (`critical-fix.ts`),
 * fetching its two commits as data; it posts nothing.
 *
 *     node scripts/critical-fixes.ts --critical-fixes                            # in review.yml: the answers, as output
 *     node scripts/critical-fixes.ts --print [--as-app] <owner/name> <number>   # by hand, with Docker for Trivy
 *
 * `--as-app` replays a pull request as if the App had opened it, with no say of Martin's. A reader that fails, or runs
 * past its time, is a hold that says what it could not read.
 */

import { criticalFix } from './critical-fix.ts';
import { realCriticalFixIO } from './critical-fix-readers.ts';
import { type Run as CheckRun, type WorkflowRun, workflowsOf } from './pin-move-ran.ts';
import { type GitHub, main, type PinMoveAnswer, type PullRequest, type Run } from './review-gate.ts';
import { RETARGETED } from './review-routing.ts';

/** When every fix's reads have ended, from the job's start, inside the job's 20 minutes, as `PIN_MOVES_MS`. */
export const CRITICAL_FIXES_MS = 15 * 60_000;
const STARTED = Date.now();

const cause = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 200) ?? '';

/**
 * The fix a pull request of the App's in the app makes, proved (`critical-fix.ts`), or the first condition it could not
 * prove. Into main alone, from the start, from a branch no other pull request comes from, with a head no other has had:
 * as a pin move's, since its runs are read by the head and the branch.
 */
export async function readCriticalFix(each: Run, pr: PullRequest, github: GitHub): Promise<PinMoveAnswer> {
  if (pr.base.ref !== 'main')
    return { reason: `it is into ${pr.base.ref}, and a critical fix is judged into main alone` };
  const closing: { close(): void }[] = [];
  try {
    const left = STARTED + CRITICAL_FIXES_MS - Date.now();
    if (left < 60_000) return { reason: 'the critical fix job had no time left to work it out' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error('the critical fix job ran out of time')), left);
      timer.unref?.();
    });
    try {
      const events = await github.paged<{ event: string }>(`/repos/${each.repo}/issues/${pr.number}/events`, each.read);
      if (events.some((e) => RETARGETED.has(e.event)))
        return { reason: 'its base was changed: a critical fix is proved only into main from the start' };
      if (!pr.created_at || Number.isNaN(Date.parse(pr.created_at)))
        return { reason: 'GitHub named no time the pull request was opened, to read its runs from' };
      const owner = pr.head.repo?.full_name.split('/')[0];
      if (!owner) return { reason: 'its head names no repository' };
      const siblings = await github.paged<PullRequest & { closed_at?: string | null }>(
        `/repos/${each.repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${pr.head.ref}`)}`,
        each.read,
      );
      const sibling = siblings.find(
        (one) =>
          one.number !== pr.number &&
          (one.state === 'open' || !one.closed_at || Date.parse(one.closed_at) >= Date.parse(pr.created_at as string)),
      );
      if (sibling)
        return {
          reason: `#${sibling.number} comes from the same branch, so a run at its head may have been made for it`,
        };
      const sharing = await github.paged<PullRequest>(`/repos/${each.repo}/commits/${pr.head.sha}/pulls`, each.read);
      const other = sharing.find((one) => one.number !== pr.number && one.head.sha === pr.head.sha);
      if (other)
        return { reason: `#${other.number} has had the same head, so its checks may have run for another base` };
      const compare = await github.api<{ merge_base_commit?: { sha?: string }; base_commit?: { sha?: string } }>(
        'GET',
        `/repos/${each.repo}/compare/${pr.state === 'open' || !pr.base.sha ? pr.base.ref : pr.base.sha}...${pr.head.sha}`,
        each.read,
      );
      const mergeBase = compare.merge_base_commit?.sha;
      const base = compare.base_commit?.sha;
      if (!mergeBase || !base || ![mergeBase, base].every((sha) => /^[0-9a-f]{40}$/.test(sha)))
        return { reason: 'GitHub named no tip and merge base to judge the fix from' };
      const reader = await Promise.race([
        realCriticalFixIO({
          repo: each.repo,
          base,
          mergeBase,
          head: pr.head.sha,
          runs: async () => {
            const [checks, workflows] = await Promise.all([
              github.paged<CheckRun>(
                `/repos/${each.repo}/commits/${pr.head.sha}/check-runs?filter=all`,
                each.read,
                'check_runs',
              ),
              github.paged<WorkflowRun>(
                `/repos/${each.repo}/actions/runs?head_sha=${pr.head.sha}&event=pull_request`,
                each.read,
                'workflow_runs',
              ),
            ]);
            return workflowsOf(checks, workflows, each.repo, {
              number: pr.number,
              ref: pr.head.ref,
              created: pr.created_at as string,
              open: pr.state === 'open',
            });
          },
        }),
        expired,
      ]);
      closing.push(reader);
      const result = await Promise.race([criticalFix(reader, pr.head.sha), expired]);
      return 'title' in result ? { title: result.title } : result;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.log(`::warning::${cause(error).replace(/::/g, ': :')}`);
    return { reason: `the gate could not read what it proves a critical fix by (${cause(error)})` };
  } finally {
    for (const each of closing) each.close();
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2), undefined, readCriticalFix);
  // A reader ended at its deadline may leave Trivy running: the answers are written, so nothing is left.
  process.exit();
}
