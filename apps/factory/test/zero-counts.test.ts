/**
 * Each count starts at 0 for every label set it can count from closed sets, and the zeros are sent before anything
 * is counted: Prometheus's `increase` and `changes` read nothing into a series' first sample, so a series that started
 * at 1 would lose the first of each kind after every restart. A meter provider is installed for this file before the
 * modules are loaded, as `telemetry.ts` is before a worker's, and nothing here counts anything but the zeros.
 */
import { metrics as api } from '@opentelemetry/api';
import * as metrics from '@opentelemetry/sdk-metrics';
import { HOLD_CAUSES, SENSES, SIGNAL_SOURCES } from '@software-factory/events';
import type { Sql } from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

const exporter = new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE);
const reader = new metrics.PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
const meterProvider = new metrics.MeterProvider({ readers: [reader] });
api.setGlobalMeterProvider(meterProvider);
// Only now: each module takes its meter as it loads.
const line = await import('../src/line/metrics.ts');
const gateway = await import('../src/gateway/metrics.ts');
const { routes } = await import('../src/gateway/agents.ts');
const { inbox } = await import('../src/outbox.ts');
const { zeroTriaged } = await import('../src/commands/triage.ts');
const { sendCounts } = await import('../src/counts.ts');

afterAll(async () => {
  await meterProvider.shutdown();
  api.disable();
});

type Attributes = Record<string, unknown>;

/** Every point of the metric named, as the reader collects it now. */
async function points(name: string): Promise<{ attributes: Attributes; value: number }[]> {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).find((m) => m.descriptor.name === name);
  return (metric?.dataPoints ?? []).map((p) => ({ attributes: p.attributes, value: p.value as number }));
}

/** The label sets of a metric's points, each as one sorted string, after checking every point is 0. */
async function zeros(name: string): Promise<string[]> {
  const all = await points(name);
  expect(all.map((p) => p.value).filter((value) => value !== 0)).toEqual([]);
  return all.map((p) => key(p.attributes)).sort();
}

const key = (attributes: object) =>
  Object.entries(attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(',');

/** Every combination of the values given, as label sets. */
function product(sets: Record<string, readonly unknown[]>): string[] {
  let combos: Attributes[] = [{}];
  for (const [label, values] of Object.entries(sets)) {
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [label]: value })));
  }
  return combos.map(key).sort();
}

const AGENTS = ['planner', 'coder', 'reviewer', 'describer'];
const ENDINGS = ['done', 'failed', 'max-turns', 'capped', 'stopped', 'held', 'stale', 'effects-failed', 'errored'];
const RELEASES = ['promoted', 'rolled-back', 'aborted', 'errored'];

