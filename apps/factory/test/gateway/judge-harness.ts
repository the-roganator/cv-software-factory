/**
 * Judgements through the gateway, as gateway.test.ts and proofs/spend-caps.gateway.test.ts make them: a stand-in for
 * TypeSafe, and a gateway on a store of its own with a clock the test moves.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { SpendPolicy } from '../../../../policy/spend.ts';
import { Cassettes } from '../../src/gateway/cassettes.ts';
import { Gateway, type Mode } from '../../src/gateway/gateway.ts';
import { Refusals } from '../../src/gateway/refusals.ts';
import { Spend } from '../../src/gateway/spend.ts';
import { TypeSafe } from '../../src/gateway/typesafe.ts';
import { capturingLog, type FakeTypeSafe, fakeTypeSafe } from './helpers.ts';

export let fake: FakeTypeSafe;

/** The stand-in for TypeSafe for a file's tests, its record and the size of its answers reset before each. */
export function withFakeTypeSafe() {
  beforeAll(async () => {
    fake = await fakeTypeSafe();
  });
  afterAll(() => fake.close());
  beforeEach(() => {
    fake.requests.length = 0;
    fake.inputTokens = 300;
  });
}

export const POLICY: SpendPolicy = { dayUsd: 20, monthUsd: 100, workItemUsd: 2 };
// A call of a million input tokens costs $0.042.
export const MILLION = 1_000_000;

export interface Setup {
  mode?: Mode;
  key?: boolean;
  policy?: SpendPolicy | ((fresh: boolean) => Promise<SpendPolicy>);
  clock?: Date;
  read?: string[];
  /** Another harness whose database this one shares, for a test that needs a second gateway: a database each would
   * spend the test's time migrating, one at a time behind every other test file's. */
  on?: { database: Database };
}

/** A gateway on a database of its own, a stand-in provider and a clock the test moves. */
export async function harness({ mode = 'record', key = true, policy = POLICY, clock, read = [], on }: Setup = {}) {
  const database: Database = on?.database ?? (await freshDatabase('gateway'));
  const now = { value: clock ?? new Date('2026-10-03T12:00:00Z') };
  // Each reading is a millisecond later than the last, so rows have an order.
  let tick = 0;
  const time = () => new Date(now.value.getTime() + tick++);
  const captured = capturingLog();
  const dir = mkdtempSync(join(tmpdir(), 'cassettes-'));
  const events = new EventWriter(database.as.gateway, { kind: 'real', artifacts: new DiskArtifacts(dir) });
  const spend = () =>
    new Spend({ sql: database.as.gateway, events, profile: 'local', policy, log: captured.log, clock: time });
  const ledger = spend();
  const typesafe = new TypeSafe({
    apiKey: 'test-key',
    baseUrl: fake.url,
    log: captured.log,
    sleep: async () => {},
    random: () => 0,
  });
  const refusals = new Refusals({ events, log: captured.log, clock: time });
  const gateway = new Gateway({
    sql: database.as.gateway,
    spend: ledger,
    cassettes: new Cassettes({ record: dir, read }),
    mode,
    typesafe: key ? typesafe : undefined,
    log: captured.log,
    clock: time,
    refusals,
  });
  const rows = () =>
    database.owner<{ outcome: string; cost_usd: string; work_item: string | null; cassette: string | null }[]>`
      select outcome, cost_usd, work_item, cassette from model_calls order by at, id`;
  const lineEvents = async () =>
    (
      await database.owner<{ type: string; payload: Record<string, unknown> }[]>`
        select type, payload from events where type like 'spend.%' order by seq`
    ).map((event) => ({ type: event.type, ...event.payload }));
  /** The refusals the gateway recorded, once it has, with the role that appended each. */
  const refused = async () => {
    await refusals.settled();
    return database.owner<{ work_item: string | null; appended_by: string; payload: Record<string, unknown> }[]>`
      select work_item, appended_by, payload from events where type = 'action.refused' order by seq`;
  };
  return {
    database,
    now,
    captured,
    dir,
    events,
    ledger,
    spend,
    gateway,
    rows,
    lineEvents,
    typesafe,
    refusals,
    refused,
  };
}

export const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was meant to fail.');
};
