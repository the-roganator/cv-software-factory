/**
 * The line's metrics as an OpenTelemetry SDK collects them: a meter provider installed for this file before the line's
 * modules are loaded, as `telemetry.ts` is before a worker's, and read as each test goes. Vitest gives each file its
 * own globals, and the counters add up across this file's tests, so each test reads what it changed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metrics as api } from '@opentelemetry/api';
import * as metrics from '@opentelemetry/sdk-metrics';
import { type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, nextWorkItem } from '@software-factory/store';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { Handback } from '../../../runner/src/step.ts';
import { LOCAL_MODEL_PACE } from '../../src/line/agents/agent.ts';
import type { Carrying } from '../../src/line/metrics.ts';
import type { LineOptions } from '../../src/line/worker.ts';
import { quiet } from '../github/fake.ts';
import { type Agent, FakeGitHub, FakeProbes, FakeSteps } from './fakes.ts';

const reader = new metrics.PeriodicExportingMetricReader({
  exporter: new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE),
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new metrics.MeterProvider({ readers: [reader] });
api.setGlobalMeterProvider(meterProvider);
// Only now: each module takes its meter as it loads.
const { Line } = await import('../../src/line/worker.ts');
const { endingsIn, limitsFor, observeHolds, observeLeases, observeStages, observeTaken, OPEN_STAGES } = await import(
  '../../src/line/metrics.ts'
);
const { openHolds } = await import('../../src/line/holds.ts');
const { fold } = await import('../../src/line/machine.ts');

afterAll(async () => {
  await meterProvider.shutdown();
  api.disable();
});

let database: Database;
let events: EventWriter;
beforeEach(async () => {
  database = await freshDatabase('line_metrics');
  events = new EventWriter(database.as.line, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
});
afterEach(() => database?.end());

interface Point {
  attributes: Record<string, unknown>;
  value: number;
  count?: number;
}

/** Every point of the metric named, as the reader collects it now: a histogram's with its count. */
async function points(name: string): Promise<Point[]> {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).find((m) => m.descriptor.name === name);
  return (metric?.dataPoints ?? []).map((p) =>
    typeof p.value === 'number'
      ? { attributes: p.attributes, value: p.value }
      : {
          attributes: p.attributes,
          value: (p.value as { sum: number }).sum,
          count: (p.value as { count: number }).count,
        },
  );
}

/** The value at a series, matched on the attributes given, summed across any others: a histogram's count. */
const at = (all: Point[], attributes: Record<string, unknown>) =>
  all
    .filter((p) => Object.entries(attributes).every(([k, v]) => p.attributes[k] === v))
    .reduce((sum, p) => sum + (p.count ?? p.value), 0);

/** What a metric reads at each of the series given, now. */
async function read(name: string, ...series: Record<string, unknown>[]): Promise<number[]> {
  const all = await points(name);
  return series.map((attributes) => at(all, attributes));
}

let now = Date.parse('2026-10-06T09:00:00Z');

const event = <K extends NewEvent['type']>(
  workItem: string | null,
  type: K,
  payload: PayloadOf<K>,
  actor: NewEvent['actor'] = 'factory',
): NewEvent =>
  ({
    id: crypto.randomUUID(),
    ts: new Date(now).toISOString(),
    work_item: workItem,
    type,
    version: VERSIONS[type],
    actor,
    summary: `${type} for the test`,
    payload,
    artifacts: [],
  }) as NewEvent;

/** A ticket as triage opens one, with the probe's signal it was opened on. */
async function ticket(): Promise<string> {
  const workItem = await nextWorkItem(database.as.triage);
  await events.append([
    event(workItem, 'work-item.opened', { kind: 'defect-fix', title: 'Server errors', sample: false }, 'triage'),
    event(
      workItem,
      'ticket.opened',
      {
        title: 'Server errors on /search',
        category: 'errors',
        severity: 'broken',
        fingerprint: { route: '/search', class: 'server-error' },
        traces: [],
      },
      'triage',
    ),
    event(
      workItem,
      'signal.received',
      { sense: 'probe', check: 'search', route: '/search', version: 'v0.9.3' },
      'probe',
    ),
  ]);
  return workItem;
}

