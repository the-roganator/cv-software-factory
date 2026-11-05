/**
 * Everything the factory does in GitHub, as the App: branches, signed commits, pull requests, comment reviews and
 * their threads, check runs, issues, and adding its pull requests to the merge queue (`merging.ts`). Two implementations share the interface:
 *
 * - `LiveActions` does it, through the client.
 * - `DryRunActions` does nothing in GitHub. It writes each action it would have taken to the artifact store, as
 *   JSON with the files a commit would have held, and logs the artifact's hash. The unattended passes run with it,
 *   so a night on the local model leaves a record and no trace in either repository. It remembers the branches,
 *   commits and pull requests it would have made, for as long as the worker runs, so the dry run's reads
 *   (`dry-run-reads.ts`) can answer for them.
 *
 * Commits go through GraphQL's `createCommitOnBranch`, never `git push`: GitHub makes the commit and signs it as the
 * App, which `main`'s ruleset requires, and the factory never runs git in a working tree it does not control.
 *
 * Both refuse to move, delete or commit to a branch the factory does not own (`branches.ts`), and to act on an issue
 * or pull request the App did not open (`issues.ts`), whatever they are asked: only opening one takes none.
 *
 * A pull request's description is where test integrity reads the tests its spec contradicts (`gates/contradicts.ts`).
 * Only the worker writes that section, rendered from the list the line gives it (`contradicts`), replacing any the
 * body it was given holds; a body it is given with no list keeps no section at all, so no agent's words can name a
 * test. Given a list and no body, it rewrites the section in the body the pull request has.
 */
import { createHash } from 'node:crypto';
import type { ArtifactStore } from '@software-factory/store';
import type { Logger } from 'pino';
import { z } from 'zod';
import { type Contradicted, render, strip } from '../gates/contradicts.ts';
import { guardBranch } from './branches.ts';
import { type GitHub, GitHubError } from './client.ts';
import {
  carriesIn,
  carriesSection,
  type Deploy,
  DeployRefused,
  deployTarget,
  deployTitle,
  withCarries,
} from './deploys.ts';
import { type IssueAction, IssueGuard, openedBy } from './issues.ts';
import { type Enqueued, guardQueue, type QueueCandidate } from './merging.ts';
import { applyTo, filesIn, PatchRefused } from './patches.ts';
import { CODEOWNERS_PATHS, inScope, protectedFrom } from './paths.ts';
import { RefusalRecorder } from './refusals.ts';

/** How the App appears as a pull request's author, and as whoever merged one or added it to the merge queue. */
export const APP_LOGIN = 'mrogan-software-factory[bot]';

export interface FileChanges {
  /** Files to add or replace, with their whole new contents. */
  additions: { path: string; contents: Uint8Array }[];
  deletions: string[];
}

export interface Commit {
  branch: string;
  /** The branch's head the commit is made on. GitHub refuses the commit if the branch has moved since. */
  expectedHead: string;
  /** The first line is the headline; the rest, after a blank line, is the body. */
  message: string;
  changes: FileChanges;
}

/** A runner's patch, to go on a branch as one signed commit (ADR 0008). */
export interface PatchCommit {
  branch: string;
  /** The branch's head, which the patch was made against and goes on. */
  expectedHead: string;
  /** A unified diff, as `git diff` writes one. */
  patch: string;
  message: string;
}

/** Reads a file at a commit: its text, or null if it is not there. */
export type ReadFile = (repo: string, path: string, ref: string) => Promise<string | null>;

