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

import { type Run as CheckRun, moveTitle, pinMove, realPinMoveIO } from './pin-move.ts';
import { type GitHub, main, type PinMoveAnswer, type PullRequest, type Run } from './review-gate.ts';

/** The most one pin move's reads may take: two commits fetched, rendered and scanned, inside the job's limit. */
export const PIN_MOVE_MS = 12 * 60_000;

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
    const compare = await github.api<{ merge_base_commit?: { sha?: string } }>(
      'GET',
      `/repos/${each.repo}/compare/${pr.base.ref}...${pr.head.sha}`,
      each.read,
    );
    const base = compare.merge_base_commit?.sha;
    if (!base || !/^[0-9a-f]{40}$/.test(base)) return { reason: 'GitHub named no merge base to judge the move from' };
    const reader = await realPinMoveIO({
      repo: each.repo,
      base,
      head: pr.head.sha,
      runs: () =>
        github.paged<CheckRun>(
          `/repos/${each.repo}/commits/${pr.head.sha}/check-runs?filter=all`,
          each.read,
          'check_runs',
        ),
    });
    closing.push(reader);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error(`no answer in ${PIN_MOVE_MS / 60_000} minutes`)), PIN_MOVE_MS);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([pinMove(reader, pr.head.sha), expired]);
      return 'move' in result ? { title: moveTitle(result) } : result;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.log(`::warning::${error instanceof Error ? error.message : String(error)}`);
    return { reason: `the gate could not read what it proves a pin move by (${cause(error)})` };
  } finally {
    for (const each of closing) each.close();
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2), readPinMove);
  // A reader ended at its deadline may leave Trivy or Helm running: the answers are written, so nothing is left.
  process.exit();
}
