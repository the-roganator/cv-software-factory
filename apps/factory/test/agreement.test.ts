import type { InboxSignal } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import type { Sample } from '../src/clients/http.ts';
import {
  agree,
  combine,
  count,
  judge,
  logSilent,
  metricsWrongEverywhere,
  type RouteCounts,
  requestsBetween,
  signalForDisagreement,
  signalForSilentLog,
  TOLERANCE,
} from '../src/logs/agreement.ts';
import { type Backends, Watcher } from '../src/logs/watcher.ts';
import { VERSION } from './fakes.ts';

describe('agreeing counts', () => {
  it.each([
    [10, 10, true],
    [10, 12, true], // within three
    [100, 118, true], // within a fifth
    [100, 130, false],
    [0, 4, false],
    [0, 3, true],
  ])('%i and %i: %s', (a, b, expected) => {
    expect(agree(a, b, TOLERANCE)).toBe(expected);
  });
});

describe('judging a route from its three counts', () => {
  it.each([
    ['all agree', { metrics: 40, logs: 41, traces: 40 }, undefined],
    ['a route with almost no traffic is not judged', { metrics: 2, logs: 0, traces: 2 }, undefined],
    ['no log record at all for requests counted elsewhere', { metrics: 40, logs: 0, traces: 40 }, 'missing-log'],
    ['far too few log records', { metrics: 40, logs: 10, traces: 41 }, 'missing-log'],
    ['metrics that count too few', { metrics: 10, logs: 40, traces: 40 }, 'wrong-metric'],
    ['metrics that count too many', { metrics: 90, logs: 40, traces: 41 }, 'wrong-metric'],
    ['all three disagree: nobody can say which is wrong', { metrics: 10, logs: 40, traces: 90 }, undefined],
    ['traces that are late are not the metrics’ fault', { metrics: 40, logs: 40 }, undefined],
    ['without traces, a log that lacks requests the metrics counted', { metrics: 40, logs: 0 }, 'missing-log'],
    ['more log records than requests counted is not a missing log', { metrics: 10, logs: 40, traces: 10 }, undefined],
    ['metrics that had a gap are not judged', { metrics: 4021, logs: 4, traces: 4, gap: true }, undefined],
    ['nor is a log missing beside them', { metrics: 4021, logs: 0, traces: 4021, gap: true }, undefined],
  ] as const)('%s', (_what, counts, expected) => {
    expect(judge(counts)).toBe(expected);
  });
});

const entry = (path: string, metrics: number, logs: number, traces?: number, route = path): RouteCounts => ({
  path,
  route,
  version: VERSION,
  metrics,
  logs,
  ...(traces === undefined ? {} : { traces }),
});

describe('two windows as one', () => {
  it('adds each route’s counts', () => {
    const both = combine([entry('/a', 9, 9, 9), entry('/b', 1, 1, 1)], [entry('/a', 1, 1, 1), entry('/c', 5, 5, 5)]);
    expect(Object.fromEntries(both.map((e) => [e.path, [e.metrics, e.logs, e.traces]]))).toEqual({
      '/a': [10, 10, 10],
      '/b': [1, 1, 1],
      '/c': [5, 5, 5],
    });
  });

  it('puts a burst at the edge of the windows in the same place for every record', () => {
    // The log counted the burst in the first window and the metrics, a minute behind, in the second.
    const first = entry('/a', 0, 9, 9);
    const second = entry('/a', 9, 0, 0);
    expect(judge(first)).toBe('wrong-metric');
    expect(judge(second)).toBe('wrong-metric');
    expect(combine([first], [second]).map((e) => judge(e))).toEqual([undefined]);
  });

  it('keeps a gap in either window', () => {
    const gapped = { ...entry('/a', 900, 1, 1), gap: true };
    expect(combine([gapped], [entry('/a', 1, 1, 1)])[0]?.gap).toBe(true);
    expect(combine([entry('/a', 1, 1, 1)], [gapped])[0]?.gap).toBe(true);
    expect(combine([entry('/a', 1, 1, 1)], [entry('/a', 1, 1, 1)])[0]?.gap).toBeUndefined();
  });

  it('does not know the traces of two windows unless it knew both', () => {
    const [both] = combine([entry('/a', 9, 9, 9)], [entry('/a', 1, 1)]);
    expect(both?.traces).toBeUndefined();
  });
});

