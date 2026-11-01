/**
 * Releases at a time t, from every release event, on a work item or on the line: one release to a `release` id. A
 * release that carries two work items has its events on each, and is one release here. The Canary panel draws the
 * newest; the Release station takes its figure from the one in flight.
 */
import { measurementOf, type PayloadOf, type PublicEvent, type ReleaseControl } from '@software-factory/events';
import { STEP_UP } from '../access.ts';
import { capital, clockSeconds, count, countdown, duration, percent, shortVersion } from '../format.ts';
import { endsRelease, type ItemState } from './items.ts';

type Started = PayloadOf<'release.started'>;
export type Stepped = PayloadOf<'canary.stepped'>;
type Measuring = PayloadOf<'canary.measuring'>;
export type Failed = PayloadOf<'release.rolled-back'>['failed'][number];
type Errored = PayloadOf<'release.errored'>['errored'][number];
type AbortedBy = PayloadOf<'release.aborted'>['by'];
/** Who rolled a release back: the analysis by itself, or Martin, aborting a canary it judged bad. */
type RolledBackBy = PayloadOf<'release.rolled-back'>['by'];
/** One measure as the analysis reported it, at a step or a look. */
export type Measure = Stepped['analysis']['measures'][number];
/**
 * What stopped a release that neither promoted nor rolled back: Stop the line, Martin, or an analysis that could not
 * judge it.
 */
export type StoppedBy = AbortedBy | 'error';

/** One step of the canary: a weight it holds, how long it pauses there (null: until someone promotes it), and whether the analysis judges it. */
export type Step = NonNullable<Started['steps']>[number];

export interface Measured {
  weight: number;
  at: number;
  stepped: Stepped;
}

/**
 * A look of the canary's background analysis, as it landed: when the analysis took it, the canary's weight then, the
 * measures it took (errors and latency together, or the journeys on their own), and each version's figures then.
 */
export interface Look {
  at: number;
  weight: number;
  measures: Measuring['measures'];
  figures: Measuring['figures'];
}

export type End =
  | { kind: 'promoted'; at: number; weight: 100 }
  | {
      kind: 'rolled-back';
      at: number;
      weight: number;
      reason: string;
      failed: Failed[];
      ticket: Signalled | undefined;
      /** The analysis's own rollback, or Martin's abort of a canary it judged bad and paused for him. */
      by: RolledBackBy;
    }
  | { kind: 'errored'; at: number; weight: number; reason: string; errored: Errored[] }
  | { kind: 'aborted'; at: number; weight: number; by: AbortedBy };

/**
 * The ticket a rollback's signal went to, and what it did there: opened it, reopened it after a verified fix, or
 * joined it while it was still open, as another release that failed on it.
 */
type Signalled = Carried & { how: keyof typeof SIGNALLED };

/** What a rollback's signal did to its ticket, in words: "triage added it to #1308". */
export const SIGNALLED = { opened: 'opened', reopened: 'reopened', joined: 'added it to' };

export interface Carried {
  number: string;
  title: string;
}

export interface Release {
  id: string;
  version: string;
  previous: string;
  commit: string | undefined;
  image: Started['image'];
  dryRun: boolean;
  /** The work items it carries. None: Martin's own commits, or a dependency update with no work item. */
  items: Carried[];
  startedAt: number;
  /**
   * The Rollout's steps as the release recorded them, then all of the traffic, which the Rollout does not list. A
   * release that recorded none has the steps measured stand in.
   */
  steps: Step[];
  /** Whether the steps are the release's own, rather than the steps measured. */
  planned: boolean;
  measured: Measured[];
  /** Each look of the background analysis this attempt has recorded, oldest first. */
  looks: Look[];
  /**
   * When errors and latency are next due to be looked at: an interval after the last look that took them, while the
   * release is in flight. Undefined before the first, for a dry run, which measures nothing, and once it has ended.
   */
  nextLook: number | undefined;
  /** The step the canary is at, as an index into the steps: -1 when nothing says which. */
  step: number;
  /** The canary's share of the traffic, now or when it ended: 0 when nothing says yet. */
  weight: number;
  /** When the step it is at ends, if its pause ends by itself. */
  until: number | undefined;
  /** When it reached the step it is at, when that step's pause ends by itself. */
  since: number | undefined;
  end: End | undefined;
  /** How each earlier attempt of the same release ended, oldest first: a retry goes again from the first step. */
  retried: End[];
  /** Martin's pause, while it holds: when he paused the canary, and the weight it keeps. */
  paused: { at: number; weight: number } | undefined;
  /** Each of Martin's promotions of this attempt, oldest first: when, and the weight it went to. */
  promotions: { at: number; to: number }[];
  /**
   * With auto-rollback off, the analysis judged this attempt bad and Argo Rollouts paused it for Martin, while it is in
   * flight (`judgedBadOf`).
   */
  judgedBad: JudgedBad | undefined;
  /**
   * What Martin, or Stop the line, did to it through the admin service that the line has not recorded yet: an abort or
   * a full promotion of the attempt in flight, or a retry of the one that ended. The admin service records the act the
   * moment it makes it (`release.controlled`), and the line its outcome at its next pass, up to half a minute later:
   * until then the panel says it is under way, and offers no control it has made pointless. Promote to the next step,
   * Pause and Resume need none of this: the projection moves the canary for them at once.
   */
  acting: Acting | undefined;
}

/**
 * An act the line has not recorded yet (`Release.acting`): which, when, the canary's weight then as the Rollout had it
 * (0 for a release that was stopped), and whether Stop the line made it.
 */
export interface Acting {
  action: 'abort' | 'promote-fully' | 'retry';
  at: number;
  weight: number;
  stop: boolean;
}

/**
 * A canary the analysis judged bad with auto-rollback off, paused for Martin: when, at what weight, each measure it
 * judged bad (inconclusive, as Argo Rollouts calls a bad figure then), and each version's figures at that moment.
 */
interface JudgedBad {
  at: number;
  weight: number;
  measures: Measure[];
  figures: Stepped['figures'];
}

/**
 * What the Canary panel shows: no release yet, or the newest one in full, in flight or however it ended, until the next
 * starts. A release that was stopped or rolled back waits for Martin's retry, and one promoted says how it went.
 */
export type CanaryView = { state: 'none' } | { state: 'shown'; release: Release };

/**
 * The analysis's measures, as the panel names them, each with its rule in `policy/release.ts`'s terms. The console's
 * image is built without policy/, so it keeps these words, and a test holds them to the policy's figures.
 */
export const MEASURES = [
  ['enough-requests', 'Requests', 'at least 100 in the window'],
  ['errors', 'Errors', '5xx share · fails a point above'],
  ['latency', 'Latency', 'p99 · fails 25% and 100 ms above'],
  ['journeys', 'Journeys', 'fails on a check failing here alone, twice'],
] as const;

/** A measure by the name the panel gives it: "Errors". */
export const measureLabel = (name: string): string => MEASURES.find(([n]) => n === name)?.[1] ?? name;

/**
 * The background analysis, in `policy/release.ts`'s figures (`minRequests` and `background`), which a test holds
 * these to: the requests the canary needs in the window before errors and latency are judged, how often they are
 * looked at, and how many failed looks of a measure fail the release.
 */
