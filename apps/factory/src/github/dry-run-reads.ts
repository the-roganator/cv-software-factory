/**
 * What a dry run reads back: the branches, commits and pull requests it would have made, answered as GitHub would
 * have answered for them, and everything else read from GitHub as it is. Without this, a line in `dry-run` reads a
 * pull request numbered past a billion, which GitHub has never heard of, and waits at Gates for ever.
 *
 * A pull request the dry run opened reads as open, its head the last commit it would have pushed. Each commit it
 * would have made has every check main's ruleset requires, each passing once `checksAfterMs` has passed since the
 * commit; and the pull request reads as merged, by the App, `mergeAfterMs` after the line added it to the merge queue,
 * or, one it never added, `mergeAfterMs` after it was ready for review, standing in for Martin's merge, so the work item
 * ends and a soak goes round at every autonomy level. A soak tells the two apart by the line's `pull-request.enqueued`
 * before the merge. A draft the line never added is never merged: GitHub cannot merge one, and Martin merges only what
 * the describer has readied. A merged one cannot be added to the queue (`DryRunActions`). Nothing ran: each check's title says so, and the gate's summary carries
 * it. A comparison of a commit the dry run made is taken against the real commit its first one went on, from the
 * files as they really are there and as the dry run left them. A step that starts from such a commit checks out that
 * real commit and makes the dry run's commits on it (`checkout`), so the reviewer, the describer and a later round of
 * the coder see the change as GitHub would have held it.
 *
 * To merge, the gate's verdict on one of its pull requests is the review App's `review` check, passing once its checks
 * do, with a verdict of `exact-pin` for a deploy pull request and `low-risk` for any other, and the summary saying
 * nothing ran. One the dry run added to the merge queue reads as queued there, on a commit of the queue's own with
 * every required check, until it merges as above, then as having left the queue merged. None conflicts with its base.
 *
 * Its memory is the dry run's (`DryRunActions`), and lasts as long as the worker: a worker started again has
 * forgotten the pull requests it opened, and GitHub answers that it has none at those numbers.
 */
import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';
import { verdictBlock } from '../../../../policy/review-verdict.ts';
import { APP_LOGIN, type DryRunActions, type DryRunPull } from './actions.ts';
import { DEPLOYS, type DeployProposal } from './deploys.ts';
import { type Mergeability, type MergeQueue, type ReviewCheck, type ReviewVerdict, verdictOf } from './merging.ts';
import type { Checkout, CheckRun, Commits, Comparison, FileAt, PullRequestState, Reads, Signed } from './reads.ts';

export interface DryRunTimes {
  /** How long after a commit the dry run's checks on it pass. */
  checksAfterMs: number;
  /** How long after a pull request is readied (or opens ready) the dry run merges it. */
  mergeAfterMs: number;
}

/** The title on each of the dry run's checks, which the gate's summary carries. */
export const DRY_RUN_CHECK_TITLE = 'Passed in a dry run: nothing ran';

/** The check a dry run reports when the base branch requires none, so the gates still finish. */
const NO_REQUIRED = ['Dry run'];

/** The summary of the dry run's `review` check, before its verdict's block. */
export const DRY_RUN_REVIEW = 'A dry run: the review gate did not run, and judged nothing.';

/** A sha for what never existed, from what it stands for: the same every time it is asked for. */
const shaFor = (what: string) => createHash('sha1').update(`dry run: ${what}`).digest('hex');

export class DryRunReads implements Reads {
  readonly #made: DryRunActions;
  readonly #live: Reads;
  readonly #times: DryRunTimes;
  readonly #now: () => Date;

  constructor(made: DryRunActions, live: Reads, times: DryRunTimes, now: () => Date = () => new Date()) {
    this.#made = made;
    this.#live = live;
    this.#times = times;
    this.#now = now;
    made.judgeMerges((pull) => this.#merged(pull));
  }

  /** When a pull request the dry run opened merges: after it was queued, or else after it was readied; never, closed. */
  #mergesAt(pull: DryRunPull): number | null {
    if (pull.closedAt !== null) return null;
    const from = pull.enqueuedAt ?? pull.readiedAt;
    return from === null ? null : from.getTime() + this.#times.mergeAfterMs;
  }

