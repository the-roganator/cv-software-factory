/**
 * Something ran it (ADR 0019, condition 8): the check that runs what the pin runs, by its place, succeeded at the head
 * in this repository's own workflow for this pull request, and, for what a cluster runs, a workload there starts it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments, parse as parseYaml } from 'yaml';
import type { Move } from './pin-move-one.ts';
import { ROOT, record, short } from './pin-move-shared.ts';

/** A check run, as the checks API lists them for a commit. */
export interface Run {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  app: { slug: string } | null;
  check_suite?: { id: number } | null;
  /**
   * The workflow file whose run made it, as `workflowsOf` reads it from its check suite: only a run of this repository,
   * on a pull request from this repository, at the run's own head. Anything else, or unread, is null.
   */
  workflow?: string | null;
}

/** A workflow run, as the Actions API lists them for a commit: the one fact that ties a check run to its file. */
export interface WorkflowRun {
  id: number;
  path: string;
  event: string;
  head_sha: string;
  /** The branch it ran from, and when it was made: a run older than the pull request was made for another. */
  head_branch: string | null;
  created_at: string;
  check_suite_id: number;
  repository: { full_name: string } | null;
  head_repository: { full_name: string } | null;
  /** The pull requests GitHub ran it for: this repository's open ones at the head, none once they closed. */
  pull_requests?: { number: number; base: { ref: string } }[] | null;
}

/**
 * The pull request a check must have run for: its number, its head branch, when it was opened, and whether it is open
 * (a replay by hand is not).
 */
export interface For {
  number: number;
  ref: string;
  created: string;
  open: boolean;
}

/** GitHub Actions, the one app whose check runs are the workflows'. */
export const ACTIONS = 'github-actions';

/** The jobs of check.yml that run what a pin runs, by the place of the pin. `tests` is a matrix of shards. */
export const ZAP_CHECK = 'ZAP scan';
export const IMAGE_CHECK = 'image builds';
export const TEST_SHARDS = ['tests (1/3)', 'tests (2/3)', 'tests (3/3)'];
/** platform.yml's job that makes a cluster from the change and passes once everything on it runs. */
export const PLATFORM_CHECK = 'platform';

export const CHECK_WORKFLOW = '.github/workflows/check.yml';
export const PLATFORM_WORKFLOW = '.github/workflows/platform.yml';
/** The workflow each check must come from: a job of the same name in any other workflow ran something else. */
export const WORKFLOW_OF: Readonly<Record<string, string>> = {
  [ZAP_CHECK]: CHECK_WORKFLOW,
  [IMAGE_CHECK]: CHECK_WORKFLOW,
  ...Object.fromEntries(TEST_SHARDS.map((name) => [name, CHECK_WORKFLOW])),
  [PLATFORM_CHECK]: PLATFORM_WORKFLOW,
};

/** ZAP's image, which the browser tests' scan starts: `ZAP scan` runs it. */
export const ZAP_FILE = 'apps/console/zap/scan.ts';
/** The Postgres the cluster runs, whose pin CI's own database is (scripts/ci-images.sh postgres): `tests` run it. */
export const POSTGRES_FILE = 'deploy/base/postgres/statefulset.yaml';

/**
 * What runs a pin, by its place: the check runs at the head that must have succeeded, or why none runs it, so it is
 * held. A pin in deploy/ the cluster runs from the change itself (a chart, its value, a third-party image) needs
 * `platform`, which makes a cluster from the change; Postgres needs it beside `tests`, which run the same pin as CI's
 * database. An image of ours never gets here (condition 3), and a Dockerfile's stage in deploy/ builds an image the
 * cluster runs only once build.yml has built it on main, which no check at the head does.
 */
