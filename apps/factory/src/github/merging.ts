/**
 * What the line needs from GitHub to merge through the queue (ADR 0014, approval routing): the review gate's verdict
 * on a pull request's head, the merge queue's state for it with the queue's own checks, whether it conflicts with its
 * base, and the one write, adding it to the queue.
 *
 * - **The verdict** is read only from the check run named `review` that the review App (`REVIEW_APP`) posted for the
 *   pull request's current head, the latest of them. Nothing else counts: the factory's App holds `checks: write` too,
 *   and its reviewer's check carries a model's words. Its summary's block is parsed by the gate's own module
 *   (`policy/review-verdict.ts`). When the gate held the pull request, the answer carries the refusal, kept and signed
 *   as `review-gate` (`refusals.ts`), once for each run of the check, for the line to record.
 * - **The queue** is read through GraphQL, which alone has it: the entry while the pull request is queued, with its
 *   position and the queue's commit, and the last time it left the queue, with GitHub's reason (`merged`,
 *   `failed_checks`, …) and the commit it was tested on. The checks on that commit come with it, each failed one with
 *   what it said, so a failure in the queue is something the line can say, not an unexplained wait.
 * - **A conflict** is GitHub's `mergeable_state` of `dirty`, read with the pull request's own conditional request.
 * - **Adding it to the queue** (`enqueuePullRequest`) names the head the line was told the gate judged, and GitHub
 *   takes it only at that head (`expectedHeadOid`), so a push after the verdict cannot ride it. It is guarded as every
 *   action on a pull request is: the App's own (`issues.ts`), from a branch of this repository the factory owns
 *   (`branches.ts`), and never a red-team attack's.
 *
 * The line asks again on each pass: the factory has no webhook, and a conditional request that finds nothing changed
 * costs nothing against the rate limit. The queue's GraphQL read is not conditional, so the line asks it only of a pull
 * request it has queued.
 */
import { z } from 'zod';
import { type Judged, readVerdict, type Verdict } from '../../../../policy/review-verdict.ts';
import type { SignedRefusal } from '../signed-refusals.ts';
import { BranchRefused, guardBranch, redTeamBranch } from './branches.ts';
import { GitHubError } from './client.ts';
import type { CheckRun } from './reads.ts';

/**
 * The review App (ADR 0014), the only one whose `review` check run counts: `REVIEW_APP` in
 * `scripts/github-settings.ts`, which the ruleset requires the check from.
 */
export const REVIEW_APP = 5470762;

/** The check the review App posts (`scripts/review-gate.ts`). */
export const REVIEW_CHECK = 'review';

/** The review App's `review` check run on a pull request's head, as the line reads it. */
export interface ReviewCheck {
  id: number;
  status: string;
  conclusion: string | null;
  title: string | null;
  /** Its summary as GitHub keeps it, the verdict's block among its words. */
  summary: string | null;
  completedAt: string | null;
  url: string | null;
}

/**
 * The gate's verdict on a pull request as it is now. `judged` is set only when the review App's latest `review` run on
 * the current head has concluded and its verdict judged this pull request at that head; otherwise `problem` says why
 * there is none yet, or none to trust.
 */
export interface ReviewVerdict {
  number: number;
  /** The pull request's head now. */
  head: string;
  /** The review App's latest `review` run on that head, or null while there is none. */
  check: ReviewCheck | null;
  /** The whole verdict the check's summary carries, when it carries one for this head. */
  verdict: Verdict | null;
  /** The verdict's entry for this pull request at this head. */
  judged: Judged | null;
  /** Why there is no `judged`, in a few words; null when there is. */
  problem: string | null;
  /** The gate's refusal, kept and signed, when it held the pull request (`judged.rule` is `held`). */
  refusal?: SignedRefusal;
}

/** One of the times a pull request went into the queue, or left it. */
export interface QueueEvent {
  at: string;
  /** Who added it, or who took it out: `github-merge-queue` when the queue did. */
  by: string | null;
}

/** A pull request's place in the merge queue. */
export interface MergeQueue {
  number: number;
  head: string;
  state: 'open' | 'closed' | 'merged';
  /** Its entry while it is queued. */
  queued: {
    position: number;
    /** GitHub's: `QUEUED`, `AWAITING_CHECKS`, `MERGEABLE`, `UNMERGEABLE` or `LOCKED`. */
    state: string;
    enqueuedAt: string;
    /** The queue's commit for it, once the queue has made one. */
    commit: string | null;
  } | null;
  /** The last time it went into the queue. */
  added: QueueEvent | null;
  /**
   * The last time it left the queue, when it has not gone back in since: GitHub's reason (`merged`, `failed_checks`,
   * `dequeued`, …), and the queue's commit it was tested on.
   */
  removed: (QueueEvent & { reason: string | null; commit: string | null }) | null;
  /**
   * The checks on the queue's commit: the one it is queued on, or the one it left the queue from. Empty with neither.
   */
  checks: CheckRun[];
}

/** Whether a pull request can merge into its base as it stands. */
export interface Mergeability {
  number: number;
  head: string;
  /** True when it conflicts with its base; null while GitHub has not worked it out yet, so the line asks again. */
  conflicts: boolean | null;
  /** GitHub's `mergeable_state`: `dirty` (conflicts), `clean`, `blocked`, `behind`, `unstable`, `draft`, `unknown`. */
  state: string;
}

/** What adding a pull request to the queue gives back: its place there. */
export interface Enqueued {
  position: number | null;
  state: string | null;
}

/** What the guard reads of a pull request before it is added to the queue. */
export interface QueueCandidate {
  state: string;
  draft: boolean;
  head: { ref: string; sha: string; repo: string | null };
}

