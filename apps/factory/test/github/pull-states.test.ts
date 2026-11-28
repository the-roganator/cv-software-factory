/**
 * The state of each pull request and issue that carries a move, as the worker serves it for the read `pulls`
 * (`pull-states.ts`): the record itself (a restart, the queue's say at a head, settled within 28 days, the cap), each
 * hold the queues give and each reason the pin watch opens an issue for, and what the pin watch records in a pass.
 */
import type { Autonomy } from '@software-factory/events';
import { MOST_PULLS, PAYLOADS } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { PATCHING } from '../../../../packages/samples/src/patching.ts';
import { verdictBlock } from '../../../../policy/review-verdict.ts';
import { LiveActions } from '../../src/github/actions.ts';
import { GitHubError } from '../../src/github/client.ts';
import type { DependencyPull } from '../../src/github/dependabot.ts';
import {
  type DeployQueueDependencies,
  type LabelEvents,
  pinQueueWatch,
  type QueuePull,
  RUN_TRIES,
  workflowPinQueueWatch,
} from '../../src/github/deploy-queue.ts';
import { APP_USER, DEPENDABOT_USER, IssueGuard, MARTIN, openedBy } from '../../src/github/issues.ts';
import type { LevelReader } from '../../src/github/level.ts';
import { type MergeQueue, REVIEW_APP, type ReviewVerdict } from '../../src/github/merging.ts';
import {
  BRANCH_HELD,
  HISTORY_UNREAD,
  issueMoveOf,
  issueOf,
  issueWhy,
  issueWhyOf,
  OPEN_REFUSED,
  PASS_MS,
  type PinScope,
  pinWatch,
  REVERTED,
  type RefusalKind,
  STEP_REFUSED,
  WITH_REVERTED,
} from '../../src/github/pins.ts';
import {
  dependabotCarries,
  lockfileName,
  namedMove,
  type PatchPull,
  type PullSource,
  PullStates,
  PullsUnread,
  pullMove,
  pullMoves,
  pullSources,
  type Seen,
} from '../../src/github/pull-states.ts';
import { actionsRunOf, type CheckRun } from '../../src/github/reads.ts';
import type { Moves, ReadMove } from '../../src/github/scanning.ts';
import { APP_REPOSITORY } from '../../src/repositories.ts';
import { client, quiet, type Route } from './fake.ts';
import { day, FACTORY, FakeRepo, FILES, move } from './pins-harness.ts';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const HEAD = 'c'.repeat(40);

/** A pin pull request as the pin watch saw it. */
const pinSeen = (number: number, over: Partial<Seen> = {}): Seen => ({
  kind: 'pin',
  number,
  moves: [{ name: 'zap', lockfile: false }],
  opened: at(NOW - DAY),
  state: 'open',
  ...over,
});

/** The day's schema, which the sense appends: what the read answers must parse as a repository's `pulls`. */
function parses(pulls: readonly PatchPull[]) {
  const [first, ...rest] = PATCHING.payload.repositories;
  return PAYLOADS['patching.read'].safeParse({
    ...PATCHING.payload,
    repositories: [{ ...first, pulls }, ...rest.map((each) => ({ ...each, pulls: [] }))],
  });
}

