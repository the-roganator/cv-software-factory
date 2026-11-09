/**
 * Argo Rollouts' analysis of the app's canary, generated from the release policy (policy/release.ts).
 *
 *     node apps/factory/src/release/analysis.ts            # write the templates
 *     node apps/factory/src/release/analysis.ts --check    # fail if they are out of date (make check, CI)
 *
 * Two ClusterAnalysisTemplates, which the app's Rollout names:
 *
 * - `website-step`, at the end of each step: enough requests to judge, errors, latency and the journeys. A step whose
 *   canary has had too few requests fails, and says so.
 * - `website-background`, throughout the release: errors and latency every minute or so, once the canary has had
 *   enough requests to judge, and the journeys every few minutes, starting half an interval in, so that they fall
 *   between the steps' own runs rather than on them.
 *
 * Enough requests are counted at the ingress: what Traefik sent to the canary's Service, which only the traffic split
 * does. The app's own count would rest on every other client that asks the canary's Service directly saying so, and
 * would pass with no visitors at all if one did not. Errors and latency come from the app's telemetry, where canary
 * and baseline are told apart by the pod-template hash Argo Rollouts gives each version, which the collector adds to
 * the app's metrics; the Rollout passes the two hashes as arguments. Each query sums over every route the app named,
 * so it does not depend on how the app names them. The factory's own requests send `UNMEASURED` (`senses/http.ts`),
 * which the app's telemetry leaves out, so they are not judged as visitors: the journeys and the pictures of a
 * release, which ask both versions directly, and the probes and the crawler, which watch the stable Service
 * throughout. Each version is judged on its share of the visitors' requests and the traffic generator's, and the
 * queries compare shares and percentiles, not counts, since the split gives the two versions different numbers.
 *
 * **Auto-rollback** (Martin's switch in Controls, `policy/line.ts`). On, as by default, a measure judged bad fails its
 * run, and Argo Rollouts rolls the canary back. Off, errors and latency judged bad are inconclusive instead: each has a
 * failure condition beside its success condition, and a measurement that meets neither is Inconclusive, which pauses
 * the Rollout for a person (`release/watch.ts` reads it). The switch reaches the queries as two series, the admin
 * service's and the line's read of Martin's latest `controls.changed` (`admin/auto-rollback.ts`,
 * `line/auto-rollback.ts`), each held to its own pod by what the collector stamps (`provenance.ts`), so the
 * internet-facing admin service cannot switch it off alone. Each such query answers its figure once when the switch is
 * on, and the same figure twice, the second marked, only while there is exactly one fresh series from each pod and both
 * read 0 (`autoRollbackOff`): two answers that fail the success condition are inconclusive, one is a failure. Anything
 * else, a series missing, stale, doubled or reading 1, answers once, and a bad canary rolls back. Nothing here writes the
 * Rollout. A canary with no figure to judge (none of its series reached Prometheus) is not judged bad but unmeasured,
 * and still fails.
 *
 * The switch covers what the analysis judges of the canary against its baseline in Prometheus: errors and latency. It
 * leaves alone what says the analysis could not judge: too few requests still fails a step, and an analysis error
 * still aborts, as neither is a verdict on the canary. The journeys are a Job, which Argo Rollouts ends only Successful
 * or Failed, so a step's run cannot wait for the Job and then judge its result with the switch: they still roll a
 * canary back with the switch off (docs/COMPONENTS/PROGRESSIVE-DELIVERY.md says so).
 *
 * The cluster-scoped templates live in this repository, deployed with the factory's images: nothing in the app's
 * repository can loosen them, and the journeys run on the same `factory-browser` the probes run, at the digest the
 * cluster pins (deploy/overlays/local/factory-image).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stringify } from 'yaml';
import { type Release, release } from '../../../../policy/release.ts';
import { METRICS_FROM_THE_ADMIN_SERVICE, METRICS_FROM_THE_LINE } from '../provenance.ts';

export const TEMPLATES_FILE = join(import.meta.dirname, '../../../../deploy/base/analysis/templates.yaml');

/** The template names, as the app's Rollout refers to them. */
export const TEMPLATES = { step: 'website-step', background: 'website-background' } as const;

const PROMETHEUS = 'http://prometheus-server.telemetry';
const REQUESTS = 'http_server_request_duration_seconds';
/** The label the collector gives each record from the pod's `rollouts-pod-template-hash`. */
const HASH = 'k8s_pod_label_rollouts_pod_template_hash';
/** Requests Traefik sent to each of its services, from its own metrics, which Prometheus scrapes. */
const INGRESS_REQUESTS = 'traefik_service_requests_total';

