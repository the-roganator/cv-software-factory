/**
 * Verify: after a release is promoted, the sense that saw a ticket's defect looks again, at the new version alone, and
 * says whether the defect has cleared. Which sense is the ticket's first signal's:
 *
 * - A probe or the crawler: its check, run again against the stable Service by the probes worker, which has the
 *   browser the line's image lacks (`probes/verify.ts`), passes twice in a row. Failing as often, it persists.
 * - An alert on an objective: the alert's expression, over the new version's requests to the route alone, stays inside
 *   the objective for a window with enough requests. Outside it for as long as the alert waits before it fires, it
 *   persists.
 * - The log watcher's new error pattern: no error record of it from the new version for a window in which the new
 *   version served enough requests. Any such record, and it persists. The signal kept the lines, not the pattern, so
 *   the pattern is rebuilt from them as the watcher builds it (`logs/patterns.ts`).
 * - The log watcher's agreement check (a `missing-log` or `wrong-metric` ticket): the check itself, over the route's
 *   requests in the metrics, the log and the traces, for a window after the promotion (`logs/agreement.ts`). The
 *   records agree on every one of the route's paths, and it has cleared; the one the ticket named is the odd one out
 *   again on any, and it persists. A log silent for every route (`*`) persists while it is silent, and clears once it
 *   counts the requests again for every route; metrics wrong on every route (`*`) persist while they are wrong on
 *   any route, and clear once every route judged has its three records agree.
 * - The canary: the release that carries the fix, or a later one that carries it too, was promoted with the measure
 *   that failed passing at its last step. A promoted release passed every step, so this clears at once, saying so; a
 *   release found live, which no analysis judged, holds for Martin.
 * - A visitor's report, or the planner's finding, alone: no sense can look again. The work item holds for Martin.
 *
 * A look that cannot tell yet (too soon after the promotion, too little traffic, a check that could not finish, a
 * backend that did not answer) says so, and the line looks again later. It never clears on too little.
 *
 * The version looked at is the stable one: the release that carried the fix, or a later one promoted since, which
 * carries it too. A dry run's release never shipped, so no sense can look at it: in a dry run, the dry run's word
 * clears it, and says so.
 *
 * The windows, counts and runs are `policy/release.ts`'s `verify`.
 */
import { setTimeout as wait } from 'node:timers/promises';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { Evidence, PayloadOf, Sense, SignalSource, SymptomClass } from '@software-factory/events';
import { COLOR_SCHEMES, clearedOnWords, cutAt, SENSES, sameVersion } from '@software-factory/events';
import { artifactRef, evidence as evidenceSchema } from '@software-factory/events/schemas';
import { CANARY_ANY_ROUTE } from '@software-factory/triage/events';
import { z } from 'zod';
import { objectives as OBJECTIVES, type Objectives } from '../../../../policy/objectives.ts';
import { release as RELEASE, type Release } from '../../../../policy/release.ts';
import { quoted, requests, type Scope, templatePattern } from '../alerts/queries.ts';
import type { Loki } from '../clients/loki.ts';
import type { Prometheus } from '../clients/prometheus.ts';
import type { Tempo } from '../clients/tempo.ts';
import { measureOfCheck } from '../intake/alerts.ts';
import {
  AGREEMENT_CHECK,
  agree,
  type Counts,
  combine,
  count,
  type Disagreement,
  judge,
  judgedRoutes,
  logSilent,
  onEveryRoute,
  type RouteCounts,
  signalForDisagreement,
  signalForSilentLog,
  TOLERANCE,
  total,
} from '../logs/agreement.ts';
import { keptLine } from '../logs/errors.ts';
import { sameError } from '../logs/patterns.ts';
import { errorLogs, TIMING } from '../logs/watcher.ts';
import type { FlagCheckAnswer, FlagCheckRequest } from '../probes/flag-check.ts';
import type { VerifyAnswer, VerifyRequest } from '../probes/verify.ts';
import { short } from '../release/recorded.ts';
import { requestLogs, routeTemplates } from '../routes.ts';

/** The ticket's first signal, as Verify reads it: never a report's words, which it has no use for. */
export interface FirstSignal {
  sense: SignalSource;
  check: string;
  route: string;
  /** The class of defect the sense named, if it named one. */
  symptom?: SymptomClass;
  evidence: Evidence[];
}

