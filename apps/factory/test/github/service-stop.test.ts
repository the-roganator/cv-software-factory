/**
 * The GitHub worker stops whole when a port it is given cannot be had: every server it opened is closed and the watches
 * stop, so nothing is left running after the start fails.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configFromEnv } from '../../src/github/config.ts';
import { startGitHubWorker } from '../../src/github/service.ts';

const held: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(held.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/**
 * A port the OS gives, held by this test, or given back for the worker to listen on. One given back may be taken by
 * another program before the worker has it, so what the tests check is not the port but the process: every server the
 * worker opened is closed, whichever port it could not have.
 */
async function port(hold = false): Promise<number> {
  const s = createServer();
  const { port } = await listenLocal(s);
  if (hold) held.push(s);
  else await new Promise((resolve) => s.close(resolve));
  return port;
}

/** Every server asked to listen from here on, the worker's: each is checked to be closed once its start has failed. */
function servers(): Server[] {
  const opened: Server[] = [];
  const listen = Server.prototype.listen;
  vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
    opened.push(this);
    return (listen as (...a: unknown[]) => Server).apply(this, args);
  });
  return opened;
}

describe('the GitHub worker, when a port it is given is taken', () => {
  it('closes every server it opened when the last door cannot listen', { timeout: 60_000 }, async () => {
    const [main, door, attack] = [await port(), await port(), await port(true)];
    const opened = servers();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const config = configFromEnv({
      GITHUB_APP_CLIENT_ID: 'Iv1.test',
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ARTIFACTS_DIR: mkdtempSync(join(tmpdir(), 'github-')),
      GITHUB_API_URL: 'http://127.0.0.1:9',
      GHCR_URL: 'http://127.0.0.1:9',
      GITHUB_POLL_SECONDS: '3600',
      PORT: String(main),
      PATCHING_PORT: String(door),
      ATTACK_PORT: String(attack),
    });
    await expect(startGitHubWorker(config, pino({ level: 'silent' }))).rejects.toThrow();
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.filter((s) => s.listening)).toEqual([]);
  });

  it('closes the sense’s door when the main port cannot listen', async () => {
    const [main, door] = [await port(true), await port()];
    const opened = servers();
    const config = configFromEnv({ PORT: String(main), PATCHING_PORT: String(door) });
    await expect(startGitHubWorker(config, pino({ level: 'silent' }))).rejects.toThrow();
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.filter((s) => s.listening)).toEqual([]);
  });
});
