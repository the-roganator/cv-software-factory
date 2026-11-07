/**
 * The gateway's metrics as an OpenTelemetry SDK collects them: a meter provider installed for this file before the
 * gateway's modules are loaded, as `telemetry.ts` is before a worker's, and read at the end of each test. Vitest gives
 * each file its own globals.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metrics as api } from '@opentelemetry/api';
import * as metrics from '@opentelemetry/sdk-metrics';
import { DiskArtifacts, EventWriter, issueJobToken } from '@software-factory/store';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { startLine } from '../../../../packages/store/test/line.ts';
import type { SpendPolicy } from '../../../../policy/spend.ts';
import type { MessagesProvider, ProviderName } from '../../src/gateway/providers.ts';
import { capturingLog, fakeTypeSafe, request } from './helpers.ts';

const reader = new metrics.PeriodicExportingMetricReader({
  exporter: new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE),
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new metrics.MeterProvider({ readers: [reader] });
api.setGlobalMeterProvider(meterProvider);
// Only now: each module takes its meter as it loads.
const { AgentCalls } = await import('../../src/gateway/agents.ts');
const { AgentCassettes } = await import('../../src/gateway/agent-cassettes.ts');
const { Cassettes } = await import('../../src/gateway/cassettes.ts');
const { Gateway } = await import('../../src/gateway/gateway.ts');
const { ProviderCaps } = await import('../../src/gateway/provider-caps.ts');
const { Spend } = await import('../../src/gateway/spend.ts');
const { TypeSafe } = await import('../../src/gateway/typesafe.ts');
const { NO_CAP, observeCaps } = await import('../../src/gateway/metrics.ts');

const typesafe = await fakeTypeSafe();
afterAll(async () => {
  await typesafe.close();
  await meterProvider.shutdown();
  api.disable();
});

let database: Database | undefined;
let stopSpend: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stopSpend?.();
  await database?.end();
  database = undefined;
  stopSpend = undefined;
});

interface Point {
  attributes: Record<string, unknown>;
  value: number;
}

/** Every point of the metric named, as the reader collects it now. */
async function points(name: string): Promise<Point[]> {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).find((m) => m.descriptor.name === name);
  return (metric?.dataPoints ?? []).map((p) => ({ attributes: p.attributes, value: p.value as number }));
}

/** The value at a series, matched on the attributes given, summed across any others. */
const at = (all: Point[], attributes: Record<string, unknown>) =>
  all
    .filter((p) => Object.entries(attributes).every(([k, v]) => p.attributes[k] === v))
    .reduce((sum, p) => sum + p.value, 0);

/** A provider that answers, in turn, each of what it is given. */
function scripted(name: ProviderName, ...replies: (Response | Error)[]): MessagesProvider {
  return {
    name,
    send: async () => {
      const reply = replies.shift();
      if (!reply) throw new Error('nothing scripted');
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

const message = (usage: Record<string, number>) =>
  new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'Fixed.' }], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

async function harness(policy: SpendPolicy, anthropic: MessagesProvider) {
  database = await freshDatabase('gateway_metrics');
  await startLine(database.admin);
  const sql = database.as.gateway;
  const { log } = capturingLog();
  const dir = mkdtempSync(join(tmpdir(), 'cassettes-'));
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(dir) });
  const spend = new Spend({ sql, events, profile: 'local', policy, log });
  await spend.resume();
  spend.start();
  stopSpend = () => spend.stop();
  const caps = new ProviderCaps({ sql, events, log, probe: async () => false });
  const agents = new AgentCalls({
    sql,
    spend,
    caps,
    cassettes: new AgentCassettes({ record: dir }),
    mode: 'replay-record',
    profile: 'local',
    allLocal: false,
    providers: { anthropic },
    log,
  });
  const gateway = new Gateway({
    sql,
    spend,
    cassettes: new Cassettes({ record: dir }),
    mode: 'record',
    typesafe: new TypeSafe({ apiKey: 'test-key', baseUrl: typesafe.url, log, sleep: async () => {}, random: () => 0 }),
    log,
  });
  const token = await issueJobToken(database.as.line, { job: 'coder-1001-1', workItem: '1001', agent: 'coder' });
  const call = async (text: string) => {
    const body = { model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user', content: text }] };
    const reply = await agents.messages({ 'x-api-key': token }, async () => JSON.stringify(body));
    return reply.status;
  };
  return { call, gateway, spend };
}

const CODER = { agent: 'coder', provider: 'anthropic', model: 'claude-sonnet-5-5' };
const LABELS = new Set(['agent', 'provider', 'model', 'outcome', 'kind', 'status', 'cap', 'profile']);

/** What a gateway metric may be labelled with: never a work item, a job or anything from a request. */
async function expectNoWorkItems() {
  const { resourceMetrics } = await reader.collect();
  const scope = resourceMetrics.scopeMetrics.find((s) => s.scope.name === 'factory-gateway');
  const labels = new Set(scope?.metrics.flatMap((m) => m.dataPoints.flatMap((p) => Object.keys(p.attributes))));
  expect(labels.size).toBeGreaterThan(0);
  expect([...labels].filter((label) => !LABELS.has(label))).toEqual([]);
}

