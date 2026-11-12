import { createServer } from 'node:http';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubError } from '../../src/github/client.ts';
import type { Reads } from '../../src/github/reads.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker, GitHubWorkerError, READ_AGAIN } from '../../src/github/worker-client.ts';
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

/** A server that answers every read after `ms`, as the worker answers `moves` once it has read every alert. */
async function slow(ms: number) {
  const server = createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: { answeredAfterMs: ms } }));
    }, ms);
  });
  const { url } = await listenLocal(server);
  close = () => server.close();
  return new GitHubWorker(url);
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
