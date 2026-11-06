import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LOGIN, DryRunActions } from '../../src/github/actions.ts';
import { DRY_RUN_CHECK_TITLE, DryRunReads } from '../../src/github/dry-run-reads.ts';
import type { Reads } from '../../src/github/reads.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker } from '../../src/github/worker-client.ts';
import { gateEvents, gateRecord } from '../../src/line/gates.ts';
import { quiet, REPO, SHA } from './fake.ts';

const BRANCH = 'factory/1001-cart';
const MINUTE = 60_000;
const TIMES = { checksAfterMs: 2 * MINUTE, mergeAfterMs: 20 * MINUTE };
const REQUIRED = ['Unit tests', 'Journeys'];

/** GitHub as it really is: the app's main, its ruleset, and one real pull request. */
function live(asked: string[] = []): Reads {
  const no = (what: string) => () => Promise.reject(new Error(`GitHub has no ${what}`));
  return {
    pullRequest: async (_repo, number) => {
      asked.push(`pullRequest ${number}`);
      if (number !== 7) return no(`pull request #${number}`)();
      return {
        number: 7,
        state: 'open',
        merged: false,
        mergeCommit: null,
        mergedBy: null,
        head: { ref: 'feat/x', sha: 'c'.repeat(40) },
        base: { ref: 'main', sha: SHA },
        draft: false,
        nodeId: 'PR_real',
      };
    },
    pullRequestFrom: async () => null,
    checkRuns: async (_repo, sha) => {
      asked.push(`checkRuns ${sha}`);
      return [];
    },
    requiredChecks: async () => REQUIRED,
    head: async (_repo, branch) => (branch === 'main' ? SHA : no(`branch ${branch}`)()),
    protectedPaths: async (_repo, ref) => {
      asked.push(`protectedPaths ${ref}`);
      return ['.github/', 'deploy/'];
    },
    comparison: no('comparison'),
    file: async (_repo, ref, path) => {
      asked.push(`file ${path} ${ref}`);
      return path === 'test/cart.test.ts' ? { found: true, text: "it('counts', () => {});\n" } : { found: false };
    },
    checkout: async (_repo, sha) => ({ commit: sha, commits: [] }),
    commits: async (_repo, base, head) => {
      asked.push(`commits ${base}...${head}`);
      return { status: 'ahead', total: 1, commits: [head] };
    },
    imageRevision: async () => SHA,
    imageSigned: async () => ({ signed: true, reason: null }),
    deployProposal: async () => ({ number: 30, commit: SHA, pinned: null, digests: [] }),
    reviewVerdict: async (_repo, number) => {
      asked.push(`reviewVerdict ${number}`);
      const head = 'c'.repeat(40);
      return { number, head, check: null, verdict: null, judged: null, problem: 'no check' };
    },
    mergeQueue: async (_repo, number) => {
      asked.push(`mergeQueue ${number}`);
      return { number, head: 'c'.repeat(40), state: 'open', queued: null, added: null, removed: null, checks: [] };
    },
    mergeability: async (_repo, number) => {
      asked.push(`mergeability ${number}`);
      return { number, head: 'c'.repeat(40), conflicts: true, state: 'dirty' };
    },
  };
}