/** The release to verify: the version the stable Service runs, which carries the fix, and when it was promoted. */
export interface Target {
  version: string;
  at: Date;
  /** The version before the fix, which the release replaced. */
  against: string;
  dryRun: boolean;
  /**
   * The canary's analysis of that release: the version it was compared with, and each measure at its last step. None
   * for a release the line found live, or a dry run's, which no analysis judged.
   */
  analysis?: { release: string; against: string; measures: Measure[] };
}

type Measure = PayloadOf<'canary.stepped'>['analysis']['measures'][number];

/** What a look found: the verification, a hold for Martin when no sense can tell, or a reason to look again later. */
export type Look =
  | { kind: 'finished'; verification: PayloadOf<'verification.finished'> }
  | { kind: 'hold'; reason: string }
  | { kind: 'wait'; why: string };

/** The probes worker, as Verify uses it: a ticket's check run again against the stable Service. */
export interface ProbesPort {
  verify(request: VerifyRequest, signal?: AbortSignal): Promise<VerifyAnswer>;
}

/**
 * The probes worker, as Verify by variant uses it: a feature flag checked at its stage (`probes/flag-check.ts`). Asked
 * once for each of the line's passes, it answers null while the check runs, and its answer once it has one.
 */
export interface FlagChecksPort {
  flagCheck(request: FlagCheckRequest, signal?: AbortSignal): Promise<FlagCheckAnswer | null>;
}

/** Where Verify looks. A sense whose backend is missing cannot look, and its work items wait at Verify. */
export interface VerifyClients {
  probes?: ProbesPort | null;
  prometheus?: Prometheus | null;
  loki?: Loki | null;
  /** Without it, an agreement check is judged on the metrics and the log alone, as the watcher does without traces. */
  tempo?: Pick<Tempo, 'requestsByRoute'> | null;
}

export interface LookOptions extends VerifyClients {
  now: Date;
  /** Whether the line runs a dry run: then a dry run's release is verified by its word. */
  dryRun: boolean;
  /** Aborted when the line stops: a check run again is given up. */
  signal?: AbortSignal;
  objectives?: Objectives;
  policy?: Release['verify'];
}

type Context = Required<Omit<LookOptions, keyof VerifyClients | 'signal'>> &
  Pick<LookOptions, 'signal'> &
  VerifyClients;
type ByOne = (signal: FirstSignal, target: Target, c: Context) => Promise<Look>;

/** How each source of a ticket's first signal is verified. */
const BY_SOURCE: Record<SignalSource, ByOne> = {
  probe: byCheck,
  crawler: byCheck,
  metrics: byObjective,
  logs: (signal, target, c) =>
    signal.symptom === 'missing-log' || signal.symptom === 'wrong-metric'
      ? byAgreement(signal, signal.symptom, target, c)
      : byPattern(signal, target, c),
  canary: byAnalysis,
  report: async () => ({ kind: 'hold', reason: NO_SENSE.report }),
  planner: async () => ({ kind: 'hold', reason: NO_SENSE.planner }),
};

const NO_SENSE = {
  report:
    'Only a visitor’s report saw this defect, and no sense can look at it again: Martin judges whether the fix cleared it',
  planner:
    'Only the planner noticed this defect, and no sense can look at it again: Martin judges whether the fix cleared it',
};

/** Looks once at the target by the sense that saw the defect. */
export async function look(signal: FirstSignal | undefined, target: Target, options: LookOptions): Promise<Look> {
  const c: Context = { objectives: OBJECTIVES, policy: RELEASE.verify, ...options };
  if (target.dryRun) {
    if (!c.dryRun) {
      return {
        kind: 'hold',
        reason: 'A dry run’s release never shipped, and the line no longer runs the dry run that would verify it',
      };
    }
    const sense = senseOf(signal);
    return {
      kind: 'finished',
      verification: {
        outcome: 'cleared',
        ...(sense ? { sense } : {}),
        check: cutAt(signal?.check ?? 'the dry run', 120),
        version: target.version,
        against: target.against,
        pages: [],
        dryRun: true,
      },
    };
  }
  if (!signal) return { kind: 'hold', reason: 'The ticket has no signal for a sense to look at again' };
  return BY_SOURCE[signal.sense](signal, target, c);
}

