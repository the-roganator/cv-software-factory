/**
 * Triage's policy: how a sense's finding becomes a ticket, and the thresholds that route a report. Read by
 * `packages/triage`; the evaluation set (`make eval`) shows how far each threshold sits from the answers it
 * separates.
 */
import type { DefectCategory, Dependency, Sense, Severity, SymptomClass } from '../packages/events/src/vocabulary.ts';

/**
 * A sense knows what it saw, so its ticket's category and severity follow from the symptom class. Severity is how
 * badly a visitor is hurt: cosmetic (they may not notice), degraded (it works, worse than it should), broken (they
 * cannot do what they came to do).
 */
export const SYMPTOMS: Record<SymptomClass, { category: DefectCategory; severity: Severity }> = {
  'broken-link': { category: 'navigation', severity: 'degraded' },
  'broken-image': { category: 'navigation', severity: 'cosmetic' },
  'redirect-loop': { category: 'navigation', severity: 'broken' },
  'wrong-result': { category: 'functional', severity: 'broken' },
  'rejects-valid-input': { category: 'functional', severity: 'broken' },
  'server-error': { category: 'errors', severity: 'broken' },
  'browser-error': { category: 'errors', severity: 'degraded' },
  'slow-response': { category: 'performance', severity: 'degraded' },
  'not-cached': { category: 'performance', severity: 'cosmetic' },
  'missing-alt': { category: 'accessibility', severity: 'degraded' },
  'low-contrast': { category: 'accessibility', severity: 'degraded' },
  'unlabelled-field': { category: 'accessibility', severity: 'degraded' },
  'missing-header': { category: 'security', severity: 'cosmetic' },
  'leaks-detail': { category: 'security', severity: 'degraded' },
  'missing-log': { category: 'observability', severity: 'degraded' },
  'wrong-metric': { category: 'observability', severity: 'cosmetic' },
};

/** The thresholds that route a report, applied in this order (TYPESAFE.md, "Routing"). */
export const REPORTS = {
  /** At or above this probability that a report holds instructions aimed at the system, it is quarantined. */
  quarantine: 0.5,
  /** At or above this probability that a report repeats an open ticket, it joins that ticket. */
  repeat: 0.6,
  /**
   * Severity is Jev's expected level on the rubric (0 no harm, 1 cosmetic, 2 degraded, 3 broken). A problem report
   * below `degraded` is cosmetic, and from `broken` up it is broken.
   */
  severity: { degraded: 1.5, broken: 2.5 },
} as const;

/**
 * How long a visitor's report is kept: the words they typed, and the page they sent it from as they sent it. The
 * privacy pages, the console's and the app's, promise `promisedDays` from when it was received. Triage forgets each
 * `keepDays` after it reached the inbox, a day short, as it prunes the inbox (`forgetReports` in packages/store), so
 * the hour between prunes still falls inside the promise.
 *
 * The gateway's cassette of Jev's judgement of a report holds it too, from when triage asked, which may be days after
 * the report arrived, while the gateway's spend cap holds. So triage judges a report only within `judgeDays` of its
 * arrival, and the gateway keeps a cassette of Jev's `cassetteDays` after its last call at most
 * (`apps/factory/src/gateway/pruning.ts`): together, no more than `keepDays`.
 */
export const REPORT_TEXT = {
  /** What the privacy pages say, in days. */
  promisedDays: 30,
  /** When triage forgets a report, in days after it reached the inbox. Less than `promisedDays`. */
  keepDays: 29,
  /** The most days a report may wait in the inbox and still be judged; one older is forgotten unjudged. */
  judgeDays: 22,
  /** The most days the gateway keeps a cassette of Jev's after its last call. `judgeDays` and this, at most `keepDays`. */
  cassetteDays: 7,
} as const;

/** How triage takes signals from the inbox. */
export const INBOX = {
  /** Tries before a signal is left in the inbox with its reason, for a person to look at. */
  attempts: 5,
  /** How long a taken signal is held before another worker may try it, in seconds. */
  leaseSeconds: 120,
  /**
   * How long a repeat (`counted`, a signal on a ticket that already has it) stays in the inbox, in days. Nothing reads
   * one after triage has counted it, so it goes then, but for each sense's newest, from which a restarted watcher
   * takes up. Signals that opened, held or still wait for a ticket stay: triage reads them again.
   */
  keepCountedDays: 3,
  /** How often triage deletes the repeats past `keepCountedDays`, in minutes. Once as it starts, too. */
  pruneMinutes: 60,
} as const;

/**
 * More new problems than a handful from one sense at once: they could be as many defects, or one fault in what the
 * sense reads, such as a gap in the log. Each would be a planner's step and more, so a burst waits for Martin as one
 * work item, held, with no ticket, before any of its problems has one.
 */
export const BURST = {
  /** The most new tickets one sense opens within the window without a hold: more than this is a burst. */
  tickets: 5,
  /** How close together a sense's signals are, in minutes, to count as one burst. Two of a sense's runs, by default. */
  minutes: 10,
  /**
   * How long after a version goes live, in minutes, a sense seeing an open ticket's defect in it for the first time is
   * the release's doing, which never counts toward a burst; later, it is found again, which does. Room after a promotion
   * for the slowest sense, the log watcher, which judges ten minutes of requests four minutes late, with time to spare.
   */
  releaseMinutes: 30,
} as const;

/**
 * What each sense reads besides the app, and when triage counts each healthy. A sense's new problem, seen while one of
 * them was not healthy or could not be told, may be the factory's environment at fault, which no agent can mend: it
 * waits for Martin as one hold for the sense, before any of its problems has a ticket. All of them depend on the disk,
 * which the app, the senses and the backends share: a full one breaks them all.
 */
export const ENVIRONMENT = {
  reads: {
    probe: ['disk'],
    crawler: ['disk'],
    // Alerts are Prometheus's rules over the app's metrics.
    metrics: ['prometheus', 'disk'],
    // The log watcher reads the app's records in Loki, counts its requests in Prometheus and follows traces in Tempo.
    logs: ['prometheus', 'loki', 'tempo', 'disk'],
    // The canary's analysis asks Prometheus.
    canary: ['prometheus', 'disk'],
  } satisfies Record<Exclude<Sense, 'report'>, readonly Dependency[]>,
  /**
   * The targets Prometheus scrapes whose series the senses read, each by the labels of its `up` series. Prometheus is
   * healthy when each has a target, every one of those answered its last scrape, and metrics still arrive over OTLP,
   * where the app's own are. The rest it scrapes, the platform's components among them, are kept for a person looking
   * back, and one of them down holds nothing.
   */
  targets: {
    // Traefik, whose requests to each of a release's versions the canary's analysis counts (release/analysis.ts).
    traefik: { job: 'kubernetes-pods', namespace: 'kube-system', app_kubernetes_io_name: 'traefik' },
    // The kubelet on each node, whose volume stats are the disk's measure.
    kubelet: { job: 'kubernetes-nodes' },
  } satisfies Record<string, Readonly<Record<string, string>>>,
  /**
   * Loki is healthy when it stored a record from anything within `lokiMinutes`; Tempo, a trace within `tempoMinutes`,
   * since a trace is searchable only a minute or two after it ends. Each of them always has something: the traffic
   * generator keeps the app busy, and the factory's own workers log and trace.
   */
  lokiMinutes: 5,
  tempoMinutes: 10,
  /**
   * The disk is healthy while every volume the cluster's pods keep has at least this fraction of it free: below a
   * tenth of the node's disk, the kubelet starts evicting pods by default.
   */
  diskFree: 0.1,
} as const;
