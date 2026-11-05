import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { found, verdictBlock } from '../../../../policy/review-verdict.ts';
import type { Actions, LiveActions } from '../../src/github/actions.ts';
import { createAttackServer } from '../../src/github/attacks.ts';
import { type GitHub, GitHubError } from '../../src/github/client.ts';
import { REVIEW_APP } from '../../src/github/merging.ts';
import { PatchRefused } from '../../src/github/patches.ts';
import type { Reads } from '../../src/github/reads.ts';
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
  /** The review check on attack 3's pull request: held, passed, never concluded, or concluded with no verdict. */
  review: 'held' | 'passed' | 'pending' | 'cancelled' | 'timed_out';
  /**
   * A `review` run another app (the factory's own) posted on the commit: the only one there, or one newer than the
   * review App's, passing.
   */
  foreign?: 'only' | 'newer';
  /** An error GitHub answers when the door first reads, as a client error does, detail and all. */
  readFails?: Error;
  /**
   * A gate that first holds the pull request only to wait for test integrity (`pending`), then, when `rejudged`, judges
   * it again after that many reads of its runs.
   */
  waits?: { rejudged?: number; next?: 'running' };
  /** A concluded review check whose block does not judge the pull request at its head, or whose rule its conclusion contradicts. */
  block?: 'other-head' | 'other-rule';
}

const PENDING = 'test integrity is still running at bbbbbbb';

/** The factory's own App, which can post a check named `review` too. */
const FACTORY_APP = 5187559;

/** A `review` run as GitHub lists it on a commit, by the app that posted it, with the gate's block for #77 at `sha`. */
function run(id: number, sha: string, app: number, review: World['review'], block?: World['block']) {
  const done = review !== 'pending';
  const holds = review === 'held' ? block !== 'other-rule' : block === 'other-rule';
  const judged = {
    number: 77,
    head: block === 'other-head' ? 'c'.repeat(40) : sha,
    rule: holds ? ('held' as const) : ('low-risk' as const),
    tags: holds ? [found('test-loosening', ['test/http.test.ts'])] : [],
  };
  return {
    id,
    name: 'review',
    head_sha: sha,
    status: done ? 'completed' : 'in_progress',
    conclusion: done ? (review === 'held' ? 'failure' : review === 'passed' ? 'success' : review) : null,
    app: { id: app },
    output: {
      title: 'Held: deletes a test',
      summary: `test-loosening\n\n${verdictBlock({ version: 1, commit: sha, judged: [judged] })}`,
    },
  };
}