describe('the record of pull requests that carry moves', () => {
  const sources = (): readonly PullSource[] => ['pins', 'dependabot', 'pin-queue'];

  it('fails after a restart until each watch that writes the repository has made a pass, and never answers empty for it', () => {
    const states = new PullStates({ sources, now: () => NOW });
    expect(() => states.read(FACTORY)).toThrow(PullsUnread);
    states.saw(FACTORY, 'pins', [pinSeen(1040)]);
    states.saw(FACTORY, 'dependabot', []);
    expect(() => states.read(FACTORY)).toThrow(/pin-queue to come/);
    states.passedQueue(FACTORY, 'pin-queue', new Set([1040]));
    expect(states.read(FACTORY).pulls.map((p) => p.number)).toEqual([1040]);
    // A worker that starts again knows nothing yet: it fails again until its watches pass.
    const restarted = new PullStates({ sources, now: () => NOW });
    expect(() => restarted.read(FACTORY)).toThrow(PullsUnread);
    // Once they have, nothing open is an answer of its own.
    for (const source of ['pins', 'dependabot'] as const) restarted.saw(FACTORY, source, []);
    restarted.passedQueue(FACTORY, 'pin-queue', new Set());
    expect(restarted.read(FACTORY)).toEqual({ repository: FACTORY, pulls: [] });
  });

  it('gives an open pull request what its queue last said of it, a pass at a new head said afresh', () => {
    const states = new PullStates({ sources, now: () => NOW });
    states.saw(FACTORY, 'pins', [pinSeen(1040), pinSeen(1041, { opened: at(NOW) })]);
    states.saw(FACTORY, 'dependabot', []);
    states.say(FACTORY, 1040, HEAD, { rule: 'move', checks: { state: 'passed', try: 1, of: 3, failed: [] } }, true);
    states.say(FACTORY, 1040, HEAD, { hold: 'level' });
    states.passedQueue(FACTORY, 'pin-queue', new Set([1040, 1041]));
    const [first, second] = states.read(FACTORY).pulls;
    expect(first).toEqual({
      kind: 'pin',
      number: 1040,
      moves: [{ name: 'zap', lockfile: false }],
      opened: at(NOW - DAY),
      state: 'open',
      rule: 'move',
      checks: { state: 'passed', try: 1, of: 3, failed: [] },
      hold: 'level',
    });
    // Nothing said of it yet: none of what a queue says.
    expect(Object.keys(second ?? {}).sort()).toEqual(['kind', 'moves', 'number', 'opened', 'state']);
    // What is said at a new head is all that is said of it; a pull request the queue no longer reads is forgotten.
    states.say(FACTORY, 1040, 'e'.repeat(40), { hold: 'checks' });
    expect(states.read(FACTORY).pulls[0]).toMatchObject({ hold: 'checks' });
    expect(states.read(FACTORY).pulls[0]).not.toHaveProperty('rule');
    states.passedQueue(FACTORY, 'pin-queue', new Set([1041]));
    expect(states.read(FACTORY).pulls[0]).not.toHaveProperty('hold');
    expect(parses(states.read(FACTORY).pulls).success).toBe(true);
  });

  it('keeps what settled in the last 28 days, newest first after the open ones, and nothing older', () => {
    const states = new PullStates({ sources: () => ['pins'], now: () => NOW });
    states.saw(FACTORY, 'pins', [
      pinSeen(1, { state: 'merged', settled: at(NOW - 27 * DAY) }),
      pinSeen(2, { state: 'closed', settled: at(NOW - 29 * DAY), closedByPerson: true }),
      pinSeen(3, { state: 'merged', settled: at(NOW - DAY) }),
      pinSeen(4, { opened: at(NOW - 2 * DAY) }),
      pinSeen(5, { opened: at(NOW - 3 * DAY) }),
    ]);
    expect(states.read(FACTORY).pulls.map((p) => p.number)).toEqual([5, 4, 3, 1]);
  });

  it(`holds at most ${MOST_PULLS}, the open ones first`, () => {
    const states = new PullStates({ sources: () => ['pins'], now: () => NOW });
    const settled = Array.from({ length: 200 }, (_, i) =>
      pinSeen(1000 + i, { state: 'merged', settled: at(NOW - DAY + i) }),
    );
    const open = Array.from({ length: 200 }, (_, i) => pinSeen(i + 1, { opened: at(NOW - DAY - i) }));
    states.saw(FACTORY, 'pins', [...settled, ...open]);
    const { pulls } = states.read(FACTORY);
    expect(pulls).toHaveLength(MOST_PULLS);
    expect(pulls.filter((p) => p.state === 'open')).toHaveLength(200);
    expect(pulls.at(-1)?.number).toBe(1000 + 200 - (MOST_PULLS - 200));
  });

  it('keeps every move a pull request carried once it settles, each lockfile move said so, packages and all', () => {
    const states = new PullStates({ sources: () => ['pins'], now: () => NOW });
    const lockfile = 'a package in `pnpm-lock.yaml`';
    const carried = ['@example/tokens', 'undici', 'ws'].map((name) => ({
      name: lockfile,
      lockfile: true,
      package: name,
    }));
    states.saw(FACTORY, 'pins', [pinSeen(7, { moves: carried })]);
    // Settled, it is read from its marks, which name each lockfile move by its file alone.
    const named = carried.map(() => namedMove(lockfile));
    expect(named.every((each) => each.lockfile)).toBe(true);
    expect(pullMoves(named)).toHaveLength(3);
    states.saw(FACTORY, 'pins', [pinSeen(7, { moves: named, state: 'merged', settled: at(NOW) })]);
    expect(states.read(FACTORY).pulls[0]?.moves).toEqual(carried);
    // After a restart, the marks alone: every lockfile move kept, and said to be one.
    const restarted = new PullStates({ sources: () => ['pins'], now: () => NOW });
    restarted.saw(FACTORY, 'pins', [pinSeen(7, { moves: pullMoves(named), state: 'merged', settled: at(NOW) })]);
    expect(restarted.read(FACTORY).pulls[0]?.moves).toEqual(named);
    expect(lockfileName('a package in `pnpm-lock.yaml` and `apps/x/pnpm-lock.yaml`')).toBe(true);
    expect(lockfileName('ghcr.io/example/sbom-tool')).toBe(false);
  });

  it('keeps the hold the watch that saw it gave, where a queue says nothing of it', () => {
    const states = new PullStates({ sources: () => ['dependabot', 'workflow-queue'], now: () => NOW });
    const seen: Seen = {
      kind: 'dependabot',
      number: 81,
      moves: [{ name: 'actions/setup-node', lockfile: false }],
      opened: at(NOW),
      state: 'open',
      hold: 'martin',
    };
    states.saw(APP_REPOSITORY, 'dependabot', [seen]);
    states.say(APP_REPOSITORY, 81, HEAD, {}, true);
    states.passedQueue(APP_REPOSITORY, 'workflow-queue', new Set([81]));
    expect(states.read(APP_REPOSITORY).pulls[0]).toMatchObject({ hold: 'martin' });
  });

  it('reads the Actions run of a check from the link GitHub gives it', () => {
    expect(actionsRunOf('https://github.com/o/r/actions/runs/19220481337/job/55')).toBe(19220481337);
    expect(actionsRunOf('https://github.com/o/r/runs/55')).toBeUndefined();
    expect(actionsRunOf(null)).toBeUndefined();
  });
});

