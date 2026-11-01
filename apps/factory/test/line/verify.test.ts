/**
 * Verify, by each sense, against stand-ins for the probes worker, Prometheus and Loki: what clears, what persists, and
 * what cannot tell yet, which is never a clear.
 */
import { describe, expect, it } from 'vitest';
import type { Sample } from '../../src/clients/http.ts';
import { Loki } from '../../src/clients/loki.ts';
import { Prometheus } from '../../src/clients/prometheus.ts';
import {
  closingComment,
  closingPullComment,
  type FirstSignal,
  judgeObjective,
  type LookOptions,
  look,
  onRoute,
  reopeningComment,
  type Target,
  whatCleared,
  whatClearedOnLook,
} from '../../src/line/verify.ts';
import { FakeProbes } from './fakes.ts';

const VERSION = 'b'.repeat(40);
const BEFORE = 'a'.repeat(40);
const PROMOTED = Date.parse('2026-10-11T09:00:00Z');
const target: Target = { version: VERSION, at: new Date(PROMOTED), against: BEFORE, dryRun: false };
/** An hour after the promotion: every window has ended. */
const later = new Date(PROMOTED + 60 * 60_000);
const options = (more: Partial<LookOptions> = {}): LookOptions => ({ now: later, dryRun: false, ...more });

const probe: FirstSignal = {
  sense: 'probe',
  check: 'departments/redirect-loop',
  route: '/departments/:department',
  evidence: [],
};

describe('Verify by a probe or the crawler', () => {
  it('clears when the check passes twice in a row on the version the release promoted', async () => {
    const probes = new FakeProbes({ outcome: 'cleared', version: VERSION, runs: ['passed', 'passed'] });
    expect(await look(probe, target, options({ probes }))).toEqual({
      kind: 'finished',
      verification: {
        outcome: 'cleared',
        sense: 'probe',
        check: 'departments/redirect-loop',
        version: VERSION,
        against: BEFORE,
        pages: [],
        dryRun: false,
      },
    });
    expect(probes.asked).toEqual([
      { sense: 'probe', check: 'departments/redirect-loop', route: '/departments/:department' },
    ]);
  });

  it('persists when it fails twice in a row, with the proof of the last failure', async () => {
    const http = {
      kind: 'http' as const,
      method: 'GET' as const,
      url: '/departments/garden',
      status: null,
      headers: {},
      timings: { firstByteMs: 3, totalMs: 40 },
      redirects: [{ status: 302, location: '/departments/garden' }],
    };
    const probes = new FakeProbes({
      outcome: 'persists',
      version: VERSION,
      runs: ['failed', 'failed'],
      evidence: http,
    });
    const crawler = { ...probe, sense: 'crawler' as const, check: 'redirect-loop@/departments/:department' };
    expect(await look(crawler, target, options({ probes }))).toMatchObject({
      kind: 'finished',
      verification: { outcome: 'persists', sense: 'crawler', evidence: http },
    });
    expect(probes.asked[0]?.sense).toBe('crawler');
  });

  it('cannot tell when the check could not, when the stable Service runs another version, or with no way to ask', async () => {
    const unsure = new FakeProbes({ outcome: 'unsure', version: VERSION, runs: ['passed', 'unsure'], message: 'Slow' });
    expect(await look(probe, target, options({ probes: unsure }))).toMatchObject({ kind: 'wait' });
    const old = new FakeProbes({ outcome: 'cleared', version: BEFORE, runs: ['passed', 'passed'] });
    expect(await look(probe, target, options({ probes: old }))).toEqual({
      kind: 'wait',
      why: `the stable Service runs ${BEFORE}, not ${VERSION}`,
    });
    // A short commit names the same version.
    const short = new FakeProbes({ outcome: 'cleared', version: VERSION.slice(0, 7), runs: ['passed', 'passed'] });
    expect(await look(probe, target, options({ probes: short }))).toMatchObject({ kind: 'finished' });
    expect(await look(probe, target, options())).toMatchObject({ kind: 'wait' });
  });
});

