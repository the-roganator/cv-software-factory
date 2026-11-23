/**
 * What a restart costs. A worker that starts again knows no commit; its first pass takes, as its own, each open pin
 * pull request's head that is already the commit it would write (`alreadyWritten`): one commit of the App's, on a
 * commit of main whose files it writes are as at main's head, writing exactly what the guard gives back for the day's
 * moves, and nothing else. Such a pull request keeps its head, its checks and its place, however far main has moved
 * elsewhere; any other head is written again, as before. Measured over the fixture day's five pull-request moves, with
 * every move taken.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LOGIN } from '../../src/github/actions.ts';
import { PIN_PREFIX } from '../../src/github/branches.ts';
import { readPinScope } from '../../src/github/pins.ts';
import { calls } from './fake.ts';
import { heldByMartin, worker } from './pin-worker-harness6.ts';
import { day, FACTORY, FakeRepo, FILES, factoryMoves, pinBranchOf, writes } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

const pinHeads = (repo: FakeRepo) =>
  Object.fromEntries([...repo.refs].filter(([name]) => name.startsWith(PIN_PREFIX)).map(([n, sha]) => [n, sha]));

const DASHBOARDS = pinBranchOf('example-dashboards');
const DASHBOARDS_FILE = 'deploy/base/telemetry/dashboards.yaml';
const ONLY = readPinScope('example-dashboards');

/** One worker's pull request for the dashboards chart, and the day it was written for. */
async function opened() {
  const repo = new FakeRepo(FILES);
  const scanned = repo.main;
  const today = () => day(scanned, factoryMoves());
  const first = await worker(repo, ONLY, today, closing);
  await first.watchOnly();
  const pull = repo.pulls.find((p) => p.head === DASHBOARDS && p.state === 'open');
  if (!pull) throw new Error('the pin watch opened nothing');
  return { repo, today, pull, written: repo.refs.get(DASHBOARDS) as string };
}

/** A worker started again over the same repository, after one pass of its watch and its queue. */
async function restarted(repo: FakeRepo, today: () => ReturnType<typeof day>) {
  const next = await worker(repo, ONLY, today, closing);
  await next.queueOnly();
  expect(next.enqueued).toEqual([]);
  await next.pass();
  return next;
}

