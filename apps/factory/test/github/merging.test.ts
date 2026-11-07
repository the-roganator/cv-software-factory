import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { type Judged, verdictBlock } from '../../../../policy/review-verdict.ts';
import { REVIEW_APP as RULESET_REVIEW_APP } from '../../../../scripts/github-settings.ts';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { BranchRefused } from '../../src/github/branches.ts';
import { GitHubError } from '../../src/github/client.ts';
import { DRY_RUN_CHECK_TITLE, DryRunReads } from '../../src/github/dry-run-reads.ts';
import { APP_USER, IssueGuard, IssueRefused, MARTIN } from '../../src/github/issues.ts';
import { REVIEW_APP } from '../../src/github/merging.ts';
import { LiveReads, type Reads } from '../../src/github/reads.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker, GitHubWorkerError } from '../../src/github/worker-client.ts';
import { verifyRefusal } from '../../src/signed-refusals.ts';
import { calls, client, OTHER_SHA, quiet, REPO, type Route, type Sent, SHA } from './fake.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const AT = () => new Date('2026-11-04T12:00:00Z');
/** The factory's own App, which may post a check named `review` too. */
const FACTORY_APP = 5187559;
const BRANCH = 'factory/1400-cart';

/** A guard that knows who opened each pull request: the App opened every one but #121, which Martin opened. */
const guard = (recorder?: RefusalRecorder) =>
  new IssueGuard({
    openedBy: async (_repo, number) => ({ by: number === 121 ? MARTIN : APP_USER, pullRequest: true }),
    recorder,
  });

/** A pull request as GitHub has it. */
function pull(
  number: number,
  { ref = BRANCH, sha = SHA, fork = false, state = 'open', draft = false, mergeable = true as boolean | null } = {},
) {
  return {
    number,
    state,
    merged: false,
    merge_commit_sha: null,
    merged_by: null,
    draft,
    node_id: `PR_node_${number}`,
    head: { ref, sha, repo: { full_name: fork ? 'someone/fork' : REPO } },
    base: { ref: 'main', sha: OTHER_SHA },
    mergeable,
    mergeable_state: mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
  };
}

const pullRoute = (number: number, options: Parameters<typeof pull>[1] = {}): Route => ({
  method: 'GET',
  path: `/repos/${REPO}/pulls/${number}`,
  answer: () => ({ body: pull(number, options) }),
});

const ENQUEUED = { data: { enqueuePullRequest: { mergeQueueEntry: { position: 2, state: 'QUEUED' } } } };