const handback = (result: unknown, patch = ''): Handback => ({
  ending: 'finished',
  patch,
  note: 'Escaped the query before it reaches the database.',
  turns: 6,
  session: 'session-1',
  result,
});

const PATCH = `diff --git a/src/search.ts b/src/search.ts
--- a/src/search.ts
+++ b/src/search.ts
@@ -1 +1 @@
-old
+new
diff --git a/test/search.test.ts b/test/search.test.ts
new file mode 100644
--- /dev/null
+++ b/test/search.test.ts
@@ -0,0 +1,2 @@
+it('finds a quote', () => {});
+expect(1).toBe(1);
`;

const SPEC = {
  outcome: 'Search answers a query with a quote in it.',
  criteria: [
    {
      given: 'a query with a quote',
      when: 'it is searched',
      expect: 'the page lists matches',
      from: 'the ticket',
      quote: 'Server errors',
    },
  ],
  scope: ['src/search.ts', 'test/'],
  risks: [],
  rollout: 'Ships as it is.',
};

const AGENTS: Record<string, Agent> = {
  planner: () => handback({ verdict: 'spec', spec: SPEC }),
  coder: () =>
    handback(
      {
        title: 'fix(search): escape the query',
        note: 'Search passed the query to the database as it was. A test searches for a quote; it is escaped now.',
      },
      PATCH,
    ),
  reviewer: () => handback({ verdict: 'approved', note: 'It does what the spec says.', findings: [] }),
  describer: () =>
    handback({
      title: 'fix(search): escape the query',
      body: 'Search escaped nothing, so a quote broke the query.',
      summary: { title: 'Search with a quote', description: 'Fixed.', story: 'The factory fixed search.' },
    }),
};

function line(agents: Partial<Record<string, Agent>> = AGENTS, options: Partial<LineOptions> = {}) {
  const steps = new FakeSteps(database.as.gateway, agents);
  const github = new FakeGitHub();
  const it = new Line({
    sql: database.as.line,
    events,
    steps,
    github,
    log: quiet,
    gatesEveryMs: 0,
    releaseEveryMs: 0,
    me: 'test',
    now: () => new Date(now),
    ...options,
  });
  const pass = async () => {
    await it.tick();
    await it.idle();
  };
  return { line: it, github, pass };
}

/** Moves the line's rows' clock back, as though each had been where it is for `seconds` longer. */
const age = (seconds: number) =>
  database.as.line`update line set moved_at = moved_at - make_interval(secs => ${seconds})`;

/** Every attribute any of the line's series carries. */
async function labels(): Promise<string[]> {
  const { resourceMetrics } = await reader.collect();
  const line = resourceMetrics.scopeMetrics.filter((scope) => scope.scope.name === 'factory-line');
  // But the holds that wait for Martin, a series each: the one stated exception, tested on its own.
  const metrics = line.flatMap((s) => s.metrics).filter((m) => m.descriptor.name !== 'line.hold.age');
  return [...new Set(metrics.flatMap((m) => m.dataPoints.flatMap((p) => Object.keys(p.attributes))))].sort();
}

