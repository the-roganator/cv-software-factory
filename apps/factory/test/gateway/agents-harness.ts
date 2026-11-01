/**
 * Agents' calls through the gateway, as agents.test.ts and the proofs in proofs/ make them: a stand-in for the provider,
 * a gateway on a store of its own, a running job's token, and the calls an agent's SDK sends.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectTcp, createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewEvent } from '@software-factory/events';
import { DiskArtifacts, EventWriter, issueJobToken } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { SpendPolicy } from '../../../../policy/spend.ts';
import { AgentCassettes } from '../../src/gateway/agent-cassettes.ts';
import { AgentCalls } from '../../src/gateway/agents.ts';
import { Cassettes } from '../../src/gateway/cassettes.ts';
import { Gateway, type Mode } from '../../src/gateway/gateway.ts';
import { ProviderCaps } from '../../src/gateway/provider-caps.ts';
import { Anthropic, LocalModels, type ProviderName } from '../../src/gateway/providers.ts';
import { Refusals } from '../../src/gateway/refusals.ts';
import { createGatewayServer } from '../../src/gateway/server.ts';
import { Spend } from '../../src/gateway/spend.ts';
import { SettingsReader } from '../../src/settings.ts';
import { capturingLog } from './helpers.ts';

/** A stream as Anthropic sends one, with the usage split between its start and its last delta. */
export const sse = (text: string) =>
  [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-sonnet-5-5',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 500,
            output_tokens: 1,
          },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');

type Step =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | 'drop'
  /** A stream as given, and then the connection dropped if `drop`. */
  | { sse: string; drop?: boolean };