const PIN = 1040;
let ids = 0;
const run = (name: string, conclusion: string | null = 'success', over: Partial<CheckRun> = {}): CheckRun => ({
  id: ++ids,
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  app: 'github-actions',
  startedAt: null,
  completedAt: null,
  title: null,
  run: 19_220_000_000 + ids,
  ...over,
});
const REQUIRED = ['lint, types, tests', 'image builds', 'review'];
const green = () => [run('lint, types, tests'), run('image builds')];
const pinPull = (): QueuePull => ({
  number: PIN,
  title: 'chore(pin): move zap to 2.17.0',
  draft: false,
  user: { id: APP_USER },
  labels: [{ name: 'pin' }],
  head: { ref: 'factory/pin/zap', sha: HEAD, repo: { full_name: FACTORY } },
  base: { ref: 'main' },
});
const judged = (rule: string, over: object = {}): ReviewVerdict => ({
  number: PIN,
  head: HEAD,
  check: null,
  verdict: null,
  judged: { number: PIN, head: HEAD, rule, tags: [], ...over } as ReviewVerdict['judged'],
  problem: null,
});
const unjudged = (): ReviewVerdict => ({ ...judged('move'), judged: null, problem: 'no review check yet' });
const queueOf = (over: Partial<MergeQueue> = {}): MergeQueue => ({
  number: PIN,
  head: HEAD,
  state: 'open',
  queued: null,
  added: null,
  removed: null,
  checks: [],
  ...over,
});
/** The level in force, as `level.ts` reads it. */
const levelAt = (autonomy: Autonomy, stopped = false) =>
  (async () => ({ autonomy, autoMerge: true, stopped })) as unknown as LevelReader;

/** The pin queue over one pin pull request of the watch's, saying what it decides where the read serves it. */
async function pinQueue(
  o: {
    verdict?: ReviewVerdict;
    runs?: CheckRun[];
    level?: LevelReader;
    queue?: MergeQueue | (() => MergeQueue);
    passes?: number;
    reviewPages?: unknown[][];
    /** Whether the pull request is in GitHub's open list, and what `/pulls/{n}` says of it once it is not. */
    listed?: boolean;
    settled?: { state: string; merged_at: string | null; closed_at: string | null };
    conflicts?: boolean | null;
    events?: LabelEvents;
    reviews?: unknown[];
    message?: string;
    commitAgain?: boolean;
    enqueue?: () => Promise<{ position: number | null; state: string | null }>;
  } = {},
) {
  const { github } = client([
    {
      method: 'GET',
      path: /\/pulls\?state=open&per_page=100&sort=created&direction=asc&page=\d+$/,
      answer: ({ path }) => ({ body: path.endsWith('page=1') && o.listed !== false ? [pinPull()] : [] }),
    },
    {
      method: 'GET',
      path: /\/pulls\/\d+$/,
      answer: () => ({ body: o.settled ?? { state: 'open', merged_at: null, closed_at: null } }),
    },
    {
      method: 'GET',
      path: /\/issues\/\d+$/,
      answer: () => ({ body: { closed_by: { login: 'mrogan' } } }),
    },
    { method: 'GET', path: /\/pulls\?state=closed/, answer: () => ({ body: [] }) },
    {
      method: 'GET',
      path: /\/issues\/\d+\/events\?per_page=100(&page=\d+)?$/,
      answer: ({ path }) => ({
        body:
          path.endsWith('page=1') || !path.includes('page=')
            ? (o.events ?? [{ event: 'labeled', actor: { id: APP_USER }, label: { name: 'pin' } }])
            : [],
      }),
    },
    {
      method: 'GET',
      path: /\/pulls\/\d+\/reviews\?per_page=100&page=\d+$/,
      answer: ({ path }) => {
        const page = Number(/page=(\d+)$/.exec(path)?.[1]);
        return { body: o.reviewPages?.[page - 1] ?? (page === 1 ? (o.reviews ?? []) : []) };
      },
    },
    {
      method: 'GET',
      path: /\/git\/commits\/[0-9a-f]{40}$/,
      answer: () => ({ body: { message: o.message ?? 'chore(pin): move zap to 2.17.0' } }),
    },
    { method: 'GET', path: /\/issues\/\d+\/comments\?per_page=100&page=\d+$/, answer: () => ({ body: [] }) },
  ]);
  const states = new PullStates({ sources: () => ['pins', 'pin-queue'], now: () => NOW });
  states.saw(FACTORY, 'pins', [pinSeen(PIN)]);
  const written = new Map([['factory/pin/zap', HEAD]]);
  const reads: DeployQueueDependencies['reads'] = {
    reviewVerdict: async () => o.verdict ?? judged('move'),
    checkRuns: async () => o.runs ?? green(),
    requiredChecks: async () => REQUIRED,
    mergeability: async () => ({
      number: PIN,
      head: HEAD,
      conflicts: o.conflicts === undefined ? false : o.conflicts,
      state: 'clean',
    }),
    mergeQueue: async () => (typeof o.queue === 'function' ? o.queue() : (o.queue ?? queueOf())),
  };
  const pass = pinQueueWatch(
    {
      github,
      reads,
      actions: {
        enqueuePullRequest: o.enqueue ?? (async () => ({ position: 1, state: 'QUEUED' })),
        comment: async () => {},
        ...(o.commitAgain ? { commitAgain: async () => 'e'.repeat(40) } : {}),
      },
      heads: { get: (_repo, branch) => written.get(branch), set: (_repo, branch, sha) => written.set(branch, sha) },
      level: o.level ?? levelAt('guarded'),
      log: quiet,
      pulls: states,
    },
    FACTORY,
    '*',
  );
  for (let i = 0; i < (o.passes ?? 1); i++) await pass();
  const [read] = states.read(FACTORY).pulls;
  return read as PatchPull;
}