const senseOf = (signal: FirstSignal | undefined): Sense | undefined => SENSES.find((sense) => sense === signal?.sense);

/** A verification of the target, by the signal's sense. */
function finished(signal: FirstSignal, target: Target, outcome: 'cleared' | 'persists', evidence?: Evidence): Look {
  const sense = senseOf(signal);
  const kept = evidence && evidenceSchema.safeParse(evidence).success ? evidence : undefined;
  return {
    kind: 'finished',
    verification: {
      outcome,
      ...(sense ? { sense } : {}),
      check: cutAt(signal.check, 120),
      version: target.version,
      against: target.against,
      ...(kept ? { evidence: kept } : {}),
      pages: [],
      dryRun: false,
    },
  };
}

/** A probe's check, or the crawler's, run again against the stable Service by the probes worker. */
async function byCheck(signal: FirstSignal, target: Target, c: Context): Promise<Look> {
  if (!c.probes) return { kind: 'wait', why: 'the line has no way to the probes (PROBES_URL)' };
  const sense = signal.sense === 'crawler' ? 'crawler' : 'probe';
  const answer = await c.probes.verify({ sense, check: signal.check, route: signal.route }, c.signal);
  if (!sameVersion(answer.version, target.version)) {
    return { kind: 'wait', why: `the stable Service runs ${answer.version}, not ${target.version}` };
  }
  if (answer.outcome === 'unsure') {
    return { kind: 'wait', why: `the check could not tell (${answer.runs.join(', ')}): ${answer.message ?? ''}` };
  }
  return finished(signal, target, answer.outcome, answer.outcome === 'persists' ? answer.evidence : undefined);
}

/**
 * The canary's measure that failed, in the analysis of the release the stable Service runs: cleared when it passed at
 * the release's last step. Verify looks only after a promotion, and a promoted release passed every step, so the
 * analysis has already said; anything else is for Martin.
 */
async function byAnalysis(signal: FirstSignal, target: Target): Promise<Look> {
  const failed = signal.evidence.find((e) => e.kind === 'canary');
  const name = failed?.kind === 'canary' ? failed.measure.name : signal.check;
  const { analysis } = target;
  if (!analysis) {
    return {
      kind: 'hold',
      reason: `No analysis judged ${short(target.version)}, which was found live: Martin judges whether its ${name} cleared`,
    };
  }
  const measure = analysis.measures.find((m) => m.name === name);
  if (measure?.phase !== 'successful') {
    return {
      kind: 'hold',
      reason: `The analysis of ${short(target.version)} did not pass its ${name} at its last step: Martin judges it`,
    };
  }
  return finished(signal, target, 'cleared', {
    kind: 'canary',
    release: analysis.release,
    version: target.version,
    against: analysis.against,
    measure,
  });
}

/** One point a minute: as the intake draws an alert's series. */
const STEP_SECONDS = 60;

/** The alert's expression over the new version's requests to the route. */
async function byObjective(signal: FirstSignal, target: Target, c: Context): Promise<Look> {
  if (!c.prometheus) return { kind: 'wait', why: 'the line has no way to Prometheus (PROMETHEUS_URL)' };
  const o = c.objectives;
  const scope: Scope = {
    version: target.version,
    ...(signal.route.includes(':') ? { template: signal.route } : { route: signal.route }),
  };
  const measured = measureOfCheck(o, signal.check, scope);
  if (!measured) return { kind: 'hold', reason: `No objective is measured as “${signal.check}”: Martin judges it` };
  const { windowMinutes, minRequests } = c.policy.metrics;
  const due = target.at.getTime() + windowMinutes * 60_000;
  if (c.now.getTime() < due) return { kind: 'wait', why: `the window ends at ${new Date(due).toISOString()}` };
  // Each point covers the objective's own window before it, so the points start that long after the promotion, and the
  // window as a whole covers the requests since.
  const window = Math.max(windowMinutes - o.windowMinutes, 1) * 60_000;
  const start = new Date(Math.max(target.at.getTime() + o.windowMinutes * 60_000, c.now.getTime() - window));
  const [asked, series] = await Promise.all([
    c.prometheus.instant(requests({ ...o, windowMinutes }, scope), c.now),
    c.prometheus.range(measured.series, start, c.now, STEP_SECONDS),
  ]);
  const verdict = judgeObjective(series?.values ?? [], {
    threshold: measured.threshold,
    served: asked[0]?.value ?? 0,
    minRequests,
    holdPoints: Math.max(1, Math.round((o.holdMinutes * 60) / STEP_SECONDS)),
  });
  if (verdict.kind === 'wait') return verdict;
  const values = (series?.values ?? []).slice(-500);
  const picture: Evidence | undefined =
    series && values.length >= 2
      ? {
          kind: 'metric',
          name: measured.name,
          unit: measured.unit,
          objective: measured.threshold,
          start: new Date(
            series.start.getTime() + (series.values.length - values.length) * STEP_SECONDS * 1000,
          ).toISOString(),
          stepSeconds: STEP_SECONDS,
          values,
        }
      : undefined;
  return finished(signal, target, verdict.outcome, picture);
}