/** Prometheus answering the requests in the window, and the objective's series at one point a minute. */
function prometheus(requests: number, series: (number | null)[]) {
  const asked: string[] = [];
  const client = new Prometheus('http://prometheus.test', async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get('query') ?? '';
    asked.push(query);
    if (url.pathname === '/api/v1/query') {
      return Response.json({ data: { result: [{ metric: {}, value: [0, String(requests)] }] } });
    }
    const start = Number(url.searchParams.get('start'));
    const values = series.flatMap((value, i) => (value === null ? [] : [[start + i * 60, String(value)]]));
    return Response.json({ data: { result: [{ metric: {}, values }] } });
  });
  return { client, asked };
}

const alert: FirstSignal = { sense: 'metrics', check: 'error ratio', route: '/departments/:department', evidence: [] };
const inside = Array.from({ length: 16 }, () => 0.01);

describe('Verify by an alert on an objective', () => {
  it('clears when the expression stays inside the objective, over the new version’s requests to the route alone', async () => {
    const { client, asked } = prometheus(450, inside);
    const found = await look(alert, target, options({ prometheus: client }));
    expect(found).toMatchObject({
      kind: 'finished',
      verification: {
        outcome: 'cleared',
        sense: 'metrics',
        check: 'error ratio',
        evidence: { kind: 'metric', name: 'Share of requests with a 5xx status', objective: 0.05, stepSeconds: 60 },
      },
    });
    // Every path of the route's, from the new version only; the requests counted over the whole window.
    for (const query of asked) {
      expect(query).toContain('http_route=~"/departments/[^/]+"');
      expect(query).toContain(`service_version="${VERSION}"`);
    }
    expect(asked[0]).toContain('[30m]');
  });

  it('persists when the expression is outside the objective for as long as the alert waits', async () => {
    const { client } = prometheus(450, [...inside.slice(0, 13), 0.2, 0.3, 0.25]);
    expect(await look(alert, target, options({ prometheus: client }))).toMatchObject({
      kind: 'finished',
      verification: { outcome: 'persists' },
    });
  });

  it('cannot tell too soon after the promotion, with too few requests, or on a blip shorter than an alert waits', async () => {
    const soon = prometheus(450, inside);
    const early = new Date(PROMOTED + 10 * 60_000);
    expect(await look(alert, target, options({ prometheus: soon.client, now: early }))).toMatchObject({
      kind: 'wait',
    });
    expect(soon.asked).toEqual([]);
    // Inside the objective throughout, on too little traffic, is not a clear.
    const quiet = prometheus(12, inside);
    expect(await look(alert, target, options({ prometheus: quiet.client }))).toEqual({
      kind: 'wait',
      why: 'the new version served 12 requests, fewer than 20',
    });
    const blip = prometheus(450, [...inside.slice(0, 8), 0.2, ...inside.slice(0, 7)]);
    expect(await look(alert, target, options({ prometheus: blip.client }))).toMatchObject({ kind: 'wait' });
    expect(await look(alert, target, options())).toMatchObject({ kind: 'wait' });
  });

  it('judges a series as the alert would', () => {
    const judge = (values: (number | null)[], served = 100) =>
      judgeObjective(values, { threshold: 1, served, minRequests: 20, holdPoints: 2 });
    expect(judge([0.5, 0.6, null, 0.4])).toEqual({ kind: 'judged', outcome: 'cleared' });
    expect(judge([0.5, 1.5, 1.2, 0.4])).toEqual({ kind: 'judged', outcome: 'persists' });
    // Outside, then no value, then outside: never twice in a row.
    expect(judge([1.5, null, 1.2])).toMatchObject({ kind: 'wait' });
    expect(judge([null, null])).toMatchObject({ kind: 'wait' });
    expect(judge([1.5, 1.5], 10)).toMatchObject({ kind: 'wait' });
  });
});

/** Loki answering the error records and the requests counted, and keeping what it was asked. */
function loki(records: { line: string; fields: Record<string, string> }[], requests: number) {
  const asked: string[] = [];
  const client = new Loki('http://loki.test', async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get('query') ?? '';
    asked.push(query);
    if (url.pathname === '/loki/api/v1/query') {
      return Response.json({ data: { result: [{ metric: {}, value: [0, String(requests)] }] } });
    }
    const start = BigInt(url.searchParams.get('start') ?? '0');
    return Response.json({
      data: {
        result: records.map((record, i) => ({
          stream: record.fields,
          values: [[String(start + BigInt(i + 1) * 1_000_000_000n), record.line]],
        })),
      },
    });
  });
  return { client, asked };
}