describe('each hold the queues give', () => {
  it('names the gate’s verdict: not judged yet, held, held for the changes Martin asked, or passed by his approval', async () => {
    expect((await pinQueue({ verdict: unjudged() })).hold).toBe('verdict');
    const pending = await pinQueue({ verdict: judged('held', { pending: 'test integrity' }) });
    expect(pending).toMatchObject({ hold: 'verdict' });
    expect(pending).not.toHaveProperty('rule');
    expect(await pinQueue({ verdict: judged('held') })).toMatchObject({ rule: 'held', hold: 'held' });
    const asked = [{ id: 9, user: { id: MARTIN }, state: 'CHANGES_REQUESTED', commit_id: 'd'.repeat(40) }];
    expect(await pinQueue({ verdict: judged('held'), reviews: asked })).toMatchObject({ hold: 'changes-requested' });
    // Someone else's request for changes is not Martin's, and holds as the gate's own hold.
    const theirs = [{ id: 9, user: { id: 1 }, state: 'CHANGES_REQUESTED', commit_id: HEAD }];
    expect((await pinQueue({ verdict: judged('held'), reviews: theirs })).hold).toBe('held');
    // Martin's latest review past the first hundred is read too.
    const others = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      user: { id: 1 },
      state: 'COMMENTED',
      commit_id: HEAD,
    }));
    expect(await pinQueue({ verdict: judged('held'), reviewPages: [others, asked] })).toMatchObject({
      hold: 'changes-requested',
    });
    expect(await pinQueue({ verdict: judged('martin-approved-head') })).toMatchObject({
      rule: 'martin-approved-head',
      hold: 'martin',
    });
  });

  it('names a major below Lights-out as the level’s, whatever else it waits for, as nothing queues it', async () => {
    const major = judged('major');
    expect(await pinQueue({ verdict: major, conflicts: null })).toMatchObject({ rule: 'major', hold: 'level' });
    const running = [run('lint, types, tests', null), run('image builds')];
    expect(await pinQueue({ verdict: major, runs: running })).toMatchObject({
      hold: 'level',
      checks: { state: 'running' },
    });
    expect(await pinQueue({ verdict: major, conflicts: true })).toMatchObject({ hold: 'level' });
    // At Lights-out a major queues as a move does.
    expect(await pinQueue({ verdict: major, level: levelAt('lights-out') })).toMatchObject({ queued: true });
  });

  it('says a pull request merged or closed as soon as it leaves the open list, not at the pin watch’s next pass', async () => {
    const merged = await pinQueue({
      listed: false,
      settled: { state: 'closed', merged_at: at(NOW), closed_at: at(NOW) },
    });
    expect(merged).toMatchObject({
      kind: 'pin',
      state: 'merged',
      settled: at(NOW),
      moves: [{ name: 'zap', lockfile: false }],
    });
    expect(merged).not.toHaveProperty('hold');
    const closed = await pinQueue({ listed: false, settled: { state: 'closed', merged_at: null, closed_at: at(NOW) } });
    expect(closed).toMatchObject({ state: 'closed', closedByPerson: true });
    // One GitHub still has open is left as it was.
    expect(await pinQueue({ listed: false })).toMatchObject({ state: 'open' });
  });

  it('names the level and the stop', async () => {
    expect(await pinQueue({ verdict: judged('major') })).toMatchObject({ rule: 'major', hold: 'level' });
    expect((await pinQueue({ level: levelAt('lights-out', true) })).hold).toBe('stopped');
    expect((await pinQueue({ level: levelAt('guarded', true) })).hold).toBe('stopped');
    // A stopped line at a level that does not queue the rule: it waits on Martin, not on the line.
    expect((await pinQueue({ level: levelAt('supervised', true) })).hold).toBe('level');
    expect((await pinQueue({ verdict: judged('major'), level: levelAt('guarded', true) })).hold).toBe('level');
  });

  it('names checks running, and checks failed on every try, by name and run, never a log', async () => {
    const running = await pinQueue({ runs: [run('lint, types, tests', null), run('image builds')] });
    expect(running).toMatchObject({ hold: 'checks', checks: { state: 'running', try: 1, of: 1, failed: [] } });
    // Failed, with tries left: written again, so it waits on its checks.
    const failed = run('lint, types, tests', 'failure');
    const again = await pinQueue({ runs: [failed, run('image builds')], commitAgain: true });
    expect(again).toMatchObject({
      hold: 'checks',
      checks: { state: 'failed', try: 1, of: RUN_TRIES, failed: [{ name: 'lint, types, tests', run: failed.run }] },
    });
    const spent = await pinQueue({
      runs: [failed, run('image builds')],
      commitAgain: true,
      message: `chore(pin): move zap to 2.17.0\n\nChecks-run: ${RUN_TRIES}`,
    });
    expect(spent).toMatchObject({ hold: 'checks-spent', checks: { state: 'failed', try: RUN_TRIES, of: RUN_TRIES } });
    // Another app's failed check is not the worker's to run again.
    const { run: _, ...theirs } = run('lint, types, tests', 'failure', { app: 'someone-else' });
    expect(await pinQueue({ runs: [theirs, run('image builds')], commitAgain: true })).toMatchObject({
      hold: 'checks-spent',
      checks: { failed: [] },
    });
  });

  it('names a conflict, the queue’s tries spent, a head a person took out, and a label taken off', async () => {
    expect((await pinQueue({ conflicts: true })).hold).toBe('conflict');
    // GitHub not having said is no conflict.
    expect(await pinQueue({ conflicts: null })).not.toHaveProperty('hold');
    const removed = (reason: string, person: boolean, failures: number) =>
      queueOf({
        removed: {
          at: at(NOW),
          by: person ? 'mrogan' : 'github-merge-queue',
          reason,
          commit: null,
          failures,
          person,
          atHead: true,
        },
      });
    expect((await pinQueue({ queue: removed('failed_checks', false, 3) })).hold).toBe('queue-spent');
    expect((await pinQueue({ queue: removed('manual', true, 0) })).hold).toBe('dequeued');
    const unlabelled: LabelEvents = [
      { event: 'labeled', actor: { id: APP_USER }, label: { name: 'pin' } },
      { event: 'unlabeled', actor: { id: MARTIN }, label: { name: 'pin' } },
    ];
    expect((await pinQueue({ events: unlabelled })).hold).toBe('label');
  });

  it('says a pull request in the queue is queued, and one GitHub refused is Martin’s', async () => {
    const queued = await pinQueue();
    expect(queued).toMatchObject({ rule: 'move', queued: true, checks: { state: 'passed' } });
    expect(queued).not.toHaveProperty('hold');
    const already = queueOf({ queued: { position: 1, state: 'QUEUED', enqueuedAt: at(NOW), commit: null } });
    expect(await pinQueue({ queue: already })).toMatchObject({ queued: true });
    // Added, then gone from the queue by no removal of the queue's own: the worker adds it no more.
    let read = 0;
    const left = () => (read++ === 0 ? queueOf() : queueOf({ added: { at: at(NOW), by: 'mrogan-software-factory' } }));
    const gone = await pinQueue({ queue: left, passes: 2 });
    expect(gone).toMatchObject({ hold: 'dequeued' });
    expect(gone).not.toHaveProperty('queued');
    const refused = await pinQueue({
      enqueue: async () => {
        throw new GitHubError('refused', 'no', 403);
      },
    });
    expect(refused.hold).toBe('martin');
    expect(parses([refused]).success).toBe(true);
  });

  it('names a pull request of Dependabot’s the gate held as Martin’s, and its failed checks spent at once', async () => {
    const BUMP = 'dependabot/github_actions/factory-0b5a7c9d1e';
    // The review App's check on the head, with the gate's verdict of the pull request in its summary.
    const review = (rule: string) => ({
      id: 1,
      name: 'review',
      head_sha: HEAD,
      status: 'completed',
      conclusion: rule === 'held' ? 'failure' : 'success',
      app: { id: REVIEW_APP },
      output: {
        title: 't',
        summary: verdictBlock({
          version: 1,
          commit: HEAD,
          judged: [{ number: 81, head: HEAD, rule: rule as 'held', tags: [] }],
        }),
      },
    });
    const watch = async (rule: string, runs: CheckRun[]) => {
      const routes: Route[] = [
        {
          method: 'GET',
          path: /\/pulls\?state=open&per_page=100&sort=created&direction=asc&page=\d+$/,
          answer: ({ path }) => ({
            body: path.endsWith('page=1')
              ? [
                  {
                    ...pinPull(),
                    number: 81,
                    user: { id: DEPENDABOT_USER },
                    head: { ref: BUMP, sha: HEAD, repo: { full_name: APP_REPOSITORY } },
                  },
                ]
              : [],
          }),
        },
        {
          method: 'GET',
          path: /\/check-runs\?check_name=review/,
          answer: () => ({ body: { check_runs: [review(rule)] } }),
        },
        { method: 'GET', path: /\/pulls\/81\/reviews/, answer: () => ({ body: [] }) },
      ];
      const { github } = client(routes);
      const states = new PullStates({ sources: () => ['dependabot', 'workflow-queue'], now: () => NOW });
      states.saw(APP_REPOSITORY, 'dependabot', [
        {
          kind: 'dependabot',
          number: 81,
          moves: [{ name: 'factory', lockfile: false }],
          opened: at(NOW),
          state: 'open',
        },
      ]);
      await workflowPinQueueWatch(
        {
          github,
          reads: {
            checkRuns: async () => runs,
            requiredChecks: async () => ['check', 'review'],
            mergeability: async () => ({ number: 81, head: HEAD, conflicts: false, state: 'clean' }),
            mergeQueue: async () => queueOf({ number: 81 }),
          },
          actions: { dryRun: false, enqueuePullRequest: async () => ({ position: 1, state: 'QUEUED' }) },
          level: levelAt('guarded'),
          log: quiet,
          pulls: states,
        },
        APP_REPOSITORY,
      )();
      return states.read(APP_REPOSITORY).pulls[0];
    };
    expect(await watch('held', [run('check')])).toMatchObject({ rule: 'held', hold: 'martin' });
    expect(await watch('exact-pin', [run('check', 'failure')])).toMatchObject({
      hold: 'checks-spent',
      checks: { state: 'failed', try: 1, of: 1 },
    });
  });
});

