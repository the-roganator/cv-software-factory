/**
 * Prometheus's rules, generated from the policy: the alerting rules from the app's objectives
 * (policy/objectives.ts), the alerts to Martin (`martinRules`, `flagRules`, and the factory's health, releases and
 * spend in `factoryRules`), and the recording rules the dashboards draw: each route against the objectives, the
 * objectives' error budget, and the line's stuck limits (policy/stuck.ts).
 *
 *     node apps/factory/src/alerts/rules.ts            # write the rules
 *     node apps/factory/src/alerts/rules.ts --check    # fail if they are out of date (make check, CI)
 *
 * The output is a values file for the Prometheus chart: `serverFiles` is where the chart keeps its rule files. A rule
 * judges each route that has had enough requests, by the same expression as the figure recorded for the dashboards, and
 * the alert carries the route and the symptom class as labels, which is all the intake needs to make a signal of it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HOLD_CAUSES, type HoldCause } from '@software-factory/events';
import { FLAGS_HELD } from '../../../../policy/flags.ts';
import { type Objectives, objectives } from '../../../../policy/objectives.ts';
import { STUCK, type StuckStage } from '../../../../policy/stuck.ts';
import { REPORT_TEXT } from '../../../../policy/triage.ts';
import { DRY_RUN_NUMBERS_FROM } from '../github/actions.ts';
import { ADMIN_ACTIONS, type AdminAction } from '../line/admin-actions.ts';
import { NUMBER_PATTERN, RELEASE_ENDINGS } from '../line/metrics.ts';
import { SECURITY_KINDS, type SecurityKind } from '../line/security.ts';
import { TARGETS, type Target } from '../probes/health.ts';
import {
  METRICS_FROM_THE_ADMIN_SERVICE,
  METRICS_FROM_THE_GATEWAY,
  METRICS_FROM_THE_LINE,
  METRICS_FROM_THE_PROBES,
} from '../provenance.ts';
import { AUTO_ROLLBACK as AUTO_ROLLBACK_SERIES } from '../release/analysis.ts';
import * as query from './queries.ts';

export const RULES_FILE = join(import.meta.dirname, '../../../../deploy/base/telemetry/values/prometheus-rules.yaml');

/** The `objective` label of each rule: the intake reads it to know what to plot. */
export const OBJECTIVES = { errorRatio: 'error-ratio', latency: 'latency' } as const;