/** A dry run with a clock, and the app's one file as it is on main. */
async function dryRun(asked: string[] = []) {
  let now = new Date('2026-10-06T22:00:00Z');
  const files: Record<string, string> = { 'src/cart.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;\n' };
  const made = new DryRunActions(
    new DiskArtifacts(await mkdtemp(join(tmpdir(), 'dry-run-reads-'))),
    quiet,
    () => now,
    async (_repo, path, ref) => (ref === SHA ? (files[path] ?? null) : null),
  );
  const reads = new DryRunReads(made, live(asked), TIMES, () => now);
  // The coder's push, as the line makes it: the branch at main, its patch, and a draft pull request.
  await made.setBranch(REPO, BRANCH, SHA, { force: true });
  const commit = await made.applyPatch(REPO, {
    branch: BRANCH,
    expectedHead: SHA,
    message: 'fix(cart): count b',
    patch: [
      'diff --git a/src/cart.ts b/src/cart.ts',
      '--- a/src/cart.ts',
      '+++ b/src/cart.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 20;',
      ' const c = 3;',
      '',
    ].join('\n'),
  });
  const { number } = await made.openPullRequest(REPO, {
    head: BRANCH,
    base: 'main',
    title: 't',
    body: 'b',
    draft: true,
  });
  return { made, reads, commit, number, later: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('a dry run’s reads', () => {
  it('answer for the pull request it opened: open, a draft, its head the commit it would have pushed', async () => {
    const { reads, commit, number } = await dryRun();
    expect(await reads.pullRequest(REPO, number)).toMatchObject({
      number,
      state: 'open',
      merged: false,
      head: { ref: BRANCH, sha: commit },
      base: { ref: 'main', sha: SHA },
      draft: true,
    });
    expect(await reads.pullRequestFrom(REPO, BRANCH)).toMatchObject({ number });
    expect(await reads.head(REPO, BRANCH)).toBe(commit);
  });

  it('pass every check main requires, once the checks have had their time, so the gates finish', async () => {
    const { reads, commit, number, later } = await dryRun();
    const read = async () => {
      const pr = await reads.pullRequest(REPO, number);
      return gateEvents(pr, await reads.checkRuns(REPO, pr.head.sha), REQUIRED, gateRecord([]));
    };
    expect((await read()).map((d) => d.type)).toEqual(['gates.started']);

    later(TIMES.checksAfterMs);
    const drafts = await read();
    expect(drafts.map((d) => d.type)).toEqual(['gates.started', 'gate.finished', 'gate.finished', 'gates.finished']);
    expect(drafts.at(-1)?.payload).toMatchObject({ commit, conclusion: 'passed', passed: 2, failed: [] });
    // Nothing ran, and the gate says so.
    expect(drafts[1]?.payload).toMatchObject({ check: 'Unit tests', required: true, summary: DRY_RUN_CHECK_TITLE });
    // And it said nothing was wrong.
    expect((await reads.checkRuns(REPO, commit)).some((run) => 'annotations' in run)).toBe(false);
    expect(drafts.some((d) => d.type === 'gate.finished' && 'annotations' in d.payload)).toBe(false);
  });

  it('never merge it while it is a draft, and merge it as the App a while after it is readied', async () => {
    const { made, reads, number, later } = await dryRun();
    later(TIMES.mergeAfterMs * 3);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ state: 'open', merged: false, draft: true });
    await made.readyForReview(REPO, { number, url: '', nodeId: `dry-run-${number}` });
    later(TIMES.mergeAfterMs - 1);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ state: 'open', merged: false, draft: false });
    later(1);
    const pr = await reads.pullRequest(REPO, number);
    expect(pr).toMatchObject({ state: 'closed', merged: true, mergedBy: APP_LOGIN });
    expect(pr.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    const [merged] = gateEvents(pr, [], REQUIRED, gateRecord([]));
    expect(merged).toMatchObject({ type: 'pull-request.merged', actor: 'factory', payload: { number, by: 'factory' } });
    expect(await reads.pullRequestFrom(REPO, BRANCH)).toBeNull();
  });

  it('never merge one put back to draft, and merge it a while after it is readied again', async () => {
    const { made, reads, number, later } = await dryRun();
    await made.readyForReview(REPO, { number, url: '', nodeId: `dry-run-${number}` });
    later(TIMES.mergeAfterMs - 1);
    await made.convertToDraft(REPO, { number, url: '', nodeId: `dry-run-${number}` });
    later(TIMES.mergeAfterMs * 3);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ state: 'open', merged: false, draft: true });
    await made.readyForReview(REPO, { number, url: '', nodeId: `dry-run-${number}` });
    later(TIMES.mergeAfterMs - 1);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ state: 'open', merged: false, draft: false });
    later(1);
    expect(await reads.pullRequest(REPO, number)).toMatchObject({ state: 'closed', merged: true });
  });

  it('read a pull request it closed as closed and unmerged, which never merges', async () => {
    const { made, reads, number, later } = await dryRun();
    await made.readyForReview(REPO, { number, url: '', nodeId: `dry-run-${number}` });
    await made.closePullRequest(REPO, number, 'Closed unmerged: the defect this fixes is gone from production.');
    later(TIMES.mergeAfterMs * 3);
    const pr = await reads.pullRequest(REPO, number);
    expect(pr).toMatchObject({ state: 'closed', merged: false, mergeCommit: null });
    expect(gateEvents(pr, [], REQUIRED, gateRecord([]))).toMatchObject([
      { type: 'work-item.closed', payload: { outcome: 'no-change' } },
    ]);
    expect(await reads.pullRequestFrom(REPO, BRANCH)).toBeNull();
  });

  it('compare its commit with main as GitHub would: from the real commit it went on, with each file’s hunks', async () => {
    const { reads, commit } = await dryRun();
    const compared = await reads.comparison(REPO, 'main', commit);
    expect(compared.mergeBase).toBe(SHA);
    expect(compared.files).toEqual([
      {
        path: 'src/cart.ts',
        added: 1,
        removed: 1,
        patch: '@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 20;\n const c = 3;',
      },
    ]);
  });

  it('read the protected paths where its commits went, and everything it did not make from GitHub', async () => {
    const asked: string[] = [];
    const { reads, commit } = await dryRun(asked);
    await reads.protectedPaths(REPO, commit);
    expect(asked).toEqual([`protectedPaths ${SHA}`]);
    expect(await reads.head(REPO, 'main')).toBe(SHA);
    expect((await reads.pullRequest(REPO, 7)).nodeId).toBe('PR_real');
    await reads.checkRuns(REPO, SHA);
    expect(asked).toContain(`checkRuns ${SHA}`);
  });

  it('read a file as its commits left it, and one it never touched where its commits went', async () => {
    const asked: string[] = [];
    const { reads, commit } = await dryRun(asked);
    expect(await reads.file(REPO, commit, 'src/cart.ts')).toEqual({
      found: true,
      text: 'const a = 1;\nconst b = 20;\nconst c = 3;\n',
    });
    expect(await reads.file(REPO, commit, 'test/cart.test.ts')).toEqual({
      found: true,
      text: "it('counts', () => {});\n",
    });
    expect(asked).toEqual([`file test/cart.test.ts ${SHA}`]);
  });

  it('read what a release is made of as it really is: no image was built from a commit the dry run made', async () => {
    const asked: string[] = [];
    const { reads, commit } = await dryRun(asked);
    expect(await reads.commits(REPO, SHA, commit)).toEqual({ status: 'ahead', total: 1, commits: [commit] });
    expect(asked).toContain(`commits ${SHA}...${commit}`);
    const image = 'the-roganator/cv-worlds-worst-website';
    expect(await reads.imageRevision(REPO, image, `sha256:${'1'.repeat(64)}`)).toBe(SHA);
    expect(await reads.imageSigned(REPO, image, `sha256:${'1'.repeat(64)}`)).toEqual({ signed: true, reason: null });
    expect(await reads.deployProposal(REPO, 'deploy/local')).toMatchObject({ number: 30 });
  });
});

