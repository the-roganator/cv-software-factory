/**
 * The worker adds this repository's local deploy pull request to the merge queue (ADR 0017), through the watch itself:
 * a fake GitHub for the pull request, fake reads for the gate's verdict, the checks and the queue, and fake actions for
 * the enqueue, or the dry run's own. The pin queue watch beside it adds the pin watch's pull requests the gate passed
 * as pin moves, each condition tested alone against one that passes.
 */
import { describe, expect, it } from 'vitest';
import { DryRunActions } from '../../src/github/actions.ts';
import { GitHubError } from '../../src/github/client.ts';
import {
  checksWait,
  type DeployQueueDependencies,
  deployPullWait,
  deployQueueWatch,
  type LabelEvents,
  labelWait,
  MAX_TRIES,
  pinPullWait,
  pinQueueWatch,
  QUEUED_DEPLOYS,
  type QueuePull,
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

const pull = (over: Partial<QueuePull> = {}): QueuePull => ({
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
  pulls?: () => QueuePull[];
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
      pull({ title: 'chore(deploy): run unrelated 06f60ad on the local cluster' }),
      pull({ title: 'chore(deploy): run console 06f60ad and 1234567 on the local cluster' }),
    ];
    for (const other of others) {
      expect(deployPullWait(FACTORY, other)?.waits, other.title).toBe('not-a-deploy');
      const { pass, enqueued } = harness({ pulls: () => [other] });
      await pass();
      expect(enqueued, JSON.stringify(other)).toEqual([]);
    }
    expect(deployPullWait(FACTORY, pull())).toBeUndefined();
  });

  it('finds the deploy watch’s pull request among others from the same branch', async () => {
    const other = pull({ number: 990, base: { ref: 'deploy/next' } });
    const { pass, enqueued } = harness({ pulls: () => [other, pull()] });
    await pass();
    expect(enqueued).toEqual([[973, HEAD]]);
  });

  it('never queues a head the gate held, judged by another rule, has not judged, or judged at another head', async () => {
    const verdicts = [
      verdict(HEAD, { rule: 'held', tags: [{ tag: 'release', because: ['release-please--branches--main'] }] }),
      verdict(HEAD, { rule: 'held', pending: 'cosign did not answer' }),
      verdict(HEAD, { rule: 'low-risk' }),
      verdict(HEAD, { rule: 'martin-approved-head' }),
      verdict(HEAD, null),
      verdict(NEWER),
      { ...verdict(HEAD), judged: { number: 973, head: NEWER, rule: 'exact-pin' as const, tags: [] } },
    ];
    for (const v of verdicts) {
      expect(verdictWait(v, HEAD, 'exact-pin')?.waits).toBe('verdict');
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
    // No required check read is no check passed.
    expect(checksWait(green(), [])?.waits).toBe('checks');
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

  it('tries again after a failure that may pass, up to MAX_TRIES, then leaves the head for Martin', async () => {
    const failures = [
      new GitHubError('conflict', 'Pull request #973 is at bbbbbbb, not aaaaaaa.', 409),
      new GitHubError('conflict', 'Expected head is stale'),
      new GitHubError('server', 'Bad gateway', 502),
      new GitHubError('network', 'socket hang up'),
      new GitHubError('rate-limited', 'API rate limit exceeded', 429),
    ];
    let failing = 2;
    const recovers = harness({
      enqueue: async () => {
        const failure = failures[failing];
        if (failing-- > 0 && failure) throw failure;
        return { position: 1, state: 'QUEUED' };
      },
    });
    for (let i = 0; i < 4; i++) await recovers.pass();
    expect(recovers.enqueued).toHaveLength(3);

    for (const failure of failures) {
      const { pass, enqueued } = harness({
        enqueue: async () => {
          throw failure;
        },
      });
      for (let i = 0; i < MAX_TRIES + 2; i++) await pass();
      expect(enqueued, failure.message).toHaveLength(MAX_TRIES);
    }
  });

  it('leaves a head for Martin at once after a failure that will not pass', async () => {
    const { pass, enqueued } = harness({
      enqueue: async () => {
        throw new GitHubError('not-found', 'Could not resolve to a PullRequest', 404);
      },
    });
    await pass();
    await pass();
    expect(enqueued).toHaveLength(1);
  });

  it('keeps only the head it is on: a head it left is tried afresh if the branch comes back to it', async () => {
    let head = HEAD;
    const { pass, enqueued } = harness({
      pulls: () => [pull({ head: { ...pull().head, sha: head } })],
      verdict: () => verdict(head),
    });
    await pass();
    head = NEWER;
    await pass();
    head = HEAD;
    await pass();
    expect(enqueued.map(([, h]) => h)).toEqual([HEAD, NEWER, HEAD]);
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

const PIN_HEAD = 'c'.repeat(40);
const OLDER = 'd'.repeat(40);
const pinPull = (over: Partial<QueuePull> = {}): QueuePull => ({
  number: 1040,
  title: 'fix(deps): move zap to 2.17.0 on its line',
  draft: false,
  user: { id: APP_USER },
  labels: [{ name: 'pin' }],
  head: { ref: 'factory/pin/zap', sha: PIN_HEAD, repo: { full_name: REPO } },
  base: { ref: 'main' },
  ...over,
});
const labelled = (by: number | null, name = 'pin') => ({
  event: 'labeled',
  actor: by === null ? null : { id: by },
  label: { name },
});
const pinVerdict = (
  head: string,
  judged: Partial<ReviewVerdict['judged'] & object> | null = {},
  number = 1040,
): ReviewVerdict => ({
  number,
  head,
  check: null,
  verdict: null,
  judged: judged === null ? null : { number, head, rule: 'pin-move', tags: [], ...judged },
  problem: judged === null ? 'the review App has posted no review check' : null,
});

/** A worker's pin queue watch against a repository with these open pull requests and each one's events. */
function pinHarness(o: {
  pulls?: () => QueuePull[];
  events?: (number: number, page: number) => LabelEvents;
  verdict?: (number: number) => ReviewVerdict;
  runs?: () => CheckRun[];
  actions?: DeployQueueDependencies['actions'];
}) {
  const sent: Sent[] = [];
  const pulls = o.pulls ?? (() => [pinPull()]);
  const { github } = client(
    [
      {
        method: 'GET',
        path: /\/pulls\?state=open&per_page=100&sort=created&direction=asc&page=\d+$/,
        answer: ({ path }) => {
          const page = Number(/page=(\d+)$/.exec(path)?.[1]);
          return { body: pulls().slice((page - 1) * 100, page * 100) };
        },
      },
      {
        method: 'GET',
        path: /\/issues\/\d+\/events\?per_page=100&page=\d+$/,
        answer: ({ path }) => {
          const [, number, page] = /issues\/(\d+)\/events\?per_page=100&page=(\d+)/.exec(path) ?? [];
          const events = o.events ?? ((_n: number, p: number) => (p === 1 ? [labelled(APP_USER)] : []));
          return { body: events(Number(number), Number(page)) };
        },
      },
    ],
    sent,
  );
  const enqueued: [number, string][] = [];
  const actions = o.actions ?? {
    enqueuePullRequest: async (_repo: string, number: number, head: string) => {
      enqueued.push([number, head]);
      return { position: 1, state: 'QUEUED' };
    },
  };
  const headOf = (number: number) => pulls().find((p) => p.number === number)?.head.sha ?? PIN_HEAD;
  const reads: DeployQueueDependencies['reads'] = {
    reviewVerdict: async (_repo, number) => (o.verdict ?? ((n: number) => pinVerdict(headOf(n), {}, n)))(number),
    checkRuns: async () => (o.runs ?? green)(),
    requiredChecks: async () => REQUIRED,
    mergeability: async (_repo, number) => ({ number, head: headOf(number), conflicts: false, state: 'clean' }),
    mergeQueue: async (_repo, number) => queue({ number, head: headOf(number) }),
  };
  const pass = pinQueueWatch({ github, reads, actions, log: quiet }, REPO);
  return { pass, enqueued, sent };
}

describe('the pin queue watch', () => {
  it('queues pin moves in this repository alone, never the app’s', () => {
    const { github } = client([]);
    const deps = { github, reads: {} as never, actions: {} as never, log: quiet };
    expect(() => pinQueueWatch(deps, APP.repo)).toThrow(/does not queue/);
  });

  it('adds the pin watch’s pull request at its head once the gate passed it as a pin move and its checks are green', async () => {
    const { pass, enqueued } = pinHarness({});
    await pass();
    expect(enqueued).toEqual([[1040, PIN_HEAD]]);
    await pass();
    expect(enqueued).toHaveLength(1);
  });

  it('queues each of several pin moves on its own, and leaves the one the gate held', async () => {
    const pulls = [
      pinPull(),
      pinPull({ number: 1041, head: { ref: 'factory/pin/postgres', sha: NEWER, repo: { full_name: REPO } } }),
    ];
    const { pass, enqueued } = pinHarness({
      pulls: () => pulls,
      verdict: (n) => (n === 1041 ? pinVerdict(NEWER, { rule: 'held', tags: [] }, n) : pinVerdict(PIN_HEAD, {}, n)),
    });
    await pass();
    expect(enqueued).toEqual([[1040, PIN_HEAD]]);
  });

  // Each case changes one thing of a pull request that passes, and nothing else.
  const notPins: [string, QueuePull][] = [
    ['opened by someone else', pinPull({ user: { id: MARTIN } })],
    ['opened by nobody GitHub knows', pinPull({ user: null })],
    ['from a fork', pinPull({ head: { ref: 'factory/pin/zap', sha: PIN_HEAD, repo: { full_name: 'someone/fork' } } })],
    ['from a fork GitHub no longer has', pinPull({ head: { ref: 'factory/pin/zap', sha: PIN_HEAD, repo: null } })],
    [
      'on another factory branch',
      pinPull({ head: { ref: 'factory/other', sha: PIN_HEAD, repo: { full_name: REPO } } }),
    ],
    [
      'on a pin move’s next branch',
      pinPull({ head: { ref: 'factory/pin-next/zap', sha: PIN_HEAD, repo: { full_name: REPO } } }),
    ],
    [
      'on a pin branch of two segments',
      pinPull({ head: { ref: 'factory/pin/zap/x', sha: PIN_HEAD, repo: { full_name: REPO } } }),
    ],
    ['the deploy branch', pinPull({ head: { ref: 'deploy/local', sha: PIN_HEAD, repo: { full_name: REPO } } })],
    ['into another base', pinPull({ base: { ref: 'feat/pin-watch' } })],
    ['a draft', pinPull({ draft: true })],
    ['without the label', pinPull({ labels: [] })],
  ];
  for (const [what, other] of notPins) {
    it(`never queues a pull request ${what}, whatever the gate said`, async () => {
      expect(pinPullWait(REPO, other)?.waits).toBe('not-a-pin');
      const { pass, enqueued } = pinHarness({ pulls: () => [other] });
      await pass();
      expect(enqueued).toEqual([]);
    });
  }
  it('passes the pull request every case above changes', () => {
    expect(pinPullWait(REPO, pinPull())).toBeUndefined();
  });

  const labels: [string, (number: number, page: number) => LabelEvents][] = [
    ['labelled pin by someone else', (_n, p) => (p === 1 ? [labelled(MARTIN)] : [])],
    [
      'labelled pin by the App and again by someone else',
      (_n, p) =>
        p === 1
          ? [
              labelled(APP_USER),
              { event: 'unlabeled', actor: { id: APP_USER }, label: { name: 'pin' } },
              labelled(MARTIN),
            ]
          : [],
    ],
    ['labelled pin by an actor GitHub no longer has', (_n, p) => (p === 1 ? [labelled(null)] : [])],
    ['with no labelling event', (_n, p) => (p === 1 ? [labelled(APP_USER, 'deploy: local')] : [])],
    [
      'whose events run past what is read',
      (_n, p) =>
        Array.from({ length: 100 }, () =>
          p === 1 ? labelled(APP_USER) : { event: 'commented', actor: { id: MARTIN } },
        ),
    ],
  ];
  for (const [what, events] of labels) {
    it(`never queues a pull request ${what}`, async () => {
      const { pass, enqueued } = pinHarness({ events });
      await pass();
      expect(enqueued).toEqual([]);
    });
  }
  it('never queues a pull request whose pin label someone but the App took off, though the App put it back', async () => {
    const { pass, enqueued } = pinHarness({
      events: (_n, p) =>
        p === 1
          ? [
              labelled(APP_USER),
              { event: 'unlabeled', actor: { id: MARTIN }, label: { name: 'pin' } },
              labelled(APP_USER),
            ]
          : [],
    });
    await pass();
    expect(enqueued).toEqual([]);
  });

  it('reads exactly as many events as it reads whole, when no page follows', async () => {
    const { pass, enqueued } = pinHarness({
      events: (_n, p) => (p <= 5 ? Array.from({ length: 100 }, () => labelled(APP_USER)) : []),
    });
    await pass();
    expect(enqueued).toEqual([[1040, PIN_HEAD]]);
  });

  it('reads the events last, never for a pull request the gate or its checks hold', async () => {
    const { pass, sent } = pinHarness({ verdict: () => pinVerdict(PIN_HEAD, { rule: 'held', tags: [] }) });
    await pass();
    expect(calls(sent).some((s) => s.path.includes('/events'))).toBe(false);
  });

  it('finds the pin watch’s pull request past the first hundred open', async () => {
    const others = Array.from({ length: 150 }, (_, i) =>
      pinPull({ number: 2000 + i, labels: [], head: { ref: `feat/x${i}`, sha: OLDER, repo: { full_name: REPO } } }),
    );
    const { pass, enqueued } = pinHarness({ pulls: () => [...others, pinPull()] });
    await pass();
    expect(enqueued).toEqual([[1040, PIN_HEAD]]);
  });

  it('queues the next pin move when one before it cannot be read', async () => {
    const second = pinPull({
      number: 1041,
      head: { ref: 'factory/pin/postgres', sha: NEWER, repo: { full_name: REPO } },
    });
    const { pass, enqueued } = pinHarness({
      pulls: () => [pinPull(), second],
      events: (n, p) => {
        if (n === 1040) throw new Error('not this one');
        return p === 1 ? [labelled(APP_USER)] : [];
      },
    });
    await pass();
    expect(enqueued).toEqual([[1041, NEWER]]);
  });

  it('reads the App’s label on a later page', async () => {
    const { pass, enqueued } = pinHarness({
      events: (_n, p) =>
        p === 1 ? Array.from({ length: 100 }, () => ({ event: 'committed', actor: null })) : [labelled(APP_USER)],
    });
    await pass();
    expect(enqueued).toEqual([[1040, PIN_HEAD]]);
    expect(labelWait([labelled(APP_USER)], true)).toBeUndefined();
  });

  const verdicts: [string, ReviewVerdict][] = [
    ['an exact pin', pinVerdict(PIN_HEAD, { rule: 'exact-pin' })],
    ['low risk', pinVerdict(PIN_HEAD, { rule: 'low-risk' })],
    [
      'held',
      pinVerdict(PIN_HEAD, { rule: 'held', tags: [{ tag: 'code-owned', because: ['policy/vulnerabilities.ts'] }] }),
    ],
    ['held, pending', pinVerdict(PIN_HEAD, { rule: 'held', pending: 'the pin move job has not run' })],
    ['held, then approved by Martin at its head', pinVerdict(PIN_HEAD, { rule: 'martin-approved-head' })],
    ['Martin’s own', pinVerdict(PIN_HEAD, { rule: 'martin-opened' })],
    ['not judged', pinVerdict(PIN_HEAD, null)],
    ['a pin move at an older head', pinVerdict(OLDER)],
    [
      'judged at an older head under the current one',
      { ...pinVerdict(PIN_HEAD), judged: { number: 1040, head: OLDER, rule: 'pin-move', tags: [] } },
    ],
  ];
  for (const [what, v] of verdicts) {
    it(`never queues a pin move whose verdict at its head is ${what}`, async () => {
      expect(verdictWait(v, PIN_HEAD, 'pin-move')?.waits).toBe('verdict');
      const { pass, enqueued } = pinHarness({ verdict: () => v });
      await pass();
      expect(enqueued).toEqual([]);
    });
  }
  it('never takes a pin move as a deploy pin, nor a deploy pin as a pin move', () => {
    expect(verdictWait(pinVerdict(PIN_HEAD), PIN_HEAD, 'exact-pin')?.waits).toBe('verdict');
    expect(verdictWait(verdict(HEAD), HEAD, 'pin-move')?.waits).toBe('verdict');
  });

  const checks: [string, CheckRun[]][] = [
    ['pending', [...green().filter((r) => r.name !== 'image builds'), run('image builds', null)]],
    ['failed', [...green(), run('lockfile scan', 'failure')]],
    ['missing', green().filter((r) => r.name !== 'pull request title')],
    [
      'passed only by the factory’s App',
      [
        ...green().filter((r) => r.name !== 'lint, types, tests'),
        run('lint, types, tests', 'success', 'mrogan-software-factory'),
      ],
    ],
  ];
  for (const [what, runs] of checks) {
    it(`never queues a pin move with a required check ${what}`, async () => {
      const { pass, enqueued } = pinHarness({ runs: () => runs });
      await pass();
      expect(enqueued).toEqual([]);
    });
  }
  it('queues a pin move whose only other check was skipped, as GitHub passes it', async () => {
    // green() skips browser tests: a skipped check is GitHub's pass, and the gate's own run proved what ran the pin.
    expect(green().find((r) => r.name === 'browser tests')?.conclusion).toBe('skipped');
    const { pass, enqueued } = pinHarness({});
    await pass();
    expect(enqueued).toHaveLength(1);
  });

  it('queues a moved pin’s new head afresh, and forgets a pull request that closed', async () => {
    let head = PIN_HEAD;
    let open = true;
    const { pass, enqueued } = pinHarness({
      pulls: () => (open ? [pinPull({ head: { ...pinPull().head, sha: head } })] : []),
    });
    await pass();
    head = NEWER;
    await pass();
    open = false;
    await pass();
    open = true;
    await pass();
    expect(enqueued.map(([, h]) => h)).toEqual([PIN_HEAD, NEWER, NEWER]);
  });

  it('reads no events of a pull request the pin watch did not open', async () => {
    const { pass, sent } = pinHarness({ pulls: () => [pinPull({ user: { id: MARTIN } })] });
    await pass();
    expect(calls(sent).some((s) => s.path.includes('/events'))).toBe(false);
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
      head: { ref: 'factory/pin/zap', sha: PIN_HEAD, repo: REPO },
    });
    const actions = new DryRunActions(store as never, quiet, undefined, undefined, guard, candidate);
    const { pass, sent } = pinHarness({ actions });
    await pass();
    await pass();
    expect(records.map(({ action, args }) => ({ action, args }))).toEqual([
      { action: 'enqueuePullRequest', args: { number: 1040, expectedHead: PIN_HEAD } },
    ]);
    expect(calls(sent).every((s) => s.method === 'GET')).toBe(true);
  });
});