describe('adding a pull request to the merge queue', () => {
  it('adds the App’s own, by the id GitHub gives it, at the head the line names', async () => {
    const sent: Sent[] = [];
    const { github } = client(
      [pullRoute(17), { method: 'POST', path: '/graphql', answer: () => ({ body: ENQUEUED }) }],
      sent,
    );
    const actions = new LiveActions(github, { guard: guard() });
    expect(await actions.enqueuePullRequest(REPO, 17, SHA)).toEqual({ position: 2, state: 'QUEUED' });
    const mutation = calls(sent).find((s) => s.path === '/graphql');
    expect(mutation?.body).toMatchObject({
      query: expect.stringContaining('enqueuePullRequest'),
      variables: { input: { pullRequestId: 'PR_node_17', expectedHeadOid: SHA } },
    });
  });

  it.each([
    ['a red-team attack’s branch', { ref: 'factory/red-team-test-1a2b3c4d' }, /red-team attack's branch/],
    ['a branch the factory does not own', { ref: 'feat/cart' }, /is not the factory's/],
    ['a fork’s branch of the factory’s name', { fork: true }, /is not from a branch of/],
  ])('refuses %s before GitHub is asked to queue it', async (_what, options, message) => {
    const sent: Sent[] = [];
    const { github } = client([pullRoute(17, options)], sent);
    const actions = new LiveActions(github, { guard: guard() });
    const refused = await actions.enqueuePullRequest(REPO, 17, SHA).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(BranchRefused);
    expect((refused as Error).message).toMatch(message);
    expect(calls(sent).some((s) => s.path === '/graphql')).toBe(false);
  });

  it('refuses a pull request the App did not open, without reading it', async () => {
    const sent: Sent[] = [];
    const { github } = client([pullRoute(121)], sent);
    const actions = new LiveActions(github, { guard: guard() });
    await expect(actions.enqueuePullRequest(REPO, 121, SHA)).rejects.toBeInstanceOf(IssueRefused);
    expect(calls(sent)).toEqual([]);
  });

  it.each([
    ['moved on since the verdict', { sha: OTHER_SHA }, /is at bbbbbbb, not aaaaaaa/],
    ['closed', { state: 'closed' }, /is not open/],
    ['a draft', { draft: true }, /is a draft/],
  ])('leaves one %s, as a conflict the line looks at again', async (_what, options, message) => {
    const sent: Sent[] = [];
    const { github } = client([pullRoute(17, options)], sent);
    const actions = new LiveActions(github, { guard: guard() });
    const failed = await actions.enqueuePullRequest(REPO, 17, SHA).catch((error: unknown) => error);
    expect(failed).toMatchObject({ kind: 'conflict', status: 409 });
    expect((failed as Error).message).toMatch(message);
    expect(calls(sent).some((s) => s.path === '/graphql')).toBe(false);
  });

  it('keeps GitHub’s refusal of the token as GitHub’s', async () => {
    const { github } = client([
      pullRoute(17),
      {
        method: 'POST',
        path: '/graphql',
        answer: () => ({
          body: { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] },
        }),
      },
    ]);
    const actions = new LiveActions(github, { guard: guard() });
    await expect(actions.enqueuePullRequest(REPO, 17, SHA)).rejects.toMatchObject({ kind: 'refused', status: 403 });
  });
});

describe('adding to the merge queue over HTTP', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function serve(routes: Route[]) {
    const dir = await mkdtemp(join(tmpdir(), 'merging-'));
    const recorder = new RefusalRecorder({ artifacts: new DiskArtifacts(dir), key: privateKey, log: quiet, now: AT });
    const sent: Sent[] = [];
    const { github } = client(routes, sent);
    const server = createWorkerServer({
      actions: new LiveActions(github, { guard: guard(recorder) }),
      repositories: [REPO],
      health: () => ({}),
      recorder,
      log: quiet,
    });
    const { url } = await listenLocal(server);
    close = () => server.close();
    return { worker: new GitHubWorker(url), sent, dir };
  }

  it('answers a red-team branch 422, its refusal signed as the guard’s, for guardrail 1', async () => {
    const { worker, sent } = await serve([pullRoute(17, { ref: 'factory/red-team-workflow' })]);
    const failed = await worker
      .act('enqueuePullRequest', REPO, { number: 17, expectedHead: SHA })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(GitHubWorkerError);
    expect(failed).toMatchObject({ status: 422, kind: 'branch-refused' });
    expect(verifyRefusal(publicKey, (failed as GitHubWorkerError).refusal)).toMatchObject({
      ok: true,
      refusal: {
        repo: REPO,
        number: 17,
        payload: {
          mechanism: 'github-guard',
          action: `enqueuePullRequest #17 in ${REPO}`,
          guardrails: [1],
        },
      },
    });
    expect(calls(sent).some((s) => s.path === '/graphql')).toBe(false);
  });

  it('answers a pull request Martin opened 403, its refusal signed, for guardrail 10', async () => {
    const { worker } = await serve([]);
    const failed = await worker
      .act('enqueuePullRequest', REPO, { number: 121, expectedHead: SHA })
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ status: 403, kind: 'issue-refused' });
    expect(verifyRefusal(publicKey, (failed as GitHubWorkerError).refusal)).toMatchObject({
      ok: true,
      refusal: { payload: { mechanism: 'github-guard', guardrails: [10] } },
    });
  });

  it('refuses another repository, and a head that is not a commit, at the door', async () => {
    const { worker, sent } = await serve([]);
    const other = worker.act('enqueuePullRequest', 'the-roganator/cv-software-factory-private', {
      number: 17,
      expectedHead: SHA,
    });
    await expect(other).rejects.toMatchObject({ status: 400, kind: 'bad-request' });
    const short = worker.act('enqueuePullRequest', REPO, { number: 17, expectedHead: 'aaaaaaa' });
    await expect(short).rejects.toMatchObject({ status: 400, kind: 'bad-request' });
    expect(calls(sent)).toEqual([]);
  });

  it('queues the App’s pull request and answers its place', async () => {
    const { worker } = await serve([
      pullRoute(17),
      { method: 'POST', path: '/graphql', answer: () => ({ body: ENQUEUED }) },
    ]);
    expect(await worker.act('enqueuePullRequest', REPO, { number: 17, expectedHead: SHA })).toEqual({
      position: 2,
      state: 'QUEUED',
    });
  });
});