export const BACKGROUND = { minRequests: 100, intervalMs: 60_000, failures: 2 } as const;

/**
 * What the analysis saw of a measure that failed a release, against its limit, in the analysis's own terms
 * (`apps/factory/src/release/analysis.ts`): the requests the split sent the canary, against the fewest it needs; the
 * canary's share of 5xx answers above the baseline's, against the most it may be; how far its p99 went past the most
 * it may be, to the millisecond but never as none, since any excess fails. A limit the analysis did not record is not
 * said. A measure with no value says it in its own words, unless those are the rollback's or Argo Rollouts' ("Metric …
 * assessed Failed due to …"): the journeys report no number, and errors and latency with none had no figures to
 * compare, which the analysis counts as infinitely worse.
 *
 * Errors and latency say each version's own figure first, where the rollback's series has both at the moment the
 * analysis failed (`versionsAt`): "p99 415 ms against 39 ms: 276 ms over its limit". Each figure is rounded on its
 * own, so the last digit of the excess can differ by one from the sum a reader makes of the two beside it.
 */
export function sawOf(failed: Failed, reason: string): string {
  const { name, value, limit, message } = failed;
  const own = ownWords(message, reason);
  if (value === null)
    return (
      own ||
      (name === 'journeys'
        ? 'a check that passed on the baseline failed here'
        : 'no figures to compare, which counts as infinitely worse')
    );
  const points = (x: number) => `${(x * 100).toFixed(2)} points`;
  const against = (words: string) => (limit === null ? '' : `, against ${words}`);
  const both = versionsAt(failed);
  if (name === 'latency') {
    // In µs first, so a float such as 1.0005 s is not read as 1000.4999… ms.
    const over = `${Math.max(1, Math.round(Math.round((value - (limit ?? 0)) * 1e6) / 1000))} ms over its limit`;
    return both ? `p99 ${Math.round(both.canary)} ms against ${Math.round(both.baseline)} ms: ${over}` : `p99 ${over}`;
  }
  if (name === 'errors') {
    if (!both) return `5xx share ${points(value)} above the baseline’s${against(`at most ${points(limit ?? 0)}`)}`;
    const allowed = limit === null ? '' : `, at most ${points(limit)} allowed`;
    return `5xx share ${both.canary.toFixed(2)}% against ${both.baseline.toFixed(2)}%: ${points(value)} above${allowed}`;
  }
  if (name === 'enough-requests') return `${value} requests to the canary${against(`at least ${limit}`)}`;
  return `${value}${against(`a limit of ${limit}`)}`;
}

/**
 * What the analysis judged bad in a canary paused for Martin, and by how much, in the words a rollback's measure has
 * (`sawOf`): each version's own figure where the step or look that judged it read them, against its limit.
 */
export function judgedWords(j: JudgedBad): string {
  return j.measures
    .map((m) => {
      const f = j.figures;
      const [unit, canary, baseline] =
        m.name === 'latency'
          ? ['ms', f?.canary.p99Ms, f?.baseline.p99Ms]
          : [
              '%',
              f && f.canary.errorRate !== null ? f.canary.errorRate * 100 : null,
              f && f.baseline.errorRate !== null ? f.baseline.errorRate * 100 : null,
            ];
      const series =
        typeof canary === 'number' && typeof baseline === 'number'
          ? { label: m.name, unit, stepSeconds: 1, canary: [canary, canary], baseline: [baseline, baseline], at: 0 }
          : undefined;
      return sawOf({ ...m, ...(series && { series }) }, '');
    })
    .join('; ');
}

/** The analysis's own words about what it judged bad, each once: Argo Rollouts' message on each measure. */
export const judgedSaid = (j: JudgedBad) => [...new Set(j.measures.flatMap((m) => (m.message ? [m.message] : [])))];

/**
 * Whether the measures are the background analysis's as each look lands, rather than the latest step's: a release in
 * flight that has recorded a look. A dry run measures nothing, and a history from before the looks were recorded has
 * only its steps.
 */
export const measuring = (r: Release) => !r.end && !r.dryRun && r.looks.length > 0;

/** The measures errors' and latency's looks take together: the requests are counted in the same window. */
export const JUDGED = new Set(['errors', 'latency']);

/** The latest look that took a measure; for the requests, the latest that took errors or latency. */
export function lookOf(r: Release, name: string): Look | undefined {
  const took = (m: Look['measures'][number]) => (name === 'enough-requests' ? JUDGED.has(m.name) : m.name === name);
  return r.looks.findLast((l) => l.measures.some(took));
}

/**
 * How far a look of errors or latency was from its limit, in the analysis's own terms, said in each figure's unit:
 * "85 ms", "0.89 pt". Latency in µs first, so a float is not misread; over its limit, never as none, since any excess
 * fails.
 */
export function room(name: string, value: number, limit: number): string {
  if (name !== 'latency') return `${Math.abs((limit - value) * 100).toFixed(2)} pt`;
  const spare = Math.round(Math.round((limit - value) * 1e6) / 1000);
  return `${value > limit ? Math.max(1, -spare) : spare} ms`;
}

/**
 * A measure's verdict as the looks land: its words, what kind of verdict they are (an analysis phase, which the panel
 * draws as it draws a step's, `none` for a measure the step did not take, or `warm` for a measure with a failed look
 * that has not failed the release), and whether its row is ruled warm for a failed look.
 */
export interface LookVerdict {
  words: string;
  kind: Stepped['analysis']['phase'] | 'none' | 'warm';
  ruled: boolean;
}

/**
 * A measure's verdict as the looks land. A step that passed since the last look says so in green ("passed at 25%")
 * until the next lands. Then: the requests are "counting" until the window has enough to judge, then "enough"; errors
 * and latency wait for those requests, then say how far the latest look was from its limit ("85 ms to spare"), warm
 * once a look has failed, with how many of the looks that fail the release have ("25 ms over · 1 of 2"); the journeys
 * wait for their first run, then say whether a check failed here alone.
 */
export function lookVerdict(r: Release, name: string): LookVerdict {
  // Judged bad with auto-rollback off: it waits for Martin, ruled as a failure is.
  if (r.judgedBad?.measures.some((x) => x.name === name)) return { words: '', kind: 'inconclusive', ruled: true };
  const m = r.measured.at(-1);
  const newest = r.looks.at(-1);
  if (m && newest && m.at > newest.at) {
    const { analysis } = m.stepped;
    const phase =
      analysis.measures.find((x) => x.name === name)?.phase ?? (analysis.measures.length ? 'none' : analysis.phase);
    return { words: phase === 'successful' ? `passed at ${m.weight}%` : '', kind: phase, ruled: bad(phase) };
  }
  const look = lookOf(r, name);
  const min = BACKGROUND.minRequests;
  const waits = (words: string): LookVerdict => ({ words, kind: 'pending', ruled: false });
  if (name === 'enough-requests') {
    const n = look?.figures?.canary.requests;
    return { words: n != null && n >= min ? 'enough' : 'counting', kind: 'running', ruled: false };
  }
  const taken = look?.measures.find((x) => x.name === name);
  if (!taken) return waits(name === 'journeys' ? 'waits for its first run' : `waits for ${min} requests`);
  if (taken.phase === 'error') return { words: '', kind: taken.phase, ruled: false };
  // With auto-rollback off, a bad look is inconclusive rather than failed, and counts towards the pause as a failed
  // look counts towards the rollback.
  const fails = r.looks.filter((l) => l.measures.some((x) => x.name === name && bad(x.phase))).length;
  const failed = bad(taken.phase);
  let words: string;
  if (name === 'journeys') words = failed ? 'worse here' : 'none worse here';
  else if (taken.value === null || taken.limit === null) {
    if (!fails) return waits(`waits for ${min} requests`);
    words = failed ? 'no figures to compare' : `waits for ${min} requests`;
  } else words = `${room(name, taken.value, taken.limit)} ${taken.value > taken.limit ? 'over' : 'to spare'}`;
  if (!fails) return { words, kind: 'running', ruled: false };
  return { words: `${words} · ${fails} of ${BACKGROUND.failures}`, kind: 'warm', ruled: true };
}