/** The log watcher's signal: the lines it kept, with the path a visitor asked for in them. */
const logs: FirstSignal = {
  sense: 'logs',
  check: 'new error pattern',
  route: '/departments/:department',
  evidence: [
    {
      kind: 'logs',
      route: '/departments/:department',
      version: BEFORE,
      requests: 3,
      lines: [
        {
          ts: '2026-10-11T08:00:00.000Z',
          level: 'error',
          message: 'GET /departments/garden failed: TypeError: Cannot read properties of undefined (reading "slug")',
          traceId: null,
        },
      ],
    },
  ],
};
const error = (path: string, message: string, route = '/departments/:department') => ({
  line: `GET ${path} failed`,
  fields: {
    route,
    path,
    exception_type: 'TypeError',
    exception_message: message,
    service_version: VERSION,
    trace_id: 'f'.repeat(32),
  },
});

describe('Verify by the log watcher', () => {
  it('persists on a record of the same pattern from the new version, on another of the route’s paths', async () => {
    const { client, asked } = loki(
      [
        error('/departments/kitchen', 'Cannot read properties of undefined (reading "slug")'),
        error('/departments/kitchen', 'Something else entirely'),
        error('/about', 'Cannot read properties of undefined (reading "slug")', '/about'),
      ],
      300,
    );
    const found = await look(logs, target, options({ loki: client }));
    expect(found).toMatchObject({
      kind: 'finished',
      verification: { outcome: 'persists', sense: 'logs', version: VERSION },
    });
    const evidence = found.kind === 'finished' ? found.verification.evidence : undefined;
    expect(evidence).toMatchObject({ kind: 'logs', requests: 300, route: '/departments/:department' });
    expect(evidence?.kind === 'logs' && evidence.lines.map((l) => l.message)).toEqual([
      'GET /departments/kitchen failed: TypeError: Cannot read properties of undefined (reading "slug")',
    ]);
    for (const query of asked) expect(query).toContain(`service_version="${VERSION}"`);
    // Only the route's errors are read, so other routes' never crowd them out.
    expect(asked.find((q) => q.includes('severity_text'))).toContain('route="/departments/:department"');
    expect(asked.find((q) => q.includes('count_over_time'))).toContain('route="/departments/:department"');
  });

  it('clears with no record of the pattern in a window with traffic, and cannot tell in one without', async () => {
    const quietly = loki([error('/departments/kitchen', 'Something else entirely')], 300);
    expect(await look(logs, target, options({ loki: quietly.client }))).toMatchObject({
      kind: 'finished',
      verification: { outcome: 'cleared', evidence: { kind: 'logs', requests: 300, lines: [] } },
    });
    const empty = loki([], 4);
    expect(await look(logs, target, options({ loki: empty.client }))).toEqual({
      kind: 'wait',
      why: 'the new version logged 4 requests, fewer than 20',
    });
    // As many records as one look reads, none of them the pattern: the rest might be.
    const crowded = loki(
      Array.from({ length: 5_000 }, () => error('/departments/kitchen', 'Something else entirely')),
      300,
    );
    expect(await look(logs, target, options({ loki: crowded.client }))).toMatchObject({ kind: 'wait' });
    const soon = loki([], 300);
    expect(
      await look(logs, target, options({ loki: soon.client, now: new Date(PROMOTED + 5 * 60_000) })),
    ).toMatchObject({ kind: 'wait' });
    expect(await look(logs, target, options())).toMatchObject({ kind: 'wait' });
  });
});

/** One path's requests in each of the watcher's windows, as each record counts them. No `traces`: Tempo has none. */
interface PathCounts {
  metrics: number;
  logs: number;
  traces?: number;
  /** The route the log gives the path; a path the log has no record of has none. */
  route?: string;
  /** Its metrics had a gap in every window. */
  gap?: true;
}

