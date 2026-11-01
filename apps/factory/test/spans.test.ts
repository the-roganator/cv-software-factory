/**
 * A work item's trace: the line's step span, kept with the step's job token, and the gateway's span for each of the
 * job's model calls under it, with the provider's call under that. The runner is a stand-in that calls the gateway
 * outside any span, as the real one does from a pod with no telemetry.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { context, ROOT_CONTEXT, SpanKind } from '@opentelemetry/api';
import { DiskArtifacts, EventWriter, issueJobToken } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../packages/store/test/database.ts';
import type { Handback, Step } from '../../runner/src/step.ts';
import { AgentCassettes } from '../src/gateway/agent-cassettes.ts';
import { AgentCalls } from '../src/gateway/agents.ts';
import { Cassettes } from '../src/gateway/cassettes.ts';
import { Gateway } from '../src/gateway/gateway.ts';
import { costOf } from '../src/gateway/prices.ts';
import { ProviderCaps } from '../src/gateway/provider-caps.ts';
import { Anthropic } from '../src/gateway/providers.ts';
import { createGatewayServer } from '../src/gateway/server.ts';
import { Spend } from '../src/gateway/spend.ts';
import { ProbesClient } from '../src/line/verify.ts';
import type { Kube } from '../src/runners/kube.ts';
import { Runners } from '../src/runners/steps.ts';
import { ATTRIBUTES as A, inSpan } from '../src/spans.ts';
import { quiet } from './github/fake.ts';
import { recordSpans } from './tracing.ts';

const { spans, tracer } = recordSpans();

/** A stream as Anthropic sends one, with its usage split between its start and its last delta. */
const STREAM = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        type: 'message',
        usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, output_tokens: 1 },
      },
    },
  ],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }],
  ['message_stop', { type: 'message_stop' }],
]
  .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  .join('');

const providerHeard: IncomingHttpHeaders[] = [];
const provider: Server = createServer(async (req, res) => {
  for await (const _ of req);
  providerHeard.push(req.headers);
  res.writeHead(200, { 'content-type': 'text/event-stream' }).end(STREAM);
});
let providerUrl = '';
let database: Database;
let gateway: Server;
let gatewayUrl = '';
let agents: AgentCalls;

beforeAll(async () => {
  providerUrl = (await listenLocal(provider)).url;
  database = await freshDatabase('spans');
  const sql = database.as.gateway;
  const events = new EventWriter(sql, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'a-'))),
  });
  const policy = { dayUsd: 20, monthUsd: null, workItemUsd: 5 };
  const spend = new Spend({ sql, events, profile: 'local', policy, log: quiet });
  const caps = new ProviderCaps({ sql, events, log: quiet, probe: async () => true });
  const cassettes = mkdtempSync(join(tmpdir(), 'cassettes-'));
  agents = new AgentCalls({
    sql,
    spend,
    caps,
    cassettes: new AgentCassettes({ record: cassettes }),
    mode: 'live',
    profile: 'local',
    allLocal: false,
    providers: { anthropic: new Anthropic({ apiKey: 'sk-ant-real-key', base: providerUrl }) },
    log: quiet,
  });
  const judge = new Gateway({ sql, spend, cassettes: new Cassettes({ record: cassettes }), mode: 'live', log: quiet });
  gateway = createGatewayServer({ gateway: judge, agents, spend, judgementsToken: undefined, log: quiet });
  gatewayUrl = (await listenLocal(gateway)).url;
});
afterAll(async () => {
  for (const server of [provider, gateway]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await database?.end();
});

const REQUEST = {
  model: 'claude-opus-5-5',
  max_tokens: 1000,
  stream: true,
  messages: [{ role: 'user', content: 'Fix the cart.' }],
};

/** A call as the Agent SDK makes one, with its job token where the key would go. */
const callGateway = (base: string, token: string) =>
  fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(REQUEST),
  });

const DONE: Handback = { ending: 'finished', patch: '', note: 'Fixed.', turns: 1, session: null };

/** Just enough of Kubernetes for one step: the prepare pod succeeds, and the agent pod runs `agent`, then ends. */
function fakeKube(agent: (env: Record<string, string>) => Promise<void>): Kube {
  const jobs = new Map<string, unknown>();
  return {
    get: async <T>(path: string) => jobs.get(path.split('/').at(-1) ?? '') as T | undefined,
    text: async () => undefined,
    async create(_path, body) {
      const job = body as {
        kind: string;
        metadata: { name: string };
        spec: { template: { spec: { containers: { env: { name: string; value: string }[] }[] } } };
      };
      if (job.kind !== 'Job') return;
      const name = job.metadata.name;
      if (name.endsWith('-prepare')) return void jobs.set(name, { status: { succeeded: 1 } });
      jobs.set(name, { status: {} });
      const env = Object.fromEntries(job.spec.template.spec.containers[0]?.env.map((e) => [e.name, e.value]) ?? []);
      // The pod is another process, with no span in hand.
      setTimeout(
        () =>
          context.with(ROOT_CONTEXT, async () => {
            await agent(env);
            jobs.set(name, { status: { succeeded: 1 } });
          }),
        10,
      );
    },
    remove: async (path) => void jobs.delete(path.split('/').at(-1) ?? ''),
  };
}

