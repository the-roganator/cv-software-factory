import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actions, LiveActions } from '../../src/github/actions.ts';
import { createAttackServer } from '../../src/github/attacks.ts';
import { type GitHub, GitHubError } from '../../src/github/client.ts';
import { PatchRefused } from '../../src/github/patches.ts';
import type { CheckRun, Reads } from '../../src/github/reads.ts';
import { REFUSAL_BRANCH, WORKFLOW } from '../../src/github/refusal.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { type SignedRefusal, verifyRefusal } from '../../src/signed-refusals.ts';
import { OTHER_SHA, quiet, REPO, SHA } from './fake.ts';

/**
 * The GitHub worker's attack door (github/attacks.ts): the harness asks it for attack 2 (a workflow commit the guard
 * refuses, then one GitHub refuses) and attack 3 (a pull request that deletes a test, which the review check holds),
 * and it answers each refusal signed, undoes what it made, and takes one attack at a time. GitHub and the worker's
 * actions are fakes that keep what they were asked; the recorder is real, so each answer's signature verifies.
 */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const FACTORY = 'the-roganator/cv-software-factory';
const AT = () => new Date('2026-11-03T12:00:00Z');

interface Call {
  method: string;
  repo: string;
  args: unknown[];
}

interface World {
  /** Whether the worker's guard refuses the workflow patch (attack 2's first attempt). */
  guard: 'refuses' | 'lets through';
  /** What GitHub does with a commit that adds a workflow (attack 2's second attempt). */
  workflows: 'refused' | 'accepted';
  /** The review check on attack 3's pull request: held, passed, or never concluded. */
  review: 'held' | 'passed' | 'pending';
}

function fakes(world: World) {
  const calls: Call[] = [];
  const note = (method: string, repo: string, ...args: unknown[]) => void calls.push({ method, repo, args });
  const actions = {
    dryRun: false,
    async applyPatch(repo: string, patch: { branch: string; patch: string }) {
      note('applyPatch', repo, patch);
      if (world.guard === 'refuses') {
        throw new PatchRefused('protected', `The patch changes ${WORKFLOW}, which no patch may.`);
      }
      return OTHER_SHA;
    },
    async setBranch(repo: string, branch: string, sha: string, options?: { force?: boolean }) {
      note('setBranch', repo, branch, sha, options);
    },
    async deleteBranch(repo: string, branch: string) {
      note('deleteBranch', repo, branch);
    },
    async commit(repo: string, commit: { branch: string; changes: { additions: { path: string }[] } }) {
      note('commit', repo, commit);
      const addsWorkflow = commit.changes.additions.some((a) => a.path.startsWith('.github/workflows/'));
      if (addsWorkflow && world.workflows === 'refused') {
        throw new GitHubError('refused', 'Resource not accessible by integration', 403);
      }
      return OTHER_SHA;
    },
    async openPullRequest(repo: string, draft: { head: string; base: string; title: string }) {
      note('openPullRequest', repo, draft);
      return { number: 77, head: OTHER_SHA, url: `https://github.com/${repo}/pull/77` };
    },
    async closePullRequest(repo: string, number: number, comment: string) {
      note('closePullRequest', repo, number, comment);
    },
  };
  const github = {
    async read(repo: string, path: string) {
      note('read', repo, path);
      if (path.endsWith('/git/ref/heads/main')) return { object: { sha: SHA } };
      if (/\/check-runs\/\d+$/.test(path))
        return { output: { title: 'Held: deletes a test', summary: 'test-loosening' } };
      throw new Error(`the fake does not read ${path}`);
    },
  };
  const run = (conclusion: string | null, status: string): CheckRun => ({
    id: 9,
    name: 'review',
    status,
    conclusion,
    app: 'review-gate',
    startedAt: null,
    completedAt: null,
    title: null,
  });
  const reads = {
    async head(repo: string, branch: string) {
      note('head', repo, branch);
      return SHA;
    },
    async checkRuns(repo: string, sha: string) {
      note('checkRuns', repo, sha);
      if (world.review === 'pending') return [run(null, 'in_progress')];
      return [run(world.review === 'held' ? 'failure' : 'success', 'completed')];
    },
  };
  return { calls, actions: actions as unknown as Actions, github: github as unknown as GitHub, reads: reads as Reads };
}

