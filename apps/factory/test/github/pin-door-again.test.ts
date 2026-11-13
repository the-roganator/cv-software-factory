/**
 * The worker's HTTP door, asked by a worker that holds no key. The door is the real
 * one (`createWorkerServer`) over the live actions and their guards, wired as service.ts wires it (with `pinHeads`),
 * against the fake GitHub the pin watch's own tests use; the pin pull requests are opened by the real pin watch.
 * Each request is a plain POST, as any pod that reaches the door can send.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveActions } from '../../src/github/actions.ts';
import { GitHubError } from '../../src/github/client.ts';
import { configFromEnv } from '../../src/github/config.ts';
import { dependencyPulls } from '../../src/github/dependabot.ts';
import { pinHeadsOf } from '../../src/github/deploy-queue.ts';
import { IssueGuard, openedBy } from '../../src/github/issues.ts';
import { PASS_MS, pinWatch } from '../../src/github/pins.ts';
import type { PullRequestState, Reads } from '../../src/github/reads.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { client, quiet, type Route, type Sent } from './fake.ts';
import { day, FACTORY, FakeRepo, FILES, factoryMoves, writes } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

/** What main's rulesets require, read live from GitHub on 2026-11-12 (`gh api repos/…/rules/branches/main`). */
const REQUIRED = [
  'lint, types, tests',
  'browser tests',
  'image builds',
  'lockfile scan',
  'pull request title',
  'platform',
  'review',
];
const PIN = 'factory/pin/example-dashboards';
const SHA = (c: string) => c.repeat(40);

async function worker() {
  const repo = new FakeRepo(FILES);
  const sent: Sent[] = [];
  const enqueues: unknown[] = [];
  const base = repo.routes();
  const commits = base.find((r) => r.method === 'POST' && r.path === '/graphql') as Route;
  const more: Route[] = [
    {
      method: 'POST',
      path: '/graphql',
      answer: (request) => {
        const { query, variables } = request.body as { query: string; variables: { input: unknown } };
        if (!query.includes('enqueuePullRequest(')) return commits.answer(request);
        enqueues.push(variables.input);
        return { body: { data: { enqueuePullRequest: { mergeQueueEntry: { position: 1, state: 'QUEUED' } } } } };
      },
    },
    {
      method: 'GET',
      path: new RegExp(`^/repos/${FACTORY}/pulls/\\d+$`),
      answer: ({ path }) => {
        const pull = repo.pulls.find((p) => p.number === Number(path.split('/').at(-1)));
        if (!pull) return { status: 404, body: { message: 'Not Found' } };
        return {
          body: {
            number: pull.number,
            state: pull.state,
            draft: false,
            node_id: `PR_${pull.number}`,
            mergeable: pull.mergeable,
            title: pull.title,
            body: pull.body,
            base: { ref: 'main' },
            head: { ref: pull.head, sha: repo.refs.get(pull.head), repo: { full_name: pull.from ?? FACTORY } },
          },
        };
      },
    },
    { method: 'POST', path: `/repos/${FACTORY}/check-runs`, answer: () => ({ status: 201, body: { id: 9001 } }) },
    { method: 'PATCH', path: new RegExp(`^/repos/${FACTORY}/check-runs/\\d+$`), answer: () => ({ body: {} }) },
  ];
  const { github } = client([...more, ...base], sent);
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'redteam4-door-')));
  const recorder = new RefusalRecorder({ artifacts, log: quiet });
  const guard = new IssueGuard({ openedBy: openedBy(github), recorder });
  const actions = new LiveActions(github, { guard });
  let clock = Date.parse('2026-11-12T07:00:00Z');
  const scanned = repo.main;
  const watch = pinWatch(
    {
      github,
      reads: {
        moves: async () => day(scanned, factoryMoves()),
        dependencyPulls: (r: string) => dependencyPulls(github, r, async () => 'version: 2\nupdates: []\n'),
      },
      actions,
      recorder,
      log: quiet,
      now: () => clock,
      only: '*',
    },
    FACTORY,
  );
  clock += PASS_MS;
  await watch();
  const reads = {
    pullRequest: async (_repo: string, number: number): Promise<PullRequestState> => {
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) throw new GitHubError('not-found', `#${number} is not a pull request.`, 404);
      return { head: { ref: pull.head, sha: repo.refs.get(pull.head) } } as PullRequestState;
    },
    requiredChecks: async () => REQUIRED,
  } as unknown as Reads;
  const server = createWorkerServer({
    actions,
    reads,
    repositories: [FACTORY],
    health: () => ({}),
    recorder,
    pinHeads: pinHeadsOf(github),
    log: quiet,
  });
  const { url } = await listenLocal(server);
  closing.push(() => server.close());
  const pin = repo.pulls.find((p) => p.head === PIN);
  if (!pin) throw new Error('the pin watch opened no pull request for example-dashboards');
  return { repo, sent, enqueues, url, pin, head: repo.refs.get(PIN) as string };
}

