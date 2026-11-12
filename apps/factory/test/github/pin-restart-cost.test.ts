/**
 * What the in-memory record costs. A worker that starts again knows no commit, so its
 * first pass writes every open pin pull request's branch again, on main's head: a new head each, the one Martin holds
 * and any he approved among them. Measured over the fixture day's five pull-request moves, with every move taken.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PIN_PREFIX } from '../../src/github/branches.ts';
import { readPinScope } from '../../src/github/pins.ts';
import { calls } from './fake.ts';
import { heldByMartin, worker } from './pin-worker-harness6.ts';
import { day, FakeRepo, FILES, factoryMoves, writes } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

const pinHeads = (repo: FakeRepo) =>
  Object.fromEntries([...repo.refs].filter(([name]) => name.startsWith(PIN_PREFIX)).map(([n, sha]) => [n, sha]));
const _tally = (sent: { method: string; path: string }[]) => {
  const by: Record<string, number> = {};
  for (const s of sent) {
    const what =
      s.path === '/graphql'
        ? 'POST createCommitOnBranch'
        : `${s.method} ${s.path
            .replace(/\?.*$/, '')
            .replace(/\/repos\/[^/]+\/[^/]+/, '')
            .replace(/heads\/.*$/, 'heads/…')
            .replace(/\/\d+/g, '/N')
            .replace(/[0-9a-f]{40}/, 'SHA')}`;
    by[what] = (by[what] ?? 0) + 1;
  }
  return by;
};

describe('what a restart costs', () => {
  it('each restart gives every open pin pull request a new head, a held one too; a steady pass writes nothing', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const today = () => day(scanned, factoryMoves());
    const first = await worker(repo, readPinScope('*'), today, closing);
    await first.pass();
    const open = repo.pulls.filter((p) => p.state === 'open');
    const before = pinHeads(repo);
    expect(open.length).toBe(5);

    // Martin holds the major by its label; it stays open, as the live plan expects.
    const major = open.find((p) => p.head === 'factory/pin/example-logs');
    if (!major) throw new Error('no pull request for the major');
    first.events.set(major.number, heldByMartin());

    // A steady pass: no write, and one read of each branch's ref more than before this change.
    first.sent.length = 0;
    await first.watchOnly();
    const steady = calls(first.sent);
    expect(writes(first.sent)).toEqual([]);
    expect(steady.filter((s) => s.path.includes('/git/ref/heads/factory/pin/')).length).toBe(5);
    expect(pinHeads(repo)).toEqual(before);

    // Three restarts, each a worker that knows no commit.
    let heads = before;
    let commits = 0;
    for (let restart = 1; restart <= 3; restart++) {
      const next = await worker(repo, readPinScope('*'), today, closing);
      next.events.set(major.number, heldByMartin());
      // Nothing is queued before its watch has written.
      await next.queueOnly();
      expect(next.enqueued).toEqual([]);
      next.sent.length = 0;
      await next.watchOnly();
      const after = pinHeads(repo);
      const moved = Object.keys(after).filter((branch) => after[branch] !== heads[branch]);
      const sent = writes(next.sent);
      commits += sent.filter((s) => s.path === '/graphql').length;
      if (restart === 1) expect(moved.length).toBe(5);
      expect(moved).toContain('factory/pin/example-logs');
      heads = after;
      await next.queueOnly();
      // The four not held are queued again, at their new heads, once the gate and the checks pass those (stubbed here).
      expect(next.enqueued.map((e) => e.number).sort()).toEqual(
        open
          .filter((p) => p !== major)
          .map((p) => p.number)
          .sort(),
      );
    }
    expect(commits).toBe(15);
  });

  it('two workers that both write (a second one on the host, without GITHUB_DRY_RUN) never agree: each pass of each writes the branch again', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const today = () => day(scanned, factoryMoves());
    const only = readPinScope('example-dashboards');
    const one = await worker(repo, only, today, closing);
    const two = await worker(repo, only, today, closing);
    const seen = new Set<string>();
    for (let hour = 0; hour < 4; hour++) {
      for (const w of [one, two]) {
        await w.watchOnly();
        seen.add(repo.refs.get('factory/pin/example-dashboards') as string);
      }
    }
    expect(seen.size).toBe(8);
    // One worker alone, over the same hours: one head.
    const alone = new FakeRepo(FILES);
    const solo = await worker(alone, only, () => day(alone.main, factoryMoves()), closing);
    const heads = new Set<string>();
    for (let hour = 0; hour < 8; hour++) {
      await solo.watchOnly();
      heads.add(alone.refs.get('factory/pin/example-dashboards') as string);
    }
    expect(heads.size).toBe(1);
  });

  it('a commit Martin adds to a pin pull request (or GitHub’s "Update branch") is written over on the watch’s next pass, with a log line', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = await worker(repo, readPinScope('example-logs'), () => day(scanned, factoryMoves()), closing);
    await w.watchOnly();
    const branch = 'factory/pin/example-logs';
    // Martin's commit on the major's branch: the value the new major needs changed with it.
    const main = repo.main;
    const his = repo.push({ 'deploy/base/telemetry/values/logs.yaml': 'his: change\n' });
    repo.refs.set('main', main);
    repo.refs.set(branch, his);
    await w.watchOnly();
    expect(repo.refs.get(branch)).not.toBe(his);
    expect(repo.file(branch, 'deploy/base/telemetry/values/logs.yaml')).not.toContain('his: change');
  });
});
