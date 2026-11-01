import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { GitHub } from '../../src/github/client.ts';
import { carriesIn, carriesSection, DEPLOYS, DeployRefused, deployTitle, type Pin } from '../../src/github/deploys.ts';
import { APP_USER, IssueGuard } from '../../src/github/issues.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker } from '../../src/github/worker-client.ts';
import {
  CLIENT_ID,
  calls,
  client,
  fakeGitHub,
  OTHER_SHA,
  PRIVATE_KEY,
  quiet,
  REPO,
  type Route,
  type Sent,
  SHA,
} from './fake.ts';

/**
 * A guard for which every issue and pull request is the App's, as `proofs/public-hostile.issues.test.ts` tests the
 * guard itself.
 */
const appsOwn = () => new IssueGuard({ openedBy: async () => ({ by: APP_USER, pullRequest: false }) });
/** GitHub's answer for an issue the App opened, as the guard reads it. */
const BY_APP = { user: { id: APP_USER } };

const APP_DEPLOY = DEPLOYS.find((t) => t.repo === REPO) as (typeof DEPLOYS)[number];
const CARRIES = [{ workItem: '1001', title: 'Redirect loop on /departments', issue: 16, pullRequest: 17 }];

/** The app's deploy pull request, #30, for SHA, as GitHub keeps it: what describing it reads and writes. */
function deployPull(pull: { state?: string; head?: string; fork?: boolean; body?: string | null } = {}) {
  let body = pull.body === undefined ? 'Runs `aaaaaaa` on the local cluster.' : pull.body;
  const routes: Route[] = [
    // The deploy pull request is the App's, as the guard asks before it is moved.
    { method: 'GET', path: `/repos/${REPO}/issues/30`, answer: () => ({ body: { ...BY_APP, pull_request: {} } }) },
    {
      method: 'GET',
      path: `/repos/${REPO}/pulls/30`,
      answer: () => ({
        body: {
          state: pull.state ?? 'open',
          title: deployTitle(APP_DEPLOY, [{ pin: APP_DEPLOY.pins[0] as Pin, commit: SHA }]),
          body,
          head: { ref: pull.head ?? APP_DEPLOY.branch, repo: { full_name: pull.fork ? 'someone/fork' : REPO } },
          base: { ref: 'main' },
        },
      }),
    },
    {
      method: 'PATCH',
      path: `/repos/${REPO}/pulls/30`,
      answer: ({ body: change }) => {
        body = (change as { body: string }).body;
        return { body: {} };
      },
    },
  ];
  return { routes, body: () => body };
}

