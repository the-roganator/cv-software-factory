/**
 * The worker adds Dependabot's bump of the commit the app calls the factory's workflows at to the merge queue
 * (`workflowPinQueueWatch`), through the watch itself: a fake GitHub for the open pull requests and the review App's
 * check on each head, fake reads for the checks and the queue, and either fake actions for the enqueue or the live
 * ones behind the worker's guard. Each condition is tested alone against one that passes.
 */
import type { Autonomy } from '@software-factory/events';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { type Judged, verdictBlock } from '../../../../policy/review-verdict.ts';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { GitHubError } from '../../src/github/client.ts';
import {
  MAX_TRIES,
  QUEUE_TRIES,
  type QueuePull,
  THEIRS,
  WORKFLOW_PIN_REPOS,
  type WorkflowPinQueueDependencies,
  workflowPinPullWait,
  workflowPinQueueWatch,
} from '../../src/github/deploy-queue.ts';
import { APP_USER, DEPENDABOT_USER, IssueGuard, MARTIN } from '../../src/github/issues.ts';
import type { LevelReader } from '../../src/github/level.ts';
import { type MergeQueue, REVIEW_APP } from '../../src/github/merging.ts';
import type { CheckRun } from '../../src/github/reads.ts';
import { APP_REPOSITORY, FACTORY_REPOSITORY } from '../../src/repositories.ts';
import { calls, client, quiet, type Route, type Sent } from './fake.ts';

const REPO = APP_REPOSITORY;
const HEAD = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const BUMP = 'dependabot/github_actions/factory-0b5a7c9d1e';
const REQUIRED = ['check', 'gates / test integrity', 'pull request title', 'review'];

const pull = (over: Partial<QueuePull> = {}): QueuePull => ({
  number: 81,
  title: 'ci: bump the factory group with 6 updates',
  draft: false,
  user: { id: DEPENDABOT_USER },
  labels: [{ name: 'dependencies' }],
  head: { ref: BUMP, sha: HEAD, repo: { full_name: REPO } },
  base: { ref: 'main' },
  ...over,
});

let ids = 0;
const run = (name: string, conclusion: string | null = 'success', app = 'github-actions'): CheckRun => ({
  id: ++ids,
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  app,
  startedAt: null,
  completedAt: null,
  title: null,
});
const green = () => REQUIRED.filter((n) => n !== 'review').map((n) => run(n));

/** The review App's check on a head, as GitHub lists it, with the gate's verdict of one pull request in its summary. */
const review = (
  head: string,
  judged: Partial<Judged> = {},
  over: { app?: number; conclusion?: string; status?: string; number?: number } = {},
) => {
  const entry: Judged = { number: over.number ?? 81, head, rule: 'exact-pin', tags: [], ...judged };
  return {
    id: ++ids,
    name: 'review',
    head_sha: head,
    status: over.status ?? 'completed',
    conclusion: over.conclusion ?? (entry.rule === 'held' ? 'failure' : 'success'),
    app: { id: over.app ?? REVIEW_APP },
    output: { title: 't', summary: verdictBlock({ version: 1, commit: head, judged: [entry] }) },
  };
};

const queue = (over: Partial<MergeQueue> = {}): MergeQueue => ({
  number: 81,
  head: HEAD,
  state: 'open',
  queued: null,
  added: null,
  removed: null,
  checks: [],
  ...over,
});

const level =
  (autonomy: Autonomy = 'guarded', autoMerge = true): LevelReader =>
  async () => ({ autonomy, autoMerge });

/** A log whose lines a test reads: what the queue said of each wait. */
function capture() {
  const lines: { level: number; msg: string; waits?: string; why?: string }[] = [];
  return { lines, log: pino({ level: 'info' }, { write: (line: string) => void lines.push(JSON.parse(line)) }) };
}

