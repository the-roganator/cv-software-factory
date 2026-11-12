/**
 * The other queue of ADR 0017, the deploy queue, adds the deploy watch's own pull request from `deploy/local`, known
 * by its branch, label and title. So the door refuses every worker that asks to write that branch or its scratch
 * branch, open a pull request from either, give a deploy label, or act on a pull request from either: what the queue
 * takes is the deploy watch's own, as it left it.
 *
 * The door, the live actions and the deploy queue watch are the real ones, over the fake GitHub; the gate's rule is the
 * real `exactPin` (`scripts/review-routing.ts`), given a signature and an ancestry that hold, as they do for any later
 * build of main's; the check's verdict the queue reads is stubbed from that result.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { exactPin } from '../../../../scripts/review-routing.ts';
import { APP_LOGIN, LiveActions } from '../../src/github/actions.ts';
import { GitHubError } from '../../src/github/client.ts';
import {
  type DeployQueueDependencies,
  deployQueueWatch,
  pinHeadsOf,
  QUEUED_DEPLOYS,
} from '../../src/github/deploy-queue.ts';
import { APP_USER, IssueGuard, openedBy } from '../../src/github/issues.ts';
import type { PullRequestState, Reads } from '../../src/github/reads.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { client, quiet, type Route, type Sent } from './fake.ts';
import { digest, FACTORY, FakeRepo, FILES } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

const PIN_FILE = 'deploy/overlays/local/factory-image/kustomization.yaml';
const IMAGE = 'ghcr.io/the-roganator/cv-software-factory';
const PINNED = {
  factory: digest('factory/pinned'),
  browser: digest('browser/pinned'),
  runner: digest('runner/pinned'),
};
/** The newest build of main's three factory images, from one commit, signed by build.yml as every build of main's is. */
const BUILT = { factory: digest('factory/built'), browser: digest('browser/built'), runner: digest('runner/built') };
const pinFile = (pins: typeof PINNED) =>
  [
    'apiVersion: kustomize.config.k8s.io/v1alpha1',
    'kind: Component',
    'images:',
    `- digest: ${pins.factory}`,
    '  name: factory',
    `  newName: ${IMAGE}/factory`,
    `- digest: ${pins.browser}`,
    '  name: factory-browser',
    `  newName: ${IMAGE}/factory-browser`,
    `- digest: ${pins.runner}`,
    '  name: factory-runner',
    `  newName: ${IMAGE}/factory-runner`,
    '',
  ].join('\n');
const contents = (pins: typeof PINNED) => Buffer.from(pinFile(pins)).toString('base64');
const TITLE = 'chore(deploy): run the factory 0123abc on the local cluster';
const REQUIRED = ['lint, types, tests', 'image builds', 'platform', 'review'];