const CONTENTS = z.object({
  type: z.string(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A file at a commit, through the contents API. Only an ordinary text file can be patched: a folder, a symlink, a
 * submodule, a file too large for the API to send whole (over a megabyte) or one that is not UTF-8 is refused rather
 * than read as something it is not.
 */
export function contentsReader(github: GitHub): ReadFile {
  return async (repo, path, ref) => {
    let file: z.infer<typeof CONTENTS>;
    try {
      file = await github.read(
        repo,
        `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`,
        CONTENTS,
      );
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not-found') return null;
      // An array answer is a folder.
      if (error instanceof GitHubError && error.kind === 'malformed') {
        throw new PatchRefused('unsupported', `${path} is not a file the patch can change.`);
      }
      throw error;
    }
    if (file.type !== 'file' || file.encoding !== 'base64' || file.content === undefined) {
      throw new PatchRefused('unsupported', `${path} is not a text file the API sends whole.`);
    }
    try {
      return UTF8.decode(Buffer.from(file.content, 'base64'));
    } catch {
      throw new PatchRefused('unsupported', `${path} is not UTF-8 text.`);
    }
  };
}

/**
 * Refuses a patch that changes a path no patch may: the workflows, the deployment, or one the repository's
 * CODEOWNERS (at the commit the patch goes on) gives a person. The line's fence asks the same; this is the last word.
 */
export async function guard(patch: string, read: (path: string) => Promise<string | null>): Promise<void> {
  const owners = (await Promise.all(CODEOWNERS_PATHS.map(read))).find((text) => text !== null) ?? null;
  const forbidden = protectedFrom(owners);
  const blocked = filesIn(patch)
    .map((f) => f.path)
    .filter((path) => inScope(path, forbidden));
  if (blocked.length)
    throw new PatchRefused('protected', `The patch changes ${blocked.join(', ')}, which no patch may.`);
}

export interface PullRequestDraft {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  labels?: string[];
  /** The tests the work's spec contradicts, which the body's section names: none, with an empty list. */
  contradicts?: Contradicted[];
}

export interface PullRequestChange {
  title?: string;
  body?: string;
  keepCarries?: boolean;
  /**
   * The tests the work's spec contradicts, which the body's section names: the new body's, or, with no new body, the
   * one the pull request has. An empty list takes the section out.
   */
  contradicts?: Contradicted[];
}

/** The words every marker of the section has, which a body the worker is given may not carry in any form. */
const MARKER_WORDS = /factory:contradicts/gi;
const HAS_MARKER_WORDS = /factory:contradicts/i;

/**
 * A body as the worker publishes it: with the section for the tests given, and only that section, after the rest. A
 * section the body has is taken out, and then whatever is left of a marker's words is broken, again until none is
 * left, so no text, an agent's or anyone's, can splice a marker the gate reads out of pieces the taking-out joins. A
 * body with no marker's words is kept as it was, but for the end it meets the section at.
 */
export function described(body: string, contradicts: readonly Contradicted[] | undefined): string {
  let rest = body;
  if (HAS_MARKER_WORDS.test(rest)) {
    rest = strip(rest);
    while (HAS_MARKER_WORDS.test(rest)) rest = rest.replace(MARKER_WORDS, 'factory: contradicts');
  }
  const section = render(contradicts ?? []);
  if (!section) return rest;
  return rest.trim() ? `${rest.replace(/\s+$/, '')}\n\n${section}` : section;
}

export interface PullRequestRef {
  number: number;
  url: string;
  /** GraphQL's id, which readying a draft needs. */
  nodeId: string;
}

export interface ReviewComment {
  path: string;
  /** The line in the change's version of the file (the right-hand side of the diff). */
  line: number;
  body: string;
}

/** A review thread the App began, found by its first comment, and what to reply on it before it is resolved. */
export interface ThreadAnswer extends ReviewComment {
  reply: string;
}

export interface CheckRunReport {
  name: string;
  headSha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
  title: string;
  summary: string;
  text?: string;
  detailsUrl?: string;
  /** The factory's own id for what the check is about, such as a work item, so a later poll can match it. */
  externalId?: string;
}

export interface Actions {
  readonly dryRun: boolean;
  /** Points a branch at a commit, making it if it does not exist. `force` lets it move to a commit that is not a descendant. */
  setBranch(repo: string, branch: string, sha: string, options?: { force?: boolean }): Promise<void>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  /** Makes one signed commit on a branch, and returns its sha. */
  commit(repo: string, commit: Commit): Promise<string>;
  /** Applies a runner's patch to the files at the branch's head, outside the sandbox, and commits it. */
  applyPatch(repo: string, patch: PatchCommit): Promise<string>;
  openPullRequest(repo: string, draft: PullRequestDraft): Promise<PullRequestRef>;
  /**
   * Retitles or rewrites a pull request the App opened. With `keepCarries`, a deploy pull request's new body keeps the
   * Carries section its body has as it is written, which the line may have written since the new body was made.
   */
  updatePullRequest(repo: string, number: number, change: PullRequestChange): Promise<void>;
  /**
   * Says what a deploy pull request carries, in its body's Carries section (`deploys.ts`), when the pull request is
   * open and still for `commit`; any other pull request is refused. Gives back whether the body changed: saying the
   * same again changes nothing.
   */
  describeDeploy(repo: string, number: number, deploy: Deploy): Promise<boolean>;
  /** Labels an issue or pull request the App opened. */
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  /** Marks a draft pull request ready for review. */
  readyForReview(repo: string, pullRequest: PullRequestRef): Promise<void>;
  /** Puts a pull request ready for review back to draft, so that GitHub will not merge it. */
  convertToDraft(repo: string, pullRequest: PullRequestRef): Promise<void>;
  /** A comment review: it neither approves nor requests changes, so it never counts toward a merge. */
  review(
    repo: string,
    number: number,
    review: { commit: string; body: string; comments: ReviewComment[] },
  ): Promise<number>;
  /**
   * Replies on each open review thread the App began with one of `threads`, found by its path, the line it was made
   * on and its first comment's body, with that one's reply, and resolves it. A thread resolved already, or begun by
   * anyone else, is left as it is, and a reply the App made already is not made again, so trying again after a
   * failure says nothing twice.
   */
  resolveThreads(repo: string, number: number, threads: ThreadAnswer[]): Promise<void>;
  createCheckRun(repo: string, report: CheckRunReport): Promise<number>;
  updateCheckRun(repo: string, id: number, report: Partial<CheckRunReport>): Promise<void>;
  openIssue(repo: string, issue: { title: string; body: string; labels?: string[] }): Promise<number>;
  /**
   * Closes an issue the App opened. With a comment, it first says why on the issue, and only while the issue is open and does not say
   * it already: closing one already closed, or trying again after a close that failed, says nothing again.
   */
  closeIssue(repo: string, number: number, reason: 'completed' | 'not_planned', comment?: string): Promise<void>;
  /**
   * Opens a closed issue the App opened again, first saying why on it. Only while the issue is closed, and without saying it twice:
   * reopening one already open, or trying again after a reopening that failed, says nothing again.
   */
  reopenIssue(repo: string, number: number, comment: string): Promise<void>;
  /**
   * Closes a pull request unmerged, first saying why on it, without saying it twice: one already closed, merged or
   * not, is left as it is. Only one from a branch the factory owns.
   */
  closePullRequest(repo: string, number: number, comment: string): Promise<void>;
  /**
   * Says something on an issue or pull request the App opened, unless it says it already, word for word: trying again
   * after a failure, or after a crash before the caller recorded it, says nothing twice. The one exception is the
   * outside reply (`issues.ts`), on an issue opened by anyone but Martin or the App.
   */
  comment(repo: string, number: number, body: string): Promise<void>;
  /**
   * Adds a pull request the App opened to the merge queue, at `expectedHead` alone: the head the gate judged, so a
   * push since cannot ride its verdict (`merging.ts`). Refused, before GitHub is asked, for a pull request from a
   * fork, from a branch the factory does not own, or from a red-team attack's.
   */
  enqueuePullRequest(repo: string, number: number, expectedHead: string): Promise<Enqueued>;
}

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
/** An issue, as closing and reopening one read it. */
const ISSUE = z.object({ state: z.string(), closed_at: z.string().nullable().default(null) });
const NUMBER = z.number().int().positive();
const ID = z.object({ id: NUMBER });

const CREATE_COMMIT = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

/** What describing a deploy needs to know of its pull request. */
const DEPLOY_PULL = z.object({
  state: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string() }),
});

const READY = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } }
}`;

const TO_DRAFT = `mutation($id: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } }
}`;

/**
 * A pull request's review threads, each with its comments. One page of each: the line posts at most three reviews of
 * twenty findings before Martin decides (two, and one after an approval's suggestions), and a thread here holds a
 * finding and a reply or two.
 */
const THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { id isResolved path originalLine comments(first: 50) { nodes { body author { login } } } }
      }
    }
  }
}`;