describe('what a restart costs', () => {
  it('a restart gives no open pin pull request a new head, a held one neither; a steady pass writes nothing', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const today = () => day(scanned, factoryMoves());
    const first = await worker(repo, readPinScope('*'), today, closing);
    await first.pass();
    const open = repo.pulls.filter((p) => p.state === 'open');
    const before = pinHeads(repo);
    expect(open.length).toBe(5);

    // Martin holds the major by its label; it stays open, as the live plan expects.
    const major = open.find((p) => p.head === pinBranchOf('example-logs'));
    if (!major) throw new Error('no pull request for the major');
    first.events.set(major.number, heldByMartin());

    // A steady pass: no write, and one read of each branch's ref.
    first.sent.length = 0;
    await first.watchOnly();
    const steady = calls(first.sent);
    expect(writes(first.sent)).toEqual([]);
    expect(steady.filter((s) => s.path.includes('/git/ref/heads/factory/pin/')).length).toBe(5);
    expect(steady.filter((s) => s.path.includes('/compare/')).length).toBe(0);
    expect(pinHeads(repo)).toEqual(before);

    // Three restarts, each a worker that knows no commit; between the second and the third, main moves by a merge that
    // touches none of their files, as the day's lockfile pull request's did.
    for (let restart = 1; restart <= 3; restart++) {
      if (restart === 3) repo.push({ 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n# moved\n' });
      const next = await worker(repo, readPinScope('*'), today, closing);
      next.events.set(major.number, heldByMartin());
      // Nothing is queued before its watch has looked.
      await next.queueOnly();
      expect(next.enqueued).toEqual([]);
      next.sent.length = 0;
      await next.watchOnly();
      expect(writes(next.sent).filter((s) => s.path === '/graphql' || s.path.includes('/git/refs'))).toEqual([]);
      // One comparison with main for each branch, and nothing more of the branch's own than a steady pass reads.
      expect(calls(next.sent).filter((s) => s.path.includes('/compare/')).length).toBe(5);
      expect(pinHeads(repo)).toEqual(before);
      await next.queueOnly();
      // The four not held are queued at the heads they had.
      expect(next.enqueued.sort((a, b) => a.number - b.number)).toEqual(
        open
          .filter((p) => p !== major)
          .map((p) => ({ number: p.number, head: before[p.head] }))
          .sort((a, b) => a.number - b.number),
      );
    }
  });

  it('a restart writes again a branch whose file main has changed since, and only that one', async () => {
    const { repo, today, pull, written } = await opened();
    // main changes the pinned file on another line: the branch's change onto main is no longer the watch's commit.
    repo.push({ [DASHBOARDS_FILE]: (repo.file('main', DASHBOARDS_FILE) as string).replace('spec:', 'spec: # moved') });
    const next = await restarted(repo, today);
    const again = repo.refs.get(DASHBOARDS) as string;
    expect(again).not.toBe(written);
    expect(repo.file(again, DASHBOARDS_FILE)).toContain('spec: # moved');
    expect(repo.file(again, DASHBOARDS_FILE)).toContain('targetRevision: 13.7.2');
    expect(next.enqueued).toEqual([{ number: pull.number, head: again }]);
  });

  it('a restart writes again a head that is not one commit of the App’s making exactly the day’s edits', async () => {
    const edited = (repo: FakeRepo) =>
      (repo.file('main', DASHBOARDS_FILE) as string).replace('targetRevision: 13.2.7', 'targetRevision: 13.7.2');
    const cases: [string, (repo: FakeRepo, written: string) => string][] = [
      // The same bytes, from a checkout of somebody else's: not the App's commit.
      [
        'the same edits, committed by someone else',
        (repo) => repo.commitOn('main', { [DASHBOARDS_FILE]: edited(repo) }),
      ],
      // The App's, made as its own are, but changing a file beside the day's edits.
      [
        'the App’s commit, with another file changed',
        (repo) =>
          repo.commitOn(
            'main',
            { [DASHBOARDS_FILE]: edited(repo), 'deploy/k3d/cluster.yaml': 'kind: Simple\n' },
            APP_LOGIN,
            'web-flow',
          ),
      ],
      // The App's, made as its own are, but writing another version than the day's.
      [
        'the App’s commit, with other edits',
        (repo) =>
          repo.commitOn('main', { [DASHBOARDS_FILE]: edited(repo).replace('13.7.2', '13.7.3') }, APP_LOGIN, 'web-flow'),
      ],
      // The watch's own commit with another on top: two commits ahead of main.
      [
        'a second commit on top of the watch’s',
        (repo, written) => repo.commitOn(written, { 'README.md': 'more\n' }, APP_LOGIN, 'web-flow'),
      ],
    ];
    for (const [what, make] of cases) {
      const { repo, today, pull, written } = await opened();
      const theirs = make(repo, written);
      repo.refs.set(DASHBOARDS, theirs);
      const next = await restarted(repo, today);
      const again = repo.refs.get(DASHBOARDS) as string;
      expect(again, what).not.toBe(theirs);
      expect(repo.file(again, DASHBOARDS_FILE), what).toContain('targetRevision: 13.7.2');
      expect(repo.file(again, 'deploy/k3d/cluster.yaml'), what).toBe(FILES['deploy/k3d/cluster.yaml']);
      expect(repo.file(again, 'README.md'), what).toBeUndefined();
      expect(next.enqueued, what).toEqual([{ number: pull.number, head: again }]);
    }
  });

  it('a restart writes again a branch whose description names other edits than the day’s', async () => {
    const { repo, today, written } = await opened();
    const pull = repo.pulls.find((p) => p.head === DASHBOARDS) as (typeof repo.pulls)[number];
    pull.body = pull.body.replace(/pin-edits [0-9a-f]{64}/, `pin-edits ${'0'.repeat(64)}`);
    await restarted(repo, today);
    expect(repo.refs.get(DASHBOARDS)).not.toBe(written);
    expect(pull.body).not.toContain('0'.repeat(64));
  });

  it('a head this worker wrote and someone moved since is written again, though it is the same edits', async () => {
    const { repo, today } = await opened();
    const w = await worker(repo, ONLY, today, closing);
    await w.watchOnly();
    const own = repo.refs.get(DASHBOARDS) as string;
    expect(w.heads.get(FACTORY, DASHBOARDS)).toBe(own);
    // The App's same edits again, from elsewhere (another worker that writes): not what this one recorded.
    const edited = (repo.file('main', DASHBOARDS_FILE) as string).replace('13.2.7', '13.7.2');
    const other = repo.commitOn('main', { [DASHBOARDS_FILE]: edited }, APP_LOGIN, 'web-flow');
    repo.refs.set(DASHBOARDS, other);
    await w.watchOnly();
    expect(repo.refs.get(DASHBOARDS)).not.toBe(other);
    expect(w.heads.get(FACTORY, DASHBOARDS)).toBe(repo.refs.get(DASHBOARDS));
  });

  it('two workers that both write settle on the head both would write, and fight again once either writes anew', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const at = { to: '13.7.2' };
    const today = () =>
      day(
        scanned,
        factoryMoves().map((m) =>
          m.name === 'example-dashboards' ? { ...m, to: `chart example-dashboards ${at.to}` } : m,
        ),
      );
    const one = await worker(repo, ONLY, today, closing);
    const two = await worker(repo, ONLY, today, closing);
    const seen = new Set<string>();
    for (let hour = 0; hour < 4; hour++)
      for (const w of [one, two]) {
        await w.watchOnly();
        seen.add(repo.refs.get(DASHBOARDS) as string);
      }
    expect(seen.size).toBe(1);
    // A later target: each writes its own, and each then finds the other's where it recorded its own.
    at.to = '13.8.0';
    seen.clear();
    for (let hour = 0; hour < 4; hour++)
      for (const w of [one, two]) {
        await w.watchOnly();
        seen.add(repo.refs.get(DASHBOARDS) as string);
      }
    expect(seen.size).toBe(8);
  });

  it('a commit Martin adds to a pin pull request (or GitHub’s "Update branch") is written over on the watch’s next pass, with a log line', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = await worker(repo, readPinScope('example-logs'), () => day(scanned, factoryMoves()), closing);
    await w.watchOnly();
    const branch = pinBranchOf('example-logs');
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