describe('the counts', () => {
  it('start at 0 for each label set the line can count, a dry run’s only on a dry run', async () => {
    line.zeroCounts({ providerOf: (agent) => (agent === 'coder' ? 'local' : 'anthropic'), dryRun: false });
    const steps = await zeros('line.steps');
    expect(steps).toHaveLength(36);
    expect(steps).toEqual(
      [
        ...product({ agent: ['planner', 'reviewer', 'describer'], outcome: ENDINGS, provider: ['anthropic'] }),
        ...product({ agent: ['coder'], outcome: ENDINGS, provider: ['local'] }),
      ].sort(),
    );
    // The holds the line starts, at each stage from Plan on: triage's are triage's to count.
    const theLines = HOLD_CAUSES.filter(
      (c) => !['suggestion', 'finding', 'burst', 'environment', 'unknown'].includes(c),
    );
    const stages = ['plan', 'build', 'gates', 'review', 'release', 'verify'];
    expect(await zeros('line.holds')).toEqual(product({ cause: theLines, stage: stages }));
    expect(await zeros('line.releases')).toEqual(product({ dry_run: [false], outcome: RELEASES }));
    expect(await zeros('line.verifications')).toEqual(
      product({ dry_run: [false], outcome: ['cleared', 'persists'], sense: [...SENSES, 'unknown'] }),
    );

    line.zeroCounts({ providerOf: () => 'anthropic', dryRun: true });
    expect(await zeros('line.releases')).toEqual(product({ dry_run: [false, true], outcome: RELEASES }));
    expect(await zeros('line.verifications')).toHaveLength((SENSES.length + 1) * 2 * 2);
  });

  it('start at 0 for each route the gateway may send calls on, and triage’s judgements', async () => {
    const messages = routes('local', false);
    // Every model an agent may be given on the profile, the local one among them.
    const models = [
      'local qwen/qwen3.8-27b',
      'anthropic claude-haiku-5-5',
      'anthropic claude-sonnet-5-5',
      'anthropic claude-opus-5-5',
    ];
    expect(messages.map((r) => `${r.agent} ${r.provider} ${r.model}`)).toEqual(
      AGENTS.flatMap((agent) => models.map((model) => `${agent} ${model}`)),
    );
    expect(routes('local', true).map((r) => `${r.provider} ${r.model}`)).toEqual(
      AGENTS.map(() => 'local qwen/qwen3.8-27b'),
    );
    const judgement = { agent: 'triage', provider: 'typesafe', model: 'jev-1.13.0' };
    gateway.zeroCounts(messages, [judgement]);

    const every = [...messages, judgement];
    expect(await zeros('gateway.calls')).toEqual(
      every
        .flatMap((route) => ['answered', 'replayed', 'refused', 'failed'].map((outcome) => key({ ...route, outcome })))
        .sort(),
    );
    expect(await zeros('factory_gateway_spend_usd')).toEqual(every.map(key).sort());
    const tokens = await zeros('gateway.tokens');
    // An agent's on each of its four models: three outcomes that use tokens, four kinds; a judgement's: answered or
    // replayed, input or output.
    expect(tokens).toHaveLength(4 * 4 * 3 * 4 + 2 * 2);
    expect(tokens.filter((t) => t.includes('agent=triage'))).toEqual(
      product({
        agent: ['triage'],
        kind: ['input', 'output'],
        model: ['jev-1.13.0'],
        outcome: ['answered', 'replayed'],
        provider: ['typesafe'],
      }),
    );
    expect(tokens.filter((t) => t.includes('outcome=refused'))).toEqual([]);
    const errors = await zeros('gateway.provider.errors');
    const sonnet = (e: string) => e.includes('agent=coder') && e.includes('model=claude-sonnet-5-5');
    expect(errors.filter(sonnet).map((e) => /status=([^,]+)/.exec(e)?.[1])).toEqual(
      ['broken', 'malformed', 'network', 'timeout'].sort(),
    );
    expect(errors.filter((e) => e.includes('agent=triage')).map((e) => /status=([^,]+)/.exec(e)?.[1])).toEqual(
      ['malformed', 'network', 'timeout'].sort(),
    );
    const refusals = await zeros('gateway.cap.refusals');
    expect(refusals).toHaveLength(4 * 4 * 4 + 3);
    expect(refusals.filter((r) => r.includes('agent=triage') && r.includes('cap=provider'))).toEqual([]);
  });

  it('start at 0 for each source and outcome triage counts, and each sense an inbox is opened for', async () => {
    const triaged = api.getMeter('factory-triage').createCounter('factory.triage.signals');
    zeroTriaged(triaged);
    const outcomes = ['opened', 'evidence', 'counted', 'report', 'finding', 'reopened', 'held'];
    expect(await zeros('factory.triage.signals')).toEqual(product({ outcome: outcomes, sense: SIGNAL_SOURCES }));

    // Only the senses a process sends for: the log watcher's two.
    inbox({} as Sql, 'logs', 'report');
    expect(await zeros('factory_signals')).toEqual(product({ sense: ['logs', 'report'] }));
  });

  it('send the zeros before anything is counted, so Prometheus’s first sample of each is 0', async () => {
    exporter.reset();
    line.zeroCounts({ providerOf: () => 'anthropic', dryRun: false });
    await sendCounts();
    line.countStep('coder', 'anthropic', 'max-turns');
    await sendCounts();

    const exported = exporter
      .getMetrics()
      .map((batch) =>
        batch.scopeMetrics
          .flatMap((scope) => scope.metrics)
          .find((m) => m.descriptor.name === 'line.steps')
          ?.dataPoints.find(
            (p) =>
              p.attributes.agent === 'coder' &&
              p.attributes.provider === 'anthropic' &&
              p.attributes.outcome === 'max-turns',
          ),
      )
      .map((point) => point?.value);
    expect(exported).toEqual([0, 1]);
  });

  /**
   * Waiting for nothing is shown by order, not by the clock: with the timers held, so that no timeout can ever fire,
   * the send has settled by the next turn of the event loop. A send that waited on its timeout, or on a flush that
   * goes out to a collector, would still be pending then. `setImmediate` stays real: held too, the turn would never
   * come and the test would time out rather than fail.
   */
  it('send nothing, and wait for nothing, with no SDK started', async () => {
    exporter.reset();
    api.disable();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const sent = sendCounts().then(() => {
        settled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      await sent;
      expect(exporter.getMetrics()).toEqual([]);
    } finally {
      vi.useRealTimers();
      api.setGlobalMeterProvider(meterProvider);
    }
  });
});
