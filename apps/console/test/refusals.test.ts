/**
 * The console's server checks each relayed refusal a visitor reads against the record the GitHub worker kept and
 * signed: verified, redacted (its words only as the public view redacts them), or unverified. And `/api/refusals`
 * answers the verdicts, and nothing of a record.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawEvent } from '@software-factory/events';
import { publicView } from '@software-factory/events/public';
import { recordBytes } from '@software-factory/events/signed';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { Feed } from '../src/feed.ts';
import { checkRefusal, RefusalChecks, refusalKey, type SignedRefusal } from '../src/refusals.ts';
import { loadSite } from '../src/site.ts';

const worker = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const publicPem = (pair: typeof worker) => pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const key = refusalKey(publicPem(worker));

const PAYLOAD = {
  mechanism: 'github-guard',
  action: 'Commit to .github/workflows/ci.yml in the-roganator/cv-worlds-worst-website',
  output: 'refused: no step may change .github/workflows/ci.yml',
  guardrails: [1],
};

/** A refusal as the GitHub worker records and signs it, kept in a store, and the payload a relay appends. */
async function signed(
  store: DiskArtifacts,
  payload: Record<string, unknown> = PAYLOAD,
  signer = worker.privateKey,
): Promise<SignedRefusal['payload']> {
  const bytes = recordBytes({
    repo: 'the-roganator/cv-worlds-worst-website',
    number: 41,
    at: '2026-10-05T09:00:00.000Z',
    payload,
  });
  const record = await store.put(bytes);
  expect(record).toBe(createHash('sha256').update(bytes).digest('hex'));
  return { ...payload, record, signature: sign(null, bytes, signer).toString('base64') };
}

const storeOf = () => new DiskArtifacts(mkdtempSync(join(tmpdir(), 'records-')));

describe('a relayed refusal, checked against its record', () => {
  it('is verified when its public view is what the worker signed, with only what a relay adds', async () => {
    const store = storeOf();
    const relayed = await signed(store);
    expect(await checkRefusal(store, key, relayed)).toBe('verified');
    const folded = { ...relayed, count: 4, lastAt: '2026-10-05T09:00:40.000Z' };
    expect(await checkRefusal(store, key, folded)).toBe('verified');
    const onNoWorkItem = { ...relayed, subject: { kind: 'issue or pull request', name: 'the-roganator/x#41' } };
    expect(await checkRefusal(store, key, onNoWorkItem)).toBe('verified');
  });

  it('is redacted when its words differ from the signed ones only as the public view redacts them', async () => {
    const store = storeOf();
    const raw = { ...PAYLOAD, output: 'refused: the summary quotes password=hunter2' };
    const relayed = await signed(store, raw);
    const shown = publicView('action.refused', { summary: '', payload: relayed as never, artifacts: [] }).payload;
    expect(JSON.stringify(shown)).toContain('[redacted]');
    expect(await checkRefusal(store, key, shown as never)).toBe('redacted');
    // The same mark in words the worker never signed is no redaction of them.
    expect(await checkRefusal(store, key, { ...relayed, output: 'refused: [redacted]' })).toBe('unverified');
  });

  it('is unverified whenever anything does not check out', async () => {
    const store = storeOf();
    const relayed = await signed(store);
    // No key to check it with.
    expect(await checkRefusal(store, undefined, relayed)).toBe('unverified');
    // Signed by another key.
    expect(await checkRefusal(store, key, await signed(store, { ...PAYLOAD, action: 'x' }, other.privateKey))).toBe(
      'unverified',
    );
    // A payload changed after it was signed, or with something beside it no relay adds.
    expect(await checkRefusal(store, key, { ...relayed, guardrails: [10] })).toBe('unverified');
    expect(await checkRefusal(store, key, { ...relayed, files: [] })).toBe('unverified');
    // Another refusal's signature, or a record the store does not hold.
    const second = await signed(store, { ...PAYLOAD, action: 'Another commit' });
    expect(await checkRefusal(store, key, { ...relayed, signature: second.signature })).toBe('unverified');
    expect(await checkRefusal(store, key, { ...relayed, record: 'f'.repeat(64) })).toBe('unverified');
    // A record that is not a refusal's.
    const notOne = await store.put(new TextEncoder().encode('{"type":"something.else","payload":{}}\n'));
    expect(await checkRefusal(store, key, { ...relayed, record: notOne })).toBe('unverified');
  });

  it('takes only an Ed25519 public key', () => {
    expect(refusalKey(undefined)).toBeUndefined();
    expect(refusalKey('not a key')).toBeUndefined();
    const privatePem = worker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(refusalKey(privatePem)).toBeUndefined();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
    expect(refusalKey(rsa.toString())).toBeUndefined();
  });
});

describe('the checks the server keeps', () => {
  it('leaves out one whose record it could not read, and reads it again when next asked', async () => {
    const store = storeOf();
    const relayed = await signed(store);
    let fail = true;
    const flaky = {
      open: (hash: string) => (fail ? Promise.reject(new Error('the volume is not there')) : store.open(hash)),
    };
    const checks = new RefusalChecks(flaky, key);
    expect(await checks.of([{ seq: 7, payload: relayed }])).toEqual({});
    fail = false;
    expect(await checks.of([{ seq: 7, payload: relayed }])).toEqual({ 7: 'verified' });
  });
});

describe('/api/refusals', () => {
  it('answers each relayed refusal’s check by seq, and nothing of its record', async () => {
    const store = storeOf();
    const good = await signed(store);
    const forged = { ...good, action: 'Something the worker never refused' };
    const event = (seq: number, payload: Record<string, unknown>, type = 'action.refused') =>
      ({
        event: {
          id: crypto.randomUUID(),
          seq,
          ts: '2026-10-05T09:00:00.000Z',
          work_item: null,
          type,
          version: 3,
          actor: 'factory',
          summary: 'A refusal the GitHub worker answered',
          payload,
          artifacts: [],
        } as RawEvent & { seq: number },
        appendedAt: Date.now(),
      }) as const;
    const feed = new Feed();
    feed.add([
      event(1, good),
      event(2, forged),
      // No record and signature: the browser reads it unverified itself, and the server is not asked.
      event(3, PAYLOAD),
    ]);
    const app = createServer(
      createApp({
        commit: 'dev',
        site: loadSite(mkdtempSync(join(tmpdir(), 'no-build-'))),
        feed,
        artifacts: store,
        refusals: new RefusalChecks(store, key),
      }),
    );
    const { url } = await listenLocal(app);
    try {
      const res = await fetch(`${url}/api/refusals`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ 1: 'verified', 2: 'unverified' });
      expect(text).not.toContain('refused: no step');
    } finally {
      app.closeAllConnections();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    }
  });
});