const THREADS_ANSWER = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviewThreads: z.object({
        nodes: z.array(
          z.object({
            id: z.string().min(1),
            isResolved: z.boolean(),
            path: z.string(),
            // The line in the version the comment was made on, which a later push does not move.
            originalLine: z.number().int().nullable(),
            comments: z.object({
              // GitHub gives a deleted account as null.
              nodes: z.array(z.object({ body: z.string(), author: z.object({ login: z.string() }).nullable() })),
            }),
          }),
        ),
      }),
    }),
  }),
});

const REPLY = `mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } }
}`;

/** What adding a pull request to the queue reads of it first, from GitHub, whatever the caller sent. */
const QUEUE_PULL = z.object({
  state: z.string(),
  draft: z.boolean().optional(),
  node_id: z.string().min(1),
  head: z.object({ ref: z.string(), sha: SHA, repo: z.object({ full_name: z.string() }).nullable() }),
});

/** A pull request as the queue's guard reads it, from GitHub. */
export function queueCandidate(
  github: GitHub,
): (repo: string, number: number) => Promise<QueueCandidate & { nodeId: string }> {
  return async (repo, number) => {
    const pull = await github.read(repo, `/repos/${repo}/pulls/${number}`, QUEUE_PULL);
    return {
      state: pull.state,
      draft: pull.draft ?? false,
      nodeId: pull.node_id,
      head: { ref: pull.head.ref, sha: pull.head.sha, repo: pull.head.repo?.full_name ?? null },
    };
  };
}

const ENQUEUE = `mutation($input: EnqueuePullRequestInput!) {
  enqueuePullRequest(input: $input) { mergeQueueEntry { position state } }
}`;

const ENQUEUED = z.object({
  enqueuePullRequest: z.object({
    mergeQueueEntry: z.object({ position: z.number().int().nullable(), state: z.string().nullable() }).nullable(),
  }),
});

