/**
 * Proves `ci:spend-caps` (policy/guardrails.ts, spec 6 guardrail 7): the gateway's tests of its caps, the day's, the
 * month's and a work item's, on the judgements it makes and on the agents' calls. Martin's (CODEOWNERS), as every file
 * here is: a change to what they assert is a change to the proof.
 */
import { describe, expect, it } from 'vitest';
import { Cassettes } from '../../src/gateway/cassettes.ts';
import { SpendCapped } from '../../src/gateway/errors.ts';
import { Gateway } from '../../src/gateway/gateway.ts';
import { ProviderCaps } from '../../src/gateway/provider-caps.ts';
import { ProviderRefusal } from '../../src/gateway/providers.ts';
import { agentRequest, call, database, start, withAgentGateway } from '../gateway/agents-harness.ts';
import { request } from '../gateway/helpers.ts';
import { failure, fake, harness, MILLION, withFakeTypeSafe } from '../gateway/judge-harness.ts';
import { appendSettings, settingsPayload } from '../settings-events.ts';

withFakeTypeSafe();
withAgentGateway();

describe('spend caps', () => {
  const day = (hours = 12) => new Date(Date.UTC(2026, 9, 3, hours));

  it('refuses at the day cap, tells the line once, and clears when the day ends', async () => {
    const h = await harness({ policy: { dayUsd: 0.04, monthUsd: null, workItemUsd: 2 }, clock: day() });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    // That call cost $0.042, which reaches the cap.
    for (const _ of [1, 2]) {
      const error = await failure(h.gateway.judge(request()));
      expect(error).toBeInstanceOf(SpendCapped);
      expect(error).toMatchObject({ cap: 'day', limitUsd: 0.04, resets: '2026-10-04T00:00:00.000Z' });
      expect((error as Error).message).toContain('2026-10-04T00:00:00.000Z');
    }
    expect(fake.requests).toHaveLength(1);
    expect(await h.lineEvents()).toEqual([
      { type: 'spend.capped', cap: 'day', limitUsd: 0.04, spentUsd: 0.042, resets: '2026-10-04T00:00:00.000Z' },
    ]);
    // The first refusal at once; its repeat waits for its minute to fold.
    expect(await h.refused()).toEqual([
      {
        work_item: null,
        appended_by: 'factory_gateway',
        payload: {
          mechanism: 'gateway',
          action: 'A judgement for the triage agent',
          output: 'The day spend cap of $0.04 has been reached ($0.04 spent); it resets at 2026-10-04T00:00:00.000Z.',
          guardrails: [7],
        },
      },
    ]);
    expect((await h.rows()).map((row) => row.outcome)).toEqual(['answered', 'refused', 'refused']);

    // Still the same day: nothing to clear.
    h.now.value = day(23);
    await h.ledger.reconcile();
    expect(await h.lineEvents()).toHaveLength(1);

    h.now.value = new Date('2026-10-04T00:00:01Z');
    await h.ledger.reconcile();
    await h.ledger.reconcile();
    expect(await h.lineEvents()).toEqual([
      expect.objectContaining({ type: 'spend.capped' }),
      { type: 'spend.cleared', cap: 'day' },
    ]);
    expect((await h.gateway.judge(request())).source).toBe('provider');
    await h.database.end();
  });

  it('reads the caps in force at each call, and clears the day’s cap once it is raised past the spend', async () => {
    const caps = { dayUsd: 0.04, monthUsd: null, workItemUsd: 2 };
    const h = await harness({ policy: async () => caps, clock: day() });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    expect(await failure(h.gateway.judge(request()))).toMatchObject({ cap: 'day', limitUsd: 0.04 });
    // Martin raises the day's cap: the next call goes ahead, and the line hears the cap has cleared.
    caps.dayUsd = 25;
    expect((await h.gateway.judge(request())).source).toBe('provider');
    await h.ledger.reconcile();
    expect((await h.lineEvents()).map((event) => event.type)).toEqual(['spend.capped', 'spend.cleared']);
    expect((await h.ledger.report()).day.limitUsd).toBe(25);
    await h.database.end();
  });

  it('reads the caps afresh before it refuses, so a cap raised a moment ago refuses nothing', async () => {
    // The caps a few seconds old say $0.04 a day; those in force this moment, $25.
    const h = await harness({
      policy: async (fresh) => ({ dayUsd: fresh ? 25 : 0.04, monthUsd: null, workItemUsd: 2 }),
      clock: day(),
    });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    expect((await h.gateway.judge(request())).source).toBe('provider');
    expect(await h.lineEvents()).toEqual([]);
    await h.database.end();
  });

  it('refuses at the month cap, naming when the month ends', async () => {
    const h = await harness({ policy: { dayUsd: 100, monthUsd: 0.05, workItemUsd: 2 }, clock: day() });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    h.now.value = new Date('2026-10-20T09:00:00Z');
    await h.gateway.judge(request());
    const error = await failure(h.gateway.judge(request()));
    expect(error).toMatchObject({ cap: 'month', limitUsd: 0.05, resets: '2026-11-01T00:00:00.000Z' });
    expect(await h.lineEvents()).toEqual([
      expect.objectContaining({ type: 'spend.capped', cap: 'month', resets: '2026-11-01T00:00:00.000Z' }),
    ]);
    h.now.value = new Date('2026-11-01T00:00:00Z');
    await h.ledger.reconcile();
    expect((await h.lineEvents()).at(-1)).toEqual({ type: 'spend.cleared', cap: 'month' });
    await h.database.end();
  });

  it('refuses at a work item’s cap, with no line event, and leaves other work items alone', async () => {
    const h = await harness({ policy: { dayUsd: 100, monthUsd: null, workItemUsd: 0.04 } });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request({ workItem: '1000' }));
    const error = await failure(h.gateway.judge(request({ workItem: '1000' })));
    expect(error).toBeInstanceOf(SpendCapped);
    expect(error).toMatchObject({ cap: 'work-item', limitUsd: 0.04, resets: null });
    // On no work item, since no job token names one: the work item is only the request's word.
    expect((await h.refused()).map((row) => [row.work_item, row.payload.action, row.payload.guardrails])).toEqual([
      [null, 'A judgement for the triage agent', [7]],
    ]);
    expect((await h.gateway.judge(request({ workItem: '1001' }))).source).toBe('provider');
    expect((await h.gateway.judge(request({ workItem: null }))).source).toBe('provider');
    expect(await h.lineEvents()).toEqual([]);
    await h.database.end();
  });

  it('costs nothing to replay, and a cap does not stop one', async () => {
    const h = await harness({ policy: { dayUsd: 0.04, monthUsd: null, workItemUsd: 2 } });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    const capped = await failure(h.gateway.judge(request({ state: 'something new' })));
    expect(capped).toBeInstanceOf(SpendCapped);
    const replaying = new Gateway({
      sql: h.database.as.gateway,
      spend: h.ledger,
      cassettes: new Cassettes({ read: [h.dir] }),
      mode: 'replay-record',
      typesafe: h.typesafe,
      log: h.captured.log,
      clock: () => h.now.value,
    });
    const replayed = await replaying.judge(request());
    expect(replayed).toMatchObject({ source: 'cassette', costUsd: 0 });
    const report = await h.ledger.report();
    expect(report.day.spentUsd).toBeCloseTo(0.042, 9);
    await h.database.end();
  });

  it('remembers what the line was told across a restart, and clears what has since ended', async () => {
    const h = await harness({ policy: { dayUsd: 0.04, monthUsd: null, workItemUsd: 2 }, clock: day() });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    expect(await h.lineEvents()).toHaveLength(1);

    const sameDay = h.spend();
    await sameDay.resume();
    expect(await h.lineEvents()).toHaveLength(1);
    expect((await sameDay.report()).capped).toEqual(['day']);

    h.now.value = new Date('2026-10-05T00:00:00Z');
    const nextDay = h.spend();
    await nextDay.resume();
    expect((await h.lineEvents()).map((event) => event.type)).toEqual(['spend.capped', 'spend.cleared']);
    expect((await nextDay.report()).capped).toEqual([]);
    await h.database.end();
  });

  it('leaves a provider’s cap to the provider’s caps across a restart', async () => {
    const h = await harness({ clock: day() });
    const caps = new ProviderCaps({
      sql: h.database.as.gateway,
      events: h.events,
      log: h.captured.log,
      probe: async () => false,
    });
    await caps.cap('local', new ProviderRefusal('unreachable', 'connect ECONNREFUSED 127.0.0.1:1234'));

    const restarted = h.spend();
    await restarted.resume();
    await restarted.reconcile();
    expect(await h.lineEvents()).toEqual([expect.objectContaining({ type: 'spend.capped', cap: 'provider' })]);
    expect((await restarted.report()).capped).toEqual([]);
    expect(h.captured.text()).not.toContain('could not update the line on spend caps');
    await h.database.end();
  });

  it('reports spend against the caps', async () => {
    const h = await harness({ clock: day() });
    fake.inputTokens = MILLION;
    await h.gateway.judge(request());
    expect(await h.ledger.report()).toEqual({
      profile: 'local',
      day: { spentUsd: 0.042, limitUsd: 20, resets: '2026-10-04T00:00:00.000Z' },
      month: { spentUsd: 0.042, limitUsd: 100, resets: '2026-11-01T00:00:00.000Z' },
      workItemLimitUsd: 2,
      capped: [],
    });
    await h.database.end();
  });
});