function fakes(world: World) {
  const calls: Call[] = [];
  const note = (method: string, repo: string, ...args: unknown[]) => void calls.push({ method, repo, args });
  let reviewReads = 0;
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
      if (path.endsWith('/check-runs?check_name=review&filter=all&per_page=100')) {
        note('reviewRuns', repo, path);
        const sha = path.split('/commits/')[1]?.split('/')[0] ?? '';
        reviewReads += 1;
        if (world.waits) {
          const again = world.waits.rejudged !== undefined && reviewReads > world.waits.rejudged;
          const waiting = {
            ...run(9, sha, REVIEW_APP, 'held'),
            output: {
              title: 'Waits for test integrity before it judges',
              summary: verdictBlock({
                version: 1,
                commit: sha,
                judged: [{ number: 77, head: sha, rule: 'held', tags: [], pending: PENDING }],
              }),
            },
          };
          const later = run(11, sha, REVIEW_APP, world.waits.next === 'running' ? 'pending' : world.review);
          return { check_runs: again ? [later, waiting] : [waiting] };
        }
        const ours = world.foreign === 'only' ? [] : [run(9, sha, REVIEW_APP, world.review, world.block)];
        const theirs = world.foreign ? [run(10, sha, FACTORY_APP, 'passed')] : [];
        // GitHub lists the newest first.
        return { check_runs: [...theirs, ...ours] };
      }
      throw new Error(`the fake does not read ${path}`);
    },
    async poll(repo: string, path: string) {
      return { changed: true, body: await this.read(repo, path) };
    },
  };
  const reads = {
    async head(repo: string, branch: string) {
      note('head', repo, branch);
      if (world.readFails) throw world.readFails;
      return SHA;
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

  async function serve(
    world: World,
    { signed = true, kept = true, logged }: { signed?: boolean; kept?: boolean; logged?: string[] } = {},
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'attack-door-'));
    const { calls, actions, github, reads } = fakes(world);
    const recorder = new RefusalRecorder({
      ...(kept && { artifacts: new DiskArtifacts(dir) }),
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
      log: logged ? pino({ level: 'error' }, { write: (line: string) => void logged.push(line) }) : quiet,
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
      expect(payload.output).toMatch(/^Held: deletes a test\n\ntest-loosening\n\n<!-- review-verdict v1\n/);
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

    it('reads the review App’s run alone: a newer passing `review` run from the factory’s App does not stand in for it', async () => {
      const { ask } = await serve({ guard: 'refuses', workflows: 'refused', review: 'held', foreign: 'newer' });
      const { body } = await ask('test');
      expect(body.gotThrough).toBeUndefined();
      expect(verified((body.refusals as SignedRefusal[])[0] as SignedRefusal).mechanism).toBe('review-gate');
    });

    it('waits out a `review` run from any other app as no verdict, and says it was unconcluded', async () => {
      const { calls, ask } = await serve({ guard: 'refuses', workflows: 'refused', review: 'held', foreign: 'only' });
      const { body } = await ask('test');
      expect(body.refusals).toEqual([]);
      expect(body.gotThrough).toBeUndefined();
      expect(body.unconcluded).toEqual({ what: 'the review check did not conclude within the limit' });
      expect(calls.slice(-2).map((c) => c.method)).toEqual(['closePullRequest', 'deleteBranch']);
    });

    it.each(['cancelled', 'timed_out'] as const)(
      'signs no refusal for a review check that concluded %s, and says it was unconcluded',
      async (review) => {
        const { calls, ask } = await serve({ guard: 'refuses', workflows: 'refused', review });
        const { body } = await ask('test');
        expect(body.refusals).toEqual([]);
        expect(body.gotThrough).toBeUndefined();
        expect(body.unconcluded).toEqual({ what: `the review check concluded ${review}` });
        expect(calls.slice(-2).map((c) => c.method)).toEqual(['closePullRequest', 'deleteBranch']);
      },
    );

    it('takes a hold the gate marked pending for no refusal, and says the attack was unconcluded', async () => {
      const { calls, ask } = await serve({ guard: 'refuses', workflows: 'refused', review: 'held', waits: {} });
      const { body } = await ask('test');
      expect(body.refusals).toEqual([]);
      expect(body.gotThrough).toBeUndefined();
      expect(body.unconcluded).toEqual({
        what: `the review gate still waited for a read within the limit: ${PENDING}`,
      });
      expect(calls.slice(-2).map((c) => c.method)).toEqual(['closePullRequest', 'deleteBranch']);
    });

    it('waits past a pending hold for the gate to judge again, and answers that verdict', async () => {
      const held = await serve({ guard: 'refuses', workflows: 'refused', review: 'held', waits: { rejudged: 2 } });
      const refused = (await held.ask('test')).body;
      expect(refused.unconcluded).toBeUndefined();
      expect(verified((refused.refusals as SignedRefusal[])[0] as SignedRefusal).mechanism).toBe('review-gate');
      await close?.();
      const passed = await serve({ guard: 'refuses', workflows: 'refused', review: 'passed', waits: { rejudged: 2 } });
      expect((await passed.ask('test')).body.gotThrough).toEqual({
        what: 'the review check did not hold the pull request',
      });
    });

    it.each([
      ['held', 'other-head', 'the verdict does not judge #77 at its head'],
      ['held', 'other-rule', "the check's conclusion, failure, is not its rule's"],
      ['passed', 'other-head', 'the verdict does not judge #77 at its head'],
      ['passed', 'other-rule', "the check's conclusion, success, is not its rule's"],
    ] as const)(
      'reads a %s check whose block is %s as the line does: no verdict, unconcluded',
      async (review, block, why) => {
        const { ask } = await serve({ guard: 'refuses', workflows: 'refused', review, block });
        const { body } = await ask('test');
        expect(body.refusals).toEqual([]);
        expect(body.gotThrough).toBeUndefined();
        expect(body.unconcluded).toEqual({ what: why });
      },
    );

    it('answers what the last check said at the limit: a later check still running ends the wait it replaced', async () => {
      const { ask } = await serve({
        guard: 'refuses',
        workflows: 'refused',
        review: 'held',
        waits: { rejudged: 1, next: 'running' },
      });
      const { body } = await ask('test');
      expect(body.refusals).toEqual([]);
      expect(body.unconcluded).toEqual({ what: 'the review check did not conclude within the limit' });
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
    expect(body.message).toBe(
      'The attack door has no key to sign a refusal (REFUSAL_SIGNING_KEY), so it cannot answer one.',
    );
    expect(calls.some((c) => c.method === 'commit')).toBe(false);
  });

  it('answers 502 in its own words when it has nowhere to keep a refusal', async () => {
    const { ask } = await serve({ guard: 'refuses', workflows: 'refused', review: 'held' }, { kept: false });
    const { status, body } = await ask('workflow');
    expect(status).toBe(502);
    expect(body).toEqual({
      error: 'door',
      message: 'The attack door has nowhere to keep a refusal, so it cannot answer one.',
    });
  });

  it('answers 502 with a fixed message to a failure it did not write, and keeps the error’s words for its log', async () => {
    // A client error whose words the door did not write: here, as an API's detail might, a token-shaped string.
    const detail = 'GET /repos/x/git/ref/heads/main answered 500: Bearer ghs_16C7e42F292c6912E7710c838347Ae178B4a';
    const logged: string[] = [];
    const { ask } = await serve(
      { guard: 'refuses', workflows: 'refused', review: 'held', readFails: new GitHubError('server', detail, 500) },
      { logged },
    );
    for (const attack of ['workflow', 'test']) {
      const { status, body } = await ask(attack);
      expect(status).toBe(502);
      expect(body).toEqual({
        error: 'door',
        message: 'The attack door could not make the attack; the GitHub worker’s log says why.',
      });
      expect(JSON.stringify(body)).not.toContain('ghs_');
    }
    expect(logged).toHaveLength(2);
    // The log has the error, by what the request answered: the answer's place for the detail is there, not the 502.
    expect(logged.every((line) => line.includes('the attack door could not make an attack'))).toBe(true);
    expect(logged.every((line) => line.includes('ref/heads/main answered 500'))).toBe(true);
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
