/**
 * Deletes the runs of the review gate's two workflows that GitHub held for Copilot, which leave a red cross behind.
 *
 *     node scripts/copilot-held-runs.ts             # in copilot-held-runs.yml, every half hour on main
 *     node scripts/copilot-held-runs.ts --dry-run   # says what it would delete, and deletes nothing
 *
 * GitHub treats Copilot as an outside contributor, so a review of Copilot's that leaves comments starts a run of
 * `pull request` (pull-request.yml) that is held for a maintainer's approval before any job starts, and fails
 * when its pull request closes. That failure starts `review` (review.yml) on main's head commit, as Copilot, held too.
 * Only Martin's reviews count, so neither has anything to judge, and a re-run is no fix: it keeps Copilot as the actor,
 * so the `review` run it starts is held in turn. Deleting a held run removes it and its check suite, and runs nothing.
 *
 * A run is deleted only when all of these hold, read from the run's id, workflow file, actors, status and conclusion,
 * and its count of jobs; nothing else of the run is read, its branch and title least of all:
 *
 * - it is a run of pull-request.yml or review.yml, by its workflow file;
 * - Copilot, by its account's id, login and type, both started it and triggered this attempt of it, so a run Martin
 *   re-ran is his to keep;
 * - it is completed, and was held (`action_required`) or failed (`failure`);
 * - it has no job, in any attempt: GitHub held it before it ran anything.
 *
 * So a held run of anyone else's, a fork's above all, waits for Martin's approval as before, and a run that did
 * something is kept, whatever became of it.
 *
 *     GH_TOKEN             the workflow's token, which may write Actions: list runs and their jobs, and delete runs
 *     GITHUB_REPOSITORY    as Actions sets it
 *     GITHUB_API_URL       as Actions sets it, or GitHub's
 */

/** Copilot's code review, by its bot account's id, which never changes; its login and type are checked too. */
export const COPILOT = { id: 175_728_472, login: 'Copilot', type: 'Bot' } as const;

/** The review gate's workflows (ADR 0014), whose runs GitHub holds for Copilot. */
export const WORKFLOWS = ['pull-request.yml', 'review.yml'] as const;

/** The conclusions of a run GitHub held: waiting for approval, or failed once its pull request closed. */
export const CONCLUSIONS = ['action_required', 'failure'] as const;

/**
 * How many pages of a hundred runs each listing reads at most, so a run of this ends whatever GitHub answers. There is
 * no window in time: the first run deletes every held run left since the gate began, about a hundred, and each run
 * after only those held since the last. Beyond a thousand of a workflow's runs with one conclusion, the rest, the
 * oldest, wait for a later pass, which finds them once those ahead are gone.
 */
export const PAGES = 10;

interface Account {
  id: number;
  login: string;
  type: string;
}

/** A workflow run, as GitHub lists it: only what the choice reads. */
export interface Run {
  id: number;
  path: string;
  status: string | null;
  conclusion: string | null;
  actor: Account | null;
  triggering_actor: Account | null;
}

const isCopilot = (account: Account | null) =>
  account?.id === COPILOT.id && account.login === COPILOT.login && account.type === COPILOT.type;

/**
 * Whether a run is one GitHub held for Copilot in the review gate's workflows, by everything but its jobs: those it
 * passes are then asked for their jobs, and deleted only with none.
 */
export function heldForCopilot(run: Run): boolean {
  return (
    WORKFLOWS.some((file) => run.path === `.github/workflows/${file}`) &&
    isCopilot(run.actor) &&
    isCopilot(run.triggering_actor) &&
    run.status === 'completed' &&
    (CONCLUSIONS as readonly (string | null)[]).includes(run.conclusion)
  );
}

/** Whether to delete a run: held for Copilot, and no job of it ever started. */
export const toDelete = (run: Run, jobs: number): boolean => heldForCopilot(run) && jobs === 0;

/** What GitHub is asked, so the tests can answer for it. */
export interface GitHub {
  /**
   * One page of a workflow's runs started by Copilot with that conclusion, a hundred at most, newest first: GitHub
   * filters by actor and conclusion, and every run it lists is checked again here.
   */
  runs(file: string, conclusion: string, page: number): Promise<Run[]>;
  /** How many jobs a run has had, in every attempt. */
  jobs(id: number): Promise<number>;
  /** Deletes a run: true once it is gone, false if it was gone already. */
  remove(id: number): Promise<boolean>;
}