describe('acting in GitHub', () => {
  it('commits through GraphQL, so GitHub signs it, with the files as base64 and the message split', async () => {
    const { github, sent } = client([
      {
        method: 'POST',
        path: '/graphql',
        answer: () => ({ body: { data: { createCommitOnBranch: { commit: { oid: OTHER_SHA } } } } }),
      },
    ]);
    const oid = await new LiveActions(github, { guard: appsOwn() }).commit(REPO, {
      branch: 'factory/1001-cart',
      expectedHead: SHA,
      message: 'fix(cart): count the last item\n\nThe loop stopped one short.',
      changes: {
        additions: [{ path: 'src/cart.ts', contents: new TextEncoder().encode('ok\n') }],
        deletions: ['old.ts'],
      },
    });
    expect(oid).toBe(OTHER_SHA);
    const call = calls(sent)[0]?.body as { query: string; variables: unknown };
    expect(call.query).toContain('createCommitOnBranch');
    expect(call.variables).toEqual({
      input: {
        branch: { repositoryNameWithOwner: REPO, branchName: 'factory/1001-cart' },
        expectedHeadOid: SHA,
        message: { headline: 'fix(cart): count the last item', body: 'The loop stopped one short.' },
        fileChanges: { additions: [{ path: 'src/cart.ts', contents: 'b2sK' }], deletions: [{ path: 'old.ts' }] },
      },
    });
  });

  it('moves a branch that exists, and makes one that does not', async () => {
    const existing = new Set(['deploy/local']);
    const { github, sent } = client([
      {
        method: 'GET',
        path: /^\/repos\/.+\/git\/ref\/heads\//,
        answer: ({ path }) =>
          existing.has(path.split('/heads/')[1] ?? '') ? { body: {} } : { status: 404, body: { message: 'Not Found' } },
      },
      { method: 'PATCH', path: /^\/repos\/.+\/git\/refs\/heads\//, answer: () => ({ body: {} }) },
      { method: 'POST', path: `/repos/${REPO}/git/refs`, answer: () => ({ status: 201, body: {} }) },
    ]);
    const actions = new LiveActions(github, { guard: appsOwn() });
    await actions.setBranch(REPO, 'deploy/local', SHA, { force: true });
    await actions.setBranch(REPO, 'factory/1001-cart', SHA);
    // Whether it exists is asked first, not read off an error's words.
    expect(calls(sent).map((s) => [s.method, s.path, s.body])).toEqual([
      ['GET', `/repos/${REPO}/git/ref/heads/deploy/local`, undefined],
      ['PATCH', `/repos/${REPO}/git/refs/heads/deploy/local`, { sha: SHA, force: true }],
      ['GET', `/repos/${REPO}/git/ref/heads/factory/1001-cart`, undefined],
      ['POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/factory/1001-cart', sha: SHA }],
    ]);
  });

  it('opens a labelled draft, readies it, and reviews with comments that never approve', async () => {
    const { github, sent } = client([
      {
        method: 'POST',
        path: `/repos/${REPO}/pulls`,
        answer: () => ({ status: 201, body: { number: 7, html_url: 'https://github.test/pr/7', node_id: 'PR_7' } }),
      },
      { method: 'POST', path: `/repos/${REPO}/issues/7/labels`, answer: () => ({ body: [] }) },
      { method: 'GET', path: `/repos/${REPO}/pulls/7`, answer: () => ({ body: { node_id: 'PR_7' } }) },
      { method: 'POST', path: '/graphql', answer: () => ({ body: { data: {} } }) },
      { method: 'POST', path: `/repos/${REPO}/pulls/7/reviews`, answer: () => ({ body: { id: 99 } }) },
    ]);
    const actions = new LiveActions(github, { guard: appsOwn() });
    const pr = await actions.openPullRequest(REPO, {
      head: 'factory/1001-cart',
      base: 'main',
      title: 'fix(cart): count the last item',
      body: 'Fixes #3',
      draft: true,
      labels: ['factory'],
    });
    expect(pr).toEqual({ number: 7, url: 'https://github.test/pr/7', nodeId: 'PR_7' });
    await actions.readyForReview(REPO, pr);
    const review = await actions.review(REPO, 7, {
      commit: SHA,
      body: 'One finding.',
      comments: [{ path: 'src/cart.ts', line: 12, body: 'Rule 2: …' }],
    });
    expect(review).toBe(99);
    const bodies = calls(sent)
      .filter((s) => s.method !== 'GET')
      .map((s) => s.body);
    expect(bodies[0]).toEqual({
      head: 'factory/1001-cart',
      base: 'main',
      title: 'fix(cart): count the last item',
      body: 'Fixes #3',
      draft: true,
    });
    expect(bodies[1]).toEqual({ labels: ['factory'] });
    expect(bodies[2]).toMatchObject({ variables: { id: 'PR_7' } });
    expect(bodies[3]).toEqual({
      commit_id: SHA,
      body: 'One finding.',
      event: 'COMMENT',
      comments: [{ path: 'src/cart.ts', line: 12, side: 'RIGHT', body: 'Rule 2: …' }],
    });
  });

  it('puts a pull request back to draft by the node id GitHub gives its number, whatever id it was sent', async () => {
    const { github, sent } = client([
      { method: 'GET', path: `/repos/${REPO}/pulls/7`, answer: () => ({ body: { node_id: 'PR_7' } }) },
      { method: 'POST', path: '/graphql', answer: () => ({ body: { data: {} } }) },
    ]);
    await new LiveActions(github, { guard: appsOwn() }).convertToDraft(REPO, { number: 7, url: '', nodeId: 'PR_8' });
    const [body] = calls(sent)
      .filter((s) => s.method === 'POST')
      .map((s) => s.body) as { query: string; variables: unknown }[];
    expect(body?.query).toContain('convertPullRequestToDraft');
    expect(body?.variables).toEqual({ id: 'PR_7' });
  });

  it('replies on the open threads it began with an answered finding, each with its reply, and resolves them, once, and leaves the rest', async () => {
    const finding = '**Blocking** · criterion 2\n\nNo test shows a lowercase query.';
    const reply = `Answered in ${SHA}: the factory’s reviewer, review 2, finds this put right.`;
    const suggestion = '**Suggestion**\n\nName the test for what it shows.';
    const declined = 'Declined by the factory’s coder: the name says what it shows.';
    const app = { login: 'mrogan-software-factory' };
    const thread = (
      id: string,
      isResolved: boolean,
      path: string,
      ...comments: [string, { login: string } | null][]
    ) => ({
      id,
      isResolved,
      path,
      originalLine: 4,
      comments: { nodes: comments.map(([body, author]) => ({ body, author })) },
    });
    const { github, sent } = client([
      {
        method: 'POST',
        path: '/graphql',
        answer: ({ body }) =>
          String((body as { query: string }).query).includes('reviewThreads')
            ? {
                body: {
                  data: {
                    repository: {
                      pullRequest: {
                        reviewThreads: {
                          nodes: [
                            thread('T1', false, 'test/search.test.ts', [finding.replace(/\n/g, '\r\n'), app]),
                            // Replied to already, by a try that failed before it resolved.
                            thread('T2', false, 'src/search.ts', [finding, app], [reply, app]),
                            thread('T3', true, 'test/pages.test.ts', [finding, app]),
                            thread('T4', false, 'test/search.test.ts', [finding, { login: 'mrogan' }]),
                            thread('T5', false, 'test/other.test.ts', [finding, app]),
                            thread('T6', false, 'test/search.test.ts', ['**Blocking** · rule 1\n\nElse.', app]),
                            thread('T8', false, 'test/search.test.ts', [suggestion, app]),
                            // The same words on another line: a finding of its own.
                            { ...thread('T7', false, 'test/search.test.ts', [finding, app]), originalLine: 9 },
                          ],
                        },
                      },
                    },
                  },
                },
              }
            : { body: { data: {} } },
      },
    ]);
    await new LiveActions(github, { guard: appsOwn() }).resolveThreads(REPO, 66, [
      { path: 'test/search.test.ts', line: 4, body: finding, reply },
      { path: 'src/search.ts', line: 4, body: finding, reply },
      { path: 'test/pages.test.ts', line: 4, body: finding, reply },
      { path: 'test/search.test.ts', line: 4, body: suggestion, reply: declined },
    ]);
    const asked = calls(sent).map((s) => s.body as { query: string; variables: Record<string, unknown> });
    expect(asked[0]?.variables).toEqual({ owner: 'the-roganator', name: 'cv-worlds-worst-website', number: 66 });
    expect(
      asked
        .slice(1)
        .map((a) => [a.query.match(/(addPullRequestReviewThreadReply|resolveReviewThread)/)?.[1], a.variables]),
    ).toEqual([
      ['addPullRequestReviewThreadReply', { id: 'T1', body: reply }],
      ['resolveReviewThread', { id: 'T1' }],
      ['resolveReviewThread', { id: 'T2' }],
      ['addPullRequestReviewThreadReply', { id: 'T8', body: declined }],
      ['resolveReviewThread', { id: 'T8' }],
    ]);
  });

  it('reports a check run with its output, and closes an issue with its reason', async () => {
    const { github, sent } = client([
      { method: 'POST', path: `/repos/${REPO}/check-runs`, answer: () => ({ status: 201, body: { id: 5 } }) },
      { method: 'PATCH', path: `/repos/${REPO}/check-runs/5`, answer: () => ({ body: {} }) },
      { method: 'GET', path: `/repos/${REPO}/issues/3`, answer: () => ({ body: BY_APP }) },
      { method: 'PATCH', path: `/repos/${REPO}/issues/3`, answer: () => ({ body: {} }) },
    ]);
    const actions = new LiveActions(github, { guard: appsOwn() });
    const id = await actions.createCheckRun(REPO, {
      name: 'factory review',
      headSha: SHA,
      status: 'in_progress',
      title: 'Reviewing',
      summary: 'Started.',
    });
    await actions.updateCheckRun(REPO, id, {
      status: 'completed',
      conclusion: 'neutral',
      title: 'Two findings',
      summary: '…',
    });
    await actions.closeIssue(REPO, 3, 'completed');
    expect(
      calls(sent)
        .filter((s) => s.method !== 'GET')
        .map((s) => s.body),
    ).toEqual([
      {
        name: 'factory review',
        head_sha: SHA,
        status: 'in_progress',
        output: { title: 'Reviewing', summary: 'Started.' },
      },
      { status: 'completed', conclusion: 'neutral', output: { title: 'Two findings', summary: '…' } },
      { state: 'closed', state_reason: 'completed' },
    ]);
  });

  it('closes an issue with a comment saying why, once, and says nothing on one already closed', async () => {
    let state = 'open';
    let failClose = 1;
    const comments: { body: string }[] = [];
    const { github, sent } = client([
      { method: 'GET', path: `/repos/${REPO}/issues/16`, answer: () => ({ body: { ...BY_APP, state } }) },
      { method: 'GET', path: /^\/repos\/.+\/issues\/16\/events/, answer: () => ({ body: [] }) },
      { method: 'GET', path: /^\/repos\/.+\/issues\/16\/comments/, answer: () => ({ body: comments }) },
      {
        method: 'POST',
        path: `/repos/${REPO}/issues/16/comments`,
        answer: ({ body }) => {
          comments.push(body as { body: string });
          return { status: 201, body: {} };
        },
      },
      {
        method: 'PATCH',
        path: `/repos/${REPO}/issues/16`,
        answer: () => {
          if (failClose-- > 0) return { status: 422, body: { message: 'Validation Failed' } };
          state = 'closed';
          return { body: {} };
        },
      },
    ]);
    const actions = new LiveActions(github, { guard: appsOwn() });
    // The first close comments, and its closing fails; trying again closes it, saying nothing twice.
    await expect(actions.closeIssue(REPO, 16, 'completed', 'Verified in production.')).rejects.toThrow();
    await actions.closeIssue(REPO, 16, 'completed', 'Verified in production.');
    await actions.closeIssue(REPO, 16, 'completed', 'Verified in production.');
    expect(comments).toEqual([{ body: 'Verified in production.' }]);
    expect(
      calls(sent)
        .filter((s) => s.method !== 'GET')
        .map((s) => [s.method, s.body]),
    ).toEqual([
      ['POST', { body: 'Verified in production.' }],
      ['PATCH', { state: 'closed', state_reason: 'completed' }],
      ['PATCH', { state: 'closed', state_reason: 'completed' }],
    ]);
  });

  it('reopens a closed issue with a comment saying why, once in each closing, and leaves one already open', async () => {
    let clock = 0;
    const time = () => new Date(Date.UTC(2026, 9, 11, 9, clock++)).toISOString();
    let issue = { state: 'closed', closed_at: time() };
    let failReopen = 1;
    const comments: { body: string; created_at: string }[] = [];
    const { github, sent } = client([
      { method: 'GET', path: `/repos/${REPO}/issues/16`, answer: () => ({ body: { ...BY_APP, ...issue } }) },
      {
        method: 'GET',
        path: /^\/repos\/.+\/issues\/16\/comments/,
        answer: ({ path }) => {
          const since = new URL(path, 'https://api.github.test').searchParams.get('since') ?? '';
          return { body: comments.filter((made) => made.created_at >= since) };
        },
      },
      {
        method: 'POST',
        path: `/repos/${REPO}/issues/16/comments`,
        answer: ({ body }) => {
          comments.push({ ...(body as { body: string }), created_at: time() });
          return { status: 201, body: {} };
        },
      },
      {
        method: 'PATCH',
        path: `/repos/${REPO}/issues/16`,
        answer: () => {
          if (failReopen-- > 0) return { status: 422, body: { message: 'Validation Failed' } };
          issue = { state: 'open', closed_at: issue.closed_at };
          return { body: {} };
        },
      },
    ]);
    const actions = new LiveActions(github, { guard: appsOwn() });
    // The first reopening comments, and fails to reopen; trying again reopens it, saying nothing twice.
    await expect(actions.reopenIssue(REPO, 16, 'It came back.')).rejects.toThrow();
    await actions.reopenIssue(REPO, 16, 'It came back.');
    await actions.reopenIssue(REPO, 16, 'It came back.');
    expect(comments.map((made) => made.body)).toEqual(['It came back.']);
    // Closed again, and the same words come back: they are said again, for this closing.
    issue = { state: 'closed', closed_at: time() };
    await actions.reopenIssue(REPO, 16, 'It came back.');
    expect(comments.map((made) => made.body)).toEqual(['It came back.', 'It came back.']);
    expect(
      calls(sent)
        .filter((s) => s.method !== 'GET')
        .map((s) => [s.method, s.body]),
    ).toEqual([
      ['POST', { body: 'It came back.' }],
      ['PATCH', { state: 'open', state_reason: 'reopened' }],
      ['PATCH', { state: 'open', state_reason: 'reopened' }],
      ['POST', { body: 'It came back.' }],
      ['PATCH', { state: 'open', state_reason: 'reopened' }],
    ]);
  });

  it('says again on a reopened issue what an earlier closing said, as it closes it again', async () => {
    const said = [{ body: 'Verified in production.' }];
    const { github, sent } = client([
      { method: 'GET', path: `/repos/${REPO}/issues/16`, answer: () => ({ body: { ...BY_APP, state: 'open' } }) },
      {
        method: 'GET',
        path: /^\/repos\/.+\/issues\/16\/events/,
        answer: () => ({
          body: [
            { event: 'closed', created_at: '2026-10-11T09:00:00Z' },
            { event: 'reopened', created_at: '2026-10-11T10:00:00Z' },
          ],
        }),
      },
      {
        method: 'GET',
        path: /^\/repos\/.+\/issues\/16\/comments/,
        answer: ({ path }) => ({ body: path.includes('since=2026-10-11T10%3A00%3A00Z') ? [] : said }),
      },
      { method: 'POST', path: `/repos/${REPO}/issues/16/comments`, answer: () => ({ status: 201, body: {} }) },
      { method: 'PATCH', path: `/repos/${REPO}/issues/16`, answer: () => ({ body: {} }) },
    ]);
    await new LiveActions(github, { guard: appsOwn() }).closeIssue(REPO, 16, 'completed', 'Verified in production.');
    expect(calls(sent).filter((s) => s.method === 'POST')).toHaveLength(1);
  });
});