/** One action asked of a door, as any pod sends it: the status, the error's name, and whether a refusal was signed. */
async function ask(url: string, action: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}/v1/actions/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const answer = (await response.json()) as { error?: string; message?: string; result?: unknown; refusal?: unknown };
  return { status: response.status, error: answer.error, message: answer.message, result: answer.result };
}

const check = (name: string, headSha: string) => ({
  repo: FACTORY,
  name,
  headSha,
  status: 'completed',
  conclusion: 'success',
  title: 'Passed as pin-move',
  summary: 'A worker’s words.',
});

describe('the door, asked again each earlier bypass', () => {
  it('1.1: a worker makes a branch, commits a pin’s digest to it and opens it as the App’s, but cannot queue it, in any form of the request', async () => {
    const { repo, url, sent, enqueues } = await worker();
    expect((await ask(url, 'setBranch', { repo: FACTORY, branch: 'factory/7-x', sha: repo.main })).status).toBe(200);
    const file = 'deploy/base/telemetry/dashboards.yaml';
    const text = (repo.file('main', file) as string).replace('13.2.7', '13.7.2');
    const committed = await ask(url, 'commit', {
      repo: FACTORY,
      branch: 'factory/7-x',
      expectedHead: repo.main,
      message: 'chore(pin): move example-dashboards to 13.7.2',
      changes: { additions: [{ path: file, contents: Buffer.from(text).toString('base64') }], deletions: [] },
    });
    // The door's commit has no path guard: a file CODEOWNERS gives Martin is written, as the description says.
    expect(committed.status).toBe(200);
    const opened = await ask(url, 'openPullRequest', {
      repo: FACTORY,
      head: 'factory/7-x',
      base: 'main',
      title: 'chore(pin): move example-dashboards to 13.7.2',
      body: '',
    });
    expect(opened.status).toBe(200);
    const { number } = opened.result as { number: number };
    const before = sent.length;
    const asked = { repo: FACTORY, number, expectedHead: committed.result as string };
    for (const headers of [{}, { 'x-factory-dry-run': 'true' }, { 'x-factory-dry-run': 'TRUE' }]) {
      const refused = await ask(url, 'enqueuePullRequest', asked, headers);
      expect([refused.status, refused.error]).toEqual([422, 'branch-refused']);
    }
    // The repository in any other spelling is not one the door serves.
    for (const other of ['The-Roganator/cv-software-factory', `${FACTORY}/`, `${FACTORY}.git`, ` ${FACTORY}`]) {
      expect((await ask(url, 'enqueuePullRequest', { ...asked, repo: other })).status).toBe(400);
    }
    // No route beside it: no action merges, enables auto-merge, or passes a query through.
    for (const none of [
      'mergePullRequest',
      'enablePullRequestAutoMerge',
      'graphql',
      'commitPins',
      'updateIssue',
      'constructor',
    ]) {
      expect((await ask(url, none, asked)).status).toBe(404);
    }
    expect(enqueues).toEqual([]);
    expect(writes(sent.slice(before))).toEqual([]);
  });

  it('1.4: no branch is set at a pin branch’s head, or at a pin-next branch’s, by any branch the worker may write', async () => {
    const { repo, url, head, sent } = await worker();
    repo.refs.set('factory/pin-next/left-behind', SHA('d'));
    const before = sent.length;
    for (const [branch, sha, force] of [
      ['factory/7-copy', head, undefined],
      ['factory/7-copy', head, true],
      ['deploy/local', head, true],
      ['factory/deploy/local', head, undefined],
      ['factory/red-team-x', head, undefined],
      ['factory/7-copy', SHA('d'), undefined],
    ] as const) {
      const refused = await ask(url, 'setBranch', { repo: FACTORY, branch, sha, ...(force ? { force } : {}) });
      expect([branch, refused.status, refused.error]).toEqual([branch, 422, 'branch-refused']);
    }
    expect(writes(sent.slice(before))).toEqual([]);
  });

  it('1.5: no check run named review, or as a check main requires, in any case or with space round it; nor a rename to one', async () => {
    const { url, head, sent } = await worker();
    const before = sent.length;
    for (const name of [
      'review',
      'Review',
      ' review ',
      'REVIEW\t',
      'review ',
      'platform',
      'Platform ',
      'Lint, Types, Tests',
      'image builds',
    ]) {
      const refused = await ask(url, 'createCheckRun', check(name, head));
      expect([name, refused.status, refused.error]).toEqual([name, 422, 'branch-refused']);
      const renamed = await ask(url, 'updateCheckRun', { repo: FACTORY, id: 9001, name });
      expect([name, renamed.status]).toEqual([name, 422]);
    }
    expect(writes(sent.slice(before))).toEqual([]);
  });

  it('no pull request from a pin branch in any form of its name, no pin label in any spelling, no write to a pin branch', async () => {
    const { repo, url, sent, pin } = await worker();
    const other = repo.addPull({ head: 'factory/9-other', title: 'fix: other' });
    const before = sent.length;
    const draft = { repo: FACTORY, base: 'main', title: 'chore(pin): move example-dashboards to 13.7.2', body: '' };
    for (const from of [
      PIN,
      `refs/heads/${PIN}`,
      `heads/${PIN}`,
      `refs/heads/refs/heads/${PIN}`,
      `refs/pull/${pin.number}/head`,
      'factory/pin',
      'factory/pin-next',
      'factory/pin-next/example-dashboards',
      'factory/pin/a/b',
    ]) {
      const refused = await ask(url, 'openPullRequest', { ...draft, head: from });
      expect([from, refused.status, refused.error]).toEqual([from, 422, 'branch-refused']);
    }
    for (const label of ['pin', 'PIN', ' pin ', 'pín', 'p​in', 'ｐｉｎ', 'pın', 'PİN', 'pi­n', '﻿pin', 'pin️']) {
      const shown = JSON.stringify(label);
      const opened = await ask(url, 'openPullRequest', { ...draft, head: 'factory/9-other', labels: [label] });
      const added = await ask(url, 'addLabels', { repo: FACTORY, number: other.number, labels: ['x', label] });
      const issue = await ask(url, 'openIssue', { repo: FACTORY, title: 't', body: 'b', labels: [label] });
      expect([shown, opened.status, added.status, issue.status]).toEqual([shown, 422, 422, 422]);
    }
    const main = repo.main;
    for (const branch of [PIN, 'factory/pin', 'factory/pin-next/x']) {
      const changes = { additions: [{ path: 'a.txt', contents: 'YQ==' }], deletions: [] };
      expect((await ask(url, 'setBranch', { repo: FACTORY, branch, sha: main, force: true })).status).toBe(422);
      expect((await ask(url, 'deleteBranch', { repo: FACTORY, branch })).status).toBe(422);
      expect(
        (await ask(url, 'commit', { repo: FACTORY, branch, expectedHead: main, message: 'm', changes })).status,
      ).toBe(422);
      expect(
        (await ask(url, 'applyPatch', { repo: FACTORY, branch, expectedHead: main, patch: 'x', message: 'm' })).status,
      ).toBe(422);
    }
    for (const branch of [`refs/heads/${PIN}`, 'Factory/pin/x', 'main']) {
      expect((await ask(url, 'setBranch', { repo: FACTORY, branch, sha: main })).status).toBe(422);
    }
    expect(writes(sent.slice(before))).toEqual([]);
  });

  it('no action that names the pin pull request by its number, live or as a dry run', async () => {
    const { url, sent, pin, head } = await worker();
    const before = sent.length;
    const ref = { number: pin.number, url: 'u', nodeId: 'PR_999' };
    const asks: [string, Record<string, unknown>][] = [
      ['comment', { number: pin.number, body: 'x' }],
      ['addLabels', { number: pin.number, labels: ['x'] }],
      ['updatePullRequest', { number: pin.number, title: 'chore(pin): move example-dashboards to 99.0.0' }],
      ['closePullRequest', { number: pin.number, comment: 'x' }],
      ['closeIssue', { number: pin.number, reason: 'completed' }],
      ['reopenIssue', { number: pin.number, comment: 'x' }],
      ['readyForReview', { pullRequest: ref }],
      ['convertToDraft', { pullRequest: ref }],
      ['review', { number: pin.number, commit: head, body: 'x', comments: [] }],
      ['resolveThreads', { number: pin.number, threads: [{ path: 'a', line: 1, body: 'b', reply: 'c' }] }],
      ['describeDeploy', { number: pin.number, commit: head, carries: [] }],
      ['enqueuePullRequest', { number: pin.number, expectedHead: head }],
    ];
    for (const [action, args] of asks) {
      for (const headers of [{}, { 'x-factory-dry-run': 'true' }]) {
        const refused = await ask(url, action, { repo: FACTORY, ...args }, headers);
        expect([action, refused.status, refused.error]).toEqual([action, 422, 'branch-refused']);
      }
    }
    expect(writes(sent.slice(before))).toEqual([]);
  });
});

