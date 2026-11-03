/**
 * What the other workers may read from GitHub through the worker: a pull request's state, the check runs on a commit
 * (with what each that failed said was wrong), the checks a branch's ruleset requires, a branch's head, the paths no
 * patch may change at a commit, a file at a commit, and how a commit compares with a branch. The line reads them to
 * see its pull requests through their gates and to Martin's merge, and appends what it sees as events; holds a spec's
 * scope to the protected paths, and the tests it says it contradicts to those their files have; and gives the
 * reviewer the base its change is measured from, and anchors its findings to lines the change shows. The worker
 * itself touches no store.
 *
 * After the merge, the line reads what a release is made of through the worker too, since only it reaches GitHub and
 * GHCR: the commits between two commits, and whether one is an ancestor of the other; the commit an image was built
 * from, and whether its pipeline signed it; and the open deploy pull request, as the deploy watch last saw it.
 *
 * Every read is a conditional request, so asking again about something that has not changed costs nothing against
 * the rate limit, and every answer is read through a Zod schema. Reading is harmless, so a dry run reads as a live
 * worker does; and a worker with no key reads the public repositories as anyone may.
 */
import { z } from 'zod';
import { type GitHub, GitHubError } from './client.ts';
import { type DeployProposal, type DeployProposals, deployedImage } from './deploys.ts';
import { CODEOWNERS_PATHS, protectedFrom } from './paths.ts';
import type { Registry } from './registry.ts';
import { pipeline, type Signatures, UnsignedError } from './signatures.ts';

export interface PullRequestState {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  /** The squash commit on the base, once merged. */
  mergeCommit: string | null;
  /** Who merged it, by login. */
  mergedBy: string | null;
  head: { ref: string; sha: string };
  /** The branch it merges into, and that branch's commit its diff is taken against. */
  base: { ref: string; sha: string };
  draft: boolean;
  /** GraphQL's id, which readying a draft needs. */
  nodeId: string;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** The app that reported it, such as `github-actions` or the factory's own. */
  app: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The check's own one-line title, when it gave one. */
  title: string | null;
  /**
   * What a run that failed said was wrong (`failedAnnotations`): each of its annotations at the failure level, with
   * the file it named. Absent from a run that has not failed, and from one GitHub never read, such as a dry run's.
   */
  annotations?: Annotation[];
}

/** One of a check run's annotations: the file it is on, or `.github` for the run as a whole, and what it says. */
export interface Annotation {
  path: string;
  message: string;
}

/**
 * Where a step that starts from a commit checks it out: the commit itself, or, for a commit a dry run made, the real
 * commit under it and the dry run's commits, each a patch and its message, oldest first.
 */
export interface Checkout {
  commit: string;
  commits: { message: string; patch: string }[];
}

/** A commit compared with a branch, as a pull request's diff is taken. */
export interface Comparison {
  /** Where the commit's history left the branch's: what the change is measured from. */
  mergeBase: string;
  /**
   * Each file the commit changes since then, with its patch as GitHub shows it (none for a binary file, or one too
   * large to show), and the lines it adds and removes, which GitHub counts even then: every one, up to the 300 GitHub
   * compares (`MAX_COMPARED_FILES`).
   */
  files: { path: string; patch: string | null; added: number; removed: number }[];
}

/** The commits one commit has that another has not, and how the two stand. */
export interface Commits {
  /**
   * `ahead` when the base is an ancestor of the head, `identical` when they are the same commit, `behind` when the
   * head is an ancestor of the base, and `diverged` when neither is.
   */
  status: 'ahead' | 'behind' | 'identical' | 'diverged';
  /** How many commits the head has that the base has not. */
  total: number;
  /** Those commits, oldest first: every one, up to `MAX_COMMITS`. */
  commits: string[];
}

/** Whether an image carries its pipeline's signature, and if not, why not. */
export interface Signed {
  signed: boolean;
  reason: string | null;
}

/**
 * A file at a commit, as the line checks a spec against it: not there (no such path, or a folder), there as text, or
 * there and not text the API sends whole (`text` null), such as a file over a megabyte.
 */
export type FileAt = { found: false } | { found: true; text: string | null };

/** The most files GitHub's comparison lists, which `comparison` reads every page of. */
export const MAX_COMPARED_FILES = 300;

/** The most commits `commits` lists: ten pages of GitHub's comparison. A deploy carries tens. */
export const MAX_COMMITS = 1000;

