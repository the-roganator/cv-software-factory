import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { SpendPolicy } from '../../../../policy/spend.ts';
import { Cassettes } from '../../src/gateway/cassettes.ts';
import { GatewayClient } from '../../src/gateway/client.ts';
import { configFromEnv, judgementsToken } from '../../src/gateway/config.ts';
import {
  BadRequest,
  CassetteMissing,
  GatewayUnavailable,
  ProviderError,
  SpendCapped,
} from '../../src/gateway/errors.ts';
import { Gateway, type Mode } from '../../src/gateway/gateway.ts';
import { createGatewayServer } from '../../src/gateway/server.ts';
import { Spend } from '../../src/gateway/spend.ts';
import { TypeSafe } from '../../src/gateway/typesafe.ts';
import { capturingLog, type FakeTypeSafe, fakeTypeSafe, request, SECRET } from './helpers.ts';

let fake: FakeTypeSafe;
let database: Database | undefined;
let server: Server;
let url: string;
let client: GatewayClient;
const captured = capturingLog();
/** Triage's caller token, as `make judgements-token` makes one. */
const TOKEN = 'a'.repeat(64);

const start = async (mode: Mode, policy: SpendPolicy = { dayUsd: 20, monthUsd: 100, workItemUsd: 0.04 }) => {
  // A database of its own, so one test's spend is not another's.
  database = await freshDatabase('server');
  const dir = mkdtempSync(join(tmpdir(), 'cassettes-'));
  const events = new EventWriter(database.as.gateway, { kind: 'real', artifacts: new DiskArtifacts(dir) });
  const spend = new Spend({ sql: database.as.gateway, events, profile: 'local', policy, log: captured.log });
  const gateway = new Gateway({
    sql: database.as.gateway,
    spend,
    cassettes: new Cassettes({ record: dir }),
    mode,
    typesafe: new TypeSafe({
      apiKey: 'k',
      baseUrl: fake.url,
      log: captured.log,
      sleep: async () => {},
      random: () => 0,
    }),
    log: captured.log,
  });
  server = createGatewayServer({ gateway, spend, judgementsToken: TOKEN, log: captured.log });
  url = (await listenLocal(server)).url;
  client = new GatewayClient({ url, token: TOKEN });
};

beforeAll(async () => {
  fake = await fakeTypeSafe();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.requests.length = 0;
  fake.inputTokens = 300;
});
const stop = async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database?.end();
  database = undefined;
};