/** A worker's workflow pin queue watch against the app's repository with these open pull requests. */
function harness(
  o: {
    pulls?: () => QueuePull[];
    reviews?: (head: string) => ReturnType<typeof review>[];
    runs?: () => CheckRun[];
    conflicts?: boolean | null;
    queued?: () => MergeQueue;
    enqueue?: (number: number, head: string) => Promise<{ position: number | null; state: string | null }>;
    actions?: WorkflowPinQueueDependencies['actions'];
    level?: LevelReader;
    log?: WorkflowPinQueueDependencies['log'];
    routes?: Route[];
    repo?: string;
  } = {},
) {
  const sent: Sent[] = [];
  const pulls = o.pulls ?? (() => [pull()]);
  const { github } = client(
    [
      ...(o.routes ?? []),
      {
        method: 'GET',
        path: /\/pulls\?state=open&per_page=100&sort=created&direction=asc&page=\d+$/,
        answer: ({ path }) => ({ body: path.endsWith('page=1') ? pulls() : [] }),
      },
      {
        method: 'GET',
        path: /\/commits\/[0-9a-f]{40}\/check-runs\?check_name=review&filter=all&per_page=100$/,
        answer: ({ path }) => {
          const head = /commits\/([0-9a-f]{40})/.exec(path)?.[1] ?? '';
          return { body: { check_runs: (o.reviews ?? ((at) => [review(at)]))(head) } };
        },
      },
    ],
    sent,
  );
  const enqueued: [number, string][] = [];
  let levels = 0;
  const actions = o.actions ?? {
    dryRun: false,
    enqueuePullRequest: async (_repo: string, number: number, head: string, asker?: string) => {
      // The watch says who asks, in every call: the guard adds Dependabot's pull request for it alone.
      expect(asker).toBe('workflow-pin-watch');
      enqueued.push([number, head]);
      return o.enqueue ? o.enqueue(number, head) : { position: 1, state: 'QUEUED' };
    },
  };
  const reads: WorkflowPinQueueDependencies['reads'] = {
    checkRuns: async () => (o.runs ?? green)(),
    requiredChecks: async () => REQUIRED,
    mergeability: async (_repo, number) => {
      const head = pulls().find((p) => p.number === number)?.head.sha ?? HEAD;
      const conflicts = o.conflicts === undefined ? false : o.conflicts;
      return { number, head, conflicts, state: conflicts ? 'dirty' : 'clean' };
    },
    mergeQueue: async () => (o.queued ?? (() => queue()))(),
  };
  const read = o.level ?? level();
  const pass = workflowPinQueueWatch(
    {
      github,
      reads,
      actions,
      level: async () => {
        levels++;
        return read();
      },
      log: o.log ?? quiet,
    },
    o.repo ?? REPO,
  );
  return { pass, enqueued, sent, levels: () => levels };
}

/** The requests that read a verdict: none is made for a pull request that is not one the watch queues. */
const verdictReads = (sent: Sent[]) => calls(sent).filter((s) => s.path.includes('/check-runs'));