/** A `review` check run as GitHub lists it on a commit. */
function reviewRun(
  id: number,
  {
    app = REVIEW_APP,
    head = SHA,
    name = 'review',
    conclusion = 'success' as string | null,
    judged = [{ number: 17, head: SHA, rule: 'low-risk', tags: [] }] as Judged[],
    summary = undefined as string | undefined,
  } = {},
) {
  return {
    id,
    name,
    head_sha: head,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    app: { id: app, slug: app === REVIEW_APP ? 'the-roganator-review-gate' : 'mrogan-software-factory' },
    completed_at: conclusion === null ? null : '2026-11-04T11:30:00Z',
    html_url: `https://github.com/${REPO}/runs/${id}`,
    output: {
      title: conclusion === 'failure' ? 'Held for Martin: it removes a test' : 'Passes',
      summary: summary ?? `The rule.\n\n${verdictBlock({ version: 1, commit: SHA, judged })}`,
    },
  };
}

function reads(
  runs: unknown[],
  { recorder, sent = [], pulls = [17] }: { recorder?: RefusalRecorder; sent?: Sent[]; pulls?: number[] } = {},
) {
  const { github } = client(
    [
      ...pulls.map((number) => pullRoute(number)),
      {
        method: 'GET',
        path: `/repos/${REPO}/commits/${SHA}/check-runs?check_name=review&filter=all&per_page=100`,
        answer: () => ({ body: { total_count: runs.length, check_runs: runs } }),
      },
    ],
    sent,
  );
  return new LiveReads(github, undefined, recorder ? { recorder } : {});
}