describe('counting the metrics', () => {
  it('takes each series’ counter now less its counter then, before summing them', () => {
    const expr = requestsBetween('job="app"', 300);
    expect(expr).toContain('offset 300s');
    expect(expr.startsWith('sum by (http_route, service_version, agreement_gap) (')).toBe(true);
  });

  it('marks the requests of a series that had a gap: one with nothing then, but something in the day before', () => {
    const series = 'http_server_request_duration_seconds_count{job="app", http_route!=""}';
    const gapped = `(${series} and (last_over_time(${series}[24h] offset 300s) unless ${series} offset 300s))`;
    const expr = requestsBetween('job="app"', 300);
    expect(expr).toContain(`unless ${gapped}) or label_replace(${gapped}, "agreement_gap", "true", "", "")`);
  });

  it('counts a series born in the window, or one whose counter restarted, from nothing', () => {
    const expr = requestsBetween('job="app"', 300);
    // A series that did not exist then falls back to itself times zero.
    expect(expr).toContain('or http_server_request_duration_seconds_count{job="app", http_route!=""} * 0');
    // A series whose difference went below zero restarted: what it holds now is what it counted since.
    expect(expr).toMatch(/>= 0\) or \(http_server_request_duration_seconds_count\{[^}]*\} unless/);
  });
});

describe('counting the traces', () => {
  /** A window of `requests` on each path in every record, with Tempo's answer `complete` or not. */
  const counted = (requests: Record<string, number>, complete: boolean) => {
    const samples = Object.entries(requests);
    const backends = {
      prometheus: {
        instant: async () =>
          samples.map(([path, value]) => ({ labels: { http_route: path, service_version: VERSION }, value })),
      },
      loki: { instant: async () => samples.map(([path, value]) => ({ labels: { path, route: path }, value })) },
      tempo: {
        requestsByRoute: async () => ({
          routes: samples.map(([route, value]) => ({ route, requests: value })),
          complete,
        }),
      },
    } as unknown as Parameters<typeof count>[1];
    return count(objectives, backends, new Date(0), new Date(300_000));
  };

  it('knows the traces of a busy window, route by route, as Tempo counted them', async () => {
    // More requests than the thousand traces a page of Tempo's search held.
    const { routes, tracesComplete } = await counted({ '/': 1200, '/about': 300, '/contact': 0 }, true);
    expect(tracesComplete).toBe(true);
    expect(routes.map(({ path, traces }) => [path, traces])).toEqual([
      ['/', 1200],
      ['/about', 300],
      ['/contact', 0],
    ]);
  });

  it('leaves the traces out when Tempo could answer only in part', async () => {
    const { routes, tracesComplete } = await counted({ '/': 1200 }, false);
    expect(tracesComplete).toBe(false);
    expect(routes[0]?.traces).toBeUndefined();
  });
});