/**
 * Refuses to add a pull request to the queue unless it is from a branch of this repository the factory owns and is not
 * a red-team attack's (a `BranchRefused`, so the worker signs it as `github-guard`), and unless it is open, ready, and
 * at the head the line names (a conflict: the line looks again). Whose it is, the issue guard asks first.
 */
export function guardQueue(repo: string, number: number, pull: QueueCandidate, expectedHead: string): void {
  // A fork's branch of the same name is not the factory's.
  if (pull.head.repo !== repo) throw new BranchRefused(`Pull request #${number} is not from a branch of ${repo}.`);
  guardBranch(pull.head.ref);
  if (redTeamBranch(pull.head.ref)) {
    throw new BranchRefused(
      `${pull.head.ref} is a red-team attack's branch: the factory never adds one to the merge queue.`,
    );
  }
  if (pull.state !== 'open') throw new GitHubError('conflict', `Pull request #${number} is not open.`, 409);
  if (pull.draft) throw new GitHubError('conflict', `Pull request #${number} is a draft.`, 409);
  if (pull.head.sha !== expectedHead) {
    throw new GitHubError(
      'conflict',
      `Pull request #${number} is at ${pull.head.sha.slice(0, 7)}, not ${expectedHead.slice(0, 7)}.`,
      409,
    );
  }
}

/** A run of the `review` check as GitHub lists it. */
export interface ListedReview {
  id: number;
  name: string;
  headSha: string;
  appId: number | null;
  status: string;
  conclusion: string | null;
  title: string | null;
  summary: string | null;
  completedAt: string | null;
  url: string | null;
}

/** Where GitHub lists every `review` check run on a commit, re-runs too, whichever app posted each. */
export const reviewRunsPath = (repo: string, sha: string): string =>
  `/repos/${repo}/commits/${sha}/check-runs?check_name=${REVIEW_CHECK}&filter=all&per_page=100`;

/** The `review` check runs on a commit, with their summaries, which carry the gate's verdict. */
export const REVIEW_RUNS = z.object({
  check_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      head_sha: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      app: z.object({ id: z.number().int() }).nullable().optional(),
      completed_at: z.string().nullable().optional(),
      html_url: z.string().nullable().optional(),
      output: z
        .object({ title: z.string().nullable().optional(), summary: z.string().nullable().optional() })
        .nullable()
        .optional(),
    }),
  ),
});

/** The runs GitHub listed, each with the app that posted it. */
export const listedReviews = (body: z.infer<typeof REVIEW_RUNS>): ListedReview[] =>
  body.check_runs.map((run) => ({
    id: run.id,
    name: run.name,
    headSha: run.head_sha,
    appId: run.app?.id ?? null,
    status: run.status,
    conclusion: run.conclusion,
    title: run.output?.title ?? null,
    summary: run.output?.summary ?? null,
    completedAt: run.completed_at ?? null,
    url: run.html_url ?? null,
  }));

/**
 * The review App's latest `review` run on a head, from every check run GitHub lists there: any other app's, another
 * name's, or another commit's is never it.
 */
export function reviewCheckOf(runs: readonly ListedReview[], head: string): ReviewCheck | null {
  const theirs = runs.filter((run) => run.name === REVIEW_CHECK && run.appId === REVIEW_APP && run.headSha === head);
  const latest = theirs.reduce<ListedReview | undefined>((a, b) => (a && a.id > b.id ? a : b), undefined);
  if (!latest) return null;
  const { name: _, headSha: __, appId: ___, ...check } = latest;
  return check;
}

/** The verdict a check gives a pull request at its head, or why it gives none. */
export function verdictOf(
  number: number,
  head: string,
  check: ReviewCheck | null,
): Omit<ReviewVerdict, 'number' | 'head' | 'check' | 'refusal'> {
  const none = (problem: string) => ({ verdict: null, judged: null, problem });
  if (!check) return none(`the review App has posted no review check on ${head.slice(0, 7)}`);
  if (check.status !== 'completed') return none('the review check has not concluded');
  const read = readVerdict(check.summary);
  if ('error' in read) return none(read.error);
  if (read.commit !== head) return none(`the verdict is for ${read.commit.slice(0, 7)}, not the head`);
  const judged = read.judged.find((each) => each.number === number && each.head === head);
  if (!judged) return { verdict: read, judged: null, problem: `the verdict does not judge #${number} at its head` };
  // Only a success passes and only a failure holds: a run cancelled, timed out or gone stale is no verdict.
  if (check.conclusion !== 'success' && check.conclusion !== 'failure') {
    return { verdict: read, judged: null, problem: `the review check concluded ${check.conclusion}` };
  }
  // A check that failed with a rule that passes, or passed with one that holds, says two things: neither is trusted.
  const failed = check.conclusion === 'failure';
  if (failed !== (judged.rule === 'held')) {
    return { verdict: read, judged: null, problem: `the check's conclusion, ${check.conclusion}, is not its rule's` };
  }
  return { verdict: read, judged, problem: null };
}

/** The review check's own words, as a refusal of the gate's carries them: its title, then its summary. */
export function reviewOutput(check: Pick<ReviewCheck, 'title' | 'summary'>): string {
  const output = [check.title ?? '', check.summary ?? '']
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
  return output || 'The review check held the pull request.';
}

/** Why the gate held a pull request, as its refusal shows a guardrail: Martin's code alone, or a risk. */
export const heldFor = (judged: Judged): 'code-owned' | 'risk' =>
  judged.tags.length > 0 && judged.tags.every((t) => t.tag === 'code-owned') ? 'code-owned' : 'risk';

/** A pull request's conflict with its base, from what GitHub says of it. */
export function conflictsOf(mergeable: boolean | null, state: string): boolean | null {
  if (state === 'dirty') return true;
  if (mergeable === null) return null;
  return !mergeable;
}