/** What one pass did, by run id. */
export interface Outcome {
  deleted: number[];
  gone: number[];
  kept: number[];
  /** A run that could not be deleted, by id, or a listing that could not be read, by workflow and conclusion. */
  failed: ({ id: number; error: string } | { list: string; error: string })[];
}

/**
 * Finds every run to delete, and deletes it unless `dryRun`. Each workflow's runs are listed in full before any is
 * deleted, so a deletion never moves a run off a page not yet read.
 */
export async function sweep(github: GitHub, dryRun: boolean, log: (line: string) => void): Promise<Outcome> {
  const outcome: Outcome = { deleted: [], gone: [], kept: [], failed: [] };
  const found = new Map<number, Run>();
  for (const file of WORKFLOWS) {
    for (const conclusion of CONCLUSIONS) {
      try {
        for (let page = 1; page <= PAGES; page++) {
          const runs = await github.runs(file, conclusion, page);
          for (const run of runs) if (heldForCopilot(run)) found.set(run.id, run);
          if (runs.length < 100) break;
          if (page === PAGES) log(`::warning::${file} has ${PAGES * 100} runs ${conclusion} or more: any more wait.`);
        }
      } catch (error) {
        // What was found is still deleted; the rest of this listing waits for the next pass.
        const said = error instanceof Error ? error.message : String(error);
        outcome.failed.push({ list: `${file} ${conclusion}`, error: said });
        log(`::warning::Could not list the runs of ${file} that are ${conclusion}: ${said}`);
      }
    }
  }
  for (const run of found.values()) {
    const where = `${run.id} (${run.path.split('/').pop()}, ${run.conclusion})`;
    try {
      const jobs = await github.jobs(run.id);
      if (!toDelete(run, jobs)) {
        outcome.kept.push(run.id);
        log(`Kept ${where}: it has ${jobs} job${jobs === 1 ? '' : 's'}.`);
        continue;
      }
      if (dryRun) {
        outcome.deleted.push(run.id);
        log(`Would delete ${where}.`);
      } else if (await github.remove(run.id)) {
        outcome.deleted.push(run.id);
        log(`Deleted ${where}.`);
      } else {
        outcome.gone.push(run.id);
        log(`Gone already: ${where}.`);
      }
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      outcome.failed.push({ id: run.id, error: said });
      log(`::warning::Could not delete ${where}: ${said}`);
    }
  }
  return outcome;
}

/** GitHub's REST API, with the workflow's token. */
export function rest(repo: string, token: string, base = 'https://api.github.com'): GitHub {
  const call = async (method: string, path: string) => {
    return fetch(`${base}/repos/${repo}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
  };
  const read = async <T>(path: string): Promise<T> => {
    const response = await call('GET', path);
    if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  };
  return {
    runs: async (file, conclusion, page) =>
      (
        await read<{ workflow_runs: Run[] }>(
          `/actions/workflows/${file}/runs?actor=${COPILOT.login}&status=${conclusion}&per_page=100&page=${page}`,
        )
      ).workflow_runs,
    jobs: async (id) =>
      (await read<{ total_count: number }>(`/actions/runs/${id}/jobs?filter=all&per_page=1`)).total_count,
    remove: async (id) => {
      const response = await call('DELETE', `/actions/runs/${id}`);
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`DELETE run: ${response.status} ${await response.text()}`);
      return true;
    },
  };
}

async function main(): Promise<void> {
  const { GH_TOKEN: token = '', GITHUB_REPOSITORY: repo = '', GITHUB_API_URL: base } = process.env;
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('Needs GH_TOKEN and GITHUB_REPOSITORY (owner/name).');
  }
  const dryRun = process.argv.includes('--dry-run');
  const outcome = await sweep(rest(repo, token, base), dryRun, (line) => console.log(line));
  const { deleted, gone, kept, failed } = outcome;
  console.log(
    `${dryRun ? 'Would delete' : 'Deleted'} ${deleted.length}, gone already ${gone.length}, kept ${kept.length}, ` +
      `failed ${failed.length}.`,
  );
  if (failed.length) process.exitCode = 1;
}

if (import.meta.main) await main();