/** Prometheus, Loki and Tempo counting the same requests in every window, and the windows they were asked about. */
function records(paths: Record<string, PathCounts>, { complete = true } = {}) {
  const windows: { start: Date; end: Date }[] = [];
  const asked: string[] = [];
  const entries = Object.entries(paths);
  const prometheus = {
    instant: async (query: string): Promise<Sample[]> => {
      asked.push(query);
      return entries.map(([path, c]) => ({
        labels: { http_route: path, service_version: VERSION, ...(c.gap ? { agreement_gap: 'true' } : {}) },
        value: c.metrics,
      }));
    },
    range: async () => undefined,
  } as unknown as Prometheus;
  const loki = {
    instant: async (query: string): Promise<Sample[]> => {
      asked.push(query);
      // The last day's log places only the paths given a route.
      return entries
        .filter(([, c]) => c.logs > 0 && (c.route !== undefined || !query.includes('[24h]')))
        .map(([path, c]) => ({ labels: { path, route: c.route ?? path }, value: c.logs }));
    },
  } as unknown as Loki;
  const tempo = {
    requestsByRoute: async (_service: string, start: Date, end: Date, version?: string) => {
      windows.push({ start, end });
      asked.push(`version ${version}`);
      const routes = entries.filter(([, c]) => c.traces).map(([route, c]) => ({ route, requests: c.traces ?? 0 }));
      return { routes, complete };
    },
  };
  return { prometheus, loki, tempo, windows, asked };
}

const missingLog: FirstSignal = {
  sense: 'logs',
  check: 'requests in the log',
  route: '/products/:slug',
  symptom: 'missing-log',
  evidence: [{ kind: 'logs', route: '/products/:slug', version: BEFORE, requests: 40, lines: [] }],
};
const wrongMetric: FirstSignal = { ...missingLog, check: 'metrics against logs and traces', symptom: 'wrong-metric' };
const silentLog: FirstSignal = { ...missingLog, route: '*' };
const wrongEverywhere: FirstSignal = { ...wrongMetric, route: '*' };