describe("the gateway's metrics", () => {
  it('counts tokens by kind and outcome, errors by status, refusals by cap, and spend against the caps', async () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 500,
    };
    const { call, spend } = await harness(
      { dayUsd: 20, monthUsd: null, workItemUsd: 0.002 },
      scripted(
        'anthropic',
        new Response('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}', { status: 529 }),
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        message(usage),
      ),
    );
    expect(await call('Fix the cart.')).toBe(529);
    expect(await call('Fix the cart.')).toBe(502);
    expect(await call('Fix the cart.')).toBe(200);
    // The same call again is replayed; another is refused, since the first took the work item past its cap.
    expect(await call('Fix the cart.')).toBe(200);
    expect(await call('Fix the till.')).toBe(403);
    await spend.reconcile();

    const tokens = await points('gateway.tokens');
    expect(at(tokens, { ...CODER, outcome: 'answered', kind: 'input' })).toBe(100);
    expect(at(tokens, { ...CODER, outcome: 'answered', kind: 'output' })).toBe(50);
    expect(at(tokens, { ...CODER, outcome: 'answered', kind: 'cache_read' })).toBe(2000);
    expect(at(tokens, { ...CODER, outcome: 'answered', kind: 'cache_write' })).toBe(500);
    expect(at(tokens, { ...CODER, outcome: 'replayed', kind: 'input' })).toBe(100);
    expect(at(tokens, { outcome: 'refused' })).toBe(0);
    // A failed call that used nothing makes no series of tokens.
    expect(tokens.filter((p) => p.attributes.outcome === 'failed')).toEqual([]);

    const errors = await points('gateway.provider.errors');
    expect(at(errors, { ...CODER, status: '529' })).toBe(1);
    expect(at(errors, { ...CODER, status: 'network' })).toBe(1);
    expect(at(await points('gateway.cap.refusals'), { ...CODER, cap: 'work-item' })).toBe(1);
    expect(at(await points('gateway.calls'), { ...CODER, outcome: 'failed' })).toBe(2);

    const spent = await points('gateway.cap.spent_usd');
    expect(at(spent, { cap: 'day', profile: 'local' })).toBeGreaterThan(0.002);
    expect(at(spent, { cap: 'month', profile: 'local' })).toBe(at(spent, { cap: 'day' }));
    // No month cap in this policy: it reads as none, a figure no cap can be.
    expect((await points('gateway.cap.limit_usd')).map((p) => [p.attributes.cap, p.value])).toEqual([
      ['day', 20],
      ['month', NO_CAP],
      ['work-item', 0.002],
    ]);
    await expectNoWorkItems();
  });

  it("counts a judgement's tokens, each of TypeSafe's error statuses, retried or not, and a day's cap", async () => {
    const { gateway } = await harness({ dayUsd: 0.00001, monthUsd: 100, workItemUsd: 1 }, scripted('anthropic'));
    typesafe.script({ status: 422 });
    await expect(gateway.judge(request())).rejects.toMatchObject({ name: 'ProviderError', status: 422 });
    typesafe.inputTokens = 1000;
    // A rate limit TypeSafe's client retries is still the provider's error.
    typesafe.script({ status: 429 });
    await gateway.judge(request());
    await expect(gateway.judge(request({ questionSet: 'triage/v2' }))).rejects.toMatchObject({ cap: 'day' });

    const triage = { agent: 'triage', provider: 'typesafe', model: 'jev-1.13.0' };
    const tokens = await points('gateway.tokens');
    expect(at(tokens, { ...triage, outcome: 'answered', kind: 'input' })).toBe(1000);
    expect(at(tokens, { ...triage, outcome: 'answered', kind: 'output' })).toBe(12);
    expect(at(await points('gateway.provider.errors'), { ...triage, status: '422' })).toBe(1);
    expect(at(await points('gateway.provider.errors'), { ...triage, status: '429' })).toBe(1);
    expect(at(await points('gateway.cap.refusals'), { ...triage, cap: 'day' })).toBe(1);
    expect(at(await points('gateway.cap.limit_usd'), { cap: 'month' })).toBe(100);
    await expectNoWorkItems();
  });

  it('reports a month cap lifted as none at once, never its last figure, which would page for a cap that is gone', async () => {
    let monthUsd: number | null = 5;
    const stop = observeCaps(() => ({
      profile: 'do',
      dayUsd: 1,
      monthUsd: 6,
      limits: { dayUsd: 20, monthUsd, workItemUsd: 1 },
    }));
    try {
      const month = async () =>
        (await points('gateway.cap.limit_usd')).find(
          (p) => p.attributes.cap === 'month' && p.attributes.profile === 'do',
        )?.value;
      expect(await month()).toBe(5);
      monthUsd = null;
      expect(await month()).toBe(NO_CAP);
      expect(NO_CAP).toBeLessThan(0);
    } finally {
      stop();
    }
  });
});
