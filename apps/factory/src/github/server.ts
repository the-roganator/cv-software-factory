/**
 * The GitHub worker over HTTP, for the other workers in the cluster: the only way they act in GitHub, since this is
 * the only pod with the App's key.
 *
 *     POST /v1/actions/<action>   one of `Actions`, with its arguments as JSON; its result out. With the header
 *                                 `x-factory-dry-run: true` it is recorded in the artifact store and not done;
 *                                 `x-factory-work-item` and `x-factory-agent` name what it is for, in its log
 *     POST /v1/reads/<read>       one of `Reads` (`reads.ts`), with its arguments as JSON; what GitHub says out.
 *                                 With `x-factory-dry-run: true`, what the dry run made reads as it would have
 *                                 been (`dry-run-reads.ts`), and anything else as GitHub says
 *     GET  /health                whether it can write, whether it is a dry run, and what it is watching
 *
 * A body must say it is JSON: a web page cannot send that without the browser asking first, and the worker answers
 * no browser, so a page open on the same machine cannot make it act. Each body is checked with Zod at the door, and names a repository the worker is configured for, or it is refused.
 * A GitHub failure keeps its meaning: refused 403, not found 404, conflict 409, rate limited 429, GitHub or the
 * network failing 502, and a write with no key 503. A patch that will not apply, a branch the factory does not
 * own, or a deploy pull request or image that is not one, is 422. GHCR failing is 502. An issue the App did not
 * open is 403 (`issue-refused`), as GitHub answers one the App may not change.
 *
 * An action refused by the worker's guard (a patch to a protected path, a branch, a deploy, an issue or pull request
 * not the App's, a pull request for the merge queue from a fork or a red-team branch, a pull request from a pin branch,
 * a `pin` label, or any action on the pin watch's pull requests, which only it takes) or by GitHub with a 403 is kept,
 * logged and signed (`refusals.ts`), and the answer carries it as `refusal`, for the worker that asked to record as
 * `action.refused` (`../signed-refusals.ts`). Its status is as it would be without it. A read refuses nothing, but the
 * gate's verdict that holds a pull request (`reviewVerdict`) carries the gate's refusal the same way, in its result.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { z } from 'zod';
import { entryProblem, MOST_CONTRADICTED } from '../gates/contradicts.ts';
import type { SignedRefusal } from '../signed-refusals.ts';
import type { Actions } from './actions.ts';
import { BranchRefused, guardWritable, pinBranch } from './branches.ts';
import { GitHubError } from './client.ts';
import { QUEUED_DEPLOYS, QUEUES_DEPLOYS_IN } from './deploy-queue.ts';
import { DeployRefused, deployLabel, MAX_CARRIES, scratchBranch } from './deploys.ts';
import { IssueRefused } from './issues.ts';
import { REVIEW_CHECK } from './merging.ts';
import { PatchRefused } from './patches.ts';
import { plainPath } from './paths.ts';
import { PIN_LABEL, PIN_REPOS } from './pins.ts';
import type { Reads } from './reads.ts';
import type { GitHubRefusal, RefusalRecorder } from './refusals.ts';
import { DIGEST, RegistryError } from './registry.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const branch = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/|.*\/$|.*\.\.|.*\/\/)[A-Za-z0-9._/-]+$/, 'a branch name of letters, digits, dots, dashes and slashes');
/** A path a commit names: one a patch may name (`plainPath`), whether or not it came from one. */
const path = z.string().refine(plainPath, 'a plain relative path');
/**
 * A path a review comment is anchored to: a file the pull request changes, which may be one Martin pushed, so any
 * relative path GitHub shows.
 */
const anchor = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !p.startsWith('/') && !p.split('/').some((part) => part === '..' || part === ''), 'a relative path');
const number = z.number().int().positive();
const text = (max: number) => z.string().max(max);
const digest = z.string().regex(DIGEST);
/** An image as GHCR names it, such as `the-roganator/cv-worlds-worst-website`. */
const image = z
  .string()
  .max(200)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/, 'an image as GHCR names it');
const carry = z.strictObject({
  workItem: z.string().regex(/^[1-9]\d{0,8}$/),
  title: text(120).min(1),
  issue: number.nullable(),
  pullRequest: number,
});
/** The tests a spec contradicts, as the section of a description names them: each one the gate would read. */
const contradicts = z
  .array(
    z.strictObject({ file: z.string(), test: z.string() }).superRefine((entry, ctx) => {
      const problem = entryProblem(entry);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    }),
  )
  .max(MOST_CONTRADICTED);
