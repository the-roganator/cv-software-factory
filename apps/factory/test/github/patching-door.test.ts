/**
 * The GitHub worker's door for the dependency sense (milestone 7, task 31): on a port of its own, it serves the sense's
 * two reads and no action, so the port the sense's NetworkPolicy opens cannot act in GitHub.
 */
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/github/config.ts';
import type { Reads } from '../../src/github/reads.ts';
import { createWorkerServer, PATCHING_READS } from '../../src/github/server.ts';

describe('the GitHub worker’s door for the sense', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());
  const REPO = 'the-roganator/cv-software-factory';

  async function door() {
    const asked: string[] = [];
    const reads = new Proxy({} as Reads, {
      get: (_, name: string) => async () => {
        asked.push(name);
        return name === 'dependencyPulls' ? [] : { read: name };
      },
    });
    // The door is given no actions at all: it has nothing to act with.
    const server = createWorkerServer({
      reads,
      repositories: [REPO],
      health: () => ({ door: 'patching' }),
      only: PATCHING_READS,
      log: pino({ level: 'silent' }),
    });
    const { url } = await listenLocal(server);
    close = () => server.close();
    const call = async (path: string, args: object = {}, headers: Record<string, string> = {}) => {
      const r = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ repo: REPO, ...args }),
      });
      return r.status;
    };
    return { call, asked };
  }

  it('serves the moves and Dependabot’s pull requests', async () => {
    const { call, asked } = await door();
    expect(PATCHING_READS).toEqual(['moves', 'dependencyPulls']);
    expect(await call('/v1/reads/moves')).toBe(200);
    expect(await call('/v1/reads/dependencyPulls')).toBe(200);
    expect(asked).toEqual(['moves', 'dependencyPulls']);
  });

  it('serves no other read and no action, dry run or not', async () => {
    const { call, asked } = await door();
    expect(await call('/v1/reads/pullRequest', { number: 1 })).toBe(404);
    expect(await call('/v1/reads/file', { ref: 'main', path: 'a' })).toBe(404);
    expect(await call('/v1/actions/openIssue', { title: 'x', body: 'y' })).toBe(404);
    expect(await call('/v1/actions/comment', { number: 1, body: 'x' }, { 'x-factory-dry-run': 'true' })).toBe(404);
    expect(asked).toEqual([]);
  });

  it('is on a port of its own', () => {
    expect(configFromEnv({ PATCHING_PORT: '8083' }).patchingPort).toBe(8083);
    expect(configFromEnv({}).patchingPort).toBeUndefined();
    expect(() => configFromEnv({ PATCHING_PORT: '8080' })).toThrow('a port of its own');
    expect(() => configFromEnv({ PATCHING_PORT: '8082', ATTACK_PORT: '8082' })).toThrow('a port of its own');
    expect(() => configFromEnv({ PATCHING_PORT: 'x' })).toThrow('a port number');
  });

  it('answers an action 404 on any server given no actions, door or not', async () => {
    const server = createWorkerServer({ repositories: [REPO], health: () => ({}), log: pino({ level: 'silent' }) });
    const { url } = await listenLocal(server);
    close = () => server.close();
    const r = await fetch(`${url}/v1/actions/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO, number: 1, body: 'x' }),
    });
    expect(r.status).toBe(404);
  });
});