interface Rule {
  alert: string;
  expr: string;
  for: string;
  /** How long it goes on firing once its expression no longer holds, so a cause that comes and goes pages once. */
  keepFiringFor?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/** What `{{ $labels.http_route }}` makes of a route in an alert, once Prometheus has expanded it. */
const ROUTE = '{{ $labels.http_route }}';

/**
 * One rule per objective. Each judges every route alike, and only one that has had `minRequests` in the window, by the
 * very expression recorded for the dashboards (`routeRulesFor`). It does not read the recorded series: anything that
 * sends metrics over OTLP could send one by that name, and an alert judges only the app's own requests.
 */
export function rulesFor(o: Objectives): Rule[] {
  const route = routeFigures(o);
  const window = `${o.windowMinutes} minutes`;
  const hold = `${o.holdMinutes}m`;
  return [
    {
      alert: 'RouteErrorRatioAboveObjective',
      expr: `(${route.errorRatio}) > ${o.errorRatio.max}`,
      for: hold,
      labels: { route: ROUTE, symptom: 'server-error', objective: OBJECTIVES.errorRatio },
      annotations: {
        summary: `${ROUTE}: more than ${percent(o.errorRatio.max)} of requests answered with a 5xx status`,
        description: `Over ${window}, with at least ${o.minRequests} requests.`,
        threshold: String(o.errorRatio.max),
      },
    },
    {
      alert: 'RouteLatencyAboveObjective',
      expr: `(${route.latency}) > ${o.latency.maxSeconds}`,
      for: hold,
      labels: { route: ROUTE, symptom: 'slow-response', objective: OBJECTIVES.latency },
      annotations: {
        summary: `${ROUTE}: ${query.percentileName(o.latency.percentile)} latency above ${o.latency.maxSeconds} s`,
        description: `Over ${window}, with at least ${o.minRequests} requests.`,
        threshold: String(o.latency.maxSeconds),
      },
    },
  ];
}

/**
 * How loudly an alert reaches Martin, as its `level` label, through Pushover: Alertmanager pages him for `page` (high
 * priority, sounding through his quiet hours), notifies him for `notify` (normal priority) and informs him for `inform`
 * (low priority, with no sound or vibration), and sends an alert with none of them to no one
 * (deploy/base/telemetry/values/prometheus.yaml).
 */
export const LEVELS = { page: 'page', notify: 'notify', inform: 'inform' } as const;
export type Level = (typeof LEVELS)[keyof typeof LEVELS];

/**
 * How loudly each kind of security event reaches Martin. What loosens a guardrail, a guardrail's proof that did not
 * hold, or what changes who can sign in, pages him; what widens what the line does (asking for an improvement, or
 * approving its spec, among those), acts on a release, or widens a feature flag, notifies him; what tightens, or only
 * records his own use, informs him, but for tightening autonomy, which notifies him. Every kind still reaches his
 * phone: only how loudly changes.
 */
export const SECURITY_LEVELS: Record<SecurityKind, Level> = {
  'autonomy-loosened': LEVELS.page,
  'passkey-enrolled': LEVELS.page,
  'passkey-revoked': LEVELS.page,
  'guardrail-approved': LEVELS.page,
  'autonomy-tightened': LEVELS.notify,
  'auto-merge-on': LEVELS.notify,
  'take-widened': LEVELS.notify,
  'flag-widened': LEVELS.notify,
  'improvement-requested': LEVELS.notify,
  'improvement-approved': LEVELS.notify,
  // Off loosens what reaches him, as nothing will; Alertmanager lets both through its mute (`PHONE_KINDS`).
  'phone-off': LEVELS.page,
  'phone-on': LEVELS.inform,
  // Off overrides a guardrail: a canary the analysis judges bad no longer rolls back by itself.
  'auto-rollback-off': LEVELS.page,
  'auto-rollback-on': LEVELS.inform,
  // A guardrail's proof that did not hold: the guardrail may not be holding. One that holds tells him nothing.
  'guardrail-not-held': LEVELS.page,
  'release-control': LEVELS.notify,
  'setting-changed': LEVELS.notify,
  'line-started': LEVELS.notify,
  'new-work-on': LEVELS.notify,
  'sign-in': LEVELS.inform,
  'line-stopped': LEVELS.inform,
  'new-work-off': LEVELS.inform,
  'auto-merge-off': LEVELS.inform,
  'take-narrowed': LEVELS.inform,
  'flag-narrowed': LEVELS.inform,
  'flag-off': LEVELS.inform,
};

/** What an alert says of each kind of security event: its title, and a line more. Never anything of the session. */
const SECURITY_WORDS: Record<SecurityKind, { summary: string; description: string }> = {
  'sign-in': { summary: 'Signed in as Martin', description: 'A passkey signed in to the console.' },
  'passkey-enrolled': { summary: 'A passkey was enrolled', description: 'A new passkey can sign in as Martin.' },
  'passkey-revoked': { summary: 'A passkey was revoked', description: 'A passkey can no longer sign in as Martin.' },
  'setting-changed': {
    summary: 'A setting was changed',
    description: "An agent's model or effort, or a spend cap, was changed in the console.",
  },
  'release-control': {
    summary: 'A release was promoted or retried',
    description: "The app's canary was promoted, or a stopped release retried, from the console.",
  },
  'guardrail-approved': {
    summary: 'A guardrail was overridden',
    description: 'A hold whose cause is a guardrail was approved.',
  },
  'line-started': { summary: 'The line was started', description: 'The line takes work again.' },
  'line-stopped': { summary: 'The line was stopped', description: 'The line takes no work until it is started again.' },
  'autonomy-loosened': {
    summary: 'Autonomy was loosened',
    description: "The line's autonomy level was made looser in the console.",
  },
  'autonomy-tightened': {
    summary: 'Autonomy was tightened',
    description: "The line's autonomy level was made stricter in the console.",
  },
  'new-work-on': {
    summary: 'Agents take new work again',
    description: 'Agents were let take new work in the console.',
  },
  'new-work-off': {
    summary: 'Agents take no new work',
    description: 'Agents were stopped taking new work in the console.',
  },
  'auto-merge-on': {
    summary: 'Auto-merge was turned on',
    description: 'Auto-merge of low-risk changes was turned on in the console.',
  },
  'auto-merge-off': {
    summary: 'Auto-merge was turned off',
    description: 'Auto-merge of low-risk changes was turned off in the console.',
  },
  'take-widened': {
    summary: 'The line takes more',
    description: 'What the line takes was widened in the console.',
  },
  'take-narrowed': {
    summary: 'The line takes less',
    description: 'What the line takes was narrowed in the console.',
  },
  'flag-widened': {
    summary: 'A feature flag was widened',
    description: "A feature flag's stage was widened in the console, or a flag turned back on for everyone.",
  },
  'flag-narrowed': {
    summary: 'A feature flag was narrowed',
    description: "A feature flag's stage was narrowed in the console.",
  },
  'flag-off': {
    summary: 'A feature flag was turned off',
    description: 'A feature flag was turned off for everyone in the console.',
  },
  'improvement-requested': {
    summary: 'An improvement was asked for',
    description: 'An improvement was asked for in the console, with the passkey given again.',
  },
  'improvement-approved': {
    summary: "An improvement's spec was approved",
    description: "An improvement's spec was approved in the console: the line will build it.",
  },
  'phone-off': {
    summary: 'Alerts no longer reach your phone',
    description:
      "Alerts to your phone were switched off in the console: none reaches it until they are switched on again. Grafana's Alerts dashboard still shows every alert.",
  },
  'phone-on': {
    summary: 'Alerts reach your phone again',
    description: 'Alerts to your phone were switched on in the console: every alert reaches it, at its level.',
  },
  'auto-rollback-off': {
    summary: 'Auto-rollback was turned off',
    description:
      'Auto-rollback was turned off in the console: a canary whose errors or latency the analysis judges bad now pauses for you to promote or abort, rather than rolling back by itself. A failed journeys check still rolls it back, and Stop the line still aborts one.',
  },
  'auto-rollback-on': {
    summary: 'Auto-rollback was turned on',
    description:
      'Auto-rollback was turned on in the console: a canary the analysis judges bad rolls back by itself. One already paused for you stays paused until you promote or abort it.',
  },
  'guardrail-not-held': {
    summary: 'A guardrail did not hold',
    description:
      'A proof make guardrails took did not hold, so its guardrail may not be holding. make guardrails said which, and why, and the audit log records it.',
  },
};

/**
 * The kinds of security event that reach the phone whatever the switch says: switching alerts off, so the last message
 * before quiet says so, and switching them on, which would otherwise race `PhoneOff` resolving, and often lose.
 */
export const PHONE_KINDS = ['phone-off', 'phone-on'] as const satisfies readonly SecurityKind[];

/**
 * How long a pushed series' last sample is believed. The workers send their metrics over OTLP, which leaves Prometheus
 * no staleness marker, so a worker that has gone would be read for the five minutes Prometheus looks back. They send
 * every 15 seconds, so a minute always holds a live worker's latest. `PhoneOff` and `AdminActionUncounted` read their
 * workers' word through it.
 */
export const PUSHED_FRESH = '1m';

/** One of the line's series, with any matcher given first, as only the line's pods send it. */
const fromTheLine = (name: string, matcher?: string) =>
  `${name}{${matcher ? `${matcher}, ` : ''}${METRICS_FROM_THE_LINE}}`;
export const SECURITY_EVENTS = fromTheLine('line_security_events_total');
export const HOLDS_STORED = fromTheLine('line_holds_stored_total');
/** The stages' gauges, which only a line that takes work reports, as it does each hold's age. */
const TAKES_WORK = `max(${fromTheLine('line_work_items')})`;
/** Whether the line's last read of them from the store succeeded. */
const COUNTING = fromTheLine('line_security_events_counting');

/** The alert that a change the admin service makes is named by no event, or cannot be compared with its events. */
export const ADMIN_UNCOUNTED = 'AdminActionUncounted';

/**
 * How long a change may stand with no event naming it before Martin is paged: the admin service appends its event
 * once the change is made, so for a moment none does, and the line compares every 15 seconds.
 */
export const ADMIN_UNCOUNTED_FOR = '2m';

/** What the line compares, by its action, as the alert that it cannot names it. */
const ADMIN_COMPARED_WORDS: Record<AdminAction, string> = {
  flags: "the flags' stages",
  rollout: "the app's Rollout's controls",
  sessions: 'the sessions',
};

/** What the alert says of each change no event names, and what Martin does about it. */
export const ADMIN_UNCOUNTED_WORDS: Record<AdminAction, { summary: string; description: string }> = {
  flags: {
    summary: 'The flags changed with no record',
    description:
      "flagd's flags hold a stage or a revision that no move of yours recorded: they were changed outside the console, or the admin service changed them without recording it. Controls shows each flag's stage as it is: move each that differs there, which records it, and look in the admin service's log.",
  },
  rollout: {
    summary: "The app's Rollout changed with no record",
    description:
      "The app's Rollout was paused, resumed or promoted fully with no control of yours recorded: outside the Canary panel, or by the admin service without recording it. The Canary panel shows it as it is: act there, which records it, and look in the admin service's log.",
  },
  sessions: {
    summary: 'A session started with no sign-in',
    description:
      'The store holds a session of the last hour that no sign-in recorded: someone made it outside the admin service’s sign-in, or the admin service did without recording it. End every session with make enrol REVOKE_OTHERS=1, then enrol your passkey again. This ends an hour after the session started.',
  },
};

/**
 * What an alert says of each hold that waits for Martin, by its cause: its title, which names the work item, and a line
 * more. Only the work item's number, and for a deploy whether there is a pull request, is templated into either: no
 * title, reason or visitor's text, which no label carries.
 */
export const HOLD_WORDS: Record<HoldCause, { summary: string; description: string }> = {
  suggestion: {
    summary: 'waits for you: a suggestion',
    description: 'Triage parked a suggestion: only you ask for improvements.',
  },
  finding: {
    summary: 'waits for you: the planner found something',
    description: 'The planner noticed a defect outside its ticket, which its word alone never opens.',
  },
  burst: {
    summary: 'waits for you: a burst of problems',
    description: 'One sense found more new problems at once than a handful, so their tickets wait unopened.',
  },
  environment: {
    summary: 'waits for you: held for its backends',
    description: 'Something its sense reads besides the app was not healthy when it saw the problem.',
  },
  spec: { summary: 'waits for your approval of its spec', description: 'Nothing is built until you approve it.' },
  question: { summary: 'waits for your answer', description: 'An agent asks you something only you can say.' },
  'ticket-rejected': {
    summary: 'waits for you: the planner turned it down',
    description: 'The planner judged it a ticket it cannot turn into a testable fix.',
  },
  scope: {
    summary: 'waits for you: held by the fence',
    description: "The coder changed files outside the spec's scope.",
  },
  'nothing-to-fix': {
    summary: 'waits for you: the coder found nothing',
    description: 'The coder says the code already does what the spec asks.',
  },
  failures: {
    summary: 'waits for you: a step kept failing',
    description: 'A step failed as often as the line allows.',
  },
  gates: {
    summary: 'waits for you: held by a gate',
    description: 'The gates kept failing after the returns to the coder the line allows.',
  },
  review: {
    summary: 'waits for you: held by review',
    description: 'The reviewer escalated, or still asked for changes after the last review the line allows.',
  },
  'beyond-ticket': {
    summary: 'waits for you: beyond its ticket',
    description: 'The reviewer found the spec or the change going beyond what the ticket asks.',
  },
  merge: { summary: 'waits for your merge', description: 'Its fix has passed its gates and review.' },
  deploy: {
    summary: 'waits for your deploy',
    description:
      '{{ if $labels.pull_request }}Its fix is merged, and the deploy pull request that carries it has passed its checks.{{ else }}Its release rolled back, was aborted or erred, and waits for your retry or the next deploy.{{ end }}',
  },
  canary: {
    summary: 'waits for you: a canary paused',
    description:
      'With auto-rollback off, the analysis judged its canary bad, and it keeps its share of the traffic until you promote it fully or abort it: switching auto-rollback on again leaves it paused.',
  },
  verify: {
    summary: 'waits for you: Verify asks',
    description: 'Verification after the release could not settle its ticket by itself.',
  },
  spend: {
    summary: 'waits for you: at its spend cap',
    description: 'It has spent as much on models as one may.',
  },
  'tests-first': {
    summary: 'waits for you: tests that prove nothing',
    description: 'Its new tests pass without the fix.',
  },
  unknown: { summary: 'waits for you', description: 'It is held for your answer.' },
};

/** How long each hold that waits for Martin has waited, in seconds, one series each (`line/metrics.ts`). */
export const HOLD_AGE = 'line_hold_age_seconds';
/**
 * How long a hold's alert fires once it starts to wait, or once its series appears already waiting, in minutes:
 * the line exports every 15 seconds and Prometheus evaluates every minute, so it cannot be missed, and it is far short of
 * Alertmanager's four-hour repeat, so it is sent once. Once it resolves, nothing more is sent.
 */
export const HOLD_ALERT_MINUTES = 30;

/** A work item's or a pull request's number: all a hold's series may carry to be made a link, as the line checks it. */
export const NUMBER = NUMBER_PATTERN;

/**
 * A dry run's pull requests (`DRY_RUN_NUMBERS_FROM` up), which are on no GitHub: numbers of its digits or more. A
 * dry run's merge hold still alerts, with no pull request to link.
 */
export function dryRunNumbers(from = DRY_RUN_NUMBERS_FROM): string {
  const digits = String(from);
  if (!/^10*$/.test(digits)) throw new Error(`A dry run's numbers start at ${from}, not a power of ten`);
  return `[1-9][0-9]{${digits.length - 1},}`;
}

/**
 * Each hold of a cause that waits for Martin, one series each, by work item, cause and pull request, the highest of the
 * line's replicas', which report the same; a dry run's pull request taken off, and read as it was `offset` ago if given.
 */
function holdsWaiting(cause: HoldCause, offset?: string): string {
  const selector = `${fromTheLine(HOLD_AGE, `cause="${cause}", work_item=~"${NUMBER}", pull_request=~"|${NUMBER}"`)}${offset ? ` offset ${offset}` : ''}`;
  return `max by (work_item, cause, pull_request) (label_replace(${selector}, "pull_request", "", "pull_request", "${dryRunNumbers()}"))`;
}

/**
 * The alert for each hold that waits for Martin, once: while it has waited less than `HOLD_ALERT_MINUTES`, or while its
 * series is newer than that, for one that appears having waited longer. The first is a new hold, or a hold that waits
 * for him again (a deploy pull request's checks passing after a newer build), whose series reads 0 between; the second
 * a merge hold's newer pull request, or a hold started while the line was down. A series at 0 (a hold no longer
 * waiting, until the line restarts) never fires, nor one whose age has not moved in that time: while the line cannot
 * read the store, the SDK sends each hold's last age again, which would otherwise stay young for as long.
 */
export function holdRule(cause: HoldCause): Rule {
  const waiting = holdsWaiting(cause);
  const before = holdsWaiting(cause, `${HOLD_ALERT_MINUTES}m`);
  const words = HOLD_WORDS[cause];
  return {
    alert: 'HoldWaits',
    expr: `((${waiting} > 0 < ${HOLD_ALERT_MINUTES * 60}) unless (${before} == ${waiting})) or (${waiting} > 0 unless ${before} > 0)`,
    for: '0s',
    labels: { level: LEVELS.notify },
    annotations: { summary: `#{{ $labels.work_item }} ${words.summary}`, description: words.description },
  };
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * The days Martin has, once told, to release the shop before a report in its pod's logs is older than the privacy pages
 * promise (`REPORT_TEXT.promisedDays`): time to merge a pending update or its deploy pull request.
 */
export const SHOP_POD_RELEASE_DAYS = 5;
/** How old a running shop pod is, in days, when Martin is told: `SHOP_POD_RELEASE_DAYS` before the promise. */
export const SHOP_POD_DAYS = REPORT_TEXT.promisedDays - SHOP_POD_RELEASE_DAYS;

/**
 * Each running pod of the shop, from kube-state-metrics: the Rollout's, which its ReplicaSets own, not the canary
 * analysis's journeys, which their Jobs own. Each series is the pod's, by `pod`, at 1.
 */
const SHOP_PODS_RUNNING =
  'max by (pod) (kube_pod_owner{namespace="website", owner_kind="ReplicaSet"}) and on (pod) max by (pod) (kube_pod_status_phase{namespace="website", phase="Running"} == 1)';

/** One of the admin service's series, as only its pod sends it. */
const fromTheAdminService = (name: string) => `${name}{${METRICS_FROM_THE_ADMIN_SERVICE}}`;
/** How long the app has not been seen to hold the flags as set, and since a narrowing it has not taken (`flags-held.ts`). */
export const FLAGS_DIFFERING = fromTheAdminService('admin_flags_differing_seconds');
export const FLAGS_NARROWING = fromTheAdminService('admin_flags_narrowing_seconds');
/** Whether the admin service's last check asked every pod of the app, and whether `flags` held a flag set. */
export const FLAGS_CHECKED = fromTheAdminService('admin_flags_checked');
export const FLAGS_SET = fromTheAdminService('admin_flags_set');
/** How long the app may differ from `flags` before Martin is told: long enough for flagd and the app to catch up. */
export const FLAGS_DIFFER_MINUTES = FLAGS_HELD.differMinutes;
/** How long the app has to take a narrowing or Off before Martin is paged. */
export const FLAGS_NARROWING_SECONDS = FLAGS_HELD.takeSeconds;

/**
 * The alerts that say whether the app holds the flags as Martin set them, from the admin service's checks of every pod
 * (`admin/flags-held.ts`):
 * - a page when a narrowing or Off has not been seen to reach the app within a minute, whether the app holds other flags
 *   or could not be asked: he used a kill switch, and nothing shows it worked;
 * - a notification when the app has held another flag set than `flags` for more than five minutes: flagd may have
 *   stopped watching `flags`, which leaves it ready and serving the last flags it read, so no change reaches the app;
 * - a notification when the admin service has not been able to ask every pod for as long, or its figures have gone
 *   while `flags` held a flag set: either way, a change that did not reach the app would not be told.
 *
 * Each figure is the highest of any series by its name from the admin service's pod. Its count of how long they have
 * differed goes on while it cannot ask, so the two are told apart by its checks over the five minutes: any that asked
 * every pod makes it a difference, so a pod missing one check does not swap one alert for the other.
 */
export function flagRules(): Rule[] {
  const differ = FLAGS_DIFFER_MINUTES * 60;
  const unchecked = {
    summary: 'The flags the app holds are not being checked',
    description: `For more than ${FLAGS_DIFFER_MINUTES} minutes the admin service has not been able to ask every pod of the app which flags it holds, so a change of a flag that did not reach the app would not be told.`,
  };
  return [
    {
      alert: 'FlagsNotTaken',
      expr: `max(${FLAGS_NARROWING}) > ${FLAGS_NARROWING_SECONDS}`,
      for: '0s',
      labels: { level: LEVELS.page },
      annotations: {
        summary: 'The app has not been seen to take a flag you narrowed',
        description:
          'A minute after you narrowed a flag or turned one off, the admin service has not seen every pod of the app hold the flags as you set them, or could not ask them: the app may still show the feature to those you took it from. Restart flagd, which reads them again as it starts.',
      },
    },
    {
      alert: 'FlagsDiffer',
      expr: `max(${FLAGS_DIFFERING}) > ${differ} and on () max(max_over_time(${FLAGS_CHECKED}[${FLAGS_DIFFER_MINUTES}m])) == 1`,
      for: '0s',
      labels: { level: LEVELS.notify },
      annotations: {
        summary: 'The app does not hold the flags as set',
        description: `For more than ${FLAGS_DIFFER_MINUTES} minutes a pod of the app has held other flags than the ones set: flagd may have stopped watching them. Restart flagd, which reads them again as it starts.`,
      },
    },
    {
      alert: 'FlagsUnchecked',
      expr: `max(${FLAGS_DIFFERING}) > ${differ} and on () max(max_over_time(${FLAGS_CHECKED}[${FLAGS_DIFFER_MINUTES}m])) == 0`,
      for: '0s',
      labels: { level: LEVELS.notify, worker: WORKERS.admin },
      annotations: unchecked,
    },
    {
      alert: 'FlagsUnchecked',
      // Gone for as long as Prometheus looks back for a sample (five minutes), having said in the six hours before
      // that `flags` held a flag set. One that never held any, or an admin service never given `flags`, is not missed.
      expr: `max(last_over_time(${FLAGS_SET}[6h])) == 1 unless on () count(${FLAGS_SET})`,
      for: '0s',
      labels: { level: LEVELS.notify, worker: WORKERS.admin },
      annotations: unchecked,
    },
  ];
}

/**
 * Whether alerts reach Martin's phone, from the admin service's switch in force (`admin/phone.ts`), and from the line's
 * read of the same in the store (`line/phone.ts`): 1 if so, 0 if not.
 */
export const PHONE = fromTheAdminService('admin_alerts_phone');
export const LINE_PHONE = fromTheLine('line_alerts_phone');

/**
 * Whether auto-rollback is on, from the admin service's read of Martin's switch (`admin/auto-rollback.ts`), and from
 * the line's (`line/auto-rollback.ts`): 1 if so, 0 if not, each from its own pod alone, as the canary's analysis reads
 * them.
 */
const { admin: AUTO_ROLLBACK, line: LINE_AUTO_ROLLBACK } = AUTO_ROLLBACK_SERIES;

/** The alert that mutes every alert with a level in Alertmanager while it fires. */
export const PHONE_OFF = 'PhoneOff';

/** How far back an alert to Martin looks for a new event: one or several in it are one message. */
const RECENT = '5m';

/**
 * The alerts to Martin (docs/COMPONENTS/ALERTING.md):
 * - an alert for each kind of security event, at its kind's level (`SECURITY_LEVELS`), the first of a kind included,
 *   from the line's count of them in the store, which starts at 0; several of a kind within five minutes are one alert;
 * - a page when that count has gone missing for ten minutes, having been there in the six hours before, or the line
 *   has not been able to read the store for five: no security event would reach him meanwhile;
 * - a page when a change the admin service makes (the flags, the app's Rollout, a session) stands for two minutes with
 *   no event naming it, by the line's comparison of each with Martin's events (`line/admin-actions.ts`): someone got
 *   round the audit log; and when the line has not been able to compare one for ten minutes; and when the admin
 *   service's word on auto-rollback differs from the line's read of his switch for as long;
 * - a page while Alertmanager has a silence in place, active or pending, from its own figures: a silence keeps pages
 *   from Martin, and nothing here makes one. A silence that matches this alert keeps it quiet too: the limit the dead
 *   man's switch covers (milestone 10). The rule takes the highest of any series by that name, so another can only page
 *   him more, never less;
 * - `PhoneOff`, with no level, while both the admin service and the line say alerts do not reach his phone (`PHONE`,
 *   `LINE_PHONE`): Alertmanager mutes every alert with a level while it fires, but for switching the phone itself
 *   (`PHONE_KINDS`). The admin service appends the switch, so its word alone is not enough; the line reads only what
 *   Martin's roles stored. The highest of each one's replicas' is taken, so any that says on is enough, and either
 *   saying nothing leaves every alert reaching the phone;
 * - a notification for each hold that waits for him, once, whoever started it, naming its work item, which Alertmanager
 *   links to its sheet in the console and, with its pull request, to that on GitHub (`holdRule`). Only a line that
 *   takes work reports the holds that wait; while none does, a hold triage starts is told by its cause alone, from the
 *   line's count of the holds stored, which it reports whatever its mode;
 * - a notification when a running shop pod is `SHOP_POD_DAYS` old: the node's container logs, which may hold a report's
 *   text, go only with the pod (docs/COMPONENTS/TRIAGE.md#how-long-a-report-is-kept), and a release replaces it. The oldest
 *   start of any series by that name for a pod is taken, so another can only alert him sooner, never later.
 *
 * Each that reads the line's series reads them alone (`METRICS_FROM_THE_LINE`), and takes the highest of its replicas',
 * which report the same figure.
 */
export function martinRules(): Rule[] {
  const security = SECURITY_KINDS.map((kind) => ({
    alert: 'SecurityEvent',
    expr: `max(increase(${fromTheLine('line_security_events_total', `kind="${kind}"`)}[${RECENT}])) > 0`,
    for: '0s',
    labels: { level: SECURITY_LEVELS[kind], kind },
    annotations: SECURITY_WORDS[kind],
  }));
  return [
    ...security,
    {
      alert: 'SecurityEventsUncounted',
      expr: `(count(last_over_time(${SECURITY_EVENTS}[6h])) unless count(${SECURITY_EVENTS})) or max(${COUNTING}) == 0`,
      for: '5m',
      labels: { level: LEVELS.page, worker: WORKERS.line },
      annotations: {
        summary: 'Security events are not being counted',
        description:
          'The line has not counted sign-ins and the rest for some minutes, so none of them would reach you.',
      },
    },
    ...ADMIN_ACTIONS.map((action) => ({
      alert: ADMIN_UNCOUNTED,
      expr: `max by (action) (last_over_time(${fromTheLine('line_admin_actions_uncounted', `action="${action}"`)}[${PUSHED_FRESH}])) == 1`,
      for: ADMIN_UNCOUNTED_FOR,
      labels: { level: LEVELS.page },
      annotations: ADMIN_UNCOUNTED_WORDS[action],
    })),
    ...ADMIN_ACTIONS.map((action) => ({
      alert: ADMIN_UNCOUNTED,
      expr: `max by (action) (last_over_time(${fromTheLine('line_admin_actions_compared', `action="${action}"`)}[${PUSHED_FRESH}])) == 0`,
      for: '10m',
      labels: { level: LEVELS.page, worker: WORKERS.line },
      annotations: {
        summary: `The line is not comparing ${ADMIN_COMPARED_WORDS[action]}`,
        description: `For ten minutes the line has not been able to compare ${ADMIN_COMPARED_WORDS[action]} with the events that record them, so a change none records would not reach you. The line’s log says why.`,
      },
    })),
    {
      // The admin service's word on auto-rollback, against the line's read of Martin's switch from the store: the two
      // series the canary's analysis reads (`release/analysis.ts`). Compared here, where both are, rather than by the
      // line: each worker reads the store again at every export, so they differ only for a moment after a switch.
      alert: ADMIN_UNCOUNTED,
      expr: `max(last_over_time(${AUTO_ROLLBACK}[${PUSHED_FRESH}])) != on () max(last_over_time(${LINE_AUTO_ROLLBACK}[${PUSHED_FRESH}]))`,
      for: ADMIN_UNCOUNTED_FOR,
      labels: { level: LEVELS.page, action: 'auto-rollback' },
      annotations: {
        summary: 'Auto-rollback differs from your switch',
        description:
          "The admin service says auto-rollback is one way and your latest switch in the store says the other: it reports what you did not record, or cannot read the store. A canary is paused for you only while both say off. Controls shows the switch as recorded: switch it there, which records it, and look in the admin service's log.",
      },
    },
    {
      alert: 'AlertmanagerSilenced',
      expr: 'max(alertmanager_silences{state=~"active|pending"}) > 0',
      for: '0s',
      labels: { level: LEVELS.page },
      annotations: {
        summary: 'Alerts are silenced',
        description: 'Alertmanager has a silence in place, which keeps the alerts it matches from your phone.',
      },
    },
    {
      // No level, so it reaches no one; Alertmanager mutes every alert with a level while it fires. Only while both the
      // admin service and the line say off: neither alone can keep alerts from Martin, and with either's series
      // missing (down, or not yet scraped) it cannot fire, and every alert reaches the phone.
      alert: PHONE_OFF,
      // Each from a sample in the last minute (four of the workers' exports): pushed metrics leave no stale marker, so a
      // worker gone would otherwise go on saying off for the five minutes Prometheus looks back.
      expr: `max(last_over_time(${PHONE}[${PUSHED_FRESH}])) == 0 and on () max(last_over_time(${LINE_PHONE}[${PUSHED_FRESH}])) == 0`,
      for: '0s',
      labels: {},
      annotations: {
        summary: 'Alerts are not reaching your phone',
        description:
          "Alerts to your phone are switched off in the console's Controls, or have not been switched on on this profile: Alertmanager sends none of them, and Grafana's Alerts dashboard shows them all.",
      },
    },
    ...HOLD_CAUSES.map(holdRule),
    {
      alert: 'HoldStarted',
      expr: `max by (cause) (increase(${HOLDS_STORED}[${RECENT}])) > 0 unless on () ${TAKES_WORK}`,
      for: '0s',
      labels: { level: LEVELS.notify },
      annotations: {
        summary: 'A hold waits for you',
        description:
          'A work item is held for your answer: {{ $labels.cause }}. The line takes no work, so it cannot say which: Needs you lists it.',
      },
    },
    {
      alert: 'ShopPodOld',
      expr: `max by (pod) (time() - kube_pod_start_time{namespace="website"}) > ${SHOP_POD_DAYS * DAY_SECONDS} and on (pod) (${SHOP_PODS_RUNNING})`,
      // The age only grows, so the hour costs little of the five days. A series missed for longer than Prometheus looks
      // back resolves the alert, and it is told again an hour after the series returns, not at once.
      for: '1h',
      labels: { level: LEVELS.notify },
      annotations: {
        summary: `The shop's pod is ${SHOP_POD_DAYS} days old`,
        description: `Its container logs on the node may hold a visitor's report, and they go only with the pod. Release the shop (merge a pending update, or its deploy pull request), so a new pod replaces it before a report in its logs is ${REPORT_TEXT.promisedDays} days old. With none pending, restart its Rollout: with one replica, the shop is down until the new pod is ready.`,
      },
    },
  ];
}

/**
 * The factory's workers an alert may be about, as their pods' `app.kubernetes.io/name` and Deployments name them: an
 * alert about one carries it as `worker`, so Alertmanager mutes it while that worker crash-loops, which is the cause
 * (deploy/base/telemetry/values/prometheus.yaml, `inhibit_rules`).
 */
export const WORKERS = { line: 'line', probes: 'probes', console: 'console', admin: 'admin' } as const;

/** The health alerts go on firing this long after their cause has gone, so one that comes and goes pages once. */
export const KEEP_FIRING = '10m';

/** How long an Argo CD application stays Degraded or OutOfSync before Martin is notified: long, on every profile. */
export const ARGO_CD_MINUTES = 30;

/** A pod in `factory` crash-loops when its containers restart this often within this window. */
export const CRASH_RESTARTS = 3;
export const CRASH_WINDOW = '5m';
const RESTARTS = 'kube_pod_container_status_restarts_total{namespace="factory"}';

/** How far back the probes' checks are read: eight checks of each address, at one every fifteen seconds. */
const CHECKS_WINDOW = '2m';

/** One of the probes', the gateway's or the line's series, as only its own pods send it. */
const fromTheProbes = (name: string, matcher?: string) =>
  `${name}{${matcher ? `${matcher}, ` : ''}${METRICS_FROM_THE_PROBES}}`;
const fromTheGateway = (name: string, matcher: string) => `${name}{${matcher}, ${METRICS_FROM_THE_GATEWAY}}`;

/** The probes' count of their checks (`probes/health.ts`). */
export const CHECKS = 'probes_checks_total';

/** What an alert that a target stops answering says, and which worker it is about, if one of the factory's. */
const DOWN: Record<Target, { alert: string; worker?: string; summary: string; description: string }> = {
  console: {
    alert: 'ConsoleDown',
    worker: WORKERS.console,
    summary: 'The console is not answering',
    description: `For two minutes the probes have had no answer from the console at {{ $labels.address }}: you cannot see or steer the factory there.`,
  },
  app: {
    alert: 'AppDown',
    summary: 'The app is not answering',
    description: `For two minutes the probes have had no answer from the app at {{ $labels.address }}: visitors see nothing.`,
  },
};

/**
 * Each address of a target that has answered none of the probes' checks over `CHECKS_WINDOW`, and failed at least one,
 * while the probes still check it: one series an address, by what only the probes' pod sends.
 */
function notAnswering(target: Target): string {
  const outcome = (o: string) =>
    `max by (address) (increase(${fromTheProbes(CHECKS, `target="${target}", outcome="${o}"`)}[${CHECKS_WINDOW}]))`;
  // And the probes still checking it, with a sample in the last minute: a probes pod that has fallen silent pages as
  // ProbesDown, never as the console or the app down from the failures it counted last.
  const fresh = `max by (address) (count_over_time(${fromTheProbes(CHECKS, `target="${target}"`)}[1m])) > 0`;
  return `${outcome('answered')} == 0 and on (address) ${outcome('failed')} > 0 and on (address) ${fresh}`;
}

/** The pods in `factory` a ReplicaSet owns, a Deployment's: one series a pod. */
const REPLICA_SET_PODS = 'group by (namespace, pod) (kube_pod_owner{namespace="factory", owner_kind="ReplicaSet"})';

/**
 * Each series of a pod in `factory`, a Deployment's by its worker's name: `line-7d9f8b6c4-x2b7q` is the line's. Only a
 * pod a ReplicaSet owns is named so, as a CronJob's (`line-29361234-abcde`) would read the same; a pod of a
 * StatefulSet or a Job keeps no `worker` label, and is told by its pod's name alone.
 */
const byWorker = (selector: string) =>
  `label_replace((${selector}) and on (namespace, pod) ${REPLICA_SET_PODS}, "worker", "$1", "pod", "(.+)-[a-z0-9]{5,10}-[a-z0-9]{5}") or ((${selector}) unless on (namespace, pod) ${REPLICA_SET_PODS})`;

/**
 * The alerts on the factory's health, its releases and its spend (docs/COMPONENTS/ALERTING.md):
 *
 * - **pages** when the console or the app stops answering the probes, or the probes say nothing, so neither could be
 *   told; when the line is stuck, carrying a work item past its stage's limit in force, or a lease is held five minutes
 *   past its expiry; when the store stops answering, or nothing can say whether it does; when a pod in `factory`
 *   crash-loops; when the day's or the month's spend cap is reached; and when the gateway answers a judgement without
 *   triage's token, which is triage's token not being the gateway's, or another caller asking;
 * - **notifies** when a release ends rolled back or aborted, or in error, and when an Argo CD application stays
 *   Degraded or OutOfSync for half an hour. A dry run's releases, which never shipped, are not counted.
 *
 * The health alerts keep firing ten minutes after their cause has gone (`KEEP_FIRING`), so one that comes and goes
 * pages once. Each reads only its sender's own series (the line's, the probes', the gateway's), by what the collector
 * stamps on them, or, for an exporter Prometheus scrapes, takes the figure so that another series by its name can only
 * page Martin more, never less: the lowest `pg_up`, the highest of the rest.
 */
export function factoryRules(): Rule[] {
  const health = { for: '0s', keepFiringFor: KEEP_FIRING };
  const down = TARGETS.map((target): Rule => {
    const { alert, worker, summary, description } = DOWN[target];
    return {
      alert,
      expr: notAnswering(target),
      for: '1m',
      keepFiringFor: KEEP_FIRING,
      labels: { level: LEVELS.page, ...(worker ? { worker } : {}) },
      annotations: { summary, description },
    };
  });
  const checks = fromTheProbes(CHECKS);
  const releases = (outcomes: string[]) =>
    `max by (outcome) (increase(${fromTheLine('line_releases_total', `outcome=~"${outcomes.join('|')}", dry_run="false"`)}[${RECENT}])) > 0`;
  const argo = (alert: string, label: string, status: string, summary: string, description: string): Rule => ({
    alert,
    expr: `max by (name) (argocd_app_info{${label}="${status}"}) == 1`,
    for: `${ARGO_CD_MINUTES}m`,
    keepFiringFor: KEEP_FIRING,
    labels: { level: LEVELS.notify },
    annotations: { summary, description },
  });
  return [
    ...down,
    {
      alert: 'ProbesDown',
      // Gone for as long as Prometheus looks back for a sample (five minutes), or there and counting nothing.
      expr: `sum(increase(${checks}[5m])) == 0 or absent(${checks})`,
      for: '2m',
      keepFiringFor: KEEP_FIRING,
      labels: { level: LEVELS.page, worker: WORKERS.probes },
      annotations: {
        summary: 'The probes have stopped checking',
        description:
          'The probes have said nothing for some minutes of whether the console and the app answer, so neither going down would reach you.',
      },
    },
    {
      alert: 'LineStuck',
      expr: `max by (stage) (${fromTheLine('line_taken_oldest_seconds')}) > on (stage) max by (stage) (${fromTheLine('line_taken_limit_seconds')})`,
      ...health,
      labels: { level: LEVELS.page, worker: WORKERS.line },
      annotations: {
        summary: 'The line is stuck at {{ $labels.stage }}',
        description:
          "A work item the line is carrying has stood at {{ $labels.stage }} longer than its limit: a step, a release or a look that should have ended has not. The line's dashboard shows which.",
      },
    },
    {
      alert: 'LeaseOverrun',
      expr: `max(${fromTheLine('line_lease_overrun_seconds')}) > 300`,
      ...health,
      labels: { level: LEVELS.page, worker: WORKERS.line },
      annotations: {
        summary: 'A lease on the line has run out unreleased',
        description:
          'A work item has been held for more than five minutes past its lease: the worker that took it neither finished nor let it go, and no line has taken it back.',
      },
    },
    {
      alert: 'StoreDown',
      expr: 'min(pg_up) == 0',
      for: '1m',
      keepFiringFor: KEEP_FIRING,
      labels: { level: LEVELS.page },
      annotations: {
        summary: 'The store is not answering',
        description:
          'Postgres has not answered its exporter for a minute: the line, triage and the console cannot read or record anything.',
      },
    },
    {
      // A name of its own: the store may be up, and StoreDown mutes what follows from the store being down.
      alert: 'StoreUnwatched',
      expr: 'absent(pg_up)',
      for: '5m',
      keepFiringFor: KEEP_FIRING,
      labels: { level: LEVELS.page },
      annotations: {
        summary: 'Nothing says whether the store answers',
        description:
          "Postgres's exporter has reported nothing for some minutes, so the store going down would not be told.",
      },
    },
    {
      alert: 'WorkerCrashLooping',
      // Restarts counted, not the waiting reason: CrashLoopBackOff clears at each restart, so a `for` on it starts again
      // each time, and holds only once the back-off outgrows it. Highest less lowest, as `increase` would extrapolate.
      expr: `max by (pod, worker) (${byWorker(`max_over_time(${RESTARTS}[${CRASH_WINDOW}]) - min_over_time(${RESTARTS}[${CRASH_WINDOW}])`)}) >= ${CRASH_RESTARTS}`,
      for: '0s',
      keepFiringFor: KEEP_FIRING,
      labels: { level: LEVELS.page },
      annotations: {
        summary: 'A worker is crash-looping',
        description:
          '{{ $labels.pod }} in factory has restarted three times in five minutes, and Kubernetes waits longer each time to start it again.',
      },
    },
    {
      alert: 'SpendCapReached',
      // By profile too, so two profiles' figures, as a gateway restarted under another would leave for a while, never mix.
      expr: `max by (cap, profile) (${fromTheGateway('gateway_cap_spent_usd', 'cap=~"day|month"')}) >= on (cap, profile) (min by (cap, profile) (${fromTheGateway('gateway_cap_limit_usd', 'cap=~"day|month"')}) >= 0)`,
      for: '0s',
      labels: { level: LEVELS.page },
      annotations: {
        summary: "The {{ $labels.cap }}'s spend cap is reached",
        description:
          'The gateway refuses every model call until the cap clears, when its window ends or you raise it in the console, and the line starts no step meanwhile.',
      },
    },
    {
      alert: 'JudgementsUnauthorized',
      // The highest of any gateway's, so another can only page Martin more, never less.
      expr: `max(increase(gateway_judgements_unauthorized_total{${METRICS_FROM_THE_GATEWAY}}[${RECENT}])) > 0`,
      ...health,
      labels: { level: LEVELS.page },
      annotations: {
        summary: "A judgement came without triage's token",
        description:
          "The gateway answered a judgement 401. If triage's log says the gateway refused its token, triage judges no report until it has the gateway's: run make judgements-token. If not, something else in the cluster asked Jev, which only triage may.",
      },
    },
    {
      alert: 'ReleaseRolledBack',
      expr: releases([RELEASE_ENDINGS['release.rolled-back']]),
      for: '0s',
      labels: { level: LEVELS.notify },
      annotations: {
        summary: 'A release rolled back',
        description:
          "The canary's analysis failed it, or judged it bad and you aborted it, and the stable version serves every visitor again. Its work items wait for the next deploy, or your retry.",
      },
    },
    {
      alert: 'ReleaseRolledBack',
      expr: releases([RELEASE_ENDINGS['release.aborted']]),
      for: '0s',
      labels: { level: LEVELS.notify },
      annotations: {
        summary: 'A release was aborted',
        description:
          'Its canary was stopped, by Stop the line or by hand, and the stable version serves every visitor again. Its work items wait for your retry.',
      },
    },
    {
      alert: 'ReleaseErrored',
      expr: releases([RELEASE_ENDINGS['release.errored']]),
      for: '0s',
      labels: { level: LEVELS.notify },
      annotations: {
        summary: 'A release ended in error',
        description:
          "The canary's analysis could not judge it, so it was stopped: the stable version still serves every visitor, and its work items wait for your retry.",
      },
    },
    argo(
      'ArgoCDDegraded',
      'health_status',
      'Degraded',
      'Argo CD: {{ $labels.name }} is degraded',
      `It has been Degraded for ${ARGO_CD_MINUTES} minutes: something it deploys is not healthy.`,
    ),
    argo(
      'ArgoCDOutOfSync',
      'sync_status',
      'OutOfSync',
      'Argo CD: {{ $labels.name }} is out of sync',
      `For ${ARGO_CD_MINUTES} minutes what runs has not been what main says.`,
    ),
  ];
}

const percent = (share: number) => `${Number((share * 100).toFixed(2))}%`;

interface Recording {
  record: string;
  expr: string;
  labels?: Record<string, string>;
}

/**
 * The names of the figures the objectives judge a route by, over their window (15 minutes): its requests, its share of
 * 5xx answers and its latency at the objective's percentile, as `website:route_errors:ratio_rate15m`.
 */
export function routeRecords(o: Objectives) {
  const w = `${o.windowMinutes}m`;
  const percentile = o.latency.percentile * 100;
  if (Math.abs(percentile - Math.round(percentile)) > 1e-9) {
    throw new Error(
      `The latency objective's percentile, ${o.latency.percentile}, is not a whole one to name a series by`,
    );
  }
  return {
    requests: `website:route_requests:increase${w}`,
    errorRatio: `website:route_errors:ratio_rate${w}`,
    latency: `website:route_latency_seconds:${query.percentileName(o.latency.percentile)}_rate${w}`,
  };
}

/**
 * Each route against the objectives, as the alerting rules judge it and the dashboards draw it: its requests in the
 * window, and its error ratio and latency only when it has had `minRequests`. A route that has answered no 5xx has an
 * error ratio of 0, not none. Each reads the app's own series alone, never a recorded one.
 */
export function routeFigures(o: Objectives): { requests: string; errorRatio: string; latency: string } {
  const enough = `on (http_route) (${query.requests(o)} >= ${o.minRequests})`;
  const all = query.requestRate(o);
  return {
    requests: query.requests(o),
    errorRatio: `((${query.errorRate(o)} or ${all} * 0) / ${all}) and ${enough}`,
    latency: `${query.latency(o)} and ${enough}`,
  };
}

/** The routes' figures, recorded for the dashboards under `routeRecords`' names. */
export function routeRulesFor(o: Objectives): Recording[] {
  const names = routeRecords(o);
  const figures = routeFigures(o);
  return (['requests', 'errorRatio', 'latency'] as const).map((figure) => ({
    record: names[figure],
    expr: figures[figure],
  }));
}

/**
 * How often the error budget's five-minute rates are recorded: each covers the five minutes before it, so a window of
 * hours or days is a sum of one sample every five minutes (2,016 over seven days). What is read from them is recorded
 * every minute, as Prometheus would find no sample of a series recorded only as often as it looks back for one (five
 * minutes) while its next is being written.
 */
export const BUDGET_INTERVAL = '5m';

/** Whether a rule of the budget is one of its five-minute rates, recorded every `BUDGET_INTERVAL`. */
export const isBudgetRate = (rule: Recording) => rule.record.endsWith(':rate5m');

/** The windows the share of bad requests is recorded over: two for how fast the budget burns, and the budget's own. */
export const BUDGET_WINDOWS = ['1h', '6h', '7d'] as const;

/**
 * The app's error budget, one for each objective, over every route together: the share of its requests each objective
 * allows to be bad, and how much of that the last seven days have left. A request is bad for the error ratio when it
 * answers with a 5xx status, and for latency when it is slower than the objective's bound, which the percentile allows
 * that share of. The requests are the alerting rules' (the app's own, to a route), recorded as a rate over each five
 * minutes, every five minutes (`BUDGET_INTERVAL`), so a longer window is a sum of those and costs one series to read.
 */
export function budgetRulesFor(o: Objectives): Recording[] {
  const { maxSeconds } = o.latency;
  if (!(query.LATENCY_BUCKETS as readonly number[]).includes(maxSeconds)) {
    throw new Error(`The latency objective, ${maxSeconds} s, is not a bound of the app's buckets`);
  }
  const rate = (extra: string[] = [], series = 'count') =>
    `sum(rate(${query.REQUESTS}_${series}${query.matchers(o, {}, extra)}[5m]))`;
  const allowed = (share: number) => `vector(${Number(share.toFixed(6))})`;
  return [
    { record: 'website:requests:rate5m', expr: rate() },
    {
      record: 'website:requests_bad:rate5m',
      // A version that has answered no 5xx has no such series: none is none bad, not no figure.
      expr: `${rate(['http_response_status_code=~"5.."'])} or vector(0)`,
      labels: { objective: OBJECTIVES.errorRatio },
    },
    {
      record: 'website:requests_bad:rate5m',
      expr: `${rate()} - ${rate([`le="${maxSeconds}"`], 'bucket')}`,
      labels: { objective: OBJECTIVES.latency },
    },
    {
      record: 'website:error_budget:ratio',
      expr: allowed(o.errorRatio.max),
      labels: { objective: OBJECTIVES.errorRatio },
    },
    {
      record: 'website:error_budget:ratio',
      expr: allowed(1 - o.latency.percentile),
      labels: { objective: OBJECTIVES.latency },
    },
    ...BUDGET_WINDOWS.flatMap((w) => {
      const ratio = {
        record: `website:requests_bad:ratio_rate${w}`,
        expr: `sum_over_time(website:requests_bad:rate5m[${w}]) / ignoring (objective) group_left () (sum_over_time(website:requests:rate5m[${w}]) > 0)`,
      };
      const burn = {
        record: `website:error_budget_burn:rate${w}`,
        expr: `website:requests_bad:ratio_rate${w} / on (objective) website:error_budget:ratio`,
      };
      return w === '7d' ? [ratio] : [ratio, burn];
    }),
    {
      record: 'website:error_budget_remaining:ratio7d',
      expr: '1 - website:requests_bad:ratio_rate7d / on (objective) website:error_budget:ratio',
    },
  ];
}

/**
 * The line's stuck limits, a series for each stage that has one, and what each stage's figures say against them.
 * Two replicas of the line would each report the whole store's figures, so a stage's are read with `max`, never `sum`.
 *
 * And when the line last finished a step (`LAST_STEP`): a sample, its value its own time, each minute a step was
 * counted in the five before it, and none otherwise, so the last in a week is one read of a few samples.
 */
export function stuckRulesFor(stuck: Record<StuckStage, { minutes: number | null }>): Recording[] {
  const limits = Object.entries(stuck).flatMap(([stage, { minutes }]) =>
    minutes === null
      ? []
      : [{ record: 'line:stage_limit_seconds', expr: `vector(${minutes * 60})`, labels: { stage } }],
  );
  return [
    ...limits,
    { record: 'line:work_items:max', expr: 'max by (stage) (line_work_items)' },
    { record: 'line:stage_oldest_seconds:max', expr: 'max by (stage) (line_stage_oldest_seconds)' },
    {
      record: 'line:stage_oldest:ratio_to_limit',
      expr: 'line:stage_oldest_seconds:max / on (stage) line:stage_limit_seconds',
    },
    { record: LAST_STEP, expr: 'timestamp(sum(increase(line_steps_total[5m])) > 0)' },
  ];
}

/** When the line last finished a step, as a Unix time, up to five minutes late: read it with `last_over_time`. */
export const LAST_STEP = 'line:steps:last_timestamp_seconds';

/** The values file's text. Strings are JSON strings, which YAML reads as written. */
export function render(o: Objectives, stuck = STUCK): string {
  const map = (values: Record<string, string>, indent: string) =>
    Object.entries(values)
      .map(([key, value]) => `${indent}${key}: ${JSON.stringify(value)}`)
      .join('\n');
  const alerts = (group: Rule[]) =>
    group
      .map(
        (rule) => `          - alert: ${rule.alert}
            expr: ${JSON.stringify(rule.expr)}
            for: ${rule.for}${rule.keepFiringFor ? `\n            keep_firing_for: ${rule.keepFiringFor}` : ''}
            labels:${Object.keys(rule.labels).length ? `\n${map(rule.labels, '              ')}` : ' {}'}
            annotations:
${map(rule.annotations, '              ')}`,
      )
      .join('\n');
  const recordings = (group: Recording[]) =>
    group
      .map(
        (rule) => `          - record: ${rule.record}
            expr: ${JSON.stringify(rule.expr)}${rule.labels ? `\n            labels:\n${map(rule.labels, '              ')}` : ''}`,
      )
      .join('\n');
  return `# Generated from policy/objectives.ts, policy/stuck.ts, policy/triage.ts and policy/flags.ts by
# apps/factory/src/alerts/rules.ts. Do not edit it: change the policy, then run \`node apps/factory/src/alerts/rules.ts\`. \`make check\` fails when this
# file is out of date.
serverFiles:
  alerting_rules.yml:
    groups:
      - name: objectives
        rules:
${alerts(rulesFor(o))}
      - name: martin
        rules:
${alerts(martinRules())}
      - name: flags
        rules:
${alerts(flagRules())}
      - name: factory
        rules:
${alerts(factoryRules())}
  recording_rules.yml:
    groups:
      - name: routes
        rules:
${recordings(routeRulesFor(o))}
      - name: error-budget-rates
        interval: ${BUDGET_INTERVAL}
        rules:
${recordings(budgetRulesFor(o).filter(isBudgetRate))}
      - name: error-budget
        rules:
${recordings(budgetRulesFor(o).filter((rule) => !isBudgetRate(rule)))}
      - name: line
        rules:
${recordings(stuckRulesFor(stuck))}
`;
}

/** Whether the file holds something other than what the objectives call for. */
export function outOfDate(o: Objectives, file: string = RULES_FILE): boolean {
  try {
    return readFileSync(file, 'utf8') !== render(o);
  } catch {
    return true;
  }
}

if (import.meta.main) {
  const where = relative(process.cwd(), RULES_FILE);
  if (process.argv.includes('--check')) {
    if (outOfDate(objectives)) {
      console.error(`${where} is out of date with the policy. Run: node apps/factory/src/alerts/rules.ts`);
      process.exit(1);
    }
    console.log(`${where} is current.`);
  } else {
    writeFileSync(RULES_FILE, render(objectives));
    console.log(`Wrote ${where}.`);
  }
}