const pullRequestRef = z.strictObject({ number, url: z.string(), nodeId: z.string().min(1) });
const checkRun = z.strictObject({
  name: text(100).min(1),
  headSha: sha,
  status: z.enum(['queued', 'in_progress', 'completed']),
  conclusion: z
    .enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required'])
    .optional(),
  title: text(200),
  summary: text(65_535),
  text: text(65_535).optional(),
  detailsUrl: z.url().optional(),
  externalId: text(100).optional(),
});

/** Each action's arguments after the repository, as the endpoint takes them. */
const ARGS = {
  setBranch: z.strictObject({ branch, sha, force: z.boolean().optional() }),
  deleteBranch: z.strictObject({ branch }),
  commit: z.strictObject({
    branch,
    expectedHead: sha,
    message: text(10_000).min(1),
    changes: z.strictObject({
      additions: z.array(z.strictObject({ path, contents: z.base64() })).max(200),
      deletions: z.array(path).max(200),
    }),
  }),
  applyPatch: z
    .strictObject({
      branch,
      expectedHead: sha,
      // Empty only beside the pin step's pins, when the move is the whole change (refined below).
      patch: z.string().max(2 * 1024 * 1024),
      /** The pin step's, on either side of the agent's: the guard holds each to the pin step's own rule. */
      pins: z
        .string()
        .min(1)
        .max(2 * 1024 * 1024)
        .optional(),
      lockfile: z
        .string()
        .min(1)
        .max(2 * 1024 * 1024)
        .optional(),
      message: text(10_000).min(1),
    })
    .refine((commit) => commit.patch !== '' || commit.pins !== undefined, {
      message: 'a commit has an agent’s patch, or the pin step’s pins',
      path: ['patch'],
    }),
  openPullRequest: z.strictObject({
    head: branch,
    base: branch,
    title: text(256).min(1),
    body: text(65_535),
    draft: z.boolean().optional(),
    labels: z.array(text(50)).max(10).optional(),
    contradicts: contradicts.optional(),
  }),
  updatePullRequest: z.strictObject({
    number,
    title: text(256).min(1).optional(),
    body: text(65_535).optional(),
    contradicts: contradicts.optional(),
  }),
  describeDeploy: z.strictObject({
    number,
    commit: sha,
    carries: z.array(carry).max(MAX_CARRIES),
    more: z.number().int().nonnegative().optional(),
  }),
  addLabels: z.strictObject({ number, labels: z.array(text(50)).min(1).max(10) }),
  readyForReview: z.strictObject({ pullRequest: pullRequestRef }),
  convertToDraft: z.strictObject({ pullRequest: pullRequestRef }),
  review: z.strictObject({
    number,
    commit: sha,
    body: text(65_535),
    comments: z.array(z.strictObject({ path: anchor, line: number, body: text(65_535).min(1) })).max(50),
  }),
  resolveThreads: z.strictObject({
    number,
    threads: z
      .array(z.strictObject({ path: anchor, line: number, body: text(65_535).min(1), reply: text(65_535).min(1) }))
      .min(1)
      .max(50),
  }),
  createCheckRun: checkRun,
  updateCheckRun: z.strictObject({ id: number, ...checkRun.partial().shape }),
  openIssue: z.strictObject({
    title: text(256).min(1),
    body: text(65_535),
    labels: z.array(text(50)).max(10).optional(),
  }),
  closeIssue: z.strictObject({
    number,
    reason: z.enum(['completed', 'not_planned']),
    comment: text(65_535).min(1).optional(),
  }),
  reopenIssue: z.strictObject({ number, comment: text(65_535).min(1) }),
  closePullRequest: z.strictObject({ number, comment: text(65_535).min(1) }),
  comment: z.strictObject({ number, body: text(65_535).min(1) }),
  enqueuePullRequest: z.strictObject({ number, expectedHead: sha }),
} satisfies Record<Exclude<keyof Actions, 'dryRun' | WatchOnly>, z.ZodType>;

/**
 * The actions only the worker's own watches take, never served: the pin watch's commit and its issues' rewrite
 * (`pins.ts`). No worker that asks can write a pin branch, even within the pin guard.
 */