describe('each reason the pin watch opens an issue for', () => {
  const moves = {
    plain: move({
      name: 'example/tool',
      pins: [{ file: 'deploy/x.yaml', line: 3 }],
      from: '1.0.0',
      to: 'image 1.1.0',
      lane: 'issue',
    }),
    bench: move({
      name: 'example/sdk',
      pins: [{ file: 'pnpm-lock.yaml', line: 9 }],
      from: '0.4.2',
      to: 'version 0.4.3',
      lane: 'issue',
      bench: true,
    }),
    none: move({
      name: 'example/old-line',
      pins: [{ file: 'Dockerfile', line: 1 }],
      from: '1.0.0',
      to: 'another line',
      lane: 'none',
    }),
    workflow: move({
      name: 'github/codeql-action',
      pins: [{ file: '.github/workflows/v.yml', line: 8 }],
      from: 'v4.31.2',
      to: 'version v4.31.6',
      lane: 'issue',
    }),
  } satisfies Record<string, ReadMove>;
  const today = day('a'.repeat(40), Object.values(moves));
  const cases: [ReadMove, string | undefined, RefusalKind | undefined, object][] = [
    [moves.bench, undefined, undefined, { issue: 'bench' }],
    [moves.none, undefined, undefined, { issue: 'none' }],
    [moves.workflow, undefined, undefined, { issue: 'workflow' }],
    [moves.plain, undefined, undefined, { issue: 'other' }],
    [moves.plain, 'its target, x, is not a version or digest a pin’s line writes', undefined, { issue: 'other' }],
    [moves.plain, REVERTED, undefined, { issue: 'reverted' }],
    [moves.plain, WITH_REVERTED, undefined, { issue: 'with-reverted' }],
    [moves.plain, BRANCH_HELD, undefined, { issue: 'branch-held' }],
    [moves.plain, HISTORY_UNREAD, undefined, { issue: 'history-unread' }],
    [moves.plain, OPEN_REFUSED, undefined, { issue: 'open-refused' }],
    ...(['young', 'provenance', 'script', 'override', 'resolved', 'lock', 'other'] as const).map(
      (kind): [ReadMove, string, RefusalKind, object] => [
        moves.plain,
        STEP_REFUSED,
        kind,
        { issue: 'refused', refusal: kind },
      ],
    ),
  ];

  it('names each, and reads the same back from the words the App wrote, for one closed or not made today', () => {
    for (const [each, why, kind, expected] of cases) {
      expect(issueWhy(each, why, kind), `${why ?? each.name} ${kind ?? ''}`).toEqual(expected);
      const { body } = issueOf(each, today, why, kind, kind === 'resolved' ? '1.1.1' : undefined);
      expect(issueWhyOf(body), `${why ?? each.name} ${kind ?? ''}`).toEqual(expected);
      expect(issueMoveOf(body)).toEqual({ name: each.name, lockfile: false });
    }
    expect(issueWhyOf('Someone else’s words.')).toBeUndefined();
  });
});