describe('Verify by the log watcher’s agreement check', () => {
  const logged = { metrics: 10, logs: 10, traces: 10, route: '/products/:slug' };

  it('clears a missing log when every path of the route is logged as the metrics and traces count it', async () => {
    const { windows, asked, ...clients } = records({
      '/products/glove-left': logged,
      '/products/glove-right': logged,
    });
    const found = await look(missingLog, target, options(clients));
    expect(found).toMatchObject({
      kind: 'finished',
      verification: { outcome: 'cleared', sense: 'logs', check: 'requests in the log', version: VERSION },
    });
    expect(found.kind === 'finished' && whatCleared(found.verification)).toBe(
      'The log of bbbbbbb recorded the requests counted elsewhere, for 30 minutes',
    );
    // The watcher's windows, the last ending four minutes ago, none of them before the promotion.
    expect(windows).toHaveLength(6);
    expect(windows.at(-1)?.end).toEqual(new Date(later.getTime() - 4 * 60_000));
    for (const { start } of windows) expect(start.getTime()).toBeGreaterThanOrEqual(PROMOTED);
    // Each record counts the new version's requests alone.
    // Not the last day's log, which places the paths: the metrics' query looks back a day too, for gaps.
    const counted = asked.filter((query) => !query.includes('count_over_time') || !query.includes('[24h]'));
    expect(counted).toHaveLength(18);
    for (const query of counted) expect(query).toMatch(new RegExp(`service_version="${VERSION}"|version ${VERSION}`));
  });

  it('persists while one of the route’s paths leaves no record, though the log never placed it on the route', async () => {
    const clients = records({
      '/products/glove-left': logged,
      '/products/glove-right': { metrics: 10, logs: 0, traces: 10 },
    });
    const found = await look(missingLog, target, options(clients));
    expect(found).toMatchObject({
      kind: 'finished',
      verification: {
        outcome: 'persists',
        evidence: { kind: 'logs', route: '/products/glove-right', version: VERSION, requests: 60, lines: [] },
      },
    });
    // Nor is a page the log gave a route of its own in the last day, though the template would fit it.
    const sibling = records({ '/products/glove-left': logged, '/products/new': { metrics: 10, logs: 0, traces: 10 } });
    const day = {
      ...sibling.loki,
      instant: async (query: string) =>
        query.includes('[24h]')
          ? [{ labels: { path: '/products/new', route: '/products/new' }, value: 9 }]
          : sibling.loki.instant(query, later),
    };
    expect(await look(missingLog, target, options({ ...sibling, loki: day as unknown as Loki }))).toMatchObject({
      verification: { outcome: 'cleared' },
    });
    // Another route's unlogged requests are not the ticket's.
    const elsewhere = records({ '/products/glove-left': logged, '/about': { metrics: 10, logs: 0, traces: 10 } });
    expect(await look(missingLog, target, options(elsewhere))).toMatchObject({
      verification: { outcome: 'cleared' },
    });
  });

  it('judges a missing log on the metrics and the log alone without Tempo, as the watcher does', async () => {
    const { tempo: _, ...cleared } = records({ '/products/glove-left': logged });
    expect(await look(missingLog, target, options(cleared))).toMatchObject({ verification: { outcome: 'cleared' } });
    const { tempo: __, ...missing } = records({ '/products/glove-left': { metrics: 10, logs: 1 } });
    expect(await look(missingLog, target, options(missing))).toMatchObject({ verification: { outcome: 'persists' } });
  });

  it('judges wrong metrics against the log and the traces, and cannot without the traces', async () => {
    const agreeing = records({ '/products/glove-left': logged });
    const cleared = await look(wrongMetric, target, options(agreeing));
    expect(cleared).toMatchObject({ verification: { outcome: 'cleared', check: 'metrics against logs and traces' } });
    expect(cleared.kind === 'finished' && whatCleared(cleared.verification)).toBe(
      'The metrics of bbbbbbb counted the requests its log and traces did, for 30 minutes',
    );
    const wrong = records({ '/products/glove-left': { ...logged, metrics: 30 } });
    expect(await look(wrongMetric, target, options(wrong))).toMatchObject({ verification: { outcome: 'persists' } });
    const { tempo: _, ...noTempo } = agreeing;
    expect(await look(wrongMetric, target, options(noTempo))).toEqual({
      kind: 'wait',
      why: 'the line has no way to Tempo (TEMPO_URL), which says whether the metrics are wrong',
    });
    const late = records({ '/products/glove-left': logged }, { complete: false });
    expect(await look(wrongMetric, target, options(late))).toEqual({
      kind: 'wait',
      why: 'Tempo did not have every trace of the window',
    });
  });

  it('persists on a log silent for every route, and clears once it counts every route’s requests again', async () => {
    const silent = records({
      '/products/glove-left': { metrics: 10, logs: 0, traces: 10 },
      '/about': { metrics: 10, logs: 0, traces: 10 },
    });
    expect(await look(silentLog, target, options(silent))).toMatchObject({
      verification: { outcome: 'persists', evidence: { kind: 'logs', requests: 60, lines: [] } },
    });
    const back = records({ '/products/glove-left': logged, '/about': { ...logged, route: '/about' } });
    expect(await look(silentLog, target, options(back))).toMatchObject({ verification: { outcome: 'cleared' } });
  });

  it('persists on metrics wrong on every route, and clears once every route’s records agree again', async () => {
    const about = { ...logged, route: '/about' };
    const wrong = records({
      '/products/glove-left': { ...logged, metrics: 30 },
      '/about': { ...about, metrics: 30 },
    });
    expect(await look(wrongEverywhere, target, options(wrong))).toMatchObject({
      verification: { outcome: 'persists', check: 'metrics against logs and traces' },
    });
    // Never judged as a silent log: the log counts every request.
    const back = records({ '/products/glove-left': logged, '/about': about });
    const cleared = await look(wrongEverywhere, target, options(back));
    expect(cleared).toMatchObject({ verification: { outcome: 'cleared' } });
    expect(cleared.kind === 'finished' && whatCleared(cleared.verification)).toBe(
      'The metrics of bbbbbbb counted the requests its log and traces did, for 30 minutes',
    );
    // A route too thin to judge stands in neither’s way.
    const thin = records({
      '/products/glove-left': logged,
      '/about': about,
      '/thin': { metrics: 1, logs: 0, traces: 0, route: '/thin' },
    });
    expect(await look(wrongEverywhere, target, options(thin))).toMatchObject({ verification: { outcome: 'cleared' } });
  });

  it('waits on metrics wrong on some routes and not others, a gap, too few requests or traces', async () => {
    const about = { ...logged, route: '/about' };
    const some = records({ '/products/glove-left': { ...logged, metrics: 30 }, '/about': about });
    expect(await look(wrongEverywhere, target, options(some))).toEqual({
      kind: 'wait',
      why: 'the records disagree on some routes and not others, so the metrics are not wrong on every one',
    });
    const gapped = records({ '/products/glove-left': logged, '/about': { ...about, gap: true } });
    expect(await look(wrongEverywhere, target, options(gapped))).toEqual({
      kind: 'wait',
      why: 'the metrics had a gap',
    });
    const thin = records({ '/products/glove-left': { metrics: 1, logs: 1, traces: 1 } });
    expect(await look(wrongEverywhere, target, options(thin))).toEqual({
      kind: 'wait',
      why: 'no route had 20 requests on the new version',
    });
    const late = records({ '/products/glove-left': logged, '/about': about }, { complete: false });
    expect(await look(wrongEverywhere, target, options(late))).toEqual({
      kind: 'wait',
      why: 'Tempo did not have every trace of the window',
    });
  });

  it('waits while the metrics of the route had a gap, whichever way they read', async () => {
    const gap = { kind: 'wait', why: 'the metrics had a gap' };
    for (const signal of [wrongMetric, missingLog]) {
      const gapped = records({ '/products/glove-left': { ...logged, metrics: 4021, gap: true } });
      expect(await look(signal, target, options(gapped))).toEqual(gap);
      const agreeing = records({ '/products/glove-left': { ...logged, gap: true } });
      expect(await look(signal, target, options(agreeing))).toEqual(gap);
    }
    // A path with no gap still shows the ticket persists, as the watcher would judge it.
    const beside = records({
      '/products/glove-left': { metrics: 10, logs: 0, traces: 10 },
      '/products/glove-right': { ...logged, metrics: 4021, gap: true },
    });
    expect(await look(missingLog, target, options(beside))).toMatchObject({ verification: { outcome: 'persists' } });
    // Another route's gap is not the ticket's.
    const elsewhere = records({ '/products/glove-left': logged, '/about': { ...logged, route: '/about', gap: true } });
    expect(await look(wrongMetric, target, options(elsewhere))).toMatchObject({ verification: { outcome: 'cleared' } });
    // On `*`, the other routes are judged; with too few requests left, it waits on the gap.
    const back = records({
      '/products/glove-left': { ...logged, gap: true },
      '/about': { ...logged, route: '/about' },
    });
    expect(await look(silentLog, target, options(back))).toMatchObject({ verification: { outcome: 'cleared' } });
    const thin = records({
      '/products/glove-left': { ...logged, gap: true },
      '/about': { metrics: 1, logs: 1, traces: 1, route: '/about' },
    });
    expect(await look(silentLog, target, options(thin))).toEqual(gap);
  });

  it('cannot tell too soon after the promotion, on too few requests, or on records that disagree otherwise', async () => {
    const clients = records({ '/products/glove-left': logged });
    // Six windows of five minutes, and the last must have ended four minutes ago.
    expect(await look(missingLog, target, options({ ...clients, now: new Date(PROMOTED + 33 * 60_000) }))).toEqual({
      kind: 'wait',
      why: 'the window ends at 2026-10-11T09:34:00.000Z',
    });
    expect(
      await look(missingLog, target, options({ ...clients, now: new Date(PROMOTED + 34 * 60_000) })),
    ).toMatchObject({ kind: 'finished' });
    const thin = records({ '/products/glove-left': { metrics: 1, logs: 1, traces: 1 } });
    expect(await look(missingLog, target, options(thin))).toEqual({
      kind: 'wait',
      why: 'the route had 6 requests on the new version, fewer than 20',
    });
    expect(await look(silentLog, target, options(thin))).toMatchObject({ kind: 'wait' });
    // Persisting takes as many requests as clearing does.
    const thinlyUnlogged = records({ '/products/glove-left': { metrics: 1, logs: 0, traces: 1 } });
    expect(await look(missingLog, target, options(thinlyUnlogged))).toMatchObject({ kind: 'wait' });
    // More log records than requests: not a missing log, and not a log that agrees either.
    const over = records({ '/products/glove-left': { ...logged, logs: 30 } });
    expect(await look(missingLog, target, options(over))).toMatchObject({ kind: 'wait' });
    expect(await look(missingLog, target, options({ prometheus: clients.prometheus }))).toEqual({
      kind: 'wait',
      why: 'the line has no way to Loki (LOKI_URL)',
    });
  });
});

