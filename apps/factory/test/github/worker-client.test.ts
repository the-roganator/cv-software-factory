import { createServer } from 'node:http';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { GitHubError } from '../../src/github/client.ts';
import type { Reads } from '../../src/github/reads.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker, GitHubWorkerError, issueGone } from '../../src/github/worker-client.ts';
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

describe('the worker’s client', () => {
  it('fails a read as the worker answered it: its status, and the kind of GitHub’s failure', async () => {
    const client = await worker({
      moves: async () => {
        throw new GitHubError('malformed', 'The scan’s moves cannot be read: run 1 left moves.json and kept no state.');
      },
      pullRequest: async () => {
        throw new GitHubError('conflict', 'PATCH /repos/x/pulls/1 answered 409: head moved', 409);
      },
    });
    const malformed = await client.read('moves', REPO, {}).catch((e) => e);
    expect(malformed).toBeInstanceOf(GitHubWorkerError);
    expect(malformed).toMatchObject({ status: 502, kind: 'malformed' });
    expect(malformed.message).toMatch(/kept no state/);
    const conflict = await client.read('pullRequest', REPO, { number: 1 }).catch((e) => e);
    expect(conflict).toMatchObject({ status: 409, kind: 'conflict' });
  });

  it('never reads an answer that is not the worker’s JSON as the worker’s status', async () => {
    for (const [status, body] of [
      [404, '404 page not found\n'],
      [409, ''],
      [200, ''],
    ] as const) {
      const url = await notTheWorker(status, body);
      for (const read of [
        () => new GitHubWorker(url).read('moves', REPO, {}),
        () => new GitHubWorker(url).read('pullRequest', REPO, { number: 1 }),
      ]) {
        const error = await read().catch((e) => e);
        expect(error).toBeInstanceOf(SyntaxError);
        expect(error).not.toBeInstanceOf(GitHubWorkerError);
        expect(issueGone(error)).toBe(false);
      }
      close?.();
    }
  });
});