/**
 * Whether a measure's phase judged the canary bad: failed, or, with auto-rollback off, inconclusive, which is how Argo
 * Rollouts calls a bad figure then (`apps/factory/src/release/analysis.ts`).
 */
export const bad = (phase: Measure['phase'] | 'none') => phase === 'failed' || phase === 'inconclusive';

/** How a figure is written, and counted up: requests, a share of 5xx answers, a p99, or words that do not count. */
export type Unit = 'requests' | 'share' | 'ms' | 'none';

/**
 * A figure written in its unit, as it stands, on its way to a new look's or there: requests short of the window's least
 * say so, "63 / 100", and the count-up writes each figure it passes the same way.
 */
export function written(unit: Unit, x: number): string {
  if (unit === 'share') return percent(x, 2);
  if (unit === 'ms') return `${Math.round(x)} ms`;
  const n = Math.round(x);
  const words = count(n);
  return n < BACKGROUND.minRequests ? `${words} / ${BACKGROUND.minRequests}` : words;
}

/** A point of a measure's line: each version's figure, and its limit, in the figure's unit. */
export interface Point {
  at: number;
  canary: number;
  baseline: number;
  limit: number;
  failed: boolean;
}

/**
 * Each look of errors or latency that judged them, as points: the canary's and the baseline's figures, and the limit
 * where the canary's would fail, which is the canary's figure less how far the look put it from its limit, in the
 * figure's unit (a share in percent, a p99 in ms).
 */
export function pointsOf(r: Release, name: 'errors' | 'latency'): Point[] {
  const scale = name === 'latency' ? 1000 : 100;
  return r.looks.flatMap((l) => {
    const taken = l.measures.find((m) => m.name === name);
    const f = l.figures;
    if (!taken || taken.value === null || taken.limit === null || !f) return [];
    const [canary, baseline] =
      name === 'latency' ? [f.canary.p99Ms, f.baseline.p99Ms] : [f.canary.errorRate, f.baseline.errorRate];
    if (canary === null || baseline === null) return [];
    const [c, b] = name === 'latency' ? [canary, baseline] : [canary * 100, baseline * 100];
    const limit = c - (taken.value - taken.limit) * scale;
    return [{ at: l.at, canary: c, baseline: b, limit, failed: bad(taken.phase) }];
  });
}

/**
 * The unit each measure's series is drawn in, as the line draws it (`apps/factory/src/release/read.ts`'s `DRAWN`). A
 * test holds them together.
 */
export const SERIES_UNITS: Record<string, string> = { errors: '%', latency: 'ms' };

/**
 * Each version's own figure when the analysis failed a measure: the canary's and the baseline's values at the series'
 * `at`, in its unit (a share of 5xx answers in percent, a p99 in ms). The line draws the series from the same query
 * the analysis runs for each version, over the same window, up to the run's end. Argo Rollouts ends a run in the
 * same pass as the look that fails it, so the figures there are the ones that look compared, to within a moment of
 * the window. Undefined for a measure with no series, one in a unit not its
 * own, or where either version has no value.
 */
export function versionsAt({ name, series }: Failed): { canary: number; baseline: number } | undefined {
  if (!series || series.unit !== SERIES_UNITS[name]) return undefined;
  const canary = series.canary[series.at];
  const baseline = series.baseline[series.at];
  return typeof canary === 'number' && typeof baseline === 'number' ? { canary, baseline } : undefined;
}

/**
 * How many looks of a measure failed before the rollback, as Argo Rollouts counted them in the one run that failed it:
 * across the run, not in a row. Undefined for any end but a rollback, a measure it did not fail, a rollback that did
 * not count them (version 2), and a measure more than one run failed (a step's and the background's), whose counts
 * the rollback's own table says run by run: then the verdict says "failed" alone.
 */
export function failedLooks(end: End | undefined, name: string): number | undefined {
  if (end?.kind !== 'rolled-back') return undefined;
  const runs = end.failed.filter((f) => f.name === name);
  return runs.length === 1 ? runs[0]?.failures : undefined;
}

/** A failed measure's message, when it says more than the rollback's reason or Argo Rollouts' boilerplate. */
export const ownWords = (message: string | undefined, reason: string) =>
  message !== reason && !/ assessed \w+ due to /.test(message ?? '') ? message : undefined;

/**
 * A stop in a few words: "stopped with the line" for Stop the line's abort, "aborted by Martin" for his own, "stopped
 * by an analysis error" for an analysis that could not judge it.
 */
const stopWords = (by: StoppedBy) =>
  by === 'stop' ? 'stopped with the line' : by === 'martin' ? 'aborted by Martin' : 'stopped by an analysis error';

/** What became of a release the app went back from: "rolled back", or what stopped it. */
export const backWords = (by: StoppedBy | undefined) => (by ? stopWords(by) : 'rolled back');

/**
 * What a fix waits for after the release that carried it was stopped, as "waiting for Martin's next deploy" is after
 * a rollback: Martin's retry or his next deploy, naming him once.
 */
export const stopWait = (by: StoppedBy) => `waiting for ${by === 'martin' ? 'his' : 'Martin’s'} retry or next deploy`;

/** What stopped a release that ended short of its promotion and rollback, if something did. */
export const stoppedBy = (end: End | undefined): StoppedBy | undefined =>
  end?.kind === 'aborted' ? end.by : end?.kind === 'errored' ? 'error' : undefined;

/**
 * How a release ended, in a few words: "promoted", "rolled back", "stopped with the line", "aborted by Martin" or
 * "stopped by an analysis error".
 */
const endedWords = (end: End) => {
  const by = stoppedBy(end);
  return by ? stopWords(by) : end.kind === 'rolled-back' ? 'rolled back' : 'promoted';
};

/** How a release ended, and at which step: "promoted", "rolled back at 25%", "aborted by Martin at 50%". */
export const endedAt = (end: End) => (end.kind === 'promoted' ? 'promoted' : `${endedWords(end)} at ${end.weight}%`);

const ALL: Step = { weight: 100, pauseSeconds: null, analysis: true };

interface Building extends Release {
  listed: Step[] | null;
  /** Each pause of Martin's that has ended: from when he paused it to when he resumed or promoted it. */
  held: { from: number; to: number }[];
  stoppedAt: number | undefined;
  /** Each measurement its looks took, by `measurementOf`. */
  seen: Set<string>;
  /** How far its looks' own times are from the events’ clock (`lookedShift`), from its first look. */
  shift: number | undefined;
  /** When the line first held a work item this attempt carries for Martin, as a canary paused for him. */
  heldAt: number | undefined;
}