export function whatRunsIt(move: Move): { checks: string[] } | { reason: string } {
  const files = new Set(move.pins.map((m) => m.place.file));
  const only = (file: string) => files.size === 1 && files.has(file);
  if (move.kind === 'k3s' || move.kind === 'k3s-release' || move.kind === 'k3d')
    return {
      reason: `${move.name} is the cluster's own: a k3s move waits for Martin, whose cluster moves with it, whatever the platform check says`,
    };
  if (move.what === 'image' && move.kind === 'workflow' && only(ZAP_FILE)) return { checks: [ZAP_CHECK] };
  if (move.what === 'image' && move.kind === 'dockerfile' && [...files].every((f) => !f.startsWith('deploy/')))
    return { checks: [IMAGE_CHECK] };
  if (
    files.has('Makefile') ||
    move.pins.some(
      (m) => m.item === 'argocd' || m.chart?.base.chart === 'argo-cd' || m.chart?.head.chart === 'argo-cd',
    ) ||
    [...files].some((f) => f.startsWith('deploy/argocd/'))
  )
    return { reason: `${move.name} is installed by make up: a merge does not apply it` };
  const inDeploy = [...files].every((f) => f.startsWith('deploy/'));
  if (move.what === 'image' && move.kind === 'third-party' && only(POSTGRES_FILE))
    return { checks: [...TEST_SHARDS, PLATFORM_CHECK] };
  if (inDeploy && (move.kind === 'chart' || (move.what === 'image' && move.kind === 'third-party')))
    return { checks: [PLATFORM_CHECK] };
  return { reason: `no check at the head runs ${move.name}: nothing shows it ran` };
}

/** The kinds whose pods the platform check holds to running and ready (scripts/platform-pods.sh). */
const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

/** A workload by its kind, name and namespace, as a kustomize patch's target names one. */
export interface Workload {
  kind: string;
  name: string;
  namespace?: string;
}

/** The workloads platform.yml's cluster changes from what `main` runs (deploy/argocd/platform-check.yaml), main's file. */
export function patchedByTheCheck(
  text = readFileSync(join(ROOT, 'deploy/argocd/platform-check.yaml'), 'utf-8'),
): Workload[] | string {
  const patches = parseYaml(text) as { target?: Record<string, unknown> }[] | null;
  if (!Array.isArray(patches) || !patches.length) return 'the platform check names no patches the gate can read';
  const targets: Workload[] = [];
  for (const { target } of patches) {
    // A target by kind and name alone: one by selector, or with no name, could reach a workload the gate cannot tell.
    const { kind, name, namespace, ...rest } = target ?? {};
    if (
      typeof kind !== 'string' ||
      typeof name !== 'string' ||
      Object.keys(rest).some((key) => key !== 'group' && key !== 'version')
    )
      return `the platform check patches a target the gate cannot match by kind and name: ${short(JSON.stringify(target ?? null))}`;
    targets.push({ kind, name, ...(typeof namespace === 'string' ? { namespace } : {}) });
  }
  return targets;
}

/**
 * Whether a cluster made from the change starts an image: some document of the rendering, read as YAML, is a
 * Deployment, StatefulSet or DaemonSet whose pod template runs it as a container or an init container, by that exact
 * reference, with no hook annotation (Helm's or Argo CD's), at a number of replicas that is a whole number above
 * nought, and not one the platform check's own patches change (`patched`). An image only a hook, a Job or a CronJob
 * runs, one named only in an argument, or one no such workload runs, is never pulled by the platform check's cluster as
 * this pin, so the check proves nothing of it. A rendering that is not YAML holds.
 */
export function started(
  rendered: string,
  references: readonly string[],
  patched: readonly Workload[] = [],
): string | undefined {
  const documents = parseAllDocuments(rendered);
  if (documents.some((doc) => doc.errors.length))
    return 'the rendering is not YAML the gate can read, so nothing shows what starts the image';
  const workloads = documents.map((doc) => record(doc.toJS()));
  for (const reference of references) {
    const runs = workloads.some((doc) => {
      const metadata = record(doc.metadata);
      const spec = record(doc.spec);
      if (typeof doc.kind !== 'string' || !WORKLOADS.has(doc.kind)) return false;
      const annotations = Object.keys(record(metadata.annotations));
      if (annotations.some((key) => key === 'helm.sh/hook' || key === 'argocd.argoproj.io/hook')) return false;
      if ('replicas' in spec && !(Number.isInteger(spec.replicas) && (spec.replicas as number) > 0)) return false;
      if (
        patched.some(
          (target) =>
            target.kind === doc.kind &&
            target.name === metadata.name &&
            (!target.namespace || !metadata.namespace || target.namespace === metadata.namespace),
        )
      )
        return false;
      const pod = record(record(spec.template).spec);
      const containers = [pod.containers, pod.initContainers].flatMap((list) => (Array.isArray(list) ? list : []));
      return containers.some((container) => record(container).image === reference);
    });
    if (!runs)
      return `no workload the platform check runs starts ${short(reference)}: a hook, a Job or nothing at all runs it, so its cluster never pulled it`;
  }
  return undefined;
}

