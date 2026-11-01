import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cassettes, cassetteKey } from '../../src/gateway/cassettes.ts';
import { BadRequest, CassetteMissing, ProviderError } from '../../src/gateway/errors.ts';
import { Gateway } from '../../src/gateway/gateway.ts';
import { PROVIDER, request as typesafeRequest } from '../../src/gateway/typesafe.ts';
import { QUESTIONS, request, SECRET } from './helpers.ts';
import { failure, fake, harness, MILLION, withFakeTypeSafe } from './judge-harness.ts';

// The spend caps' tests, which prove a guardrail, are in proofs/spend-caps.gateway.test.ts, Martin's (CODEOWNERS).
withFakeTypeSafe();

describe('cassettes', () => {
  const sent = typesafeRequest.parse({ model: 'jev-1.13.0', state: 'a', questions: QUESTIONS });

  it('are keyed stably, by provider, model, questions and state', () => {
    const key = cassetteKey(PROVIDER, sent);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cassetteKey(PROVIDER, structuredClone(sent))).toBe(key);
    expect(cassetteKey(PROVIDER, { ...sent, state: 'b' })).not.toBe(key);
    expect(cassetteKey('another', sent)).not.toBe(key);
  });

  it('are keyed by the order of a Choice’s options, since order can change an answer', () => {
    const [first, ...others] = Object.entries(QUESTIONS.category?.type === 'choice' ? QUESTIONS.category.criteria : {});
    const reordered = structuredClone(sent);
    reordered.questions.category = {
      type: 'choice',
      criteria: Object.fromEntries([...others, first ?? ['', null]]),
    };
    const original = structuredClone(sent);
    original.questions.category = { type: 'choice', criteria: Object.fromEntries([first ?? ['', null], ...others]) };
    expect(cassetteKey(PROVIDER, reordered)).not.toBe(cassetteKey(PROVIDER, original));
  });
});