/** Ends an attempt by its own event: what was under way is done, whatever it was. */
function close(r: Building, end: End) {
  r.end = end;
  r.acting = undefined;
}

/**
 * Where the canary is at a time: after the last step measured or the step Martin promoted it to, whichever came last,
 * and past any step the analysis does not judge whose pause has run out, since such a step records nothing. Paused by
 * Martin, it stays where it was when he paused it, at the weight it kept, with no end to wait for.
 */
function position(r: Building, now: number): Pick<Release, 'step' | 'weight' | 'until' | 'since'> {
  if (!r.listed) {
    // With no steps to place it on, the weight it last went to: measured, or promoted to.
    const latest = [
      ...r.measured.map((m) => ({ at: m.at, weight: m.weight })),
      ...r.promotions.map((p) => ({ at: p.at, weight: p.to })),
    ]
      .sort((a, b) => a.at - b.at)
      .at(-1);
    return { step: -1, weight: r.paused?.weight ?? latest?.weight ?? 0, until: undefined, since: undefined };
  }
  const steps = r.steps;
  const paused = r.paused && r.paused.at <= now ? r.paused : undefined;
  const asOf = paused ? paused.at : now;
  let step = 0;
  let from = r.startedAt;
  // A plan may hold a weight twice (a pause, then an analysis): a step measured is the next judged one at its weight.
  // Only a step that passed moves the canary on: one that could not be judged, or that waits for someone to decide,
  // holds it there, with no end to wait for. Martin's promotion moves it to the step that sets the weight it went to.
  let holding = false;
  const moves = [
    // Paused, it moves no further, whatever is recorded after.
    ...r.measured.filter((m) => m.at <= asOf).map((m) => ({ at: m.at, m, to: undefined })),
    ...r.promotions.filter((p) => p.at <= asOf).map((p) => ({ at: p.at, m: undefined, to: p.to })),
  ].sort((a, b) => a.at - b.at);
  for (const { at, m, to } of moves) {
    if (m) {
      const index = steps.findIndex((s, i) => i >= step && s.analysis && s.weight === m.weight);
      if (index < 0) continue;
      holding = m.stepped.analysis.phase !== 'successful';
      [step, from] = [holding ? index : index + 1, m.at];
    } else {
      const index = steps.findIndex((s, i) => i >= step && s.weight === to);
      if (index < 0) continue;
      [step, from, holding] = [index, at, false];
    }
  }
  if (holding)
    return { step, weight: paused?.weight ?? steps[step]?.weight ?? 100, until: undefined, since: undefined };
  // A step's pause counts only the time the canary ran: what Martin held it for is added to its end.
  const after = (start: number, ms: number) => {
    let [t, left] = [start, ms];
    for (const hold of r.held) {
      if (hold.to <= t) continue;
      const ran = Math.max(t, hold.from) - t;
      if (ran >= left) break;
      [t, left] = [Math.max(t, hold.to), left - ran];
    }
    return t + left;
  };
  for (let s = steps[step]; s && !s.analysis && s.pauseSeconds !== null; s = steps[step]) {
    const ends = after(from, s.pauseSeconds * 1000);
    if (ends > asOf) break;
    from = ends;
    step += 1;
  }
  step = Math.min(step, steps.length - 1);
  const pause = steps[step]?.pauseSeconds;
  if (paused) return { step, weight: paused.weight, until: undefined, since: undefined };
  const until = pause == null ? undefined : after(from, pause * 1000);
  return { step, weight: steps[step]?.weight ?? 100, until, since: until === undefined ? undefined : from };
}