export type WatchOnly = 'commitPins' | 'updateIssue';

export type Name = keyof typeof ARGS;

/** The actions a worker may ask for, each with its arguments after the repository, and what it gives back. */
export type ActionName = Name;
export type ActionArgs = { [K in Name]: z.input<(typeof ARGS)[K]> };
export type ActionResult<K extends Name> = Awaited<ReturnType<Actions[K]>>;

/** The headers that name what an action is taken for, so the worker's log of it can be found by its work item. */
export const WORK_ITEM_HEADER = 'x-factory-work-item';
export const AGENT_HEADER = 'x-factory-agent';

/** The work item, and the agent, an action is taken for: neither is needed, and neither changes what is done. */
export interface ActingFor {
  workItem?: string | undefined;
  agent?: string | undefined;
}

/** `/v1/actions/<action>` or `/v1/reads/<read>`. */
const ROUTE = /^\/v1\/(actions|reads)\/([A-Za-z]+)$/;

/** A work item's id or an agent's name, as a log may carry it: anything else a caller sends is left out. */
const NAMED = /^[A-Za-z0-9-]{1,64}$/;

function actingFor(req: IncomingMessage): ActingFor {
  const on: ActingFor = {};
  for (const [key, header] of [
    ['workItem', WORK_ITEM_HEADER],
    ['agent', AGENT_HEADER],
  ] as const) {
    const value = req.headers[header];
    if (typeof value === 'string' && NAMED.test(value)) on[key] = value;
  }
  return on;
}

/**
 * A label as GitHub may take it, read broadly so nothing that could be `pin` passes: decomposed (NFKD) with its marks
 * taken out, so `PİN` is `pin`; every character Unicode says to ignore taken out (zero-width, the soft hyphen,
 * variation selectors, fillers); a dotless i read as i; without regard to case or the space round it.
 */
const labelAsRead = (label: string): string =>
  label
    .normalize('NFKD')
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(/\u0131/g, 'i')
    .trim()
    .toLowerCase();

/** Whether a label is `pin` as GitHub takes it. */
const isPinLabel = (label: string): boolean => labelAsRead(label) === PIN_LABEL;

/**
 * Throws `BranchRefused` for what only the pin watch does with a pull request: open one from a pin branch, or give one
 * the `pin` label. The merge queue's pin watch (`deploy-queue.ts`) takes a pull request the App opened from a pin
 * branch and labelled `pin` as the pin watch's own, so no worker that asks may make one, even from a branch the watch
 * wrote.
 */