export interface Reads {
  pullRequest(repo: string, number: number): Promise<PullRequestState>;
  checkRuns(repo: string, sha: string): Promise<CheckRun[]>;
  /** The status checks a branch's rulesets require, by name. */
  requiredChecks(repo: string, branch: string): Promise<string[]>;
  /** The commit a branch points at. */
  head(repo: string, branch: string): Promise<string>;
  /** The open pull request from one of the repository's branches, if there is one. */
  pullRequestFrom(repo: string, branch: string): Promise<PullRequestState | null>;
  /**
   * The paths no patch may change at a commit, as scope entries: the workflows, the deployment, and what the
   * repository's CODEOWNERS gives a person (`paths.ts`, as the worker's guard reads them).
   */
  protectedPaths(repo: string, ref: string): Promise<string[]>;
  /** A file at a commit: the line reads a test file there to check the tests a spec names are in it. */
  file(repo: string, ref: string, path: string): Promise<FileAt>;
  /** How a commit compares with a branch: its merge base, and the files it changes since. */
  comparison(repo: string, base: string, head: string): Promise<Comparison>;
  /** Where a step checks a commit out from: GitHub has every commit but a dry run's. */
  checkout(repo: string, sha: string): Promise<Checkout>;
  /** The commits `head` has that `base` has not, and whether either is an ancestor of the other. */
  commits(repo: string, base: string, head: string): Promise<Commits>;
  /** The commit an image of the repository's deploys was built from, by its label; null when it has none. */
  imageRevision(repo: string, image: string, digest: string): Promise<string | null>;
  /** Whether an image of the repository's deploys carries the signature of `build.yml` on its main. */
  imageSigned(repo: string, image: string, digest: string): Promise<Signed>;
  /** The open deploy pull request from a deploy branch, as the deploy watch last saw or made it; null when none. */
  deployProposal(repo: string, branch: string): Promise<DeployProposal | null>;
}

const SHA = z.string().regex(/^[0-9a-f]{40}$/);

const PULL = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  merge_commit_sha: SHA.nullable(),
  // GitHub gives a deleted account as null.
  merged_by: z.object({ login: z.string() }).nullable(),
  head: z.object({ ref: z.string(), sha: SHA }),
  base: z.object({ ref: z.string(), sha: SHA }),
  draft: z.boolean().optional(),
  node_id: z.string().min(1),
});

const CHECK_RUNS = z.object({
  check_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      app: z.object({ slug: z.string().optional() }).nullable().optional(),
      started_at: z.string().nullable().optional(),
      completed_at: z.string().nullable().optional(),
      output: z.object({ title: z.string().nullable().optional() }).optional(),
    }),
  ),
});

const ANNOTATIONS = z.array(
  z.object({ path: z.string(), annotation_level: z.string().nullable().optional(), message: z.string().nullable() }),
);

/** The most annotations of a run read: the first page. A gate fails on a handful, and an event keeps ten. */
const ANNOTATIONS_PER_PAGE = 50;

/**
 * The line Actions adds to every job that fails, on the run as a whole: it says nothing of why, and is the same on
 * every failed job.
 */
const EXIT_CODE = /^Process completed with exit code \d+\.?$/;

/**
 * A check run's conclusion as the gates judge it: a success or a neutral passes, a skip is skipped, and anything else
 * (a failure, a timeout, a cancellation) fails. The one rule for it: the gates record it, and this worker reads what a
 * failed run said by it.
 */
export const outcomeOf = (conclusion: string | null): 'success' | 'failure' | 'skipped' =>
  conclusion === 'success' || conclusion === 'neutral' ? 'success' : conclusion === 'skipped' ? 'skipped' : 'failure';

/** The errors a read of what a run said waits out: the next read asks again. Any other gives the run no reasons. */
const PASSING: readonly string[] = ['rate-limited', 'server', 'network'];

const RULES = z.array(
  z.object({
    type: z.string(),
    parameters: z
      .object({ required_status_checks: z.array(z.object({ context: z.string() })).optional() })
      .loose()
      .optional(),
  }),
);

const REF = z.object({ object: z.object({ sha: SHA }) });

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** What the contents API answers for a path: a file, or a folder's listing. */
const CONTENTS = z.union([
  z.object({ type: z.string(), encoding: z.string().optional(), content: z.string().optional() }),
  z.array(z.unknown()),
]);