  #merged(pull: DryRunPull): boolean {
    const at = this.#mergesAt(pull);
    return at !== null && this.#now().getTime() >= at;
  }

  async pullRequest(repo: string, number: number): Promise<PullRequestState> {
    const pull = this.#made.pullRequestMade(number);
    return pull?.repo === repo ? this.#state(pull) : this.#live.pullRequest(repo, number);
  }

  async pullRequestFrom(repo: string, branch: string): Promise<PullRequestState | null> {
    const pull = this.#made.pullRequestsMade().find((p) => p.repo === repo && p.head === branch);
    if (!pull) return this.#live.pullRequestFrom(repo, branch);
    const state = this.#state(pull);
    return state.state === 'open' ? state : null;
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    const commit = this.#made.commitMade(sha);
    if (!commit) return this.#live.checkRuns(repo, sha);
    return this.#passing(repo, sha, commit.at, new Date(commit.at.getTime() + this.#times.checksAfterMs));
  }

  /** Every check main's ruleset requires on a commit, from `startedAt`, each passing at `passesAt`. */
  async #passing(repo: string, sha: string, from: Date, passesAt: Date): Promise<CheckRun[]> {
    const required = await this.#live.requiredChecks(repo, 'main');
    const done = this.#now().getTime() >= passesAt.getTime();
    const startedAt = from.toISOString();
    const completedAt = passesAt.toISOString();
    return (required.length ? required : NO_REQUIRED).map((name, index) => ({
      id: Number.parseInt(sha.slice(0, 8), 16) * 100 + index + 1,
      name,
      status: done ? 'completed' : 'in_progress',
      conclusion: done ? 'success' : null,
      app: 'dry-run',
      startedAt,
      completedAt: done ? completedAt : null,
      title: DRY_RUN_CHECK_TITLE,
    }));
  }

  requiredChecks(repo: string, branch: string): Promise<string[]> {
    return this.#live.requiredChecks(repo, branch);
  }

  async head(repo: string, branch: string): Promise<string> {
    return this.#made.branchMade(repo, branch) ?? this.#live.head(repo, branch);
  }

  /** At a commit the dry run made, the paths protected where its first commit went: it never changes CODEOWNERS. */
  protectedPaths(repo: string, ref: string): Promise<string[]> {
    return this.#live.protectedPaths(repo, this.#made.rootOf(ref));
  }

  /** A file at a commit the dry run made, as its commits left it, and otherwise as GitHub has it. */
  async file(repo: string, ref: string, path: string): Promise<FileAt> {
    for (let made = this.#made.commitMade(ref); made; made = this.#made.commitMade(made.parent)) {
      if (!made.files.has(path)) continue;
      const text = made.files.get(path) ?? null;
      return text === null ? { found: false } : { found: true, text };
    }
    return this.#live.file(repo, this.#made.rootOf(ref), path);
  }

  async comparison(repo: string, base: string, head: string): Promise<Comparison> {
    if (!this.#made.commitMade(head)) return this.#live.comparison(repo, base, head);
    const root = this.#made.rootOf(head);
    // Every path a commit of the chain changed, as the latest of them left it.
    const changed = new Set<string>();
    for (let made = this.#made.commitMade(head); made; made = this.#made.commitMade(made.parent)) {
      for (const path of made.files.keys()) changed.add(path);
    }
    const files: Comparison['files'] = [];
    for (const path of [...changed].sort()) {
      const [before, after] = await Promise.all([this.#made.file(repo, path, root), this.#made.file(repo, path, head)]);
      if (before === after) continue;
      files.push({ path, ...hunks(path, before ?? '', after ?? '') });
    }
    return { mergeBase: root, files };
  }

  /** As GitHub has them: a commit the dry run made is on no branch, and no image was built from one. */
  commits(repo: string, base: string, head: string): Promise<Commits> {
    return this.#live.commits(repo, base, head);
  }

  imageRevision(repo: string, image: string, digest: string): Promise<string | null> {
    return this.#live.imageRevision(repo, image, digest);
  }

  imageSigned(repo: string, image: string, digest: string): Promise<Signed> {
    return this.#live.imageSigned(repo, image, digest);
  }

  /** As the deploy watch has it, whether its proposals are real or the dry run's own. */
  deployProposal(repo: string, branch: string): Promise<DeployProposal | null> {
    return this.#live.deployProposal(repo, branch);
  }

  /** The real commit under one the dry run made, and its commits on it, each as a patch, oldest first. */
  async checkout(repo: string, sha: string): Promise<Checkout> {
    const chain: { sha: string; parent: string; message: string; patch: string | undefined; paths: string[] }[] = [];
    for (let at = sha, made = this.#made.commitMade(at); made; at = made.parent, made = this.#made.commitMade(at)) {
      chain.unshift({
        sha: at,
        parent: made.parent,
        message: made.message,
        patch: made.patch,
        paths: [...made.files.keys()],
      });
    }
    if (!chain.length) return this.#live.checkout(repo, sha);
    const commits: Checkout['commits'] = [];
    for (const commit of chain) {
      commits.push({ message: commit.message, patch: commit.patch ?? (await this.#patch(repo, commit)) });
    }
    return { commit: this.#made.rootOf(sha), commits };
  }

  /** A commit made from whole files, as `git diff` would show it against its parent. */
  async #patch(repo: string, commit: { sha: string; parent: string; paths: string[] }): Promise<string> {
    const parts: string[] = [];
    for (const path of [...commit.paths].sort()) {
      const [before, after] = await Promise.all([
        this.#made.file(repo, path, commit.parent),
        this.#made.file(repo, path, commit.sha),
      ]);
      if (before === after) continue;
      const header = [
        `diff --git a/${path} b/${path}`,
        ...(before === null ? ['new file mode 100644'] : after === null ? ['deleted file mode 100644'] : []),
        `--- ${before === null ? '/dev/null' : `a/${path}`}`,
        `+++ ${after === null ? '/dev/null' : `b/${path}`}`,
      ];
      parts.push([...header, hunks(path, before ?? '', after ?? '').patch].join('\n'));
    }
    return `${parts.join('\n')}\n`;
  }

  /** A pull request the dry run opened in `repo`, or undefined for one GitHub has. */
  #own(repo: string, number: number): DryRunPull | undefined {
    const pull = this.#made.pullRequestMade(number);
    return pull?.repo === repo ? pull : undefined;
  }

  async reviewVerdict(repo: string, number: number): Promise<ReviewVerdict> {
    const pull = this.#own(repo, number);
    if (!pull) return this.#live.reviewVerdict(repo, number);
    const head = this.#state(pull).head.sha;
    const commit = this.#made.commitMade(head);
    let check: ReviewCheck | null = null;
    if (commit) {
      const passesAt = new Date(commit.at.getTime() + this.#times.checksAfterMs);
      const done = this.#now().getTime() >= passesAt.getTime();
      const rule = DEPLOYS.some((t) => t.repo === repo && t.branch === pull.head) ? 'exact-pin' : 'low-risk';
      check = {
        id: Number.parseInt(head.slice(0, 8), 16) * 100,
        status: done ? 'completed' : 'in_progress',
        conclusion: done ? 'success' : null,
        title: DRY_RUN_CHECK_TITLE,
        summary: done
          ? `${DRY_RUN_REVIEW}\n\n${verdictBlock({ version: 1, commit: head, judged: [{ number, head, rule, tags: [] }] })}`
          : null,
        completedAt: done ? passesAt.toISOString() : null,
        url: null,
      };
    }
    return { number, head, check, ...verdictOf(number, head, check) };
  }

  async mergeQueue(repo: string, number: number): Promise<MergeQueue> {
    const pull = this.#own(repo, number);
    if (!pull) return this.#live.mergeQueue(repo, number);
    const state = this.#state(pull);
    const at = pull.enqueuedAt;
    const base = {
      number,
      head: state.head.sha,
      state: state.merged ? ('merged' as const) : state.state,
      added: at ? { at: at.toISOString(), by: APP_LOGIN } : null,
    };
    if (!at) return { ...base, queued: null, removed: null, checks: [] };
    const commit = shaFor(`${repo}#${number} queue`);
    // The queue's checks pass as it merges, and it leaves the queue merged.
    const mergesAt = new Date(at.getTime() + this.#times.mergeAfterMs);
    const checks = await this.#passing(repo, commit, at, mergesAt);
    if (state.merged) {
      const removed = { at: mergesAt.toISOString(), by: 'github-merge-queue', reason: 'merged', commit };
      return { ...base, queued: null, removed, checks };
    }
    if (state.state === 'closed') {
      const closed = (pull.closedAt ?? at).toISOString();
      return { ...base, queued: null, removed: { at: closed, by: APP_LOGIN, reason: 'dequeued', commit }, checks };
    }
    const queued = { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: at.toISOString(), commit };
    return { ...base, queued, removed: null, checks };
  }

  async mergeability(repo: string, number: number): Promise<Mergeability> {
    const pull = this.#own(repo, number);
    if (!pull) return this.#live.mergeability(repo, number);
    // The dry run's commits go on main as it was, and nothing else moves its branches: none conflicts.
    return { number, head: this.#state(pull).head.sha, conflicts: false, state: pull.draft ? 'draft' : 'clean' };
  }

  #state(pull: DryRunPull): PullRequestState {
    const sha = this.#made.headOf(pull);
    // A pull request the dry run closed unmerged never merges.
    const merged = this.#merged(pull);
    return {
      number: pull.number,
      state: merged || pull.closedAt !== null ? 'closed' : 'open',
      merged,
      mergeCommit: merged ? shaFor(`${pull.repo}#${pull.number} merged`) : null,
      // The dry run stands in for the merge, so it is the App's, never Martin's.
      mergedBy: merged ? APP_LOGIN : null,
      head: { ref: pull.head, sha },
      base: { ref: pull.base, sha: this.#made.rootOf(sha) },
      draft: pull.draft,
      nodeId: pull.nodeId,
    };
  }
}

/** A hunk's side as git writes it: a side with no lines names the line before it. */
const at = (start: number, lines: number) => `${lines === 0 ? start - 1 : start},${lines}`;

/** A file's change as GitHub's comparison shows it: its hunks, and the lines added and removed. */
function hunks(path: string, before: string, after: string): { patch: string; added: number; removed: number } {
  const { hunks: parts } = structuredPatch(path, path, before, after, '', '', { context: 3 });
  const lines = parts.flatMap((h) => h.lines);
  return {
    patch: parts
      .map((h) => [`@@ -${at(h.oldStart, h.oldLines)} +${at(h.newStart, h.newLines)} @@`, ...h.lines].join('\n'))
      .join('\n'),
    added: lines.filter((line) => line.startsWith('+')).length,
    removed: lines.filter((line) => line.startsWith('-')).length,
  };
}