const RESOLVE = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { isResolved } }
}`;

/** GraphQL names the App without the `[bot]` REST adds. */
const byApp = (author: { login: string } | null) =>
  author?.login.replace(/\[bot\]$/, '') === APP_LOGIN.replace(/\[bot\]$/, '');

/** A comment's body as it is compared: GitHub may keep the line endings it was sent with, or not. */
const same = (a: string, b: string) => a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();

const checkRunBody = (report: Partial<CheckRunReport>) => ({
  name: report.name,
  head_sha: report.headSha,
  status: report.status,
  conclusion: report.conclusion,
  details_url: report.detailsUrl,
  external_id: report.externalId,
  output:
    report.title === undefined
      ? undefined
      : { title: report.title, summary: report.summary ?? '', ...(report.text ? { text: report.text } : {}) },
});

export class LiveActions implements Actions {
  readonly dryRun = false;
  readonly #github: GitHub;
  readonly #read: ReadFile;
  /**
   * The last write to each pull request's body, by repository and number. The deploy watch moving a pull request and
   * the line describing it run in this one worker: a description waits for a move, so it never writes back the body
   * of the build before. A move may still keep the Carries section the body had when its pass began, a description
   * older than one that landed meanwhile; the line describes the moved pull request again, for its new commit.
   */
  readonly #bodies = new Map<string, Promise<unknown>>();
  readonly #guard: IssueGuard;

  /** `guard` holds the issue actions to the App's own issues; by default it asks GitHub, and keeps no record. */
  constructor(github: GitHub, { guard }: { guard?: IssueGuard } = {}) {
    this.#github = github;
    this.#read = contentsReader(github);
    this.#guard = guard ?? new IssueGuard({ openedBy: openedBy(github) });
  }

  async applyPatch(repo: string, { branch, expectedHead, patch, message }: PatchCommit): Promise<string> {
    guardBranch(branch);
    const read = (path: string) => this.#read(repo, path, expectedHead);
    await guard(patch, read);
    const changes = await applyTo(patch, read);
    return this.commit(repo, { branch, expectedHead, message, changes });
  }

  async setBranch(repo: string, branch: string, sha: string, { force = false } = {}): Promise<void> {
    guardBranch(branch);
    // Whether the branch is there decides between moving it and making it: asked, not read off an error's words.
    let exists = true;
    try {
      await this.#github.read(repo, `/repos/${repo}/git/ref/heads/${branch}`, z.unknown());
    } catch (error) {
      if (!(error instanceof GitHubError && error.kind === 'not-found')) throw error;
      exists = false;
    }
    if (exists) await this.#github.write(repo, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha, force });
    else await this.#github.write(repo, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    guardBranch(branch);
    await this.#github.write(repo, 'DELETE', `/repos/${repo}/git/refs/heads/${branch}`);
  }

  async commit(repo: string, { branch, expectedHead, message, changes }: Commit): Promise<string> {
    guardBranch(branch);
    const [headline = '', ...rest] = message.split('\n');
    const body = rest.join('\n').trim();
    const answer = await this.#github.graphql(
      repo,
      CREATE_COMMIT,
      {
        input: {
          branch: { repositoryNameWithOwner: repo, branchName: branch },
          expectedHeadOid: expectedHead,
          message: { headline, ...(body ? { body } : {}) },
          fileChanges: {
            additions: changes.additions.map((a) => ({
              path: a.path,
              contents: Buffer.from(a.contents).toString('base64'),
            })),
            deletions: changes.deletions.map((path) => ({ path })),
          },
        },
      },
      z.object({ createCommitOnBranch: z.object({ commit: z.object({ oid: SHA }) }) }),
    );
    return answer.createCommitOnBranch.commit.oid;
  }

  async openPullRequest(repo: string, { labels, contradicts, ...draft }: PullRequestDraft): Promise<PullRequestRef> {
    const made = await this.#github.write(
      repo,
      'POST',
      `/repos/${repo}/pulls`,
      { ...draft, body: described(draft.body, contradicts), draft: draft.draft ?? false },
      z.object({ number: NUMBER, html_url: z.string(), node_id: z.string().min(1) }),
    );
    // Its own pull request, just opened: nothing to ask the guard.
    if (labels?.length) await this.#label(repo, made.number, labels);
    return { number: made.number, url: made.html_url, nodeId: made.node_id };
  }

  async updatePullRequest(
    repo: string,
    number: number,
    { keepCarries, contradicts, ...change }: PullRequestChange,
  ): Promise<void> {
    // Guarded within its turn, which it takes as it is asked: a description asked after it still waits for it.
    await this.#inTurn(repo, number, async () => {
      await this.#guard.check(repo, number, 'updatePullRequest');
      if (change.body !== undefined) change.body = described(change.body, contradicts);
      else if (contradicts !== undefined) {
        // The section alone, in the body as it is: read in its turn, so nothing written since is written over.
        const { body } = await this.#github.read(
          repo,
          `/repos/${repo}/pulls/${number}`,
          DEPLOY_PULL.pick({ body: true }),
        );
        const now = described(body ?? '', contradicts);
        if (now === (body ?? '') && change.title === undefined) return;
        change.body = now;
      }
      if (keepCarries && change.body !== undefined) {
        // Read in its turn, so a description written since the new body was made is not written over.
        const { body } = await this.#github.read(
          repo,
          `/repos/${repo}/pulls/${number}`,
          DEPLOY_PULL.pick({ body: true }),
        );
        const carries = carriesIn(body);
        if (carries) change.body = withCarries(change.body, carries);
      }
      await this.#github.write(repo, 'PATCH', `/repos/${repo}/pulls/${number}`, change);
    });
  }

  async describeDeploy(repo: string, number: number, { commit, carries, more }: Deploy): Promise<boolean> {
    return this.#inTurn(repo, number, async () => {
      await this.#guard.check(repo, number, 'describeDeploy');
      const pull = await this.#github.read(repo, `/repos/${repo}/pulls/${number}`, DEPLOY_PULL);
      // A fork's branch of the same name is not the deploy branch.
      if (pull.head.repo?.full_name !== repo) throw new DeployRefused(`Pull request #${number} is not from ${repo}.`);
      const target = deployTarget(repo, pull.head.ref);
      // Only a deploy of one pin file has one range of commits to say what it carries.
      const [pin, ...others] = target.pins;
      if (!pin || others.length) throw new DeployRefused(`${pull.head.ref} of ${repo} moves more than one pin file.`);
      // Moved on to a newer build since the line looked, or merged: the line looks again.
      if (pull.state !== 'open' || pull.base.ref !== 'main' || pull.title !== deployTitle(target, [{ pin, commit }])) {
        throw new GitHubError('conflict', `Pull request #${number} is not open for ${commit.slice(0, 7)}.`, 409);
      }
      const body = withCarries(pull.body ?? '', carriesSection(carries, more));
      if (body === pull.body) return false;
      await this.#github.write(repo, 'PATCH', `/repos/${repo}/pulls/${number}`, { body });
      return true;
    });
  }

  /** Does a write to a pull request's body once every write to it begun before has ended. */
  #inTurn<T>(repo: string, number: number, write: () => Promise<T>): Promise<T> {
    const key = `${repo}#${number}`;
    const done = (this.#bodies.get(key) ?? Promise.resolve()).then(write);
    const settled = done.catch(() => {});
    this.#bodies.set(key, settled);
    void settled.then(() => {
      if (this.#bodies.get(key) === settled) this.#bodies.delete(key);
    });
    return done;
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.#guard.check(repo, number, 'addLabels');
    await this.#label(repo, number, labels);
  }

  async #label(repo: string, number: number, labels: string[]): Promise<void> {
    await this.#github.write(repo, 'POST', `/repos/${repo}/issues/${number}/labels`, { labels });
  }

  async readyForReview(repo: string, pullRequest: PullRequestRef): Promise<void> {
    await this.#github.graphql(repo, READY, { id: await this.#own(repo, pullRequest, 'readyForReview') }, z.unknown());
  }

  async convertToDraft(repo: string, pullRequest: PullRequestRef): Promise<void> {
    await this.#github.graphql(
      repo,
      TO_DRAFT,
      { id: await this.#own(repo, pullRequest, 'convertToDraft') },
      z.unknown(),
    );
  }

  /**
   * The GraphQL id of a pull request the App opened, read from GitHub by its number once the guard has passed it, so
   * the pull request acted on is the one guarded, whatever id the caller sent.
   */
  async #own(repo: string, pullRequest: PullRequestRef, action: IssueAction): Promise<string> {
    await this.#guard.check(repo, pullRequest.number, action);
    const pull = await this.#github.read(
      repo,
      `/repos/${repo}/pulls/${pullRequest.number}`,
      z.object({ node_id: z.string().min(1) }),
    );
    return pull.node_id;
  }

  async review(
    repo: string,
    number: number,
    { commit, body, comments }: { commit: string; body: string; comments: ReviewComment[] },
  ): Promise<number> {
    await this.#guard.check(repo, number, 'review');
    const made = await this.#github.write(
      repo,
      'POST',
      `/repos/${repo}/pulls/${number}/reviews`,
      {
        commit_id: commit,
        body,
        event: 'COMMENT',
        comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
      },
      ID,
    );
    return made.id;
  }

  async resolveThreads(repo: string, number: number, threads: ThreadAnswer[]): Promise<void> {
    await this.#guard.check(repo, number, 'resolveThreads');
    const [owner, name] = repo.split('/');
    const answer = await this.#github.graphql(repo, THREADS, { owner, name, number }, THREADS_ANSWER);
    for (const thread of answer.repository.pullRequest.reviewThreads.nodes) {
      const [first, ...replies] = thread.comments.nodes;
      if (thread.isResolved || !first || !byApp(first.author)) continue;
      const made = (c: ReviewComment) => c.path === thread.path && c.line === thread.originalLine;
      const { reply } = threads.find((c) => made(c) && same(c.body, first.body)) ?? {};
      if (reply === undefined) continue;
      if (!replies.some((r) => byApp(r.author) && same(r.body, reply))) {
        await this.#github.graphql(repo, REPLY, { id: thread.id, body: reply }, z.unknown());
      }
      await this.#github.graphql(repo, RESOLVE, { id: thread.id }, z.unknown());
    }
  }

  async createCheckRun(repo: string, report: CheckRunReport): Promise<number> {
    const made = await this.#github.write(repo, 'POST', `/repos/${repo}/check-runs`, checkRunBody(report), ID);
    return made.id;
  }

  async updateCheckRun(repo: string, id: number, report: Partial<CheckRunReport>): Promise<void> {
    await this.#github.write(repo, 'PATCH', `/repos/${repo}/check-runs/${id}`, checkRunBody(report));
  }

  async openIssue(repo: string, issue: { title: string; body: string; labels?: string[] }): Promise<number> {
    const made = await this.#github.write(repo, 'POST', `/repos/${repo}/issues`, issue, z.object({ number: NUMBER }));
    return made.number;
  }

  async closeIssue(repo: string, number: number, reason: 'completed' | 'not_planned', comment?: string): Promise<void> {
    await this.#guard.check(repo, number, 'closeIssue');
    if (comment !== undefined) {
      const issue = await this.#github.read(repo, `/repos/${repo}/issues/${number}`, ISSUE);
      if (issue.state !== 'open') return;
      // A close whose comment was made and whose closing failed is tried again: the comment is not made twice. Only
      // what was said since the issue last reopened counts: a close of an earlier pass may have said the same.
      const events = await this.#github.read(
        repo,
        `/repos/${repo}/issues/${number}/events?per_page=100`,
        z.array(z.object({ event: z.string(), created_at: z.string() })),
      );
      const reopened = events.findLast((event) => event.event === 'reopened')?.created_at ?? null;
      if (!(await this.#said(repo, number, comment, reopened))) await this.#post(repo, number, comment);
    }
    await this.#github.write(repo, 'PATCH', `/repos/${repo}/issues/${number}`, {
      state: 'closed',
      state_reason: reason,
    });
  }

  async reopenIssue(repo: string, number: number, comment: string): Promise<void> {
    await this.#guard.check(repo, number, 'reopenIssue');
    const issue = await this.#github.read(repo, `/repos/${repo}/issues/${number}`, ISSUE);
    if (issue.state !== 'closed') return;
    // Only what was said since it closed counts: an earlier reopening may have said the same.
    if (!(await this.#said(repo, number, comment, issue.closed_at))) await this.#post(repo, number, comment);
    await this.#github.write(repo, 'PATCH', `/repos/${repo}/issues/${number}`, {
      state: 'open',
      state_reason: 'reopened',
    });
  }

  async closePullRequest(repo: string, number: number, comment: string): Promise<void> {
    await this.#guard.check(repo, number, 'closePullRequest');
    const pull = await this.#github.read(
      repo,
      `/repos/${repo}/pulls/${number}`,
      z.object({ state: z.string(), head: z.object({ ref: z.string() }) }),
    );
    if (pull.state !== 'open') return;
    // Only a pull request from a branch of the factory's own, as for every change it makes to a branch.
    guardBranch(pull.head.ref);
    if (!(await this.#said(repo, number, comment, null))) await this.#post(repo, number, comment);
    await this.#github.write(repo, 'PATCH', `/repos/${repo}/pulls/${number}`, { state: 'closed' });
  }

  /** Whether an issue's comments since a time (or ever, with none) already say this, word for word. */
  async #said(repo: string, number: number, body: string, since: string | null): Promise<boolean> {
    const after = since ? `&since=${encodeURIComponent(since)}` : '';
    const comments = await this.#github.read(
      repo,
      `/repos/${repo}/issues/${number}/comments?per_page=100${after}`,
      z.array(z.object({ body: z.string().nullable() })),
    );
    // As GitHub keeps it: its line endings may be \r\n, and its ends trimmed.
    return comments.some((made) => same(made.body ?? '', body));
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.#guard.check(repo, number, 'comment', body);
    if (!(await this.#said(repo, number, body, null))) await this.#post(repo, number, body);
  }

  async #post(repo: string, number: number, body: string): Promise<void> {
    await this.#github.write(repo, 'POST', `/repos/${repo}/issues/${number}/comments`, { body });
  }

  async enqueuePullRequest(repo: string, number: number, expectedHead: string): Promise<Enqueued> {
    await this.#guard.check(repo, number, 'enqueuePullRequest');
    // Read from GitHub once the guard has passed it, so the pull request queued is the one guarded, by its own id.
    const pull = await queueCandidate(this.#github)(repo, number);
    guardQueue(repo, number, pull, expectedHead);
    const answer = await this.#github.graphql(
      repo,
      ENQUEUE,
      { input: { pullRequestId: pull.nodeId, expectedHeadOid: expectedHead } },
      ENQUEUED,
    );
    const entry = answer.enqueuePullRequest.mergeQueueEntry;
    return { position: entry?.position ?? null, state: entry?.state ?? null };
  }
}

