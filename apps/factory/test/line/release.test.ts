import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InboxSignal, type NewEvent, type PayloadOf, type Screenshot, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, nextWorkItem } from '@software-factory/store';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { setTake, startLine } from '../../../../packages/store/test/line.ts';
import { Prometheus } from '../../src/clients/prometheus.ts';
import { GitHubWorkerError } from '../../src/github/worker-client.ts';
import { Line, type LineOptions } from '../../src/line/worker.ts';
import { IndexedArtifacts, type Picture, PictureIndex, type Shot } from '../../src/pictures/index.ts';
import type { AnalysisRun, Rollout } from '../../src/release/rollout.ts';
import { JOURNEY_FALLBACK } from '../../src/release/signals.ts';
import type { Kube } from '../../src/runners/kube.ts';
import { quiet } from '../github/fake.ts';
import { CANARY, commitOf, digestOf, releaseOf, rollout, run, STABLE } from '../release/fixtures.ts';
import { recordSpans } from '../tracing.ts';
import { FakeGitHub, FakeProbes, FakeSteps } from './fakes.ts';

const { spans } = recordSpans();
let database: Database;
let events: EventWriter;
/** Martin's commands, from the admin service's role: only his roles may append them. */
let martin: EventWriter;
beforeEach(async () => {
  database = await freshDatabase('release');
  events = new EventWriter(database.as.line, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
  martin = new EventWriter(database.admin, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
  await startLine(database.admin);
});
afterEach(() => database?.end());

let now = Date.parse('2026-10-11T09:00:00Z');

const event = <K extends NewEvent['type']>(
  workItem: string | null,
  type: K,
  payload: PayloadOf<K>,
  actor: NewEvent['actor'],
) =>
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

/** The coder's push of pull request `number`. */
const pushed = (workItem: string, number: number) =>
  event(
    workItem,
    'pull-request.pushed',
    {
      number,
      title: 'fix(departments): stop the redirect loop',
      branch: `factory/${workItem}-a-redirect-loop`,
      attempt: 1,
      testsFirst: true,
      files: [{ path: 'src/departments.ts', added: 1, removed: 1 }],
      whole: [{ path: 'src/departments.ts', added: 1, removed: 1 }],
    },
    'coder',
  );

/** A ticket's first events, as triage appends them: its signal came from `sense`. */
async function opened(sense: 'probe' | 'report' | 'canary' | 'logs' = 'probe'): Promise<string> {
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
      {
        sense,
        check: sense === 'canary' ? 'latency' : sense === 'logs' ? 'requests in the log' : 'departments',
        route: '/departments/:department',
        version: commitOf(STABLE),
        ...(sense === 'logs' ? { symptom: 'missing-log' } : {}),
      },
      sense === 'report' ? 'widget' : sense,
    ),
  ]);
  return workItem;
}

/**
 * A work item whose fix merged in pull request `number`, as `commit`, and which the line holds at Release. Its ticket
 * came from a probe, which the line here has no way to ask at Verify: there it waits. A dry run's, from a billion up,
 * was pushed as the dry run's too, with an issue GitHub never had.
 */
async function merged(
  number: number,
  commit: string,
  sense: 'probe' | 'report' | 'canary' | 'logs' = 'probe',
): Promise<string> {
  const workItem = await opened(sense);
  await events.append([
    ...(number >= 1_000_000_000 ? [pushed(workItem, number)] : []),
    event(workItem, 'pull-request.merged', { number, commit, by: 'martin' }, 'martin'),
  ]);
  await database.owner`insert into line (work_item, stage, issue) values (${workItem}, 'release', ${number - 1})`;
  return workItem;
}

/** The Kubernetes API, holding the app's Rollout and its runs, and counting what is asked of it. */
class FakeKube implements Kube {
  rollout: Rollout | undefined;
  runs: AnalysisRun[] = [];
  /** Each journeys Job's termination message, by the Job's name. */
  readonly messages = new Map<string, string | null>();
  readonly asked: string[] = [];

  async get<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    this.asked.push(path);
    const pods = path.match(/^\/api\/v1\/namespaces\/website\/pods\?labelSelector=job-name%3D(.+)$/);
    if (pods?.[1]) {
      // null: the pod is there, and its container has not ended; 'pending': the pod is there, its container has no
      // status yet.
      const message = this.messages.get(decodeURIComponent(pods[1]));
      const state = message === null ? { running: {} } : { terminated: { message } };
      const statuses = message === 'pending' ? [] : [{ name: 'journeys', state }];
      const items = message === undefined ? [] : [{ status: { containerStatuses: statuses } }];
      return schema.parse({ items });
    }
    if (path === '/apis/argoproj.io/v1alpha1/namespaces/website/rollouts/website') {
      return this.rollout && schema.parse(this.rollout);
    }
    if (path === '/apis/argoproj.io/v1alpha1/namespaces/website/analysisruns') {
      return schema.parse({ items: this.runs });
    }
    throw new Error(`The line may not read ${path}`);
  }

  async text(path: string): Promise<string | undefined> {
    throw new Error(`The line may not read ${path}`);
  }

  async create(): Promise<void> {
    throw new Error('The release watch changes nothing');
  }

  async remove(): Promise<void> {
    throw new Error('The release watch changes nothing');
  }
}

/**
 * Prometheus, answering each version's figures by its hash: the canary a little slower, with a few more errors. A
 * range is the same figure at every step.
 */
function prometheus(asked: string[] = [], failing = false) {
  // By route, the canary is slower on /search alone, and has more errors on /search and /cart.
  const byRoute = (query: string): Record<string, number> => {
    const canary = query.includes(CANARY);
    if (query.includes('histogram_quantile')) {
      return canary ? { '/search': 0.62, '/cart': 0.13 } : { '/search': 0.12, '/cart': 0.12 };
    }
    if (query.includes('5..')) return canary ? { '/search': 9, '/cart': 4 } : { '/search': 1, '/cart': 0 };
    return canary ? { '/search': 60, '/cart': 40, '/about': 0 } : { '/search': 200, '/cart': 150 };
  };
  const figure = (query: string) => {
    const canary = query.includes(CANARY);
    if (query.includes('histogram_quantile')) return canary ? 0.124 : 0.118;
    if (query.includes('5..')) return canary ? 0.004 : 0.002;
    return canary ? 224.4 : 640;
  };
  return new Prometheus('http://prometheus.test', async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get('query') ?? '';
    asked.push(url.pathname);
    if (failing) return new Response('down', { status: 503 });
    if (url.pathname === '/api/v1/query' && query.includes('http_route)')) {
      const result = Object.entries(byRoute(query)).map(([route, value]) => ({
        metric: { http_route: route },
        value: [0, String(value)],
      }));
      return Response.json({ data: { result } });
    }
    if (url.pathname === '/api/v1/query') {
      return Response.json({ data: { result: [{ metric: {}, value: [0, String(figure(query))] }] } });
    }
    const start = Number(url.searchParams.get('start'));
    const end = Number(url.searchParams.get('end'));
    const step = Number(url.searchParams.get('step'));
    const values: [number, string][] = [];
    for (let at = start; at <= end; at += step) values.push([at, String(figure(query))]);
    return Response.json({ data: { result: [{ metric: {}, values }] } });
  });
}

function line(options: Partial<LineOptions> = {}, { prometheusDown = false } = {}) {
  const github = new FakeGitHub();
  const kube = new FakeKube();
  const asked: string[] = [];
  const it = new Line({
    sql: database.as.line,
    events,
    steps: new FakeSteps(database.as.gateway, {}),
    github,
    log: quiet,
    me: 'test',
    now: () => new Date(now),
    gatesEveryMs: 60_000,
    deployEveryMs: 60_000,
    releaseEveryMs: 0,
    release: {
      kube,
      rollout: { namespace: 'website', name: 'website' },
      prometheus: prometheus(asked, prometheusDown),
    },
    ...options,
  });
  return { line: it, github, kube, asked };
}

/** The release's events on a work item, but for the background analysis's looks, which tests read on their own. */
const typesOf = async (workItem: string | null) =>
  (
    await database.as.line<{ type: string; actor: string }[]>`
      select type, actor from events
      where work_item is not distinct from ${workItem}
        and type in ('release.started', 'canary.stepped', 'release.promoted', 'release.rolled-back', 'release.aborted',
          'release.errored')
      order by seq`
  ).map((r) => `${r.type} by ${r.actor}`);

const payloads = async <K extends NewEvent['type']>(workItem: string | null, type: K) =>
  (
    await database.as.line<{ payload: PayloadOf<K> }[]>`
      select payload from events where work_item is not distinct from ${workItem} and type = ${type} order by seq`
  ).map((r) => r.payload);

const stage = async (workItem: string) =>
  (await database.as.line<{ stage: string }[]>`select stage from line where work_item = ${workItem}`)[0]?.stage;

/** The app's main: the commits of two fixes, the stable version's, a later fix's, and a release's. */
const [FIX_1, FIX_2, FIX_3, FIX_4] = ['1', '2', '3', '4'].map((c) => c.repeat(40)) as [string, string, string, string];
const HISTORY = ['0'.repeat(40), FIX_1, FIX_2, commitOf(STABLE), FIX_3, FIX_4, commitOf(CANARY)];

