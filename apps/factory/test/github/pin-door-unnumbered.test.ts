/**
 * What a worker that asks can do through the door about the pin watch's pull requests without naming one by its
 * number, and about this repository's merge queue: each is refused, signed. The door is the real one (`createWorkerServer`), over the live actions
 * and their guards, against the fake GitHub the pin watch's own tests use; the pin pull requests are opened by the
 * real pin watch.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LOGIN, LiveActions } from '../../src/github/actions.ts';
import { GitHubError } from '../../src/github/client.ts';
import { dependencyPulls } from '../../src/github/dependabot.ts';
import { type DeployQueueDependencies, pinHeadsOf, pinQueueWatch } from '../../src/github/deploy-queue.ts';
import { IssueGuard, openedBy } from '../../src/github/issues.ts';
import { PASS_MS, type PinScope, pinWatch, readPinScope } from '../../src/github/pins.ts';
import type { PullRequestState, Reads } from '../../src/github/reads.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker, type GitHubWorkerError } from '../../src/github/worker-client.ts';
import { client, quiet, type Route, type Sent } from './fake.ts';
import { day, digest, FACTORY, FakeRepo, FILES, factoryMoves, writes } from './pins-harness.ts';

let close: (() => void) | undefined;
afterEach(() => close?.());

/**
 * The worker as service.ts wires it, over one fake repository: the pin watch, and the door with the live actions. The
 * fake answers what the pin watch's tests did not need: a pull request as the queue's guard reads it, the enqueue, and
 * a check run.
 */
async function worker(only: PinScope) {
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
            head: { ref: pull.head, sha: repo.refs.get(pull.head), repo: { full_name: pull.from ?? FACTORY } },
          },
        };
      },
    },
    { method: 'POST', path: `/repos/${FACTORY}/check-runs`, answer: () => ({ status: 201, body: { id: 9001 } }) },
  ];
  const { github } = client([...more, ...base], sent);
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'redteam3-door-')));
  const recorder = new RefusalRecorder({ artifacts, log: quiet });
  const guard = new IssueGuard({ openedBy: openedBy(github), recorder });
  const actions = new LiveActions(github, { guard });

  // The pin watch, as the worker runs it.
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
      only,
    },
    FACTORY,
  );
  clock += PASS_MS;
  await watch();

  // The door's read of a pull request by its number, as GitHub has it: its head's branch, or not found for an issue.
  const reads = {
    pullRequest: async (_repo: string, number: number): Promise<PullRequestState> => {
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) throw new GitHubError('not-found', `#${number} is not a pull request.`, 404);
      return { head: { ref: pull.head, sha: repo.refs.get(pull.head) } } as PullRequestState;
    },
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
  close = () => server.close();
  const refusals = () => readdirSync(artifacts.dir, { recursive: true }).filter((f) => /[0-9a-f]{16}/.test(String(f)));
  return { repo, sent, enqueues, door: new GitHubWorker(url), refusals, github, scanned };
}