describe('a dry run’s checkout', () => {
  it('names the real commit under its pull request, and its commits on it as patches git applies, oldest first', async () => {
    const { made, reads, commit } = await dryRun();
    // A later commit made from whole files, as the worker's commit action makes one: a change, a new file, and none
    // of the first.
    const second = await made.commit(REPO, {
      branch: BRANCH,
      expectedHead: commit,
      message: 'test(cart): count c',
      changes: {
        additions: [
          { path: 'src/cart.ts', contents: new TextEncoder().encode('const a = 1;\nconst b = 20;\nconst c = 30;\n') },
          { path: 'test/cart.test.ts', contents: new TextEncoder().encode('c is 30\n') },
        ],
        deletions: [],
      },
    });
    const checkout = await reads.checkout(REPO, second);
    expect(checkout.commit).toBe(SHA);
    expect(checkout.commits.map((c) => c.message)).toEqual(['fix(cart): count b', 'test(cart): count c']);

    // As the runner's prepare step makes them: on the real commit's files, with git.
    const dir = await mkdtemp(join(tmpdir(), 'checkout-'));
    const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: dir, input, encoding: 'utf-8' });
    git(['init', '--quiet']);
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src/cart.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    for (const { patch } of checkout.commits) git(['apply', '-'], patch);
    expect(await readFile(join(dir, 'src/cart.ts'), 'utf-8')).toBe('const a = 1;\nconst b = 20;\nconst c = 30;\n');
    expect(await readFile(join(dir, 'test/cart.test.ts'), 'utf-8')).toBe('c is 30\n');
  });

  it('leaves a commit GitHub has to GitHub', async () => {
    const { reads } = await dryRun();
    expect(await reads.checkout(REPO, SHA)).toEqual({ commit: SHA, commits: [] });
  });
});

describe('the worker’s reads over HTTP', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it('answer from the dry run only for a worker that asks for one', async () => {
    const { made, reads, number } = await dryRun();
    const server = createWorkerServer({
      actions: made,
      reads: live(),
      dryRun: made,
      dryRunReads: reads,
      repositories: [REPO],
      health: () => ({}),
      log: quiet,
    });
    const { url } = await listenLocal(server);
    close = () => server.close();

    const pr = await new GitHubWorker(url, { dryRun: true }).read('pullRequest', REPO, { number });
    expect(pr.number).toBe(number);
    await expect(new GitHubWorker(url).read('pullRequest', REPO, { number })).rejects.toThrow();
  });
});