describe('the line’s metrics', () => {
  it('count each step by agent and how it ended, each hold by cause, each verification, and the time at each stage', async () => {
    const workItem = await ticket();
    const probes = new FakeProbes({ outcome: 'cleared', version: 'v0.9.4', runs: ['passed', 'passed'] });
    const { pass, github } = line(AGENTS, { verify: { probes } });
    // The provider the step's calls went to, as its `model.called` says: the fake runners' calls are local.
    const done = (agent: string) => ({ agent, provider: 'local', outcome: 'done' });
    const before = await read('line.steps', ...['planner', 'coder', 'reviewer', 'describer'].map(done));

    await pass(); // the issue, and the planner
    await age(120); // in Build, before the coder
    await pass(); // the coder
    github.pass();
    await pass(); // the gates pass, and the reviewer
    await pass(); // the describer
    await pass(); // the hold for Martin's merge
    github.merge();
    await pass(); // the merge, and the hold at Release for a deploy to carry it
    const release = { release: '6d8f9c7b54', version: 'v0.9.4', previous: 'v0.9.3', watched: true, dryRun: false };
    const image = { digest: `sha256:${'c'.repeat(64)}`, signed: true, admitted: true };
    await events.append(event(workItem, 'release.started', { ...release, image, steps: null }, 'rollouts'));
    await pass();
    await events.append(event(workItem, 'release.promoted', release, 'rollouts'));
    await pass(); // the probe looks again, and it has cleared
    await pass(); // it closes as verified

    const after = await read('line.steps', ...['planner', 'coder', 'reviewer', 'describer'].map(done));
    expect(after.map((n, i) => n - (before[i] ?? 0))).toEqual([1, 1, 1, 1]);
    expect(
      await read('line.holds', { cause: 'merge', stage: 'review' }, { cause: 'deploy', stage: 'release' }),
    ).toEqual([1, 1]);
    expect(await read('line.verifications', { sense: 'probe', outcome: 'cleared', dry_run: false })).toEqual([1]);
    // Each stage it left, once, Build after the two minutes it was made to wait there; never its end. Held for the
    // merge and then for a deploy is one stay at `held`, as the store has it.
    const stages = await points('line.stage.duration');
    expect(
      ['plan', 'build', 'gates', 'review', 'held', 'release', 'verify'].map((stage) => at(stages, { stage })),
    ).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(stages.find((p) => p.attributes.stage === 'build')?.value).toBeGreaterThanOrEqual(120);
    expect(at(stages, { stage: 'ended' })).toBe(0);
  });

  it('count a step that failed, one out of turns, and the hold for failures', async () => {
    await ticket();
    let tries = 0;
    const { pass } = line({
      planner: () =>
        tries++ === 0 ? 'fails' : { ...handback({ verdict: 'spec', spec: SPEC }), ending: 'max-turns' as const },
    });
    const series = [
      { agent: 'planner', outcome: 'failed' },
      { agent: 'planner', outcome: 'max-turns' },
    ];
    const before = await read('line.steps', ...series);
    const held = (await read('line.holds', { cause: 'failures', stage: 'plan' }))[0] ?? 0;

    await pass(); // the issue, and the planner, which fails
    await pass(); // the planner, which runs out of turns
    await pass(); // the hold

    const after = await read('line.steps', ...series);
    expect(after.map((n, i) => n - (before[i] ?? 0))).toEqual([1, 1]);
    expect(await read('line.holds', { cause: 'failures', stage: 'plan' })).toEqual([held + 1]);
  });

  it('count a step that something outside the agent broke as errored', async () => {
    await ticket();
    const { pass } = line({
      planner: () => {
        throw new Error('The runners could not make the Job.');
      },
    });
    const [before = 0] = await read('line.steps', { agent: 'planner', outcome: 'errored' });
    await pass(); // the issue, and the planner, whose Job is never made
    expect(await read('line.steps', { agent: 'planner', outcome: 'errored' })).toEqual([before + 1]);
  });

  it('count a dry run’s release once as it ends, and its verification by the dry run’s word', async () => {
    const workItem = await nextWorkItem(database.as.triage);
    await events.append([
      event(workItem, 'work-item.opened', { kind: 'defect-fix', title: 'A redirect loop', sample: false }, 'triage'),
      event(
        workItem,
        'ticket.opened',
        {
          title: 'A redirect loop on /departments/:department',
          category: 'errors',
          severity: 'broken',
          fingerprint: { route: '/departments/:department', class: 'redirect-loop' },
          traces: [],
        },
        'triage',
      ),
      event(
        workItem,
        'signal.received',
        { sense: 'probe', check: 'departments', route: '/departments/:department', version: 'v0.9.3' },
        'probe',
      ),
      event(
        workItem,
        'pull-request.pushed',
        {
          number: 1_000_000_001,
          title: 'fix(departments): stop the redirect loop',
          branch: `factory/${workItem}-a-redirect-loop`,
          attempt: 1,
          testsFirst: true,
          files: [{ path: 'src/departments.ts', added: 1, removed: 1 }],
          whole: [{ path: 'src/departments.ts', added: 1, removed: 1 }],
        },
        'coder',
      ),
      event(workItem, 'pull-request.merged', { number: 1_000_000_001, commit: 'd'.repeat(40), by: 'martin' }, 'martin'),
    ]);
    await database.owner`insert into line (work_item, stage, issue) values (${workItem}, 'release', 1000000000)`;
    const { line: it } = line({}, { release: null, dryRun: true, dryRunReleaseMs: 60_000 });
    const series = { outcome: 'promoted', dry_run: true };
    const [promoted = 0] = await read('line.releases', series);
    const [verified = 0] = await read('line.verifications', { sense: 'probe', outcome: 'cleared', dry_run: true });

    for (let minute = 0; minute <= 6; minute++) {
      now += 60_000;
      await it.tick();
      await it.idle();
    }

    expect(await read('line.releases', series)).toEqual([promoted + 1]);
    expect(await read('line.verifications', { sense: 'probe', outcome: 'cleared', dry_run: true })).toEqual([
      verified + 1,
    ]);
  });

  it('count a release’s end once, however many work items it is recorded on', () => {
    const promoted = { release: 'f00dfeed01', dryRun: false };
    expect(
      endingsIn([
        { type: 'release.started', payload: promoted },
        { type: 'release.promoted', payload: promoted },
        { type: 'release.promoted', payload: promoted },
        { type: 'release.rolled-back', payload: { release: 'beefcafe02' } },
      ]),
    ).toEqual([
      { type: 'release.promoted', release: 'f00dfeed01', dryRun: false },
      { type: 'release.rolled-back', release: 'beefcafe02', dryRun: false },
    ]);
  });

  it('read the work items at each stage, and the oldest’s time there, from the store, every stage reported', async () => {
    const [first, second, third] = [await ticket(), await ticket(), await ticket()];
    await database.owner`
      insert into line (work_item, stage, moved_at) values
        (${first}, 'held', clock_timestamp() - interval '2 hours'),
        (${second}, 'held', clock_timestamp() - interval '5 minutes'),
        (${third}, 'ended', clock_timestamp() - interval '3 days')`;
    const stop = observeStages(database.as.line);
    try {
      const counts = await points('line.work_items');
      expect(counts.map((p) => p.attributes.stage).sort()).toEqual([...OPEN_STAGES].sort());
      expect(at(counts, { stage: 'held' })).toBe(2);
      expect(at(counts, { stage: 'plan' })).toBe(0);
      const oldest = await points('line.stage.oldest');
      expect(at(oldest, { stage: 'held' })).toBeGreaterThanOrEqual(7200);
      expect(at(oldest, { stage: 'held' })).toBeLessThan(7300);
      expect(at(oldest, { stage: 'plan' })).toBe(0);
    } finally {
      stop();
    }
    // Once stopped it reads the store no more: the SDK keeps the last figure it had.
    await database.as.line`update line set stage = 'plan'`;
    expect(at(await points('line.work_items'), { stage: 'held' })).toBe(2);
  });

  describe('what the line is carrying', () => {
    const limits = limitsFor(() => 'anthropic', LOCAL_MODEL_PACE.deadline);
    const carrying = (over: Partial<Carrying> = {}): Carrying => ({ only: null, newWork: true, limits, ...over });
    /** The work items carried and the oldest's time at each stage, read now. */
    const read = async (...stages: string[]) => {
      const [items, oldest] = [await points('line.taken.work_items'), await points('line.taken.oldest')];
      return stages.map((stage) => [at(items, { stage }), Math.floor(at(oldest, { stage }) / 60)]);
    };
    const three = async () => {
      const [first, second, third] = [await ticket(), await ticket(), await ticket()];
      await database.owner`
        insert into line (work_item, stage, moved_at) values
          (${first}, 'gates', clock_timestamp() - interval '70 minutes'),
          (${second}, 'build', clock_timestamp() - interval '30 minutes'),
          (${third}, 'ended', clock_timestamp() - interval '3 days')`;
      return [first, second, third] as const;
    };

    it('limit each stage as policy/stuck.ts does, four times longer where its agents run on the local model', () => {
      expect(limits).toEqual({
        plan: 90 * 60,
        build: 120 * 60,
        waiting: null,
        gates: 60 * 60,
        review: 120 * 60,
        release: 60 * 60,
        verify: 25 * 60 * 60,
        held: null,
      });
      // ALL_LOCAL: every step on the local model, and only the stages where steps run take longer.
      expect(limitsFor(() => 'local', LOCAL_MODEL_PACE.deadline)).toEqual({
        ...limits,
        plan: 360 * 60,
        build: 480 * 60,
        review: 480 * 60,
      });
      // One agent sent there: its stage alone.
      expect(
        limitsFor((agent) => (agent === 'describer' ? 'local' : 'anthropic'), LOCAL_MODEL_PACE.deadline).review,
      ).toBe(480 * 60);
    });

    it('report the work items it has taken, by stage, with the oldest’s time and the stage’s limit', async () => {
      await three();
      const stop = observeTaken(database.as.line, () => carrying());
      try {
        expect(await read('gates', 'build', 'plan', 'held')).toEqual([
          [1, 70],
          [1, 30],
          [0, 0],
          [0, 0],
        ]);
        const limit = await points('line.taken.limit');
        expect(limit.map((p) => p.attributes.stage).sort()).toEqual(
          OPEN_STAGES.filter((stage) => limits[stage] !== null).sort(),
        );
        expect(at(limit, { stage: 'gates' })).toBe(3600);
      } finally {
        stop();
      }
    });

    it('report none while the line is stopped, nor a step’s stage while a day’s or month’s cap is reached, and again once not', async () => {
      await three();
      const martin = new EventWriter(database.admin, {
        kind: 'real',
        artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
      });
      const stop = observeTaken(database.as.line, () => carrying());
      try {
        await martin.append([event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin')]);
        expect(await read('gates', 'build')).toEqual([
          [0, 0],
          [0, 0],
        ]);
        await martin.append([event(null, 'line.started', {}, 'martin')]);
        expect(await read('gates', 'build')).toEqual([
          [1, 70],
          [1, 30],
        ]);
        const capped = { cap: 'day' as const, limitUsd: 20, spentUsd: 20, resets: '2026-10-07T00:00:00.000Z' };
        await events.append([event(null, 'spend.capped', capped)]);
        // The gates call no model, and go on under a cap.
        expect(await read('gates', 'build')).toEqual([
          [1, 70],
          [0, 0],
        ]);
        await events.append([event(null, 'spend.cleared', { cap: 'day' })]);
        expect(await read('gates', 'build')).toEqual([
          [1, 70],
          [1, 30],
        ]);
        // A provider's own cap is not the factory's: the line says nothing of it, and its alerts do.
        const provider = {
          cap: 'provider' as const,
          provider: 'anthropic' as const,
          reason: 'credit' as const,
          message: 'No credit.',
        };
        await events.append([event(null, 'spend.capped', provider)]);
        expect(await read('gates', 'build')).toEqual([
          [1, 70],
          [1, 30],
        ]);
      } finally {
        stop();
      }
    });

    it('count no time the line was told to stand: from its last start, and at a step’s stage from a cap cleared', async () => {
      await three();
      const martin = new EventWriter(database.admin, {
        kind: 'real',
        artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
      });
      const stop = observeTaken(database.as.line, () => carrying());
      try {
        // Started again twenty minutes ago, after a stop longer than both work items' time.
        const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
        await martin.append([{ ...event(null, 'line.started', {}, 'martin'), ts: ago(20) }]);
        expect(await read('gates', 'build')).toEqual([
          [1, 20],
          [1, 20],
        ]);
        // A day's cap cleared five minutes ago: the build's time runs from then, the gates' does not.
        await events.append([{ ...event(null, 'spend.cleared', { cap: 'day' }), ts: ago(5) }]);
        expect(await read('gates', 'build')).toEqual([
          [1, 20],
          [1, 5],
        ]);
      } finally {
        stop();
      }
    });

    it('report only the one work item under Just one, and no step’s stage while agents take no new work', async () => {
      const [, build] = await three();
      const stop = observeTaken(database.as.line, () => carrying({ only: build }));
      try {
        expect(await read('gates', 'build')).toEqual([
          [0, 0],
          [1, 30],
        ]);
      } finally {
        stop();
      }
      const again = observeTaken(database.as.line, () => carrying({ newWork: false }));
      try {
        expect(await read('gates', 'build')).toEqual([
          [1, 70],
          [0, 0],
        ]);
      } finally {
        again();
      }
    });

    it('report how long a lease has been held past its expiry, and 0 with none', async () => {
      const [gates, build, ended] = await three();
      const stop = observeLeases(database.as.line);
      try {
        // A work item that has ended needs no lease, and no line takes it back: never paged.
        await database.owner`
          update line set held_by = 'line-gone', held_until = clock_timestamp() - interval '3 hours'
          where work_item = ${ended}`;
        expect(at(await points('line.lease.overrun'), {})).toBe(0);
        await database.owner`
          update line set held_by = 'line-gone', held_until = clock_timestamp() - interval '8 minutes'
          where work_item = ${gates}`;
        await database.owner`
          update line set held_by = 'line-1', held_until = clock_timestamp() + interval '8 minutes'
          where work_item = ${build}`;
        const overrun = at(await points('line.lease.overrun'), {});
        expect(overrun).toBeGreaterThanOrEqual(480);
        expect(overrun).toBeLessThan(540);
      } finally {
        stop();
      }
    });
  });

  it('report the stages while the line runs, every count from 0, and read them no more once it stops', async () => {
    const workItem = await ticket();
    await database.as.line`insert into line (work_item, stage) values (${workItem}, 'review')`;
    // A line for another work item leaves this one where it is; the figures are the whole store's.
    const { line: it } = line({}, { only: 'none' });
    const abort = new AbortController();
    const running = it.run(abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(at(await points('line.work_items'), { stage: 'review' })).toBe(1);
    // Every count from 0 as it starts: a kind nothing in this file counted has its series all the same.
    const aborted = (await points('line.releases')).filter((p) => p.attributes.outcome === 'aborted');
    expect(aborted).toEqual([{ attributes: { outcome: 'aborted', dry_run: false }, value: 0 }]);
    abort.abort();
    await running;
    await database.as.line`update line set stage = 'verify'`;
    const after = await points('line.work_items');
    expect([at(after, { stage: 'review' }), at(after, { stage: 'verify' })]).toEqual([1, 0]);
  });

  it('report each hold that waits for Martin, by work item, cause and pull request, as the line folds it', async () => {
    const hour = 60 * 60_000;
    const started = Date.now() - 3 * hour;
    const at = (ms: number) => {
      now = started + ms;
    };
    const hold = (cause: PayloadOf<'hold.started'>['cause'], stage: PayloadOf<'hold.started'>['stage']) =>
      ({ stage, kind: cause === 'merge' || cause === 'deploy' ? 'approval' : 'held', cause, reason: 'Waits' }) as const;
    const pushed = (number: number) => ({
      number,
      title: 'fix(search): escape the query',
      branch: 'factory/search',
      attempt: 1,
      testsFirst: true,
      files: [{ path: 'src/search.ts', added: 1, removed: 1 }],
      whole: [{ path: 'src/search.ts', added: 1, removed: 1 }],
    });
    const deploy = (state: 'checking' | 'passed') => ({ pullRequest: 30, commit: 'd'.repeat(40), state });
    const [merge, deploying, ready, gates, answered, closed] = [
      await ticket(),
      await ticket(),
      await ticket(),
      await ticket(),
      await ticket(),
      await ticket(),
    ];
    at(0);
    await events.append([
      event(merge, 'pull-request.pushed', pushed(12), 'coder'),
      event(merge, 'hold.started', hold('merge', 'review')),
      event(gates, 'hold.started', hold('gates', 'gates')),
      event(answered, 'hold.started', hold('gates', 'gates')),
      event(closed, 'hold.started', hold('gates', 'gates')),
    ]);
    for (const item of [deploying, ready]) {
      await events.append([
        event(item, 'pull-request.merged', { number: 14, commit: 'c'.repeat(40), by: 'martin' }, 'martin'),
        event(item, 'hold.started', hold('deploy', 'release')),
        event(item, 'deploy.changed', deploy('checking')),
      ]);
    }
    at(hour);
    await events.append([
      // Held again for its merge, as the review gate's word on it changed: the wait is one, from the first.
      event(merge, 'hold.started', hold('merge', 'review')),
      event(ready, 'deploy.changed', deploy('passed')),
      event(closed, 'work-item.closed', { outcome: 'no-change', reason: 'Closed' }, 'martin'),
    ]);
    await new EventWriter(database.admin, {
      kind: 'real',
      artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
    }).append([event(answered, 'hold.answered', { decision: 'approved' }, 'martin')]);

    const stop = observeHolds(database.as.line);
    try {
      const series = (await points('line.hold.age')).map((p) => ({
        ...p.attributes,
        hours: Math.round(p.value / 3600),
      }));
      expect(series).toEqual([
        { work_item: merge, cause: 'merge', pull_request: '12', hours: 3 },
        { work_item: gates, cause: 'gates', hours: 3 },
        // A deploy hold waits for Martin from when its deploy pull request's checks passed; one whose run is not his.
        { work_item: ready, cause: 'deploy', pull_request: '30', hours: 2 },
      ]);
      // The same holds the line's own fold has in force, but the deploy whose checks still run.
      const folded: string[] = [];
      for (const item of [merge, deploying, ready, gates, answered, closed]) {
        const rows = await database.as.line<{ type: string; payload: unknown }[]>`
          select type, payload from events where work_item = ${item} order by seq`;
        const s = fold(rows as never);
        if (s.hold && !s.closed) folded.push(item);
      }
      expect(folded).toEqual([merge, deploying, ready, gates]);
      expect((await openHolds(database.as.line)).map((h) => h.workItem).sort()).toEqual(
        folded.filter((item) => item !== deploying).sort(),
      );

      // Merged, the merge hold is over, and its series ends; the deploy whose checks were running now waits too.
      await events.append([
        event(merge, 'pull-request.merged', { number: 12, commit: 'e'.repeat(40), by: 'martin' }, 'martin'),
        event(deploying, 'deploy.changed', deploy('passed')),
      ]);
      const after = (await points('line.hold.age')).map((p) => [p.attributes.work_item, p.value > 0]);
      expect(after).toEqual([
        [merge, false],
        [gates, true],
        [ready, true],
        [deploying, true],
      ]);
      // The SDK, with the cumulative temporality the counters need, goes on sending the ended series at 0 though the
      // line no longer observes it: an upgrade that drops it instead would show here, and the 0 could then go.
      const again = (await points('line.hold.age')).map((p) => [p.attributes.work_item, p.value > 0]);
      expect(again).toEqual(after);
    } finally {
      stop();
    }
  });

  it('label every series with a closed set, never a work item, a job or a release', async () => {
    // After the tests before it, which made a series of each.
    expect(await labels()).toEqual(['agent', 'cause', 'dry_run', 'outcome', 'provider', 'sense', 'stage']);
  });
});
