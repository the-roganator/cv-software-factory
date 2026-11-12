import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actions } from '../../src/github/actions.ts';
import { BranchRefused } from '../../src/github/branches.ts';
import { GitHubError } from '../../src/github/client.ts';
import { DeployRefused } from '../../src/github/deploys.ts';
import { PatchRefused } from '../../src/github/patches.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker, GitHubWorkerError } from '../../src/github/worker-client.ts';
import { verifyRefusal } from '../../src/signed-refusals.ts';
import { doorReads } from './door-reads.ts';
import { quiet, REPO, SHA } from './fake.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const AT = () => new Date('2026-10-31T12:00:00Z');

/** Actions that each fail as asked, or succeed: what the guard and GitHub would have said is beside the point here. */
function failing(error: unknown): Actions {
  const fail = async () => {
    throw error;
  };
  return new Proxy({ dryRun: false } as Actions, {
    get: (target, name) => (name === 'dryRun' ? target.dryRun : fail),
  });
}

describe('the GitHub worker’s refusals', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function serve(error: unknown, { signed = true, heads = {} as Record<number, string> } = {}) {
    const key = signed ? privateKey : undefined;
    const dir = await mkdtemp(join(tmpdir(), 'refusals-'));
    const logged: Record<string, unknown>[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => void logged.push(JSON.parse(line)) });
    const server = createWorkerServer({
      actions: failing(error),
      reads: doorReads(heads),
      repositories: [REPO],
      health: () => ({}),
      recorder: new RefusalRecorder({ artifacts: new DiskArtifacts(dir), key, log, now: AT }),
      log: quiet,
    });
    const { url } = await listenLocal(server);
    close = () => server.close();
    const relayed: [unknown, unknown][] = [];
    const worker = new GitHubWorker(url, { onRefusal: (refusal, on) => void relayed.push([refusal, on]) });
    return { dir, logged, url, worker, relayed };
  }

  const patch = { branch: 'factory/1400-cart', expectedHead: SHA, patch: 'diff', message: 'fix' };

  it('answers its guard’s refusal of a protected path signed, with its status as before, and keeps it', async () => {
    const { dir, logged, worker, relayed } = await serve(
      new PatchRefused('protected', 'The patch changes .github/workflows/ci.yml, which no patch may.'),
    );
    const failed = await worker
      .act('applyPatch', REPO, patch, { workItem: '1400', agent: 'coder' })
      .catch((error: unknown) => error);
    // The line's handling is as it was: the same status and kind.
    expect(failed).toBeInstanceOf(GitHubWorkerError);
    expect(failed).toMatchObject({ status: 422, kind: 'patch-refused' });
    const { refusal } = failed as GitHubWorkerError;
    const verified = verifyRefusal(publicKey, refusal);
    expect(verified).toMatchObject({
      ok: true,
      refusal: {
        repo: REPO,
        number: null,
        at: '2026-10-31T12:00:00.000Z',
        payload: {
          mechanism: 'github-guard',
          action: `applyPatch branch factory/1400-cart in ${REPO}`,
          output: 'The patch changes .github/workflows/ci.yml, which no patch may.',
          guardrails: [1],
        },
      },
    });
    // The record is the artifact, by its hash; the relay is told, with what the action was for.
    const record = (refusal as { record: string }).record;
    expect(await readdir(dir)).toEqual([record]);
    expect(JSON.parse(await readFile(join(dir, record), 'utf-8'))).toMatchObject({
      type: 'action.refused',
      repo: REPO,
    });
    expect(relayed).toEqual([[refusal, { workItem: '1400', agent: 'coder' }]]);
    // Logged with its hash, for Loki: the cross-check on a relay that drops one.
    expect(logged).toEqual([
      expect.objectContaining({ msg: 'refused: recorded as action.refused', record, mechanism: 'github-guard' }),
    ]);
  });

  it('signs a branch, a deploy, and GitHub’s 403 to its token, each with its guardrail', async () => {
    const cases = [
      [new BranchRefused('main is not the factory’s.'), 'setBranch', 422, 'github-guard', [1]],
      [new DeployRefused('#9 is not a deploy pull request.'), 'describeDeploy', 422, 'github-guard', [1]],
      [
        new GitHubError('refused', 'PUT /repos/x/contents answered 403: Resource not accessible by integration', 403),
        'commit',
        403,
        'token-permission',
        [1],
      ],
    ] as const;
    for (const [error, action, status, mechanism, guardrails] of cases) {
      const { worker } = await serve(error);
      const args = {
        setBranch: { branch: 'main', sha: SHA },
        describeDeploy: { number: 9, commit: SHA, carries: [] },
        commit: { branch: 'factory/x', expectedHead: SHA, message: 'm', changes: { additions: [], deletions: [] } },
      }[action];
      const failed = (await worker.act(action, REPO, args as never).catch((e: unknown) => e)) as GitHubWorkerError;
      expect(failed.status, action).toBe(status);
      expect(verifyRefusal(publicKey, failed.refusal), action).toMatchObject({
        ok: true,
        refusal: { payload: { mechanism, guardrails }, number: action === 'describeDeploy' ? 9 : null },
      });
      close?.();
    }
  });

  /** An action asked through the door, answered as the guard would, or as the action itself fails when it passes. */
  async function ask(action: string, args: unknown, heads: Record<number, string> = {}) {
    // The actions would fail as no refusal does: only the door's guard can answer one refused.
    const { worker } = await serve(new Error('the action was reached'), { heads });
    const failed = (await worker
      .act(action as never, REPO, args as never)
      .catch((e: unknown) => e)) as GitHubWorkerError;
    close?.();
    return failed;
  }

  it('refuses, signed, a pull request from a pin branch or a pin label from a worker that asks: only the pin watch makes one', async () => {
    const asks = [
      ['openPullRequest', { head: 'factory/pin/node-24', base: 'main', title: 't', body: '' }],
      ['openPullRequest', { head: 'factory/pin-next/node-24', base: 'main', title: 't', body: '' }],
      ['openPullRequest', { head: 'refs/heads/factory/pin/node-24', base: 'main', title: 't', body: '' }],
      ['openPullRequest', { head: 'factory/1400-cart', base: 'main', title: 't', body: '', labels: ['pin'] }],
      ['addLabels', { number: 1040, labels: ['bug', 'pin'] }],
      ['addLabels', { number: 1040, labels: ['Pin'] }],
      ['openIssue', { title: 't', body: '', labels: [' PIN '] }],
    ] as const;
    for (const [action, args] of asks) {
      const failed = await ask(action, args);
      expect(failed.status, JSON.stringify(args)).toBe(422);
      expect(verifyRefusal(publicKey, failed.refusal), action).toMatchObject({
        ok: true,
        refusal: { payload: { mechanism: 'github-guard' } },
      });
    }
  });

  it('refuses, signed, every action a worker asks on the pin watch’s pull request by its number, and passes the same on another', async () => {
    const pullRequest = { number: 1040, url: 'https://github.com/x/pull/1040', nodeId: 'PR_x' };
    const asks = [
      ['enqueuePullRequest', { number: 1040, expectedHead: SHA }],
      ['reopenIssue', { number: 1040, comment: 'again' }],
      ['closeIssue', { number: 1040, reason: 'completed' }],
      ['closePullRequest', { number: 1040, comment: 'gone' }],
      ['updatePullRequest', { number: 1040, title: 't' }],
      ['addLabels', { number: 1040, labels: ['bug'] }],
      ['readyForReview', { pullRequest }],
      ['convertToDraft', { pullRequest }],
      ['comment', { number: 1040, body: 'a worker’s comment' }],
      ['review', { number: 1040, commit: SHA, body: 'a worker’s review', comments: [] }],
      ['resolveThreads', { number: 1040, threads: [{ path: 'README.md', line: 1, body: 'x', reply: 'resolved' }] }],
      ['describeDeploy', { number: 1040, commit: SHA, carries: [] }],
    ] as const;
    for (const [action, args] of asks) {
      const refused = await ask(action, args, { 1040: 'factory/pin/node-24' });
      expect(refused.status, action).toBe(422);
      expect(verifyRefusal(publicKey, refused.refusal), action).toMatchObject({
        ok: true,
        refusal: { payload: { mechanism: 'github-guard' }, number: 1040 },
      });
      // The same action on the line's own pull request, or on an issue, passes the door and reaches the action.
      for (const heads of [{ 1040: 'factory/1400-cart' }, {}]) {
        const passed = await ask(action, args, heads);
        expect(passed.status, `${action} ${JSON.stringify(heads)}`).toBe(500);
        expect(passed.refusal).toBeUndefined();
      }
    }
    const opened = await ask('openPullRequest', { head: 'factory/1400-cart', base: 'main', title: 't', body: '' });
    expect(opened.status).toBe(500);
  });

  it('does not take a failure for a refusal: a patch that will not apply, a 401, a rate limit, a 404', async () => {
    const failures = [
      new PatchRefused('does-not-apply', 'The patch does not apply.'),
      new PatchRefused('unsupported', 'The patch renames a file.'),
      new GitHubError('refused', 'answered 401: Bad credentials', 401),
      Object.assign(new GitHubError('rate-limited', 'answered 403: API rate limit exceeded', 403), { waitMs: 0 }),
      new GitHubError('not-found', 'answered 404', 404),
    ];
    for (const error of failures) {
      const { dir, worker, relayed } = await serve(error);
      const failed = (await worker.act('applyPatch', REPO, patch).catch((e: unknown) => e)) as GitHubWorkerError;
      expect(failed.refusal, error.message).toBeUndefined();
      expect(relayed).toEqual([]);
      expect(await readdir(dir)).toEqual([]);
      close?.();
    }
  });

  it('without its key, keeps and logs each refusal, and answers it unsigned, which does not verify', async () => {
    const { dir, logged, worker } = await serve(new BranchRefused('main is not the factory’s.'), { signed: false });
    const failed = (await worker
      .act('setBranch', REPO, { branch: 'main', sha: SHA })
      .catch((e: unknown) => e)) as GitHubWorkerError;
    expect(failed.refusal).toMatchObject({ payload: { mechanism: 'github-guard' } });
    expect(failed.refusal).not.toHaveProperty('signature');
    expect(verifyRefusal(publicKey, failed.refusal)).toEqual({ ok: false, why: 'it is not signed' });
    expect(await readdir(dir)).toHaveLength(1);
    expect(logged[0]).toMatchObject({ signed: false });
  });
});