/** Every release by t, oldest first, each as far as it had got. */
export function releases(events: readonly PublicEvent[], items: readonly ItemState[], t: number): Release[] {
  const titles = new Map(items.map((item) => [item.number, item.title]));
  const carried = (number: string): Carried => ({ number, title: titles.get(number) ?? '' });
  const byId = new Map<string, Building>();
  // A rollback is a signal: the ticket it went to names the release in its evidence. Whether it opened, reopened or
  // joined that ticket is told by the work item's events before it.
  const tickets = new Map<string, { number: string; how: Signalled['how'] }>();
  const signalled = new Set<string>();
  const reopened = new Set<string>();
  // Whether the history records aborts: one that does has no stop to infer.
  let recordsAborts = false;
  for (const event of events) {
    const at = Date.parse(event.ts);
    // Stop the line aborts the canary in flight, and the line records the abort. A history from before it did has
    // only the stop: the newest release, if it has not ended, is read as aborted by it, until it records an end of its
    // own. An older one that never recorded an end was left behind by a newer, and the stop says nothing of it. Once
    // the history has recorded an abort, a stop is never read as one.
    if (event.type === 'line.stopped') {
      if (recordsAborts) continue;
      const newest = [...byId.values()].at(-1);
      if (newest && !newest.end) newest.stoppedAt ??= at;
      continue;
    }
    // The line's hold of a work item a canary paused for Martin carries: it says so of the release, as its own events
    // do, should they not.
    if (event.type === 'hold.started') {
      const { cause, release } = event.payload;
      const r = cause === 'canary' && release ? byId.get(release) : undefined;
      if (r && !r.end) r.heldAt ??= at;
      continue;
    }
    if (event.type === 'work-item.reopened' && event.work_item) {
      reopened.add(event.work_item);
      continue;
    }
    if (event.type === 'signal.received' && event.work_item) {
      const number = event.work_item;
      const how = !signalled.has(number) ? 'opened' : reopened.has(number) ? 'reopened' : 'joined';
      for (const evidence of event.payload.evidence ?? []) {
        if (evidence.kind === 'canary') tickets.set(evidence.release, { number, how });
      }
      signalled.add(number);
      reopened.delete(number);
      continue;
    }
    if (event.type === 'release.started') {
      const p = event.payload;
      const known = byId.get(p.release);
      // The same start on another work item it carries. One after the release ended is a retry: it goes again, from
      // its first step, as the newest release, carrying what it carried.
      if (known && !known.end && known.stoppedAt === undefined) {
        if (event.work_item && !known.items.some((i) => i.number === event.work_item))
          known.items.push(carried(event.work_item));
        continue;
      }
      const items = known?.items ?? [];
      const ended = known && endOf(known);
      const retried = known ? [...known.retried, ...(ended ? [ended] : [])] : [];
      if (event.work_item && !items.some((i) => i.number === event.work_item)) items.push(carried(event.work_item));
      byId.delete(p.release);
      const listed = p.steps?.length ? p.steps : null;
      byId.set(p.release, {
        id: p.release,
        version: p.version,
        previous: p.previous,
        commit: p.commit,
        image: p.image,
        dryRun: p.dryRun,
        items,
        startedAt: at,
        listed,
        steps: listed ? (listed.at(-1)?.weight === 100 ? listed : [...listed, ALL]) : [],
        planned: Boolean(listed),
        measured: [],
        looks: [],
        nextLook: undefined,
        step: 0,
        weight: 0,
        until: undefined,
        since: undefined,
        end: undefined,
        retried,
        paused: undefined,
        promotions: [],
        judgedBad: undefined,
        acting: undefined,
        held: [],
        stoppedAt: undefined,
        seen: new Set(),
        shift: undefined,
        heldAt: undefined,
      });
      continue;
    }
    // Martin's controls from the console: a pause holds the canary where it is until he resumes, promotes or aborts it;
    // a promotion moves it on. What the Rollout then does, the line records.
    if (event.type === 'release.controlled') {
      const r = byId.get(event.payload.release);
      if (!r) continue;
      const { action, weight, to, stop } = event.payload;
      // Stop the line's abort, made by the admin service, is one the line records: the stop says nothing more of it.
      if (stop && !r.end) {
        recordsAborts = true;
        r.stoppedAt = undefined;
      }
      // A retry asks the release that ended to start again: the line's next start of it is the answer.
      if (endOf(r)) {
        if (action === 'retry') r.acting = { action, at, weight, stop: false };
        continue;
      }
      if (action === 'abort' || action === 'promote-fully') r.acting = { action, at, weight, stop: stop === true };
      if (action === 'pause') r.paused = { at, weight };
      // Resumed or promoted, it runs again; aborted, it stays where he held it, which is where it stopped.
      else if (r.paused && action !== 'abort' && action !== 'retry') {
        r.held.push({ from: r.paused.at, to: at });
        r.paused = undefined;
      }
      if (to !== undefined) r.promotions.push({ at, to });
      continue;
    }
    // A look lands on each work item the release carries, not always in the same pass, and not always grouped the same
    // way: the line may have read one work item's between two of the analysis's writes. Each measurement is kept once,
    // by its measure and its own end, as the line keeps them, whatever look it came in. A dry run has no canary to
    // look at, so it keeps none.
    if (event.type === 'canary.measuring') {
      const r = byId.get(event.payload.release);
      if (!r || r.end || r.dryRun) continue;
      const { weight, figures } = event.payload;
      const measures = event.payload.measures.filter((m) => !r.seen.has(measurementOf(m)));
      if (!measures.length) continue;
      for (const m of measures) r.seen.add(measurementOf(m));
      const taken = Date.parse(event.payload.at);
      r.shift ??= lookedShift(taken, at);
      r.looks.push({ at: Math.min(taken + r.shift, at), weight, measures, figures });
      continue;
    }
    if (event.type !== 'canary.stepped' && !endsRelease(event)) continue;
    // A line that records an analysis's Error records aborts too.
    if (event.type === 'release.aborted' || event.type === 'release.errored') recordsAborts = true;
    const r = byId.get(event.payload.release);
    if (!r || r.end) continue;
    if (event.type === 'canary.stepped') {
      const { weight } = event.payload;
      // The line records a step on each work item the release carries, not always in the same pass.
      if (!r.measured.some((m) => m.weight === weight)) r.measured.push({ weight, at, stepped: event.payload });
    }
    if (event.type === 'release.promoted') close(r, { kind: 'promoted', at, weight: 100 });
    if (event.type === 'release.rolled-back') {
      const { weight, reason, failed, by } = event.payload;
      close(r, { kind: 'rolled-back', at, weight, reason, failed, ticket: undefined, by });
    }
    // Recorded a pass after Argo Rollouts acted on the abort the Error made: it ended then.
    if (event.type === 'release.errored') {
      const { weight, reason, errored, abortedAt } = event.payload;
      close(r, { kind: 'errored', at: Date.parse(abortedAt), weight, reason, errored });
    }
    // Recorded a pass after Argo Rollouts acted on it: it ended then, at the step it had reached.
    if (event.type === 'release.aborted') close(r, abortedAt(r, Date.parse(event.payload.abortedAt), event.payload.by));
  }
  return [...byId.values()].map((r): Release => {
    const {
      listed: _listed,
      stoppedAt: _stoppedAt,
      held: _held,
      seen: _seen,
      shift: _shift,
      heldAt: _heldAt,
      ...release
    } = r;
    if (!r.planned) release.steps = measuredSteps(r);
    const end = endOf(r);
    const judged = end || r.dryRun ? undefined : judgedBadOf(r);
    // Paused for Martin, it waits where it is: no step's pause runs out, and no look is due. Argo Rollouts paused it
    // when it was judged, so it stands where it was then, or where Martin has promoted it to since.
    const asOf = judged ? Math.max(judged.at, ...r.promotions.filter((p) => p.at <= t).map((p) => p.at)) : t;
    const place = { ...position(r, end?.at ?? asOf), ...(judged && { until: undefined, since: undefined }) };
    const ticket = tickets.get(r.id);
    if (end?.kind === 'rolled-back' && ticket) end.ticket = { ...carried(ticket.number), how: ticket.how };
    release.looks = [...r.looks].sort((a, b) => a.at - b.at);
    const looked = release.looks.findLast((l) => l.measures.some((m) => m.name !== 'journeys'));
    if (!end && !r.dryRun && !judged && looked) release.nextLook = looked.at + BACKGROUND.intervalMs;
    // An end the history inferred from a stop answers an abort as its own event does; only a retry outlives an end.
    const acting = end && r.acting?.action !== 'retry' ? undefined : r.acting;
    return { ...release, ...place, weight: end ? end.weight : place.weight, end, judgedBad: judged, acting };
  });
}

/**
 * The oldest a look can be when the line records it: Argo Rollouts keeps a measure's last ten measurements, the
 * journeys' three minutes apart, so a line that was down records looks up to half an hour old, and a pass more.
 */
const RECORDED_WITHIN_MS = 35 * 60_000;

/**
 * How far a release's looks' own times are from the events' clock, from its first look: none, as a look is recorded
 * within Argo Rollouts' memory of it after it was taken. A log moved in time as a whole (`pnpm dev` serves the samples'
 * as if their last event were now, and `factory events load` moves a recording's) moves the events' times and not
 * their payloads': there the first look is placed at its event, and every later one moved as far, so the looks keep
 * their order and spacing, and none is placed after its own event.
 */
const lookedShift = (taken: number, recorded: number) =>
  taken <= recorded && recorded - taken <= RECORDED_WITHIN_MS ? 0 : recorded - taken;

/**
 * Whether the analysis judged an attempt in flight bad, with auto-rollback off, as the line's watch reads it from the
 * Rollout (`apps/factory/src/release/watch.ts`'s `judgedBadOf`): a step's analysis that ended inconclusive on a measure,
 * which pauses the canary at once; or a measure of the background analysis inconclusive on as many of the attempt's
 * looks as fail a release (`BACKGROUND.failures`), since its `inconclusiveLimit` matches its `failureLimit`, and Argo
 * Rollouts counts both across the run. A single inconclusive look pauses nothing: it is warm, as a failed look is.
 * Whichever came first is when it was judged.
 */