describe('the review gate’s verdict', () => {
  it('is the review App’s, which the ruleset requires the check from', () => {
    expect(REVIEW_APP).toBe(RULESET_REVIEW_APP);
  });

  it('reads the review App’s latest run on the head, and its verdict for the pull request at that head', async () => {
    const read = await reads([
      reviewRun(300, { conclusion: 'failure', judged: [{ number: 17, head: SHA, rule: 'held', tags: [] }] }),
      reviewRun(301),
    ]).reviewVerdict(REPO, 17);
    expect(read).toMatchObject({
      number: 17,
      head: SHA,
      check: { id: 301, status: 'completed', conclusion: 'success' },
      judged: { number: 17, head: SHA, rule: 'low-risk', tags: [] },
      problem: null,
    });
    expect(read.refusal).toBeUndefined();
  });

  it('ignores a `review` check the factory’s App posted, whatever it says, even the latest', async () => {
    const read = await reads([
      reviewRun(300, { conclusion: 'failure', judged: [{ number: 17, head: SHA, rule: 'held', tags: [] }] }),
      reviewRun(301, { app: FACTORY_APP }),
    ]).reviewVerdict(REPO, 17);
    expect(read.check?.id).toBe(300);
    expect(read.judged?.rule).toBe('held');
  });

  it('has no verdict when the review App has posted only for an older head, or only another app has', async () => {
    const older = await reads([reviewRun(300, { head: OTHER_SHA })]).reviewVerdict(REPO, 17);
    expect(older).toMatchObject({ check: null, judged: null, problem: expect.stringContaining('no review check') });
    const foreign = await reads([reviewRun(300, { app: FACTORY_APP })]).reviewVerdict(REPO, 17);
    expect(foreign).toMatchObject({ check: null, judged: null });
  });

  it.each([
    ['a run still going', { conclusion: null }, 'the review check has not concluded'],
    ['a summary with no verdict', { summary: 'Passes.' }, 'the summary carries no verdict'],
    [
      'a verdict for another pull request',
      { judged: [{ number: 18, head: SHA, rule: 'low-risk', tags: [] }] as Judged[] },
      'the verdict does not judge #17 at its head',
    ],
    [
      'a verdict for an older head',
      { judged: [{ number: 17, head: OTHER_SHA, rule: 'low-risk', tags: [] }] as Judged[] },
      'the verdict does not judge #17 at its head',
    ],
    [
      'a run that failed with a rule that passes',
      { conclusion: 'failure' },
      "the check's conclusion, failure, is not its rule's",
    ],
    [
      'a run cancelled with a rule that holds',
      { conclusion: 'cancelled', judged: [{ number: 17, head: SHA, rule: 'held', tags: [] }] as Judged[] },
      'the review check concluded cancelled',
    ],
  ])('has no verdict to trust from %s', async (_what, options, problem) => {
    const read = await reads([reviewRun(300, options)]).reviewVerdict(REPO, 17);
    expect(read).toMatchObject({ judged: null, problem });
  });

  it('carries the gate’s refusal of a held pull request, signed once for the run however often it is read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merging-'));
    const logged: Record<string, unknown>[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => void logged.push(JSON.parse(line)) });
    const recorder = new RefusalRecorder({ artifacts: new DiskArtifacts(dir), key: privateKey, log, now: AT });
    const held = reviewRun(300, {
      conclusion: 'failure',
      judged: [
        { number: 17, head: SHA, rule: 'held', tags: [{ tag: 'test-loosening', because: ['test/cart.test.ts'] }] },
      ],
    });
    const live = reads([held], { recorder });
    const first = await live.reviewVerdict(REPO, 17);
    const again = await live.reviewVerdict(REPO, 17);
    expect(again.refusal).toEqual(first.refusal);
    expect(verifyRefusal(publicKey, first.refusal)).toMatchObject({
      ok: true,
      refusal: {
        repo: REPO,
        number: 17,
        // When the check concluded, so a worker started again keeps the same record.
        at: '2026-11-04T11:30:00.000Z',
        payload: {
          mechanism: 'review-gate',
          action: `Merge pull request #17 at aaaaaaa in ${REPO}`,
          // The gate's words alone: the verdict's block is for the line, not for the console to show.
          output: 'Held for Martin: it removes a test\n\nThe rule.',
          guardrails: [2],
          subject: { kind: 'commit', name: SHA },
        },
      },
    });
    expect(await readdir(dir)).toHaveLength(1);
    expect(logged.filter((l) => l.mechanism === 'review-gate')).toHaveLength(1);
  });

  it('signs each held pull request a run judges its own refusal, as one run judges every pull request of a stack', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merging-'));
    const recorder = new RefusalRecorder({ artifacts: new DiskArtifacts(dir), key: privateKey, log: quiet, now: AT });
    const tags = [{ tag: 'test-loosening' as const, because: ['test/cart.test.ts'] }];
    const held = reviewRun(300, {
      conclusion: 'failure',
      judged: [
        { number: 17, head: SHA, rule: 'held', tags },
        { number: 18, head: SHA, rule: 'held', tags },
      ],
    });
    const live = reads([held], { recorder, pulls: [17, 18] });
    const first = await live.reviewVerdict(REPO, 17);
    const second = await live.reviewVerdict(REPO, 18);
    expect(verifyRefusal(publicKey, first.refusal)).toMatchObject({ ok: true, refusal: { number: 17 } });
    expect(verifyRefusal(publicKey, second.refusal)).toMatchObject({
      ok: true,
      refusal: { number: 18, payload: { action: `Merge pull request #18 at aaaaaaa in ${REPO}` } },
    });
    expect(await readdir(dir)).toHaveLength(2);
  });

  it('shows a pull request held for Martin’s code alone under guardrail 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merging-'));
    const recorder = new RefusalRecorder({ artifacts: new DiskArtifacts(dir), key: privateKey, log: quiet, now: AT });
    const held = reviewRun(300, {
      conclusion: 'failure',
      judged: [{ number: 17, head: SHA, rule: 'held', tags: [{ tag: 'code-owned', because: ['.github/CODEOWNERS'] }] }],
    });
    const read = await reads([held], { recorder }).reviewVerdict(REPO, 17);
    expect(read.refusal?.payload).toMatchObject({ mechanism: 'review-gate', guardrails: [1] });
  });

  it('signs no refusal for a hold the gate marked pending, which only waits for it to judge again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merging-'));
    const recorder = new RefusalRecorder({ artifacts: new DiskArtifacts(dir), key: privateKey, log: quiet, now: AT });
    const pending = 'test integrity is still running at aaaaaaa';
    const waits = reviewRun(300, {
      conclusion: 'failure',
      judged: [{ number: 17, head: SHA, rule: 'held', tags: [], pending }],
    });
    const read = await reads([waits], { recorder }).reviewVerdict(REPO, 17);
    // The verdict is read whole, pending and all, for the line to wait on.
    expect(read).toMatchObject({ judged: { rule: 'held', pending }, problem: null });
    expect(read.refusal).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it('signs nothing for a failed run whose verdict cannot be trusted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merging-'));
    const recorder = new RefusalRecorder({ artifacts: new DiskArtifacts(dir), key: privateKey, log: quiet, now: AT });
    const read = await reads([reviewRun(300, { conclusion: 'failure', summary: 'Re-run it.' })], {
      recorder,
    }).reviewVerdict(REPO, 17);
    expect(read.refusal).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });
});