describe('the line’s watch of the app’s release', () => {
  it('records the fixes already live as found, and sends them on to Verify (work items 1001 and 1006)', async () => {
    const first = await merged(17, FIX_1);
    const second = await merged(25, FIX_2);
    const later = await merged(30, FIX_3);
    // A dry run's merge, which GitHub never had, is never found live.
    const dryRun = await merged(1_000_000_001, 'd'.repeat(40));
    const { line: it, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();

    for (const workItem of [first, second]) {
      expect(await typesOf(workItem)).toEqual(['release.started by factory', 'release.promoted by factory']);
      expect(await stage(workItem)).toBe('verify');
    }
    expect(await payloads(first, 'release.started')).toEqual([
      {
        release: releaseOf(STABLE),
        version: commitOf(STABLE),
        previous: commitOf(STABLE),
        commit: commitOf(STABLE),
        image: { digest: digestOf(STABLE), signed: true, admitted: true },
        watched: false,
        steps: null,
        dryRun: false,
      },
    ]);
    // Not in the stable version yet: held at Release for the deploy that will carry it.
    expect(await typesOf(later)).toEqual([]);
    expect(await stage(later)).toBe('held');
    expect(await typesOf(dryRun)).toEqual([]);

    // Read again, nothing more.
    await it.tick();
    expect(await typesOf(first)).toHaveLength(2);
  });

  it('records a release on each work item it carries, step by step, and its promotion; a new line adds nothing', async () => {
    const shipped = await merged(17, FIX_1);
    const carried = [await merged(30, FIX_3), await merged(31, FIX_4)];
    const { line: it, github, kube, asked } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    expect(await typesOf(shipped)).toHaveLength(2);

    // A deploy merged: the canary starts, and its first step's analysis ends.
    const t0 = new Date(now).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 });
    // The step's journeys Job counted the checks on each version.
    const step = run({ step: 2, created: t0, completed: new Date(now + 3.5 * 60_000).toISOString() });
    const job = `${step.metadata.uid}.journeys.1`;
    const journeys = step.status.metricResults.find((m) => m.name === 'journeys');
    for (const m of journeys?.measurements ?? []) m.metadata = { 'job-name': job, 'job-namespace': 'website' };
    kube.messages.set(
      job,
      JSON.stringify({ regressions: [], counts: { base: { passed: 41, ran: 48 }, change: { passed: 40, ran: 48 } } }),
    );
    kube.runs = [run({ created: t0, phase: 'Running' }), step];
    await it.tick();
    for (const workItem of carried) {
      expect(await typesOf(workItem)).toEqual(['release.started by rollouts', 'canary.stepped by rollouts']);
      expect(await stage(workItem)).toBe('release');
    }
    expect(await typesOf(shipped)).toHaveLength(2);
    // The start records the canary's steps as the Rollout read from the cluster has them.
    expect((await payloads(carried[0] as string, 'release.started'))[0]?.steps).toEqual([
      { weight: 25, pauseSeconds: 180, analysis: true },
      { weight: 50, pauseSeconds: 180, analysis: true },
    ]);
    const [stepped] = await payloads(carried[0] as string, 'canary.stepped');
    expect(stepped?.figures).toEqual({
      canary: { requests: 224, errorRate: 0.004, p99Ms: 124, journeys: [40, 48] },
      baseline: { requests: 640, errorRate: 0.002, p99Ms: 118, journeys: [41, 48] },
    });
    expect(stepped?.weight).toBe(25);
    // The background analysis's first look, as it landed, with each version's figures then.
    const [look] = await payloads(carried[0] as string, 'canary.measuring');
    expect(look).toMatchObject({ release: releaseOf(CANARY), weight: 25, at: t0, dryRun: false });
    expect(look?.measures.map((m) => m.name)).toEqual(['errors', 'latency', 'journeys']);
    expect(look?.figures).toEqual({
      canary: { requests: 224, errorRate: 0.004, p99Ms: 124, journeys: null },
      baseline: { requests: 640, errorRate: 0.002, p99Ms: 118, journeys: null },
    });
    // Three figures of each version, at the step's end and at the look.
    expect(asked.filter((path) => path === '/api/v1/query')).toHaveLength(12);

    // Promoted. The line starts again, and appends nothing it has.
    kube.rollout = rollout({ current: CANARY, stable: CANARY });
    await it.tick();
    const again = line();
    again.github.history = HISTORY;
    again.kube.rollout = kube.rollout;
    again.kube.runs = kube.runs;
    await again.line.tick();
    for (const workItem of carried) {
      expect(await typesOf(workItem)).toEqual([
        'release.started by rollouts',
        'canary.stepped by rollouts',
        'release.promoted by rollouts',
      ]);
      expect(await stage(workItem)).toBe('verify');
    }
    // A span for each pass that read or recorded something of a release, naming what it carried; none for the pass
    // that found nothing new.
    const release = releaseOf(CANARY);
    expect(spans('release').map((span) => span.attributes)).toEqual([
      { release: releaseOf(STABLE), dry_run: false, work_items: [shipped] },
      { release, dry_run: false, work_items: carried },
      { release, dry_run: false, work_items: carried },
    ]);
  });

  it('carries a work item by its latest merge, and leaves one closed while its release runs', async () => {
    const { line: it, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    const [carried, closing, mergedAgain] = [await merged(30, FIX_3), await merged(31, FIX_4), await merged(32, FIX_4)];
    // Sent back after its merge, the third merged again, as a commit this release does not run.
    await events.append([
      event(mergedAgain, 'pull-request.merged', { number: 33, commit: 'e'.repeat(40), by: 'martin' }, 'martin'),
    ]);
    const t0 = new Date(now).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    kube.runs = [run({ created: t0, phase: 'Running' })];
    await it.tick();
    expect(await typesOf(carried)).toEqual(['release.started by rollouts']);
    expect(await typesOf(closing)).toEqual(['release.started by rollouts']);
    expect(await typesOf(mergedAgain)).toEqual([]);
    // Martin closes one at Release: the release goes on for the other.
    await events.append([
      event(closing, 'work-item.closed', { outcome: 'no-change', reason: 'Martin closed it' }, 'martin'),
    ]);
    kube.runs = [...kube.runs, run({ step: 2, created: t0, completed: t0 })];
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 });
    await it.tick();
    expect(await typesOf(carried)).toEqual(['release.started by rollouts', 'canary.stepped by rollouts']);
    expect(await typesOf(closing)).toEqual(['release.started by rollouts']);
  });

  it('records a release that carries none of the line’s work on the line', async () => {
    const { line: it, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    await it.tick();
    kube.rollout = rollout({ current: CANARY, stable: CANARY });
    await it.tick();
    expect(await typesOf(null)).toEqual([
      'release.started by factory',
      'release.promoted by factory',
      'release.started by rollouts',
      'release.promoted by rollouts',
    ]);
  });

  it('finds live an image promoted before and released again while it was down, by the release that shipped last', async () => {
    const { line: it, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    await it.tick();
    kube.rollout = rollout({ current: CANARY, stable: CANARY });
    await it.tick();
    // STABLE pinned again and promoted while the line was down, and none of its runs kept: the line's last promotion
    // is CANARY's, which the releases of STABLE's hash alone do not show.
    kube.rollout = rollout({ current: STABLE, stable: STABLE, revision: 5 });
    await it.tick();
    expect((await typesOf(null)).slice(4)).toEqual(['release.started by factory', 'release.promoted by factory']);
    expect((await payloads(null, 'release.promoted')).at(-1)).toMatchObject({
      release: `${STABLE}-5`,
      previous: commitOf(CANARY),
      watched: false,
    });
  });

  it('takes the stable version at a later revision for none when the last promotion is from before releases were named', async () => {
    const warnings: string[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => warnings.push(line) });
    const { line: it, github, kube } = line({ log });
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    // A promotion of version 1 named no release, so it says nothing of which image shipped last.
    const payload = { version: commitOf(CANARY), previous: commitOf(STABLE) };
    await database.as.line`
      insert into events (id, ts, type, version, actor, summary, payload, artifacts, public, sample)
      values (${crypto.randomUUID()}, now(), 'release.promoted', 1, 'rollouts', 'Promoted',
              ${database.as.line.json(payload)}, '[]', '{}', false)`;
    kube.rollout = rollout({ current: STABLE, stable: STABLE, revision: 5 });
    await it.tick();
    expect(await typesOf(null)).toEqual([
      'release.started by factory',
      'release.promoted by factory',
      'release.promoted by rollouts',
    ]);
    expect(warnings).toEqual([]);
  });

  it('records a rollback with the series that condemned it, and holds the work it carried at Release again', async () => {
    const { line: it, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    const carried = await merged(30, FIX_3);
    const t0 = new Date(now).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    kube.runs = [run({ created: t0, phase: 'Running' })];
    await it.tick();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, abort: true });
    kube.runs = [
      run({
        created: t0,
        completed: new Date(now + 3 * 60_000).toISOString(),
        phase: 'Failed',
        message: 'Metric "latency" assessed Failed due to failed (2) > failureLimit (1)',
        metrics: { latency: { phase: 'Failed', value: '[0.247]' } },
      }),
    ];
    await it.tick();
    const [rolledBack] = await payloads(carried, 'release.rolled-back');
    expect(rolledBack).toMatchObject({ release: releaseOf(CANARY), weight: 25, restored: commitOf(STABLE) });
    expect(rolledBack?.failed).toEqual([
      {
        name: 'latency',
        phase: 'failed',
        value: 0.247,
        limit: 0,
        series: expect.objectContaining({ label: 'p99 latency', unit: 'ms', stepSeconds: 15, at: 12 }),
      },
    ]);
    expect(rolledBack?.failed[0]?.series?.canary.slice(0, 2)).toEqual([124, 124]);
    expect(await stage(carried)).toBe('held');
  });

  it('records a step without its figures when Prometheus cannot say', async () => {
    const { line: it, github, kube } = line({}, { prometheusDown: true });
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    const carried = await merged(30, FIX_3);
    const t0 = new Date(now).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 });
    kube.runs = [run({ created: t0, phase: 'Running' }), run({ step: 2, created: t0, completed: t0 })];
    await it.tick();
    const [stepped] = await payloads(carried, 'canary.stepped');
    expect(stepped?.analysis.measures.map((m) => m.name)).toEqual(['enough-requests', 'errors', 'latency', 'journeys']);
    expect(stepped?.figures).toBeUndefined();
  });

  it('keeps the journeys’ counts at a step when Prometheus cannot say', async () => {
    const { line: it, github, kube } = line({}, { prometheusDown: true });
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    const carried = await merged(30, FIX_3);
    const t0 = new Date(now).toISOString();
    const step = run({ step: 2, created: t0, completed: t0 });
    const journeys = step.status.metricResults.find((m) => m.name === 'journeys');
    for (const m of journeys?.measurements ?? []) m.metadata = { 'job-name': 'step.journeys.1' };
    kube.messages.set(
      'step.journeys.1',
      JSON.stringify({ regressions: [], counts: { base: { passed: 41, ran: 48 }, change: { passed: 40, ran: 48 } } }),
    );
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 });
    kube.runs = [run({ created: t0, phase: 'Running' }), step];
    await it.tick();
    const [stepped] = await payloads(carried, 'canary.stepped');
    expect(stepped?.figures).toEqual({
      canary: { requests: null, errorRate: null, p99Ms: null, journeys: [40, 48] },
      baseline: { requests: null, errorRate: null, p99Ms: null, journeys: [41, 48] },
    });
  });

  it('records a release of the one work item the line acts on, and the line’s own, while it acts on that alone', async () => {
    const workItem = await merged(30, FIX_3);
    await setTake(database.admin, { kind: 'just-one', workItem });
    const { line: it, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    // The version found live carries none of the line's work: recorded on the line, as what the next is compared with.
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    expect(await typesOf(null)).toEqual(['release.started by factory', 'release.promoted by factory']);
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    await it.tick();
    kube.rollout = rollout({ current: CANARY, stable: CANARY });
    await it.tick();
    expect(await typesOf(workItem)).toEqual(['release.started by rollouts', 'release.promoted by rollouts']);
    expect(await stage(workItem)).toBe('verify');
  });

  it('leaves a release that carries another work item for the whole line, while it acts on one alone', async () => {
    const { line: whole, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await whole.tick();
    const [workItem, other] = [await merged(30, FIX_3), await merged(31, FIX_4)];
    await setTake(database.admin, { kind: 'just-one', workItem });
    const only = line();
    only.github.history = HISTORY;
    for (const [digest, commit] of github.revisions) only.github.revisions.set(digest, commit);
    only.kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    await only.line.tick();
    expect(await typesOf(workItem)).toEqual([]);
    expect(await typesOf(other)).toEqual([]);
    expect(await typesOf(null)).toHaveLength(2);

    // The line acts on them all again, and records it on both.
    await setTake(database.admin, { kind: 'every' });
    kube.rollout = only.kube.rollout;
    await whole.tick();
    for (const carried of [workItem, other]) expect(await typesOf(carried)).toEqual(['release.started by rollouts']);
  });
});

