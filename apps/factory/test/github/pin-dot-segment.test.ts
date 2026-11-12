/**
 * A branch named with a `.` segment, and a branch moved by any route. `fetch`'s URL parser takes `.` segments out, so
 * `factory/./pin/<move>` would be `factory/pin/<move>` to GitHub while no guard, comparing names as text, saw a pin
 * branch. The door's pattern and `guardBranch` refuse any segment starting with a dot, and the client sends no path
 * with a dot segment. Beneath both, the positive check: a queue adds only the commit its own watch wrote
 * (`WatchedHeads`), so a branch moved anyhow is not queued, and the watch writes its own again on its next pass.
 */
import { createServer } from 'node:http';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveActions } from '../../src/github/actions.ts';
import { GitHub } from '../../src/github/client.ts';
import { readPinScope } from '../../src/github/pins.ts';
import { CLIENT_ID, PRIVATE_KEY, quiet } from './fake.ts';
import { heldByMartin, worker } from './pin-worker-harness.ts';
import { day, digest, FACTORY, FakeRepo, FILES, factoryMoves } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

const A = 'factory/pin/example-dashboards';
const B = 'factory/pin/example-sidecar';
const SIDECAR_FILES = ['deploy/base/telemetry/values/dashboards.yaml', 'deploy/base/telemetry/values/logs.yaml'];

/** The sidecar's move, as the pin watch would write it: the tag and digest at each of its two pins. */
const sidecarMoved = (repo: FakeRepo) =>
  SIDECAR_FILES.map((path) => ({
    path,
    contents: Buffer.from(
      (repo.file('main', path) ?? '').replace(`2.11.2@${digest('sidecar/old')}`, `2.14.3@${digest('sidecar/new')}`),
    ).toString('base64'),
  }));

