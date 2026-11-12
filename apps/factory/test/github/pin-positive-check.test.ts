/**
 * The positive check (`WatchedHeads`, `headWait`).
 *
 * The record is set only from what `commitPins` gives back: the id of the commit GitHub's `createCommitOnBranch` made
 * on main's head for the watch's own edits. A branch moved by anyone else (set here straight in the fake repository,
 * as a write route nobody has found would) is never adopted, at a restart or in a race, and the enqueue goes only at
 * the recorded commit, which GitHub takes only while the branch is at it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WatchedHeads } from '../../src/github/branches.ts';
import { headWait, type QueuePull } from '../../src/github/deploy-queue.ts';
import { readPinScope } from '../../src/github/pins.ts';
import { worker } from './pin-worker-harness6.ts';
import { day, FACTORY, FakeRepo, FILES, factoryMoves } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

const A = 'factory/pin/example-dashboards';
const ONLY = readPinScope('example-dashboards');

async function start(options: { realEnqueue?: boolean } = {}) {
  const repo = new FakeRepo(FILES);
  const scanned = repo.main;
  const today = () => day(scanned, factoryMoves());
  const w = await worker(repo, ONLY, today, closing, options);
  await w.watchOnly();
  const pull = repo.pulls.find((p) => p.head === A && p.state === 'open');
  if (!pull) throw new Error('the pin watch opened nothing');
  return { repo, w, pull, today };
}

/** A commit of somebody else's, on main: what a worker would put under the pull request if it could write the branch. */
const theirs = (repo: FakeRepo) => {
  const main = repo.main;
  const made = repo.push({
    'deploy/base/telemetry/dashboards.yaml': 'spec:\n  source:\n    chart: evil\n    targetRevision: 0.0.1\n',
  });
  repo.refs.set('main', main);
  return made;
};