describe('describing a deploy', () => {
  it('writes what the deploy pull request carries into its body, and leaves a body that says it already', async () => {
    const pull = deployPull();
    const { github, sent } = client(pull.routes);
    const actions = new LiveActions(github, { guard: appsOwn() });
    expect(await actions.describeDeploy(REPO, 30, { commit: SHA, carries: CARRIES })).toBe(true);
    expect(pull.body()).toBe(`Runs \`aaaaaaa\` on the local cluster.\n\n${carriesSection(CARRIES)}`);
    expect(await actions.describeDeploy(REPO, 30, { commit: SHA, carries: CARRIES })).toBe(false);
    expect(await actions.describeDeploy(REPO, 30, { commit: SHA, carries: [] })).toBe(true);
    expect(carriesIn(pull.body())).toBe(carriesSection([]));
    expect(calls(sent).filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('refuses a pull request that is not a deploy, and one no longer for the commit, or no longer open', async () => {
    for (const [pull, commit, refusal] of [
      [{ head: 'factory/1001-cart' }, SHA, DeployRefused],
      [{ fork: true }, SHA, DeployRefused],
      [{}, OTHER_SHA, { kind: 'conflict' }],
      [{ state: 'closed' }, SHA, { kind: 'conflict' }],
    ] as const) {
      const { routes } = deployPull(pull);
      const { github, sent } = client(routes);
      const describing = new LiveActions(github, { guard: appsOwn() }).describeDeploy(REPO, 30, {
        commit,
        carries: CARRIES,
      });
      if (refusal === DeployRefused) await expect(describing).rejects.toBeInstanceOf(DeployRefused);
      else await expect(describing).rejects.toMatchObject(refusal);
      expect(calls(sent).filter((c) => c.method === 'PATCH')).toEqual([]);
    }
  });

  it('refuses a deploy of several pin files, which has no one range of commits to say it carries', async () => {
    const factory = DEPLOYS.find((t) => t.pins.length > 1) as (typeof DEPLOYS)[number];
    const { github, sent } = client([
      {
        method: 'GET',
        path: `/repos/${factory.repo}/pulls/30`,
        answer: () => ({
          body: {
            state: 'open',
            title: deployTitle(factory, [{ pin: factory.pins[0] as Pin, commit: SHA }]),
            body: '',
            head: { ref: factory.branch, repo: { full_name: factory.repo } },
            base: { ref: 'main' },
          },
        }),
      },
    ]);
    const describing = new LiveActions(github, { guard: appsOwn() }).describeDeploy(factory.repo, 30, {
      commit: SHA,
      carries: CARRIES,
    });
    await expect(describing).rejects.toThrow(/more than one pin file/);
    expect(calls(sent).filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('waits for the watch’s write to the same body, so neither writes over the other with a body it read before', async () => {
    const pull = deployPull();
    const sent: Sent[] = [];
    const fake = fakeGitHub(pull.routes, sent);
    // The watch's write is slow to come back.
    let letGo = () => {};
    const slow = new Promise<void>((resolve) => (letGo = resolve));
    let first = true;
    const github = new GitHub({
      credentials: { clientId: CLIENT_ID, privateKey: PRIVATE_KEY },
      api: 'https://api.github.test',
      log: quiet,
      sleep: async () => {},
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PATCH' && first) {
          first = false;
          await slow;
        }
        return fake.fetch(input, init);
      }) as typeof fetch,
    });
    const actions = new LiveActions(github, { guard: appsOwn() });
    const move = actions.updatePullRequest(REPO, 30, { body: 'Runs `bbbbbbb` on the local cluster.' });
    const describing = actions.describeDeploy(REPO, 30, { commit: SHA, carries: CARRIES });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Only the guard's read of who opened it, in the move's turn, before its write.
    const toPull = () => calls(sent).filter((c) => !c.path.endsWith('/issues/30'));
    expect(toPull()).toEqual([]);
    letGo();
    await Promise.all([move, describing]);
    // The description read the body the move wrote, and kept it.
    expect(toPull().map((c) => c.method)).toEqual(['PATCH', 'GET', 'PATCH']);
    expect(pull.body()).toBe(`Runs \`bbbbbbb\` on the local cluster.\n\n${carriesSection(CARRIES)}`);
  });
});

describe('a dry run', () => {
  it('writes each action to the artifact store, sends nothing, and makes nothing that could pass for real', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(
      new DiskArtifacts(dir),
      quiet,
      () => new Date('2026-10-04T12:00:00Z'),
      undefined,
      appsOwn(),
    );
    const oid = await actions.commit(REPO, {
      branch: 'factory/1001-cart',
      expectedHead: SHA,
      message: 'fix(cart): count the last item',
      changes: {
        additions: [
          { path: 'src/cart.ts', contents: new TextEncoder().encode('export const n = 1;\n') },
          { path: 'logo.png', contents: new Uint8Array([0x89, 0x50, 0xff, 0xfe]) },
        ],
        deletions: [],
      },
    });
    const pr = await actions.openPullRequest(REPO, { head: 'factory/1001-cart', base: 'main', title: 't', body: 'b' });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(pr.number).toBeGreaterThan(1_000_000_000);

    const records = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    const commit = records.find((r) => r.action === 'commit');
    expect(commit).toMatchObject({ repo: REPO, at: '2026-10-04T12:00:00.000Z' });
    expect(commit.args.changes.additions).toEqual([
      { path: 'src/cart.ts', text: 'export const n = 1;\n' },
      { path: 'logo.png', base64: 'iVD//g==' },
    ]);
    expect(records.map((r) => r.action).sort()).toEqual(['commit', 'openPullRequest']);
  });

  it('records what it would have said a deploy carries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(
      new DiskArtifacts(dir),
      quiet,
      () => new Date('2026-10-04T12:00:00Z'),
      undefined,
      appsOwn(),
    );
    expect(await actions.describeDeploy(REPO, 30, { commit: SHA, carries: CARRIES })).toBe(true);
    const [record] = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    expect(record).toEqual({
      action: 'describeDeploy',
      repo: REPO,
      at: '2026-10-04T12:00:00.000Z',
      args: { number: 30, commit: SHA, carries: CARRIES },
    });
  });

  it('records the issue it would have closed, with what it would have said on it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(
      new DiskArtifacts(dir),
      quiet,
      () => new Date('2026-10-04T12:00:00Z'),
      undefined,
      appsOwn(),
    );
    await actions.closeIssue(REPO, 16, 'completed', 'Verified in production.');
    const [record] = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    expect(record).toMatchObject({
      action: 'closeIssue',
      args: { number: 16, reason: 'completed', comment: 'Verified in production.' },
    });
  });
});