describe('a rollback, as signals to triage', () => {
  const inbox = async () =>
    database.owner<{ sense: string; fingerprint: string; signal: InboxSignal }[]>`
      select sense, fingerprint, signal from inbox order by signal->>'check'`;

  /** A release carrying a fix, under way at 25%, and the line that watches it. */
  async function underWay() {
    const watching = line();
    const { line: it, github, kube } = watching;
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    const carried = await merged(30, FIX_3);
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    kube.runs = [run({ created: new Date(now).toISOString(), phase: 'Running' })];
    await it.tick();
    return { ...watching, carried };
  }

  /** The background run, failed on errors, latency and the journeys, whose Job was `job`. */
  function failedRun(job: string) {
    const failed = run({
      created: new Date(now).toISOString(),
      completed: new Date(now + 3 * 60_000).toISOString(),
      phase: 'Failed',
      message: 'Metric "latency" assessed Failed due to failed (2) > failureLimit (1)',
      metrics: {
        errors: { phase: 'Failed', value: '[0.0119]' },
        latency: { phase: 'Failed', value: '[0.247]', message: 'Metric "latency" assessed Failed' },
        journeys: { phase: 'Failed' },
      },
    });
    const journeys = failed.status.metricResults.find((m) => m.name === 'journeys');
    for (const m of journeys?.measurements ?? []) m.metadata = { 'job-name': job, 'job-namespace': 'website' };
    return failed;
  }

  it('sends one for each failed measure, by its class, where the canary did worse, once, across a restart', async () => {
    const { line: it, github, kube } = await underWay();
    const job = `${failedRun('x').metadata.uid}.journeys.2`;
    kube.messages.set(
      job,
      JSON.stringify({
        regressions: [
          {
            sense: 'probe',
            check: 'checkout/console',
            route: '/checkout',
            symptom: 'browser-error',
            message: 'An error',
          },
        ],
      }),
    );
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, abort: true });
    kube.runs = [failedRun(job)];
    await it.tick();

    const sent = await inbox();
    expect(sent.map((row) => [row.sense, row.fingerprint, row.signal.check])).toEqual([
      ['canary', '* server-error', 'errors'],
      ['canary', '/checkout browser-error', 'journeys'],
      ['canary', '/search slow-response', 'latency'],
    ]);
    const [errors, journeys, latency] = sent.map((row) => row.signal);
    expect(errors?.evidence?.[0]).toMatchObject({
      kind: 'canary',
      release: releaseOf(CANARY),
      measure: { name: 'errors', phase: 'failed', value: 0.0119, limit: 0.01 },
      routes: {
        unit: '%',
        worse: [
          { route: '/search', canary: 15, baseline: 0.5 },
          { route: '/cart', canary: 10, baseline: 0 },
        ],
      },
      series: expect.objectContaining({ label: 'share of 5xx answers', unit: '%' }),
    });
    expect(latency?.evidence?.[0]).toMatchObject({
      routes: { unit: 'ms', worse: [{ route: '/search', canary: 620, baseline: 120 }] },
      measure: { message: 'Metric "latency" assessed Failed' },
    });
    expect(journeys?.evidence?.[0]).toMatchObject({
      checks: [{ sense: 'probe', check: 'checkout/console', route: '/checkout', symptom: 'browser-error' }],
    });

    // Read again, and by a line started again: the same signals, none twice.
    await it.tick();
    const again = line();
    again.github.history = github.history;
    again.kube.rollout = kube.rollout;
    again.kube.runs = kube.runs;
    for (const [name, message] of kube.messages) again.kube.messages.set(name, message);
    await again.line.tick();
    expect(await inbox()).toHaveLength(3);
  });

  it('sends a failed journey under a fixed class on every route when its Job’s words are lost', async () => {
    const { line: it, kube } = await underWay();
    kube.messages.set('gone.journeys.1', 'Error: Chromium crashed');
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, abort: true });
    kube.runs = [failedRun('gone.journeys.1')];
    await it.tick();
    const journeys = (await inbox()).find((row) => row.signal.check === 'journeys');
    expect(journeys?.fingerprint).toBe(`* ${JOURNEY_FALLBACK}`);
  });

  it('waits for a journeys Job whose container has not ended, then reads what it wrote', async () => {
    const { line: it, kube } = await underWay();
    // Its pod is listed before its container has a status.
    kube.messages.set('slow.journeys.1', 'pending');
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, abort: true });
    kube.runs = [failedRun('slow.journeys.1')];
    await it.tick();
    expect((await inbox()).map((row) => row.signal.check)).toEqual(['errors', 'latency']);
    kube.messages.set('slow.journeys.1', null);
    await it.tick();
    expect((await inbox()).map((row) => row.signal.check)).toEqual(['errors', 'latency']);
    kube.messages.set(
      'slow.journeys.1',
      JSON.stringify({ regressions: [{ sense: 'crawler', check: 'links', route: '/about', symptom: 'broken-link' }] }),
    );
    await it.tick();
    const journeys = (await inbox()).find((row) => row.signal.check === 'journeys');
    expect(journeys?.fingerprint).toBe('/about broken-link');
  });

  /** The runs as Martin's abort leaves them: terminated, which fails none. */
  const terminated = () => [
    run({
      created: new Date(now).toISOString(),
      completed: new Date(now + 60_000).toISOString(),
      phase: 'Successful',
      message: 'Run Terminated',
      terminate: true,
    }),
  ];

  it('records Martin’s abort, sends nothing for it, and holds the work it carried for him', async () => {
    const { line: it, kube, carried } = await underWay();
    const abortedAt = new Date(now).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt });
    kube.runs = terminated();
    // A pass after the control's lag: no control from the console claimed it.
    now += 20_000;
    await it.tick();
    expect(await inbox()).toEqual([]);
    expect(await typesOf(carried)).toEqual(['release.started by rollouts', 'release.aborted by martin']);
    expect(await payloads(carried, 'release.aborted')).toEqual([
      { release: releaseOf(CANARY), version: commitOf(CANARY), restored: commitOf(STABLE), abortedAt, by: 'martin' },
    ]);
    await it.tick();
    expect(await stage(carried)).toBe('held');
    const [hold] = await payloads(carried, 'hold.started');
    expect(hold).toMatchObject({ cause: 'deploy', reason: expect.stringMatching(/^Martin aborted the release/) });
  });

  it('holds the work for Martin when the canary is judged bad and paused, and takes his abort for a rollback', async () => {
    const { line: it, kube, carried } = await underWay();
    const verdict = 'Metric "errors" assessed Inconclusive due to inconclusive (1) > inconclusiveLimit (0)';
    const judged = run({
      step: 2,
      created: new Date(now + 3 * 60_000).toISOString(),
      completed: new Date(now + 3.5 * 60_000).toISOString(),
      phase: 'Inconclusive',
      message: verdict,
      metrics: { errors: { phase: 'Inconclusive', value: '[0.0213,0.0213]', inconclusive: 1 } },
    });
    const background = kube.runs;
    kube.runs = [...background, judged];
    kube.rollout = rollout({
      current: CANARY,
      stable: STABLE,
      stepIndex: 2,
      weight: 25,
      pausedFor: 'InconclusiveAnalysisRun',
    });
    await it.tick();
    await it.tick();
    // Held once, however many passes find it paused.
    const holds = await payloads(carried, 'hold.started');
    expect(holds.map((h) => [h.cause, h.release])).toEqual([['canary', releaseOf(CANARY)]]);
    expect(await stage(carried)).toBe('held');
    expect(await inbox()).toEqual([]);

    // Martin aborts it from the console's Canary panel.
    const abortedAt = new Date(now + 4 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    now += 4 * 60_000 + 20_000;
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt });
    // The abort terminates the background run, made when the release started, before the verdict.
    kube.runs = [
      ...background.map((r) => ({
        ...r,
        spec: { ...r.spec, terminate: true },
        status: { ...r.status, phase: 'Successful', message: 'Run Terminated' },
      })),
      judged,
    ];
    await it.tick();
    expect(await typesOf(carried)).toEqual([
      'release.started by rollouts',
      'canary.stepped by rollouts',
      'release.rolled-back by martin',
    ]);
    expect(await payloads(carried, 'release.rolled-back')).toMatchObject([
      {
        by: 'martin',
        weight: 25,
        reason: verdict,
        abortedAt,
        failed: [{ name: 'errors', phase: 'inconclusive', value: 0.0213, failures: 1, series: expect.any(Object) }],
      },
    ]);
    // Triage gets the analysis's verdict, as from any rollback, a pass after the rollback is recorded.
    await it.tick();
    const sent = await inbox();
    expect(sent.map((row) => [row.sense, row.fingerprint, row.signal.check])).toEqual([
      ['canary', '* server-error', 'errors'],
    ]);
    expect(sent[0]?.signal.summary).toContain(`judged bad and rolled back by Martin: ${verdict}`);
    expect(sent[0]?.signal.evidence?.[0]).toMatchObject({ measure: { phase: 'inconclusive', message: verdict } });
    // It failed Release: held for the next deploy, or his retry.
    expect(await stage(carried)).toBe('held');
    expect((await payloads(carried, 'hold.started')).at(-1)).toMatchObject({
      cause: 'deploy',
      reason: expect.stringMatching(
        /^Martin aborted the release that carried the fix, .*which the analysis judged bad/,
      ),
    });
  });

  it('records an analysis that could not judge the canary, sends nothing for it, and holds the work for Martin', async () => {
    const { line: it, kube, carried } = await underWay();
    const abortedAt = new Date(now + 60_000).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt });
    kube.runs = [
      run({
        created: new Date(now).toISOString(),
        completed: new Date(now + 60_000).toISOString(),
        phase: 'Error',
        message: 'Metric "latency" assessed Error due to consecutiveErrors (5) > consecutiveErrorLimit (4)',
        metrics: { latency: { phase: 'Error', message: 'connection refused' } },
      }),
    ];
    await it.tick();
    expect(await inbox()).toEqual([]);
    expect(await typesOf(carried)).toEqual(['release.started by rollouts', 'release.errored by rollouts']);
    expect(await payloads(carried, 'release.errored')).toMatchObject([
      { weight: 25, errored: [{ name: 'latency', phase: 'error', message: 'connection refused' }], abortedAt },
    ]);
    await it.tick();
    expect(await stage(carried)).toBe('held');
    const [hold] = await payloads(carried, 'hold.started');
    expect(hold).toMatchObject({ cause: 'deploy', reason: expect.stringMatching(/could not judge it/) });
  });

  it('records Stop the line’s abort while the line is stopped, and starts the release again when it is retried', async () => {
    const { line: it, kube, carried } = await underWay();
    // `make stop-the-line`: the line's stop, then the abort, which Argo Rollouts keeps to the second, cut short.
    const stop = event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin');
    await martin.append([{ ...stop, ts: new Date(now + 400).toISOString() }]);
    kube.rollout = rollout({
      current: CANARY,
      stable: STABLE,
      stepIndex: 0,
      abort: true,
      abortedAt: new Date(now).toISOString(),
    });
    kube.runs = terminated();
    now += 20_000;
    await it.tick();
    expect(await typesOf(carried)).toEqual(['release.started by rollouts', 'release.aborted by martin']);
    expect(await payloads(carried, 'release.aborted')).toMatchObject([{ by: 'stop' }]);
    now += 60_000;
    await martin.append([event(null, 'line.started', { autonomy: 'guarded' }, 'martin')]);
    await it.tick();
    expect(await stage(carried)).toBe('held');
    // Martin retries it.
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    kube.runs = [...terminated(), run({ name: 'website-68ff668868-4.1', created: new Date(now).toISOString() })];
    await it.tick();
    expect(await typesOf(carried)).toEqual([
      'release.started by rollouts',
      'release.aborted by martin',
      'release.started by rollouts',
    ]);
    await it.tick();
    expect(await stage(carried)).toBe('release');
  });

  it('waits a pass for the console’s control before it says who made a fresh abort', async () => {
    const { line: it, kube, carried } = await underWay();
    kube.rollout = rollout({
      current: CANARY,
      stable: STABLE,
      stepIndex: 0,
      abort: true,
      abortedAt: new Date(now).toISOString(),
    });
    kube.runs = terminated();
    await it.tick();
    expect(await payloads(carried, 'release.aborted')).toEqual([]);
    await martin.append([
      {
        ...event(
          null,
          'release.controlled',
          { action: 'abort', release: releaseOf(CANARY), version: commitOf(CANARY), weight: 25 },
          'martin',
        ),
        ts: new Date(now - 500).toISOString(),
      },
    ]);
    await it.tick();
    expect(await payloads(carried, 'release.aborted')).toMatchObject([{ by: 'martin' }]);
  });

  it('takes Martin’s abort from his control on the console, even just after the line stopped', async () => {
    const { line: it, kube, carried } = await underWay();
    const control = (release: string) =>
      event(null, 'release.controlled', { action: 'abort', release, version: commitOf(CANARY), weight: 25 }, 'martin');
    // He stopped the line, and aborted the canary from the panel in the same minute.
    await martin.append([
      {
        ...event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin'),
        ts: new Date(now - 20_000).toISOString(),
      },
      { ...control(releaseOf(CANARY)), ts: new Date(now - 5_000).toISOString() },
    ]);
    kube.rollout = rollout({
      current: CANARY,
      stable: STABLE,
      stepIndex: 0,
      abort: true,
      abortedAt: new Date(now - 4_000).toISOString(),
    });
    kube.runs = terminated();
    await it.tick();
    expect(await payloads(carried, 'release.aborted')).toMatchObject([{ by: 'martin' }]);
  });

  it('takes the console’s Stop the line abort from its control, at once, however long ago the line stopped', async () => {
    const { line: it, kube, carried } = await underWay();
    // The stop recorded long before the abort (Kubernetes was slow to take it), which time alone would call his own.
    await martin.append([
      {
        ...event(null, 'line.stopped', { reason: 'Something is wrong' }, 'martin'),
        ts: new Date(now - 10 * 60_000).toISOString(),
      },
      {
        ...event(
          null,
          'release.controlled',
          { action: 'abort', release: releaseOf(CANARY), version: commitOf(CANARY), weight: 25, stop: true },
          'martin',
        ),
        ts: new Date(now - 2_000).toISOString(),
      },
    ]);
    kube.rollout = rollout({
      current: CANARY,
      stable: STABLE,
      stepIndex: 0,
      abort: true,
      abortedAt: new Date(now - 2_000).toISOString(),
    });
    kube.runs = terminated();
    await it.tick();
    expect(await payloads(carried, 'release.aborted')).toMatchObject([{ by: 'stop' }]);
  });

  it('takes no record of this abort, on another of the release’s targets, for the attempt before it', async () => {
    const { line: it, kube, carried } = await underWay();
    const abortedAt = new Date(now - 4_000).toISOString();
    // He stopped the line and aborted from the panel; the abort is recorded already elsewhere than on this work item.
    await martin.append([
      {
        ...event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin'),
        ts: new Date(now - 20_000).toISOString(),
      },
      {
        ...event(
          null,
          'release.controlled',
          { action: 'abort', release: releaseOf(CANARY), version: commitOf(CANARY), weight: 25 },
          'martin',
        ),
        ts: new Date(now - 5_000).toISOString(),
      },
    ]);
    await events.append([
      event(
        null,
        'release.aborted',
        { release: releaseOf(CANARY), version: commitOf(CANARY), restored: commitOf(STABLE), abortedAt, by: 'martin' },
        'rollouts',
      ),
    ]);
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt });
    kube.runs = terminated();
    await it.tick();
    expect(await payloads(carried, 'release.aborted')).toMatchObject([{ by: 'martin' }]);
  });

  it('takes a control of an earlier attempt for none of a retried release’s later aborts', async () => {
    const { line: it, kube, carried } = await underWay();
    await martin.append([
      {
        ...event(
          null,
          'release.controlled',
          { action: 'abort', release: releaseOf(CANARY), version: commitOf(CANARY), weight: 25 },
          'martin',
        ),
        ts: new Date(now - 5_000).toISOString(),
      },
    ]);
    const first = new Date(now - 4_000).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 0, abort: true, abortedAt: first });
    kube.runs = terminated();
    now += 20_000;
    await it.tick();
    expect(await payloads(carried, 'release.aborted')).toMatchObject([{ by: 'martin' }]);
    // Retried, then aborted again within the minute by Stop the line: the earlier control is the first attempt's.
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    kube.runs = [...terminated(), run({ name: 'website-68ff668868-4.1', created: new Date(now).toISOString() })];
    await it.tick();
    await martin.append([event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin')]);
    kube.rollout = rollout({
      current: CANARY,
      stable: STABLE,
      stepIndex: 0,
      abort: true,
      abortedAt: new Date(now + 1_000).toISOString(),
    });
    now += 20_000;
    await it.tick();
    expect(await payloads(carried, 'release.aborted')).toMatchObject([{ by: 'martin' }, { by: 'stop' }]);
  });

  it('takes a control of an attempt a version 3 rollback ended for none of the retry’s aborts', async () => {
    const { line: it, kube, carried } = await underWay();
    await martin.append([
      {
        ...event(
          null,
          'release.controlled',
          { action: 'abort', release: releaseOf(CANARY), version: commitOf(CANARY), weight: 25 },
          'martin',
        ),
        ts: new Date(now - 5_000).toISOString(),
      },
    ]);
    // The analysis rolled the first attempt back, recorded as version 3 recorded one: with no time of the abort.
    await events.append([
      {
        ...event(
          carried,
          'release.rolled-back',
          {
            release: releaseOf(CANARY),
            version: commitOf(CANARY),
            restored: commitOf(STABLE),
            weight: 25,
            reason: 'The analysis failed it',
            failed: [],
            dryRun: false,
            by: 'analysis',
          },
          'rollouts',
        ),
        ts: new Date(now - 4_000).toISOString(),
      },
    ]);
    // Retried, then aborted again within the minute by Stop the line: the earlier control is the first attempt's.
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    kube.runs = [...terminated(), run({ name: 'website-68ff668868-4.1', created: new Date(now).toISOString() })];
    await it.tick();
    await martin.append([event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin')]);
    kube.rollout = rollout({
      current: CANARY,
      stable: STABLE,
      stepIndex: 0,
      abort: true,
      abortedAt: new Date(now + 1_000).toISOString(),
    });
    now += 20_000;
    await it.tick();
    expect(await payloads(carried, 'release.aborted')).toMatchObject([{ by: 'stop' }]);
  });

  it('takes no control of another release, or long before the abort, for Martin’s abort of this one', async () => {
    const { line: it, kube, carried } = await underWay();
    const control = (release: string, ts: number) => ({
      ...event(
        null,
        'release.controlled',
        { action: 'abort', release, version: commitOf(CANARY), weight: 25 },
        'martin',
      ),
      ts: new Date(ts).toISOString(),
    });
    await martin.append([
      control(releaseOf(CANARY), now - 5 * 60_000),
      control('0123abcd-9', now - 5_000),
      {
        ...event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin'),
        ts: new Date(now - 2_000).toISOString(),
      },
    ]);
    kube.rollout = rollout({
      current: CANARY,
      stable: STABLE,
      stepIndex: 0,
      abort: true,
      abortedAt: new Date(now - 1_000).toISOString(),
    });
    kube.runs = terminated();
    now += 20_000;
    await it.tick();
    expect(await payloads(carried, 'release.aborted')).toMatchObject([{ by: 'stop' }]);
  });

  it('takes an abort long after the line stopped for Martin’s own', async () => {
    const { line: it, kube, carried } = await underWay();
    await martin.append([event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin')]);
    kube.rollout = rollout({
      current: CANARY,
      stable: STABLE,
      stepIndex: 0,
      abort: true,
      abortedAt: new Date(now + 10 * 60_000).toISOString(),
    });
    kube.runs = terminated();
    now += 11 * 60_000;
    await it.tick();
    expect(await payloads(carried, 'release.aborted')).toMatchObject([{ by: 'martin' }]);
  });

  it('waits to send a failed measure until it can read where the canary did worse', async () => {
    const { line: it, kube } = await underWay();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, abort: true });
    kube.runs = [failedRun('a.journeys.1')];
    const down = line({}, { prometheusDown: true });
    down.github.history = HISTORY;
    down.kube.rollout = kube.rollout;
    down.kube.runs = kube.runs;
    await down.line.tick();
    expect((await inbox()).map((row) => row.signal.check)).toEqual(['journeys']);
    await it.tick();
    expect((await inbox()).map((row) => row.signal.check)).toEqual(['errors', 'journeys', 'latency']);
  });
});