/**
 * Whether an objective's series has cleared: inside the objective at every point, with enough requests, or persisting:
 * outside it for `holdPoints` in a row, as the alert would fire. Anything else cannot tell yet.
 */
export function judgeObjective(
  values: readonly (number | null)[],
  {
    threshold,
    served,
    minRequests,
    holdPoints,
  }: { threshold: number; served: number; minRequests: number; holdPoints: number },
): { kind: 'judged'; outcome: 'cleared' | 'persists' } | { kind: 'wait'; why: string } {
  if (served < minRequests) {
    return { kind: 'wait', why: `the new version served ${Math.round(served)} requests, fewer than ${minRequests}` };
  }
  const points = values.filter((value) => value !== null);
  if (!points.length) return { kind: 'wait', why: 'the objective has no value yet' };
  let run = 0;
  let longest = 0;
  for (const value of values) {
    run = value !== null && value > threshold ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  if (longest >= holdPoints) return { kind: 'judged', outcome: 'persists' };
  if (points.every((value) => value <= threshold)) return { kind: 'judged', outcome: 'cleared' };
  return { kind: 'wait', why: 'the objective was outside for a moment, shorter than an alert waits' };
}

/** The most error records one look reads. */
const MAX_RECORDS = 5_000;

/** The log watcher's pattern, in the new version's error records since the promotion. */
async function byPattern(signal: FirstSignal, target: Target, c: Context): Promise<Look> {
  if (!c.loki) return { kind: 'wait', why: 'the line has no way to Loki (LOKI_URL)' };
  const o = c.objectives;
  const { windowMinutes, minRequests } = c.policy.logs;
  const due = target.at.getTime() + windowMinutes * 60_000;
  if (c.now.getTime() < due) return { kind: 'wait', why: `the window ends at ${new Date(due).toISOString()}` };
  const version = `service_version=${quoted(target.version)}`;
  // The route's own errors, or for `*` those no request raised: other routes' never crowd them out of what is read.
  const errorsOn = ` | route=${quoted(signal.route === '*' ? '' : signal.route)}`;
  const requestsTo = signal.route === '*' ? '' : ` | route=${quoted(signal.route)}`;
  const [errors, served] = await Promise.all([
    c.loki.records(errorLogs(o, ` | ${version}${errorsOn}`), target.at, c.now, MAX_RECORDS),
    c.loki.instant(`sum(count_over_time(${requestLogs(o)} | ${version}${requestsTo} [${windowMinutes}m]))`, c.now),
  ]);
  const requested = Math.round(served[0]?.value ?? 0);
  const kept = signal.evidence.flatMap((e) => (e.kind === 'logs' ? e.lines.map((line) => line.message) : []));
  // A signal that kept no line names its route alone: any error there is the same, as far as anyone can tell.
  const same = errors.filter(
    (record) =>
      (record.fields.route || '*') === signal.route &&
      (!kept.length || kept.some((line) => sameError(record, keptLine(record).message, line, signal.route))),
  );
  const lines = (records: typeof same): Evidence => ({
    kind: 'logs',
    route: signal.route === '*' ? '/' : signal.route,
    version: target.version,
    requests: requested,
    lines: records.slice(-20).map(keptLine),
  });
  if (same.length) return finished(signal, target, 'persists', lines(same));
  // As many as Loki gave, none of them the pattern: the rest may hold it.
  if (errors.length >= MAX_RECORDS)
    return { kind: 'wait', why: `the route logged ${MAX_RECORDS} other errors or more` };
  if (requested < minRequests) {
    return { kind: 'wait', why: `the new version logged ${requested} requests, fewer than ${minRequests}` };
  }
  return finished(signal, target, 'cleared', lines([]));
}

/** A Tempo with none of the traces, so that the counts leave them out, as when Tempo can answer only in part. */
const NO_TRACES: Pick<Tempo, 'requestsByRoute'> = { requestsByRoute: async () => ({ routes: [], complete: false }) };

/**
 * Whether a path's counts belong to a route: the route the log gave the path, or the path itself. A path the log did
 * not place, in the window or in the last day (`known`), as a missing log places none, is matched against the route's
 * template, as `/products/:slug` matches `/products/glove-left`; one the log placed under another route, or as a route
 * of its own (`/products/new`), is that route's.
 */
export function onRoute(
  { path, route: placed }: Pick<RouteCounts, 'path' | 'route'>,
  route: string,
  known: ReadonlyMap<string, string> = new Map(),
): boolean {
  if (placed === route || path === route) return true;
  if (placed !== path || known.has(path)) return false;
  return new RegExp(`^${templatePattern(route)}$`).test(path);
}

/**
 * The log watcher's agreement check, again, over the new version's requests in the last of the policy's window: the
 * watcher's windows, as many as fill it, the last ending long enough ago for the traces to have reached Tempo, and
 * none before the promotion. Each window is counted on its own, one after another, so that Tempo is asked no more at
 * once than the watcher asks it, and the windows are judged together. A path is judged, and its route, only with the
 * policy's `minRequests`: persisting takes as much as clearing does.
 */
async function byAgreement(signal: FirstSignal, disagreement: Disagreement, target: Target, c: Context): Promise<Look> {
  if (!c.prometheus) return { kind: 'wait', why: 'the line has no way to Prometheus (PROMETHEUS_URL)' };
  if (!c.loki) return { kind: 'wait', why: 'the line has no way to Loki (LOKI_URL)' };
  // Two records cannot say the metrics are wrong: only the traces say which of them is.
  if (disagreement === 'wrong-metric' && !c.tempo) {
    return { kind: 'wait', why: 'the line has no way to Tempo (TEMPO_URL), which says whether the metrics are wrong' };
  }
  const { windowMinutes, minRequests } = c.policy.logs;
  const { agreementWindowMs: windowMs, agreementLagMs: lagMs } = TIMING;
  const windows = Math.max(1, Math.ceil((windowMinutes * 60_000) / windowMs));
  const due = target.at.getTime() + windows * windowMs + lagMs;
  if (c.now.getTime() < due) return { kind: 'wait', why: `the window ends at ${new Date(due).toISOString()}` };
  const end = new Date(c.now.getTime() - lagMs);
  const start = new Date(end.getTime() - windows * windowMs);
  const backends = { prometheus: c.prometheus, loki: c.loki, tempo: c.tempo ?? NO_TRACES };
  // The routes the log gave paths in the last day: a page of a route of its own is never counted as the ticket's.
  // Asked once a look; Loki not answering is a look that cannot tell, never one that counts a path on a guess.
  const known = await routeTemplates(c.loki, c.objectives, end);
  let all: RouteCounts[] = [];
  for (let i = 0; i < windows; i += 1) {
    const from = new Date(start.getTime() + i * windowMs);
    const to = new Date(from.getTime() + windowMs);
    all = combine(all, (await count(c.objectives, backends, from, to, known, target.version)).routes);
  }
  const tolerance = { ...TOLERANCE, minRequests };

  if (signal.route === '*' && disagreement === 'wrong-metric') {
    // Every route judged, as the watcher judges them, a path with a gap left out. Any route still wrong persists: the
    // ticket on every route takes the signals of each route (triage), so no ticket of its own would hold it.
    const judged = judgedRoutes(all, tolerance);
    const wrong = judged.filter((route) => route.finding === 'wrong-metric');
    if (wrong.length) {
      const prometheus = c.prometheus;
      const everywhere = onEveryRoute(wrong);
      const told = await signalForDisagreement(
        disagreement,
        everywhere,
        { objectives: c.objectives, prometheus },
        start,
        end,
        target.version,
      );
      return finished(signal, target, 'persists', told?.evidence?.[0]);
    }
    if (!judged.length) {
      if (all.some((entry) => entry.gap)) return { kind: 'wait', why: 'the metrics had a gap' };
      return { kind: 'wait', why: `no route had ${minRequests} requests on the new version` };
    }
    if (judged.some((route) => route.counts.traces === undefined)) {
      return { kind: 'wait', why: 'Tempo did not have every trace of the window' };
    }
    // As on a silent log's `*`, the routes left once a gap is left out are judged.
    if (judged.every((route) => recordsAgree(route.counts))) return finished(signal, target, 'cleared');
    return { kind: 'wait', why: 'the routes’ records disagree, and none of them has wrong metrics' };
  }

  if (signal.route === '*') {
    // As the watcher judges a silent log, over the windows together: a gap of a few minutes is not the log silent.
    if (logSilent(all, tolerance)) {
      return finished(signal, target, 'persists', signalForSilentLog(all, end)?.evidence?.[0]);
    }
    // A path whose metrics had a gap holds a running total, which says nothing of the window: the rest are judged.
    const gapless = all.filter((entry) => !entry.gap);
    const served = total(gapless);
    const requests = Math.round(Math.max(served.metrics, served.traces ?? 0));
    if (requests < minRequests) {
      if (gapless.length < all.length) return { kind: 'wait', why: 'the metrics had a gap' };
      return { kind: 'wait', why: `the new version served ${requests} requests, fewer than ${minRequests}` };
    }
    // A route the log still leaves out, in an otherwise full log, is a ticket of its own, as the watcher finds it.
    if (agree(served.logs, served.metrics, TOLERANCE)) return finished(signal, target, 'cleared');
    return {
      kind: 'wait',
      why: 'the log counts some of the requests and not others, and is not silent for every route',
    };
  }

  const onIt = all.filter((entry) => onRoute(entry, signal.route, known));
  // A path whose metrics had a gap holds a running total, which says nothing of the window, either way: as the
  // watcher does, the route's other paths are judged, and it can clear only once none had one.
  const paths = onIt.filter((entry) => !entry.gap);
  const sum = total(paths);
  // Any of the route's paths, as the watcher judges them, or the route as a whole.
  const busiest = [...paths].sort((a, b) => b.metrics - a.metrics);
  const worst =
    busiest.find((entry) => judge(entry, tolerance) === disagreement) ??
    (busiest[0] && judge(sum, tolerance) === disagreement
      ? { path: busiest[0].path, route: signal.route, version: busiest[0].version, ...sum }
      : undefined);
  if (worst) {
    const prometheus = c.prometheus;
    const told = await signalForDisagreement(
      disagreement,
      worst,
      { objectives: c.objectives, prometheus },
      start,
      end,
      target.version,
    );
    return finished(signal, target, 'persists', told?.evidence?.[0]);
  }
  if (paths.length < onIt.length) return { kind: 'wait', why: 'the metrics had a gap' };
  const requests = Math.round(Math.max(sum.metrics, sum.logs, sum.traces ?? 0));
  if (requests < minRequests) {
    return { kind: 'wait', why: `the route had ${requests} requests on the new version, fewer than ${minRequests}` };
  }
  if (disagreement === 'wrong-metric' && sum.traces === undefined) {
    return { kind: 'wait', why: 'Tempo did not have every trace of the window' };
  }
  if (recordsAgree(sum)) return finished(signal, target, 'cleared');
  return { kind: 'wait', why: 'the route’s records disagree, and none of them is the odd one out the ticket named' };
}

/** Whether the records' counts agree with each other: the metrics and the log, and the traces too when known. */
function recordsAgree({ metrics, logs, traces }: Counts): boolean {
  return (
    agree(logs, metrics, TOLERANCE) &&
    (traces === undefined || (agree(logs, traces, TOLERANCE) && agree(metrics, traces, TOLERANCE)))
  );
}

/** What cleared a work item, in a sentence for its issue and its closing: the verification, or Martin's word. */
export function whatCleared(
  verification: PayloadOf<'verification.finished'> | undefined,
  answer?: string,
  policy: Release['verify'] = RELEASE.verify,
): string {
  if (!verification) return `Martin judged it cleared${answer ? `, saying: ${answer}` : ''}`;
  if (verification.dryRun) return 'The dry run’s word: its release never shipped, so no sense looked';
  return clearedBy(verification, undefined, policy);
}

/**
 * What a look again found cleared, in a sentence for the work item's issue, its pull request and its closing: as
 * Verify says it, on a release that did not carry the work item's fix, and what that release carried instead.
 */
export function whatClearedOnLook(
  rechecked: PayloadOf<'signal.rechecked'>,
  policy: Release['verify'] = RELEASE.verify,
): string {
  return clearedBy(rechecked, clearedOnWords(rechecked.carried), policy);
}

/**
 * What a sense saw clear, in its own terms: on the release that carries the fix (`release` undefined), or on the
 * release the words name.
 */
function clearedBy(
  seen: Pick<PayloadOf<'signal.rechecked'>, 'sense' | 'check' | 'evidence' | 'version' | 'against'>,
  release: string | undefined,
  policy: Release['verify'],
): string {
  const { sense, check, evidence } = seen;
  const version = short(seen.version ?? '');
  const on = release ? `, on ${release}` : '';
  switch (sense) {
    case 'probe':
    case 'crawler':
      return `The ${sense}’s check “${check}” passed ${times(policy.checks.inARow)} in a row on ${version}, ${release ?? 'which carries the fix'}`;
    case 'metrics':
      return `The ${check} of ${version}’s requests stayed inside its objective for ${policy.metrics.windowMinutes} minutes${on}`;
    case 'logs': {
      const minutes = policy.logs.windowMinutes;
      if (check === AGREEMENT_CHECK['missing-log']) {
        return `The log of ${version} recorded the requests counted elsewhere, for ${minutes} minutes${on}`;
      }
      if (check === AGREEMENT_CHECK['wrong-metric']) {
        return `The metrics of ${version} counted the requests its log and traces did, for ${minutes} minutes${on}`;
      }
      const served = evidence?.kind === 'logs' ? `, over ${evidence.requests} requests` : '';
      return `No error like the one the log watcher saw came from ${version} in ${minutes} minutes${served}${on}`;
    }
    case 'canary': {
      const against = short(evidence?.kind === 'canary' ? evidence.against : (seen.against ?? ''));
      return `The canary’s ${check} passed against ${against} as ${version} was released, and it was promoted${on}`;
    }
    default:
      return `Verify found “${check}” cleared on ${version}${on}`;
  }
}

/** The comment on the issue as the factory closes it, as verified by Verify, by Martin, or by a look again. */
export function closingComment(
  verification: PayloadOf<'verification.finished'> | undefined,
  workItem: string,
  answer?: string,
  rechecked?: PayloadOf<'signal.rechecked'>,
): string {
  const cleared = rechecked ? whatClearedOnLook(rechecked) : whatCleared(verification, answer);
  return [
    `Verified in production. ${cleared}.`,
    '',
    `The factory’s work item #${workItem} is closed as verified.`,
  ].join('\n');
}

/** The comment on a held or waiting work item's pull request as the factory closes it unmerged, its defect gone. */
export function closingPullComment(rechecked: PayloadOf<'signal.rechecked'>, workItem: string): string {
  return [
    `Closed unmerged: the defect this fixes is gone from production. ${whatClearedOnLook(rechecked)}.`,
    '',
    `The factory’s work item #${workItem} is closed as verified.`,
  ].join('\n');
}

/**
 * The comment on the issue as the factory opens it again: what came back, as the sense saw it, or that the dry run's
 * fix it was verified on never shipped.
 */
export function reopeningComment(reopened: PayloadOf<'work-item.reopened'>, workItem: string): string {
  if (reopened.dryRun) {
    return [
      'A dry run verified a fix for this, and that fix never shipped: the defect is still in the app.',
      '',
      `The factory’s work item #${workItem} is open again, and goes back to Plan for a fix that ships.`,
    ].join('\n');
  }
  const where =
    reopened.route !== '*' ? `\`${reopened.route}\`` : reopened.sense === 'canary' ? CANARY_ANY_ROUTE : 'every page';
  return [
    `It came back after its fix was verified: the ${reopened.sense} saw “${reopened.check}” again on ${where}, in version ${short(reopened.version)}.`,
    '',
    `The factory’s work item #${workItem} is open again, and goes back to Plan for another fix.`,
  ].join('\n');
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** The probes worker's answer, checked: the evidence is checked again as the verification is made. */
const verifyAnswer = z.object({
  outcome: z.enum(['cleared', 'persists', 'unsure']),
  version: z.string(),
  runs: z.array(z.enum(['passed', 'failed', 'unsure'])),
  message: z.string().optional(),
  evidence: z.unknown().optional(),
}) as z.ZodType<VerifyAnswer>;

/** A screenshot the probes name, as an event's artifacts take it. */
const screenshot = artifactRef.options[0];
/** A check the probes name: one that did not pass cleanly, or regressed. */
const journeyCheck = z.strictObject({
  sense: z.enum(['probe', 'crawler']),
  check: z.string().min(1).max(120),
  route: z.string().min(1).max(200),
  failed: z.boolean(),
  message: z.string().max(300).optional(),
});

/** A flag's check as the probes answered it, checked where it enters, as the event it makes is again when appended. */
const flagCheckAnswer = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('have'), version: z.string() }),
  z.strictObject({ kind: z.literal('not-held'), version: z.string().nullable(), message: z.string() }),
  z.strictObject({
    kind: z.literal('checked'),
    version: z.string(),
    revision: z.string(),
    journeys: z.strictObject({ passed: z.number().int().min(0), ran: z.number().int().min(0) }),
    notClean: z.array(journeyCheck),
    regressions: z.array(journeyCheck).optional(),
    device: z.strictObject({ allowed: z.array(z.string()), kept: z.array(z.string()) }),
    pages: z.array(
      z.strictObject({
        path: z.string(),
        scheme: z.enum(COLOR_SCHEMES),
        route: z.string(),
        off: screenshot.optional(),
        on: screenshot.optional(),
        changed: z.number().min(0).max(1).optional(),
        diff: screenshot.optional(),
      }),
    ),
  }),
]) as z.ZodType<FlagCheckAnswer>;

