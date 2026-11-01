/**
 * Agreement. A request leaves three records: a count in the metrics, a record in the log and a trace. Over the same
 * window they should say the same number, route by route. Where one disagrees with the other two, that one is wrong:
 *
 * - a route whose requests leave no log record, or far too few, is `missing-log`;
 * - a route whose metrics count something other than what its logs and traces both saw is `wrong-metric`.
 *
 * When all three disagree, or traces are not there yet, nothing can be said of the odd one out, and nothing is.
 * The window should end a few minutes ago, because a trace reaches Tempo a minute or two late.
 */
import { cutTo, type InboxSignal } from '@software-factory/events';
import type { Objectives } from '../../../../policy/objectives.ts';
import { appSeries, quoted } from '../alerts/queries.ts';
import type { Loki } from '../clients/loki.ts';
import type { Prometheus } from '../clients/prometheus.ts';
import type { Tempo } from '../clients/tempo.ts';
import { requestLogs } from '../routes.ts';

/** The requests one route had in a window, as each record of them says. `traces` is absent when Tempo had none. */
export interface Counts {
  metrics: number;
  logs: number;
  traces?: number;
  /**
   * The metrics had a gap: a series counted now had no sample at the window's start, though it had some in the day
   * before. What it counted in the window cannot be told from its running total, so the route is not judged.
   */
  gap?: boolean;
}

export interface Tolerance {
  /** Counts this close always agree: a request on the edge of the window may land either side of it. */
  absolute: number;
  /** Counts this close, as a share of the larger, agree. */
  relative: number;
  /** A route with fewer requests than this in the window, by every record, is not judged. */
  minRequests: number;
}

export const TOLERANCE: Tolerance = { absolute: 3, relative: 0.2, minRequests: 5 };

export function agree(a: number, b: number, tolerance: Tolerance): boolean {
  return Math.abs(a - b) <= Math.max(tolerance.absolute, tolerance.relative * Math.max(a, b));
}

export type Disagreement = 'missing-log' | 'wrong-metric';

/** The check each disagreement's signal names, and its verification after it. */
export const AGREEMENT_CHECK: Record<Disagreement, string> = {
  'missing-log': 'requests in the log',
  'wrong-metric': 'metrics against logs and traces',
};

/** What the three records' counts for a route say is wrong, if they say. A route whose metrics had a gap is not judged. */
export function judge(
  { metrics, logs, traces, gap }: Counts,
  tolerance: Tolerance = TOLERANCE,
): Disagreement | undefined {
  if (gap) return undefined;
  if (Math.max(metrics, logs, traces ?? 0) < tolerance.minRequests) return undefined;
  const logsAgreeMetrics = agree(logs, metrics, tolerance);
  if (traces === undefined) {
    // Two records cannot say which is wrong, except that a log with too few records leaves requests unlogged.
    return !logsAgreeMetrics && logs < metrics ? 'missing-log' : undefined;
  }
  const logsAgreeTraces = agree(logs, traces, tolerance);
  const metricsAgreeTraces = agree(metrics, traces, tolerance);
  if (logsAgreeMetrics && logsAgreeTraces && metricsAgreeTraces) return undefined;
  // The log is the odd one out when metrics and traces agree and the log has fewer.
  if (metricsAgreeTraces && !logsAgreeMetrics && logs < metrics) return 'missing-log';
  // The metrics are the odd one out when the log and the traces agree.
  if (logsAgreeTraces && !metricsAgreeTraces) return 'wrong-metric';
  return undefined;
}

/** What one route's requests look like in each record, with the version that served them and its route. */
export interface RouteCounts extends Counts {
  /** The path asked for. */
  path: string;
  /** The route the app's log gives it. */
  route: string;
  version: string | undefined;
}

/** Two windows' counts as one: each route's requests in both. The later window's version and route name win. */
export function combine(earlier: RouteCounts[], later: RouteCounts[]): RouteCounts[] {
  const combined = new Map<string, RouteCounts>(earlier.map((entry) => [entry.path, { ...entry }]));
  for (const entry of later) {
    const before = combined.get(entry.path);
    if (!before) {
      combined.set(entry.path, { ...entry });
      continue;
    }
    combined.set(entry.path, {
      ...entry,
      version: entry.version ?? before.version,
      metrics: before.metrics + entry.metrics,
      logs: before.logs + entry.logs,
      // Traces are known for the pair only when they are known for both.
      ...(before.traces !== undefined && entry.traces !== undefined ? { traces: before.traces + entry.traces } : {}),
      // A gap in either window is a gap in both.
      ...(before.gap || entry.gap ? { gap: true } : {}),
    });
  }
  return [...combined.values()];
}

/** How far before a window's start a series' last sample still makes its absence there a gap, not a new series. */
export const GAP_LOOKBACK = '24h';

/** The label the metrics' query gives the requests of series that had a gap. */
const GAP_LABEL = 'agreement_gap';