/**
 * How Traefik's metrics name a Kubernetes Service that a TraefikService's split sends to: `<namespace>-<name>-<port>`
 * from its CRD provider. `http://website-canary.website` is `website-website-canary-80@kubernetescrd`.
 */
export function ingressServiceOf(url: string): string {
  const { hostname, port } = new URL(url);
  const [name, namespace] = hostname.split('.');
  if (!name || !namespace) throw new Error(`${url} does not name a Service as <name>.<namespace>`);
  return `${namespace}-${name}-${port || 80}@kubernetescrd`;
}

type Version = 'stable' | 'canary';

/** The labels of one version's requests, on every route the app named, with any matchers more. */
const labels =
  (r: Release, hash: string) =>
  (extra = '') =>
    `{job="${r.app.metricsJob}", http_route!="", ${HASH}="${hash}"${extra}}`;

/**
 * One version's own figures, by its pod-template hash, over the window: its requests, its share of 5xx answers, and its
 * latency at the policy's percentile, in seconds. Each sums over every route the app named. The templates pass the
 * hash as an argument; the release watch names it (`release/read.ts`).
 */
export function versionQueries(r: Release, hash: string) {
  const window = `[${r.windowMinutes}m]`;
  const of = labels(r, hash);
  return {
    requests: `sum(increase(${REQUESTS}_count${of()}${window}))`,
    errorShare:
      `(sum(rate(${REQUESTS}_count${of(', http_response_status_code=~"5.."')}${window})) or vector(0))\n` +
      `    / sum(rate(${REQUESTS}_count${of()}${window}))`,
    latency: `histogram_quantile(${r.latency.percentile}, sum by (le) (rate(${REQUESTS}_bucket${of()}${window})))`,
  };
}

/**
 * One version's figures on each route the app named, over `seconds` up to the moment asked: its requests, the 5xx
 * answers among them, and its latency at the policy's percentile, in seconds. A rollback's signal compares them, to
 * say where the canary did worse (`release/read.ts`).
 */
export function routeQueries(r: Release, hash: string, seconds: number) {
  const window = `[${Math.max(1, Math.round(seconds))}s]`;
  const of = labels(r, hash);
  return {
    requests: `sum by (http_route) (increase(${REQUESTS}_count${of()}${window}))`,
    errors: `sum by (http_route) (increase(${REQUESTS}_count${of(', http_response_status_code=~"5.."')}${window}))`,
    latency: `histogram_quantile(${r.latency.percentile}, sum by (le, http_route) (rate(${REQUESTS}_bucket${of()}${window})))`,
  };
}

/**
 * The PromQL behind each measure, for one release policy. Each is written across lines, as the templates show it: a
 * version's figure on a line of its own.
 */
export function queries(r: Release) {
  const window = `[${r.windowMinutes}m]`;
  const version = (v: Version) => versionQueries(r, `{{args.${v}-hash}}`);
  // Only the split sends to the canary through the ingress: the journeys ask its Service directly.
  const canaryRequests = `sum(increase(${INGRESS_REQUESTS}{service="${ingressServiceOf(r.app.canary)}"}${window}))`;
  const errorShare = (v: Version) => version(v).errorShare;
  const latency = (v: Version) => version(v).latency;
  // Nothing is judged until the split has sent the canary enough requests: the result is then empty, which passes,
  // so a step that falls short fails on `enough-requests` alone, for that reason, and not on what the journeys alone
  // made of errors and latency. Once it has, a canary measured against no stable version (no series for the stable
  // hash, as on the first release after the app is reset) is no worse than nothing, 0, which passes: there is no
  // baseline to be worse than. A canary with nothing measured (no series for its own hash) is infinitely worse, which
  // fails. With the stable version's series present, the middle line answers nothing, and the comparison is all.
  const measured = (v: Version) => version(v).requests;
  const noStable = `(\n  vector(0)\n  and on () ${measured('canary')}\n  unless on () ${measured('stable')}\n)`;
  const judged = (expr: string) =>
    `(\n${expr}\nor on () ${noStable}\nor on () vector(Inf)\n)\nand on () ${canaryRequests} >= ${r.minRequests}`;
  return {
    /** How many requests the traffic split sent the canary in the window, through the ingress. */
    requests: `${canaryRequests} or vector(0)`,
    /** The canary's share of 5xx answers, less the baseline's. */
    errors: judged(`  (\n    ${errorShare('canary')}\n  )\n-\n  (\n    ${errorShare('stable')}\n  )`),
    /**
     * How far the canary's latency is past the most it may be: the baseline's, and a quarter more or 100 ms more,
     * whichever is more. Above nought fails.
     */
    latency: judged(
      `  ${latency('canary')}\n-\n  (\n    ${latency('stable')}\n    + clamp_min(${latency('stable')} * ${r.latency.maxRatioAbove}, ${r.latency.minSecondsAbove})\n  )`,
    ),
  };
}