/** GitHub's answer to the queue's GraphQL read. */
function queueAnswer({
  entry = null as unknown,
  events = [] as unknown[],
  state = 'OPEN',
}: {
  entry?: unknown;
  events?: unknown[];
  state?: string;
}) {
  return {
    data: {
      repository: {
        pullRequest: { headRefOid: SHA, state, mergeQueueEntry: entry, timelineItems: { nodes: events } },
      },
    },
  };
}

const QUEUE_COMMIT = 'c'.repeat(40);
const added = (at: string, by = 'mrogan-software-factory') => ({
  __typename: 'AddedToMergeQueueEvent',
  createdAt: at,
  actor: { login: by },
});
const removed = (at: string, reason: string) => ({
  __typename: 'RemovedFromMergeQueueEvent',
  createdAt: at,
  reason,
  actor: { login: 'github-merge-queue' },
  beforeCommit: { oid: QUEUE_COMMIT },
});

function queueReads(answer: unknown, sent: Sent[] = []) {
  const { github } = client(
    [
      { method: 'POST', path: '/graphql', answer: () => ({ body: answer }) },
      {
        method: 'GET',
        path: `/repos/${REPO}/commits/${QUEUE_COMMIT}/check-runs?per_page=100`,
        answer: () => ({
          body: {
            check_runs: [
              {
                id: 1,
                name: 'browser tests',
                status: 'completed',
                conclusion: 'failure',
                app: { slug: 'github-actions' },
              },
              { id: 2, name: 'review', status: 'completed', conclusion: 'success', app: { slug: 'review' } },
            ],
          },
        }),
      },
      {
        method: 'GET',
        path: `/repos/${REPO}/check-runs/1/annotations?per_page=50`,
        answer: () => ({
          body: [{ path: '.github', annotation_level: 'failure', message: 'console browser (1/4) failed' }],
        }),
      },
    ],
    sent,
  );
  return new LiveReads(github);
}