/**
 * The requests each route and version counted in the last `seconds`, series by series before they are summed: the
 * counter now, less the counter then, with a series that did not exist then counted from nothing. A series whose
 * counter went down has restarted (the app's pod restarted on the same version), so it counts from nothing too.
 * `increase` would miss the first requests of a series that began in the window, and in an app with thin traffic
 * most routes' series do.
 *
 * A series with no sample then, but some in the `GAP_LOOKBACK` before, is not new: its metrics had a gap, and it came
 * back with its whole running total, which counting from nothing would take for the window's requests. Its requests
 * are summed apart, marked with `agreement_gap="true"`, so that the route is not judged on them.
 */
export function requestsBetween(job: string, seconds: number): string {
  const counter = (offset = '') => `http_server_request_duration_seconds_count{${job}, http_route!=""}${offset}`;
  const then = counter(` offset ${seconds}s`);
  const delta = `(${counter()} - (${then} or ${counter()} * 0))`;
  const counted = `((${delta} >= 0) or (${counter()} unless (${delta} >= 0)))`;
  const gapped = `(${counter()} and (last_over_time(${counter(`[${GAP_LOOKBACK}] offset ${seconds}s`)}) unless ${then}))`;
  return (
    `sum by (http_route, service_version, ${GAP_LABEL}) ` +
    `((${counted} unless ${gapped}) or label_replace(${gapped}, "${GAP_LABEL}", "true", "", ""))`
  );
}

/**
 * Counts each route's requests between two times, in each of the three records. A path takes its route from the
 * window's own log records, or failing them from `known`, the routes the log gave paths before: the window when the
 * log says least is the one that cannot place a path by itself, and a path it cannot place is a route of its own.
 * With a `version`, only the requests that version of the app served are counted, in each record.
 */
export async function count(
  o: Objectives,
  backends: { prometheus: Prometheus; loki: Loki; tempo: Pick<Tempo, 'requestsByRoute'> },
  start: Date,
  end: Date,
  known: ReadonlyMap<string, string> = new Map(),
  version?: string,
): Promise<{ routes: RouteCounts[]; tracesComplete: boolean }> {
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
  const job = `${appSeries(o)}${version === undefined ? '' : `, service_version=${quoted(version)}`}`;
  const logged = version === undefined ? requestLogs(o) : `${requestLogs(o)} | service_version=${quoted(version)}`;
  const [metrics, logs, traced] = await Promise.all([
    backends.prometheus.instant(requestsBetween(job, seconds), end),
    backends.loki.instant(`sum by (path, route) (count_over_time(${logged} [${seconds}s]))`, end),
    backends.tempo.requestsByRoute(o.app.logsService, start, end, version),
  ]);

  const routes = new Map<string, RouteCounts>();
  const at = (path: string) => {
    let entry = routes.get(path);
    if (!entry) {
      entry = { path, route: known.get(path) ?? path, version: undefined, metrics: 0, logs: 0 };
      routes.set(path, entry);
    }
    return entry;
  };
  // The version of a route is the one that served most of it.
  const busiest = new Map<string, number>();
  for (const { labels, value } of metrics) {
    const entry = at(labels.http_route ?? '');
    entry.metrics += value;
    if (labels[GAP_LABEL] === 'true') entry.gap = true;
    if (value > (busiest.get(entry.path) ?? 0)) {
      busiest.set(entry.path, value);
      entry.version = labels.service_version;
    }
  }
  for (const { labels, value } of logs) {
    const entry = at(labels.path ?? '');
    entry.logs += value;
    if (labels.route) entry.route = labels.route;
  }
  for (const { route, requests } of traced.routes) {
    const entry = at(route);
    entry.traces = (entry.traces ?? 0) + requests;
  }
  // A route Tempo shows nothing of has traces of zero, once Tempo shows others: it is not simply late.
  const anyTraces = traced.routes.some(({ requests }) => requests > 0);
  for (const entry of routes.values()) {
    if (anyTraces) entry.traces ??= 0;
    if (!traced.complete) delete entry.traces;
  }
  return { routes: [...routes.values()].filter((entry) => entry.path), tracesComplete: traced.complete };
}

/**
 * Whether the log is silent for every route at once, rather than for some: more than one route's requests are
 * missing from it, and across every route, judged or not, it holds no more records than an edge of the window
 * explains. That is one finding about the log, not one per route: Loki stopped storing the app's records, or the app
 * stopped writing them. A route left out of an otherwise full log is not this, and is judged on its own. Routes are
 * judged here with their paths' counts together, so that a route spread thin over many pages still counts.
 */
export function logSilent(entries: RouteCounts[], tolerance: Tolerance = TOLERANCE): boolean {
  const byRoute = new Map<string, RouteCounts[]>();
  for (const entry of entries) byRoute.set(entry.route, [...(byRoute.get(entry.route) ?? []), entry]);
  const unlogged = [...byRoute.values()].filter((paths) => judge(total(paths), tolerance) === 'missing-log').length;
  const logged = entries.reduce((sum, entry) => sum + entry.logs, 0);
  return unlogged >= 2 && agree(logged, 0, tolerance);
}