const prometheus = (query: string) => ({ prometheus: { address: PROMETHEUS, query } });

/** The two series of auto-rollback, each from its own pod alone: 1 on, 0 off. */
export const AUTO_ROLLBACK = {
  admin: `admin_auto_rollback{${METRICS_FROM_THE_ADMIN_SERVICE}}`,
  line: `line_auto_rollback{${METRICS_FROM_THE_LINE}}`,
} as const;

/**
 * How long a pushed series' last sample is believed, as the alerts believe the workers' (`alerts/rules.ts`'s
 * `PUSHED_FRESH`, which a test holds this to): OTLP leaves Prometheus no staleness marker, so a worker gone would be read
 * for the five minutes of Prometheus's own lookback, which this shortens to one.
 */
export const SWITCH_FRESH = '1m';

/**
 * One element, while auto-rollback is off by both: exactly one fresh series from the admin service's pod and one from
 * the line's, each reading 0. Empty otherwise: a series missing or stale, two from one pod, or either reading anything
 * but 0.
 */
export function autoRollbackOff(): string {
  const fresh = (series: string) => `last_over_time(${series}[${SWITCH_FRESH}])`;
  const one = (series: string) => `(count(${fresh(series)}) == 1 and on () max(${fresh(series)}) == 0)`;
  return `${one(AUTO_ROLLBACK.admin)}
and on () ${one(AUTO_ROLLBACK.line)}`;
}

/** The label the second answer carries while auto-rollback is off, so the two are told apart. */
export const OFF_LABEL = 'auto_rollback';

/**
 * A measure's query with the switch: its figure, and, only while auto-rollback is off by both series and the figure is
 * finite, the same figure again under `OFF_LABEL`. Both are the one figure, so `result[0]` is it whichever comes first.
 * An infinite figure, a canary with nothing measured (`queries`), is no verdict on the canary but that it could not be
 * measured, so it answers once and fails, whatever the switch.
 */
export function switched(query: string): string {
  return `(
${query}
)
or
(
  label_replace(
(
${query}
) < Inf
  , "${OFF_LABEL}", "off", "", "")
  and on ()
${autoRollbackOff()}
)`;
}

/**
 * The conditions of a measure the switch covers, from what passes: nothing to judge, or a figure within its limit. Two
 * answers that do not pass (auto-rollback off) meet neither, which Argo Rollouts calls Inconclusive; any other number of
 * answers that do not pass fails. Argo Rollouts reads the failure condition first.
 */
export function conditions(passes: string) {
  const successCondition = `len(result) == 0 || ${passes}`;
  return { successCondition, failureCondition: `len(result) != 2 && !(${successCondition})` };
}

/**
 * Errors and latency, the measures from Prometheus, each passing when there is nothing yet to judge, and inconclusive
 * rather than failed on a bad figure while auto-rollback is off.
 */
function compared(r: Release) {
  const q = queries(r);
  return [
    { name: 'errors', ...conditions(`result[0] <= ${r.errors.maxAbove}`), query: switched(q.errors) },
    { name: 'latency', ...conditions('result[0] <= 0'), query: switched(q.latency) },
  ];
}

const LABELS = { 'app.kubernetes.io/name': 'journeys', 'app.kubernetes.io/part-of': 'software-factory' };

/**
 * The journeys gate (`factory gate journeys`), as a Job in the app's namespace: the stable Service is the base and the
 * canary's the change, and the Job fails when a check that passes on the base fails on the change twice. It writes
 * those checks, and how many passed of how many ran on each, to its container's termination message, where the line
 * reads them (`release/read.ts`): the counts at each step, and the checks when the journeys fail a release. Only what
 * the gate writes there: a gate that crashed before writing leaves it empty, rather than its logs, which the line
 * would have no use for.
 */
export const JOURNEYS_MESSAGE = '/dev/termination-log';
function journeys(r: Release) {
  return {
    metadata: { labels: LABELS },
    spec: {
      // The gate runs a failing check again itself; a Job that fails has found something, or could not look.
      backoffLimit: 0,
      activeDeadlineSeconds: 900,
      template: {
        metadata: { labels: LABELS },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          // The restricted Pod Security Standard, which the namespace enforces. Chromium runs without its own sandbox,
          // as in the probes; the pod's fences hold instead.
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'journeys',
              // Pinned by digest with the factory's images (kustomize `images:`).
              image: 'factory-browser',
              args: ['src/cli.ts', 'gate', 'journeys', '--base', r.app.stable, '--change', r.app.canary],
              env: [{ name: 'COMPARISON_FILE', value: JOURNEYS_MESSAGE }],
              terminationMessagePath: JOURNEYS_MESSAGE,
              terminationMessagePolicy: 'File',
              resources: { requests: { cpu: '200m', memory: '512Mi' }, limits: { memory: '2Gi' } },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'tmp', mountPath: '/tmp' },
                { name: 'shm', mountPath: '/dev/shm' },
              ],
            },
          ],
          volumes: [
            { name: 'tmp', emptyDir: {} },
            // Chromium keeps shared memory here, and the default 64Mi is too small for a page.
            { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
          ],
        },
      },
    },
  };
}