describe('resolving threads in a dry run', () => {
  it('records the threads it would have resolved, with what it would have said on them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(
      new DiskArtifacts(dir),
      quiet,
      () => new Date('2026-10-04T12:00:00Z'),
      undefined,
      appsOwn(),
    );
    const threads = [
      {
        path: 'src/search.ts',
        line: 1,
        body: '**Blocking** · criterion 1\n\nNo quote is escaped.',
        reply: 'Answered.',
      },
    ];
    await actions.resolveThreads(REPO, 66, threads);
    const [record] = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    expect(record).toEqual({
      action: 'resolveThreads',
      repo: REPO,
      at: '2026-10-04T12:00:00.000Z',
      args: { number: 66, threads },
    });
  });
});

describe('closing a pull request', () => {
  it('says why on it once, closes it unmerged, and leaves one already closed', async () => {
    let pull = { state: 'open', head: { ref: 'factory/1028-search' } };
    let failClose = 1;
    const comments: { body: string }[] = [];
    const { github, sent } = client([
      { method: 'GET', path: `/repos/${REPO}/pulls/66`, answer: () => ({ body: pull }) },
      { method: 'GET', path: /^\/repos\/.+\/issues\/66\/comments/, answer: () => ({ body: comments }) },
      {
        method: 'POST',
        path: `/repos/${REPO}/issues/66/comments`,
        answer: ({ body }) => {
          comments.push(body as { body: string });
          return { status: 201, body: {} };
        },
      },
      {
        method: 'PATCH',
        path: `/repos/${REPO}/pulls/66`,
        answer: () => {
          if (failClose-- > 0) return { status: 422, body: { message: 'Validation Failed' } };
          pull = { state: 'closed', head: pull.head };
          return { body: {} };
        },
      },
    ]);
    const actions = new LiveActions(github, { guard: appsOwn() });
    await expect(actions.closePullRequest(REPO, 66, 'Closed unmerged.')).rejects.toThrow();
    await actions.closePullRequest(REPO, 66, 'Closed unmerged.');
    await actions.closePullRequest(REPO, 66, 'Closed unmerged.');
    expect(
      calls(sent)
        .filter((s) => s.method !== 'GET')
        .map((s) => [s.method, s.body]),
    ).toEqual([
      ['POST', { body: 'Closed unmerged.' }],
      ['PATCH', { state: 'closed' }],
      ['PATCH', { state: 'closed' }],
    ]);
  });

  it('closes only a pull request from a branch the factory owns', async () => {
    const { github, sent } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}/pulls/67`,
        answer: () => ({ body: { state: 'open', head: { ref: 'dependabot/npm_and_yarn/pino-10.4.0' } } }),
      },
    ]);
    await expect(
      new LiveActions(github, { guard: appsOwn() }).closePullRequest(REPO, 67, 'Closed unmerged.'),
    ).rejects.toThrow();
    expect(calls(sent).filter((s) => s.method !== 'GET')).toEqual([]);
  });

  it('records the pull request a dry run would have closed, with what it would have said', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(
      new DiskArtifacts(dir),
      quiet,
      () => new Date('2026-10-04T12:00:00Z'),
      undefined,
      appsOwn(),
    );
    await actions.closePullRequest(REPO, 66, 'Closed unmerged.');
    const [record] = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    expect(record).toEqual({
      action: 'closePullRequest',
      repo: REPO,
      at: '2026-10-04T12:00:00.000Z',
      args: { number: 66, comment: 'Closed unmerged.' },
    });
  });

  it('records a dry run’s close of its own pull request once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(
      new DiskArtifacts(dir),
      quiet,
      () => new Date('2026-10-04T12:00:00Z'),
      undefined,
      appsOwn(),
    );
    const { number } = await actions.openPullRequest(REPO, {
      head: 'factory/1-a',
      base: 'main',
      title: 't',
      body: 'b',
    });
    await actions.closePullRequest(REPO, number, 'Closed unmerged.');
    await actions.closePullRequest(REPO, number, 'Closed unmerged.');
    const records = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    expect(records.filter((r) => r.action === 'closePullRequest')).toHaveLength(1);
  });
});

describe('commenting on an issue', () => {
  it('says each thing once: asked again, after a failure or a restart, it says nothing more', async () => {
    // As GitHub may keep one: with \r\n for its line endings.
    const comments: { body: string }[] = [{ body: 'Something said before.\r\nOn two lines.' }];
    let failPost = 1;
    const { github, sent } = client([
      { method: 'GET', path: `/repos/${REPO}/issues/31`, answer: () => ({ body: BY_APP }) },
      { method: 'GET', path: /^\/repos\/.+\/issues\/31\/comments/, answer: () => ({ body: comments }) },
      {
        method: 'POST',
        path: `/repos/${REPO}/issues/31/comments`,
        answer: ({ body }) => {
          if (failPost-- > 0) return { status: 422, body: { message: 'Validation Failed' } };
          comments.push(body as { body: string });
          return { status: 201, body: {} };
        },
      },
    ]);
    const actions = new LiveActions(github, { guard: appsOwn() });
    await expect(actions.comment(REPO, 31, 'Released behind its flag.')).rejects.toThrow();
    await actions.comment(REPO, 31, 'Released behind its flag.');
    await actions.comment(REPO, 31, 'Released behind its flag.');
    await actions.comment(REPO, 31, 'Something said before.\nOn two lines.');
    expect(
      calls(sent)
        .filter((s) => s.method === 'POST')
        .map((s) => s.body),
    ).toEqual([{ body: 'Released behind its flag.' }, { body: 'Released behind its flag.' }]);
    expect(comments.map((c) => c.body)).toEqual([
      'Something said before.\r\nOn two lines.',
      'Released behind its flag.',
    ]);
  });

  it('records what a dry run would have said on an issue once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(
      new DiskArtifacts(dir),
      quiet,
      () => new Date('2026-10-04T12:00:00Z'),
      undefined,
      appsOwn(),
    );
    await Promise.all([
      actions.comment(REPO, 31, 'Released behind its flag.'),
      actions.comment(REPO, 31, 'Released behind its flag.'),
    ]);
    await actions.comment(REPO, 31, 'Released behind its flag.');
    await actions.comment(REPO, 32, 'Released behind its flag.');
    const records = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    expect(records.map((r) => r.args.number).sort()).toEqual([31, 32]);
  });
});

describe('reopening an issue in a dry run', () => {
  it('records the issue it would have reopened, with what it would have said on it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(
      new DiskArtifacts(dir),
      quiet,
      () => new Date('2026-10-04T12:00:00Z'),
      undefined,
      appsOwn(),
    );
    await actions.reopenIssue(REPO, 16, 'It came back.');
    const [record] = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    expect(record).toEqual({
      action: 'reopenIssue',
      repo: REPO,
      at: '2026-10-04T12:00:00.000Z',
      args: { number: 16, comment: 'It came back.' },
    });
  });
});

describe('the worker over HTTP', () => {
  let close: (() => void) | undefined;
  let baseUrl = '';
  afterEach(() => close?.());

  async function serve(actions: ConstructorParameters<typeof LiveActions>[0] | DryRunActions) {
    const server = createWorkerServer({
      actions: actions instanceof DryRunActions ? actions : new LiveActions(actions, { guard: appsOwn() }),
      repositories: [REPO],
      health: () => ({ mode: 'test' }),
      log: quiet,
    });
    const { url: base } = await listenLocal(server);
    close = () => server.close();
    baseUrl = base;
    return (path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as { message?: string } & Record<string, unknown>,
      }));
  }

  it('acts for a configured repository, with arguments checked at the door', async () => {
    const { github, sent } = client([
      { method: 'POST', path: `/repos/${REPO}/issues`, answer: () => ({ status: 201, body: { number: 12 } }) },
    ]);
    const call = await serve(github);
    expect(await call('/v1/actions/openIssue', { repo: REPO, title: 'A broken link', body: '…' })).toEqual({
      status: 200,
      body: { result: 12, dryRun: false },
    });
    expect(await call('/v1/actions/openIssue', { repo: 'someone/else', title: 'x', body: '' })).toMatchObject({
      status: 400,
      body: { message: `repo must be one of ${REPO}.` },
    });
    const bad = await call('/v1/actions/commit', {
      repo: REPO,
      branch: 'factory/../main',
      expectedHead: 'nope',
      message: 'x',
      changes: { additions: [{ path: '../../etc/passwd', contents: 'eA==' }], deletions: [] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/branch.*expectedHead.*changes\.additions\.0\.path/s);
    expect(await call('/v1/actions/mergePullRequest', { repo: REPO })).toMatchObject({ status: 404 });
    expect(calls(sent)).toHaveLength(1);
  });

  it('logs each action with the work item and the agent it is for, and leaves out names a log should not carry', async () => {
    const logged: Record<string, unknown>[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const server = createWorkerServer({
      actions: new DryRunActions(new DiskArtifacts(dir), quiet, () => new Date('2026-10-17T12:00:00Z')),
      repositories: [REPO],
      health: () => ({ mode: 'test' }),
      log: pino({ level: 'info' }, { write: (line: string) => void logged.push(JSON.parse(line)) }),
    });
    const { url } = await listenLocal(server);
    close = () => server.close();
    const worker = new GitHubWorker(url);
    await worker.act('openIssue', REPO, { title: 'A broken link', body: '…' }, { workItem: '1042', agent: 'coder' });
    await worker.act('openIssue', REPO, { title: 'A broken link', body: '…' });
    await worker.act('openIssue', REPO, { title: 'A broken link', body: '…' }, { workItem: '1042 forged: yes' });
    const actions = logged.filter((l) => l.msg === 'github openIssue');
    expect(actions.map(({ action, repo, workItem, agent }) => ({ action, repo, workItem, agent }))).toEqual([
      { action: 'openIssue', repo: REPO, workItem: '1042', agent: 'coder' },
      { action: 'openIssue', repo: REPO, workItem: undefined, agent: undefined },
      { action: 'openIssue', repo: REPO, workItem: undefined, agent: undefined },
    ]);
    // A refusal says which action it was, and for what.
    const main = { branch: 'main', sha: 'a'.repeat(40), force: true };
    await expect(worker.act('setBranch', REPO, main, { workItem: '1042', agent: 'coder' })).rejects.toThrow();
    expect(logged.find((l) => l.msg === 'a branch was refused')).toMatchObject({
      action: 'setBranch',
      workItem: '1042',
      agent: 'coder',
    });
  });

  it("keeps a GitHub failure's meaning", async () => {
    const { github } = client([
      {
        method: 'POST',
        path: '/graphql',
        answer: () => ({
          body: {
            errors: [{ type: 'FORBIDDEN', message: 'refusing to allow a GitHub App to create or update workflow' }],
          },
        }),
      },
    ]);
    const call = await serve(github);
    const refused = await call('/v1/actions/commit', {
      repo: REPO,
      branch: 'factory/1001-cart',
      expectedHead: SHA,
      message: 'ci: x',
      changes: { additions: [{ path: '.github/workflows/x.yml', contents: 'eA==' }], deletions: [] },
    });
    expect(refused).toEqual({
      status: 403,
      body: { error: 'refused', message: 'refusing to allow a GitHub App to create or update workflow' },
    });
    const { github: keyless } = client([], [], { keyless: true });
    close?.();
    const readOnly = await (await serve(keyless))('/v1/actions/openIssue', { repo: REPO, title: 'hi', body: 'hi' });
    expect(readOnly).toMatchObject({ status: 503, body: { error: 'read-only' } });
  });

  it('describes a deploy with its list checked at the door, and refuses a pull request that is not one', async () => {
    const pull = deployPull({ head: 'factory/1001-cart' });
    const { github, sent } = client(pull.routes);
    const call = await serve(github);
    const ask = (carries: unknown) =>
      call('/v1/actions/describeDeploy', { repo: REPO, number: 30, commit: SHA, carries });
    expect(await ask(CARRIES)).toMatchObject({ status: 422, body: { error: 'deploy-refused' } });
    for (const carries of [
      [{ ...CARRIES[0], workItem: '../1' }],
      [{ ...CARRIES[0], title: 'x'.repeat(121) }],
      [{ ...CARRIES[0], markdown: '**' }],
      Array.from({ length: 51 }, () => CARRIES[0]),
    ]) {
      expect(await ask(carries)).toMatchObject({ status: 400 });
    }
    expect(calls(sent)).toHaveLength(1);
  });

  it('refuses a body that does not say it is JSON, which is all a web page can send unasked', async () => {
    const { github, sent } = client([]);
    await serve(github);
    const plain = await fetch(`${baseUrl}/v1/actions/comment`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ repo: REPO, number: 1, body: 'hi' }),
    });
    expect(plain.status).toBe(415);
    expect(calls(sent)).toEqual([]);
  });

  it('chains a dry run’s actions: what it would have opened can be labelled, readied and commented on', async () => {
    const call = await serve(new DryRunActions(new DiskArtifacts(await mkdtemp(join(tmpdir(), 'dry-run-'))), quiet));
    const opened = await call('/v1/actions/openPullRequest', {
      repo: REPO,
      head: 'factory/1-cart',
      base: 'main',
      title: 't',
      body: 'b',
    });
    const pullRequest = opened.body.result as { number: number; url: string; nodeId: string };
    expect(
      (await call('/v1/actions/addLabels', { repo: REPO, number: pullRequest.number, labels: ['factory'] })).status,
    ).toBe(200);
    expect((await call('/v1/actions/readyForReview', { repo: REPO, pullRequest })).status).toBe(200);
    expect((await call('/v1/actions/convertToDraft', { repo: REPO, pullRequest })).status).toBe(200);
    expect((await call('/v1/actions/readyForReview', { repo: REPO, pullRequest })).status).toBe(200);
    expect((await call('/v1/actions/comment', { repo: REPO, number: pullRequest.number, body: 'Ready.' })).status).toBe(
      200,
    );
    const thread = { path: 'src/cart.ts', line: 3, body: '**Blocking**\n\nOne short.', reply: 'Answered.' };
    const resolve = (threads: object[]) =>
      call('/v1/actions/resolveThreads', { repo: REPO, number: pullRequest.number, threads });
    expect((await resolve([thread])).status).toBe(200);
    // Nothing to resolve, or nothing to say, is refused at the door.
    expect((await resolve([])).status).toBe(400);
    expect((await resolve([{ ...thread, reply: '' }])).status).toBe(400);
  });

  it('says it is a dry run in every answer', async () => {
    const call = await serve(new DryRunActions(new DiskArtifacts(await mkdtemp(join(tmpdir(), 'dry-run-'))), quiet));
    expect(await call('/v1/actions/deleteBranch', { repo: REPO, branch: 'factory/1001-cart' })).toEqual({
      status: 200,
      body: { result: null, dryRun: true },
    });
    expect(await call('/health')).toEqual({ status: 200, body: { status: 'ok', mode: 'test' } });
  });
});