async function worker() {
  const repo = new FakeRepo({ ...FILES, [PIN_FILE]: pinFile(PINNED) });
  const pinned = Object.values(PINNED);
  const sent: Sent[] = [];
  const enqueues: { pullRequestId: string; expectedHeadOid: string }[] = [];
  const base = repo.routes();
  const commits = base.find((r) => r.method === 'POST' && r.path === '/graphql') as Route;
  const asGitHub = (p: (typeof repo.pulls)[number]) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    draft: false,
    node_id: `PR_${p.number}`,
    mergeable: true,
    user: { login: p.user, id: p.user === APP_LOGIN ? APP_USER : 1 },
    labels: p.labels.map((name) => ({ name })),
    head: { ref: p.head, sha: repo.refs.get(p.head), repo: { full_name: FACTORY } },
    base: { ref: 'main' },
  });
  const more: Route[] = [
    {
      method: 'POST',
      path: '/graphql',
      answer: (request) => {
        const { query, variables } = request.body as { query: string; variables: { input: never } };
        if (!query.includes('enqueuePullRequest(')) return commits.answer(request);
        enqueues.push(variables.input);
        return { body: { data: { enqueuePullRequest: { mergeQueueEntry: { position: 1, state: 'QUEUED' } } } } };
      },
    },
    {
      // The deploy queue's list: the open pull requests from the deploy branch.
      method: 'GET',
      path: /\/pulls\?state=open&per_page=10&head=/,
      answer: () => ({ body: repo.pulls.filter((p) => p.state === 'open' && p.head === 'deploy/local').map(asGitHub) }),
    },
    {
      method: 'GET',
      path: new RegExp(`^/repos/${FACTORY}/pulls/\\d+$`),
      answer: ({ path }) => {
        const pull = repo.pulls.find((p) => p.number === Number(path.split('/').at(-1)));
        return pull ? { body: asGitHub(pull) } : { status: 404, body: { message: 'Not Found' } };
      },
    },
  ];
  const { github } = client([...more, ...base], sent);
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'redteam4-deploy-')));
  const recorder = new RefusalRecorder({ artifacts, log: quiet });
  const guard = new IssueGuard({ openedBy: openedBy(github), recorder });
  const actions = new LiveActions(github, { guard });
  const doorReads = {
    pullRequest: async (_repo: string, number: number): Promise<PullRequestState> => {
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) throw new GitHubError('not-found', `#${number} is not a pull request.`, 404);
      return { head: { ref: pull.head, sha: repo.refs.get(pull.head) } } as PullRequestState;
    },
    requiredChecks: async () => REQUIRED,
  } as unknown as Reads;
  const server = createWorkerServer({
    actions,
    reads: doorReads,
    repositories: [FACTORY],
    health: () => ({}),
    recorder,
    pinHeads: pinHeadsOf(github),
    log: quiet,
  });
  const { url } = await listenLocal(server);
  closing.push(() => server.close());

  /** The gate's verdict as the check would carry it: what the real `exactPin` says of the pull request's one file. */
  const gate = async (head: string) => {
    const was = repo.file('main', PIN_FILE) as string;
    const now = repo.file(head, PIN_FILE) as string;
    const [before, after] = [was.split('\n'), now.split('\n')];
    const patch = ['@@ -1,13 +1,13 @@'];
    for (const [i, line] of before.entries()) {
      if (line === after[i]) patch.push(` ${line}`);
      else patch.push(`-${line}`, `+${after[i]}`);
    }
    return exactPin(
      [{ filename: PIN_FILE, status: 'modified', patch: patch.join('\n') }],
      {
        // Any build of main's is signed by build.yml on main, at its commit; a later build's commit descends from the pinned one's.
        signedAt: async (_repo, _image, d) => (pinned.includes(d) ? 'a'.repeat(40) : 'b'.repeat(40)),
        ahead: async (_repo, from, to) => from === 'a'.repeat(40) && to === 'b'.repeat(40),
        content: async () => now,
      },
      true,
    );
  };
  const headOf = (number: number) => repo.refs.get(repo.pulls.find((p) => p.number === number)?.head ?? '') as string;
  const reads: DeployQueueDependencies['reads'] = {
    reviewVerdict: async (_repo, number) => {
      const head = headOf(number);
      const said = await gate(head);
      const rule = 'pins' in said ? ('exact-pin' as const) : ('held' as const);
      return { number, head, check: null, verdict: null, judged: { number, head, rule, tags: [] }, problem: null };
    },
    checkRuns: async () =>
      REQUIRED.filter((name) => name !== 'review').map((name, i) => ({
        id: i + 1,
        name,
        status: 'completed',
        conclusion: 'success',
        app: 'github-actions',
        startedAt: null,
        completedAt: null,
        title: null,
      })),
    requiredChecks: async () => REQUIRED,
    mergeability: async (_repo, number) => ({ number, head: headOf(number), conflicts: false, state: 'clean' }),
    mergeQueue: async (_repo, number) => ({
      number,
      head: headOf(number),
      state: 'open',
      queued: null,
      added: null,
      removed: null,
      checks: [],
    }),
  };
  const [target] = QUEUED_DEPLOYS;
  if (!target) throw new Error('no queued deploy');
  // The worker's own deploy queue, with the live actions: its enqueue is guarded as the worker guards it.
  const queue = deployQueueWatch({ github, reads, actions, recorder, log: quiet }, target);
  return { repo, url, sent, enqueues, queue, gate, actions };
}