describe('a dry run’s release', () => {
  it('releases each merge the dry run made by its word, a while after the merge, and sends it on to Verify', async () => {
    const workItem = await merged(1_000_000_001, 'd'.repeat(40));
    const real = await merged(30, FIX_3);
    const { line: it, github } = line({ release: null, dryRun: true, dryRunReleaseMs: 60_000 });
    github.history = HISTORY;
    await it.tick();
    expect(await typesOf(workItem)).toEqual([]);
    for (let minute = 1; minute <= 4; minute++) {
      now += 60_000;
      await it.tick();
    }
    expect(await typesOf(workItem)).toEqual([
      'release.started by factory',
      'canary.stepped by factory',
      'canary.stepped by factory',
      'release.promoted by factory',
    ]);
    expect((await payloads(workItem, 'release.started'))[0]).toMatchObject({
      dryRun: true,
      release: 'dry-run-dddddddddddd',
    });
    expect(await stage(workItem)).toBe('verify');
    // A real merge waits for a real release.
    expect(await typesOf(real)).toEqual([]);
    // A span for each pass that recorded something, and none for those that had nothing due.
    expect(spans('release').map((span) => span.attributes)).toEqual(
      Array(4).fill({ dry_run: true, work_items: [workItem] }),
    );
  });

  it('is not answered for outside a dry run', async () => {
    const workItem = await merged(1_000_000_001, 'd'.repeat(40));
    const { line: it } = line({ release: null });
    now += 10 * 60_000;
    await it.tick();
    expect(await typesOf(workItem)).toEqual([]);
  });
});