/**
 * The probes worker over HTTP. Asking starts the verification, and asking again collects its answer: a crawl run four
 * times takes longer than a request may wait. It asks every `pollMs` until there is an answer, or `deadlineMs` passes.
 * Only the first ask is traced, inside the look's span: asking again is polling, and a span for each would bury it.
 * A flag's check is asked once a call, and the line's next pass asks again (`flagCheck`).
 */
export class ProbesClient implements ProbesPort, FlagChecksPort {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #pollMs: number;
  readonly #deadlineMs: number;

  constructor(url: string, { fetcher = fetch, pollMs = 10_000, deadlineMs = 30 * 60_000 } = {}) {
    this.#url = url.replace(/\/$/, '');
    this.#fetch = fetcher;
    this.#pollMs = pollMs;
    this.#deadlineMs = deadlineMs;
  }

  async verify(request: VerifyRequest, signal?: AbortSignal): Promise<VerifyAnswer> {
    const deadline = Date.now() + this.#deadlineMs;
    for (let asked = context.active(); ; asked = ROOT_CONTEXT) {
      const response = await context.with(asked, () =>
        this.#fetch(`${this.#url}/v1/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        }),
      );
      if (response.status === 200) return verifyAnswer.parse(await response.json());
      if (response.status !== 202) throw new Error(`The probes answered a verification with ${response.status}`);
      await response.body?.cancel();
      if (Date.now() + this.#pollMs > deadline) throw new Error('The probes did not finish the check in time');
      // Leaves no listener behind on the signal, which is the line's and outlives every verification.
      await wait(this.#pollMs, undefined, { signal }).catch((error: unknown) => {
        throw signal?.aborted ? signal.reason : error;
      });
    }
  }

  /** Asks for a flag's check once: null while it runs, which asking again with the same request joins. */
  async flagCheck(request: FlagCheckRequest, signal?: AbortSignal): Promise<FlagCheckAnswer | null> {
    const response = await this.#fetch(`${this.#url}/v1/flag-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (response.status === 202) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`The probes answered a flag's check with ${response.status}`);
    }
    return flagCheckAnswer.parse(await response.json());
  }
}