function judgedBadOf(r: Building): JudgedBad | undefined {
  const step = r.measured.findLast((m) => m.stepped.analysis.measures.some((x) => x.phase === 'inconclusive'));
  const stepped: JudgedBad | undefined = step && {
    at: step.at,
    weight: step.weight,
    measures: step.stepped.analysis.measures.filter((x) => x.phase === 'inconclusive'),
    figures: step.stepped.figures,
  };
  let looked: JudgedBad | undefined;
  const counts = new Map<string, number>();
  for (const look of [...r.looks].sort((a, b) => a.at - b.at)) {
    for (const m of look.measures) if (m.phase === 'inconclusive') counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
    const judged = look.measures.filter(
      (m) => m.phase === 'inconclusive' && (counts.get(m.name) ?? 0) >= BACKGROUND.failures,
    );
    if (judged.length) {
      looked = { at: look.at, weight: look.weight, measures: judged, figures: look.figures };
      break;
    }
  }
  const judged = stepped && looked ? (stepped.at <= looked.at ? stepped : looked) : (stepped ?? looked ?? heldOf(r));
  // A step measured after the verdict means the canary went on past it (promoted by hand), as the line reads a run made
  // after it: nothing waits for Martin then.
  return judged && !r.measured.some((m) => m.at > judged.at) ? judged : undefined;
}

/** Held by the line, with nothing recorded that says what was judged bad: when it held it, where it was then. */
const heldOf = (r: Building): JudgedBad | undefined =>
  r.heldAt === undefined
    ? undefined
    : { at: r.heldAt, weight: position(r, r.heldAt).weight, measures: [], figures: undefined };

/** A release that recorded no steps: the steps measured stand in, then all of the traffic. */
const measuredSteps = (r: Building) =>
  [...new Set([...r.measured.map((m) => m.weight), 100])].map((weight) => ({ ...ALL, weight }));

/** How a release ended, if it has: by its own event, or, in a history from before aborts were recorded, the line's stop. */
function endOf(r: Building): End | undefined {
  if (r.end || r.stoppedAt === undefined) return r.end;
  return abortedAt(r, r.stoppedAt, 'stop');
}

/** An abort at a time, at the step the canary had reached: the Rollout no longer says which. */
const abortedAt = (r: Building, at: number, by: AbortedBy): End => ({
  kind: 'aborted',
  at,
  weight: position(r, at).weight,
  by,
});

/** The newest release, in full, until the next starts. */
export function canaryView(all: readonly Release[]): CanaryView {
  const release = all.at(-1);
  return release ? { state: 'shown', release } : { state: 'none' };
}

/**
 * One of Martin's controls of the canary, as the panel offers it: the action, its label, what it does, whether it asks
 * for the passkey again (`policy/access.ts`'s `release.promote` and `release.retry`; the console's image is built
 * without policy/, so it keeps this copy, and a test holds the two together), and why it cannot be pressed now, if it
 * cannot.
 */
export interface Control {
  action: ReleaseControl;
  label: string;
  what: string;
  stepUp: boolean;
  /** For a promotion, the weight it goes to. */
  to?: number;
  off?: string;
}

/**
 * Martin's controls of a release, as it stands: in flight, promote it to the next step's weight (when there is a step
 * before all of the traffic) or fully, pause or resume it, and abort it; paused for him as judged bad (auto-rollback
 * off), only promote it fully, past the analysis's verdict, or abort it, which counts as a rollback, since the admin
 * service refuses the rest; stopped (by him, with the line, or by an analysis error) or rolled back, retry it, but not
 * while the line is stopped, which starts no canary. Promoted, or a dry run's: none. There is never a rollback of his
 * own: that is the analysis's, or his abort of a canary it judged bad.
 */
export function controlsOf(r: Release, lineStopped: boolean): Control[] {
  // An act under way leaves nothing to press until the line records what it did (`acting`).
  if (r.dryRun || r.acting) return [];
  const version = shortVersion(r.version);
  const control = (action: ReleaseControl, label: string, what: string, off?: string): Control => ({
    action,
    label,
    what,
    stepUp: STEP_UP[action],
    ...(off && { off }),
  });
  if (r.end) {
    if (r.end.kind === 'promoted') return [];
    const off = lineStopped ? 'Start the line first: a stopped line starts no canary.' : undefined;
    return [control('retry', 'Retry', `Starts ${version}’s canary again from its first step.`, off)];
  }
  const back = `Sends all the traffic back to ${shortVersion(r.previous)}.`;
  if (r.judgedBad) {
    const fails = r.items.length ? `${failsRelease(r)}, and ` : '';
    return [
      control('promote-fully', 'Promote fully', `Gives ${version} all the traffic now, past the analysis’s verdict.`),
      control('abort', 'Abort', `${back} It counts as a rollback: ${fails}triage gets the analysis’s verdict.`),
    ];
  }
  const next = r.steps.slice(r.step + 1).find((s) => s.weight > r.weight && s.weight < 100)?.weight;
  return [
    ...(next === undefined
      ? []
      : [
          {
            ...control(
              'promote',
              `Promote to ${next}%`,
              'Moves the canary to its next step now, without waiting out this one.',
            ),
            to: next,
          },
        ]),
    control(
      'promote-fully',
      'Promote fully',
      `Gives ${version} all the traffic now${next ? ', skipping the steps left' : ''}.`,
    ),
    r.paused
      ? control('resume', 'Resume', 'Gives the canary back to its analysis, to move on by itself again.')
      : control('pause', 'Pause', `Holds the canary at ${r.weight}% until Martin resumes it.`),
    control('abort', 'Abort', `${back} Nothing failed, so it opens no ticket.`),
  ];
}

/**
 * An act under way, in a few words, for the kicker: "Aborting at 25%", "Promoting fully", "Starting again".
 */
export function actingKicker(a: Acting): string {
  if (a.action === 'retry') return 'Starting again';
  if (a.action === 'promote-fully') return 'Promoting fully';
  const at = a.weight ? ` at ${a.weight}%` : '';
  return a.stop ? `Stopping with the line${at}` : `Aborting${at}`;
}

/**
 * An act under way, as the note and the paused card say it: who did what when, what Argo Rollouts does now, and that
 * the line records it at its next pass.
 */
export function actingWords(r: Release, a: Acting, viewer: Viewer, when: string): string {
  const who = viewer === 'martin' ? 'You' : 'Martin';
  const recorded = 'The line records it at its next pass.';
  if (a.action === 'retry')
    return `${who} retried the release at ${when}: Argo Rollouts starts ${shortVersion(r.version)}’s canary again from its first step. ${recorded}`;
  if (a.action === 'promote-fully')
    return `${who} promoted the canary fully at ${when}${r.judgedBad ? ', past the analysis’s verdict' : ''}: Argo Rollouts gives ${shortVersion(r.version)} all the traffic. ${recorded}`;
  const by = a.stop ? 'Stop the line aborted the canary' : `${who} aborted the canary`;
  const rollback = r.judgedBad ? ' Since the analysis judged it bad, it counts as a rollback.' : '';
  return `${by}${a.weight ? ` at ${a.weight}%` : ''}, at ${when}: Argo Rollouts sends all the traffic back to ${shortVersion(r.previous)}.${rollback} ${recorded}`;
}

/** The work items a rollback fails at Release: "#1302 fails Release", "#1302 and #1304 fail Release". */
const failsRelease = (r: Release) =>
  `${r.items.map((i) => `#${i.number}`).join(' and ')} ${r.items.length > 1 ? 'fail' : 'fails'} Release`;

/**
 * Whether a canary in flight is past its step's pause at a step the analysis judges, and so waits for that analysis to
 * end (a journeys Job still running, say): it moves on then, not at the time its pause ended. Not while Martin's pause,
 * an act under way, or a verdict waiting for him holds it.
 */