describe('a `.` segment in a branch name, and a branch moved by any route', () => {
  it('on the wire: no dot segment is sent, by the actions or by the client itself, so no name is another to GitHub', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/installation')) return res.end(JSON.stringify({ id: 42 }));
      if (req.url?.endsWith('/access_tokens')) {
        res.statusCode = 201;
        return res.end(JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() }));
      }
      if (req.method === 'DELETE') {
        res.statusCode = 204;
        return res.end();
      }
      return res.end(JSON.stringify({ object: { sha: 'a'.repeat(40) } }));
    });
    const { url: api } = await listenLocal(server);
    closing.push(() => server.close());
    // The real client and the real fetch, as the worker runs them: only GitHub's address is a stand-in.
    const github = new GitHub({ credentials: { clientId: CLIENT_ID, privateKey: PRIVATE_KEY }, api, log: quiet });
    const actions = new LiveActions(github);
    for (const branch of ['factory/./pin/example-dashboards', 'factory/.x/pin', 'factory/./deploy/local']) {
      await expect(actions.setBranch(FACTORY, branch, 'e'.repeat(40), { force: true })).rejects.toThrow(/plain/);
      await expect(actions.deleteBranch(FACTORY, branch)).rejects.toThrow(/plain/);
    }
    // The client refuses a dot segment, or its escape, in any path it is given, before anything is sent.
    for (const path of [
      `/repos/${FACTORY}/git/refs/heads/factory/./pin/example-dashboards`,
      `/repos/${FACTORY}/git/refs/heads/factory/x/../pin/example-dashboards`,
      `/repos/${FACTORY}/git/refs/heads/factory/%2e/pin/example-dashboards`,
      `/repos/${FACTORY}/git/refs/heads/factory/%2E%2E/pin`,
    ]) {
      await expect(github.write(FACTORY, 'DELETE', path), path).rejects.toThrow(/dot segment/);
    }
    expect(seen.filter((s) => s.startsWith('PATCH') || s.startsWith('DELETE'))).toEqual([]);
    // Control: the name written plainly is refused before anything is sent.
    await expect(actions.setBranch(FACTORY, A, 'e'.repeat(40), { force: true })).rejects.toThrow(/pin watch's/);
  });

  it('queues no move the setting does not name put on a named move’s branch, by the door or any route; the watch puts its own back', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    // The setting names one move. The day lists others, the sidecar's among them, which the watch leaves alone.
    const w = await worker(repo, readPinScope('example-dashboards'), () => day(scanned, factoryMoves()), closing);
    await w.watchOnly();
    const pull = repo.pulls.find((p) => p.head === A && p.state === 'open');
    if (!pull) throw new Error('the pin watch opened nothing');
    expect(repo.pulls.filter((p) => p.state === 'open').map((p) => p.head)).toEqual([A]);
    const watchs = repo.refs.get(A) as string;

    // The worker that asks makes its own commit, signed as the App's, on a branch of the factory's: the sidecar's move.
    expect((await w.ask('setBranch', { branch: 'factory/7-x', sha: repo.main })).status).toBe(200);
    const committed = await w.ask('commit', {
      branch: 'factory/7-x',
      expectedHead: repo.main,
      message: 'chore(pin): move example/sidecar to 2.14.3',
      changes: { additions: sidecarMoved(repo), deletions: [] },
    });
    expect(committed.status).toBe(200);
    const theirs = committed.result as string;

    // Controls: the pin branch by its name, with `refs/heads/`, with `..` and with `//`, is refused.
    for (const branch of [
      A,
      `refs/heads/${A}`,
      'factory/x/../pin/example-dashboards',
      'factory//pin/example-dashboards',
    ]) {
      const refused = await w.ask('setBranch', { branch, sha: theirs, force: true });
      expect([400, 422], branch).toContain(refused.status);
    }
    expect(repo.refs.get(A)).toBe(watchs);

    // The same branch with a `.` segment: refused at the door, as a name no segment of which starts with a dot.
    const moved = await w.ask('setBranch', { branch: 'factory/./pin/example-dashboards', sha: theirs, force: true });
    expect(moved.status).toBe(400);
    expect(repo.refs.get(A)).toBe(watchs);

    // Moved all the same, by any route the door does not see: the queue takes no head the watch did not write.
    repo.refs.set(A, theirs as string);
    await w.queueOnly();
    expect(w.enqueued).toEqual([]);
    // The watch's next pass writes its own move again, the dashboards' and nothing else, and the queue adds that.
    await w.watchOnly();
    const restored = repo.refs.get(A) as string;
    expect(restored).not.toBe(theirs);
    expect(repo.file(A, 'deploy/base/telemetry/dashboards.yaml')).toContain('targetRevision: 13.7.2');
    expect(repo.file(A, SIDECAR_FILES[0] as string)).not.toContain(`2.14.3@${digest('sidecar/new')}`);
    await w.queueOnly();
    expect(w.enqueued).toEqual([{ number: pull.number, head: restored }]);
  });

  it('merges no move Martin holds under another named move’s pull request', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = await worker(
      repo,
      readPinScope('example-dashboards,example/sidecar'),
      () => day(scanned, factoryMoves()),
      closing,
    );
    await w.watchOnly();
    const dashboards = repo.pulls.find((p) => p.head === A);
    const sidecar = repo.pulls.find((p) => p.head === B);
    if (!dashboards || !sidecar) throw new Error('the pin watch did not open both');
    // Martin holds the sidecar's move: its label off.
    sidecar.labels = [];
    w.events.set(sidecar.number, heldByMartin());

    // The worker that asks: the held move's change, as a commit of its own, set on the other move's branch.
    await w.ask('setBranch', { branch: 'factory/7-x', sha: repo.main });
    const { result: theirs } = await w.ask('commit', {
      branch: 'factory/7-x',
      expectedHead: repo.main,
      message: 'chore(pin): move example/sidecar to 2.14.3',
      changes: { additions: sidecarMoved(repo), deletions: [] },
    });
    expect(
      (await w.ask('setBranch', { branch: 'factory/./pin/example-dashboards', sha: theirs, force: true })).status,
    ).toBe(400);
    // Moved all the same, by any route the door does not see.
    repo.refs.set(A, theirs as string);
    await w.ask('deleteBranch', { branch: 'factory/7-x' });

    await w.queueOnly();
    // Neither the held pull request, nor the held move under the other's.
    expect(w.enqueued).toEqual([]);
    await w.pass();
    await w.pass();
    expect(w.enqueued.some((e) => e.number === sidecar.number)).toBe(false);
    expect(w.enqueued.some((e) => e.head === theirs)).toBe(false);
    expect(repo.file(A, SIDECAR_FILES[0] as string)).not.toContain(`2.14.3@${digest('sidecar/new')}`);
  });

  it('deletes no pin branch, and neither moves nor deletes the deploy watch’s scratch branch, by a dot segment', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    const w = await worker(repo, readPinScope('example-dashboards'), () => day(scanned, factoryMoves()), closing);
    await w.watchOnly();
    expect(repo.refs.has(A)).toBe(true);
    expect((await w.ask('deleteBranch', { branch: 'factory/./pin/example-dashboards' })).status).toBe(400);
    expect(repo.refs.has(A)).toBe(true);
    repo.refs.set('factory/deploy/local', repo.main);
    for (const branch of ['factory/deploy/local', 'factory/deploy', 'factory/deploy/local/x', 'deploy/local']) {
      expect((await w.ask('setBranch', { branch, sha: 'e'.repeat(40), force: true })).status, branch).toBe(422);
    }
    for (const branch of ['factory/./deploy/local', './deploy/local', 'factory/.deploy/local']) {
      expect((await w.ask('setBranch', { branch, sha: 'e'.repeat(40), force: true })).status, branch).toBe(400);
      expect((await w.ask('deleteBranch', { branch })).status, branch).toBe(400);
    }
    expect(repo.refs.get('factory/deploy/local')).toBe(repo.main);
  });
});