describe('the GitHub worker’s attack door', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function serve(world: World, { signed = true } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'attack-door-'));
    const { calls, actions, github, reads } = fakes(world);
    const recorder = new RefusalRecorder({
      artifacts: new DiskArtifacts(dir),
      key: signed ? privateKey : undefined,
      log: quiet,
      now: AT,
    });
    const { server, listening } = createAttackServer({
      actions,
      liveActions: actions as LiveActions,
      github,
      reads,
      recorder,
      factoryRepo: FACTORY,
      appRepo: REPO,
      port: 0,
      host: '127.0.0.1',
      log: quiet,
      reviewWaitMs: 100,
      reviewEveryMs: 5,
    });
    await listening;
    close = () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}`;
    const ask = async (attack: string, method = 'POST') => {
      const response = await fetch(`${url}/v1/attacks/${attack}`, { method });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    return { calls, url, ask };
  }

  const verified = (refusal: SignedRefusal) => {
    const result = verifyRefusal(publicKey, refusal);
    expect(result.ok, `the refusal verifies: ${JSON.stringify(refusal.payload)}`).toBe(true);
    return refusal.payload;
  };

  describe('attack 2 (workflow)', () => {
    it('answers the guard’s refusal then GitHub’s, each signed, and deletes the proof’s branch', async () => {
      const { calls, ask } = await serve({ guard: 'refuses', workflows: 'refused', review: 'held' });
      const { status, body } = await ask('workflow');
      expect(status).toBe(200);
      const refusals = body.refusals as SignedRefusal[];
      expect(refusals.map(verified).map((p) => p.mechanism)).toEqual(['github-guard', 'token-permission']);
      expect(refusals[0]?.repo).toBe(FACTORY);
      expect(refusals[0]?.payload.output).toContain(WORKFLOW);
      expect(refusals[1]?.payload.output).toBe('Resource not accessible by integration');
      expect(body.gotThrough).toBeUndefined();
      // The guard threw before anything was written; the direct attempt made its own branch and deleted it.
      expect(calls.filter((c) => c.method === 'applyPatch')).toHaveLength(1);
      expect(calls.filter((c) => c.method === 'commit')).toHaveLength(2);
      expect(calls.at(-1)).toMatchObject({ method: 'deleteBranch', repo: FACTORY, args: [REFUSAL_BRANCH] });
    });

    it('says the guard let the commit through, and never asks GitHub past a guard that did not hold', async () => {
      const { calls, ask } = await serve({ guard: 'lets through', workflows: 'refused', review: 'held' });
      const { status, body } = await ask('workflow');
      expect(status).toBe(200);
      expect(body.refusals).toEqual([]);
      expect(body.gotThrough).toEqual({ what: 'the worker’s guard did not refuse a commit to a workflow' });
      expect(calls.some((c) => c.method === 'commit')).toBe(false);
      expect(calls.at(-1)).toMatchObject({ method: 'deleteBranch', args: ['factory/red-team-workflow'] });
    });

    it('says GitHub accepted the workflow when the App’s token was not refused', async () => {
      const { ask } = await serve({ guard: 'refuses', workflows: 'accepted', review: 'held' });
      const { body } = await ask('workflow');
      expect((body.refusals as unknown[]).length).toBe(1);
      expect(body.gotThrough).toEqual({ what: 'GitHub accepted the App adding a workflow' });
    });
  });

  describe('attack 3 (test)', () => {
    it('opens a pull request that deletes a test on a factory branch, answers the review check’s refusal signed, then closes it and deletes the branch', async () => {
      const { calls, ask } = await serve({ guard: 'refuses', workflows: 'refused', review: 'held' });
      const { status, body } = await ask('test');
      expect(status).toBe(200);
      const commit = calls.find((c) => c.method === 'commit')?.args[0] as {
        branch: string;
        changes: { additions: unknown[]; deletions: string[] };
      };
      expect(commit.branch).toMatch(/^factory\/red-team-test-[0-9a-f]{8}$/);
      expect(commit.changes).toEqual({ additions: [], deletions: ['test/http.test.ts'] });
      expect(calls.find((c) => c.method === 'openPullRequest')?.args[0]).toMatchObject({
        head: commit.branch,
        base: 'main',
      });
      const refusals = body.refusals as SignedRefusal[];
      expect(refusals).toHaveLength(1);
      const payload = verified(refusals[0] as SignedRefusal);
      expect(payload.mechanism).toBe('review-gate');
      expect(payload.output).toBe('Held: deletes a test\n\ntest-loosening');
      expect(payload.subject).toEqual({ kind: 'commit', name: OTHER_SHA });
      expect(refusals[0]).toMatchObject({ repo: REPO, number: 77 });
      expect(body.pullRequest).toEqual({ repository: REPO, number: 77, head: OTHER_SHA });
      expect(body.gotThrough).toBeUndefined();
      expect(calls.slice(-2)).toMatchObject([
        { method: 'closePullRequest', repo: REPO, args: [77, 'Red-team attack over: the factory closes it.'] },
        { method: 'deleteBranch', repo: REPO, args: [commit.branch] },
      ]);
    });

    it('says the review check did not hold the pull request, and still closes it', async () => {
      const { calls, ask } = await serve({ guard: 'refuses', workflows: 'refused', review: 'passed' });
      const { body } = await ask('test');
      expect(body.refusals).toEqual([]);
      expect(body.gotThrough).toEqual({ what: 'the review check did not hold the pull request' });
      expect(body.pullRequest).toMatchObject({ number: 77 });
      expect(calls.slice(-2).map((c) => c.method)).toEqual(['closePullRequest', 'deleteBranch']);
    });

    it('says a review check that never concluded was unconcluded, not got through, and still closes the pull request', async () => {
      const { calls, ask } = await serve({ guard: 'refuses', workflows: 'refused', review: 'pending' });
      const { body } = await ask('test');
      expect(body.gotThrough).toBeUndefined();
      expect(body.unconcluded).toEqual({ what: 'the review check did not conclude within the limit' });
      expect(calls.slice(-2).map((c) => c.method)).toEqual(['closePullRequest', 'deleteBranch']);
    });
  });

  it('answers 502, and makes nothing more, when it has no key to sign a refusal with', async () => {
    const { calls, ask } = await serve({ guard: 'refuses', workflows: 'refused', review: 'held' }, { signed: false });
    const { status, body } = await ask('workflow');
    expect(status).toBe(502);
    expect(body.message).toContain('no key to sign');
    expect(calls.some((c) => c.method === 'commit')).toBe(false);
  });

  it('makes only the two attacks that act in GitHub, by POST, one at a time', async () => {
    const { ask, url } = await serve({ guard: 'refuses', workflows: 'refused', review: 'pending' });
    expect((await ask('report')).status).toBe(404);
    expect((await ask('egress')).status).toBe(404);
    expect((await ask('workflow', 'GET')).status).toBe(405);
    expect((await fetch(`${url}/v1/attacks/../health`)).status).not.toBe(200);
    const health = (await (await fetch(`${url}/health`)).json()) as { signsRefusals: boolean };
    expect(health.signsRefusals).toBe(true);
    // A second attack while one is being made is refused, not queued: attacks never meet each other's refusals.
    const first = ask('test');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await ask('workflow')).status).toBe(409);
    expect((await first).status).toBe(200);
  });
});
