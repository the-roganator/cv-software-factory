/**
 * Stand-ins for the line's collaborators beyond the store: the runners, which hand back what each test's agents say
 * and write their calls to `model_calls` as the gateway would; the GitHub worker, a repository in memory with pull
 * requests, check runs and issues; and the probes worker, as Verify asks it to run a check again.
 */
import type { Sql } from 'postgres';
import type { Found, Rule } from '../../../../policy/review-verdict.ts';
import type { Handback } from '../../../runner/src/step.ts';
import type { Contradicted } from '../../src/gates/contradicts.ts';
import { described } from '../../src/github/actions.ts';
import type { DeployProposal } from '../../src/github/deploys.ts';
import type { Annotation, CheckRun, Comparison, PullRequestState } from '../../src/github/reads.ts';
import type {
  ActingFor,
  ActionArgs,
  ActionName,
  ActionResult,
  ReadArgs,
  ReadName,
  ReadResult,
} from '../../src/github/server.ts';
import { GitHubWorkerError } from '../../src/github/worker-client.ts';
import type { ProbesPort } from '../../src/line/verify.ts';
import type { GitHubPort, Steps } from '../../src/line/worker.ts';
import type { VerifyAnswer, VerifyRequest } from '../../src/probes/verify.ts';
import { jobName } from '../../src/runners/jobs.ts';
import type { StepOutcome, StepRequest } from '../../src/runners/steps.ts';

export const MAIN = 'a'.repeat(40);

/** What an agent does with a step: hands something back, fails, or works until the line stops it. */
export type Agent = (
  request: StepRequest,
) => Handback | 'fails' | 'works on' | Promise<Handback | 'fails' | 'works on'>;

export class FakeSteps implements Steps {
  readonly requests: StepRequest[] = [];
  readonly finished: string[] = [];
  /** How many times deleting a work item's volume fails before it works. */
  finishFails = 0;
  readonly #agents: Partial<Record<string, Agent>>;
  readonly #sql: Sql;
  #working: (() => void)[] = [];

  /** `sql` records each step's model calls, as the gateway does, so it is the gateway's. */
  constructor(sql: Sql, agents: Partial<Record<string, Agent>>) {
    this.#sql = sql;
    this.#agents = agents;
  }