describe('the workflow pin queue watch', () => {
  it('queues only in the app’s repository, which calls the factory’s workflows at a commit', () => {
    expect(WORKFLOW_PIN_REPOS).toEqual([REPO]);
    expect(() => harness({ repo: FACTORY_REPOSITORY })).toThrow(/does not queue/);
  });

  it('adds Dependabot’s bump to the queue at its head once the gate passed it as an exact pin and its checks are green', async () => {
    const said = capture();
    const { pass, enqueued } = harness({ log: said.log });
    await pass();
    expect(enqueued).toEqual([[81, HEAD]]);
    expect(said.lines.map((line) => line.msg)).toEqual(['added the workflow pin pull request to the merge queue']);
    // Once for each head: the next pass does not ask again.
    await pass();
    expect(enqueued).toHaveLength(1);
  });

  it('adds it through the worker’s guard, as the one write it makes: at the head the gate judged', async () => {
    const sent: Sent[] = [];
    const routes: Route[] = [
      {
        method: 'GET',
        path: `/repos/${REPO}/issues/81`,
        answer: () => ({ body: { user: { id: DEPENDABOT_USER }, pull_request: {} } }),
      },
      {
        method: 'GET',
        path: `/repos/${REPO}/pulls/81`,
        answer: () => ({
          body: {
            state: 'open',
            draft: false,
            node_id: 'PR_node_81',
            head: { ref: BUMP, sha: HEAD, repo: { full_name: REPO } },
            base: { ref: 'main' },
          },
        }),
      },
      {
        method: 'POST',
        path: '/graphql',
        answer: () => ({
          body: { data: { enqueuePullRequest: { mergeQueueEntry: { position: 1, state: 'QUEUED' } } } },
        }),
      },
    ];
    const { github } = client(routes, sent);
    const { pass } = harness({ actions: new LiveActions(github) });
    await pass();
    expect(calls(sent).filter((s) => s.method !== 'GET')).toMatchObject([
      { path: '/graphql', body: { variables: { input: { pullRequestId: 'PR_node_81', expectedHeadOid: HEAD } } } },
    ]);
  });

  it('queues a newer head afresh once the gate and its checks pass it', async () => {
    let head = HEAD;
    const { pass, enqueued } = harness({
      pulls: () => [pull({ head: { ...pull().head, sha: head } })],
      queued: () => queue({ head }),
    });
    await pass();
    head = NEWER;
    await pass();
    expect(enqueued).toEqual([
      [81, HEAD],
      [81, NEWER],
    ]);
  });

  it('looks at no pull request but Dependabot’s from its GitHub Actions branches', async () => {
    const others = [
      pull({ user: { id: MARTIN } }),
      pull({ user: { id: APP_USER } }),
      pull({ user: { id: 4242 } }),
      pull({ user: null }),
      pull({ head: { ref: 'dependabot/npm_and_yarn/vitest-5.1.0', sha: HEAD, repo: { full_name: REPO } } }),
      pull({ head: { ref: 'dependabot/docker/node-24.22.3', sha: HEAD, repo: { full_name: REPO } } }),
      pull({ head: { ref: 'dependabot/tooling-7ddd2f2d32', sha: HEAD, repo: { full_name: REPO } } }),
      pull({ head: { ref: 'factory/pin/zap', sha: HEAD, repo: { full_name: REPO } } }),
    ];
    for (const other of others) {
      const said = capture();
      const { pass, enqueued, sent } = harness({ pulls: () => [other], log: said.log });
      await pass();
      expect(enqueued).toEqual([]);
      expect(verdictReads(sent)).toEqual([]);
      expect(said.lines).toEqual([]);
    }
  });

  it('waits, saying why and reading no verdict, for one from a fork, into another branch, a draft, or the prefix alone', async () => {
    const cases: [QueuePull, string][] = [
      [
        pull({ head: { ref: BUMP, sha: HEAD, repo: { full_name: 'dependabot/fork' } } }),
        `it is not from a branch of ${REPO}`,
      ],
      [pull({ head: { ref: BUMP, sha: HEAD, repo: null } }), `it is not from a branch of ${REPO}`],
      [pull({ base: { ref: 'release' } }), 'it is into release, not main'],
      [pull({ draft: true }), 'it is a draft'],
      [
        pull({ head: { ref: 'dependabot/github_actions/', sha: HEAD, repo: { full_name: REPO } } }),
        "dependabot/github_actions/ is not one of Dependabot's branches under dependabot/github_actions/",
      ],
    ];
    for (const [other, why] of cases) {
      expect(workflowPinPullWait(REPO, other)).toEqual({ waits: 'not-a-workflow-pin', why });
      const said = capture();
      const { pass, enqueued, sent } = harness({ pulls: () => [other], log: said.log });
      await pass();
      await pass();
      expect(enqueued).toEqual([]);
      expect(verdictReads(sent)).toEqual([]);
      // Said once for each head and reason.
      expect(said.lines).toMatchObject([{ msg: 'the workflow pin pull request waits to be queued', why }]);
    }
    expect(workflowPinPullWait(REPO, pull())).toBeUndefined();
    expect(workflowPinPullWait(REPO, pull({ user: { id: 4242 } }))?.why).toBe('Dependabot did not open it');
  });

  it('adds nothing the gate did not pass as an exact pin at that head: never another rule, a hold, a wait or another head’s', async () => {
    const cases: [ReturnType<typeof review>[], RegExp][] = [
      [[], /has posted no review check/],
      [[review(HEAD, { rule: 'held' })], /the gate's rule is held, not exact-pin/],
      // Martin's approval of the head leaves adding it his.
      [[review(HEAD, { rule: 'martin-approved-head' })], /the gate's rule is martin-approved-head, not exact-pin/],
      [[review(HEAD, { rule: 'move' })], /the gate's rule is move, not exact-pin/],
      [[review(HEAD, { rule: 'low-risk' })], /the gate's rule is low-risk, not exact-pin/],
      [[review(HEAD, { rule: 'lights-out' })], /the gate's rule is lights-out, not exact-pin/],
      [
        [review(HEAD, { rule: 'held', pending: 'the gate could not check its exact pin: 503' })],
        /the gate waits: the gate could not check its exact pin: 503/,
      ],
      [[review(HEAD, {}, { status: 'in_progress' })], /has not concluded/],
      [[review(HEAD, {}, { conclusion: 'cancelled' })], /concluded cancelled/],
      [[review(HEAD, {}, { conclusion: 'failure' })], /is not its rule's/],
      // A verdict for another head, or another pull request at this one.
      [[review(HEAD, { head: NEWER })], /does not judge #81 at its head/],
      [[review(HEAD, {}, { number: 82 })], /does not judge #81 at its head/],
      // Only the review App's check is the gate's: the factory's own App, or GitHub Actions, can post one of that name.
      [[review(HEAD, {}, { app: 5187559 })], /has posted no review check/],
      [[review(HEAD, {}, { app: 15368 })], /has posted no review check/],
      // The latest of the review App's runs on the head decides.
      [[review(HEAD), review(HEAD, { rule: 'held' })], /the gate's rule is held/],
    ];
    for (const [reviews, why] of cases) {
      const said = capture();
      const { pass, enqueued, levels } = harness({ reviews: () => reviews, log: said.log });
      await pass();
      expect(enqueued, String(why)).toEqual([]);
      expect(said.lines).toMatchObject([{ waits: 'verdict', why: expect.stringMatching(why) }]);
      // The level is read only just before an enqueue.
      expect(levels()).toBe(0);
    }
  });

  it('adds it only when the level Martin set queues an exact pin, with auto-merge on, read just before the enqueue', async () => {
    const cases: [Autonomy, boolean, string | undefined][] = [
      ['supervised', true, 'at Supervised an exact-pin waits for Martin'],
      ['supervised', false, 'at Supervised an exact-pin waits for Martin'],
      ['guarded', false, 'with auto-merge off an exact-pin waits for Martin'],
      ['lights-out', false, 'with auto-merge off an exact-pin waits for Martin'],
      ['guarded', true, undefined],
      ['lights-out', true, undefined],
    ];
    for (const [autonomy, autoMerge, why] of cases) {
      const said = capture();
      const { pass, enqueued } = harness({ level: level(autonomy, autoMerge), log: said.log });
      await pass();
      expect(enqueued, `${autonomy} ${autoMerge}`).toEqual(why ? [] : [[81, HEAD]]);
      if (why) expect(said.lines).toMatchObject([{ why }]);
    }
    // What Martin changes holds from the next pass, with nothing restarted.
    let autonomy: Autonomy = 'supervised';
    const { pass, enqueued } = harness({ level: async () => ({ autonomy, autoMerge: true }) });
    await pass();
    expect(enqueued).toEqual([]);
    autonomy = 'guarded';
    await pass();
    expect(enqueued).toEqual([[81, HEAD]]);
  });

  it('waits for every other required check, and for one that failed says what would move it, once', async () => {
    const running = capture();
    const going = harness({ runs: () => [...green().slice(1), run('check', null)], log: running.log });
    await going.pass();
    expect(going.enqueued).toEqual([]);
    expect(running.lines).toMatchObject([{ waits: 'checks', why: 'waiting for check' }]);

    const failing = capture();
    const sent: Sent[] = [];
    const { github } = client([], sent);
    const failed = harness({
      runs: () => [...green().slice(1), run('check', 'failure')],
      log: failing.log,
      // The live actions: were the watch to comment on it or write its head again, GitHub would be asked.
      actions: new LiveActions(github),
    });
    await failed.pass();
    await failed.pass();
    expect(failing.lines).toMatchObject([{ waits: 'failed', why: `failed: check: ${THEIRS}` }]);
    expect(THEIRS).toMatch(/waits for Martin to run the check again, or for Dependabot's next rebase/);
    expect(calls(sent)).toEqual([]);
    // The factory's own App's run of a required check counts for nothing.
    const own = harness({ runs: () => [...green().slice(1), run('check', 'success', 'mrogan-software-factory')] });
    await own.pass();
    expect(own.enqueued).toEqual([]);
  });

  it('adds none that conflicts with main, or whose conflict GitHub has not worked out, or that is queued already', async () => {
    for (const conflicts of [true, null]) {
      const { pass, enqueued } = harness({ conflicts });
      await pass();
      expect(enqueued).toEqual([]);
    }
    const inQueue = queue({
      queued: { position: 1, state: 'QUEUED', enqueuedAt: '2026-11-24T21:00:00Z', commit: null },
    });
    const { pass, enqueued } = harness({ queued: () => inQueue });
    await pass();
    expect(enqueued).toEqual([]);
  });

  it(`adds a head the queue took out for failed checks again, ${QUEUE_TRIES} times in all, then leaves it for Martin with no comment`, async () => {
    const out = (failures: number, reason = 'failed_checks') =>
      queue({ removed: { at: '2026-11-24T21:10:00Z', by: 'github-merge-queue', reason, commit: NEWER, failures } });
    let state = queue();
    const said = capture();
    const { pass, enqueued } = harness({ queued: () => state, log: said.log });
    await pass();
    for (let failures = 1; failures < QUEUE_TRIES; failures++) {
      state = out(failures);
      await pass();
    }
    expect(enqueued).toHaveLength(QUEUE_TRIES);
    state = out(QUEUE_TRIES);
    await pass();
    await pass();
    expect(enqueued).toHaveLength(QUEUE_TRIES);
    expect(said.lines.at(-1)).toMatchObject({
      level: 40,
      msg: `the merge queue took the workflow pin pull request out for failed checks ${QUEUE_TRIES} times: it waits for Martin`,
    });
    // Out any other way (Martin took it out), it is not added again.
    state = queue();
    const taken = harness({ queued: () => state });
    await taken.pass();
    state = out(0, 'dequeued');
    await taken.pass();
    expect(taken.enqueued).toHaveLength(1);
  });

  it(`tries a failure that may pass again, ${MAX_TRIES} times at most, and leaves a refusal for Martin at once`, async () => {
    let asked = 0;
    const flaky = harness({
      enqueue: async () => {
        asked++;
        throw new GitHubError('server', 'Bad gateway', 502);
      },
    });
    for (let i = 0; i < MAX_TRIES + 2; i++) await flaky.pass();
    expect(asked).toBe(MAX_TRIES);
    asked = 0;
    const refused = harness({
      enqueue: async () => {
        asked++;
        throw new GitHubError('refused', 'Resource not accessible by integration', 403);
      },
    });
    await refused.pass();
    await refused.pass();
    expect(asked).toBe(1);
  });

  it('holds only the pull request it could not read, and goes on to the next', async () => {
    const two = [pull({ number: 80, head: { ref: `${BUMP}-x`, sha: NEWER, repo: { full_name: REPO } } }), pull()];
    const { pass, enqueued } = harness({
      pulls: () => two,
      reviews: (head) => {
        if (head === NEWER) throw new Error('unread');
        return [review(head)];
      },
    });
    await pass();
    expect(enqueued).toEqual([[81, HEAD]]);
  });

  it('adds and records nothing in a dry run, and reads nothing', async () => {
    const records: unknown[] = [];
    const store = { put: async (record: unknown) => void records.push(record) };
    const guard = new IssueGuard({ openedBy: async () => ({ by: DEPENDABOT_USER, pullRequest: true }) });
    const actions = new DryRunActions(store as never, quiet, undefined, undefined, guard, async () => ({
      state: 'open',
      draft: false,
      head: { ref: BUMP, sha: HEAD, repo: REPO },
      base: 'main',
    }));
    const { pass, sent } = harness({ actions });
    await pass();
    expect(records).toEqual([]);
    expect(calls(sent)).toEqual([]);
  });
});