describe('the door, asked what it once still served', () => {
  it('refuses a check run at a pin pull request’s head, whatever it is named (review to the eye, platform)', async () => {
    const { url, head, sent } = await worker();
    for (const name of [
      'review\u200b',
      'rev\u0456ew',
      '\uff52\uff45\uff56\uff49\uff45\uff57',
      'platform\u200b',
      'lint',
    ]) {
      const before = sent.length;
      const refused = await ask(url, 'createCheckRun', check(name, head));
      expect(refused.status, JSON.stringify(name)).toBe(422);
      expect(writes(sent.slice(before)).find((s) => s.path.endsWith('/check-runs'))).toBeUndefined();
    }
  });

  it('no effect shown: a pull request INTO a pin branch, and a branch at a pin branch’s former head', async () => {
    const { repo, url, head } = await worker();
    await ask(url, 'setBranch', { repo: FACTORY, branch: 'factory/8-into', sha: repo.main });
    const into = await ask(url, 'openPullRequest', {
      repo: FACTORY,
      head: 'factory/8-into',
      base: PIN,
      title: 't',
      body: '',
    });
    expect(into.status).toBe(200);
    // The pin branch moves on (a later target, or made again on main): its former head is no pin branch's now.
    repo.refs.set(PIN, SHA('e'));
    const former = await ask(url, 'setBranch', { repo: FACTORY, branch: 'factory/8-former', sha: head });
    expect(former.status).toBe(200);
    expect(repo.refs.get('factory/8-former')).toBe(head);
    // The pin branch's head now is still refused.
    expect((await ask(url, 'setBranch', { repo: FACTORY, branch: 'factory/8-now', sha: SHA('e') })).status).toBe(422);
  });

  it('starts no worker configured for this repository in another case than the guards name it', () => {
    for (const spelled of ['The-Roganator/CV-Software-Factory', 'the-roganator/CV-worlds-worst-website']) {
      expect(() => configFromEnv({ GITHUB_REPOSITORIES: spelled }), spelled).toThrow(/as the worker's guards name it/);
    }
    expect(configFromEnv({ GITHUB_REPOSITORIES: 'the-roganator/cv-software-factory' }).repositories).toEqual([
      'the-roganator/cv-software-factory',
    ]);
  });
});
