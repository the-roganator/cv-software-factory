/**
 * Whether auto-rollback is on, as the line reads it from the store (line/auto-rollback.ts), collected as an
 * OpenTelemetry SDK collects it: a meter provider is installed for this file before the module loads.
 */
import { metrics as api } from '@opentelemetry/api';
import * as metrics from '@opentelemetry/sdk-metrics';
import { VERSIONS } from '@software-factory/events';
import pino from 'pino';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';

const reader = new metrics.PeriodicExportingMetricReader({
  exporter: new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE),
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new metrics.MeterProvider({ readers: [reader] });
api.setGlobalMeterProvider(meterProvider);
const { observeAutoRollback } = await import('../../src/line/auto-rollback.ts');

afterAll(async () => {
  await meterProvider.shutdown();
  api.disable();
});

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('line_auto_rollback');
});
afterEach(() => database?.end());

/** The series as the SDK collects it now. */
async function autoRollback(sql: Sql): Promise<number | undefined> {
  const stop = observeAutoRollback(sql, pino({ level: 'silent' }));
  try {
    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((m) => m.descriptor.name === 'line.auto_rollback');
    return metric?.dataPoints.at(-1)?.value as number | undefined;
  } finally {
    stop();
  }
}

/** A switch as Martin's command line's role stores it. */
const stored = (autoRollback: boolean) =>
  database.operator`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
    values (${crypto.randomUUID()}, now(), null, 'controls.changed', ${VERSIONS['controls.changed']}, 'martin',
            'controls.changed', ${database.operator.json({
              autonomy: 'supervised',
              newWork: true,
              take: null,
              autoRollback,
              change: { control: 'auto-rollback', before: !autoRollback, after: autoRollback },
            })}, '[]', '{}', false)`;

/** A store that cannot be read. */
const unreachable = (() => {
  throw new Error('the store is down');
}) as unknown as Sql;

describe('the line’s series of whether auto-rollback is on', () => {
  it('says on before any switch, and Martin’s latest switch after', async () => {
    expect(await autoRollback(database.as.line)).toBe(1);
    await stored(false);
    expect(await autoRollback(database.as.line)).toBe(0);
    await stored(true);
    expect(await autoRollback(database.as.line)).toBe(1);
  });

  it('says on when it cannot read the store, so a word of off it read before is not sent on', async () => {
    await stored(false);
    expect(await autoRollback(database.as.line)).toBe(0);
    expect(await autoRollback(unreachable)).toBe(1);
  });

  it('reads Martin’s latest switch of a version newer than it knows as it stands, not the one before it', async () => {
    await stored(false);
    await database.operator`
      insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
      values (${crypto.randomUUID()}, now(), null, 'controls.changed', ${VERSIONS['controls.changed'] + 1}, 'martin',
              'controls.changed', ${database.operator.json({ autoRollback: true, newer: { anything: 1 } })}, '[]', '{}',
              false)`;
    expect(await autoRollback(database.as.line)).toBe(1);
  });
});