describe('counting a route whose metrics had a gap', () => {
  const backends = (samples: Sample[]) =>
    ({
      prometheus: { instant: async () => samples },
      loki: { instant: async () => [{ labels: { path: '/privacy', route: '/privacy' }, value: 4 }] },
      tempo: { requestsByRoute: async () => ({ routes: [{ route: '/privacy', requests: 4 }], complete: true }) },
    }) as unknown as Parameters<typeof count>[1];
  const metric = (value: number, gap?: true): Sample => ({
    labels: { http_route: '/privacy', service_version: VERSION, ...(gap ? { agreement_gap: 'true' } : {}) },
    value,
  });

  it('marks the route when any of its series had one', async () => {
    const { routes } = await count(objectives, backends([metric(3), metric(4018, true)]), at(40), at(45));
    expect(routes).toEqual([
      { path: '/privacy', route: '/privacy', version: VERSION, metrics: 4021, logs: 4, traces: 4, gap: true },
    ]);
    expect(judge(routes[0] as RouteCounts)).toBeUndefined();
  });

  it('gives the route the version that served most of it, its series with a gap and without together', async () => {
    const other = 'v0.9.3';
    const samples = [
      metric(3),
      metric(4, true),
      { labels: { http_route: '/privacy', service_version: other }, value: 5 },
    ];
    const { routes } = await count(objectives, backends(samples), at(40), at(45));
    expect(routes[0]?.version).toBe(VERSION);
  });

  it('judges the route as ever when none had one', async () => {
    const { routes } = await count(objectives, backends([metric(4021)]), at(40), at(45));
    expect(routes[0]?.gap).toBeUndefined();
    expect(judge(routes[0] as RouteCounts)).toBe('wrong-metric');
  });

  it('signals nothing for it, and says so in the watcher’s log, until a pair of windows has no gap', async () => {
    const sent: InboxSignal[] = [];
    const warned: unknown[] = [];
    // The series came back in the second window, with its running total; the windows after count as ever.
    const windows = [[metric(4)], [metric(4021, true)], [metric(4)], [metric(4021)]];
    const watcher = new Watcher(
      {
        ...backends([]),
        prometheus: { instant: async () => windows.shift() ?? [metric(4)], range: async () => undefined },
        objectives,
        outbox: { send: async (signal: InboxSignal) => void sent.push(signal) },
        log: { info: () => {}, warn: (fields: unknown) => void warned.push(fields) },
      } as unknown as Backends,
      { errors: new Date(0), reports: new Date(0) },
    );
    for (const minutes of [44, 49, 54]) await watcher.checkAgreement(at(minutes));
    expect(sent).toEqual([]);
    expect(warned).toEqual([{ paths: 1 }, { paths: 1 }]);
    // A pair with no gap is judged: here metrics that count too many.
    await watcher.checkAgreement(at(59));
    expect(sent.map((s) => [s.route, s.symptom])).toEqual([['/privacy', 'wrong-metric']]);
  });
});

describe('judging windows in pairs', () => {
  it('never pairs a window with one before a gap: a window that could not be counted ends the pair', async () => {
    let failing = false;
    const counted = async () => {
      if (failing) throw new Error('Loki is down');
      return [];
    };
    const backends = {
      objectives,
      prometheus: { instant: counted },
      loki: { instant: counted },
      tempo: { requestsByRoute: async () => ({ routes: [], complete: true }) },
      outbox: { send: async () => {} },
      log: { info: () => {}, warn: () => {} },
    } as unknown as Backends;
    const watcher = new Watcher(backends, { errors: new Date(0), reports: new Date(0) });
    const previous = () => (watcher as unknown as { previousWindow: unknown }).previousWindow;
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 4, 9, minutes));

    await watcher.checkAgreement(at(10));
    expect(previous()).toBeDefined();
    failing = true;
    await expect(watcher.checkAgreement(at(15))).rejects.toThrow('Loki is down');
    expect(previous()).toBeUndefined();
  });
});