describe('what the pin watch records in a pass', () => {
  const lockfile: ReadMove = move({
    name: 'a package in `pnpm-lock.yaml`',
    pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
    from: '',
    to: '',
    lockfile: true,
    lane: 'issue',
    mark: '3f9a1c0b7e2d',
    withheld: { package: '@example/tokens', from: '3.0.1', to: '3.0.2', pins: [{ file: 'pnpm-lock.yaml', line: 2 }] },
  });
  const workflow: ReadMove = move({
    name: 'actions/setup-node',
    pins: [{ file: '.github/workflows/platform.yml', line: 2 }],
    from: 'v6.0.0',
    to: 'version v6.1.0',
    lane: 'issue',
  });

  function harness(
    repo: FakeRepo,
    moves: ReadMove[],
    dependencyPulls: () => DependencyPull[],
    o: { only?: PinScope; today?: () => Promise<Moves> } = {},
  ) {
    // The App's `pin` items as GitHub lists them: its issues and pull requests, with their times.
    const listed: Route = {
      method: 'GET',
      path: new RegExp(`^/repos/${FACTORY}/issues\\?state=all&labels=pin`),
      answer: ({ path }) => ({
        body: path.endsWith('page=1')
          ? [
              ...repo.issues.map((i) => ({
                number: i.number,
                title: i.title,
                state: i.state,
                body: i.body,
                user: { login: i.user },
                created_at: at(NOW - 10 * DAY),
                closed_at: i.state === 'closed' ? at(NOW - 2 * DAY) : null,
              })),
              ...repo.pulls
                .filter((p) => p.labels.includes('pin'))
                .map((p) => ({
                  number: p.number,
                  title: p.title,
                  state: p.state,
                  body: p.body,
                  user: { login: p.user },
                  pull_request: { merged_at: p.merged_at },
                  created_at: at(NOW - 40 * DAY),
                  closed_at: p.merged_at,
                })),
            ]
          : [],
      }),
    };
    const { github } = client([listed, ...repo.routes()]);
    const guard = new IssueGuard({ openedBy: openedBy(github) });
    const states = new PullStates({ sources: () => ['pins', 'dependabot'], now: () => clock });
    let clock = NOW;
    const watch = pinWatch(
      {
        github,
        reads: {
          moves: o.today ?? (async () => day(repo.main, moves)),
          dependencyPulls: async () => dependencyPulls(),
        },
        actions: new LiveActions(github, { guard }),
        log: quiet,
        now: () => clock,
        only: o.only ?? '*',
        pulls: states,
      },
      FACTORY,
    );
    return {
      states,
      pass: async () => {
        clock += PASS_MS;
        await watch();
        return states.read(FACTORY).pulls;
      },
    };
  }

  it('records the issues it opens and keeps, the pull requests settled in 28 days, and Dependabot’s for a pin of the day', async () => {
    const repo = new FakeRepo(FILES);
    const marks = (names: string[]) => `<!-- factory: pin-moves ${encodeURIComponent(JSON.stringify(names))} -->`;
    const merged = repo.addPull({
      head: 'factory/pin/zap',
      labels: ['pin'],
      state: 'closed',
      body: marks(['zap']),
      merged_at: at(NOW - 3 * DAY),
    });
    repo.addPull({
      head: 'factory/pin/old',
      labels: ['pin'],
      state: 'closed',
      body: marks(['old']),
      merged_at: at(NOW - 30 * DAY),
    });
    // An issue Martin closed, of a move the day no longer lists.
    const closed = repo.addIssue({
      labels: ['pin'],
      state: 'closed',
      closed_by: 'mrogan',
      body: issueOf({ ...workflow, name: 'actions/checkout' }, day(repo.main, [workflow]), REVERTED).body,
    });
    const bump = repo.addPull({ head: 'dependabot/github_actions/actions/setup-node-6.1.0', user: 'dependabot[bot]' });
    const dependabot: DependencyPull = {
      number: bump.number,
      head: { ref: bump.head, sha: HEAD },
      draft: false,
      createdAt: at(NOW - DAY),
      ecosystem: 'github-actions',
      directory: '/',
      dependency: 'actions/setup-node',
      version: '6.1.0',
      changed: [],
      unread: [],
    };
    let open = [dependabot];
    const h = harness(repo, [lockfile, workflow], () => open);
    const first = await h.pass();
    const issues = repo.issues.filter((i) => i.state === 'open');
    expect(issues).toHaveLength(2);
    const byNumber = new Map(first.map((p) => [p.number, p]));
    expect(byNumber.get(merged.number)).toMatchObject({
      kind: 'pin',
      state: 'merged',
      moves: [{ name: 'zap', lockfile: false }],
    });
    expect(first.some((p) => p.moves.some((m) => m.name === 'old'))).toBe(false);
    expect(byNumber.get(closed.number)).toMatchObject({
      kind: 'issue',
      state: 'closed',
      closedByPerson: true,
      issue: 'reverted',
      moves: [{ name: 'actions/checkout', lockfile: false }],
    });
    const opened = first.filter((p) => p.kind === 'issue' && p.state === 'open');
    expect(opened.map((p) => p.moves)).toEqual(
      expect.arrayContaining([
        [{ name: lockfile.name, lockfile: true, package: '@example/tokens' }],
        [{ name: 'actions/setup-node', lockfile: false }],
      ]),
    );
    expect(opened.map((p) => p.issue).sort()).toEqual(['other', 'workflow']);
    expect(byNumber.get(bump.number)).toMatchObject({
      kind: 'dependabot',
      state: 'open',
      hold: 'martin',
      moves: [{ name: 'actions/setup-node', lockfile: false }],
    });
    expect(parses(first).success).toBe(true);

    // The next pass reads the issues it opened as GitHub lists them; Dependabot's, merged, is settled.
    bump.state = 'closed';
    bump.merged_at = at(NOW);
    open = [];
    const second = await h.pass();
    const again = second.filter((p) => p.kind === 'issue' && p.state === 'open');
    expect(again.map((p) => p.number).sort()).toEqual(issues.map((i) => i.number).sort());
    expect(again.find((p) => p.issue === 'other')?.moves).toEqual([
      { name: lockfile.name, lockfile: true, package: '@example/tokens' },
    ]);
    expect(second.find((p) => p.number === bump.number)).toMatchObject({ state: 'merged', settled: at(NOW) });
    expect(parses(second).success).toBe(true);
  });

  it('matches Dependabot’s pull requests to the day’s moves by the pin its branch names, or the lines a group’s rewrites', () => {
    const pull = (over: Partial<DependencyPull>): DependencyPull => ({
      number: 5,
      head: { ref: 'dependabot/x', sha: HEAD },
      draft: false,
      createdAt: at(NOW),
      ecosystem: 'npm',
      directory: '/',
      dependency: null,
      version: null,
      changed: [],
      unread: [],
      ...over,
    });
    const image = move({
      name: 'ghcr.io/example/sbom-tool',
      pins: [{ file: 'deploy/images/sbom-tool/Dockerfile', line: 2 }],
      from: 'v1.54.0',
      to: 'image v1.57.1',
      lane: 'worker',
    });
    const all = [lockfile, workflow, image];
    const names = (p: DependencyPull) => dependabotCarries(p, all).map((m) => m.name);
    expect(names(pull({ dependency: '@example/tokens', version: '3.0.2' }))).toEqual([lockfile.name]);
    expect(dependabotCarries(pull({ dependency: '@example/tokens' }), all).map(pullMove)).toEqual([
      { name: lockfile.name, lockfile: true, package: '@example/tokens' },
    ]);
    expect(names(pull({ ecosystem: 'github-actions', dependency: 'actions/setup-node' }))).toEqual([workflow.name]);
    expect(
      names(pull({ ecosystem: 'docker', directory: '/deploy/images/sbom-tool', dependency: 'example/sbom-tool' })),
    ).toEqual([image.name]);
    expect(names(pull({ ecosystem: 'docker', directory: '/elsewhere', dependency: 'example/sbom-tool' }))).toEqual([]);
    const group = pull({
      changed: [
        { file: 'deploy/images/sbom-tool/Dockerfile', line: 2, before: 'FROM x:v1.54.0', after: 'FROM x:v1.57.1' },
      ],
    });
    expect(names(group)).toEqual([image.name]);
  });

  describe('a pass that makes nothing still makes the read ready, with what GitHub lists', () => {
    const marks = (names: string[]) => `<!-- factory: pin-moves ${encodeURIComponent(JSON.stringify(names))} -->`;
    const fixture = () => {
      const repo = new FakeRepo(FILES);
      const open = repo.addPull({ head: 'factory/pin/zap', labels: ['pin'], body: marks(['zap']) });
      const merged = repo.addPull({
        head: 'factory/pin/old',
        labels: ['pin'],
        state: 'closed',
        body: marks(['old']),
        merged_at: at(NOW - DAY),
      });
      // The lockfile's pull requests as the pin step names their moves, open: a lockfile at two files with an image the
      // step makes with it, and the lockfile's routine updates and routine majors on branches of their own.
      const both = 'a package in `deploy/overlays/local/factory-image/kustomization.yaml` and `pnpm-lock.yaml`';
      const lock = 'a package in `pnpm-lock.yaml`';
      const step = [
        repo.addPull({
          head: 'factory/pin/pnpm-lock.yaml-46deb745',
          labels: ['pin'],
          body: marks([both, 'mcr.microsoft.com/playwright', both, both]),
        }),
        repo.addPull({
          head: 'factory/pin/pnpm-lock.yaml-routine-major-46deb745',
          labels: ['pin'],
          body: marks([lock]),
        }),
        repo.addPull({
          head: 'factory/pin/pnpm-lock.yaml-routine-46deb745',
          labels: ['pin'],
          body: marks([lock, lock, lock, lock]),
        }),
      ];
      // The day's lockfile moves, merged in one pull request and named by its marks alone; and a lockfile move's issue.
      const lockfiles = repo.addPull({
        head: 'factory/pin/pnpm-lock.yaml',
        labels: ['pin'],
        state: 'closed',
        body: marks([lockfile.name, lockfile.name]),
        merged_at: at(NOW - DAY),
      });
      const issue = repo.addIssue({ labels: ['pin'], body: issueOf(lockfile, day(repo.main, [lockfile])).body });
      return { repo, open, merged, lockfiles, issue, step };
    };
    const expectStep = (pulls: PatchPull[], step: { number: number }[]) => {
      const [both, major, routine] = step.map((each) => pulls.find((p) => p.number === each.number));
      expect(both?.moves.map((m) => m.lockfile)).toEqual([true, false, true, true]);
      expect(major).toMatchObject({
        state: 'open',
        moves: [{ name: 'a package in `pnpm-lock.yaml`', lockfile: true }],
      });
      expect(routine?.moves).toHaveLength(4);
    };
    const expectLockfiles = (pulls: PatchPull[], lockfiles: number, issue: number) => {
      const lockfileMove = { name: lockfile.name, lockfile: true };
      expect(pulls.find((p) => p.number === lockfiles)?.moves).toEqual([lockfileMove, lockfileMove]);
      expect(pulls.find((p) => p.number === issue)).toMatchObject({ kind: 'issue', moves: [lockfileMove] });
    };
    const expectListed = (pulls: PatchPull[], open: number, merged: number) => {
      expect(pulls.find((p) => p.number === open)).toMatchObject({
        kind: 'pin',
        state: 'open',
        moves: [{ name: 'zap', lockfile: false }],
      });
      expect(pulls.find((p) => p.number === merged)).toMatchObject({
        state: 'merged',
        moves: [{ name: 'old', lockfile: false }],
      });
      expect(parses(pulls).success).toBe(true);
    };

    it('told no move', async () => {
      const { repo, open, merged, lockfiles, issue, step } = fixture();
      const h = harness(repo, [], () => [], { only: [] });
      const pulls = await h.pass();
      expectListed(pulls, open.number, merged.number);
      expectLockfiles(pulls, lockfiles.number, issue.number);
      expectStep(pulls, step);
      // Its queue, told none too, has made its pass.
      const states = new PullStates({ sources: () => ['pin-queue'], now: () => NOW });
      const { github } = client([]);
      await pinQueueWatch(
        {
          github,
          reads: {} as DeployQueueDependencies['reads'],
          actions: { enqueuePullRequest: async () => ({ position: 1, state: 'QUEUED' }) },
          heads: { get: () => undefined },
          level: levelAt('guarded'),
          log: quiet,
          pulls: states,
        },
        FACTORY,
        [],
      )();
      expect(states.read(FACTORY).pulls).toEqual([]);
    });

    it('on a day the scan wrote no moves.json, or whose moves cannot be read', async () => {
      const { repo, open, merged, lockfiles, issue, step } = fixture();
      const h = harness(repo, [], () => [], { today: async () => ({ ...day(repo.main, []), file: null }) });
      const pulls = await h.pass();
      expectListed(pulls, open.number, merged.number);
      expectLockfiles(pulls, lockfiles.number, issue.number);
      expectStep(pulls, step);
      const failing = harness(repo, [], () => [], {
        today: async () => {
          throw new Error('the state cannot be read');
        },
      });
      await expect(failing.pass()).rejects.toThrow('the state cannot be read');
      // Dependabot's waits on no day; the pin pull requests and issues are said all the same.
      failing.states.saw(FACTORY, 'dependabot', []);
      expectListed(failing.states.read(FACTORY).pulls, open.number, merged.number);
    });

    it('in a worker that cannot write, which runs no watch: it answers at once', () => {
      const writes = (w: boolean) => pullSources(FACTORY, { writes: w, pinRepos: [FACTORY], workflowPinRepos: [] });
      expect(writes(true)).toEqual(['pins', 'dependabot', 'pin-queue']);
      expect(writes(false)).toEqual([]);
      const states = new PullStates({ sources: () => writes(false), now: () => NOW });
      expect(states.read(FACTORY)).toEqual({ repository: FACTORY, pulls: [] });
    });
  });
});