const pullRequestState = (pr: z.infer<typeof PULL>): PullRequestState => ({
  number: pr.number,
  state: pr.state,
  merged: pr.merged,
  mergeCommit: pr.merged ? pr.merge_commit_sha : null,
  mergedBy: pr.merged_by?.login ?? null,
  head: { ref: pr.head.ref, sha: pr.head.sha },
  base: { ref: pr.base.ref, sha: pr.base.sha },
  draft: pr.draft ?? false,
  nodeId: pr.node_id,
});

const COMPARE = z.object({
  merge_base_commit: z.object({ sha: SHA }),
  files: z
    .array(
      z.object({
        filename: z.string(),
        patch: z.string().optional(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

const COMPARE_COMMITS = z.object({
  status: z.enum(['ahead', 'behind', 'identical', 'diverged']),
  total_commits: z.number().int().nonnegative(),
  commits: z.array(z.object({ sha: SHA })),
});

/** What the release reads need beside GitHub, which only the GitHub worker has: GHCR, Sigstore, the deploy watch. */
export interface ReleaseSources {
  registry: Pick<Registry, 'revision'>;
  signatures: Pick<Signatures, 'verify'>;
  proposals: DeployProposals;
}

const segments = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

export class LiveReads implements Reads {
  readonly #github: GitHub;
  readonly #sources: ReleaseSources | undefined;

  /** Without `sources`, as in a test of the line's other reads, the release reads fail. */
  constructor(github: GitHub, sources?: ReleaseSources) {
    this.#github = github;
    this.#sources = sources;
  }

  async pullRequest(repo: string, number: number): Promise<PullRequestState> {
    const { body: pr } = await this.#github.poll(repo, `/repos/${repo}/pulls/${number}`, PULL);
    return pullRequestState(pr);
  }

  async pullRequestFrom(repo: string, branch: string): Promise<PullRequestState | null> {
    const head = `${repo.split('/')[0]}:${branch}`;
    const path = `/repos/${repo}/pulls?head=${encodeURIComponent(head)}&state=open&per_page=1`;
    const { body } = await this.#github.poll(repo, path, z.array(PULL));
    return body[0] ? pullRequestState(body[0]) : null;
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    // One page: a commit here has a dozen check runs, not a hundred.
    const { body } = await this.#github.poll(repo, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`, CHECK_RUNS);
    // What a run said is read only for the latest run of each name, as the gates take a check run again: an earlier
    // attempt's is never recorded.
    const latest = new Map<string, number>();
    for (const run of body.check_runs) latest.set(run.name, Math.max(run.id, latest.get(run.name) ?? run.id));
    return Promise.all(
      body.check_runs.map(async (run) => {
        const read: CheckRun = {
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          app: run.app?.slug ?? null,
          startedAt: run.started_at ?? null,
          completedAt: run.completed_at ?? null,
          title: run.output?.title ?? null,
        };
        const failed = run.status === 'completed' && outcomeOf(run.conclusion) === 'failure';
        return failed && latest.get(run.name) === run.id
          ? { ...read, annotations: await this.#failedAnnotations(repo, run.id) }
          : read;
      }),
    );
  }

  /**
   * A failed run's annotations at the failure level, less Actions' exit-code line: what the gate itself said was
   * wrong. A job's summary is not in its check run's output, so these are the only reasons GitHub keeps for a job.
   * One more conditional read for each run that failed, and none for the rest. The reasons are extras: a read that
   * GitHub refuses, or answers with nothing or something malformed, gives none, so the runs are still read and the
   * gates recorded. One that a rate limit or an outage stops fails the whole read, which the line asks again on its
   * next pass, so a passing failure does not record a gate without its reasons for good.
   */
  async #failedAnnotations(repo: string, id: number): Promise<Annotation[]> {
    try {
      const path = `/repos/${repo}/check-runs/${id}/annotations?per_page=${ANNOTATIONS_PER_PAGE}`;
      const { body } = await this.#github.poll(repo, path, ANNOTATIONS);
      return body.flatMap(({ path, annotation_level, message }) =>
        annotation_level === 'failure' && message?.trim() && !EXIT_CODE.test(message.trim()) ? [{ path, message }] : [],
      );
    } catch (error) {
      if (error instanceof GitHubError && PASSING.includes(error.kind)) throw error;
      return [];
    }
  }

  async requiredChecks(repo: string, branch: string): Promise<string[]> {
    const { body } = await this.#github.poll(repo, `/repos/${repo}/rules/branches/${segments(branch)}`, RULES);
    const names = body
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => rule.parameters?.required_status_checks?.map((check) => check.context) ?? []);
    return [...new Set(names)];
  }

  async head(repo: string, branch: string): Promise<string> {
    const { body } = await this.#github.poll(repo, `/repos/${repo}/git/ref/heads/${segments(branch)}`, REF);
    return body.object.sha;
  }

  async protectedPaths(repo: string, ref: string): Promise<string[]> {
    const files = await Promise.all(CODEOWNERS_PATHS.map((path) => this.#text(repo, path, ref)));
    return protectedFrom(files.find((text) => text !== null) ?? null);
  }

  async file(repo: string, ref: string, path: string): Promise<FileAt> {
    const url = `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`;
    try {
      const { body } = await this.#github.poll(repo, url, CONTENTS);
      if (Array.isArray(body) || body.type !== 'file') return { found: false };
      if (body.encoding !== 'base64' || body.content === undefined) return { found: true, text: null };
      try {
        return { found: true, text: UTF8.decode(Buffer.from(body.content, 'base64')) };
      } catch {
        return { found: true, text: null };
      }
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not-found') return { found: false };
      throw error;
    }
  }

  /** A text file at a commit, or null where there is none: no such path, a folder, or a file the API will not send. */
  async #text(repo: string, path: string, ref: string): Promise<string | null> {
    const url = `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`;
    try {
      const { body } = await this.#github.poll(repo, url, CONTENTS);
      if (Array.isArray(body) || body.type !== 'file' || body.encoding !== 'base64' || body.content === undefined)
        return null;
      return Buffer.from(body.content, 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not-found') return null;
      throw error;
    }
  }

  /** GitHub has the commit: nothing to read. */
  async checkout(_repo: string, sha: string): Promise<Checkout> {
    return { commit: sha, commits: [] };
  }

  async comparison(repo: string, base: string, head: string): Promise<Comparison> {
    // Every page of files, a hundred to a page, up to the most GitHub compares: a page short of a hundred is the last,
    // and one that adds none already listed ends it too, should GitHub give the same files on every page.
    let mergeBase: string | undefined;
    const files = new Map<string, Comparison['files'][number]>();
    for (let page = 1; page <= MAX_COMPARED_FILES / 100; page++) {
      const { body } = await this.#github.poll(
        repo,
        `/repos/${repo}/compare/${segments(base)}...${head}?per_page=100&page=${page}`,
        COMPARE,
      );
      mergeBase ??= body.merge_base_commit.sha;
      const listed = body.files ?? [];
      const before = files.size;
      for (const file of listed) {
        if (files.has(file.filename)) continue;
        files.set(file.filename, {
          path: file.filename,
          patch: file.patch ?? null,
          added: file.additions,
          removed: file.deletions,
        });
      }
      if (listed.length < 100 || files.size === before) break;
    }
    return { mergeBase: mergeBase as string, files: [...files.values()] };
  }

  async commits(repo: string, base: string, head: string): Promise<Commits> {
    const commits: string[] = [];
    let status: Commits['status'] = 'identical';
    let total = 0;
    for (let page = 1; page <= MAX_COMMITS / 100; page++) {
      const { body } = await this.#github.poll(
        repo,
        `/repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}`,
        COMPARE_COMMITS,
      );
      ({ status, total_commits: total } = body);
      commits.push(...body.commits.map((c) => c.sha));
      if (!body.commits.length || commits.length >= total) break;
    }
    return { status, total, commits };
  }

  async imageRevision(repo: string, image: string, digest: string): Promise<string | null> {
    return (await this.#release().registry.revision(deployedImage(repo, image), digest)) ?? null;
  }

  async imageSigned(repo: string, image: string, digest: string): Promise<Signed> {
    try {
      await this.#release().signatures.verify(deployedImage(repo, image), digest, pipeline(repo));
      return { signed: true, reason: null };
    } catch (error) {
      if (error instanceof UnsignedError) return { signed: false, reason: error.message };
      throw error;
    }
  }

  async deployProposal(repo: string, branch: string): Promise<DeployProposal | null> {
    return this.#release().proposals.get(repo, branch);
  }

  #release(): ReleaseSources {
    if (!this.#sources) throw new Error('This worker reads no images and watches no deploys.');
    return this.#sources;
  }
}
