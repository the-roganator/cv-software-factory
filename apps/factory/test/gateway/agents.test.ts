import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiskArtifacts, EventWriter, endJobToken, issueJobToken } from '@software-factory/store';
import { describe, expect, it, vi } from 'vitest';
import { keyedRequest } from '../../src/gateway/agent-cassettes.ts';
import { usageOf } from '../../src/gateway/agents.ts';
import * as instruments from '../../src/gateway/metrics.ts';
import { costOf } from '../../src/gateway/prices.ts';
import { capOf, LocalModels, systemInPlace } from '../../src/gateway/providers.ts';
import { appendSettings, settingsPayload } from '../settings-events.ts';
import {
  agentRequest,
  call,
  caps,
  captured,
  cassettesDir,
  database,
  opened,
  provider,
  refusalsIn,
  sse,
  start,
  stop,
  url,
  withAgentGateway,
} from './agents-harness.ts';

// The tests of a stop and of the spend caps, which prove guardrails, are in proofs/, Martin's (CODEOWNERS).
withAgentGateway();

describe('agents through the gateway', () => {
  it('refuses a call without the token of a running job', async () => {
    const { token } = await start();
    expect((await call('sk-ant-guess', agentRequest())).status).toBe(401);
    await endJobToken(database.as.line, 'coder-1001-1');
    const ended = await call(token, agentRequest());
    expect(ended.status).toBe(401);
    expect(await ended.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    expect(provider.requests).toHaveLength(0);
  });

  it('sends the policy’s model and effort for Claude with the real key, relays the stream, and audits and records the call', async () => {
    provider.requests.length = 0;
    const { sql, token } = await start();
    const response = await call(token, agentRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(await response.text()).toBe(sse('Fixed.'));

    const [sent] = provider.requests;
    expect(sent?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      output_config: { effort: 'medium' },
      max_tokens: 32000,
    });
    // The cache markers pass through as the runner wrote them.
    expect(sent?.body.system).toEqual(agentRequest().system);
    expect(sent?.headers['x-api-key']).toBe('sk-ant-real-key');
    expect(sent?.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    expect(JSON.stringify(sent?.headers)).not.toContain(token);

    const [row] = await sql`select * from model_calls`;
    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 2000,
      cacheWriteTokens: 500,
      cacheWriteHourTokens: 0,
    };
    expect(row).toMatchObject({
      agent: 'coder',
      work_item: '1001',
      job: 'coder-1001-1',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 2000,
      cache_write_tokens: 500,
      outcome: 'answered',
    });
    expect(Number(row?.cost_usd)).toBeCloseTo(costOf('claude-sonnet-5-5', usage), 8);
    expect(readdirSync(cassettesDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('adds each priced call to the spend the dashboards read, at what the audit log says it cost', async () => {
    // Without an OpenTelemetry SDK every instrument is the same no-op, so the spy sees every instrument's records.
    const added = vi.spyOn(instruments.spend, 'add');
    try {
      const { sql, token } = await start();
      await (await call(token, agentRequest())).text();
      const [row] = await vi.waitFor(async () => {
        const rows = await sql<{ cost_usd: string }[]>`select cost_usd from model_calls`;
        if (!rows.length) throw new Error('not audited yet');
        return rows;
      });
      // Never a work item, which would make a series for each.
      expect(added.mock.calls).toContainEqual([
        Number(row?.cost_usd),
        { agent: 'coder', provider: 'anthropic', model: 'claude-sonnet-5-5' },
      ]);
    } finally {
      added.mockRestore();
    }
  });

  it('replays the same step on another day, in another session, without asking the provider', async () => {
    provider.requests.length = 0;
    const { sql, token } = await start();
    await (await call(token, agentRequest('2026-10-04', 'a'))).text();
    const again = await call(token, agentRequest('2026-10-05', 'b'));
    expect(await again.text()).toBe(sse('Fixed.'));
    expect(provider.requests).toHaveLength(1);
    expect((await sql`select outcome, cost_usd from model_calls order by at`).map((r) => r.outcome)).toEqual([
      'answered',
      'replayed',
    ]);
    // A changed prompt is a new call, and pays.
    await (await call(token, { ...agentRequest(), messages: [{ role: 'user', content: 'Fix the till.' }] })).text();
    expect(provider.requests).toHaveLength(2);
  });
  it('treats spent credit as a cap: it says so once, waits, and clears when the provider answers', async () => {
    provider.requests.length = 0;
    const { sql, token, refusals } = await start();
    await new EventWriter(database.as.triage, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) }).append(
      opened(),
    );
    provider.script({
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      },
    });
    const refused = await call(token, agentRequest());
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('300');
    // While capped, nothing more reaches the provider.
    expect((await call(token, agentRequest())).status).toBe(429);
    expect(provider.requests).toHaveLength(1);

    await caps.probe();
    const cleared = await call(token, agentRequest());
    expect(cleared.status).toBe(200);
    await cleared.text();
    const lines = await sql`select type, version, payload from events where type like 'spend.%' order by seq`;
    expect(lines).toEqual([
      {
        type: 'spend.capped',
        version: 2,
        payload: {
          cap: 'provider',
          provider: 'anthropic',
          reason: 'credit',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      },
      { type: 'spend.cleared', version: 2, payload: { cap: 'provider', provider: 'anthropic' } },
    ]);
    // The provider's own refusal and the one the gateway held after it are the same cap's, in the provider's words.
    await refusals.stop();
    const capped = {
      mechanism: 'gateway',
      action: 'A model call by the coder agent, while anthropic is at its credit cap',
      output: 'anthropic refuses calls for now (credit): Your credit balance is too low to access the Anthropic API.',
      guardrails: [7],
    };
    // One repeat in its minute is appended as itself.
    const recorded = { work_item: '1001', appended_by: 'factory_gateway', payload: capped };
    expect(await refusalsIn(database.owner)).toEqual([recorded, recorded]);
  });

  it('sends every agent to the local model when asked, and caps it when nothing is listening', async () => {
    const { sql, token, refusals } = await start({ allLocal: true, local: 'http://127.0.0.1:9' });
    await new EventWriter(database.as.triage, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) }).append(
      opened(),
    );
    const refused = await call(token, agentRequest());
    expect(refused.status).toBe(429);
    const [capped] = await sql`select payload from events where type = 'spend.capped'`;
    expect(capped?.payload).toMatchObject({ cap: 'provider', provider: 'local', reason: 'unreachable' });
    const [row] = await sql`select provider, model, outcome from model_calls`;
    expect(row).toEqual({ provider: 'local', model: 'qwen/qwen3.8-27b', outcome: 'failed' });
    // Held for an outage, not a cap: the next call is refused, and no guardrail is recorded as refusing it.
    expect((await call(token, agentRequest())).status).toBe(429);
    await refusals.stop();
    expect(await refusalsIn(database.owner)).toEqual([]);
  });

  it('sends the local model no effort, whatever the runner asked for, and keys its cassette without one', async () => {
    provider.requests.length = 0;
    const { token } = await start({ allLocal: true });
    const asked = { ...agentRequest(), output_config: { effort: 'max', format: { type: 'json_schema' } } };
    const response = await call(token, asked);
    expect(response.status).toBe(200);
    await response.text();

    const [sent] = provider.requests;
    expect(sent?.body).toMatchObject({ model: 'qwen/qwen3.8-27b', output_config: { format: { type: 'json_schema' } } });
    expect(sent?.body.output_config).not.toHaveProperty('effort');
    const [file] = readdirSync(cassettesDir).filter((f) => f.endsWith('.json'));
    const cassette = JSON.parse(readFileSync(join(cassettesDir, file ?? ''), 'utf8'));
    expect(cassette).toMatchObject({ provider: 'local', model: 'qwen/qwen3.8-27b' });
    expect(cassette.request.output_config).toEqual({ format: { type: 'json_schema' } });

    // With nothing else in it, no `output_config` is sent at all.
    provider.requests.length = 0;
    await (await call(token, { ...agentRequest(), output_config: { effort: 'low' } })).text();
    expect(provider.requests[0]?.body).not.toHaveProperty('output_config');
  });

  it('sends the model and effort Martin chose from a job’s next step, and nothing outside policy', async () => {
    provider.requests.length = 0;
    const { token } = await start({ settings: true });
    // Each call asks something new, so none is replayed.
    let asks = 0;
    const sent = async (job: string) => {
      provider.requests.length = 0;
      const ask = `Ask ${++asks}.`;
      await (await call(job, { ...agentRequest(), messages: [{ role: 'user', content: ask }] })).text();
      const body = provider.requests[0]?.body;
      return { model: body?.model, effort: (body?.output_config as { effort?: string } | undefined)?.effort };
    };
    const job = (n: number) =>
      issueJobToken(database.as.line, { job: `coder-1001-${n}`, workItem: '1001', agent: 'coder' });
    const opus = settingsPayload({ agents: { coder: { model: 'claude-opus-5-5', effort: 'high' } } });
    await appendSettings(database.admin, opus);
    // The job running as he chose goes on as it began.
    expect(await sent(token)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' });
    const second = await job(2);
    expect(await sent(second)).toEqual({ model: 'claude-opus-5-5', effort: 'high' });

    // One outside policy, appended straight to the store as one of his roles, so row security lets it in.
    await appendSettings(
      database.operator,
      settingsPayload({ agents: { coder: { model: 'claude-opus-9', effort: 'max' } }, caps: { workItemUsd: 0 } }),
    );
    expect(await sent(await job(3))).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' });
    // The job before it still runs as it began.
    expect(await sent(second)).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    const local = settingsPayload({ agents: { coder: { model: 'qwen/qwen3.8-27b' } } });
    await appendSettings(database.admin, local);
    expect(await sent(await job(4))).toEqual({ model: 'qwen/qwen3.8-27b', effort: undefined });
  });

  it('sends every agent to the local model under ALL_LOCAL, whatever the settings say', async () => {
    provider.requests.length = 0;
    const { sql } = await start({ settings: true, allLocal: true });
    await appendSettings(
      database.admin,
      settingsPayload({ agents: { coder: { model: 'claude-opus-5-5', effort: 'high' } } }),
    );
    const token = await issueJobToken(database.as.line, { job: 'coder-1001-2', workItem: '1001', agent: 'coder' });
    await (await call(token, agentRequest())).text();
    expect(provider.requests[0]?.body.model).toBe('qwen/qwen3.8-27b');
    expect(await sql`select provider, model from model_calls`).toEqual([
      { provider: 'local', model: 'qwen/qwen3.8-27b' },
    ]);
  });

  it('records each refusal of a guardrail on the job’s work item, in its own words, as the gateway’s role', async () => {
    const { token, refusals } = await start({ policy: { dayUsd: 20, monthUsd: null, workItemUsd: 0.001 } });
    await new EventWriter(database.as.triage, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) }).append(
      opened(),
    );
    // The work item's cap, once its first call has spent past it.
    await (await call(token, agentRequest())).text();
    const capped = await call(token, { ...agentRequest(), messages: [{ role: 'user', content: 'More.' }] });
    const cap = ((await capped.json()) as { error: { message: string } }).error.message;
    // An agent that calls no model through this API.
    const jev = await issueJobToken(database.as.line, { job: 'triage-1001-1', workItem: '1001', agent: 'triage' });
    const policy = ((await (await call(jev, agentRequest())).json()) as { error: { message: string } }).error.message;
    await refusals.settled();
    expect(await refusalsIn(database.owner)).toEqual([
      {
        work_item: '1001',
        appended_by: 'factory_gateway',
        payload: {
          mechanism: 'gateway',
          action: 'A model call by the coder agent, at the work-item spend cap',
          output: cap,
          guardrails: [7],
        },
      },
      {
        work_item: '1001',
        appended_by: 'factory_gateway',
        payload: { mechanism: 'gateway', action: 'A model call by the triage agent', output: policy, guardrails: [6] },
      },
    ]);
    expect(cap).toMatch(/work-item spend cap/);
    expect(policy).toBe('The triage agent does not call models through this API.');
  });

  it('folds a loop of refused calls into one event a minute, and records none for a guess or a request it cannot read', async () => {
    const { token, refusals } = await start();
    await new EventWriter(database.as.triage, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) }).append(
      opened(),
    );
    await new EventWriter(database.admin, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) }).append(stop());
    for (const _ of [1, 2, 3, 4]) expect((await call(token, agentRequest())).status).toBe(403);
    // A token that is no job's, and a count of tokens, refuse no model call.
    expect((await call('sk-ant-guess', agentRequest())).status).toBe(401);
    expect((await call(token, agentRequest(), '/v1/messages/count_tokens')).status).toBe(403);
    await refusals.stop();
    const stopped = {
      mechanism: 'gateway',
      action: 'A model call by the coder agent',
      output: 'The line is stopped: agents take no new calls until it starts again.',
      guardrails: [9],
    };
    expect(await refusalsIn(database.owner)).toEqual([
      { work_item: '1001', appended_by: 'factory_gateway', payload: stopped },
      {
        work_item: '1001',
        appended_by: 'factory_gateway',
        payload: { ...stopped, count: 3, lastAt: expect.any(String) },
      },
    ]);
  });

  it('answers a refused call as it would have when the store will not take its refusal', async () => {
    // Work item 1001 was never opened, so the store refuses an event on it.
    const { token, refusals } = await start();
    await new EventWriter(database.admin, { kind: 'real', artifacts: new DiskArtifacts(cassettesDir) }).append(stop());
    const response = await call(token, agentRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringMatching(/line is stopped/) } });
    await refusals.settled();
    expect(await refusalsIn(database.owner)).toEqual([]);
    expect(captured.text()).toMatch(/could not record the gateway’s refusal/);
  });

  it('replays only, without a cassette, as an error the SDK does not retry', async () => {
    const { token } = await start({ mode: 'replay' });
    const response = await call(token, agentRequest());
    expect(response.status).toBe(400);
  });

  it('counts tokens with the provider, or estimates', async () => {
    const { token } = await start({ mode: 'replay' });
    const response = await call(
      token,
      { messages: [{ role: 'user', content: 'x'.repeat(400) }] },
      '/v1/messages/count_tokens',
    );
    expect(await response.json()).toEqual({ input_tokens: expect.any(Number) });
  });
});