/** What a dry run records for one action: enough to see exactly what would have changed. */
export interface DryRunRecord {
  action: keyof Omit<Actions, 'dryRun'>;
  repo: string;
  at: string;
  /** The action's arguments, with file contents as text where they are UTF-8, and base64 where they are not. */
  args: unknown;
}

/** A commit a dry run would have made: on what, when, and each file it changed, with its new text or null if deleted. */
export interface DryRunCommit {
  parent: string;
  at: Date;
  message: string;
  /** The runner's patch it was made from, when it was made from one. */
  patch: string | undefined;
  files: Map<string, string | null>;
}

/** A pull request a dry run would have opened. */
export interface DryRunPull {
  number: number;
  repo: string;
  /** Its branch, and the branch it would merge into. */
  head: string;
  base: string;
  openedAt: Date;
  draft: boolean;
  /** When it left draft, or opened ready; null while it is a draft. */
  readiedAt: Date | null;
  nodeId: string;
  /** When it would have been closed unmerged, or null while it is open: then it never merges. */
  closedAt: Date | null;
  /** Its description, as the dry run would last have written it. */
  body: string;
  /** When it would last have been added to the merge queue, and at which head, or null while it has not. */
  enqueuedAt: Date | null;
  enqueuedHead: string | null;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Where a dry run's numbers start: its pull requests, and so its merges, are numbered from here up. */
export const DRY_RUN_NUMBERS_FROM = 1_000_000_000;

/** File contents as they will read in the record. */
function shown(contents: Uint8Array): { text: string } | { base64: string } {
  try {
    return { text: decoder.decode(contents) };
  } catch {
    return { base64: Buffer.from(contents).toString('base64') };
  }
}

export class DryRunActions implements Actions {
  readonly dryRun = true;
  readonly #artifacts: ArtifactStore;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #read: ReadFile;
  /**
   * The commits it would have made, each with its parent, when, and the files it changed, so a patch can go on one:
   * the smoke run's seeded base, or a second round's fix on top of the first.
   */
  readonly #commits = new Map<string, DryRunCommit>();
  /** Where the branches it would have moved would point, by repository and branch. */
  readonly #branches = new Map<string, string>();
  /** The pull requests it would have opened, by number. */
  readonly #pulls = new Map<number, DryRunPull>();
  /** What it would have said on each issue or pull request, by repository and number, so it records each once. */
  readonly #said = new Map<string, Set<string>>();
  /**
   * Numbers for what would have been made, from a billion up: positive, as every action that takes one requires,
   * and far beyond any this repository will reach, so none can be taken for a real one.
   */
  #next = DRY_RUN_NUMBERS_FROM;
  /** Holds the issue actions to the App's own issues, as the live actions' guard does, for those GitHub has. */
  readonly #guard: IssueGuard;
  /** Whether a pull request this dry run opened reads as merged now, as its reads judge it (`dry-run-reads.ts`). */
  #mergedNow: (pull: DryRunPull) => boolean = () => false;
  /** Reads a pull request GitHub has, as the queue's guard reads it. */
  readonly #readPull: (repo: string, number: number) => Promise<QueueCandidate>;