function guardPinPull({ head, labels }: { head?: string; labels?: readonly string[] | undefined }): void {
  const branch = head?.replace(/^refs\/heads\//, '');
  // A head is a branch by its name, or `refs/heads/` and its name; any other ref's form is not read as a branch here.
  if (branch !== undefined && /^(refs|heads|pull)\//.test(branch)) {
    throw new BranchRefused(`${head} is not a branch by its name: a pull request is opened from a branch's name.`);
  }
  if (branch !== undefined && pinBranch(branch)) {
    throw new BranchRefused(`${head} is the pin watch's: only the pin watch opens a pull request from it.`);
  }
  if (labels?.some(isPinLabel)) {
    throw new BranchRefused(`Only the pin watch gives a pull request or issue the ${PIN_LABEL} label.`);
  }
}

/**
 * Throws `BranchRefused` for any action a worker asks on one of the pin watch's pull requests, or here the deploy
 * watch's, by its branch as GitHub has it now: every action that names a pull request or issue by its number
 * (`numberOf`: `number`, or `pullRequest`'s), so one added later that names it so is too, and none is allowed, as only
 * each watch acts on its own. A number that is no pull request is an issue's, and not the queues' concern.
 */
async function guardPinNumber(repo: string, args: Record<string, unknown>, reads?: Reads): Promise<void> {
  const number = numberOf(args);
  if (number === null) return;
  if (!reads) throw new Error(`The door reads nothing, so it cannot tell whether #${number} is the pin watch's.`);
  let head: string;
  try {
    ({
      head: { ref: head },
    } = await reads.pullRequest(repo, number));
  } catch (error) {
    if (error instanceof GitHubError && error.kind === 'not-found') return;
    // GitHub's 403 to the door's own read is no refusal of the action, which was never asked: kept as a failure.
    if (error instanceof GitHubError && error.status === 403) {
      throw new Error(`The door could not read #${number}, so it cannot tell whether it is the pin watch's.`, {
        cause: error,
      });
    }
    throw error;
  }
  if (pinBranch(head)) {
    throw new BranchRefused(`#${number} is the pin watch's pull request, from ${head}: only the pin watch acts on it.`);
  }
  if (deployBranch(repo, head)) {
    throw new BranchRefused(
      `#${number} is the deploy watch's pull request, from ${head}: only the deploy watch acts on it.`,
    );
  }
}

/**
 * Whether a branch is one of the deploy watch's in a repository whose deploy pull requests the worker queues itself:
 * the deploy branch, or the scratch branch its commit is made on. The deploy queue takes a pull request from it as the
 * watch's own, so no worker that asks writes it, opens a pull request from it, or acts on one (ADR 0017).
 */
function deployBranch(repo: string, branch: string): boolean {
  if (repo !== QUEUES_DEPLOYS_IN) return false;
  // A branch at a prefix of one, or under one, is no branch of anyone else's: git keeps one ref of a path.
  const related = (watched: string) =>
    watched === branch || `${watched}/`.startsWith(`${branch}/`) || branch.startsWith(`${watched}/`);
  return QUEUED_DEPLOYS.some((target) => related(target.branch) || related(scratchBranch(target)));
}

/**
 * Throws `BranchRefused` for what only the deploy watch does in this repository: write its branches (`branch`), open a
 * pull request from one (`head`), or give one of its labels (`deploy: <profile>`).
 */
function guardDeployWatch(repo: string, args: Record<string, unknown>): void {
  if (repo !== QUEUES_DEPLOYS_IN) return;
  for (const field of ['branch', 'head'] as const) {
    const named = args[field];
    if (typeof named === 'string' && deployBranch(repo, named.replace(/^refs\/heads\//, ''))) {
      throw new BranchRefused(`${named} is the deploy watch's: no worker that asks writes it or opens it.`);
    }
  }
  const labels = args.labels;
  if (Array.isArray(labels)) {
    const watched = QUEUED_DEPLOYS.map((target) => labelAsRead(deployLabel(target)));
    if (labels.some((label) => typeof label === 'string' && watched.includes(labelAsRead(label)))) {
      throw new BranchRefused(`Only the deploy watch gives a pull request or issue a deploy label.`);
    }
  }
}

/**
 * Throws `BranchRefused` for an enqueue a worker asks in a repository whose merge queue only the worker's own watches
 * add to: this one's, where the deploy queue and the pin queue add only what their watches opened and the gate passed
 * (ADR 0017). The line adds to the app's alone.
 */
function guardEnqueue(repo: string): void {
  if (repo === QUEUES_DEPLOYS_IN || PIN_REPOS.includes(repo)) {
    throw new BranchRefused(
      `In ${repo} only the worker's own watches add to the merge queue: no worker that asks adds a pull request there.`,
    );
  }
}

/**
 * Throws `BranchRefused` for a branch a worker asks to set, or a check run it asks to post, at a pin branch's commit,
 * in a repository the pin watch writes: a second pull request with the pin move's head would have the gate hold the
 * move (two pull requests that have had one head), so only the pin watch's branches are at its commits.
 */
async function guardPinHead(
  repo: string,
  sha: string,
  pinHeads: ((repo: string) => Promise<readonly string[]>) | undefined,
  what: string,
): Promise<void> {
  if (!PIN_REPOS.includes(repo)) return;
  if (!pinHeads) throw new Error(`The door cannot read the pin watch's branches in ${repo}, so nothing is set there.`);
  if ((await pinHeads(repo)).includes(sha)) {
    throw new BranchRefused(`${sha.slice(0, 7)} is a pin branch's head: no worker that asks has ${what} at it.`);
  }
}

/**
 * Throws `BranchRefused` for a check run a worker asks to post or rename as the review gate's, in any repository, or,
 * in this one, as one GitHub requires on `main`: those are what a merge here waits for, and only their own workflows
 * and App post them. In the app's repository the line posts its own (`factory review`), and its required checks are not
 * read for it.
 */
async function guardCheckName(repo: string, name: string | undefined, reads?: Reads): Promise<void> {
  if (name === undefined) return;
  const asRead = name.trim().toLowerCase();
  if (asRead === REVIEW_CHECK) {
    throw new BranchRefused(`A check run named ${name} is the review gate's: no worker that asks posts one.`);
  }
  if (repo !== QUEUES_DEPLOYS_IN && !PIN_REPOS.includes(repo)) return;
  if (!reads) throw new Error(`The door reads nothing, so it cannot tell whether ${name} is a check main requires.`);
  const required = await reads.requiredChecks(repo, 'main');
  if (required.some((r) => r.trim().toLowerCase() === asRead)) {
    throw new BranchRefused(`A check run named ${name} is one main requires: no worker that asks posts one.`);
  }
}

/** Each action's call, from its checked arguments. */
const CALLS: { [K in Name]: (actions: Actions, repo: string, args: z.infer<(typeof ARGS)[K]>) => Promise<unknown> } = {
  setBranch: (x, repo, { branch, sha, force }) => x.setBranch(repo, branch, sha, force === undefined ? {} : { force }),
  deleteBranch: (x, repo, { branch }) => x.deleteBranch(repo, branch),
  commit: (x, repo, { changes, ...commit }) =>
    x.commit(repo, {
      ...commit,
      changes: {
        additions: changes.additions.map((f) => ({ path: f.path, contents: Buffer.from(f.contents, 'base64') })),
        deletions: changes.deletions,
      },
    }),
  applyPatch: (x, repo, patch) => x.applyPatch(repo, patch),
  openPullRequest: async (x, repo, draft) => {
    guardPinPull(draft);
    return x.openPullRequest(repo, defined(draft));
  },
  updatePullRequest: (x, repo, { number, ...change }) => x.updatePullRequest(repo, number, defined(change)),
  describeDeploy: (x, repo, { number, ...deploy }) => x.describeDeploy(repo, number, defined(deploy)),
  addLabels: async (x, repo, { number, labels }) => {
    guardPinPull({ labels });
    return x.addLabels(repo, number, labels);
  },
  readyForReview: (x, repo, { pullRequest }) => x.readyForReview(repo, pullRequest),
  convertToDraft: (x, repo, { pullRequest }) => x.convertToDraft(repo, pullRequest),
  review: (x, repo, { number, ...review }) => x.review(repo, number, review),
  resolveThreads: (x, repo, { number, threads }) => x.resolveThreads(repo, number, threads),
  createCheckRun: (x, repo, report) => x.createCheckRun(repo, defined(report)),
  updateCheckRun: (x, repo, { id, ...report }) => x.updateCheckRun(repo, id, defined(report)),
  openIssue: async (x, repo, issue) => {
    guardPinPull(issue);
    return x.openIssue(repo, defined(issue));
  },
  closeIssue: (x, repo, { number, reason, comment }) => x.closeIssue(repo, number, reason, comment),
  reopenIssue: (x, repo, { number, comment }) => x.reopenIssue(repo, number, comment),
  closePullRequest: (x, repo, { number, comment }) => x.closePullRequest(repo, number, comment),
  comment: (x, repo, { number, body }) => x.comment(repo, number, body),
  enqueuePullRequest: (x, repo, { number, expectedHead }) => x.enqueuePullRequest(repo, number, expectedHead),
};

/** Each read's arguments after the repository. */
const READS = {
  pullRequest: z.strictObject({ number }),
  checkRuns: z.strictObject({ sha }),
  requiredChecks: z.strictObject({ branch }),
  head: z.strictObject({ branch }),
  pullRequestFrom: z.strictObject({ branch }),
  protectedPaths: z.strictObject({ ref: sha }),
  file: z.strictObject({ ref: sha, path }),
  comparison: z.strictObject({ base: branch, head: sha }),
  checkout: z.strictObject({ sha }),
  commits: z.strictObject({ base: sha, head: sha }),
  imageRevision: z.strictObject({ image, digest }),
  imageSigned: z.strictObject({ image, digest }),
  deployProposal: z.strictObject({ branch }),
  deployBuild: z.strictObject({ branch }),
  reviewVerdict: z.strictObject({ number }),
  mergeQueue: z.strictObject({ number }),
  mergeability: z.strictObject({ number }),
  moves: z.strictObject({}),
  dependencyPulls: z.strictObject({}),
} satisfies Record<keyof Reads, z.ZodType>;

type ReadName = keyof typeof READS;

/** The reads the dependency sense's door serves (`factory patching`): the scan's moves and Dependabot's pull requests. */
export const PATCHING_READS: readonly ReadName[] = ['moves', 'dependencyPulls'];

/** The reads a worker may ask for, each with its arguments after the repository, and what it gives back. */
export type { ReadName };
export type ReadArgs = { [K in ReadName]: z.input<(typeof READS)[K]> };
export type ReadResult<K extends ReadName> = Awaited<ReturnType<Reads[K]>>;

const READ_CALLS: {
  [K in ReadName]: (reads: Reads, repo: string, args: z.infer<(typeof READS)[K]>) => Promise<unknown>;
} = {
  pullRequest: (r, repo, { number }) => r.pullRequest(repo, number),
  checkRuns: (r, repo, { sha }) => r.checkRuns(repo, sha),
  requiredChecks: (r, repo, { branch }) => r.requiredChecks(repo, branch),
  head: (r, repo, { branch }) => r.head(repo, branch),
  pullRequestFrom: (r, repo, { branch }) => r.pullRequestFrom(repo, branch),
  protectedPaths: (r, repo, { ref }) => r.protectedPaths(repo, ref),
  file: (r, repo, { ref, path }) => r.file(repo, ref, path),
  comparison: (r, repo, { base, head }) => r.comparison(repo, base, head),
  checkout: (r, repo, { sha }) => r.checkout(repo, sha),
  commits: (r, repo, { base, head }) => r.commits(repo, base, head),
  imageRevision: (r, repo, { image, digest }) => r.imageRevision(repo, image, digest),
  imageSigned: (r, repo, { image, digest }) => r.imageSigned(repo, image, digest),
  deployProposal: (r, repo, { branch }) => r.deployProposal(repo, branch),
  deployBuild: (r, repo, { branch }) => r.deployBuild(repo, branch),
  reviewVerdict: (r, repo, { number }) => r.reviewVerdict(repo, number),
  mergeQueue: (r, repo, { number }) => r.mergeQueue(repo, number),
  mergeability: (r, repo, { number }) => r.mergeability(repo, number),
  moves: (r, repo) => r.moves(repo),
  dependencyPulls: (r, repo) => r.dependencyPulls(repo),
};

/** An object without its undefined fields, as the actions' optional fields expect: absent, never undefined. */
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;
}

class TooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new TooLarge();
  return Buffer.concat(chunks).toString('utf-8');
}

const STATUS: Record<GitHubError['kind'], number> = {
  refused: 403,
  'not-found': 404,
  conflict: 409,
  'rate-limited': 429,
  server: 502,
  network: 502,
  'read-only': 503,
  malformed: 502,
  'read-again': 409,
};

export interface WorkerServerOptions {
  /** What it acts with; a door with `only` takes none, and acts with none. */
  actions?: Actions | undefined;
  /** What the other workers may read; without it, every read is not found. */
  reads?: Reads | undefined;
  /** What a request asking for a dry run (`x-factory-dry-run: true`) gets: one memory of what it would have done. */
  dryRun?: Actions | undefined;
  /** What a read asking for a dry run gets: what that memory would have made, as it would read. */
  dryRunReads?: Reads | undefined;
  /** The repositories the worker acts on, as `owner/name`. */
  repositories: readonly string[];
  /** What the worker says about itself at `/health`. */
  health: () => Record<string, unknown>;
  /**
   * The only reads a door serves, and no action: the dependency sense's door (`PATCHING_READS`), on a port of its own
   * that a NetworkPolicy opens to the sense alone, so the sense reaches the worker's reads and cannot act in GitHub.
   */
  only?: readonly ReadName[] | undefined;
  /** What keeps, logs and signs each refusal, for the answer to carry; without it, a refusal is answered as it is. */
  recorder?: RefusalRecorder | undefined;
  /**
   * The commits the pin watch's branches point at in a repository (`pinHeadsOf`): a branch a worker asks to set in one
   * of `PIN_REPOS` is refused at any of them. Without it, such a branch is refused in those repositories.
   */
  pinHeads?: ((repo: string) => Promise<readonly string[]>) | undefined;
  log: Logger;
}

/** In a few words, what an action asked, for its refusal: the action, and the branch or number it named. */
function asked(name: Name, repo: string, args: Record<string, unknown>): string {
  const number = numberOf(args);
  const branch = [args.branch, args.head].find((b) => typeof b === 'string');
  const on = [number !== null ? `#${number}` : undefined, branch && `branch ${branch}`].filter(Boolean);
  return `${name}${on.length ? ` ${on.join(' ')}` : ''} in ${repo}`;
}

/** The issue or pull request an action named, if any. */
function numberOf(args: Record<string, unknown>): number | null {
  const pullRequest = args.pullRequest as { number?: unknown } | undefined;
  const number = typeof args.number === 'number' ? args.number : pullRequest?.number;
  return typeof number === 'number' ? number : null;
}

/**
 * A refusal to keep, from what an action threw: its guard's (a protected path, a branch, a deploy) or GitHub's 403. An
 * issue the guard refused was kept by the guard. Anything else is a failure, not a refusal.
 */
export function refusalOf(
  error: unknown,
  name: Name,
  repo: string,
  args: Record<string, unknown>,
): GitHubRefusal | undefined {
  const about = { repo, number: numberOf(args), action: asked(name, repo, args) };
  if (error instanceof PatchRefused && error.kind === 'protected') {
    return { ...about, mechanism: 'github-guard', cause: 'protected', output: error.message };
  }
  if (error instanceof BranchRefused)
    return { ...about, mechanism: 'github-guard', cause: 'branch', output: error.message };
  if (error instanceof DeployRefused)
    return { ...about, mechanism: 'github-guard', cause: 'deploy', output: error.message };
  if (error instanceof GitHubError && error.kind === 'refused' && error.status === 403) {
    return { ...about, mechanism: 'token-permission', cause: 'forbidden', output: error.message };
  }
  return undefined;
}

export function createWorkerServer({
  actions: live,
  reads: liveReads,
  dryRun,
  dryRunReads,
  repositories,
  health,
  recorder,
  only,
  pinHeads,
  log,
}: WorkerServerOptions): Server {
  /** Each refusal kept for an action's failure, for its answer. */
  const refusals = new WeakMap<object, SignedRefusal>();

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /** Kept and signed; a refusal that cannot be kept is logged, and the action's own failure answered all the same. */
  const refusalWith = async (refusal: GitHubRefusal | undefined): Promise<SignedRefusal | undefined> => {
    if (!refusal || !recorder) return undefined;
    try {
      return await recorder.record(refusal);
    } catch (error) {
      log.error({ err: error, mechanism: refusal.mechanism, repo: refusal.repo }, 'could not keep a refusal');
      return undefined;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, on: ActingFor) => {
    const { pathname } = new URL(req.url ?? '/', 'http://github');
    if (pathname === '/health') return send(res, 200, { status: 'ok', ...health() });
    // A dry run when asked for, such as the smoke run's, even from a worker that acts.
    const dry = req.headers['x-factory-dry-run'] === 'true';
    const actions = dry && dryRun ? dryRun : live;
    const reads = dry && dryRunReads ? dryRunReads : liveReads;
    const [, kind, name = ''] = ROUTE.exec(pathname) ?? [];
    const known = only
      ? kind === 'reads' && reads && only.includes(name as ReadName)
      : kind === 'actions'
        ? actions !== undefined && Object.hasOwn(ARGS, name)
        : kind === 'reads' && reads && Object.hasOwn(READS, name);
    if (!known)
      return send(res, 404, { error: 'not-found', message: `No such ${kind === 'reads' ? 'read' : 'action'}.` });
    if (req.method !== 'POST') return send(res, 405, { error: 'bad-request', message: 'Use POST.' });
    if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, { error: 'bad-request', message: 'Send the body as application/json.' });
    }

    let input: unknown;
    try {
      input = JSON.parse(await readBody(req));
    } catch (error) {
      const message = error instanceof TooLarge ? `The body is over ${MAX_BODY_BYTES} bytes.` : 'The body is not JSON.';
      return send(res, error instanceof TooLarge ? 413 : 400, { error: 'bad-request', message });
    }
    const { repo, ...rest } = (input ?? {}) as { repo?: unknown };
    if (typeof repo !== 'string' || !repositories.includes(repo)) {
      return send(res, 400, { error: 'bad-request', message: `repo must be one of ${repositories.join(', ')}.` });
    }
    const parsed = (kind === 'reads' ? READS[name as ReadName] : ARGS[name as Name]).safeParse(rest);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`);
      return send(res, 400, { error: 'bad-request', message: problems.join('; ') });
    }
    if (kind === 'reads' && reads) {
      const read = READ_CALLS[name as ReadName] as (r: Reads, repo: string, args: unknown) => Promise<unknown>;
      return send(res, 200, { result: await read(reads, repo, parsed.data) });
    }
    // Only an action reaches here, and only on a server given actions (`known` above).
    if (!actions) return send(res, 404, { error: 'not-found', message: 'No such action.' });
    let result: unknown;
    try {
      guardDeployWatch(repo, parsed.data as Record<string, unknown>);
      await guardPinNumber(repo, parsed.data as Record<string, unknown>, reads);
      if (name === 'enqueuePullRequest') guardEnqueue(repo);
      if (name === 'setBranch') {
        const { branch, sha } = parsed.data as unknown as { branch: string; sha: string };
        // The branch's own refusal first, as the action gives it, before anything is read.
        guardWritable(branch);
        await guardPinHead(repo, sha, pinHeads, 'a branch is set');
      }
      if (name === 'createCheckRun' || name === 'updateCheckRun') {
        const { name: called, headSha } = parsed.data as unknown as { name?: string; headSha?: string };
        await guardCheckName(repo, called, reads);
        // A run at a pin move's head, named to look like a check it is not, would be shown beside the gate's.
        if (headSha !== undefined) await guardPinHead(repo, headSha, pinHeads, 'a check run is posted');
      }
      result = await (CALLS[name as Name] as (x: Actions, r: string, a: unknown) => Promise<unknown>)(
        actions,
        repo,
        parsed.data,
      );
    } catch (error) {
      const refused =
        error instanceof IssueRefused
          ? error.refusal
          : await refusalWith(refusalOf(error, name as Name, repo, parsed.data as Record<string, unknown>));
      if (refused && error !== null && typeof error === 'object') refusals.set(error, refused);
      throw error;
    }
    log.info({ action: name, repo, ...on, dryRun: actions.dryRun }, `github ${name}`);
    send(res, 200, { result: result ?? null, dryRun: actions.dryRun });
  };

  return createServer((req, res) => {
    const on = actingFor(req);
    // A failure's log says which action or read failed, and for which work item. Nothing here may throw: it runs
    // outside the catch below.
    const [, kind, name] = ROUTE.exec(URL.parse(req.url ?? '/', 'http://github')?.pathname ?? '') ?? [];
    const about = { ...(name ? { [kind === 'reads' ? 'read' : 'action']: name } : {}), ...on };
    handle(req, res, on).catch((error: unknown) => {
      if (res.headersSent) return void res.destroy();
      const kept = error !== null && typeof error === 'object' ? refusals.get(error) : undefined;
      const refusal = kept ? { refusal: kept } : {};
      if (error instanceof PatchRefused) {
        log.warn({ ...about, message: error.message }, 'a patch was refused');
        return send(res, 422, { error: 'patch-refused', message: error.message, ...refusal });
      }
      if (error instanceof BranchRefused) {
        log.warn({ ...about, message: error.message }, 'a branch was refused');
        return send(res, 422, { error: 'branch-refused', message: error.message, ...refusal });
      }
      if (error instanceof IssueRefused) {
        log.warn({ ...about, message: error.message, record: error.refusal?.record }, 'an issue action was refused');
        return send(res, 403, { error: 'issue-refused', message: error.message, ...refusal });
      }
      if (error instanceof DeployRefused) {
        log.warn({ ...about, message: error.message }, 'a deploy was refused');
        return send(res, 422, { error: 'deploy-refused', message: error.message, ...refusal });
      }
      if (error instanceof RegistryError) {
        log.warn({ ...about, status: error.status, message: error.message }, 'ghcr.io failed a read');
        return send(res, 502, { error: 'registry', message: error.message });
      }
      if (error instanceof GitHubError) {
        log.warn(
          { ...about, kind: error.kind, status: error.status, message: error.message },
          'github refused an action',
        );
        return send(res, STATUS[error.kind], { error: error.kind, message: error.message, ...refusal });
      }
      log.error({ ...about, err: error }, 'action failed');
      send(res, 500, { error: 'internal', message: 'The action failed; the worker logged why.' });
    });
  });
}