describe('the merge queue', () => {
  it('reads a queued pull request’s place, and the queue’s checks on its commit', async () => {
    const sent: Sent[] = [];
    const read = await queueReads(
      queueAnswer({
        entry: {
          position: 1,
          state: 'AWAITING_CHECKS',
          enqueuedAt: '2026-11-04T11:40:00Z',
          headCommit: { oid: QUEUE_COMMIT },
        },
        events: [added('2026-11-04T11:40:00Z')],
      }),
      sent,
    ).mergeQueue(REPO, 17);
    expect(read).toMatchObject({
      number: 17,
      head: SHA,
      state: 'open',
      queued: { position: 1, state: 'AWAITING_CHECKS', enqueuedAt: '2026-11-04T11:40:00Z', commit: QUEUE_COMMIT },
      added: { at: '2026-11-04T11:40:00Z', by: 'mrogan-software-factory' },
      removed: null,
    });
    expect(read.checks.map((c) => c.name)).toEqual(['browser tests', 'review']);
    expect(calls(sent).find((s) => s.path === '/graphql')?.body).toMatchObject({
      variables: { owner: 'the-roganator', name: 'cv-worlds-worst-website', number: 17 },
    });
  });

  it('reads why it left the queue, and what the queue’s failed check said', async () => {
    const read = await queueReads(
      queueAnswer({ events: [added('2026-11-04T11:40:00Z'), removed('2026-11-04T11:46:00Z', 'failed_checks')] }),
    ).mergeQueue(REPO, 17);
    expect(read).toMatchObject({
      queued: null,
      removed: { at: '2026-11-04T11:46:00Z', by: 'github-merge-queue', reason: 'failed_checks', commit: QUEUE_COMMIT },
    });
    expect(read.checks[0]).toMatchObject({
      name: 'browser tests',
      conclusion: 'failure',
      annotations: [{ path: '.github', message: 'console browser (1/4) failed' }],
    });
  });

  it('says nothing of a removal once it has gone back in, and nothing of a queue it never joined', async () => {
    const back = await queueReads(
      queueAnswer({
        events: [
          added('2026-11-04T11:40:00Z'),
          removed('2026-11-04T11:46:00Z', 'failed_checks'),
          added('2026-11-04T11:50:00Z'),
        ],
      }),
    ).mergeQueue(REPO, 17);
    expect(back).toMatchObject({ removed: null, added: { at: '2026-11-04T11:50:00Z' }, checks: [] });
    const never = await queueReads(queueAnswer({})).mergeQueue(REPO, 17);
    expect(never).toMatchObject({ queued: null, added: null, removed: null, checks: [] });
  });

  it('is GitHub’s not found for a pull request it does not have', async () => {
    const answer = { data: { repository: { pullRequest: null } } };
    await expect(queueReads(answer).mergeQueue(REPO, 17)).rejects.toBeInstanceOf(GitHubError);
  });
});

describe('a conflict with the base', () => {
  it.each([
    [true, false, 'clean'],
    [false, true, 'dirty'],
    [null, null, 'unknown'],
  ] as const)('reads mergeable %s as conflicts %s', async (mergeable, conflicts, state) => {
    const { github } = client([pullRoute(17, { mergeable })]);
    expect(await new LiveReads(github).mergeability(REPO, 17)).toEqual({ number: 17, head: SHA, conflicts, state });
  });
});