/**
 * The check runs at the head, each with the workflow file that made it, read from the workflow run of its check suite:
 * a run of this repository (`repo`), on `pull_request`, from a branch of this repository, at the check run's own head,
 * from this pull request's branch, made no earlier than the pull request, which GitHub lists among its pull requests into
 * main. A check run whose suite is not such a run (another app's, a fork's, another event's, another head's, another
 * branch's, or one made before this pull request) has none. A run's `pull_requests` are the open pull requests whose head
 * it matches now, with their bases now, not the one it ran for: the branch and the time bind it, and `readPinMove` holds
 * a pull request with a sibling from the same branch. GitHub empties that list once they close, so a replay of a closed
 * one by hand takes a run that names none.
 */
export function workflowsOf(checks: readonly Run[], workflows: readonly WorkflowRun[], repo: string, pr: For): Run[] {
  return checks.map((run) => {
    const suite = run.check_suite?.id;
    const made = workflows.find((w) => suite !== undefined && w.check_suite_id === suite);
    const ours =
      made &&
      made.repository?.full_name === repo &&
      made.head_repository?.full_name === repo &&
      made.event === 'pull_request' &&
      made.head_sha === run.head_sha &&
      made.head_branch === pr.ref &&
      Date.parse(made.created_at) >= Date.parse(pr.created) &&
      ((made.pull_requests ?? []).some((p) => p.number === pr.number && p.base.ref === 'main') ||
        (!pr.open && !made.pull_requests?.length));
    return { ...run, workflow: ours ? made.path : null };
  });
}

/**
 * Whether each check ran at the head and succeeded: every run of each name at the head, from the workflow that has that
 * job (`WORKFLOW_OF`), at its latest attempt, completed, a success. Attempts of one workflow run share its check suite,
 * so a re-run that succeeds counts; a second run that succeeds never hides another that failed. A run of the same name
 * from anywhere else counts for nothing; skipped, cancelled or failed is no success.
 */
export function ranIt(runs: readonly Run[], head: string, checks: readonly string[]): string | undefined {
  for (const name of checks) {
    const workflow = WORKFLOW_OF[name];
    if (!workflow) return `the gate knows no workflow that runs ${name}`;
    const named = runs.filter((run) => run.name === name && run.head_sha === head && run.app?.slug === ACTIONS);
    const bySuite = new Map<number | string, Run>();
    for (const run of named.filter((each) => each.workflow === workflow)) {
      const suite = run.check_suite?.id ?? `run ${run.id}`;
      const seen = bySuite.get(suite);
      if (!seen || run.id > seen.id) bySuite.set(suite, run);
    }
    const latest = [...bySuite.values()].sort((a, b) => b.id - a.id);
    if (!latest.length)
      return named.length
        ? `${name} at ${head.slice(0, 7)} ran in no run of ${workflow} for this pull request that the gate could read`
        : `${name} has not run at ${head.slice(0, 7)}`;
    const unfinished = latest.find((run) => run.status !== 'completed');
    if (unfinished) return `${name} has not finished at ${head.slice(0, 7)}`;
    const failed = latest.find((run) => run.conclusion !== 'success');
    if (failed)
      return `${name} at ${head.slice(0, 7)} is ${failed.conclusion ?? 'unfinished'}, not a success: ${
        name === PLATFORM_CHECK && failed.conclusion === 'skipped'
          ? 'it made no cluster from the change'
          : 'something must run it'
      }`;
  }
  return undefined;
}