describe('spend caps on an agent’s calls', () => {
  it('holds a work item at its cap, and does not retry it', async () => {
    const { sql, token } = await start({ policy: { dayUsd: 20, monthUsd: null, workItemUsd: 0.001 } });
    await (await call(token, agentRequest())).text();
    const response = await call(token, { ...agentRequest(), messages: [{ role: 'user', content: 'More.' }] });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { type: 'permission_error', message: expect.stringMatching(/work-item spend cap/) },
    });
    expect((await sql`select outcome from model_calls order by at`).map((r) => r.outcome)).toEqual([
      'answered',
      'refused',
    ]);
  });

  it('refuses calls at the caps Martin set, and holds to policy’s where what he set is outside it', async () => {
    const { token } = await start({ settings: true });
    await appendSettings(database.admin, settingsPayload({ caps: { workItemUsd: 0.001 } }));
    await (await call(token, agentRequest())).text();
    const more = { ...agentRequest(), messages: [{ role: 'user', content: 'More.' }] };
    expect((await call(token, more)).status).toBe(403);
    // Zero is never no cap, nor is a figure past the ceiling: policy's $1 is in force, which the call is well under.
    await appendSettings(database.operator, settingsPayload({ caps: { workItemUsd: 0 } }));
    const allowed = await call(token, more);
    expect(allowed.status).toBe(200);
    await allowed.text();
    await appendSettings(database.operator, settingsPayload({ caps: { dayUsd: 0.000001, workItemUsd: 1e6 } }));
    const capped = await call(token, { ...more, messages: [{ role: 'user', content: 'Again.' }] });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ error: { message: expect.stringMatching(/day/) } });
  });
});