describe('reading the provider', () => {
  it('reads usage from a whole response and from a stream', () => {
    expect(
      usageOf(JSON.stringify({ type: 'message', usage: { input_tokens: 5, output_tokens: 2 } }), false),
    ).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
    });
    expect(usageOf(sse('x'), true)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 2000,
      cacheWriteTokens: 500,
      cacheWriteHourTokens: 0,
    });
  });

  it('tells a cap the factory does not own from any other refusal', () => {
    const error = (type: string, message: string) => JSON.stringify({ type: 'error', error: { type, message } });
    expect(capOf(402, error('billing_error', 'Payment required'))?.reason).toBe('credit');
    expect(
      capOf(400, error('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'))?.reason,
    ).toBe('credit');
    expect(
      capOf(400, error('invalid_request_error', 'You have reached your specified workspace API usage limits.'))?.reason,
    ).toBe('workspace-limit');
    expect(capOf(429, error('rate_limit_error', 'Too many requests'))).toBeUndefined();
    expect(capOf(400, error('invalid_request_error', 'max_tokens: too large'))).toBeUndefined();
  });

  it('keeps a long refusal’s words whole: cut between characters, and marked', () => {
    const said = `Your credit balance is too low${' '.repeat(268)}\u{1F4B8} and more`;
    const refusal = capOf(402, JSON.stringify({ type: 'error', error: { type: 'billing_error', message: said } }));
    expect(refusal?.message).toBe('Your credit balance is too low…');
    expect(refusal?.message.isWellFormed()).toBe(true);
    const plain = capOf(
      402,
      JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'a'.repeat(400) } }),
    );
    expect(plain?.message).toBe(`${'a'.repeat(299)}…`);
  });

  it('keys a step without its session or its date', () => {
    expect(keyedRequest(agentRequest('2026-10-04', 'a'))).toEqual(keyedRequest(agentRequest('2027-01-31', 'b')));
  });

  it('keys a step with the results of tools run at once in one order, whichever finished first', () => {
    const results = (...ids: string[]) => ({
      ...agentRequest(),
      messages: [
        { role: 'user', content: 'Fix the cart.' },
        {
          role: 'user',
          content: [
            ...ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: `read ${id}` })),
            { type: 'text', text: 'Carry on.' },
          ],
        },
      ],
    });
    expect(keyedRequest(results('toolu_2', 'toolu_1'))).toEqual(keyedRequest(results('toolu_1', 'toolu_2')));
    expect(keyedRequest(results('toolu_1', 'toolu_3'))).not.toEqual(keyedRequest(results('toolu_1', 'toolu_2')));
  });

  it('keys a step without the times its tools printed, and with everything else they printed', () => {
    const ran = (output: string) => ({
      ...agentRequest(),
      messages: [
        { role: 'user', content: 'Fix the cart.' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: output }] },
      ],
    });
    const vitest = (start: string, file: string, test: string, duration: string, failed = 1) =>
      [
        ' RUN  v3.2.4 /work/repo',
        '',
        ` ❯ test/cart.test.ts (2 tests | ${failed} failed)${file && ` ${file}`}`,
        `   × cart > counts the last item${test && ` ${test}`}`,
        '',
        ` Test Files  1 failed (1)`,
        `      Tests  ${failed} failed | ${2 - failed} passed (2)`,
        `   Start at  ${start}`,
        `   Duration  ${duration}`,
      ].join('\n');
    const first = keyedRequest(ran(vitest('23:03:54', '4ms', '2ms', '483ms (tests 77%, import 16%, transform 6%)')));
    const again = keyedRequest(ran(vitest('09:12:01', '11ms', '1.5s', '1.02s (transform 20ms, setup 0ms)')));
    expect(again).toEqual(first);
    expect(JSON.stringify(first)).toContain('counts the last item\\n');
    // Vitest prints a test's time only when the test is slow: printed once and not the other time, it keys the same.
    expect(keyedRequest(ran(vitest('10:00:00', '', '', '290ms')))).toEqual(first);
    const listed = (time: string) => ran(`total 8\n-rw-r--r--@  1 runner  wheel  1503 ${time} cart.test.ts\n`);
    expect(keyedRequest(listed('Oct  5 23:14'))).toEqual(keyedRequest(listed('Jan 12  2027')));
    expect(keyedRequest(listed('Oct  5 23:14'))).not.toEqual(keyedRequest(ran('total 8\n')));
    // Biome, in colour.
    const checked = (ms: number) =>
      ran(`\u001b[34mChecked 2 files in ${ms}\u001b[0m\u001b[2mms\u001b[0m. No fixes applied.`);
    expect(keyedRequest(checked(7))).toEqual(keyedRequest(checked(12)));
    // A different outcome is a different call.
    expect(keyedRequest(ran(vitest('23:03:54', '4ms', '2ms', '483ms', 2)))).not.toEqual(first);
  });
});

