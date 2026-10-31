/**
 * A proof read from CI (`ci:` in the catalogue): the run that counts, and whether it held.
 *
 * `check.yml` runs on pull requests and in the merge queue only, never on a push to `main`, and a deploy pin's run in
 * the queue skips the tests. So the run that counts is the newest `merge_group` run of the proof's workflow, from this
 * repository (never a fork's, never a pull request's), whose commit is on `main`'s first-parent history (the commit
 * `main` moved to), walking back from `main`'s head past runs where the proving job was skipped. It holds if every
 * part of the job passed in that run, and that commit reached `main` no more than a day before `main`'s head did, each
 * measured by when it reached `main` (its pull request's merge), not by its commit date.
 */
import { parse } from 'yaml';
import type { CiProof } from '../../../../policy/guardrails.ts';

/** A read of GitHub's API, by path, as JSON. */
export type Read = <T>(path: string) => Promise<T>;

export interface WorkflowRun {
  id: number;
  html_url: string;
  head_sha: string;
  event: string;
  path: string;
  run_attempt?: number;
  created_at: string;
  updated_at: string;
  head_repository?: { full_name?: string } | null;
}

export interface Job {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at?: string | null;
}

/** How far back the walk goes, in `main`'s first-parent commits. */
export const WALK = 200;
/** How much older than `main`'s head the run's commit may have reached `main`. */
export const FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * The names GitHub gives a job's parts: its name, or its key, and for a matrix of one dimension each value in
 * brackets, as `tests (1/3)`.
 */
export function jobNames(workflow: string, key: string): string[] {
  const job = (parse(workflow) as { jobs?: Record<string, { name?: string; strategy?: { matrix?: unknown } }> }).jobs?.[
    key
  ];
  if (!job) throw new Error(`no job ${key} in the workflow`);
  const name = job.name ?? key;
  const matrix = job.strategy?.matrix as Record<string, unknown> | undefined;
  if (!matrix) return [name];
  const dimensions = Object.entries(matrix).filter(([k]) => k !== 'include' && k !== 'exclude');
  const [dimension, ...more] = dimensions;
  if (!dimension || more.length || !Array.isArray(dimension[1]) || 'include' in matrix || 'exclude' in matrix) {
    throw new Error(`job ${key}'s matrix is not one list of values`);
  }
  return (dimension[1] as unknown[]).map((value) => `${name} (${String(value)})`);
}

export interface CiReading {
  repo: string;
  proof: CiProof;
  /** The proof's workflow, as `main` has it. */
  workflow: string;
  /** `main`'s first-parent history, its head first. */
  firstParent: string[];
  read: Read;
}

export interface CiTaken {
  held: boolean;
  output: string;
  commit?: string;
  run?: { url: string; at: string };
}

/** When a commit reached `main`: its pull request's merge, or its committer's date for one that came otherwise. */
async function reachedMain(read: Read, repo: string, sha: string): Promise<Date> {
  const pulls = await read<{ merged_at: string | null; merge_commit_sha?: string | null }[]>(
    `/repos/${repo}/commits/${sha}/pulls`,
  );
  const merged = pulls.find((p) => p.merge_commit_sha === sha && p.merged_at) ?? pulls.find((p) => p.merged_at);
  if (merged?.merged_at) return new Date(merged.merged_at);
  const commit = await read<{ commit: { committer: { date: string } } }>(`/repos/${repo}/commits/${sha}`);
  return new Date(commit.commit.committer.date);
}

const short = (sha: string) => sha.slice(0, 12);

export async function readCiProof({ repo, proof, workflow, firstParent, read }: CiReading): Promise<CiTaken> {
  const names = jobNames(workflow, proof.job);
  const file = proof.workflow.split('/').at(-1);
  const runs: WorkflowRun[] = [];
  for (let page = 1; page <= 3; page++) {
    const { workflow_runs } = await read<{ workflow_runs: WorkflowRun[] }>(
      `/repos/${repo}/actions/workflows/${file}/runs?event=merge_group&per_page=100&page=${page}`,
    );
    runs.push(...workflow_runs);
    if (workflow_runs.length < 100) break;
  }
  // This repository's merge-queue runs of this workflow, by commit, the newest first.
  const counted = runs.filter(
    (r) =>
      r.event === 'merge_group' &&
      r.head_repository?.full_name === repo &&
      (r.path === proof.workflow || r.path.startsWith(`${proof.workflow}@`)),
  );
  const bySha = new Map<string, WorkflowRun[]>();
  for (const r of [...counted].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
    bySha.set(r.head_sha, [...(bySha.get(r.head_sha) ?? []), r]);
  }

  const passedOver: string[] = [];
  const head = firstParent[0];
  if (!head) return { held: false, output: "main's history could not be read" };
  for (const sha of firstParent.slice(0, WALK)) {
    for (const run of bySha.get(sha) ?? []) {
      const { jobs } = await read<{ jobs: Job[] }>(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
      const parts = names.map((name) => ({ name, job: jobs.find((j) => j.name === name) }));
      // A deploy's run skips the tests: GitHub then lists the job once, by its own name, unexpanded, or each part, every
      // one completed and skipped. A part missing otherwise is a run not done yet, which is this proof's run, unpassed.
      const skippedJob = (job?: Job) => job?.status === 'completed' && job.conclusion === 'skipped';
      const whole = jobs.find((j) => j.name === proof.job);
      const skippedRun =
        parts.every(({ job }) => skippedJob(job)) || (parts.every(({ job }) => !job) && skippedJob(whole));
      if (skippedRun) {
        passedOver.push(`${short(sha)} (${run.html_url}): ${proof.job} skipped`);
        continue;
      }
      const [reached, headReached] = await Promise.all([reachedMain(read, repo, sha), reachedMain(read, repo, head)]);
      const behindMs = headReached.getTime() - reached.getTime();
      const failed = parts.filter(({ job }) => job?.status !== 'completed' || job.conclusion !== 'success');
      const fresh = behindMs <= FRESH_MS;
      const lines = [
        `${file}'s merge-group run ${run.html_url} (attempt ${run.run_attempt ?? 1}) on ${short(sha)}, main's ${
          firstParent.indexOf(sha) === 0 ? 'head' : `head~${firstParent.indexOf(sha)}`
        }:`,
        ...parts.map(({ name, job }) => `  ${name}: ${job ? (job.conclusion ?? job.status) : 'missing'}`),
        `It reached main at ${reached.toISOString()}, ${(behindMs / 3_600_000).toFixed(1)} hours before main's head ${short(head)} did.`,
        `Its tests: ${proof.tests.join(', ')}.`,
      ];
      if (failed.length) lines.push(`✗ ${failed.map(({ name }) => name).join(', ')} did not pass.`);
      if (!fresh) lines.push("✗ It is more than a day older than main's head: a newer run must run its tests.");
      if (passedOver.length) lines.push(`Passed over, the tests skipped: ${passedOver.join('; ')}.`);
      return {
        held: !failed.length && fresh,
        output: lines.join('\n'),
        commit: sha,
        run: {
          url: run.html_url,
          at: new Date(run.updated_at).toISOString(),
        },
      };
    }
  }
  return {
    held: false,
    output: `No merge-group run of ${file} on main's last ${Math.min(WALK, firstParent.length)} first-parent commits ran ${proof.job}.`,
  };
}