/**
 * Several paths' counts as one. As in `combine`, the traces are known only when every path's are, and a gap in any
 * path's metrics is a gap in all of them.
 */
export function total(entries: readonly Counts[]): Counts {
  let metrics = 0;
  let logs = 0;
  let traces: number | undefined = 0;
  let gap = false;
  for (const entry of entries) {
    metrics += entry.metrics;
    logs += entry.logs;
    traces = traces === undefined || entry.traces === undefined ? undefined : traces + entry.traces;
    gap ||= entry.gap === true;
  }
  return { metrics, logs, ...(traces === undefined || !entries.length ? {} : { traces }), ...(gap ? { gap } : {}) };
}

/** At most this many routes are shown in a silent log's evidence, the busiest first. */
const SILENT_ROUTES_SHOWN = 8;

/**
 * The one signal for a log silent for every route, on every route (`*`) as `missing-log`, so that each window it
 * holds is the same ticket. Its evidence is the log of each of the busiest routes as it should have been: none at
 * all beside the requests counted elsewhere. Nothing, if the metrics do not say which version served the requests.
 */
export function signalForSilentLog(entries: RouteCounts[], end: Date): InboxSignal | undefined {
  const byRoute = new Map<string, { route: string; requests: number; versions: Map<string, number> }>();
  const versions = new Map<string, number>();
  for (const entry of entries) {
    const requests = Math.max(entry.metrics, entry.traces ?? 0);
    const route = byRoute.get(entry.route) ?? { route: entry.route, requests: 0, versions: new Map() };
    route.requests += requests;
    if (entry.version) {
      route.versions.set(entry.version, (route.versions.get(entry.version) ?? 0) + entry.metrics);
      versions.set(entry.version, (versions.get(entry.version) ?? 0) + entry.metrics);
    }
    byRoute.set(entry.route, route);
  }
  const version = busiest(versions);
  if (!version) return undefined;
  const evidence = [...byRoute.values()]
    .filter((route) => route.requests > 0)
    .sort((a, b) => b.requests - a.requests)
    .slice(0, SILENT_ROUTES_SHOWN)
    .map((route) => ({
      kind: 'logs' as const,
      route: route.route,
      version: busiest(route.versions) ?? version,
      requests: Math.round(route.requests),
      lines: [],
    }));
  return {
    sense: 'logs',
    check: AGREEMENT_CHECK['missing-log'],
    route: '*',
    version,
    symptom: 'missing-log',
    observedAt: end.toISOString(),
    artifacts: [],
    evidence,
  };
}

/** The key with the largest count. */
function busiest(counts: Map<string, number>): string | undefined {
  let best: [string, number] | undefined;
  for (const [key, value] of counts) if (!best || value > best[1]) best = [key, value];
  return best?.[0];
}

/**
 * The signal for a route whose records disagree, or nothing if the metrics do not say which version served it.
 * A missing log is shown as the log it should have been: none at all beside the requests counted elsewhere. Wrong
 * metrics are shown as the series they report, with what the other records counted in its name.
 */
export async function signalForDisagreement(
  disagreement: Disagreement,
  entry: RouteCounts,
  backends: { objectives: Objectives; prometheus: Prometheus },
  start: Date,
  end: Date,
): Promise<InboxSignal | undefined> {
  const { version, route } = entry;
  if (!version) return undefined;
  const base = {
    sense: 'logs' as const,
    route,
    version,
    symptom: disagreement,
    observedAt: end.toISOString(),
    artifacts: [],
  };
  if (disagreement === 'missing-log') {
    return {
      ...base,
      check: AGREEMENT_CHECK['missing-log'],
      evidence: [
        { kind: 'logs', route, version, requests: Math.round(Math.max(entry.metrics, entry.traces ?? 0)), lines: [] },
      ],
    };
  }
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  const job = appSeries(backends.objectives);
  const picture = await backends.prometheus.range(
    `sum (increase(http_server_request_duration_seconds_count{${job}, http_route=${quoted(entry.path)}}[1m]))`,
    new Date(end.getTime() - 3600_000),
    end,
    60,
  );
  const counted = `metrics ${Math.round(entry.metrics)}, logs ${Math.round(entry.logs)}, traces ${entry.traces ?? 0}`;
  return {
    ...base,
    check: AGREEMENT_CHECK['wrong-metric'],
    ...(picture && picture.values.length >= 2
      ? {
          evidence: [
            {
              kind: 'metric' as const,
              name: cutTo(`Requests a minute. In ${minutes} minutes: ${counted}`, 80),
              unit: 'requests',
              start: picture.start.toISOString(),
              stepSeconds: picture.stepSeconds,
              values: picture.values,
            },
          ],
        }
      : {}),
  };
}
