import { createServer } from 'node:http';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubError } from '../../src/github/client.ts';
import type { Reads } from '../../src/github/reads.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker, GitHubWorkerError, issueGone, READ_AGAIN } from '../../src/github/worker-client.ts';
import { quiet, REPO } from './fake.ts';

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  close = undefined;
});

/** The worker's server, its reads failing as `reads` says. */
async function worker(reads: Partial<Reads>) {
  const server = createWorkerServer({
    actions: {} as never,
    reads: reads as Reads,
    repositories: [REPO],
    health: () => ({}),
    log: quiet,
  });
  const { url } = await listenLocal(server);
  close = () => server.close();
  return new GitHubWorker(url);
}

/** Something at the worker's address that is not the worker: it answers every call `status` with `body`. */
async function notTheWorker(status: number, body: string) {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(status, { 'content-type': 'text/plain' }).end(body);
  });
  const { url } = await listenLocal(server);
  close = () => server.close();
  return url;
}

/** A server that answers every read after `ms`, as the worker answers `moves` once it has read every alert. */
async function slow(ms: number, options: ConstructorParameters<typeof GitHubWorker>[1] = {}) {
  const server = createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: { answeredAfterMs: ms } }));
    }, ms);
  });
  const { url } = await listenLocal(server);
  close = () => {
    server.closeAllConnections();
    server.close();
  };
  return new GitHubWorker(url, options);
}

describe('the worker’s client', () => {
  it('tells a read to ask again from GitHub’s own conflict', async () => {
    const client = await worker({
      moves: async () => {
        throw new GitHubError(READ_AGAIN, 'The scan’s run 1 finished while its moves were read: read them again.', 409);
      },
      pullRequest: async () => {
        throw new GitHubError('conflict', 'PATCH /repos/x/pulls/1 answered 409: head moved', 409);
      },
    });
    const again = await client.read('moves', REPO, {}).catch((e) => e);
    expect(again).toBeInstanceOf(GitHubWorkerError);
    expect(again).toMatchObject({ status: 409, kind: READ_AGAIN });
    const conflict = await client.read('pullRequest', REPO, { number: 1 }).catch((e) => e);
    expect(conflict).toMatchObject({ status: 409, kind: 'conflict' });
    expect(READ_AGAIN).toBe('read-again');
  });

  it('waits for a read as long as its own timeout, with no other limit on the headers', async () => {
    const client = await slow(1_500);
    expect(await client.read('moves', REPO, {})).toEqual({ answeredAfterMs: 1_500 });
  });

  it('never reads an answer that is not the worker’s JSON as the worker’s status, on moves', async () => {
    for (const [status, body] of [
      [404, '404 page not found\n'],
      [409, ''],
      [200, ''],
      [200, 'null'],
    ] as const) {
      const url = await notTheWorker(status, body);
      const error = await new GitHubWorker(url).read('moves', REPO, {}).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GitHubWorkerError);
      expect(issueGone(error)).toBe(false);
      expect(error.message).toBe(
        `The GitHub worker's reads/moves answered ${status} with something other than its JSON`,
      );
      close?.();
    }
  });

  it('gives moves up at its own deadline, naming the read and the time it had, over node:http', async () => {
    // Fetch's own deadline fails as `The operation was aborted`; this message is the node:http path's alone. The worker
    // never answers, and the deadline's timer is the test's to move: the read is still waiting a moment before it, and
    // has failed at it, however fast or slow the machine.
    let arrived = () => {};
    const asked = new Promise<void>((resolve) => (arrived = resolve));
    const server = createServer((req) => {
      req.resume();
      arrived();
    });
    const { url } = await listenLocal(server);
    close = () => {
      server.closeAllConnections();
      server.close();
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let outcome: unknown;
      const read = new GitHubWorker(url, { movesTimeoutMs: 60_000 }).read('moves', REPO, {}).then(
        (answer) => (outcome = answer),
        (error) => (outcome = error),
      );
      await asked;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await read;
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toBeInstanceOf(GitHubWorkerError);
      expect((outcome as Error).message).toBe('/v1/reads/moves gave no whole answer within 60 s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads every other call over fetch, as before', async () => {
    // fetch throws its own SyntaxError on an answer that is not JSON; the node:http path never does.
    const url = await notTheWorker(404, '404 page not found\n');
    const error = await new GitHubWorker(url).read('pullRequest', REPO, { number: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(SyntaxError);
  });

  // Node's fetch gave up on the headers after 300 s whatever its signal; this client has no such limit. Five minutes and
  // more is too long for every run of the suite: LONG_READS=1 runs it.
  it.runIf(process.env.LONG_READS === '1')(
    'receives a read that answers after more than 300 s',
    async () => {
      const client = await slow(305_000);
      expect(await client.read('moves', REPO, {})).toEqual({ answeredAfterMs: 305_000 });
    },
    330_000,
  );
});