describe('a path on a route', () => {
  it.each([
    [{ path: '/products/glove-left', route: '/products/:slug' }, true],
    // A path the log did not place matches the route's template.
    [{ path: '/products/glove-left', route: '/products/glove-left' }, true],
    [{ path: '/products/glove-left/reviews', route: '/products/glove-left/reviews' }, false],
    [{ path: '/products', route: '/products' }, false],
    // One the log placed under another route is that route's.
    [{ path: '/products/new', route: '/products/new-arrivals' }, false],
  ])('%o', (entry, expected) => {
    expect(onRoute(entry, '/products/:slug')).toBe(expected);
  });
});

describe('Verify by the canary', () => {
  const failed = { name: 'latency', phase: 'failed' as const, value: 0.247, limit: 0 };
  const canary: FirstSignal = {
    sense: 'canary',
    check: 'latency',
    route: '*',
    evidence: [{ kind: 'canary', release: '68ff668868', version: BEFORE, against: 'c'.repeat(40), measure: failed }],
  };
  const passing = { name: 'latency', phase: 'successful' as const, value: -0.101, limit: 0 };
  const analysed = (measures: (typeof passing)[]): Target => ({
    ...target,
    analysis: { release: '7fc778d748', against: BEFORE, measures },
  });

  it('clears when a release that carries the fix was promoted with the measure that failed passing', async () => {
    const cleared = await look(canary, analysed([passing]), options());
    expect(cleared).toEqual({
      kind: 'finished',
      verification: {
        outcome: 'cleared',
        sense: 'canary',
        check: 'latency',
        version: VERSION,
        against: BEFORE,
        evidence: { kind: 'canary', release: '7fc778d748', version: VERSION, against: BEFORE, measure: passing },
        pages: [],
        dryRun: false,
      },
    });
    expect(cleared.kind === 'finished' && whatCleared(cleared.verification)).toBe(
      'The canary’s latency passed against aaaaaaa as bbbbbbb was released, and it was promoted',
    );
  });

  it('holds for Martin when no analysis judged the release, or its last step did not pass the measure', async () => {
    expect(await look(canary, target, options())).toEqual({
      kind: 'hold',
      reason: 'No analysis judged bbbbbbb, which was found live: Martin judges whether its latency cleared',
    });
    expect(await look(canary, analysed([]), options())).toMatchObject({ kind: 'hold' });
    expect(await look(canary, analysed([{ ...passing, phase: 'inconclusive' as never }]), options())).toMatchObject({
      kind: 'hold',
    });
  });
});