describe('a commit the watch did not write is never the recorded one', () => {
  it('the branch moved under the pull request is not queued, and the watch writes its own again', async () => {
    const { repo, w, pull } = await start();
    const watchs = repo.refs.get(A) as string;
    expect(w.heads.get(FACTORY, A)).toBe(watchs);
    const evil = theirs(repo);
    repo.refs.set(A, evil);
    await w.queueOnly();
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
    await w.watchOnly();
    const again = repo.refs.get(A) as string;
    expect(again).not.toBe(evil);
    expect(w.heads.get(FACTORY, A)).toBe(again);
    expect(repo.file(A, 'deploy/base/telemetry/dashboards.yaml')).toContain('targetRevision: 13.7.2');
    await w.queueOnly();
    expect(w.enqueued).toEqual([{ number: pull.number, head: again }]);
  });

  it('a commit left on the branch across a restart is not adopted, and nothing is queued before the rewrite', async () => {
    const { repo, pull, today } = await start();
    const evil = theirs(repo);
    repo.refs.set(A, evil);
    // The worker starts again: a new record, the same repository.
    const next = await worker(repo, ONLY, today, closing);
    await next.queueOnly();
    await next.queueOnly();
    expect(next.enqueued).toEqual([]);
    expect(next.heads.get(FACTORY, A)).toBeUndefined();
    await next.pass();
    expect(repo.refs.get(A)).not.toBe(evil);
    expect(next.enqueued).toEqual([{ number: pull.number, head: repo.refs.get(A) }]);
  });

  it('the branch moved in the instant after the watch’s own write: the record is the watch’s commit, not what the branch holds', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = await worker(repo, ONLY, () => day(scanned, factoryMoves()), closing);
    const evil = theirs(repo);
    // Whoever races it sets the pin branch the moment GitHub has taken the watch's own update of it.
    w.race.afterWrite = (sent) => {
      if (sent.method === 'PATCH' || sent.method === 'POST') {
        if (sent.path.endsWith(`/git/refs/heads/${A}`) || (sent.body as { ref?: string })?.ref === `refs/heads/${A}`)
          repo.refs.set(A, evil);
      }
    };
    await w.watchOnly();
    delete w.race.afterWrite;
    expect(repo.refs.get(A)).toBe(evil);
    expect(w.heads.get(FACTORY, A)).not.toBe(evil);
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
  });

  it('every read lagging at the watch’s commit while the branch holds another: the enqueue names the watch’s commit, and GitHub does not take it', async () => {
    const { repo, w } = await start({ realEnqueue: true });
    const watchs = repo.refs.get(A) as string;
    const evil = theirs(repo);
    repo.refs.set(A, evil);
    // The list, the gate's verdict, the mergeability and the queue's read all still name the watch's commit.
    w.lag.set(A, watchs);
    w.lagging.all = true;
    for (let i = 0; i < 7; i++) await w.queueOnly();
    expect(w.taken).toEqual([]);
    expect(w.enqueued).toEqual([]);
    // The only enqueue the worker ever sent named the watch's own commit.
    const asked = w.sent
      .filter((s) => s.path === '/graphql' && JSON.stringify(s.body).includes('enqueuePullRequest('))
      .map((s) => (s.body as { variables: { input: { expectedHeadOid: string } } }).variables.input.expectedHeadOid);
    expect(new Set(asked)).toEqual(new Set(asked.length ? [watchs] : []));
  });

  it('a list lagging at an older commit of the watch’s own is not queued at it', async () => {
    const { repo, w, today } = await start();
    const first = repo.refs.get(A) as string;
    // A restart writes the branch again; GitHub's list still names the first commit.
    const next = await worker(repo, ONLY, today, closing);
    next.lag.set(A, first);
    await next.pass();
    expect(repo.refs.get(A)).not.toBe(first);
    expect(next.enqueued).toEqual([]);
    expect(w.enqueued).toEqual([]);
  });

  it('one branch’s recorded commit passes no other branch, in this repository or another', () => {
    const heads = new WatchedHeads();
    const sha = 'd'.repeat(40);
    heads.set(FACTORY, 'deploy/local', sha);
    const pull = (ref: string) => ({ head: { ref, sha, repo: { full_name: FACTORY } } }) as QueuePull;
    expect(headWait(heads, FACTORY, pull('deploy/local'), 'not-a-deploy')).toBeUndefined();
    expect(headWait(heads, FACTORY, pull(A), 'not-a-pin')).toBeDefined();
    expect(
      headWait(heads, 'the-roganator/cv-worlds-worst-website', pull('deploy/local'), 'not-a-deploy'),
    ).toBeDefined();
    // The key is the repository and the branch with a space between: neither may hold one (a repository's name
    // cannot, and git refuses a space in a ref), so no pair of them makes another pair's key.
    heads.set('a b', 'c', sha);
    expect(heads.get('a', 'b c')).toBe(sha);
  });

  it('a later target writes a new commit, and the record of the old one is gone', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const at = { to: '13.7.2' };
    const moves = () =>
      factoryMoves().map((m) =>
        m.name === 'example-dashboards' ? { ...m, to: `chart example-dashboards ${at.to}` } : m,
      );
    const w = await worker(repo, ONLY, () => day(scanned, moves()), closing);
    await w.watchOnly();
    const old = repo.refs.get(A) as string;
    at.to = '13.8.0';
    await w.watchOnly();
    expect(w.heads.get(FACTORY, A)).toBe(repo.refs.get(A));
    // The branch put back at the watch's older commit, for the older target, is not the watch's now.
    repo.refs.set(A, old);
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
  });

  it('a move gone closes its pull request and forgets its commit', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const at = { gone: false };
    const moves = () => factoryMoves().filter((m) => !at.gone || m.name !== 'example-dashboards');
    const w = await worker(repo, ONLY, () => day(scanned, moves()), closing);
    await w.watchOnly();
    expect(w.heads.get(FACTORY, A)).toBeDefined();
    at.gone = true;
    await w.watchOnly();
    expect(w.heads.get(FACTORY, A)).toBeUndefined();
  });
});