const ARGS = [{ name: 'stable-hash' }, { name: 'canary-hash' }];

function template(name: string, metrics: unknown[]) {
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'ClusterAnalysisTemplate',
    metadata: {
      name,
      // Argo Rollouts' kinds arrive with its Application, which may not have synced yet.
      annotations: { 'argocd.argoproj.io/sync-options': 'SkipDryRunOnMissingResource=true' },
    },
    spec: { args: ARGS, metrics },
  };
}

/** What each template is for, as a comment above it in the file. */
const PURPOSE: Record<string, (r: Release) => string> = {
  [TEMPLATES.step]: () =>
    'At the end of each step: enough requests to judge, then errors, latency and the journeys against the baseline.',
  [TEMPLATES.background]: (r) =>
    `Throughout the release: errors and latency against the baseline, every ${r.background.intervalMinutes}m once there is enough to judge, and the journeys every ${r.background.journeysIntervalMinutes}m.`,
};

/** The two templates, as Kubernetes objects. */
export function templatesFor(r: Release) {
  const q = queries(r);
  const step = template(TEMPLATES.step, [
    {
      name: 'enough-requests',
      successCondition: `result[0] >= ${r.minRequests}`,
      failureLimit: 0,
      provider: prometheus(q.requests),
    },
    // A bad figure with auto-rollback off is inconclusive at once, and pauses the canary at the step it reached.
    ...compared(r).map(({ name, successCondition, failureCondition, query }) => ({
      name,
      successCondition,
      failureCondition,
      failureLimit: 0,
      inconclusiveLimit: 0,
      provider: prometheus(query),
    })),
    { name: 'journeys', failureLimit: 0, provider: { job: journeys(r) } },
  ]);
  const background = template(TEMPLATES.background, [
    // Paused on the same look that would have failed it: Argo Rollouts counts a run's inconclusive looks as it counts
    // its failed ones, across the run. It counts the two apart, and has no limit on both together, so a run whose
    // switch is flipped while it runs may see up to 2 × (failures − 1) bad looks (two, at policy’s two) before the next
    // decides, Failed or Inconclusive by the switch then: one more than a run with the switch left alone.
    ...compared(r).map(({ name, successCondition, failureCondition, query }) => ({
      name,
      interval: `${r.background.intervalMinutes}m`,
      successCondition,
      failureCondition,
      failureLimit: r.background.failures - 1,
      inconclusiveLimit: r.background.failures - 1,
      provider: prometheus(query),
    })),
    {
      name: 'journeys',
      interval: `${r.background.journeysIntervalMinutes}m`,
      initialDelay: `${(r.background.journeysIntervalMinutes * 60) / 2}s`,
      failureLimit: r.background.failures - 1,
      provider: { job: journeys(r) },
    },
  ]);
  return [step, background];
}

/** The templates file's text. */
export function render(r: Release): string {
  const header = `# Generated from policy/release.ts by apps/factory/src/release/analysis.ts. Do not edit it: change the policy, then
# run \`node apps/factory/src/release/analysis.ts\`. \`make check\` fails when this file is out of date.
`;
  const documents = templatesFor(r).map(
    (t) => `---\n# ${PURPOSE[t.metadata.name]?.(r)}\n${stringify(t, { lineWidth: 0, aliasDuplicateObjects: false })}`,
  );
  return header + documents.join('');
}

/** Whether the file holds something other than what the policy calls for. */
export function outOfDate(r: Release, file: string = TEMPLATES_FILE): boolean {
  try {
    return readFileSync(file, 'utf8') !== render(r);
  } catch {
    return true;
  }
}

if (import.meta.main) {
  const where = relative(process.cwd(), TEMPLATES_FILE);
  if (process.argv.includes('--check')) {
    if (outOfDate(release)) {
      console.error(`${where} is out of date with policy/release.ts. Run: node apps/factory/src/release/analysis.ts`);
      process.exit(1);
    }
    console.log(`${where} is current.`);
  } else {
    writeFileSync(TEMPLATES_FILE, render(release));
    console.log(`Wrote ${where}.`);
  }
}