describe('Verify when no sense can look', () => {
  it('holds for Martin when only a visitor’s report, or the planner, saw the defect', async () => {
    const report: FirstSignal = { sense: 'report', check: 'visitor report', route: '/about', evidence: [] };
    expect(await look(report, target, options())).toEqual({
      kind: 'hold',
      reason:
        'Only a visitor’s report saw this defect, and no sense can look at it again: Martin judges whether the fix cleared it',
    });
    expect(await look({ ...report, sense: 'planner' }, target, options())).toMatchObject({ kind: 'hold' });
  });
});

describe('a dry run’s verification', () => {
  const dry: Target = { ...target, dryRun: true };

  it('is the dry run’s word, and says so', async () => {
    const probes = new FakeProbes({ outcome: 'persists', version: VERSION, runs: ['failed', 'failed'] });
    expect(await look(probe, dry, options({ dryRun: true, probes }))).toEqual({
      kind: 'finished',
      verification: {
        outcome: 'cleared',
        sense: 'probe',
        check: 'departments/redirect-loop',
        version: VERSION,
        against: BEFORE,
        pages: [],
        dryRun: true,
      },
    });
    // No sense looked.
    expect(probes.asked).toEqual([]);
    expect(whatCleared({ outcome: 'cleared', check: 'x', against: BEFORE, pages: [], dryRun: true })).toBe(
      'The dry run’s word: its release never shipped, so no sense looked',
    );
  });

  it('holds for Martin outside a dry run, which nothing would verify', async () => {
    expect(await look(probe, dry, options())).toMatchObject({ kind: 'hold' });
  });
});