const post = (body: string, token: string | null = TOKEN) =>
  fetch(`${url}/v1/judgements`, {
    method: 'POST',
    body,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

describe('the gateway over HTTP', () => {
  it('serves a judgement to the client, and a cassette replays it', async () => {
    await start('replay-record');
    const first = await client.judge(request({ workItem: '1000' }));
    expect(first).toMatchObject({
      model: 'jev-1.13.0',
      source: 'provider',
      usage: { inputTokens: 300, outputTokens: 12 },
    });
    expect(first.answers.category).toMatchObject({ type: 'choice', choice: 'functional' });
    const second = await client.judge(request({ workItem: '1000' }));
    expect(second).toMatchObject({ source: 'cassette', costUsd: 0, cassette: first.cassette });
    await stop();
  });

  it('answers /health and /v1/spend', async () => {
    await start('replay');
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: 'ok', mode: 'replay' });
    const spend = await client.spend();
    expect(spend).toMatchObject({ profile: 'local', capped: [], workItemLimitUsd: 0.04 });
    expect(spend.day.limitUsd).toBe(20);
    await stop();
  });

  it('maps a spend cap to 429, with the cap and when it resets, and the client maps it back', async () => {
    await start('record');
    fake.inputTokens = 1_000_000;
    await client.judge(request({ workItem: '2000' }));
    const raw = await post(JSON.stringify(request({ workItem: '2000' })));
    expect(raw.status).toBe(429);
    expect(await raw.json()).toMatchObject({ error: 'spend-capped', cap: 'work-item', limitUsd: 0.04, resets: null });
    const error = await client.judge(request({ workItem: '2000' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpendCapped);
    expect(error).toMatchObject({ cap: 'work-item', limitUsd: 0.04 });
    await stop();
  });

  it('sends Retry-After with a day cap', async () => {
    await start('record', { dayUsd: 0.04, monthUsd: null, workItemUsd: 2 });
    fake.inputTokens = 1_000_000;
    await client.judge(request({ state: 'one' }));
    const raw = await post(JSON.stringify(request({ state: 'two' })));
    expect(raw.status).toBe(429);
    expect(Number(raw.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await raw.json()) as { cap: string; resets: string };
    expect(body.cap).toBe('day');
    expect(body.resets).toMatch(/T00:00:00\.000Z$/);
    await stop();
  });

  it('maps a cassette miss to 409', async () => {
    await start('replay');
    const raw = await post(JSON.stringify(request()));
    expect(raw.status).toBe(409);
    const body = (await raw.json()) as { key: string };
    const error = await client.judge(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CassetteMissing);
    expect((error as CassetteMissing).key).toBe(body.key);
    await stop();
  });

  it('maps a provider failure to 502, and says nothing of what it answered', async () => {
    await start('record');
    fake.script({ status: 422 });
    const raw = await post(JSON.stringify(request()));
    expect(raw.status).toBe(502);
    const text = await raw.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'provider-failed', kind: 'rejected', status: 422 });
    expect(text).not.toContain(SECRET);
    fake.script({ status: 422 });
    const error = await client.judge(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'rejected', status: 422 });
    await stop();
  });

  it('maps a request it will not send to 400, never echoing it', async () => {
    await start('record');
    const alias = await post(JSON.stringify(request({ model: 'jev-latest' })));
    expect(alias.status).toBe(400);
    expect(await client.judge(request({ model: 'jev-latest' })).catch((e: unknown) => e)).toBeInstanceOf(BadRequest);

    const bad = [
      `{"state": "${SECRET}`,
      JSON.stringify({ ...request(), extra: SECRET }),
      JSON.stringify({ ...request(), questions: { q: { type: SECRET } } }),
      JSON.stringify(SECRET),
    ];
    for (const body of bad) {
      const raw = await post(body);
      expect(raw.status).toBe(400);
      expect(await raw.text()).not.toContain(SECRET);
    }
    expect(fake.requests).toHaveLength(0);
    await stop();
  });

  it('refuses a body that is too large with 413', async () => {
    await start('record');
    const raw = await post(JSON.stringify(request({ state: 'x'.repeat(300 * 1024) })));
    expect(raw.status).toBe(413);
    await stop();
  });

  it('answers a route or method it does not have with 404 or 405', async () => {
    await start('record');
    expect((await fetch(`${url}/nothing`)).status).toBe(404);
    const wrong = await fetch(`${url}/v1/judgements`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    expect((await fetch(`${url}/v1/spend`, { method: 'POST' })).status).toBe(405);
    await stop();
  });

  it('answers 500 with nothing of what went wrong, and the client calls it unavailable', async () => {
    const gateway = { mode: 'replay', judge: async () => Promise.reject(new Error(`boom ${SECRET}`)) };
    const spend = { report: async () => ({}) };
    server = createGatewayServer({
      gateway: gateway as never,
      spend: spend as never,
      judgementsToken: TOKEN,
      log: captured.log,
    });
    url = (await listenLocal(server)).url;
    client = new GatewayClient({ url, token: TOKEN });
    const raw = await post(JSON.stringify(request()));
    expect(raw.status).toBe(500);
    expect(await raw.text()).not.toContain(SECRET);
    expect(await client.judge(request()).catch((e: unknown) => e)).toBeInstanceOf(GatewayUnavailable);
    await stop();
  });

  it('is unavailable to a client with no gateway to reach', async () => {
    const lost = new GatewayClient({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
    expect(await lost.judge(request()).catch((e: unknown) => e)).toBeInstanceOf(GatewayUnavailable);
  });
});

describe('judgements, which take triage’s token', () => {
  it('answer 401 to a request without it, or with another, before reading it, and record nothing', async () => {
    await start('record');
    const wrong = [null, 'b'.repeat(64), TOKEN.slice(1), `${TOKEN}a`, ''];
    for (const token of wrong) {
      const raw = await post(JSON.stringify(request()), token);
      expect(raw.status, String(token)).toBe(401);
      expect(raw.headers.get('www-authenticate')).toBe('Bearer');
      expect(await raw.json()).toEqual({
        error: 'unauthorized',
        message: 'Judgements take triage’s token, and this request did not carry it.',
      });
    }
    // The token where a job token would go, or not as a bearer's, is not it either.
    for (const headers of [{ 'x-api-key': TOKEN }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }]) {
      const raw = await fetch(`${url}/v1/judgements`, { method: 'POST', body: JSON.stringify(request()), headers });
      expect(raw.status).toBe(401);
    }
    // Nothing reached Jev, nothing was spent, and no refusal was appended: a wrong token is no guardrail's.
    expect(fake.requests).toHaveLength(0);
    const sql = database?.as.gateway;
    if (!sql) throw new Error('no database');
    expect(await sql`select 1 from model_calls`).toHaveLength(0);
    expect(await sql`select 1 from events`).toHaveLength(0);
    await stop();
  });

  it('turn a 401 into GatewayUnavailable for a client without it, which triage waits out', async () => {
    await start('record');
    const without = new GatewayClient({ url });
    const error = await without.judge(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayUnavailable);
    expect(error).toMatchObject({ status: 401, message: expect.stringContaining('triage’s token') });
    expect(fake.requests).toHaveLength(0);
    await stop();
  });

  it('are all 401 with no token configured, and the gateway says so once as it starts', async () => {
    const warned = captured.lines.length;
    const gateway = { mode: 'replay', judge: async () => Promise.reject(new Error('never asked')) };
    const spend = { report: async () => ({}) };
    server = createGatewayServer({
      gateway: gateway as never,
      spend: spend as never,
      judgementsToken: undefined,
      log: captured.log,
    });
    url = (await listenLocal(server)).url;
    expect(captured.lines.slice(warned).filter((line) => line.includes('JUDGEMENTS_TOKEN'))).toHaveLength(1);
    for (const token of [null, '', TOKEN, 'undefined']) {
      expect((await post(JSON.stringify(request()), token)).status).toBe(401);
    }
    // The routes that take no token stay open.
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await stop();
  });

  it('send the token with judgements alone', async () => {
    const seen: { path: string; authorization: string | null }[] = [];
    const recording: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ path: new URL(String(input)).pathname, authorization: headers.get('authorization') });
      return new Response('{}', { status: 500 });
    };
    const spy = new GatewayClient({ url: 'http://gateway', token: TOKEN, fetch: recording });
    await spy.judge(request()).catch(() => {});
    await spy.spend().catch(() => {});
    expect(seen).toEqual([
      { path: '/v1/judgements', authorization: `Bearer ${TOKEN}` },
      { path: '/v1/spend', authorization: null },
    ]);
  });
});