  constructor(
    artifacts: ArtifactStore,
    log: Logger,
    now: () => Date = () => new Date(),
    read: ReadFile = async () => {
      throw new Error('This dry run reads no files.');
    },
    guard: IssueGuard = new IssueGuard({
      openedBy: async () => {
        throw new Error('This dry run reads no issues.');
      },
      recorder: new RefusalRecorder({ artifacts, log, now }),
    }),
    readPull: (repo: string, number: number) => Promise<QueueCandidate> = async () => {
      throw new Error('This dry run reads no pull requests.');
    },
  ) {
    this.#artifacts = artifacts;
    this.#log = log;
    this.#now = now;
    this.#read = read;
    this.#guard = guard;
    this.#readPull = readPull;
  }

  /**
   * Refuses an issue action the live actions' guard would, on an issue GitHub has. An issue or pull request numbered
   * from `DRY_RUN_NUMBERS_FROM` up is one this dry run made, which GitHub never had, as the App: it passes, whether
   * this worker remembers it or has started again since.
   */
  async #guarded(repo: string, number: number, action: IssueAction, body?: string): Promise<void> {
    if (number >= DRY_RUN_NUMBERS_FROM) return;
    await this.#guard.check(repo, number, action, body);
  }

  /** A commit this dry run would have made, or undefined for any other. */
  commitMade(sha: string): DryRunCommit | undefined {
    return this.#commits.get(sha);
  }