export const waitsForAnalysis = (r: Release, t: number) =>
  !r.end &&
  !r.dryRun &&
  !r.paused &&
  !r.acting &&
  !r.judgedBad &&
  r.until !== undefined &&
  t >= r.until &&
  r.steps[r.step]?.analysis === true;

/** The release in flight: the newest, while it has not ended. */
export const inFlight = (all: readonly Release[]) => {
  const newest = all.at(-1);
  return newest && !newest.end ? newest : undefined;
};

/** The colour role a word of the Canary panel takes: in flight is ink, a pass green, a failure warm. */
export type Tone = 'signal' | 'ok' | 'attn' | 'faint';
/** An analysis's own phase, of a step or a measure. */
export type Phase = Measured['stepped']['analysis']['phase'];
/** A measure's verdict: its analysis's phase, judged bad in a canary Martin aborted, recorded by a dry run, or not measured. */
export type VerdictPhase = Phase | 'judged' | 'dry' | 'none';

/** How the release stands, as the kicker says it, in its tone. */
export function standing(r: Release): [word: string, tone: Tone, dot: string] {
  const { end, weight, acting } = r;
  // An act the line has not recorded yet: under way, blinking, warm for an abort.
  if (acting) return [`${actingKicker(acting)}…`, acting.action === 'abort' ? 'attn' : 'signal', 'blink'];
  if (!end) {
    // Judged bad with auto-rollback off, Argo Rollouts holds it for Martin: warm, ringed.
    if (r.judgedBad) return [`Paused for Martin at ${weight}% · judged bad`, 'attn', 'ring'];
    // Martin's pause holds it: still, not blinking, until he resumes, promotes or aborts it.
    if (r.paused && !r.dryRun) return [`Paused by Martin at ${weight}%`, 'signal', ''];
    const word = weight ? `Canary · ${weight}%` : 'Canary · starting';
    return r.dryRun ? [`${word}, as the dry run records it`, 'faint', ''] : [`${word} of traffic`, 'signal', 'blink'];
  }
  const [word, tone]: [string, Tone] =
    end.kind === 'promoted' ? ['Promoted · all traffic', 'ok'] : [capital(endedAt(end)), 'attn'];
  return r.dryRun ? [`${word}, as the dry run records it`, 'faint', ''] : [word, tone, tone === 'attn' ? 'ring' : ''];
}

/** What a release's end did at the step it reached, as the step says it: "rolled back here". */
export const CUT = {
  'rolled-back': 'rolled back',
  stop: 'stopped',
  martin: 'aborted',
  error: 'could not be judged',
} as const;

/** A step's verdict: its analysis's phase, or failed when any of its measures failed. */
export const stepPhase = (m: Measured): Phase =>
  m.stepped.analysis.measures.some((x) => x.phase === 'failed') ? 'failed' : m.stepped.analysis.phase;

/** A share of 5xx answers and a p99, as a table of figures writes them, the canary's or a flag's: a dash for none. */
export const shareCell = (x: number | null | undefined) => (x == null ? '—' : percent(x, 2));
export const msCell = (x: number | null | undefined) => (x == null ? '—' : `${x} ms`);
const countCell = (x: number | null | undefined) => (x == null ? '—' : count(x));
const out = (x: [number, number] | null | undefined) => (x ? `${x[0]} / ${x[1]}` : '—');

/** A measure's figure at a step, on the canary or the baseline: none for a dry run, which measured nothing. */
export function figureOf(r: Release, m: Measured, name: string, side: 'canary' | 'baseline'): string {
  const { analysis, figures } = m.stepped;
  if (r.dryRun) return '—';
  if (!figures) return name === 'enough-requests' && side === 'canary' ? countCell(analysis.requests) : '—';
  const f = figures[side];
  if (name === 'errors') return shareCell(f.errorRate);
  if (name === 'latency') return msCell(f.p99Ms);
  if (name === 'journeys') return out(f.journeys);
  return countCell(f.requests ?? (side === 'canary' ? analysis.requests : null));
}

/**
 * A measure's verdict at a step. A measure the rollback failed is failed, whatever the step's own analysis said of
 * it. A step of an analysis that names no measures (an older event's) passed or failed as a whole; a measure missing
 * from one that names them was not measured.
 */
export function phaseOf(r: Release, m: Measured, name: string): VerdictPhase {
  const { analysis } = m.stepped;
  if (r.dryRun) return 'dry';
  if (r.end?.kind === 'rolled-back' && r.end.weight === m.weight && r.end.failed.some((f) => f.name === name))
    return r.end.by === 'martin' ? 'judged' : 'failed';
  return analysis.measures.find((x) => x.name === name)?.phase ?? (analysis.measures.length ? 'none' : analysis.phase);
}

/**
 * When the first step is measured, while the release waits for it: in flight, not a dry run, nothing measured yet,
 * and at a step the analysis judges when its pause runs out. Otherwise there is nothing to wait for, and no table.
 */
export function firstMeasured(r: Release): number | undefined {
  const step = r.steps[r.step];
  return r.planned && !r.end && !r.dryRun && !r.measured.length && step?.analysis ? r.until : undefined;
}

/** A figure as a look has it: its value, to count up from the last, and how it is written when it gets there. */
export interface Fig {
  value: number | null;
  text: string;
  unit: Unit;
}

const fig = (unit: Unit, value: number | null | undefined): Fig =>
  value == null ? { value: null, text: '—', unit: 'none' } : { value, text: written(unit, value), unit };

/**
 * Each version's figure for a measure, from its latest look: the canary's to count up, the baseline's as words.
 * Errors and latency have none until the canary has the requests to judge them.
 */
export function liveFigures(r: Release, name: string): { canary: Fig; baseline: Fig } {
  const look = lookOf(r, name);
  const taken = look?.measures.find((x) => x.name === name);
  const f = look?.figures;
  const none = { canary: fig('none', null), baseline: fig('none', null) };
  if (!f) return none;
  if (name === 'enough-requests') {
    return { canary: fig('requests', f.canary.requests), baseline: { ...fig('requests', f.baseline.requests) } };
  }
  if (name === 'journeys') {
    return {
      canary: { value: null, text: out(f.canary.journeys), unit: 'none' },
      baseline: { value: null, text: out(f.baseline.journeys), unit: 'none' },
    };
  }
  if (taken?.value == null) return none;
  const unit = name === 'latency' ? 'ms' : 'share';
  const of = (side: 'canary' | 'baseline') => (name === 'latency' ? f[side].p99Ms : f[side].errorRate);
  return { canary: fig(unit, of('canary')), baseline: fig(unit, of('baseline')) };
}

/**
 * The span the trend column draws over: from the release's start to the end of its planned steps, or to the latest
 * thing it recorded if that is later.
 */
export function horizon(r: Release): [from: number, to: number] {
  const planned = r.planned
    ? r.steps.reduce((sum, s) => sum + (s.weight < 100 ? (s.pauseSeconds ?? 0) * 1000 : 0), 0)
    : 0;
  const latest = [r.until ?? 0, r.end?.at ?? 0, ...r.looks.map((l) => l.at), ...r.measured.map((m) => m.at)];
  return [r.startedAt, Math.max(r.startedAt + planned, ...latest)];
}