describe('a log silent for every route', () => {
  it.each([
    [
      'every route’s requests, and none in the log',
      [entry('/a', 40, 0, 40), entry('/b', 20, 0, 20), entry('/c', 9, 0)],
      true,
    ],
    ['a stray record or two at the edge of the window', [entry('/a', 40, 2, 40), entry('/b', 20, 1, 20)], true],
    ['one route quiet, the others logged', [entry('/a', 40, 0, 40), entry('/b', 20, 20, 20), entry('/c', 9, 9)], false],
    [
      'two routes quiet beside a busy one logged',
      [entry('/a', 40, 0, 40), entry('/b', 20, 0), entry('/c', 90, 90)],
      false,
    ],
    [
      'a quiet log beside a light route logged',
      [entry('/a', 40, 0, 40), entry('/b', 20, 0, 20), entry('/c', 4, 4)],
      false,
    ],
    ['only one route had requests', [entry('/a', 40, 0, 40), entry('/b', 2, 0, 2)], false],
    [
      'two paths of one route are one route',
      [entry('/p/x', 40, 0, 40, '/p/:slug'), entry('/p/y', 20, 0, 20, '/p/:slug')],
      false,
    ],
    ['nothing anywhere', [entry('/a', 0, 0, 0), entry('/b', 0, 0)], false],
    [
      'a route spread thin over many pages still counts',
      [...['1', '2', '3'].map((n) => entry(`/p/${n}`, 3, 0, 3, '/p/:slug')), entry('/', 40, 0, 40)],
      true,
    ],
  ] as const)('%s: %s', (_what, entries, expected) => {
    expect(logSilent([...entries])).toBe(expected);
  });

  const end = new Date(Date.UTC(2026, 9, 13, 19, 47));
  const other = 'v0.9.3';

  it('is one signal on every route, the busiest routes’ logs shown as they should have been', () => {
    const entries = [
      entry('/products/glove-left', 30, 0, 30, '/products/:slug'),
      entry('/products/glove-right', 25, 0, 25, '/products/:slug'),
      entry('/about', 20, 0, 20),
      { ...entry('/departments/home', 60, 0, 60, '/departments/:slug'), version: other },
    ];
    const signal = signalForSilentLog(entries, end) as InboxSignal;
    expect(validateSignal(signal)).toEqual({ ok: true });
    expect(signal).toMatchObject({ sense: 'logs', route: '*', symptom: 'missing-log', version: VERSION });
    expect(signal.evidence).toEqual([
      { kind: 'logs', route: '/departments/:slug', version: other, requests: 60, lines: [] },
      { kind: 'logs', route: '/products/:slug', version: VERSION, requests: 55, lines: [] },
      { kind: 'logs', route: '/about', version: VERSION, requests: 20, lines: [] },
    ]);
  });

  it('shows no more routes than a signal holds', () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry(`/r${i}`, 10 + i, 0));
    const signal = signalForSilentLog(entries, end) as InboxSignal;
    expect(validateSignal(signal)).toEqual({ ok: true });
    expect(signal.evidence?.map((e) => ('route' in e ? e.route : ''))).toEqual([
      '/r11',
      '/r10',
      '/r9',
      '/r8',
      '/r7',
      '/r6',
      '/r5',
      '/r4',
    ]);
  });

  it('is nothing when the metrics do not say which version served the requests', () => {
    expect(signalForSilentLog([{ ...entry('/a', 40, 0), version: undefined }], end)).toBeUndefined();
  });
});

