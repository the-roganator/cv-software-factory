/**
 * How a release of the app is judged: a canary is compared with the version it replaces (its baseline), not with the
 * objectives, because the app is broken on purpose and the baseline already fails some of them. A fix that leaves
 * those as they are is no worse. Argo Rollouts' analysis is generated from this file (`factory`'s
 * `release/analysis.ts`), and `make check` fails if the generated templates are out of date.
 *
 * The steps (how much of the traffic the canary takes, and for how long) are the app's, in its repository's
 * `deploy/`; the judgement is here, so nothing in the app's repository can loosen it. These figures are a start, and
 * Martin's to change.
 *
 * Three measures, at each step and throughout the release: errors and latency from Prometheus, over every route at
 * once, and the journeys: the same comparison the app's pull requests pass (a check that passes on the baseline and
 * fails on the canary, twice), run against the two Services. The journeys have no thresholds of their own.
 *
 * After a release is promoted, Verify asks the sense that saw a ticket's defect whether it has cleared on the new
 * version (`verify`). And a feature flag at the share stage is judged with the same thresholds, its two sides compared
 * on the traffic generator's own requests (`flags`).
 */
import { objectives } from './objectives.ts';

export interface Release {
  /** The app, as its telemetry names it and as the cluster serves it. */
  app: {
    /** The `job` of its request metrics. */
    metricsJob: string;
    /** The stable version's Service: the baseline, and all of the app between releases. */
    stable: string;
    /** The canary's Service: the new version while a release is in flight. */
    canary: string;
  };
  /** How far back each comparison looks, in minutes: no longer than the shortest of the app's steps. */
  windowMinutes: number;
  /**
   * A step fails when the traffic split has sent the canary fewer requests than this in the window, counted at the
   * ingress: too few to judge. Until it has, errors and latency are not judged.
   */
  minRequests: number;
  /** The canary fails when its share of 5xx answers is more than this above the baseline's (0.01 is a point). */
  errors: { maxAbove: number };
  /**
   * The canary fails when its latency at the percentile is more than `maxRatioAbove` above the baseline's and more
   * than `minSecondsAbove` above it too: a fast route that becomes a little slower is not a regression.
   */
  latency: { percentile: number; maxRatioAbove: number; minSecondsAbove: number };
  /**
   * Each measure is also looked at throughout the release: errors and latency every `intervalMinutes`, once the
   * canary has `minRequests` in the window, and the journeys every `journeysIntervalMinutes`. A measure fails the
   * release at its `failures`th failed look: one look of many can be one slow request.
   */
  background: { intervalMinutes: number; journeysIntervalMinutes: number; failures: number };
  /** The traffic generator (`factory traffic`): how many of the app's pages it asks for each second. */
  traffic: { requestsPerSecond: number };
  /**
   * How Verify asks the sense that saw a ticket's defect whether it has cleared on the version a release promoted.
   * Each look either says cleared or persists, or cannot tell yet (too soon, too little traffic, a check that could not
   * finish), and then the line looks again `everyMinutes` later.
   */
  verify: {
    /**
     * A probe's or the crawler's check, run again against the stable Service: cleared when it passes `inARow` times in
     * a row, and persists when it fails as many, as the senses signal only on a second failure. One look runs it at
     * most `runs` times.
     */
    checks: { inARow: number; runs: number };
    /**
     * An alert's expression over the new version's requests alone, from `windowMinutes` after the promotion: cleared
     * when it stays inside the objective for the window, with at least `minRequests` in it; persists when it is outside
     * for the objective's `holdMinutes` in a row, as long as the alert waits before it fires.
     */
    metrics: { windowMinutes: number; minRequests: number };
    /**
     * The log watcher's pattern: persists on any error record of it from the new version since the promotion; cleared
     * when there is none for `windowMinutes` after the promotion, in which the new version logged at least
     * `minRequests` requests (to the ticket's route, when it has one). The watcher's agreement check (a missing log,
     * wrong metrics): the metrics, the log and the traces agree on the route for the last `windowMinutes`, all after
     * the promotion, with at least `minRequests` requests in them.
     */
    logs: { windowMinutes: number; minRequests: number };
    /** How long the line waits to look again when a sense could not tell. */
    everyMinutes: number;
    /**
     * How long after the promotion a sense may go on not telling (too little traffic, a check it can no longer see, a
     * backend that does not answer) before the work item holds for Martin, with the last reason.
     */
    waitHours: number;
    /**
     * How long after the promotion a routine update may wait for a scan whose routine listing is whole (one that made
     * a listing, and read every pin for it) before the work item holds for Martin. Two days, so two daily scans each
     * have their turn, wherever in the day the release fell: one scan that could not read a registry holds nothing.
     * From the promotion, never from the scan: a clock that started again at every scan that was not whole, those a
     * push starts among them, could wait for ever.
     */
    listingWaitHours: number;
  };
  /**
   * The pictures of a release (every page on the stable version and on the canary, and their diffs) are kept for the
   * last `keepReleases` releases pictured, and for any a work item waits at Verify for; the rest are deleted. A
   * verification's own pages stay as long as its event names them.
   */
  pictures: { keepReleases: number };
  /**
   * Verify by variant: a feature flag at the share stage is judged on the traffic generator's own requests, flag on
   * against flag off, with the thresholds above, flag on as the canary and flag off as its baseline: `errors`,
   * `latency`, and `minRequests` on each side. The window runs from the app holding Martin's move to now, less every
   * canary's time in flight, whose two versions would mix the sides. It is judged once, when each side has enough
   * requests and the window is at least `windowMinutes` long; until then it waits.
   */
  flags: { windowMinutes: number };
}

export const release = {
  app: {
    metricsJob: objectives.app.metricsJob,
    stable: 'http://website.website',
    canary: 'http://website-canary.website',
  },
  windowMinutes: 3,
  // A quarter of five requests a second for three minutes is 225: this is under half that, so a step falls short
  // only when the traffic has, not by chance.
  minRequests: 100,
  errors: { maxAbove: 0.01 },
  latency: { percentile: 0.99, maxRatioAbove: 0.25, minSecondsAbove: 0.1 },
  // A journeys run takes about 25 s, with up to four browsers at once. Every three minutes from a minute and a half in
  // (half an interval), a run falls mid-step, between the steps' own runs, so no two overlap on the laptop.
  background: { intervalMinutes: 1, journeysIntervalMinutes: 3, failures: 2 },
  traffic: { requestsPerSecond: 5 },
  // Half an hour is two of the objectives' windows: at five requests a second over some forty pages, a route has
  // about two hundred requests in it, ten times what an objective needs to judge one.
  verify: {
    checks: { inARow: 2, runs: 4 },
    metrics: { windowMinutes: 30, minRequests: objectives.minRequests },
    logs: { windowMinutes: 30, minRequests: objectives.minRequests },
    everyMinutes: 5,
    waitHours: 24,
    listingWaitHours: 48,
  },
  // A release's pictures take about 12 MB, and at most about 26 MB (sixty pages, every one changed), on a volume of
  // 1 Gi the senses' screenshots share. Five cover a canary retried after a rollback, and take at most an eighth.
  pictures: { keepReleases: 5 },
  // At least one cycle of the generator's walk: each id walks the round's pages in turn, so in a round's length times
  // 101 requests every page meets every id once, and each side has the same mix of pages. The app's 76 pages make a
  // round of 77, which is 7,777 requests, 26 minutes at five a second: half an hour covers a round of up to 89.
  flags: { windowMinutes: 30 },
} satisfies Release;