/** When the next look is due, as the caption says it: "next look in 0:29", or "next look due" once it is. */
export const nextWords = (ms: number) => (ms > 0 ? `next look in ${countdown(ms)}` : 'next look due');

/** What is left of a step's pause: "2:13 left", or, once it is over, that the step waits for its analysis. */
export const stepLeft = (ms: number) => (ms > 0 ? `${countdown(ms)} left` : 'waiting for its analysis');

/**
 * Whether the panel shows the measures' own table: always before an end, and after a rollback or an error only when it
 * came at the step last measured (and, for an error, that step's analysis erred); otherwise the end has a table of its
 * own.
 */
export function showsMeasures(r: Release): boolean {
  const { end } = r;
  const m = r.measured.at(-1);
  if (end?.kind === 'rolled-back') return m?.weight === end.weight;
  if (end?.kind === 'errored') return m?.weight === end.weight && m.stepped.analysis.phase === 'error';
  return true;
}

/** Who reads the panel: Martin, signed in, or anyone else, who reads of him. */
export type Viewer = 'martin' | 'visitor';

/**
 * How an earlier attempt of the release ended, for the note of its retry: "Started again after its rollback at
 * 16:21:30." None for a first attempt.
 */
function againWords(r: Release): string {
  const before = r.retried.at(-1);
  if (!before) return '';
  const how =
    before.kind === 'rolled-back'
      ? 'its rollback'
      : before.kind === 'errored'
        ? 'its analysis error'
        : before.kind === 'aborted' && before.by === 'stop'
          ? 'the line stopped it'
          : 'Martin aborted it';
  return `Started again after ${how} at ${clockSeconds(before.at)}. `;
}

/** What happens next, or what happened, in the release's own times. */
export function note(r: Release, switched: Switched, t: number): string {
  const { end, acting } = r;
  if (r.dryRun)
    return 'The dry run answers for this release: its merges were never made, so nothing shipped and nothing was measured. It records each step as the line would see it, so a soak goes round.';
  if (acting) return actingWords(r, acting, switched.viewer, clockSeconds(acting.at));
  if (!end) return againWords(r) + flying(r, switched, t);
  const took = duration(end.at - r.startedAt);
  if (end.kind === 'promoted')
    return `Promoted at ${clockSeconds(end.at)}, ${took} after it started.${r.items.length ? ' Verify now asks the sense that saw each ticket whether it has cleared.' : ''}`;
  if (end.kind === 'aborted' && end.by === 'stop')
    return `Stop the line aborted the canary at ${end.weight}%, at ${clockSeconds(end.at)}. ${shortVersion(r.previous)}, the version before, takes all the traffic. The release stays stopped until Martin retries it or a new deploy starts another; starting the line does not resume it.`;
  if (end.kind === 'aborted')
    return `Martin aborted the canary at ${end.weight}%, at ${clockSeconds(end.at)}. ${shortVersion(r.previous)}, the version before, takes all the traffic. The release stays aborted until he retries it or a new deploy starts another.`;
  if (end.kind === 'errored')
    return `The analysis could not judge the canary at ${end.weight}%, and Argo Rollouts stopped it at ${clockSeconds(end.at)}. ${shortVersion(r.previous)}, the version before, takes all the traffic. Nothing failed, so it is no signal; the release stays stopped until Martin retries it or a new deploy starts another.`;
  const never = `${100 - end.weight}% of the traffic never saw it: it stayed on ${shortVersion(r.previous)}.`;
  if (end.by === 'martin')
    return `Martin aborted it at ${clockSeconds(end.at)}, after the analysis judged it bad: that counts as a rollback, and triage has the analysis’s verdict. ${never}`;
  return `Rolled back at ${clockSeconds(end.at)}, ${took} in. ${never}`;
}

/**
 * What a failing measure does, in the note: rolls the canary back, or, with auto-rollback off, pauses it for Martin,
 * though a failed journeys check, which the switch does not cover, still rolls it back.
 */
const failing = (switched: Switched) =>
  switched.autoRollback
    ? 'it rolls back on its own'
    : `it pauses for ${switched.viewer === 'martin' ? 'you' : 'Martin'} (a failed journeys check still rolls it back)`;

/** Who reads the panel, and whether auto-rollback is on, as Controls has it in force. */
export interface Switched {
  viewer: Viewer;
  autoRollback: boolean;
}

/** What happens next to a release in flight. */
function flying(r: Release, switched: Switched, t: number): string {
  const { viewer } = switched;
  const step = r.steps[r.step];
  const { judgedBad } = r;
  if (judgedBad) {
    const [you, yours] = viewer === 'martin' ? ['you', 'you promote or abort'] : ['Martin', 'he promotes or aborts'];
    const bad = judgedWords(judgedBad);
    return `The analysis judged the canary bad at ${clockSeconds(judgedBad.at)}${bad ? `: ${bad}` : ''}. Auto-rollback was off, so that is inconclusive rather than failed, and Argo Rollouts has paused it for ${you}. It keeps ${r.weight}% of the traffic until ${yours} it, even with auto-rollback switched on again. Stop the line still aborts it.`;
  }
  if (r.paused)
    return `Martin paused the canary at ${clockSeconds(r.paused.at)}. It keeps ${r.weight}% of the traffic until he resumes it, promotes it or aborts it.`;
  if (!r.planned) return 'This release recorded no steps, so the steps measured so far stand in for them.';
  if (r.weight === 100) return 'Every step has passed: the canary takes all the traffic next.';
  if (!step || r.until === undefined)
    return `The canary holds at ${r.weight}% until someone promotes it; if a measure fails, ${failing(switched)}.`;
  // The step's own words and the time left are over the bar above: this says what happens when it ends.
  const next = r.steps[r.step + 1]?.weight ?? 100;
  const to = next === 100 ? 'takes all the traffic' : `moves to ${next}%`;
  // Its pause is over and its analysis still running (the journeys' Job, say): it moves when that ends, not at a time.
  if (waitsForAnalysis(r, t))
    return `The ${r.weight}% step’s pause ended at ${clockSeconds(r.until)}, and the canary waits for the step’s analysis to end. If every measure passes, it ${to}; if one fails, ${failing(switched)}.`;
  const moves = `${to} at ${clockSeconds(r.until)}`;
  return step.analysis
    ? `If every measure passes, the canary ${moves}; if one fails, ${failing(switched)}.`
    : `The canary ${moves}; if a measure fails first, ${failing(switched)}.`;
}

/** What Abort does, as its dialog says it: a rollback of a canary judged bad, otherwise a manual abort. */
export function abortWords(r: Release): string {
  const before = `${shortVersion(r.previous)}, the version before, takes all the traffic at once.`;
  if (r.judgedBad)
    return `${before} It counts as a rollback, since the analysis judged it bad: triage gets its verdict, as from any rollback${r.items.length ? `, and ${failsRelease(r)}` : ''}.`;
  return `${before} Nothing failed, so it opens no ticket${r.items.length ? `, and ${r.items.map((i) => `#${i.number}`).join(' and ')} waits for your retry or the next deploy` : ''}.`;
}

/**
 * Whether Argo Rollouts ran this release's canary: an image admission control let in, and not a dry run, which is the
 * line's own record and moves nothing.
 */
export const rollouts = (r: Release) => !r.dryRun && r.image?.admitted === true;