/** A stream's events, written as Anthropic writes them. */
const events = (...list: [string, unknown][]) =>
  list.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

describe('what a local model is sent', () => {
  // As the Agent SDK sends a step's calls: the environment after the prompt, and the tokens left after each result.
  const env = {
    role: 'system',
    content: [{ type: 'text', text: '# Environment', cache_control: { type: 'ephemeral' } }],
  };
  const left = (n: number, last: boolean) =>
    last
      ? { role: 'system', content: [{ type: 'text', text: `${n} tokens left`, cache_control: { type: 'ephemeral' } }] }
      : { role: 'system', content: `${n} tokens left` };
  const used = (id: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] });
  const result = (id: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] });
  const call = (turns: number) => ({
    system: [{ type: 'text', text: 'You are the planner.' }],
    messages: [
      { role: 'user', content: 'Plan the fix.' },
      turns ? { ...env, content: '# Environment' } : env,
      ...Array.from({ length: turns }, (_, i) => [
        used(`t${i}`),
        result(`t${i}`),
        left(100 - i, i === turns - 1),
      ]).flat(),
    ],
  });
  const reminder = (text: string) => ({ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` });

  it('has each system message among the turns in the user’s turn where it stood, after any tool’s results', () => {
    expect(systemInPlace(call(1))).toEqual({
      system: [{ type: 'text', text: 'You are the planner.' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Plan the fix.' }, reminder('# Environment')] },
        used('t0'),
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't0', content: 'x' }, reminder('100 tokens left')],
        },
      ],
    });
    const plain = { messages: [{ role: 'user', content: 'Hello' }] };
    expect(systemInPlace(plain)).toBe(plain);
  });

  it('sends each call as the one before it with more on the end, so the model’s cache holds', () => {
    for (let turns = 0; turns < 4; turns++) {
      const before = systemInPlace(call(turns)).messages;
      const after = systemInPlace(call(turns + 1)).messages;
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.length).toBeGreaterThan(before.length);
    }
  });

  it('is what LM Studio is sent, and only for a message', async () => {
    const sent: { url: string; body: string }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body) });
      return new Response('{}');
    }) as typeof fetch;
    const local = new LocalModels({ base: 'http://lm', fetch: fetcher });
    await local.send('/v1/messages', JSON.stringify(call(1)), {});
    await local.send('/v1/messages/count_tokens', JSON.stringify(call(1)), {});
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual(systemInPlace(call(1)));
    expect(JSON.parse(sent[1]?.body ?? '')).toEqual(call(1));
  });
});

describe('what the gateway lets through', () => {
  it('refuses a beta it does not know, a server tool, and a field it does not take, before calling anyone', async () => {
    provider.requests.length = 0;
    const { token } = await start();
    const send = (body: unknown, beta = 'interleaved-thinking-2025-05-14') =>
      fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': token, 'anthropic-beta': beta, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const beta = await send(agentRequest(), 'interleaved-thinking-2025-05-14,web-fetch-2025-09-10');
    expect(beta.status).toBe(400);
    expect(await beta.json()).toMatchObject({ error: { message: expect.stringContaining('web-fetch-2025-09-10') } });
    const search = await send({ ...agentRequest(), tools: [{ type: 'web_search_20260209', name: 'web_search' }] });
    expect(search.status).toBe(400);
    expect((await send({ ...agentRequest(), service_tier: 'priority' })).status).toBe(400);
    const bash = await send({ ...agentRequest(), tools: [{ name: 'Bash', input_schema: { type: 'object' } }] });
    expect(bash.status).toBe(200);
    await bash.text();
    expect(provider.requests).toHaveLength(1);
  });

  it('checks the token before it reads the body, and takes a Bearer token as well as a key', async () => {
    const { token } = await start();
    const stranger = await fetch(`${url}/v1/messages`, { method: 'POST', body: 'not json at all' });
    expect(stranger.status).toBe(401);
    const bearer = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(bearer.status).toBe(400);
    expect(await bearer.json()).toMatchObject({ error: { message: 'The body is not JSON.' } });
    const huge = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token },
      body: 'x'.repeat(33 * 1024 * 1024),
    });
    expect(huge.status).toBe(413);
  });
});

describe('what the provider answers', () => {
  it('a whole message, not streamed: relayed, audited and recorded', async () => {
    provider.requests.length = 0;
    const { sql, token } = await start();
    const response = await call(token, { ...agentRequest(), stream: false });
    expect(await response.json()).toMatchObject({ type: 'message', usage: { input_tokens: 10 } });
    const [row] = await sql`select input_tokens, output_tokens, outcome from model_calls`;
    expect(row).toEqual({ input_tokens: 10, output_tokens: 3, outcome: 'answered' });
  });

  it('counts an hour’s cache writes apart, and a delta’s nulls change nothing', async () => {
    const { sql, token } = await start();
    provider.script({
      sse: events(
        [
          'message_start',
          {
            type: 'message_start',
            message: {
              type: 'message',
              usage: {
                input_tokens: 100,
                cache_read_input_tokens: 2000,
                cache_creation_input_tokens: 500,
                cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
                output_tokens: 1,
              },
            },
          },
        ],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: {
              output_tokens: 40,
              input_tokens: null,
              cache_read_input_tokens: null,
              cache_creation_input_tokens: null,
            },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ),
    });
    await (await call(token, agentRequest())).text();
    const [row] =
      await sql`select input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd from model_calls`;
    expect(row).toMatchObject({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 2000,
      cache_write_tokens: 500,
    });
    const usage = {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
      cacheWriteHourTokens: 500,
    };
    expect(Number(row?.cost_usd)).toBeCloseTo(costOf('claude-sonnet-5-5', usage), 8);
  });

  it('a stream that reports an error, or breaks off, is audited at what it cost, and keeps no cassette', async () => {
    const { sql, token } = await start();
    const start_ = [
      'message_start',
      { type: 'message_start', message: { type: 'message', usage: { input_tokens: 300, output_tokens: 1 } } },
    ] as [string, unknown];
    const delta = ['message_delta', { type: 'message_delta', delta: {}, usage: { output_tokens: 25 } }] as [
      string,
      unknown,
    ];
    provider.script({
      sse: events(start_, delta, [
        'error',
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      ]),
    });
    await (await call(token, agentRequest())).text();
    provider.script({ sse: events(start_, delta), drop: true });
    await (await call(token, agentRequest('2026-10-06')).catch(() => undefined))?.text().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = await sql`select outcome, output_tokens, cost_usd from model_calls order by at`;
    expect(rows.map((r) => [r.outcome, r.output_tokens])).toEqual([
      ['failed', 25],
      ['failed', 25],
    ]);
    expect(rows.every((r) => Number(r.cost_usd) > 0)).toBe(true);
    expect(readdirSync(cassettesDir).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('passes a rate limit or an overload through with its retry-after, for the SDK to wait out', async () => {
    const { token } = await start();
    provider.script(
      {
        status: 429,
        body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
        headers: { 'retry-after': '12' },
      },
      { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } },
    );
    const limited = await call(token, agentRequest());
    expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '12']);
    expect((await call(token, agentRequest())).status).toBe(529);
  });
});