async function ask(url: string, action: string, body: unknown) {
  const response = await fetch(`${url}/v1/actions/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = (await response.json()) as { error?: string; message?: string; result?: unknown };
  return { status: response.status, error: answer.error, message: answer.message, result: answer.result };
}

describe('the deploy queue takes only what the deploy watch made and left', () => {
  it('refuses a worker’s commit to deploy/local under the watch’s open pull request, and queues the watch’s own head', async () => {
    const { repo, url, enqueues, queue, actions } = await worker();
    const main = repo.main;
    // The deploy watch's own pull request, made as the watch makes it (the actions, not the door): the three together.
    await actions.setBranch(FACTORY, 'deploy/local', main, { force: true });
    const watched = await actions.commit(FACTORY, {
      branch: 'deploy/local',
      expectedHead: main,
      message: TITLE,
      changes: { additions: [{ path: PIN_FILE, contents: Buffer.from(pinFile(BUILT)) }], deletions: [] },
    });
    const { number } = await actions.openPullRequest(FACTORY, {
      head: 'deploy/local',
      base: 'main',
      title: TITLE,
      body: '',
      labels: ['deploy: local'],
    });
    // A worker that asks, by the door: one commit on the deploy branch, putting the runner's pin back. Refused.
    const committed = await ask(url, 'commit', {
      repo: FACTORY,
      branch: 'deploy/local',
      expectedHead: watched,
      message: 'chore(deploy): the runner as it was',
      changes: {
        additions: [{ path: PIN_FILE, contents: contents({ ...BUILT, runner: PINNED.runner }) }],
        deletions: [],
      },
    });
    expect(committed.status).toBe(422);
    expect(repo.refs.get('deploy/local')).toBe(watched);
    // Every other way onto the watch's branches, or its pull request, is refused the same.
    const refused = [
      ['setBranch', { branch: 'deploy/local', sha: main, force: true }],
      ['setBranch', { branch: 'factory/deploy/local', sha: main }],
      ['deleteBranch', { branch: 'deploy/local' }],
      ['applyPatch', { branch: 'factory/deploy/local', expectedHead: main, patch: 'diff', message: 'm' }],
      ['comment', { number, body: 'a worker’s words' }],
      ['updatePullRequest', { number, title: 'chore(deploy): another' }],
      ['closePullRequest', { number, comment: 'closed by a worker' }],
      ['addLabels', { number: 9999, labels: ['Deploy: Local'] }],
      ['openIssue', { title: 't', body: '', labels: ['deploy: local'] }],
    ] as const;
    for (const [action, args] of refused) {
      expect((await ask(url, action, { repo: FACTORY, ...args })).status, action).toBe(422);
    }
    expect(repo.refs.get('deploy/local')).toBe(watched);
    // The queue adds the watch's own head: the three digests together.
    await queue();
    expect(enqueues).toEqual([{ pullRequestId: `PR_${number}`, expectedHeadOid: watched }]);
  });

  it('refuses a worker’s pull request from deploy/local after Martin closed the watch’s, so nothing is queued', async () => {
    const { repo, url, enqueues, queue, actions } = await worker();
    await actions.setBranch(FACTORY, 'deploy/local', repo.main, { force: true });
    await actions.commit(FACTORY, {
      branch: 'deploy/local',
      expectedHead: repo.main,
      message: TITLE,
      changes: { additions: [{ path: PIN_FILE, contents: Buffer.from(pinFile(BUILT)) }], deletions: [] },
    });
    repo.addPull({
      head: 'deploy/local',
      title: TITLE,
      labels: ['deploy: local'],
      state: 'closed',
      closed_by: 'mrogan',
    });
    for (const head of ['deploy/local', 'refs/heads/deploy/local', 'factory/deploy/local']) {
      const opened = await ask(url, 'openPullRequest', {
        repo: FACTORY,
        head,
        base: 'main',
        title: TITLE,
        body: '',
        labels: ['deploy: local'],
      });
      expect(opened.status, head).toBe(422);
    }
    expect(repo.pulls.filter((p) => p.state === 'open')).toEqual([]);
    await queue();
    expect(enqueues).toEqual([]);
  });
});