describe('metrics wrong on every route', () => {
  it.each([
    ['every route’s metrics count too many', [entry('/a', 90, 30, 30), entry('/b', 60, 20, 20)], true],
    ['one route’s metrics wrong, another’s right', [entry('/a', 90, 30, 30), entry('/b', 20, 20, 20)], false],
    ['one route’s metrics wrong, another’s log missing', [entry('/a', 90, 30, 30), entry('/b', 20, 0, 20)], false],
    ['only one route judged', [entry('/a', 90, 30, 30), entry('/b', 3, 1, 1)], false],
    [
      'a route too thin to judge stands in no way',
      [entry('/a', 90, 30, 30), entry('/b', 60, 20, 20), entry('/c', 4, 4, 4)],
      true,
    ],
    [
      'a route whose metrics had a gap stands in no way, nor counts',
      [entry('/a', 90, 30, 30), entry('/b', 60, 20, 20), { ...entry('/c', 20, 20, 20), gap: true }],
      true,
    ],
    [
      'a path whose metrics had a gap is left out, and its route judged on the rest',
      [
        entry('/p/x', 90, 30, 30, '/p/:slug'),
        { ...entry('/p/y', 20, 20, 20, '/p/:slug'), gap: true },
        entry('/b', 60, 20, 20),
      ],
      true,
    ],
    [
      'one route and a gap are one route',
      [entry('/a', 90, 30, 30), { ...entry('/b', 4000, 20, 20), gap: true }],
      false,
    ],
    ['without the traces nothing says the metrics are wrong', [entry('/a', 90, 30), entry('/b', 60, 20)], false],
    [
      'two paths of one route are one route',
      [entry('/p/x', 90, 30, 30, '/p/:slug'), entry('/p/y', 60, 20, 20, '/p/:slug')],
      false,
    ],
  ] as const)('%s: %s', (_what, entries, expected) => {
    expect(metricsWrongEverywhere([...entries]) !== undefined).toBe(expected);
  });

  it('sums the wrong routes’ counts on every route, with the version that served most of them', () => {
    const other = 'v0.9.3';
    const everywhere = metricsWrongEverywhere([
      entry('/a', 90, 30, 30),
      { ...entry('/b', 60, 20, 20), version: other },
      entry('/c', 30, 10, 10),
      { ...entry('/d', 20, 20, 20), gap: true },
    ]);
    expect(everywhere).toEqual({ path: '*', route: '*', version: VERSION, metrics: 180, logs: 60, traces: 60 });
  });

  it('is one signal, its picture every route’s requests, its name the summed counts', async () => {
    const queries: string[] = [];
    const prometheus = {
      range: async (query: string, start: Date) => {
        queries.push(query);
        return { start, stepSeconds: 60, values: [3, 4, 5] };
      },
    } as unknown as Parameters<typeof signalForDisagreement>[2]['prometheus'];
    const everywhere = metricsWrongEverywhere([entry('/a', 90, 30, 30), entry('/b', 60, 20, 20)]) as RouteCounts;
    const signal = (await signalForDisagreement(
      'wrong-metric',
      everywhere,
      { objectives, prometheus },
      at(35),
      at(45),
    )) as InboxSignal;
    expect(validateSignal(signal)).toEqual({ ok: true });
    expect(signal).toMatchObject({ sense: 'logs', route: '*', symptom: 'wrong-metric', version: VERSION });
    expect(signal.evidence).toMatchObject([
      { kind: 'metric', name: 'Requests a minute. In 10 minutes: metrics 150, logs 50, traces 50' },
    ]);
    expect(queries[0]).toContain('http_route!=""');
  });

  it('is told once by the watcher, and no route on its own', async () => {
    const sent: InboxSignal[] = [];
    const watcher = new Watcher(
      {
        objectives,
        prometheus: {
          instant: async () =>
            ['/about', '/privacy'].map((path) => ({
              labels: { http_route: path, service_version: VERSION },
              value: 30,
            })),
          range: async () => undefined,
        },
        loki: {
          instant: async (query: string) =>
            query.includes('[24h]')
              ? []
              : ['/about', '/privacy'].map((path) => ({ labels: { path, route: path }, value: 10 })),
        },
        tempo: {
          requestsByRoute: async () => ({
            routes: ['/about', '/privacy'].map((route) => ({ route, requests: 10 })),
            complete: true,
          }),
        },
        outbox: { send: async (signal: InboxSignal) => void sent.push(signal) },
        log: { info: () => {}, warn: () => {} },
      } as unknown as Backends,
      { errors: new Date(0), reports: new Date(0) },
    );
    for (const minutes of [44, 49, 54, 59]) await watcher.checkAgreement(at(minutes));
    expect(sent.map((s) => [s.route, s.symptom])).toEqual([['*', 'wrong-metric']]);
  });
});

/** Backends that answer each query from what a test says the records hold. */
function records(options: {
  metrics: Record<string, number>;
  window: () => Sample[];
  day: () => Sample[] | Promise<Sample[]>;
  sent?: InboxSignal[];
}) {
  const days: string[] = [];
  const backends = {
    objectives,
    prometheus: {
      instant: async () =>
        Object.entries(options.metrics).map(([path, value]) => ({
          labels: { http_route: path, service_version: VERSION },
          value,
        })),
      range: async () => undefined,
    },
    loki: {
      instant: async (query: string) => {
        if (!query.includes('[24h]')) return options.window();
        days.push(query);
        return options.day();
      },
    },
    tempo: { requestsByRoute: async () => ({ routes: [], complete: true }) },
    outbox: { send: async (signal: InboxSignal) => void options.sent?.push(signal) },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Backends;
  return { backends, days };
}

const logged = (path: string, route: string, value: number): Sample => ({ labels: { path, route }, value });
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 13, 19, minutes));