describe('the door, asked for actions that name no pull request', () => {
  /** What the door answered, as the worker that asked sees it. */
  const failure = (asked: Promise<unknown>) =>
    asked.then(() => undefined).catch((e: unknown) => e as GitHubWorkerError);

  it('refuses a branch at a pin pull request’s head, so no second pull request has it and the gate does not hold the move', async () => {
    const { repo, door, sent, refusals } = await worker('*');
    const pin = repo.pulls.find((p) => p.head === 'factory/pin/ghcr.io-example-scanner-proxy');
    if (!pin) throw new Error('the pin watch opened no pull request for the scanner');
    const head = repo.refs.get(pin.head) as string;
    const before = sent.length;
    const failed = await failure(door.act('setBranch', FACTORY, { branch: 'factory/7-copy', sha: head }));
    expect(failed?.status).toBe(422);
    expect(writes(sent.slice(before))).toEqual([]);
    expect(repo.refs.has('factory/7-copy')).toBe(false);
    expect(refusals()).toHaveLength(1);
    // No pull request but the pin watch's has its head, which is what the gate's shared-head check reads.
    expect(repo.pulls.filter((p) => repo.refs.get(p.head) === head).map((p) => p.number)).toEqual([pin.number]);
    // A branch at any other commit is set as before.
    await door.act('setBranch', FACTORY, { branch: 'factory/7-copy', sha: repo.main });
    expect(repo.refs.get('factory/7-copy')).toBe(repo.main);
  });

  it('refuses a check run named as the review gate’s, or as a check main requires, at any head', async () => {
    const { repo, door, sent, refusals } = await worker('*');
    const pin = repo.pulls.find((p) => p.head === 'factory/pin/ghcr.io-example-scanner-proxy');
    const head = repo.refs.get(pin?.head ?? '') as string;
    const asked = { headSha: head, status: 'completed', conclusion: 'success', title: 't', summary: 's' } as const;
    for (const name of ['review', ' Review ']) {
      const failed = await failure(door.act('createCheckRun', FACTORY, { name, ...asked }));
      expect(failed?.status, name).toBe(422);
    }
    expect(sent.some((s) => s.method === 'POST' && s.path.endsWith('/check-runs'))).toBe(false);
    expect(refusals()).toHaveLength(2);
  });

  it('refuses to add any pull request to this repository’s merge queue: only the worker’s own watches add to it', async () => {
    // The pin watch is told nothing: it opens nothing, and the pin queue reads nothing.
    const { repo, door, sent, enqueues, refusals, github, scanned } = await worker(readPinScope(undefined));
    expect(repo.pulls).toEqual([]);

    // A worker that asks can still make the App's pull request whose only change is a pin under deploy/.
    const file = 'deploy/images/sbom-tool/Dockerfile';
    const moved = (FILES[file] as string).replace(
      `v1.54.0@${digest('sbom-tool/old')}`,
      `v1.55.1@${digest('sbom-tool/new')}`,
    );
    await door.act('setBranch', FACTORY, { branch: 'factory/7-sbom', sha: scanned });
    const head = await door.act('commit', FACTORY, {
      branch: 'factory/7-sbom',
      expectedHead: scanned,
      message: 'chore(pin): move ghcr.io/example/sbom-tool to v1.55.1',
      changes: { additions: [{ path: file, contents: Buffer.from(moved).toString('base64') }], deletions: [] },
    });
    const opened = await door.act('openPullRequest', FACTORY, {
      head: 'factory/7-sbom',
      base: 'main',
      title: 'chore(pin): move ghcr.io/example/sbom-tool to v1.55.1',
      body: '',
    });
    expect(repo.pulls.find((p) => p.number === opened.number)).toMatchObject({ user: APP_LOGIN, state: 'open' });

    // But not add it to the queue: Martin merges it, or nobody does.
    const failed = await failure(
      door.act('enqueuePullRequest', FACTORY, { number: opened.number, expectedHead: head }),
    );
    expect(failed?.status).toBe(422);
    expect(enqueues).toEqual([]);
    expect(refusals()).toHaveLength(1);

    // The pin queue, told nothing, had no part in it: it reads nothing.
    const before = sent.length;
    const reads = new Proxy({} as DeployQueueDependencies['reads'], {
      get: () => async () => {
        throw new Error('the pin queue read something');
      },
    });
    const none = { enqueuePullRequest: async () => ({ position: null, state: null }) };
    await pinQueueWatch(
      { github, reads, actions: none, heads: { get: () => undefined }, log: quiet },
      FACTORY,
      readPinScope(undefined),
    )();
    expect(sent.length).toBe(before);
  });

  it('refuses a head in another ref’s form, a label that reads as pin, and the pin prefix itself as a branch', async () => {
    const { door, sent, refusals } = await worker(readPinScope(undefined));
    for (const head of [
      'heads/factory/pin/zap',
      'refs/remotes/origin/factory/pin/zap',
      'refs/tags/factory/pin/zap',
      'pull/5/head',
    ]) {
      const failed = await failure(door.act('openPullRequest', FACTORY, { head, base: 'main', title: 't', body: '' }));
      expect(failed?.status, head).toBe(422);
    }
    for (const label of [
      'pin\u200b',
      '\u200bpin',
      'pin\u00ad',
      '\uff50\uff49\uff4e',
      'p\u0131n',
      'P\u0130N',
      'pi\u034fn',
      'pin\ufe0f',
      'pi\u0301n',
    ]) {
      const failed = await failure(door.act('openIssue', FACTORY, { title: 't', body: '', labels: [label] }));
      expect(failed?.status, JSON.stringify(label)).toBe(422);
    }
    for (const branch of ['factory/pin', 'factory/pin-next']) {
      const failed = await failure(door.act('setBranch', FACTORY, { branch, sha: 'a'.repeat(40) }));
      expect(failed?.status, branch).toBe(422);
    }
    expect(writes(sent)).toEqual([]);
    // Kept and signed; two refusals of the same words for the same action are one record.
    expect(refusals().length).toBeGreaterThan(0);
  });
});