describe('the gateway’s settings', () => {
  it('default to replay on the local profile', () => {
    expect(configFromEnv({})).toMatchObject({ mode: 'replay', profile: 'local', port: 8080, cassettesRead: [] });
  });

  it('read the modes, the profile and the folders', () => {
    expect(
      configFromEnv({
        GATEWAY_MODE: 'record',
        TYPESAFE_API_KEY: 'k',
        CASSETTES_DIR: '/data',
        CASSETTES_READ: '/a:/b',
        FACTORY_PROFILE: 'do',
        PORT: '9000',
      }),
    ).toMatchObject({ mode: 'record', cassettesDir: '/data', cassettesRead: ['/a', '/b'], profile: 'do', port: 9000 });
  });

  it('read triage’s token, and refuse one short enough to guess', () => {
    expect(configFromEnv({}).judgementsToken).toBeUndefined();
    expect(configFromEnv({ JUDGEMENTS_TOKEN: TOKEN }).judgementsToken).toBe(TOKEN);
    expect(() => configFromEnv({ JUDGEMENTS_TOKEN: 'triage' })).toThrow('JUDGEMENTS_TOKEN');
    // As triage reads it too: a token with whitespace, as a stray newline would leave, is not sent as written.
    expect(judgementsToken(undefined)).toBeUndefined();
    expect(judgementsToken(TOKEN)).toBe(TOKEN);
    expect(() => judgementsToken(`${TOKEN}\n`)).toThrow('whitespace');
    expect(() => judgementsToken(` ${TOKEN}`)).toThrow('whitespace');
    expect(() => judgementsToken('a'.repeat(31))).toThrow('32 characters');
  });

  it('refuse a mode or profile that does not exist, and recording nowhere', () => {
    expect(() => configFromEnv({ GATEWAY_MODE: 'yolo' })).toThrow('GATEWAY_MODE');
    expect(() => configFromEnv({ FACTORY_PROFILE: 'moon' })).toThrow('FACTORY_PROFILE');
    expect(() => configFromEnv({ GATEWAY_MODE: 'record', TYPESAFE_API_KEY: 'k' })).toThrow('CASSETTES_DIR');
    // On `local` the local model records with no key at all, so it needs somewhere to.
    expect(() => configFromEnv({ GATEWAY_MODE: 'record' })).toThrow('CASSETTES_DIR');
    // With no key and no local model it only replays, so it records nothing and needs nowhere to.
    expect(configFromEnv({ GATEWAY_MODE: 'record', FACTORY_PROFILE: 'do' }).mode).toBe('record');
  });
});