describe('placing a path whose window the log is silent for', () => {
  const metrics = { '/products/glove-left': 30, '/products/glove-right': 20, '/about': 15 };
  const day = [
    logged('/products/glove-left', '/products/:slug', 300),
    logged('/products/glove-right', '/products/:slug', 200),
  ];

  it('takes the route the log gave it before, and the window’s own log first', async () => {
    const { backends } = records({ metrics, window: () => [logged('/about', '/about', 15)], day: () => day });
    const known = new Map([
      ['/products/glove-left', '/products/:slug'],
      ['/about', '/stale'],
    ]);
    const { routes } = await count(objectives, backends, at(40), at(45), known);
    expect(Object.fromEntries(routes.map((e) => [e.path, e.route]))).toEqual({
      '/products/glove-left': '/products/:slug',
      '/products/glove-right': '/products/glove-right',
      '/about': '/about',
    });
  });

  it('signals a route once, not each of its pages, when its log is missing beside a logged one', async () => {
    const sent: InboxSignal[] = [];
    const { backends } = records({ metrics, window: () => [logged('/about', '/about', 15)], day: () => day, sent });
    const watcher = new Watcher(backends, { errors: new Date(0), reports: new Date(0) });
    await watcher.checkAgreement(at(44));
    await watcher.checkAgreement(at(49));
    expect(sent.map((s) => [s.route, s.symptom])).toEqual([['/products/:slug', 'missing-log']]);
  });

  it('signals once for the log as a whole when it is silent for every route', async () => {
    const sent: InboxSignal[] = [];
    const { backends } = records({ metrics, window: () => [], day: () => day, sent });
    const watcher = new Watcher(backends, { errors: new Date(0), reports: new Date(0) });
    for (const minutes of [44, 49, 54, 59]) await watcher.checkAgreement(at(minutes));
    expect(sent.map((s) => [s.route, s.symptom])).toEqual([['*', 'missing-log']]);
    expect(sent[0]?.evidence?.map((e) => ('route' in e ? e.route : ''))).toEqual(['/products/:slug', '/about']);
  });

  it('signals the log once, not each route, at the edges of a gap', async () => {
    const sent: InboxSignal[] = [];
    // The log holds the first window, then nothing for two, then everything again.
    const windows = [[logged('/about', '/about', 15), logged('/products/glove-left', '/products/:slug', 30)], [], []];
    const { backends } = records({
      metrics,
      window: () => windows.shift() ?? [logged('/about', '/about', 15)],
      day: () => day,
      sent,
    });
    const watcher = new Watcher(backends, { errors: new Date(0), reports: new Date(0) });
    for (const minutes of [44, 49, 54]) await watcher.checkAgreement(at(minutes));
    expect(sent.map((s) => [s.route, s.symptom])).toEqual([['*', 'missing-log']]);
    // The window after the gap is judged with the last silent one: the gap still, already told.
    await watcher.checkAgreement(at(59));
    expect(sent).toHaveLength(1);
  });

  it('asks the last day’s log once an hour, and keeps the names it knew when the log has fewer or fails', async () => {
    const sent: InboxSignal[] = [];
    let lookup: () => Sample[] = () => day;
    const { backends, days } = records({
      metrics: { '/products/glove-left': 30, '/about': 15 },
      window: () => [logged('/about', '/about', 15)],
      day: () => lookup(),
      sent,
    });
    const watcher = new Watcher(backends, { errors: new Date(0), reports: new Date(0) });
    const hour = (h: number, m: number) => new Date(Date.UTC(2026, 9, 13, h, m));
    for (const minutes of [4, 9, 14]) await watcher.checkAgreement(hour(19, minutes));
    expect(days).toHaveLength(1);

    // An hour on, the lookup fails, and is not asked again within the hour; then it finds only part of the day.
    lookup = () => {
      throw new Error('Loki is full');
    };
    await watcher.checkAgreement(hour(20, 9));
    await watcher.checkAgreement(hour(20, 14));
    expect(days).toHaveLength(2);
    lookup = () => [logged('/about', '/about', 15)];
    await watcher.checkAgreement(hour(21, 9));
    expect(days).toHaveLength(3);
    // The paths it named before still have their routes.
    expect(sent.map((s) => s.route)).toEqual(['/products/:slug', '/products/:slug', '/products/:slug']);
  });
});