  /** The real commit under a chain of commits this dry run made: where its first one would have gone. */
  rootOf(sha: string): string {
    let at = sha;
    for (let made = this.#commits.get(at); made; made = this.#commits.get(at)) at = made.parent;
    return at;
  }

  /** Where a branch this dry run moved would point, or undefined for one it never touched. */
  branchMade(repo: string, branch: string): string | undefined {
    return this.#branches.get(`${repo} ${branch}`);
  }

  /**
   * The head a pull request this dry run opened would be at: its branch as the dry run moved it, or, for a branch it
   * never moved, a sha that stands for it, the same every time, which its reads give too (`dry-run-reads.ts`).
   */
  headOf(pull: DryRunPull): string {
    return (
      this.branchMade(pull.repo, pull.head) ??
      createHash('sha1').update(`dry run: ${pull.repo}#${pull.number} head`).digest('hex')
    );
  }

  /**
   * When a pull request this dry run opened went into the merge queue, while it is still there: GitHub takes a pull
   * request out of the queue when its head moves or it goes back to draft, so a push or a draft since leaves it out.
   */
  queuedAt(pull: DryRunPull): Date | null {
    return !pull.draft && pull.enqueuedHead === this.headOf(pull) ? pull.enqueuedAt : null;
  }

  /** A pull request this dry run would have opened, or undefined for any other number. */
  pullRequestMade(number: number): DryRunPull | undefined {
    return this.#pulls.get(number);
  }

  /** The pull requests this dry run would have opened, in order. */
  pullRequestsMade(): DryRunPull[] {
    return [...this.#pulls.values()];
  }

  /** A file at a commit: as a commit this dry run made left it, or as it really is. */
  async file(repo: string, path: string, ref: string): Promise<string | null> {
    let at = ref;
    for (let made = this.#commits.get(at); made; made = this.#commits.get(at)) {
      if (made.files.has(path)) return made.files.get(path) ?? null;
      at = made.parent;
    }
    return this.#read(repo, path, at);
  }

  async applyPatch(repo: string, { branch, expectedHead, patch, message }: PatchCommit): Promise<string> {
    guardBranch(branch);
    const read = (path: string) => this.file(repo, path, expectedHead);
    await guard(patch, read);
    const changes = await applyTo(patch, read);
    return this.#commit(repo, { branch, expectedHead, message, changes }, patch);
  }

  async #record(action: DryRunRecord['action'], repo: string, args: unknown): Promise<string> {
    const record: DryRunRecord = { action, repo, at: this.#now().toISOString(), args };
    const hash = await this.#artifacts.put(new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`));
    this.#log.info({ action, repo, artifact: hash }, `dry run: would ${action}`);
    return hash;
  }

  #number(): number {
    this.#next += 1;
    return this.#next;
  }

  async setBranch(repo: string, branch: string, sha: string, options: { force?: boolean } = {}): Promise<void> {
    guardBranch(branch);
    await this.#record('setBranch', repo, { branch, sha, ...options });
    this.#branches.set(`${repo} ${branch}`, sha);
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    guardBranch(branch);
    await this.#record('deleteBranch', repo, { branch });
    this.#branches.delete(`${repo} ${branch}`);
  }

  commit(repo: string, commit: Commit): Promise<string> {
    return this.#commit(repo, commit, undefined);
  }

  async #commit(repo: string, commit: Commit, patch: string | undefined): Promise<string> {
    guardBranch(commit.branch);
    const { changes, ...rest } = commit;
    const hash = await this.#record('commit', repo, {
      ...rest,
      changes: {
        additions: changes.additions.map((a) => ({ path: a.path, ...shown(a.contents) })),
        deletions: changes.deletions,
      },
    });
    // The record's own hash stands in for the commit's: it is as long, and names something that can be looked up.
    const sha = hash.slice(0, 40);
    const files = new Map<string, string | null>(changes.deletions.map((path) => [path, null]));
    for (const a of changes.additions) files.set(a.path, new TextDecoder().decode(a.contents));
    this.#commits.set(sha, { parent: commit.expectedHead, at: this.#now(), message: commit.message, patch, files });
    this.#branches.set(`${repo} ${commit.branch}`, sha);
    return sha;
  }

  async openPullRequest(repo: string, { contradicts, ...given }: PullRequestDraft): Promise<PullRequestRef> {
    // What it records is what it would publish: the body with its section, and not the list it was made from.
    const draft = { ...given, body: described(given.body, contradicts) };
    await this.#record('openPullRequest', repo, draft);
    const number = this.#number();
    const nodeId = `dry-run-${number}`;
    this.#pulls.set(number, {
      number,
      repo,
      head: draft.head,
      base: draft.base,
      openedAt: this.#now(),
      draft: draft.draft ?? false,
      readiedAt: draft.draft ? null : this.#now(),
      nodeId,
      closedAt: null,
      body: draft.body,
      enqueuedAt: null,
      enqueuedHead: null,
    });
    return { number, url: `dry-run:${repo}#${number}`, nodeId };
  }

  // A dry run's deploy pull requests have no body to read: what it records is the body the watch made. Its own pull
  // requests' bodies it remembers, so a section given alone is recorded in the description it would have set.
  async updatePullRequest(
    repo: string,
    number: number,
    { keepCarries: _, contradicts, ...change }: PullRequestChange,
  ): Promise<void> {
    await this.#guarded(repo, number, 'updatePullRequest');
    const pull = this.#pulls.get(number);
    const body =
      change.body !== undefined
        ? described(change.body, contradicts)
        : contradicts !== undefined && pull?.repo === repo
          ? described(pull.body, contradicts)
          : undefined;
    if (body !== undefined && pull?.repo === repo) {
      // The section alone, unchanged, is no write; a body given is recorded as a live worker would write it.
      if (change.body === undefined && body === pull.body && change.title === undefined) return;
      pull.body = body;
    }
    // A pull request it never opened has no body it knows: it records the list, which says what it would have set.
    const unknown = body === undefined && contradicts !== undefined ? { contradicts } : {};
    await this.#record('updatePullRequest', repo, {
      number,
      ...change,
      ...(body !== undefined ? { body } : {}),
      ...unknown,
    });
  }

  async describeDeploy(repo: string, number: number, deploy: Deploy): Promise<boolean> {
    await this.#guarded(repo, number, 'describeDeploy');
    await this.#record('describeDeploy', repo, { number, ...deploy });
    return true;
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.#guarded(repo, number, 'addLabels');
    await this.#record('addLabels', repo, { number, labels });
  }

  async readyForReview(repo: string, pullRequest: PullRequestRef): Promise<void> {
    await this.#guarded(repo, pullRequest.number, 'readyForReview');
    await this.#record('readyForReview', repo, { number: pullRequest.number });
    const pull = this.#pulls.get(pullRequest.number);
    if (pull?.draft) Object.assign(pull, { draft: false, readiedAt: this.#now() });
  }

  async convertToDraft(repo: string, pullRequest: PullRequestRef): Promise<void> {
    await this.#guarded(repo, pullRequest.number, 'convertToDraft');
    await this.#record('convertToDraft', repo, { number: pullRequest.number });
    const pull = this.#pulls.get(pullRequest.number);
    if (pull && !pull.draft) Object.assign(pull, { draft: true, readiedAt: null });
  }

  async review(
    repo: string,
    number: number,
    review: { commit: string; body: string; comments: ReviewComment[] },
  ): Promise<number> {
    await this.#guarded(repo, number, 'review');
    await this.#record('review', repo, { number, ...review });
    return this.#number();
  }

  async resolveThreads(repo: string, number: number, threads: ThreadAnswer[]): Promise<void> {
    await this.#guarded(repo, number, 'resolveThreads');
    await this.#record('resolveThreads', repo, { number, threads });
  }

  async createCheckRun(repo: string, report: CheckRunReport): Promise<number> {
    await this.#record('createCheckRun', repo, report);
    return this.#number();
  }

  async updateCheckRun(repo: string, id: number, report: Partial<CheckRunReport>): Promise<void> {
    await this.#record('updateCheckRun', repo, { id, ...report });
  }

  async openIssue(repo: string, issue: { title: string; body: string; labels?: string[] }): Promise<number> {
    await this.#record('openIssue', repo, issue);
    return this.#number();
  }

  async closeIssue(repo: string, number: number, reason: 'completed' | 'not_planned', comment?: string): Promise<void> {
    await this.#guarded(repo, number, 'closeIssue');
    await this.#record('closeIssue', repo, { number, reason, ...(comment === undefined ? {} : { comment }) });
  }

  async reopenIssue(repo: string, number: number, comment: string): Promise<void> {
    await this.#guarded(repo, number, 'reopenIssue');
    await this.#record('reopenIssue', repo, { number, comment });
  }

  async closePullRequest(repo: string, number: number, comment: string): Promise<void> {
    // One it closed already is left as it is, as GitHub's would be, and recorded once.
    const pull = this.#pulls.get(number);
    if (pull?.closedAt) return;
    await this.#guarded(repo, number, 'closePullRequest');
    await this.#record('closePullRequest', repo, { number, comment });
    if (pull) pull.closedAt = this.#now();
  }

  /** Told how its reads judge a pull request it opened merged, so one merged is not added to the merge queue. */
  judgeMerges(merged: (pull: DryRunPull) => boolean): void {
    this.#mergedNow = merged;
  }

  /**
   * Guarded as the live action is, against the pull request as this dry run would have left it, or as GitHub has it;
   * then recorded, and its own pull request reads as queued from then on, and merges after the dry run's while
   * (`dry-run-reads.ts`). One that reads as merged is not open, and is refused (409).
   */
  async enqueuePullRequest(repo: string, number: number, expectedHead: string): Promise<Enqueued> {
    const made = this.#pulls.get(number);
    const own = made?.repo === repo ? made : undefined;
    if (own) {
      guardQueue(
        repo,
        number,
        {
          state: own.closedAt || this.#mergedNow(own) ? 'closed' : 'open',
          draft: own.draft,
          head: { ref: own.head, sha: this.headOf(own), repo },
        },
        expectedHead,
      );
    } else {
      await this.#guarded(repo, number, 'enqueuePullRequest');
      guardQueue(repo, number, await this.#readPull(repo, number), expectedHead);
    }
    await this.#record('enqueuePullRequest', repo, { number, expectedHead });
    if (!own) return { position: null, state: null };
    if (!this.queuedAt(own)) Object.assign(own, { enqueuedAt: this.#now(), enqueuedHead: expectedHead });
    return { position: 1, state: 'QUEUED' };
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    const on = `${repo}#${number}`;
    const said = this.#said.get(on) ?? new Set<string>();
    if (said.has(body)) return;
    // Taken before it is guarded and recorded, so two asked at once record it once; given back if either fails.
    this.#said.set(on, said.add(body));
    try {
      await this.#guarded(repo, number, 'comment', body);
      await this.#record('comment', repo, { number, body });
    } catch (error) {
      said.delete(body);
      throw error;
    }
  }
}
