/**
 * The review gate's pin moves (ADR 0019), worked out where no secret is: review.yml's `pin move` job runs this, with
 * read-only permissions, from main's whole checkout, and hands the gate one answer for each pull request it would
 * judge. It judges the same pull requests the gate does, by the gate's own code (`review-gate.ts`), and works out a pin
 * move for each pull request of the factory's App's here (`pin-move.ts`), fetching its two commits as data; it posts
 * nothing.
 *
 *     node scripts/pin-moves.ts --pin-moves                                  # in review.yml: the answers, as output
 *     node scripts/pin-moves.ts --print [--as-app] <owner/name> <number>    # by hand, with Docker for Trivy
 *
 * `--as-app` replays a pull request as if the App had opened it, with no say of Martin's: what the rules would have
 * said of the same change. A reader that fails, or runs past its time, is a hold that says what it could not read.
 */

import { type Run as CheckRun, moveTitle, pinMove, realPinMoveIO, type WorkflowRun, workflowsOf } from './pin-move.ts';
import { type GitHub, main, type PinMoveAnswer, type PullRequest, type Run } from './review-gate.ts';

/**
 * When every pin move's reads have ended, from the job's start: one window for the run, inside the job's 20 minutes with
 * room for its setup and for the answers to be written, so a slow move, or several in a queued stack, never leaves the
 * gate with none. A move started late gets what is left.
 */
export const PIN_MOVES_MS = 15 * 60_000;
const STARTED = Date.now();

const cause = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 200) ?? '';

/**
 * The pin move a pull request of the App's here makes, proved (`pin-move.ts`), or the first condition it could not
 * prove. Into main alone, from the merge base to its head: the change it would merge. Anything not read holds it,
 * saying what: a pin move is never passed on a fact the gate did not read.
 */
export async function readPinMove(each: Run, pr: PullRequest, github: GitHub): Promise<PinMoveAnswer> {
  if (pr.base.ref !== 'main') return { reason: `it is into ${pr.base.ref}, and a pin move is judged into main alone` };
  const closing: { close(): void }[] = [];
  try {
    const left = STARTED + PIN_MOVES_MS - Date.now();
    if (left < 60_000) return { reason: 'the pin move job had no time left to work it out' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error('the pin move job ran out of time')), left);
      timer.unref?.();
    });
    try {
      // Never retargeted: a check that ran for another base, before the pull request moved to main, ran something else.
      const events = await github.paged<{ event: string }>(`/repos/${each.repo}/issues/${pr.number}/events`, each.read);
      if (events.some((e) => e.event === 'base_ref_changed'))
        return { reason: 'its base was changed: a pin move is proved only into main from the start' };
      // Nor ever the head of another pull request: a check run is the head's, whichever base it ran for.
      const sharing = await github.paged<PullRequest>(`/repos/${each.repo}/commits/${pr.head.sha}/pulls`, each.read);
      const other = sharing.find((one) => one.number !== pr.number && one.head.sha === pr.head.sha);
      if (other)
        return { reason: `#${other.number} has had the same head, so its checks may have run for another base` };
      const compare = await github.api<{ merge_base_commit?: { sha?: string }; base_commit?: { sha?: string } }>(
        'GET',
        // Open, against main as it is now; closed (a replay by hand), against the tip it was judged on then.
        `/repos/${each.repo}/compare/${pr.state === 'open' || !pr.base.sha ? pr.base.ref : pr.base.sha}...${pr.head.sha}`,
        each.read,
      );
      // The move is proved on what the merge makes against main's tip, never against a merge base main has left.
      const mergeBase = compare.merge_base_commit?.sha;
      const base = compare.base_commit?.sha;
      if (!mergeBase || !base || ![mergeBase, base].every((sha) => /^[0-9a-f]{40}$/.test(sha)))
        return { reason: 'GitHub named no tip and merge base to judge the move from' };
      const reader = await Promise.race([
        realPinMoveIO({
          repo: each.repo,
          base,
          mergeBase,
          head: pr.head.sha,
          // Each check run with the workflow file its suite's run is of, so a job of the same name in another
          // workflow, or a run for another head or event, proves nothing.
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
            return workflowsOf(checks, workflows, each.repo, { number: pr.number, open: pr.state === 'open' });
          },
        }),
        expired,
      ]);
      closing.push(reader);
      const result = await Promise.race([pinMove(reader, pr.head.sha), expired]);
      return 'move' in result ? { title: moveTitle(result) } : result;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    // One line, cut: a tool's error can carry a registry's or a chart index's text, never a workflow command.
    console.log(`::warning::${cause(error).replace(/::/g, ': :')}`);
    return { reason: `the gate could not read what it proves a pin move by (${cause(error)})` };
  } finally {
    // Tidying never replaces the answer: a reader's close does not throw (pin-move.ts's removeWork).
    for (const each of closing) each.close();
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2), readPinMove);
  // A reader ended at its deadline may leave Trivy or Helm running: the answers are written, so nothing is left.
  process.exit();
}