describe('what cleared a work item, on its issue', () => {
  it('says which sense looked, at which version, or that Martin judged it', () => {
    const cleared = { outcome: 'cleared' as const, version: VERSION, against: BEFORE, pages: [], dryRun: false };
    expect(whatCleared({ ...cleared, sense: 'metrics', check: 'latency p95' })).toBe(
      'The latency p95 of bbbbbbb’s requests stayed inside its objective for 30 minutes',
    );
    expect(
      whatCleared({
        ...cleared,
        sense: 'logs',
        check: 'new error pattern',
        evidence: { kind: 'logs', route: '/about', version: VERSION, requests: 300, lines: [] },
      }),
    ).toBe('No error like the one the log watcher saw came from bbbbbbb in 30 minutes, over 300 requests');
    expect(closingComment(undefined, '1001', 'The page is right now')).toBe(
      [
        'Verified in production. Martin judged it cleared, saying: The page is right now.',
        '',
        'The factory’s work item #1001 is closed as verified.',
      ].join('\n'),
    );
  });

  it('says what a look again found cleared, on a release that did not carry the fix, and what it carried', () => {
    const looked = {
      for: 'release' as const,
      outcome: 'cleared' as const,
      sense: 'probe' as const,
      check: 'search answers',
      release: 'r2',
      version: VERSION,
      against: BEFORE,
      carried: ['1033'],
    };
    expect(whatClearedOnLook(looked)).toBe(
      'The probe’s check “search answers” passed twice in a row on bbbbbbb, a release that carried work item #1033, not this one’s fix',
    );
    expect(whatClearedOnLook({ ...looked, sense: 'metrics', check: 'latency p95', carried: ['1033', '1040'] })).toBe(
      'The latency p95 of bbbbbbb’s requests stayed inside its objective for 30 minutes, on a release that carried work items #1033 and #1040, not this one’s fix',
    );
    expect(whatClearedOnLook({ ...looked, carried: [] })).toMatch(
      /, a release that carried none of the factory’s fixes$/,
    );
    expect(closingComment(undefined, '1028', undefined, looked)).toBe(
      [
        `Verified in production. ${whatClearedOnLook(looked)}.`,
        '',
        'The factory’s work item #1028 is closed as verified.',
      ].join('\n'),
    );
    expect(closingPullComment(looked, '1028').split('\n')[0]).toBe(
      `Closed unmerged: the defect this fixes is gone from production. ${whatClearedOnLook(looked)}.`,
    );
  });

  it('says where it came back: a canary’s every route is routes it could not narrow to one', () => {
    const reopened = {
      sense: 'canary' as const,
      check: 'errors',
      route: '*',
      version: VERSION,
      reason: 'Back',
      dryRun: false,
    };
    expect(reopeningComment(reopened, '1001').split('\n')[0]).toBe(
      'It came back after its fix was verified: the canary saw “errors” again on routes it could not narrow to one, in version bbbbbbb.',
    );
    expect(reopeningComment({ ...reopened, sense: 'crawler' }, '1001')).toMatch(/again on every page, in version/);
  });

  it('says a dry run’s fix never shipped, when the line reopens a ticket the dry run verified', () => {
    const reopened = { sense: 'report' as const, check: 'a report', route: '/', version: VERSION, reason: 'Back' };
    expect(reopeningComment({ ...reopened, dryRun: true }, '1001')).toBe(
      [
        'A dry run verified a fix for this, and that fix never shipped: the defect is still in the app.',
        '',
        'The factory’s work item #1001 is open again, and goes back to Plan for a fix that ships.',
      ].join('\n'),
    );
  });
});