describe('merging in a dry run', () => {
  const MINUTE = 60_000;
  const TIMES = { checksAfterMs: 2 * MINUTE, mergeAfterMs: 20 * MINUTE };
  const no = (what: string) => () => Promise.reject(new Error(`GitHub has no ${what}`));
  const live = {
    requiredChecks: async () => ['Unit tests'],
    reviewVerdict: no('such pull request'),
    mergeQueue: no('such pull request'),
    mergeability: no('such pull request'),
  } as unknown as Reads;

  async function dryRun({ ref = BRANCH } = {}) {
    let now = new Date('2026-11-04T12:00:00Z');
    const dir = await mkdtemp(join(tmpdir(), 'merging-dry-'));
    const made = new DryRunActions(
      new DiskArtifacts(dir),
      quiet,
      () => now,
      undefined,
      guard(),
      async (repo, n) => {
        const { head, state, draft } = pull(n, n === 18 ? { ref: 'factory/red-team-test-1a2b3c4d' } : {});
        return { state, draft, head: { ref: head.ref, sha: head.sha, repo: repo } };
      },
    );
    const reads = new DryRunReads(made, live, TIMES, () => now);
    const head = await made.commit(REPO, {
      branch: ref,
      expectedHead: SHA,
      message: 'fix(cart): count b',
      changes: { additions: [{ path: 'src/cart.ts', contents: new TextEncoder().encode('b\n') }], deletions: [] },
    });
    const { number } = await made.openPullRequest(REPO, { head: ref, base: 'main', title: 't', body: 'b' });
    const records = async () =>
      Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'))));
    return { made, reads, head, number, records, later: (ms: number) => (now = new Date(now.getTime() + ms)) };
  }

  it('passes the review check once the checks have had their time, with a verdict saying nothing ran', async () => {
    const { reads, head, number, later } = await dryRun();
    expect(await reads.reviewVerdict(REPO, number)).toMatchObject({
      head,
      check: { status: 'in_progress' },
      judged: null,
      problem: 'the review check has not concluded',
    });
    later(TIMES.checksAfterMs);
    expect(await reads.reviewVerdict(REPO, number)).toMatchObject({
      head,
      check: { status: 'completed', conclusion: 'success', title: DRY_RUN_CHECK_TITLE },
      judged: { number, head, rule: 'low-risk', tags: [] },
      problem: null,
    });
  });

  it('records what it would queue, reads it queued, then merged as every dry run’s merge is', async () => {
    const { made, reads, head, number, records, later } = await dryRun();
    expect(await reads.mergeQueue(REPO, number)).toMatchObject({ queued: null, added: null });
    later(5 * MINUTE);
    expect(await made.enqueuePullRequest(REPO, number, head)).toEqual({ position: 1, state: 'QUEUED' });
    expect((await records()).find((r) => r.action === 'enqueuePullRequest')).toMatchObject({
      repo: REPO,
      args: { number, expectedHead: head },
    });
    const queued = await reads.mergeQueue(REPO, number);
    expect(queued).toMatchObject({ state: 'open', queued: { position: 1 }, removed: null });
    expect(queued.checks.map((c) => [c.name, c.status])).toEqual([['Unit tests', 'in_progress']]);
    later(TIMES.mergeAfterMs);
    const merged = await reads.mergeQueue(REPO, number);
    expect(merged).toMatchObject({ state: 'merged', queued: null, removed: { reason: 'merged' } });
    expect(merged.checks.map((c) => [c.name, c.conclusion])).toEqual([['Unit tests', 'success']]);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ merged: true });
  });

  it('merges one the line queued a while after it was queued, not after it was readied', async () => {
    const { made, reads, head, number, later } = await dryRun();
    later(5 * MINUTE);
    await made.enqueuePullRequest(REPO, number, head);
    // Readied twenty minutes ago: one never queued would read as merged by now, standing in for Martin's merge.
    later(TIMES.mergeAfterMs - 5 * MINUTE);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ state: 'open', merged: false });
    expect(await reads.mergeQueue(REPO, number)).toMatchObject({ queued: { position: 1 } });
    later(5 * MINUTE);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ merged: true });
  });

  it('takes one out of the queue when its head moves or it goes back to draft, as GitHub does', async () => {
    const { made, reads, head, number, later } = await dryRun();
    const ref = { number, url: '', nodeId: '' };
    await made.enqueuePullRequest(REPO, number, head);
    await made.convertToDraft(REPO, ref);
    const moved = await made.commit(REPO, {
      branch: BRANCH,
      expectedHead: head,
      message: 'fix(cart): count c',
      changes: { additions: [{ path: 'src/cart.ts', contents: new TextEncoder().encode('c\n') }], deletions: [] },
    });
    later(TIMES.mergeAfterMs);
    // A draft, out of the queue: it never merges at a head nobody queued.
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ state: 'open', merged: false });
    expect(await reads.mergeQueue(REPO, number)).toMatchObject({ queued: null, added: null });
    await made.readyForReview(REPO, ref);
    await made.enqueuePullRequest(REPO, number, moved);
    later(TIMES.mergeAfterMs - MINUTE);
    // Queued again at the new head, it merges a while after that, not after the first.
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ merged: false });
    later(MINUTE);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ merged: true, head: { sha: moved } });
  });

  it('never merges one queued, then moved while ready, until it is queued again at its new head', async () => {
    const { made, reads, head, number, later } = await dryRun();
    await made.enqueuePullRequest(REPO, number, head);
    const moved = await made.commit(REPO, {
      branch: BRANCH,
      expectedHead: head,
      message: 'fix(cart): count c',
      changes: { additions: [{ path: 'src/cart.ts', contents: new TextEncoder().encode('c\n') }], deletions: [] },
    });
    // Ready all along, and readied long ago: out of the queue, it is not Martin's merge it stands for, and waits.
    later(TIMES.mergeAfterMs * 3);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ state: 'open', merged: false, draft: false });
    expect(await reads.mergeQueue(REPO, number)).toMatchObject({ queued: null, added: null });
    await made.enqueuePullRequest(REPO, number, moved);
    later(TIMES.mergeAfterMs - MINUTE);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ merged: false });
    later(MINUTE);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ merged: true, head: { sha: moved } });
  });

  it('merges one never queued a while after it was readied, and refuses to queue one merged', async () => {
    const { made, reads, head, number, later, records } = await dryRun();
    later(TIMES.mergeAfterMs);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ merged: true });
    await expect(made.enqueuePullRequest(REPO, number, head)).rejects.toMatchObject({ kind: 'conflict', status: 409 });
    expect((await records()).filter((r) => r.action === 'enqueuePullRequest')).toEqual([]);
    expect(await reads.mergeQueue(REPO, number)).toMatchObject({ state: 'merged', added: null, removed: null });
  });

  it('queues one from a branch it never moved at the head its reads give', async () => {
    const { made, reads } = await dryRun();
    const { number } = await made.openPullRequest(REPO, {
      head: 'factory/12-other',
      base: 'main',
      title: 't',
      body: 'b',
    });
    const { head } = await reads.mergeability(REPO, number);
    expect(await made.enqueuePullRequest(REPO, number, head)).toEqual({ position: 1, state: 'QUEUED' });
  });

  it('never conflicts with its base', async () => {
    const { reads, head, number } = await dryRun();
    expect(await reads.mergeability(REPO, number)).toEqual({ number, head, conflicts: false, state: 'clean' });
  });

  it('refuses as the live action does: a red-team branch, a head moved on, one Martin opened', async () => {
    const red = await dryRun({ ref: 'factory/red-team-test-1a2b3c4d' });
    await expect(red.made.enqueuePullRequest(REPO, red.number, red.head)).rejects.toBeInstanceOf(BranchRefused);
    const moved = await dryRun();
    await expect(moved.made.enqueuePullRequest(REPO, moved.number, OTHER_SHA)).rejects.toMatchObject({
      kind: 'conflict',
    });
    await expect(moved.made.enqueuePullRequest(REPO, 121, SHA)).rejects.toBeInstanceOf(IssueRefused);
    await expect(moved.made.enqueuePullRequest(REPO, 18, SHA)).rejects.toBeInstanceOf(BranchRefused);
    expect((await moved.records()).filter((r) => r.action === 'enqueuePullRequest')).toEqual([]);
  });

  it('records a real pull request it would queue, which reads as GitHub has it', async () => {
    const { made, reads, records } = await dryRun();
    expect(await made.enqueuePullRequest(REPO, 17, SHA)).toEqual({ position: null, state: null });
    expect((await records()).find((r) => r.action === 'enqueuePullRequest')?.args).toEqual({
      number: 17,
      expectedHead: SHA,
    });
    await expect(reads.mergeQueue(REPO, 17)).rejects.toThrow('GitHub has no such pull request');
  });
});