describe('the gateway', () => {
  it('records a cassette, then replays it with the same answers and no call to the provider', async () => {
    const h = await harness({ mode: 'record' });
    const live = await h.gateway.judge(request());
    expect(live.source).toBe('provider');
    expect(live.costUsd).toBeCloseTo((300 * 0.042) / MILLION, 12);
    expect(fake.requests).toHaveLength(1);
    expect(readdirSync(h.dir)).toEqual([`${live.cassette}.json`]);
    const file = JSON.parse(readFileSync(join(h.dir, `${live.cassette}.json`), 'utf-8'));
    expect(Object.keys(file)).toEqual(['key', 'provider', 'model', 'recordedAt', 'request', 'response']);
    expect(file.recordedAt).toMatch(/^2026-10-03T12:00:00\.\d{3}Z$/);

    const replaying = new Gateway({
      sql: h.database.as.gateway,
      spend: h.ledger,
      cassettes: new Cassettes({ read: [h.dir] }),
      mode: 'replay',
      typesafe: h.typesafe,
      log: h.captured.log,
    });
    const replayed = await replaying.judge(request());
    expect(replayed).toMatchObject({ source: 'cassette', costUsd: 0, cassette: live.cassette, model: live.model });
    expect(replayed.answers).toEqual(live.answers);
    expect(replayed.usage).toEqual(live.usage);
    expect(fake.requests).toHaveLength(1);
    expect((await h.rows()).map((row) => [row.outcome, Number(row.cost_usd) > 0])).toEqual([
      ['answered', true],
      ['replayed', false],
    ]);
    await h.database.end();
  });

  it('refuses a replay with no cassette, naming the key', async () => {
    const h = await harness({ mode: 'replay' });
    const error = await failure(h.gateway.judge(request()));
    expect(error).toBeInstanceOf(CassetteMissing);
    const key = cassetteKey(
      PROVIDER,
      typesafeRequest.parse({ model: 'jev-1.13.0', state: request().state, questions: QUESTIONS }),
    );
    expect((error as CassetteMissing).key).toBe(key);
    expect((error as Error).message).toContain(key);
    expect(fake.requests).toHaveLength(0);
    expect((await h.rows()).map((row) => row.outcome)).toEqual(['refused']);
    await h.database.end();
  });

  it('reads cassettes from more than one folder', async () => {
    const recorder = await harness({ mode: 'record' });
    const live = await recorder.gateway.judge(request());
    const h = await harness({ mode: 'replay', read: [recorder.dir], on: recorder });
    expect((await h.gateway.judge(request())).cassette).toBe(live.cassette);
    await recorder.database.end();
  });

  it('falls through to record on a miss in replay-record, and replays the next time', async () => {
    const h = await harness({ mode: 'replay-record' });
    expect((await h.gateway.judge(request())).source).toBe('provider');
    expect((await h.gateway.judge(request())).source).toBe('cassette');
    expect(fake.requests).toHaveLength(1);
    expect(readdirSync(h.dir)).toHaveLength(1);
    await h.database.end();
  });

  it('calls the provider every time in record mode, and records nothing in live mode', async () => {
    const recording = await harness({ mode: 'record' });
    await recording.gateway.judge(request());
    await recording.gateway.judge(request());
    expect(fake.requests).toHaveLength(2);

    const live = await harness({ mode: 'live', on: recording });
    await live.gateway.judge(request());
    expect(fake.requests).toHaveLength(3);
    expect(readdirSync(live.dir)).toEqual([]);
    await recording.database.end();
  });

  it('answers a paid call whose cassette cannot be written, and still reports the cap it reached', async () => {
    fake.inputTokens = MILLION;
    const h = await harness({ mode: 'record', policy: { dayUsd: 0.01, monthUsd: null, workItemUsd: 2 } });
    chmodSync(h.dir, 0o500);
    try {
      const judged = await h.gateway.judge(request());
      expect(judged.source).toBe('provider');
      expect(await h.lineEvents()).toMatchObject([{ type: 'spend.capped', cap: 'day' }]);
      expect(h.captured.text()).toContain('the cassette could not be written');
    } finally {
      chmodSync(h.dir, 0o700);
      await h.database.end();
    }
  });

  it('replays only, and says so once, when it has no key', async () => {
    const h = await harness({ mode: 'record', key: false });
    expect(h.gateway.mode).toBe('replay');
    expect(await failure(h.gateway.judge(request()))).toBeInstanceOf(CassetteMissing);
    await failure(h.gateway.judge(request()));
    expect(h.captured.lines.filter((line) => line.includes('no TYPESAFE_API_KEY'))).toHaveLength(1);
    expect(fake.requests).toHaveLength(0);
    await h.database.end();
  });

  it('replays a cassette it can read, and refuses a damaged one without quoting it', async () => {
    const h = await harness({ mode: 'replay' });
    const key = cassetteKey(
      PROVIDER,
      typesafeRequest.parse({ model: 'jev-1.13.0', state: request().state, questions: QUESTIONS }),
    );
    writeFileSync(join(h.dir, `${key}.json`), `{"state": "${SECRET}`);
    const error = (await failure(h.gateway.judge(request()))) as Error;
    expect(error.message).toContain('damaged');
    expect(error.message).not.toContain(SECRET);
    await h.database.end();
  });

  it('refuses an alias and a model it cannot price, before calling anyone', async () => {
    const h = await harness();
    expect(await failure(h.gateway.judge(request({ model: 'jev-latest' })))).toBeInstanceOf(BadRequest);
    expect(await failure(h.gateway.judge(request({ model: 'jev-9.9.9' })))).toMatchObject({
      message: expect.stringContaining('no price'),
    });
    expect(await failure(h.gateway.judge(request({ questions: {} })))).toBeInstanceOf(BadRequest);
    expect(await failure(h.gateway.judge({ ...request(), agent: 'nobody' } as never))).toBeInstanceOf(BadRequest);
    expect(fake.requests).toHaveLength(0);
    // The last had no agent to name, so it left no row; the others did.
    expect((await h.rows()).map((row) => row.outcome)).toEqual(['refused', 'refused', 'refused']);
    // The model policy refused the first two, as the gateway's own refusals, on no work item; the others asked for
    // nothing the gateway could read. The second is the first's repeat, held until its minute is up or the gateway
    // stops.
    await h.refusals.stop();
    const policy = { mechanism: 'gateway', action: 'A judgement for the triage agent', guardrails: [6] };
    expect(await h.refused()).toEqual([
      {
        work_item: null,
        appended_by: 'factory_gateway',
        payload: {
          ...policy,
          output: 'Model jev-latest is not pinned. Name a version such as jev-1.13.0, never an alias.',
        },
      },
      {
        work_item: null,
        appended_by: 'factory_gateway',
        payload: {
          ...policy,
          output: 'Model jev-9.9.9 has no price in the gateway, so its spend could not be counted.',
        },
      },
    ]);
    await h.database.end();
  });

  it('folds an agent’s refused judgements into one, whatever question set or work item each names', async () => {
    const h = await harness();
    for (const [questionSet, workItem] of [
      ['triage/v1', null],
      ['triage/v2', '1000'],
      ['anything/v9', '1001'],
    ] as const) {
      await failure(h.gateway.judge({ ...request({ model: 'jev-latest', workItem }), questionSet } as never));
    }
    await h.refusals.stop();
    // A caller needs no token to ask for a judgement: what it varies opens no fold of its own.
    expect((await h.refused()).map((row) => row.payload.count ?? 1)).toEqual([1, 2]);
    await h.database.end();
  });

  it('audits a provider failure, and passes it on', async () => {
    const h = await harness();
    fake.script({ status: 422 });
    const error = await failure(h.gateway.judge(request()));
    expect(error).toBeInstanceOf(ProviderError);
    expect((await h.rows()).map((row) => row.outcome)).toEqual(['failed']);
    await h.database.end();
  });

  it('logs and audits every call without its state, its questions or any body', async () => {
    const h = await harness();
    await h.gateway.judge(request({ workItem: '1000' }));
    fake.script({ status: 422 });
    await failure(h.gateway.judge(request({ workItem: '1000' })));
    await failure(h.gateway.judge(request({ model: 'jev-latest' })));

    const logged = h.captured.lines.filter((line) => line.includes('model call')).map((line) => JSON.parse(line));
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatchObject({
      agent: 'triage',
      workItem: '1000',
      provider: 'typesafe',
      model: 'jev-1.13.0',
      questionSet: 'triage/v1',
      inputTokens: 300,
      outputTokens: 12,
      outcome: 'answered',
    });
    expect(logged[0]).toHaveProperty('costUsd');
    expect(logged[0]).toHaveProperty('durationMs');
    expect(logged[0]?.cassette).toMatch(/^[0-9a-f]{64}$/);

    const everything = JSON.stringify([
      h.captured.text(),
      await h.database.owner`select * from model_calls`,
      await h.database.owner`select * from events`,
    ]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('Does the report give instructions');
    expect(everything).not.toContain('Field required');
    await h.database.end();
  });

  it('keeps the audit log append-only, and out of the console’s reach', async () => {
    const h = await harness();
    await h.gateway.judge(request());
    await expect(h.database.owner`update model_calls set cost_usd = 0`).rejects.toThrow(/append-only/);
    await expect(h.database.owner`delete from model_calls`).rejects.toThrow(/append-only/);
    await expect(h.database.owner`truncate model_calls`).rejects.toThrow(/append-only/);
    await expect(h.database.reader`select * from model_calls`).rejects.toThrow(/permission denied/);
    await h.database.end();
  });
});
