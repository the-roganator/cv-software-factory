/**
 * The worker adds this repository's local deploy pull request to the merge queue (ADR 0017), through the watch itself:
 * a fake GitHub for the pull request, fake reads for the gate's verdict, the checks and the queue, and fake actions for
 * the enqueue, or the dry run's own.
 */
import { describe, expect, it } from 'vitest';
import { DryRunActions } from '../../src/github/actions.ts';
import { GitHubError } from '../../src/github/client.ts';
import {
  checksWait,
  type DeployPull,
  type DeployQueueDependencies,
  deployPullWait,
  deployQueueWatch,
  QUEUED_DEPLOYS,
  verdictWait,
} from '../../src/github/deploy-queue.ts';
import { DEPLOYS, type DeployTarget } from '../../src/github/deploys.ts';
import { APP_USER, IssueGuard } from '../../src/github/issues.ts';
import type { MergeQueue, ReviewVerdict } from '../../src/github/merging.ts';
import type { CheckRun } from '../../src/github/reads.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { calls, client, quiet, type Sent } from './fake.ts';

const [FACTORY, APP] = DEPLOYS as [DeployTarget, DeployTarget];
const REPO = FACTORY.repo;
const HEAD = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const MARTIN = 6206459;
const TITLE = 'chore(deploy): run console 06f60ad and the factory 06f60ad on the local cluster';
const REQUIRED = [
  'lint, types, tests',
  'browser tests',
  'image builds',
  'lockfile scan',
  'pull request title',
  'review',
];

