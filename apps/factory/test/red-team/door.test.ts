import { createServer } from 'node:http';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { attackDoor } from '../../src/red-team/door.ts';

/**
 * The harness's side of the attack door (red-team/door.ts): one POST an attack over `node:http`, held open within the
 * attack's limit, its answer read strictly. The door here is a stand-in that answers what each test says.
 */
describe('the harness’s call to the attack door', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function door(answer: (path: string, method: string) => { status: number; body: unknown; afterMs?: number }) {
    const server = createServer((req, res) => {
      const { status, body, afterMs } = answer(req.url ?? '', req.method ?? '');
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }, afterMs ?? 0);
    });
    const { url } = await listenLocal(server);
    close = () => server.close();
    return attackDoor(url);
  }

  const within = { signal: new AbortController().signal, limitMs: 2000 };
  const refusal = {
    repo: 'the-roganator/cv-software-factory',
    number: null,
    at: '2026-11-03T12:00:00.000Z',
    payload: { mechanism: 'github-guard', action: 'commit a workflow', output: 'refused', guardrails: [1] },
    record: 'a'.repeat(64),
    signature: 'c2ln'.repeat(22).slice(0, 86),
  };

  it('posts the attack by id and reads the answer', async () => {
    const seen: string[] = [];
    const ask = await door((path, method) => {
      seen.push(`${method} ${path}`);
      return { status: 200, body: { refusals: [refusal], unconcluded: { what: 'the check' } } };
    });
    const result = await ask('workflow', within);
    expect(seen).toEqual(['POST /v1/attacks/workflow']);
    expect(result.refusals).toHaveLength(1);
    expect(result.unconcluded).toEqual({ what: 'the check' });
  });

  it('throws with the door’s words when it answers an error', async () => {
    const ask = await door(() => ({ status: 409, body: { error: 'conflict', message: 'one at a time' } }));
    await expect(ask('test', within)).rejects.toThrow('answered 409: one at a time');
  });

  it('throws when the answer is not in the shape it reads, rather than relay it', async () => {
    const ask = await door(() => ({
      status: 200,
      body: { refusals: [{ ...refusal, payload: { mechanism: 'gateway' } }] },
    }));
    await expect(ask('test', within)).rejects.toThrow('a shape the harness does not read');
  });

  it('gives up at the attack’s limit, and when the harness stops', async () => {
    const ask = await door(() => ({ status: 200, body: { refusals: [] }, afterMs: 500 }));
    await expect(ask('test', { ...within, limitMs: 50 })).rejects.toThrow();
    const stopping = new AbortController();
    const call = ask('test', { signal: stopping.signal, limitMs: 2000 });
    stopping.abort();
    await expect(call).rejects.toThrow();
  });
});