describe('Verify on the line', () => {
  /** A release of `commit` carrying the work item, promoted. */
  async function promote(workItem: string, release = 'f00dfeed01', version = commitOf(CANARY), dryRun = false) {
    const payload = { release, version, previous: commitOf(STABLE), commit: version, watched: !dryRun, dryRun };
    await events.append([
      event(workItem, 'release.started', { ...payload, steps: null, ...(dryRun ? {} : { image: IMAGE }) }, 'rollouts'),
      event(workItem, 'release.promoted', payload, 'rollouts'),
    ]);
  }
  const IMAGE = { digest: digestOf(CANARY), signed: true, admitted: true };
  const pass = async (it: Line) => {
    await it.tick();
    await it.idle();
  };
  const types = async (workItem: string) =>
    (
      await database.as.line<{ type: string }[]>`
        select type from events where work_item = ${workItem} and type not like 'release.%' order by seq`
    ).map((r) => r.type);

  it('sends the work back to Plan when the probe still fails, with a session of its own, and holds the second time', async () => {
    const workItem = await merged(30, FIX_3);
    await database.as.line`update line set session = 'session-1' where work_item = ${workItem}`;
    await promote(workItem);
    const probes = new FakeProbes({ outcome: 'persists', version: commitOf(CANARY), runs: ['failed', 'failed'] });
    const { line: it, github } = line({ release: null, verify: { probes } });
    await pass(it); // Verify looks: it persists
    await pass(it); // and the work goes back to Plan
    expect((await types(workItem)).slice(-2)).toEqual(['verification.finished', 'work.returned']);
    expect((await payloads(workItem, 'work.returned'))[0]).toEqual({
      from: 'verify',
      to: 'plan',
      reason: `The probe still saw “departments” on ${commitOf(CANARY)}, the release that carried the fix`,
    });
    const [row] = await database.as.line<{ stage: string; session: string | null }[]>`
      select stage, session from line where work_item = ${workItem}`;
    expect(row?.session).toBeNull();
    // The issue stays open.
    expect(github.acts.filter((a) => a.action === 'closeIssue')).toEqual([]);

    expect(github.acts.filter((a) => a.action === 'closeIssue')).toEqual([]);
  });

  it('closes a canary’s ticket as verified once a release carrying its fix promotes with the failed measure passing', async () => {
    const workItem = await merged(30, FIX_3, 'canary');
    const release = 'f00dfeed01';
    const measures = [
      { name: 'errors', phase: 'successful' as const, value: -0.001, limit: 0.01 },
      { name: 'latency', phase: 'successful' as const, value: -0.09, limit: 0 },
    ];
    const stepped = {
      release,
      version: commitOf(CANARY),
      weight: 50,
      analysis: { phase: 'successful' as const, requests: 230, measures },
      dryRun: false,
    };
    await events.append([event(null, 'canary.stepped', stepped, 'rollouts')]);
    await promote(workItem, release);
    const { line: it, github } = line({ release: null });
    await pass(it);
    await pass(it);
    const [verified] = await payloads(workItem, 'verification.finished');
    expect(verified).toMatchObject({
      outcome: 'cleared',
      sense: 'canary',
      check: 'latency',
      evidence: { kind: 'canary', release, measure: measures[1] },
    });
    expect((await types(workItem)).slice(-2)).toEqual(['verification.finished', 'work-item.closed']);
    expect(github.acts.filter((a) => a.action === 'closeIssue')).toHaveLength(1);
  });

  it('holds for Martin when a second fix’s release leaves the signal persisting, and keeps the issue open', async () => {
    const workItem = await merged(30, FIX_3);
    await promote(workItem);
    const persisted = {
      outcome: 'persists' as const,
      sense: 'probe' as const,
      check: 'departments',
      version: commitOf(CANARY),
      against: commitOf(STABLE),
      pages: [],
      dryRun: false,
    };
    // The first fix's pass, sent back from Verify; the second fix merged and released.
    await events.append([
      event(workItem, 'verification.finished', persisted, 'probe'),
      event(workItem, 'work.returned', { from: 'verify', to: 'plan', reason: 'It persists' }, 'factory'),
      event(workItem, 'pull-request.merged', { number: 31, commit: FIX_4, by: 'martin' }, 'martin'),
    ]);
    await promote(workItem, 'f00dfeed02');
    const probes = new FakeProbes({ outcome: 'persists', version: commitOf(CANARY), runs: ['failed', 'failed'] });
    const { line: it, github } = line({ release: null, verify: { probes } });
    await pass(it);
    await pass(it);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      stage: 'verify',
      kind: 'held',
      cause: 'verify',
    });
    expect(await stage(workItem)).toBe('held');
    expect(github.acts.filter((a) => a.action === 'closeIssue')).toEqual([]);
  });

  it('drops what a sense saw when a release promoted while it looked, and looks again at the new one', async () => {
    const workItem = await merged(30, FIX_3);
    await promote(workItem);
    const later = 'e'.repeat(40);
    const asked: string[] = [];
    const probes = {
      verify: async () => {
        asked.push('verify');
        if (asked.length === 1) {
          // Meanwhile, another release goes out, on the line.
          await events.append([
            event(
              null as unknown as string,
              'release.promoted',
              {
                release: 'f00dfeed09',
                version: later,
                previous: commitOf(CANARY),
                commit: later,
                watched: true,
                dryRun: false,
              },
              'rollouts',
            ),
          ]);
          return {
            outcome: 'cleared' as const,
            version: commitOf(CANARY),
            runs: ['passed' as const, 'passed' as const],
          };
        }
        return { outcome: 'cleared' as const, version: later, runs: ['passed' as const, 'passed' as const] };
      },
    };
    const { line: it } = line({ release: null, verify: { probes } });
    await pass(it);
    expect(await types(workItem)).not.toContain('verification.finished');
    await pass(it);
    expect(await payloads(workItem, 'verification.finished')).toEqual([
      expect.objectContaining({ outcome: 'cleared', version: later }),
    ]);
  });

  it('holds for Martin when only a visitor’s report saw the defect, and closes it as verified on his approval', async () => {
    const workItem = await merged(30, FIX_3, 'report');
    await promote(workItem);
    const { line: it, github } = line({ release: null });
    await pass(it);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      stage: 'verify',
      kind: 'approval',
      cause: 'verify',
    });
    await martin.append([
      event(workItem, 'hold.answered', { decision: 'approved', answer: 'The page is right now' }, 'martin'),
    ]);
    await pass(it);
    expect(github.acts.at(-1)).toEqual({
      action: 'closeIssue',
      args: {
        number: 29,
        reason: 'completed',
        comment: expect.stringContaining('Martin judged it cleared, saying: The page is right now.'),
      },
    });
    expect(await payloads(workItem, 'work-item.closed')).toEqual([
      { outcome: 'verified', reason: 'Martin judged it cleared, saying: The page is right now' },
    ]);
  });

  it('cuts a long approval’s words to fit the close, never inside an emoji', async () => {
    const workItem = await merged(30, FIX_3, 'report');
    await promote(workItem);
    const { line: it } = line({ release: null });
    await pass(it);
    // `Martin judged it cleared, saying: ` is 34 units, so the emoji's two units sit at 198 and 199: the 199 units
    // `cutTo` keeps before its mark would end on its first half, which it drops.
    const answer = `${'x'.repeat(164)}🙂 and more after it`;
    await martin.append([event(workItem, 'hold.answered', { decision: 'approved', answer }, 'martin')]);
    await pass(it);
    expect(await payloads(workItem, 'work-item.closed')).toEqual([
      { outcome: 'verified', reason: `Martin judged it cleared, saying: ${'x'.repeat(164)}…` },
    ]);
  });

  it('looks again later when the sense cannot tell, never closes on it, and asks Martin after a day', async () => {
    const workItem = await merged(30, FIX_3);
    await promote(workItem);
    const probes = new FakeProbes(new Error('The probes did not answer'));
    const { line: it } = line({ release: null, verify: { probes }, verifyEveryMs: 5 * 60_000 });
    await pass(it);
    await pass(it);
    expect(probes.asked).toHaveLength(1);
    expect(await stage(workItem)).toBe('verify');
    now += 5 * 60_000;
    probes.answers.splice(0, 1, { outcome: 'unsure', version: commitOf(CANARY), runs: ['passed', 'unsure'] });
    await pass(it);
    expect(probes.asked).toHaveLength(2);
    expect(await types(workItem)).not.toContain('verification.finished');

    // A day after the release, it still cannot tell: Martin is asked, told why.
    now += 24 * 60 * 60_000;
    await pass(it);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      stage: 'verify',
      kind: 'held',
      cause: 'verify',
      reason: expect.stringContaining('Verify could not tell in 24 hours after the release'),
    });
  });

  it('looks at a missing log by the agreement check, which needs Prometheus as well as Loki', async () => {
    const workItem = await merged(30, FIX_3, 'logs');
    await promote(workItem);
    const { line: it } = line({ release: null, verify: {} });
    now += 24 * 60 * 60_000;
    await pass(it);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      cause: 'verify',
      reason: expect.stringContaining('the line has no way to Prometheus (PROMETHEUS_URL)'),
    });
  });

  it('takes a verified work item back into Plan when its ticket reopens, once its issue is open again', async () => {
    const workItem = await merged(30, FIX_3);
    await promote(workItem);
    const probes = new FakeProbes({ outcome: 'cleared', version: commitOf(CANARY), runs: ['passed', 'passed'] });
    const steps = new FakeSteps(database.as.gateway, { planner: () => 'fails' });
    const { line: it, github } = line({ release: null, verify: { probes }, steps });
    await pass(it);
    await pass(it);
    expect(await stage(workItem)).toBe('ended');

    // Triage reopens it: the probe saw the same defect again, on a later version.
    const later = 'e'.repeat(40);
    const reopened = {
      sense: 'probe' as const,
      check: 'departments',
      route: '/departments/:department',
      version: later,
      reason: 'The probes saw it again',
      dryRun: false,
    };
    await events.append([event(workItem, 'work-item.reopened', reopened, 'triage')]);
    await database.as.line`update line set moved_at = moved_at - interval '2 minutes' where work_item = ${workItem}`;
    // GitHub fails the first time: it stays where it is, and comes back on the next pass.
    github.failing.set('reopenIssue', 1);
    await pass(it);
    expect(await stage(workItem)).toBe('ended');
    await pass(it);
    expect(github.acts.filter((a) => a.action === 'reopenIssue')).toEqual([
      {
        action: 'reopenIssue',
        args: {
          number: 29,
          comment: [
            'It came back after its fix was verified: the probe saw “departments” again on `/departments/:department`, in version eeeeeee.',
            '',
            `The factory’s work item #${workItem} is open again, and goes back to Plan for another fix.`,
          ].join('\n'),
        },
      },
    ]);
    // The fresh pass starts at Plan, with the planner told what came back.
    expect(steps.requests.at(-1)).toMatchObject({ agent: 'planner', workItem, round: 1 });
    expect(steps.requests.at(-1)?.prompt).toContain(`- The probe saw “departments” again on ${later}.`);
    expect(await stage(workItem)).toBe('plan');
    await pass(it);
    expect(github.acts.filter((a) => a.action === 'reopenIssue')).toHaveLength(1);
  });

  it('opens a new issue for a reopened work item whose issue is gone', async () => {
    const workItem = await merged(30, FIX_3);
    await promote(workItem);
    const probes = new FakeProbes({ outcome: 'cleared', version: commitOf(CANARY), runs: ['passed', 'passed'] });
    const steps = new FakeSteps(database.as.gateway, { planner: () => 'fails' });
    const { line: it, github } = line({ release: null, verify: { probes }, steps });
    await pass(it);
    await pass(it);
    const reopened = {
      sense: 'probe' as const,
      check: 'departments',
      route: '/departments/:department',
      version: 'e'.repeat(40),
      reason: 'The probes saw it again',
      dryRun: false,
    };
    await events.append([event(workItem, 'work-item.reopened', reopened, 'triage')]);
    await database.as.line`update line set moved_at = moved_at - interval '2 minutes' where work_item = ${workItem}`;
    github.refusing.set('reopenIssue', new GitHubWorkerError(404, 'not-found', 'Not Found'));
    await pass(it);
    expect(github.acts.at(-1)?.action).toBe('openIssue');
    const [row] = await database.as.line<{ stage: string; issue: number }[]>`
      select stage, issue from line where work_item = ${workItem}`;
    expect(row).toEqual({ stage: 'plan', issue: 41 });
  });

  it('verifies a dry run’s work item by the dry run’s word, and closes it, only in a dry run', async () => {
    // A line no longer in a dry run has nothing to verify it by: it closes it with no change (below).
    const left = await merged(1_000_000_002, 'e'.repeat(40));
    await promote(left, 'dry-run-eeeeeeeeeeee', 'e'.repeat(40), true);
    const live = line({ release: null });
    await pass(live.line);
    expect(await types(left)).not.toContain('verification.finished');
    expect(await payloads(left, 'work-item.closed')).toMatchObject([{ outcome: 'no-change' }]);

    const workItem = await merged(1_000_000_001, 'd'.repeat(40));
    await promote(workItem, 'dry-run-dddddddddddd', 'd'.repeat(40), true);

    const { line: it, github } = line({ release: null, dryRun: true });
    await pass(it);
    await pass(it);
    expect(await payloads(workItem, 'verification.finished')).toEqual([
      expect.objectContaining({ outcome: 'cleared', sense: 'probe', dryRun: true }),
    ]);
    expect(github.acts.at(-1)).toMatchObject({ action: 'closeIssue', args: { reason: 'completed' } });
    expect(await payloads(workItem, 'work-item.closed')).toEqual([
      { outcome: 'verified', reason: 'The dry run’s word: its release never shipped, so no sense looked' },
    ]);
    expect(await stage(workItem)).toBe('ended');
    expect(spans('verify').map((span) => span.attributes)).toEqual([
      { work_item: workItem, release: 'dry-run-dddddddddddd', outcome: 'cleared' },
    ]);
  });

  describe('what a dry run left, as the line runs live', () => {
    it('closes each work item whose pull request or issue was the dry run’s with no change, and a real issue', async () => {
      const atRelease = await merged(1_000_000_001, 'd'.repeat(40));
      const atVerify = await merged(1_000_000_002, 'e'.repeat(40));
      await promote(atVerify, 'dry-run-eeeeeeeeeeee', 'e'.repeat(40), true);
      const gone = await opened();
      await events.append([pushed(gone, 1_000_000_004)]);
      await database.owner`insert into line (work_item, stage, issue) values (${gone}, 'gates', 8)`;
      // Its pull request open still, on a ticket the line took before the dry run, with an issue GitHub has.
      const open = await opened();
      await events.append([pushed(open, 1_000_000_003)]);
      await database.owner`insert into line (work_item, stage, issue) values (${open}, 'gates', 7)`;
      // Taken by the dry run, with no pull request yet: its issue is the dry run's.
      const taken = await opened();
      await database.owner`insert into line (work_item, stage, issue) values (${taken}, 'plan', 1000000005)`;
      // Reopened by triage, and waiting to come back into Plan, which forgets its issue: it is left to that.
      const back = await opened();
      await events.append([
        event(back, 'work-item.closed', { outcome: 'verified', reason: 'Cleared' }, 'factory'),
        event(
          back,
          'work-item.reopened',
          {
            sense: 'probe',
            check: 'departments',
            route: '/',
            version: commitOf(STABLE),
            reason: 'Back',
            dryRun: false,
          },
          'triage',
        ),
      ]);
      await database.owner`insert into line (work_item, stage, issue) values (${back}, 'ended', 1000000006)`;
      const real = await merged(30, FIX_3);
      const { line: it, github } = line({ release: null, gatesEveryMs: 0 });
      // GitHub fails once: that one is tried again on the next pass. One whose issue is gone closes all the same.
      github.refusing.set('closeIssue', new GitHubWorkerError(404, 'not-found', 'Not Found'));
      github.failing.set('closeIssue', 1);
      await pass(it);
      await pass(it);
      const merge = 'A dry run merged its fix, which never shipped: the line, running live, closed it';
      expect(await payloads(atRelease, 'work-item.closed')).toEqual([{ outcome: 'no-change', reason: merge }]);
      expect(await payloads(atVerify, 'work-item.closed')).toEqual([{ outcome: 'no-change', reason: merge }]);
      const unmerged = 'Its pull request was a dry run’s, which GitHub never had: the line, running live, closed it';
      expect(await payloads(open, 'work-item.closed')).toEqual([{ outcome: 'no-change', reason: unmerged }]);
      expect(await payloads(taken, 'work-item.closed')).toEqual([
        {
          outcome: 'no-change',
          reason: 'Its issue was a dry run’s, which GitHub never had: the line, running live, closed it',
        },
      ]);
      expect(await payloads(gone, 'work-item.closed')).toEqual([{ outcome: 'no-change', reason: unmerged }]);
      expect(github.acts.filter((a) => a.action !== 'describeDeploy')).toEqual([
        {
          action: 'closeIssue',
          args: {
            number: 7,
            reason: 'not_planned',
            comment: [
              `${unmerged}.`,
              '',
              `The factory’s work item #${open} is closed with no change: the next signal of this defect opens a fresh ticket.`,
            ].join('\n'),
          },
        },
      ]);
      // The close names its work item, as the line's other issue actions do.
      expect(github.actingFor.filter((_, i) => github.acts[i]?.action === 'closeIssue')).toEqual([{ workItem: open }]);
      await pass(it);
      const stages = await Promise.all([atRelease, atVerify, open, taken].map(stage));
      expect(stages).toEqual(['ended', 'ended', 'ended', 'ended']);
      // The real merge waits for a real release, and nothing is closed twice.
      expect(await payloads(real, 'work-item.closed')).toEqual([]);
      expect(await payloads(back, 'work-item.closed')).toHaveLength(1);
      expect(await payloads(atRelease, 'work-item.closed')).toHaveLength(1);
    });

    it('closes an improvement the dry run handed over, whose row has ended, saying so on no issue GitHub had', async () => {
      const workItem = await nextWorkItem(database.admin);
      await martin.append([
        event(workItem, 'work-item.opened', { kind: 'improvement', title: 'Delivery dates', sample: false }, 'martin'),
        event(workItem, 'improvement.requested', { words: 'Delivery dates.', steppedUp: true }, 'martin'),
      ]);
      await events.append([
        pushed(workItem, 1_000_000_001),
        event(
          workItem,
          'pull-request.merged',
          { number: 1_000_000_001, commit: 'd'.repeat(40), by: 'martin' },
          'martin',
        ),
      ]);
      await promote(workItem, 'dry-run-dddddddddddd', 'd'.repeat(40), true);
      // Another line, going live at the same time, holds it: this one leaves it to that.
      await database.owner`
        insert into line (work_item, stage, issue, held_by, held_until)
        values (${workItem}, 'ended', 1000000000, 'other', clock_timestamp() + interval '1 hour')`;
      const { line: it, github } = line({ release: null });
      await pass(it);
      expect(await payloads(workItem, 'work-item.closed')).toEqual([]);
      await database.owner`update line set held_until = clock_timestamp() - interval '1 second'`;
      await pass(it);
      expect(await payloads(workItem, 'work-item.closed')).toEqual([
        {
          outcome: 'no-change',
          reason: 'A dry run merged its improvement, which never shipped: the line, running live, closed it',
        },
      ]);
      expect(github.acts.filter((a) => a.action !== 'describeDeploy')).toEqual([]);
      await pass(it);
      expect(await payloads(workItem, 'work-item.closed')).toHaveLength(1);
    });

    it('reopens a ticket the dry run verified, and takes it back into Plan with a new issue', async () => {
      const workItem = await merged(1_000_000_001, 'd'.repeat(40));
      await promote(workItem, 'dry-run-dddddddddddd', 'd'.repeat(40), true);
      const dry = line({ release: null, dryRun: true });
      await pass(dry.line);
      await pass(dry.line);
      expect(await stage(workItem)).toBe('ended');
      await database.as.line`update line set moved_at = moved_at - interval '2 minutes' where work_item = ${workItem}`;

      const steps = new FakeSteps(database.as.gateway, { planner: () => 'fails' });
      const { line: it, github } = line({ release: null, steps });
      await pass(it);
      expect(await payloads(workItem, 'work-item.reopened')).toEqual([
        {
          sense: 'probe',
          check: 'departments',
          route: '/departments/:department',
          version: commitOf(STABLE),
          reason: 'A dry run verified it, and its fix never shipped: the line, running live, takes it again',
          dryRun: true,
        },
      ]);
      // Its issue was the dry run's, which GitHub never had: the line opens one, and the planner starts afresh, told
      // of no fix that came back.
      expect(github.acts.map((a) => a.action)).toEqual(['openIssue']);
      expect(await stage(workItem)).toBe('plan');
      expect(steps.requests.at(-1)).toMatchObject({ agent: 'planner', workItem, round: 1 });
      expect(steps.requests.at(-1)?.prompt).not.toContain('came back');
      await pass(it);
      expect(await payloads(workItem, 'work-item.reopened')).toHaveLength(1);
    });

    it('ends nothing for a line that is still in a dry run', async () => {
      const workItem = await merged(1_000_000_001, 'd'.repeat(40));
      const { line: it } = line({ release: null, dryRun: true });
      await pass(it);
      expect(await payloads(workItem, 'work-item.closed')).toEqual([]);
    });
  });

  describe('with the pictures taken while its release ran as a canary', () => {
    /** A page's screenshot; a boxed one boxes the heading and, for another sense's finding, the cards. */
    const shot = (fill: string, path: string, version: string, boxed = false): Shot => ({
      kind: 'screenshot',
      hash: fill.repeat(64),
      type: 'image/png',
      size: 2048,
      route: path.startsWith('/departments/') ? '/departments/:department' : path,
      version,
      width: 1280,
      height: 1600,
      boxes: boxed
        ? [
            { x: 40, y: 200, width: 600, height: 120, kind: 'problem' },
            { x: 40, y: 900, width: 1200, height: 400, kind: 'problem' },
          ]
        : [],
      ...(boxed && { selectors: ['main h1', '.cards'] }),
    });
    /** Every page on the version before and on the release's, as the probes worker indexed them. */
    async function pictured() {
      const index = new PictureIndex(database.as.probes);
      const [before, after] = [commitOf(STABLE), commitOf(CANARY)];
      const page = (path: string, fills: string, changed: number, boxed = false): Picture => ({
        canary: after,
        stable: before,
        path,
        route: shot('0', path, after).route,
        before: shot(fills[0] as string, path, before, boxed),
        after: shot(fills[1] as string, path, after, boxed),
        changed,
        diff: changed ? shot(fills[2] as string, path, after) : null,
        rollout: null,
      });
      await index.record([
        page('/', '11', 0),
        page('/about', '234', 0.3),
        page('/departments/garden', '5678', 0.02, true),
        page('/departments/home', '99', 0),
      ]);
      // After the promotion, the page with a box, again.
      await index.rolledOut(
        { canary: after, stable: before, path: '/departments/garden' },
        shot('8', '/departments/garden', after, true),
      );
      return index;
    }
    const screenshotsOf = async (workItem: string, type: string) =>
      (
        await database.as.line<{ artifacts: Screenshot[] }[]>`
          select artifacts from events where work_item = ${workItem} and type = ${type} order by seq desc limit 1`
      )[0]?.artifacts ?? [];
    const artifactsOf = async (workItem: string, type: string) =>
      (await screenshotsOf(workItem, type)).map((a) => a.hash[0]);
    /** The depth of each box, by the place and hash of the screenshots with any. */
    const boxesOf = async (workItem: string, type: string) =>
      Object.fromEntries(
        (await screenshotsOf(workItem, type))
          .map((a, i) => [`${i} ${a.hash[0]}`, a.boxes.map((b) => b.y)] as const)
          .filter(([, ys]) => ys.length),
      );
    const lineWithPictures = async (options: Partial<LineOptions>) =>
      line({
        release: null,
        events: new EventWriter(database.as.line, { kind: 'real', artifacts: new IndexedArtifacts(database.as.line) }),
        pictures: await pictured(),
        ...options,
      });

    it('names every page against the version before, the ticket’s own first and intended, with their screenshots', async () => {
      const workItem = await merged(30, FIX_3);
      await promote(workItem);
      // The probe's signal was seen on the garden's page, with the heading boxed.
      await new PictureIndex(database.as.probes).remember(
        {
          sense: 'probe',
          check: 'departments',
          route: '/departments/:department',
          path: '/departments/garden',
          elements: [{ selector: 'main h1', kind: 'problem' }],
        },
        new Date(now),
      );
      const probes = new FakeProbes({ outcome: 'cleared', version: commitOf(CANARY), runs: ['passed', 'passed'] });
      const { line: it } = await lineWithPictures({ verify: { probes } });
      await pass(it);
      expect((await payloads(workItem, 'verification.finished'))[0]?.pages).toEqual([
        {
          page: '/departments/garden',
          route: '/departments/:department',
          screenshot: '6'.repeat(64),
          changed: 0.02,
          intended: true,
        },
        { page: '/about', route: '/about', screenshot: '3'.repeat(64), changed: 0.3, intended: false },
        { page: '/', route: '/', screenshot: '1'.repeat(64), changed: 0, intended: false },
        {
          page: '/departments/home',
          route: '/departments/:department',
          screenshot: '9'.repeat(64),
          changed: 0,
          intended: false,
        },
      ]);
      // Each page before and after, in that order, then the ticket's own page after the rollout, with its box.
      expect(await artifactsOf(workItem, 'verification.finished')).toEqual([
        '5',
        '6',
        '2',
        '3',
        '1',
        '1',
        '9',
        '9',
        '8',
      ]);
      // Only the heading its own check boxed, not the cards another sense's finding did; and nothing the index keeps.
      expect(await boxesOf(workItem, 'verification.finished')).toEqual({ '0 5': [200], '1 6': [200], '8 8': [200] });
      for (const a of await screenshotsOf(workItem, 'verification.finished')) expect(a).not.toHaveProperty('selectors');
    });

    it('names the other work item the release carried on a page that is its own, and not the ticket’s', async () => {
      const workItem = await merged(30, FIX_3);
      await promote(workItem);
      // The release carried another work item too, whose sense boxes nothing: its own pages are its route's.
      const other = await opened('logs');
      const payload = { release: 'f00dfeed01', version: commitOf(CANARY), previous: commitOf(STABLE) };
      await events.append([
        event(
          other,
          'release.started',
          { ...payload, commit: payload.version, watched: true, dryRun: false, steps: null, image: IMAGE },
          'rollouts',
        ),
      ]);
      await new PictureIndex(database.as.probes).remember(
        {
          sense: 'probe',
          check: 'departments',
          route: '/departments/:department',
          path: '/departments/garden',
          elements: [{ selector: 'main h1', kind: 'problem' }],
        },
        new Date(now),
      );
      const probes = new FakeProbes({ outcome: 'cleared', version: commitOf(CANARY), runs: ['passed', 'passed'] });
      const { line: it } = await lineWithPictures({ verify: { probes } });
      await pass(it);
      const pages = (await payloads(workItem, 'verification.finished'))[0]?.pages;
      expect(pages?.map((p) => [p.page, p.intended, p.intendedFor])).toEqual([
        ['/departments/garden', true, undefined],
        ['/about', false, undefined],
        ['/departments/home', false, other],
        ['/', false, undefined],
      ]);
    });

    it('holds a visitor’s report for Martin with every page before and after, its route’s pages intended', async () => {
      const workItem = await merged(30, FIX_3, 'report');
      await promote(workItem);
      const { line: it } = await lineWithPictures({});
      await pass(it);
      expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({ stage: 'verify', cause: 'verify' });
      // With no box to say which, every page of the report's route is its own.
      // A visitor's report boxes nothing: its pictures carry none of the boxes other checks drew, and no page after
      // the rollout, which only another check's box was the reason for.
      expect(await artifactsOf(workItem, 'hold.started')).toEqual(['5', '6', '9', '9', '2', '3', '1', '1']);
      expect(await boxesOf(workItem, 'hold.started')).toEqual({});
    });

    it('names none for a release the probes worker did not picture', async () => {
      const workItem = await merged(30, FIX_3);
      await promote(workItem, 'f00dfeed03', 'd'.repeat(40));
      const probes = new FakeProbes({ outcome: 'cleared', version: 'd'.repeat(40), runs: ['passed', 'passed'] });
      const { line: it } = await lineWithPictures({ verify: { probes } });
      await pass(it);
      expect((await payloads(workItem, 'verification.finished'))[0]?.pages).toEqual([]);
      expect(await artifactsOf(workItem, 'verification.finished')).toEqual([]);
    });
  });
});