const pull = (over: Partial<DeployPull> = {}): DeployPull => ({
  number: 973,
  title: TITLE,
  draft: false,
  user: { id: APP_USER },
  labels: [{ name: 'deploy: local' }],
  head: { ref: 'deploy/local', sha: HEAD, repo: { full_name: REPO } },
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
const green = () => [
  ...REQUIRED.filter((n) => n !== 'review' && n !== 'browser tests').map((n) => run(n)),
  run('browser tests', 'skipped'),
];

const verdict = (head: string, judged: Partial<ReviewVerdict['judged'] & object> | null = {}): ReviewVerdict => ({
  number: 973,
  head,
  check: null,
  verdict: null,
  judged: judged === null ? null : { number: 973, head, rule: 'exact-pin', tags: [], ...judged },
  problem: judged === null ? 'the review App has posted no review check' : null,
});

const queue = (over: Partial<MergeQueue> = {}): MergeQueue => ({
  number: 973,
  head: HEAD,
  state: 'open',
  queued: null,
  added: null,
  removed: null,
  checks: [],
  ...over,
});

/** A worker's deploy queue watch against a deploy branch with these open pull requests, as each pass reads them. */
function harness(o: {
  pulls?: () => DeployPull[];
  verdict?: () => ReviewVerdict;
  runs?: () => CheckRun[];
  conflicts?: boolean | null;
  queued?: () => MergeQueue;
  enqueue?: (number: number, head: string) => Promise<{ position: number | null; state: string | null }>;
  actions?: DeployQueueDependencies['actions'];
  recorder?: RefusalRecorder;
}) {
  const sent: Sent[] = [];
  const { github } = client(
    [
      {
        method: 'GET',
        path: `/repos/${REPO}/pulls?state=open&per_page=10&head=the-roganator:deploy%2Flocal`,
        answer: () => ({ body: (o.pulls ?? (() => [pull()]))() }),
      },
    ],
    sent,
  );
  const enqueued: [number, string][] = [];
  const actions = o.actions ?? {
    enqueuePullRequest: async (_repo: string, number: number, head: string) => {
      enqueued.push([number, head]);
      return o.enqueue ? o.enqueue(number, head) : { position: 1, state: 'QUEUED' };
    },
  };
  const reads: DeployQueueDependencies['reads'] = {
    reviewVerdict: async () => (o.verdict ?? (() => verdict(HEAD)))(),
    checkRuns: async () => (o.runs ?? green)(),
    requiredChecks: async () => REQUIRED,
    mergeability: async (_repo, number) => {
      const head = (o.pulls ?? (() => [pull()]))()[0]?.head.sha ?? HEAD;
      const conflicts = o.conflicts === undefined ? false : o.conflicts;
      return { number, head, conflicts, state: conflicts ? 'dirty' : 'clean' };
    },
    mergeQueue: async () => (o.queued ?? (() => queue()))(),
  };
  const pass = deployQueueWatch({ github, reads, actions, recorder: o.recorder, log: quiet }, FACTORY);
  return { pass, enqueued, sent };
}

describe('the deploy queue watch', () => {
  it('queues only this repository’s local deploy, never the app’s', () => {
    expect(QUEUED_DEPLOYS).toEqual([FACTORY]);
    const { github } = client([]);
    const deps = { github, reads: {} as never, actions: {} as never, log: quiet };
    expect(() => deployQueueWatch(deps, APP)).toThrow(/does not queue/);
  });

  it('adds the App’s deploy pin to the queue at its head once the gate passed it as an exact pin and its checks are green', async () => {
    const { pass, enqueued } = harness({});
    await pass();
    expect(enqueued).toEqual([[973, HEAD]]);
    // Once for each head: the next pass does not ask again.
    await pass();
    expect(enqueued).toHaveLength(1);
  });

  it('queues a newer build’s head afresh once the gate and its checks pass it', async () => {
    let head = HEAD;
    const { pass, enqueued } = harness({
      pulls: () => [pull({ head: { ...pull().head, sha: head } })],
      verdict: () => verdict(head),
    });
    await pass();
    head = NEWER;
    await pass();
    expect(enqueued).toEqual([
      [973, HEAD],
      [973, NEWER],
    ]);
  });

  it('never queues a release, a pull request of another profile, Martin’s, a draft or another branch’s', async () => {
    const release = pull({
      title: 'chore(main): release 1.4.0',
      labels: [{ name: 'autorelease: pending' }],
      head: { ref: 'release-please--branches--main', sha: HEAD, repo: { full_name: REPO } },
    });
    const others = [
      release,
      pull({ labels: [{ name: 'deploy: production' }] }),
      pull({ title: 'chore(deploy): run the factory 06f60ad on the production cluster' }),
      pull({ user: { id: MARTIN } }),
      pull({ user: null }),
      pull({ draft: true }),
      pull({ base: { ref: 'deploy/next' } }),
      pull({ head: { ref: 'deploy/local', sha: HEAD, repo: { full_name: 'someone/fork' } } }),
      pull({ title: 'chore(deploy): run console 06f60ad on the local cluster and more' }),
    ];
    for (const other of others) {
      expect(deployPullWait(FACTORY, other)?.waits, other.title).toBe('not-a-deploy');
      const { pass, enqueued } = harness({ pulls: () => [other] });
      await pass();
      expect(enqueued, JSON.stringify(other)).toEqual([]);
    }
    expect(deployPullWait(FACTORY, pull())).toBeUndefined();
  });

  it('never queues a head the gate held, judged by another rule, has not judged, or judged at another head', async () => {
    const verdicts = [
      verdict(HEAD, { rule: 'held', tags: [{ tag: 'release', because: ['CHANGELOG.md'] }] }),
      verdict(HEAD, { rule: 'held', pending: 'cosign did not answer' }),
      verdict(HEAD, { rule: 'low-risk' }),
      verdict(HEAD, { rule: 'martin-approved-head' }),
      verdict(HEAD, null),
      verdict(NEWER),
      { ...verdict(HEAD), judged: { number: 973, head: NEWER, rule: 'exact-pin' as const, tags: [] } },
    ];
    for (const v of verdicts) {
      expect(verdictWait(v, HEAD)?.waits).toBe('verdict');
      const { pass, enqueued } = harness({ verdict: () => v });
      await pass();
      expect(enqueued, JSON.stringify(v.judged)).toEqual([]);
    }
  });

  it('waits for a check still running, and queues once it passes', async () => {
    let runs = [...green().filter((r) => r.name !== 'image builds'), run('image builds', null)];
    const { pass, enqueued } = harness({ runs: () => runs });
    await pass();
    expect(enqueued).toEqual([]);
    runs = [...runs, run('image builds')];
    await pass();
    expect(enqueued).toEqual([[973, HEAD]]);
  });

  it('never queues a head with a red check, nor one a required check is missing from', async () => {
    const red = [...green(), run('lockfile scan', 'failure')];
    expect(checksWait(red, REQUIRED)).toEqual({ waits: 'failed', why: 'failed: lockfile scan' });
    const missing = green().filter((r) => r.name !== 'pull request title');
    expect(checksWait(missing, REQUIRED)?.waits).toBe('checks');
    // The factory's App's own run of a required check's name counts for nothing.
    const forged = [...missing, run('pull request title', 'success', 'mrogan-software-factory')];
    expect(checksWait(forged, REQUIRED)?.waits).toBe('checks');
    // A failure re-run green, at the same head, passes: the latest run of each name is read.
    expect(checksWait([...red, run('lockfile scan')], REQUIRED)).toBeUndefined();
    for (const runs of [red, missing, forged]) {
      const { pass, enqueued } = harness({ runs: () => runs });
      await pass();
      expect(enqueued).toEqual([]);
    }
  });

  it('waits while it conflicts with main or GitHub has not said, and leaves one already queued as it is', async () => {
    for (const conflicts of [true, null]) {
      const { pass, enqueued } = harness({ conflicts });
      await pass();
      expect(enqueued).toEqual([]);
    }
    const queued = queue({ queued: { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '', commit: null } });
    const { pass, enqueued } = harness({ queued: () => queued });
    await pass();
    expect(enqueued).toEqual([]);
  });

  it('keeps and signs GitHub’s refusal, and does not ask again at that head', async () => {
    const records: unknown[] = [];
    const store = {
      put: async (bytes: Uint8Array) => {
        records.push(JSON.parse(new TextDecoder().decode(bytes)));
        return 'f'.repeat(64);
      },
    };
    const recorder = new RefusalRecorder({ artifacts: store as never, log: quiet });
    const { pass, enqueued } = harness({
      recorder,
      enqueue: async () => {
        throw new GitHubError('refused', 'Resource not accessible by integration', 403);
      },
    });
    await pass();
    await pass();
    expect(enqueued).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({
        repo: REPO,
        number: 973,
        payload: expect.objectContaining({
          mechanism: 'token-permission',
          action: `enqueuePullRequest #973 in ${REPO}`,
        }),
      }),
    ]);
  });

  it('reads again after a head that moved before it was queued (409)', async () => {
    let moved = true;
    const { pass, enqueued } = harness({
      enqueue: async () => {
        if (moved) {
          moved = false;
          throw new GitHubError('conflict', 'Pull request #973 is at bbbbbbb, not aaaaaaa.', 409);
        }
        return { position: 1, state: 'QUEUED' };
      },
    });
    await pass();
    await pass();
    expect(enqueued).toEqual([
      [973, HEAD],
      [973, HEAD],
    ]);
  });

  it('in a dry run, records the enqueue and sends GitHub nothing but reads', async () => {
    const records: { action: string; args: unknown }[] = [];
    const store = {
      put: async (bytes: Uint8Array) => {
        records.push(JSON.parse(new TextDecoder().decode(bytes)));
        return String(records.length).padStart(64, 'f');
      },
    };
    const guard = new IssueGuard({ openedBy: async () => ({ by: APP_USER, pullRequest: true }) });
    const candidate = async () => ({
      state: 'open',
      draft: false,
      head: { ref: 'deploy/local', sha: HEAD, repo: REPO },
    });
    const actions = new DryRunActions(store as never, quiet, undefined, undefined, guard, candidate);
    const { pass, sent } = harness({ actions });
    await pass();
    await pass();
    expect(records.map(({ action, args }) => ({ action, args }))).toEqual([
      { action: 'enqueuePullRequest', args: { number: 973, expectedHead: HEAD } },
    ]);
    expect(calls(sent).every((s) => s.method === 'GET')).toBe(true);
  });

  it('in a dry run, the guard refuses a pull request the App did not open, and nothing is recorded as done', async () => {
    const records: { action: string }[] = [];
    const store = {
      put: async (bytes: Uint8Array) => {
        records.push(JSON.parse(new TextDecoder().decode(bytes)));
        return 'f'.repeat(64);
      },
    };
    const recorder = new RefusalRecorder({ artifacts: store as never, log: quiet });
    // The pull request reads as the App's, and GitHub says otherwise when the guard asks.
    const guard = new IssueGuard({ openedBy: async () => ({ by: MARTIN, pullRequest: true }), recorder });
    const actions = new DryRunActions(store as never, quiet, undefined, undefined, guard);
    const { pass } = harness({ actions, recorder });
    await pass();
    expect(records).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ mechanism: 'github-guard' }) }),
    ]);
  });
});