const STEP: Step = {
  agent: 'coder',
  repository: 'https://github.com/the-roganator/cv-worlds-worst-website.git',
  commit: 'a'.repeat(40),
  prompt: 'Fix it.',
  maxTurns: 10,
};

describe('a work item’s trace', () => {
  it('runs from the line’s step through the gateway’s call to the provider’s', async () => {
    let handback = '';
    const runners: Runners = new Runners({
      sql: database.as.line,
      kube: fakeKube(async (env) => {
        const answer = await callGateway(env.ANTHROPIC_BASE_URL ?? '', env.ANTHROPIC_API_KEY ?? '');
        expect(answer.status).toBe(200);
        await answer.text();
        await fetch(handback, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.ANTHROPIC_API_KEY}` },
          body: JSON.stringify(DONE),
        });
      }),
      image: 'runner',
      gatewayUrl,
      handbackUrl: 'http://127.0.0.1/v1/handback',
      log: quiet,
      pollMs: 10,
      graceMs: 10,
    });
    const line = createServer(runners.handback());
    handback = `${(await listenLocal(line)).url}/v1/handback`;

    const outcome = await inSpan('step', { [A.workItem]: '1001', [A.agent]: 'coder' }, () =>
      runners.run({ ...STEP, workItem: '1001', round: 1, deadlineSeconds: 60 }),
    );
    await new Promise<void>((resolve) => line.close(() => resolve()));
    expect(outcome).toMatchObject({ kind: 'handed-back', job: 'coder-1001-1-1' });

    const [step] = spans('step');
    const [call] = spans('model call');
    expect(call?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId);
    expect(call?.spanContext().traceId).toBe(step?.spanContext().traceId);
    const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 2000, cacheWriteTokens: 500 };
    expect(call?.attributes).toEqual({
      work_item: '1001',
      job: 'coder-1001-1-1',
      agent: 'coder',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      outcome: 'answered',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 2000,
      cache_write_tokens: 500,
      cost_usd: costOf('claude-sonnet-5-5', usage),
    });
    // The provider's call is the call span's child, and the provider is sent the trace.
    const sent = spans().find(
      (span) => span.kind === SpanKind.CLIENT && span.attributes['server.port'] === Number(new URL(providerUrl).port),
    );
    expect(sent?.parentSpanContext?.spanId).toBe(call?.spanContext().spanId);
    expect(providerHeard.at(-1)?.traceparent).toContain(step?.spanContext().traceId);
    // The runner's own calls, made outside any span, make none.
    expect(spans().filter((span) => span.kind === SpanKind.CLIENT)).toHaveLength(1);
  });

  it('links each call to the request that carried it, and with no step’s trace puts the call under the request', async () => {
    const step = tracer.startSpan('step');
    const traceparent = `00-${step.spanContext().traceId}-${step.spanContext().spanId}-01`;
    step.end();
    const traced = await issueJobToken(database.as.line, {
      job: 'coder-1002-1-1',
      workItem: '1002',
      agent: 'coder',
      traceparent,
    });
    const untraced = await issueJobToken(database.as.line, { job: 'coder-1003-1-1', workItem: '1003', agent: 'coder' });
    const asked = async (token: string) =>
      tracer.startActiveSpan('POST /v1/messages', async (request) => {
        const reply = await agents.messages({ 'x-api-key': token }, async () => JSON.stringify(REQUEST));
        for await (const _ of reply.body as AsyncIterable<Uint8Array>);
        request.end();
        return request.spanContext();
      });

    const first = await asked(traced);
    const second = await asked(untraced);

    const [underStep, underRequest] = spans('model call');
    expect(underStep?.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
    expect(underStep?.links.map((link) => link.context.spanId)).toEqual([first.spanId]);
    expect(underRequest?.parentSpanContext?.spanId).toBe(second.spanId);
    expect(underRequest?.links).toEqual([]);
    expect(underRequest?.attributes).toMatchObject({ work_item: '1003', job: 'coder-1003-1-1', outcome: 'answered' });
  });

  it('traces a look’s first ask of the probes, and none of its polls for the answer', async () => {
    const heard: (string | undefined)[] = [];
    const probes = createServer(async (req, res) => {
      for await (const _ of req);
      heard.push(req.headers.traceparent as string | undefined);
      if (heard.length < 3) return void res.writeHead(202).end('{"state":"running"}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ outcome: 'cleared', version: 'b'.repeat(40), runs: ['passed', 'passed'] }));
    });
    const { url: base } = await listenLocal(probes);
    const asked = { sense: 'probe', check: 'search', route: '/search', version: 'b'.repeat(40) };
    const look = await inSpan('verify', {}, async (span) => {
      await new ProbesClient(base, { pollMs: 5 }).verify(asked as never);
      return span.spanContext();
    });
    probes.closeAllConnections();
    await new Promise<void>((resolve) => probes.close(() => resolve()));

    expect(heard).toHaveLength(3);
    expect(heard[0]).toContain(look.traceId);
    expect(heard.slice(1)).toEqual([undefined, undefined]);
    expect(spans().filter((span) => span.kind === SpanKind.CLIENT)).toHaveLength(1);
  });
});