  async run(request: StepRequest): Promise<StepOutcome> {
    const job = jobName(request.agent, request.workItem, request.round, request.attempt);
    // As the runners do: a step stopped before it starts never reaches its agent.
    if (request.signal?.aborted) return { kind: 'stopped', job };
    this.requests.push(request);
    const agent = this.#agents[request.agent];
    if (!agent) throw new Error(`No fake ${request.agent}`);
    const answer = await agent(request);
    if (answer === 'works on') {
      let stop = () => {};
      await new Promise<void>((resolve) => {
        stop = resolve;
        this.#working.push(resolve);
        request.signal?.addEventListener('abort', () => resolve());
      });
      this.#working = this.#working.filter((other) => other !== stop);
      return { kind: 'stopped', job };
    }
    // Two calls a model answered and one whose stream broke off part way, which are counted; one the gateway refused
    // and one the provider refused, with no tokens, which are not.
    for (const [outcome, tokens, cost] of [
      ['answered', [100, 20, 50, 10], 0.01],
      ['answered', [100, 20, 50, 10], 0.01],
      ['failed', [100, 20, 50, 10], 0.01],
      ['refused', [0, 0, 0, 0], 0],
      ['failed', [0, 0, 0, 0], 0],
    ] as const) {
      const [input, output, cacheRead, cacheWrite] = tokens;
      await this.#sql`
        insert into model_calls (id, agent, work_item, provider, model, question_set, input_tokens, output_tokens,
                                 cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, outcome, job)
        values (${crypto.randomUUID()}, ${request.agent}, ${request.workItem}, 'local', 'qwen/qwen3.8-27b', 'messages',
                ${input}, ${output}, ${cacheRead}, ${cacheWrite}, ${cost}, 1000, ${outcome}, ${job})`;
    }
    if (answer === 'fails')
      return { kind: 'failed', job, reason: 'The agent pod failed without handing anything back.' };
    return { kind: 'handed-back', job, handback: answer };
  }

  async finish(workItem: string): Promise<void> {
    if (this.finishFails-- > 0) throw new Error('The volume could not be deleted.');
    this.finished.push(workItem);
  }

  async cancel(): Promise<void> {
    for (const stop of this.#working) stop();
    this.#working = [];
  }

  get working(): number {
    return this.#working.length;
  }
}

/** The app's repository in memory, as the GitHub worker would read and change it. */
export class FakeGitHub implements GitHubPort {
  readonly acts: { action: string; args: Record<string, unknown> }[] = [];
  /** What each of `acts` was said to be for, in the same order. */
  readonly actingFor: (ActingFor | undefined)[] = [];
  /** Actions that fail, as GitHub failing does, and how many times each will. */
  readonly failing = new Map<ActionName, number>();
  /** Actions GitHub refuses once, with the GitHub worker's own error. */
  readonly refusing = new Map<ActionName, Error>();
  /** Reads that fail, as GitHub failing does, and how many times each will. */
  readonly failingReads = new Map<ReadName, number>();
  /** An action that is done, and then fails as though the line crashed before it heard back: once. */
  crashAfter: ActionName | undefined;
  /** A read that waits until the test lets it go. */
  holdReads: Promise<void> | undefined;
  readonly pulls = new Map<number, PullRequestState>();
  readonly checks = new Map<string, CheckRun[]>();
  required = ['test'];
  /** What the app's CODEOWNERS gives Martin, beside the workflows and the deployment. */
  protectedPaths = ['.github/', 'deploy/', 'Dockerfile', '**/AGENTS.md'];
  /**
   * The files the pull request changes since main, as GitHub compares them: every file a patch has changed, with the
   * hunks of each patch that changed it. GitHub's comparison is one diff from the merge base, whose hunks would merge
   * and renumber those of an earlier round; here each round's hunks keep their own lines, so a line any round showed
   * stays one a finding can be anchored to, as it is on GitHub unless a later round removed it.
   */
  diff: Comparison['files'] = [];
  /** The app's files at every commit, by path, as a read of one finds them: a test file the spec names, say. */
  readonly files = new Map<string, string>();
  /** Each pull request's description, as the worker would have published it, with its section. */
  readonly bodies = new Map<number, string>();
  /** The app's open deploy pull request, as the deploy watch has it, and the commits it runs since the pinned one. */
  deploy: DeployProposal | null = null;
  deployCommits: string[] = [];
  /** Each of the app's images' commits, by digest, as its revision label names it. */
  readonly revisions = new Map<string, string>();
  /** The app's images whose signature does not verify, by digest. */
  readonly unsigned = new Set<string>();
  /**
   * The app's main, oldest first. When it is set, `commits` compares two of its commits as GitHub does, and a commit
   * not in it is one GitHub never had (404); when not, `commits` answers `deployCommits`.
   */
  history: string[] | undefined;
  /**
   * The review gate's verdict on each pull request's head, as the review App's check posts it: by default `low-risk`,
   * concluded; `pending` while it runs, and `none` for no check at all. A held one carries `refusal`, as the GitHub
   * worker signs it, and `pending` when the gate held it only to wait for test integrity; `completedAt` is when its check
   * concluded.
   */
  gate: { rule: Rule; tags?: Found[]; refusal?: unknown; pending?: string; completedAt?: string } | 'pending' | 'none' =
    { rule: 'low-risk' };
  /** Whether each pull request conflicts with main, as GitHub says. */
  conflicts: boolean | null = false;
  /** The pull requests in the merge queue, and the last taken out of it, with why. */
  readonly queued = new Set<number>();
  readonly dequeued = new Map<number, { reason: string; failed: string[]; at: string }>();
  #commits = 0;

  /** The merge queue taking a pull request out without merging it, with GitHub's reason and the checks that failed. */
  dequeue(number: number, reason: string, failed: string[] = []): void {
    this.queued.delete(number);
    this.dequeued.set(number, { reason, failed, at: new Date().toISOString() });
  }

  async act<K extends ActionName>(
    action: K,
    _repo: string,
    given: ActionArgs[K],
    on?: ActingFor,
  ): Promise<ActionResult<K>> {
    const args = given as Record<string, unknown>;
    const refusal = this.refusing.get(action);
    if (refusal) {
      this.refusing.delete(action);
      throw refusal;
    }
    const failures = this.failing.get(action) ?? 0;
    if (failures > 0) {
      this.failing.set(action, failures - 1);
      throw new Error(`GitHub failed: ${action} (502)`);
    }
    this.acts.push({ action, args });
    this.actingFor.push(on);
    const result = this.#act(action, args) as ActionResult<K>;
    if (this.crashAfter === action) {
      this.crashAfter = undefined;
      throw new Error('The line crashed');
    }
    return result;
  }

  #act(action: ActionName, args: Record<string, unknown>): unknown {
    switch (action) {
      case 'openIssue':
        return 41;
      case 'describeDeploy':
        return true;
      case 'applyPatch': {
        const sha = String(++this.#commits).padStart(40, 'f');
        for (const pr of this.pulls.values()) if (pr.head.ref === args.branch) pr.head.sha = sha;
        this.lastCommit = sha;
        for (const file of String(args.patch)
          .split(/^diff --git a\/\S+ b\//m)
          .slice(1)) {
          const path = file.slice(0, file.indexOf('\n'));
          const patch = file.slice(file.indexOf('@@'));
          const lines = patch.split('\n');
          const added = lines.filter((l) => l.startsWith('+')).length;
          const removed = lines.filter((l) => l.startsWith('-')).length;
          const before = this.diff.find((f) => f.path === path);
          if (before)
            Object.assign(before, {
              patch: `${before.patch ?? ''}\n${patch}`,
              added: before.added + added,
              removed: before.removed + removed,
            });
          else this.diff.push({ path, patch, added, removed });
        }
        return sha;
      }
      case 'openPullRequest': {
        const number = 12;
        this.bodies.set(number, described(String(args.body), args.contradicts as Contradicted[] | undefined));
        this.pulls.set(number, {
          number,
          state: 'open',
          merged: false,
          mergeCommit: null,
          mergedBy: null,
          head: { ref: String(args.head), sha: this.lastCommit },
          base: { ref: String(args.base), sha: MAIN },
          draft: Boolean(args.draft),
          nodeId: 'PR_12',
        });
        return { number, url: 'https://github.test/pull/12', nodeId: 'PR_12' };
      }
      case 'readyForReview':
      case 'convertToDraft': {
        const pr = this.pulls.get(Number((args.pullRequest as { number: number }).number));
        if (pr) pr.draft = action === 'convertToDraft';
        return undefined;
      }
      case 'enqueuePullRequest': {
        const pr = this.pulls.get(Number(args.number));
        if (pr?.state !== 'open' || pr.head.sha !== args.expectedHead) {
          this.acts.pop();
          throw new GitHubWorkerError(409, 'conflict', `Pull request #${args.number} is not at ${args.expectedHead}`);
        }
        this.queued.add(pr.number);
        this.dequeued.delete(pr.number);
        return { position: 1, state: 'QUEUED' };
      }
      case 'closePullRequest': {
        const pr = this.pulls.get(Number(args.number));
        if (pr?.state === 'open') pr.state = 'closed';
        return undefined;
      }
      case 'updatePullRequest': {
        const number = Number(args.number);
        const body = args.body === undefined ? this.bodies.get(number) : String(args.body);
        const contradicts = args.contradicts as Contradicted[] | undefined;
        if (body !== undefined) this.bodies.set(number, described(body, contradicts));
        return undefined;
      }
      default:
        return undefined;
    }
  }

  lastCommit = MAIN;

  async read<K extends ReadName>(read: K, _repo: string, given: ReadArgs[K]): Promise<ReadResult<K>> {
    await this.holdReads;
    const failures = this.failingReads.get(read) ?? 0;
    if (failures > 0) {
      this.failingReads.set(read, failures - 1);
      throw new Error(`GitHub failed: ${read} (502)`);
    }
    const args = given as Record<string, unknown>;
    const answer = (value: unknown) => value as ReadResult<K>;
    switch (read) {
      case 'head':
        return answer(MAIN);
      case 'requiredChecks':
        return answer(this.required);
      case 'protectedPaths':
        return answer(this.protectedPaths);
      case 'file': {
        const text = this.files.get(String(args.path));
        return answer(text === undefined ? { found: false } : { found: true, text });
      }
      case 'comparison':
        return answer({ mergeBase: MAIN, files: this.diff });
      case 'checkRuns':
        return answer(this.checks.get(String(args.sha)) ?? []);
      case 'pullRequest': {
        const pr = this.pulls.get(Number(args.number));
        if (!pr) throw new Error(`No pull request #${args.number}`);
        return answer(structuredClone(pr));
      }
      case 'checkout':
        return answer({ commit: args.sha, commits: [] });
      case 'deployProposal':
        return answer(structuredClone(this.deploy));
      case 'commits': {
        if (this.history) {
          const [from, to] = [this.history.indexOf(String(args.base)), this.history.indexOf(String(args.head))];
          if (from < 0 || to < 0) throw new GitHubWorkerError(404, 'not-found', 'No commit found');
          const commits = this.history.slice(from + 1, to + 1);
          const status = from === to ? 'identical' : from < to ? 'ahead' : 'behind';
          return answer({ status, total: commits.length, commits });
        }
        const at = this.deployCommits;
        return answer({ status: 'ahead', total: at.length, commits: [...at] });
      }
      case 'imageRevision':
        return answer(this.revisions.get(String(args.digest)) ?? null);
      case 'imageSigned':
        return answer(
          this.unsigned.has(String(args.digest))
            ? { signed: false, reason: 'no signature by the pipeline' }
            : { signed: true, reason: null },
        );
      case 'reviewVerdict': {
        const pr = this.pulls.get(Number(args.number));
        if (!pr) throw new Error(`No pull request #${args.number}`);
        const head = pr.head.sha;
        const gate = this.gate;
        if (gate === 'none') {
          return answer({ number: pr.number, head, check: null, verdict: null, judged: null, problem: 'none' });
        }
        const done = gate !== 'pending';
        const held = done && gate.rule === 'held';
        const check = {
          id: 900,
          status: done ? 'completed' : 'in_progress',
          conclusion: done ? (held ? 'failure' : 'success') : null,
          title: done ? (held ? `#${pr.number}: held for its risk tags` : 'Low-risk') : null,
          summary: null,
          completedAt: done ? (gate.completedAt ?? '2026-10-05T10:02:00Z') : null,
          url: 'https://github.test/runs/900',
        };
        if (!done) return answer({ number: pr.number, head, check, verdict: null, judged: null, problem: 'running' });
        const judged = {
          number: pr.number,
          head,
          rule: gate.rule,
          tags: gate.tags ?? [],
          ...(gate.pending ? { pending: gate.pending } : {}),
        };
        return answer({
          number: pr.number,
          head,
          check,
          verdict: { version: 1, commit: head, judged: [judged] },
          judged,
          problem: null,
          ...(held && gate.refusal ? { refusal: gate.refusal } : {}),
        });
      }
      case 'mergeability': {
        const pr = this.pulls.get(Number(args.number));
        if (!pr) throw new Error(`No pull request #${args.number}`);
        return answer({ number: pr.number, head: pr.head.sha, conflicts: this.conflicts, state: 'blocked' });
      }
      case 'mergeQueue': {
        const pr = this.pulls.get(Number(args.number));
        if (!pr) throw new Error(`No pull request #${args.number}`);
        const out = this.dequeued.get(pr.number);
        const queued = this.queued.has(pr.number);
        return answer({
          number: pr.number,
          head: pr.head.sha,
          state: pr.merged ? 'merged' : pr.state,
          queued: queued ? { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '', commit: null } : null,
          added: queued || out ? { at: new Date().toISOString(), by: 'mrogan-software-factory[bot]' } : null,
          removed: out ? { at: out.at, by: 'github-merge-queue', reason: out.reason, commit: 'd'.repeat(40) } : null,
          checks: (out?.failed ?? []).map((name, i) => ({
            id: 800 + i,
            name,
            status: 'completed',
            conclusion: 'failure',
            app: 'github-actions',
            startedAt: null,
            completedAt: null,
            title: null,
          })),
        });
      }
      case 'pullRequestFrom': {
        const pr = [...this.pulls.values()].find((p) => p.head.ref === args.branch && p.state === 'open');
        return answer(pr ? structuredClone(pr) : null);
      }
    }
    throw new Error(`No fake read ${read}`);
  }

  /** The required check finishing on the pull request's head; one that fails says what was wrong, as the worker reads it. */
  pass(number = 12, conclusion = 'success', annotations?: Annotation[]): void {
    const pr = this.pulls.get(number);
    if (!pr) throw new Error(`No pull request #${number}`);
    this.checks.set(pr.head.sha, [
      {
        id: this.checks.size + 1,
        name: 'test',
        status: 'completed',
        conclusion,
        app: 'github-actions',
        startedAt: '2026-10-05T10:00:00Z',
        completedAt: '2026-10-05T10:01:00Z',
        title: null,
        ...(annotations ? { annotations } : {}),
      },
    ]);
  }

  merge(number = 12): void {
    const pr = this.pulls.get(number);
    if (!pr) throw new Error(`No pull request #${number}`);
    Object.assign(pr, { state: 'closed', merged: true, mergeCommit: 'c'.repeat(40), mergedBy: 'mrogan' });
  }
}

/** The probes worker, answering each verification as the test says, in turn, and counting what it was asked. */
export class FakeProbes implements ProbesPort {
  readonly asked: VerifyRequest[] = [];
  /** What it answers, in turn; the last again once the rest are given. */
  readonly answers: (VerifyAnswer | Error)[];

  constructor(...answers: (VerifyAnswer | Error)[]) {
    this.answers = answers;
  }

  async verify(request: VerifyRequest): Promise<VerifyAnswer> {
    this.asked.push(request);
    const answer = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    if (!answer) throw new Error('No fake answer');
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