/** A stand-in for Anthropic's Messages API (and LM Studio's, which is the same). */
async function fakeProvider() {
  const steps: Step[] = [];
  const requests: { headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = [];
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    requests.push({ headers: req.headers, body });
    const step = steps.shift();
    if (step === 'drop') return void req.socket.destroy();
    if (step && 'sse' in step) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(step.sse);
      if (step.drop) return void setTimeout(() => res.destroy(), 20);
      return void res.end();
    }
    if (step) {
      res.writeHead(step.status, { 'content-type': 'application/json', ...step.headers });
      return void res.end(JSON.stringify(step.body));
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return void res.end(sse('Fixed.'));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'message',
        content: [{ type: 'text', text: 'Fixed.' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
    );
  };
  const server: Server = createServer((req, res) => void handle(req, res));
  const { url } = await listenLocal(server);
  return {
    url,
    requests,
    script: (...next: Step[]) => void steps.push(...next),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A TCP relay to the store that can cut every connection through it, and refuse new ones. */
export async function cutter(host: string, port: number) {
  const sockets = new Set<Socket>();
  let refusing = false;
  const relay = createNetServer((client) => {
    if (refusing) return void client.destroy();
    const upstream = connectTcp(port, host);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  const { port: relayPort } = await listenLocal(relay);
  return {
    port: relayPort,
    cut: () => {
      for (const socket of sockets) socket.destroy();
    },
    refuse: (on: boolean) => {
      refusing = on;
    },
    close: () => new Promise<void>((resolve) => relay.close(() => resolve())),
  };
}

export let provider: Awaited<ReturnType<typeof fakeProvider>>;
export let database: Database;
let server: Server | undefined;
export let url: string;
export let cassettesDir: string;
export let caps: ProviderCaps;
export let agentCalls: AgentCalls | undefined;
export const captured = capturingLog();

/** The stand-in provider for a file's tests, and each test's gateway and store gone after it. */
export function withAgentGateway() {
  beforeAll(async () => {
    provider = await fakeProvider();
  });
  afterAll(() => provider.close());
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await agentCalls?.stop();
    agentCalls = undefined;
    await database?.end();
  });
}

export interface Options {
  mode?: Mode;
  policy?: SpendPolicy;
  allLocal?: boolean;
  local?: string;
  /** Martin's settings from the store, read afresh at every look, in place of `policy`. */
  settings?: boolean;
  /** The gateway's clock, for a test that moves it on. */
  clock?: () => Date;
  /** Whether the gateway listens for appends, as it does when it runs. */
  listening?: boolean;
  /** The gateway's own client, made from its role's, for a test that comes between it and the store. */
  client?: (gateway: Sql) => Sql;
}

export async function start({
  mode = 'replay-record',
  policy = { dayUsd: 20, monthUsd: null, workItemUsd: 5 },
  allLocal = false,
  local,
  settings: fromStore = false,
  clock,
  listening = true,
  client,
}: Options = {}) {
  database = await freshDatabase('agents');
  cassettesDir = mkdtempSync(join(tmpdir(), 'cassettes-'));
  const sql = client ? client(database.as.gateway) : database.as.gateway;
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) });
  // A clock a minute on at every look, so the settings in force are read again each time.
  let looks = 0;
  const settings = fromStore
    ? new SettingsReader(sql, 'local', { clock: () => new Date(Date.UTC(2026, 9, 4) + looks++ * 60_000) })
    : undefined;
  const spend = new Spend({
    sql,
    events,
    profile: 'local',
    policy: settings ? async (fresh: boolean) => (await settings.now(fresh)).caps : policy,
    log: captured.log,
  });
  const providers: Partial<Record<ProviderName, Anthropic | LocalModels>> = {
    anthropic: new Anthropic({ apiKey: 'sk-ant-real-key', base: provider.url }),
    local: new LocalModels({ base: local ?? provider.url }),
  };
  caps = new ProviderCaps({
    sql,
    events,
    log: captured.log,
    probe: async (name) => (await providers[name]?.send('/v1/messages', '{}', {}))?.ok ?? false,
  });
  const refusals = new Refusals({ events, log: captured.log });
  const agents = new AgentCalls({
    sql,
    spend,
    caps,
    cassettes: new AgentCassettes({ record: cassettesDir }),
    mode,
    profile: 'local',
    allLocal,
    ...(settings && { settings }),
    providers,
    log: captured.log,
    refusals,
    ...(clock && { clock }),
  });
  agentCalls = agents;
  if (listening) await agents.start();
  const gateway = new Gateway({
    sql,
    spend,
    cassettes: new Cassettes({ record: cassettesDir }),
    mode,
    log: captured.log,
  });
  server = createGatewayServer({ gateway, agents, spend, log: captured.log });
  url = (await listenLocal(server)).url;
  const token = await issueJobToken(database.as.line, { job: 'coder-1001-1', workItem: '1001', agent: 'coder' });
  return { sql, token, events, refusals };
}

/** Work item 1001 opened, as triage opens a ticket's, so the gateway's refusals have it to go on. */
export const opened = (): NewEvent => ({
  id: crypto.randomUUID(),
  ts: new Date().toISOString(),
  work_item: '1001',
  type: 'work-item.opened',
  version: 2,
  actor: 'triage',
  summary: 'Work item opened',
  payload: { kind: 'defect-fix', title: 'Server errors', sample: false },
  artifacts: [],
});

/** The refusals in the store, with the role that appended each. */
export const refusalsIn = (sql: Database['owner']) =>
  sql<{ work_item: string | null; appended_by: string; payload: Record<string, unknown> }[]>`
    select work_item, appended_by, payload from events where type = 'action.refused' order by seq`;

/** A call as the Agent SDK makes one: the token where the key would be, and the API's version and betas. */
export const call = (token: string, body: Record<string, unknown>, path = '/v1/messages') =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

export const agentRequest = (day = '2026-10-04', session = 'a') => ({
  model: 'claude-opus-5-5',
  max_tokens: 32000,
  stream: true,
  metadata: { user_id: `session-${session}` },
  system: [{ type: 'text', text: `You are the coder. Today's date is ${day}.`, cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'Fix the cart.' }],
});

/** The line stopped, by Martin. */
export const stop = (): NewEvent => ({
  id: crypto.randomUUID(),
  ts: new Date().toISOString(),
  work_item: null,
  type: 'line.stopped',
  version: 1,
  actor: 'martin',
  summary: 'The line stopped',
  payload: { reason: 'testing' },
  artifacts: [],
});
