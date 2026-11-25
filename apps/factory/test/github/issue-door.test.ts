/**
 * Writing an issue again over the door, as the line does a move's when a newer scan names another target: the
 * description alone, and only of an issue the App opened.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveActions } from '../../src/github/actions.ts';
import { APP_USER, IssueGuard, MARTIN } from '../../src/github/issues.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker, type GitHubWorkerError } from '../../src/github/worker-client.ts';
import { verifyRefusal } from '../../src/signed-refusals.ts';
import { doorReads } from './door-reads.ts';
import { calls, client, quiet, REPO, type Sent } from './fake.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
/** The App's own issue, and one Martin opened. */
const OURS = 41;
const HIS = 121;

let close: (() => void) | undefined;
afterEach(() => close?.());

async function serve() {
  const dir = await mkdtemp(join(tmpdir(), 'issue-door-'));
  const recorder = new RefusalRecorder({ artifacts: new DiskArtifacts(dir), key: privateKey, log: quiet });
  const sent: Sent[] = [];
  const { github } = client([{ method: 'PATCH', path: /\/issues\/\d+$/, answer: () => ({ body: {} }) }], sent);
  const guard = new IssueGuard({
    openedBy: async (_repo, number) => ({ by: number === HIS ? MARTIN : APP_USER, pullRequest: false }),
    recorder,
  });
  const server = createWorkerServer({
    actions: new LiveActions(github, { guard }),
    reads: doorReads(),
    repositories: [REPO],
    health: () => ({}),
    recorder,
    log: quiet,
  });
  const { url } = await listenLocal(server);
  close = () => server.close();
  const writes = () => calls(sent).filter((s) => s.method === 'PATCH');
  return { url, worker: new GitHubWorker(url), writes };
}

describe('writing an issue again over HTTP', () => {
  it('writes the description of an issue the App opened, and nothing else of it', async () => {
    const { worker, writes } = await serve();
    await worker.act('updateIssue', REPO, { number: OURS, body: 'The move, to `2.0.3`.' });
    expect(writes().map((s) => [s.path, s.body])).toEqual([
      [`/repos/${REPO}/issues/${OURS}`, { body: 'The move, to `2.0.3`.' }],
    ]);
  });

  it('answers an issue Martin opened 403, its refusal signed, for guardrail 10, and writes nothing', async () => {
    const { worker, writes } = await serve();
    const failed = await worker
      .act('updateIssue', REPO, { number: HIS, body: 'The move, to `2.0.3`.' })
      .catch((error: unknown) => error);
    expect(failed).toMatchObject({ status: 403, kind: 'issue-refused' });
    expect(verifyRefusal(publicKey, (failed as GitHubWorkerError).refusal)).toMatchObject({
      ok: true,
      refusal: { repo: REPO, number: HIS, payload: { mechanism: 'github-guard', guardrails: [10] } },
    });
    expect(writes()).toEqual([]);
  });

  it('takes no title, no state and no empty description', async () => {
    const { url, writes } = await serve();
    for (const body of [
      { number: OURS, title: 'Another title' },
      { number: OURS, body: 'b', title: 'Another title' },
      { number: OURS, body: 'b', state: 'closed' },
      { number: OURS, body: '' },
    ]) {
      const response = await fetch(`${url}/v1/actions/updateIssue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: REPO, ...body }),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(writes()).toEqual([]);
  });
});
