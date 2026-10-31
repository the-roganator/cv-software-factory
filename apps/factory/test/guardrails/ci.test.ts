/**
 * Which CI run a `ci:` proof reads, and when it holds (guardrails/ci.ts): the newest merge-group run from this
 * repository, on main's first-parent history, that ran the proving job; every part of it passed; and it reached main no
 * more than a day before main's head did.
 */
import { describe, expect, it } from 'vitest';
import { CI_PROOFS } from '../../../../policy/guardrails.ts';
import { type Job, jobNames, readCiProof, type WorkflowRun } from '../../src/guardrails/ci.ts';

const REPO = 'the-roganator/cv-software-factory';
const WORKFLOW = `
jobs:
  kind:
    name: which checks apply
  tests:
    name: tests
    strategy:
      matrix:
        shard: [1/2, 2/2]
`;
const proof = CI_PROOFS['ci:scope-fence'];
const sha = (n: number) => String(n).repeat(40).slice(0, 40);

function runOf(n: number, at: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: n,
    html_url: `https://github.com/${REPO}/actions/runs/${n}`,
    head_sha: sha(n),
    event: 'merge_group',
    path: '.github/workflows/check.yml',
    run_attempt: 1,
    created_at: at,
    updated_at: at,
    head_repository: { full_name: REPO },
    ...overrides,
  };
}

const passed = (name: string): Job => ({ name, status: 'completed', conclusion: 'success' });

/** A fake of GitHub's API: the runs, each run's jobs, and when each commit's pull request merged. */
function github(runs: WorkflowRun[], jobs: Record<number, Job[]>, merged: Record<string, string>) {
  const asked: string[] = [];
  const read = async <T>(path: string): Promise<T> => {
    asked.push(path);
    if (path.includes('/actions/workflows/check.yml/runs')) return { workflow_runs: runs } as T;
    const run = /\/actions\/runs\/(\d+)\/jobs/.exec(path)?.[1];
    if (run) return { jobs: jobs[Number(run)] ?? [] } as T;
    const pulls = /\/commits\/([0-9a-f]{40})\/pulls$/.exec(path)?.[1];
    if (pulls) return [{ merged_at: merged[pulls] ?? null, merge_commit_sha: pulls }] as T;
    throw new Error(`unexpected ${path}`);
  };
  return { read, asked };
}

describe('a CI proof’s run', () => {
  it('names each part of a job, as GitHub does', () => {
    expect(jobNames(WORKFLOW, 'tests')).toEqual(['tests (1/2)', 'tests (2/2)']);
    expect(jobNames(WORKFLOW, 'kind')).toEqual(['which checks apply']);
    expect(() => jobNames(WORKFLOW, 'nothing')).toThrow(/no job/);
  });

  it('is the newest run on main that ran the tests, past a deploy’s that skipped them, and holds when each part passed', async () => {
    const skipped = (name: string): Job => ({ name, status: 'completed', conclusion: 'skipped' });
    const { read } = github(
      [runOf(1, '2026-10-31T10:00:00Z'), runOf(2, '2026-10-31T11:00:00Z')],
      // A skipped matrix job is listed once, by the job's own name, as GitHub lists a deploy's run.
      {
        1: [passed('tests (1/2)'), passed('tests (2/2)')],
        2: [skipped('tests')],
      },
      { [sha(1)]: '2026-10-31T10:20:00Z', [sha(2)]: '2026-10-31T11:20:00Z' },
    );
    const taken = await readCiProof({ repo: REPO, proof, workflow: WORKFLOW, firstParent: [sha(2), sha(1)], read });
    expect(taken).toMatchObject({
      held: true,
      commit: sha(1),
      run: { url: `https://github.com/${REPO}/actions/runs/1`, at: '2026-10-31T10:00:00.000Z' },
    });
    expect(taken.output).toMatch(/tests \(1\/2\): success\n {2}tests \(2\/2\): success/);
    expect(taken.output).toMatch(/1\.0 hours before main's head/);
    expect(taken.output).toMatch(/Passed over, the tests skipped: 222222222222/);
  });

  it('never counts a fork’s run, a pull request’s, another workflow’s or a commit off main’s first-parent history', async () => {
    const parts = [passed('tests (1/2)'), passed('tests (2/2)')];
    const { read } = github(
      [
        runOf(3, '2026-10-31T12:00:00Z', { head_repository: { full_name: 'someone/fork' } }),
        runOf(4, '2026-10-31T12:00:00Z', { event: 'pull_request' }),
        runOf(5, '2026-10-31T12:00:00Z', { path: '.github/workflows/other.yml' }),
        runOf(6, '2026-10-31T12:00:00Z'),
      ],
      { 3: parts, 4: parts, 5: parts, 6: parts },
      {},
    );
    const taken = await readCiProof({
      repo: REPO,
      proof,
      workflow: WORKFLOW,
      firstParent: [sha(3), sha(4), sha(5)],
      read,
    });
    expect(taken).toEqual({
      held: false,
      output: "No merge-group run of check.yml on main's last 3 first-parent commits ran tests.",
    });
  });

  it('does not hold when a part failed or is missing, or the run is more than a day older than main’s head', async () => {
    const at = '2026-10-31T10:00:00Z';
    const failed = github(
      [runOf(1, at)],
      { 1: [passed('tests (1/2)'), { name: 'tests (2/2)', status: 'completed', conclusion: 'failure' }] },
      {},
    );
    const partial = github([runOf(1, at)], { 1: [passed('tests (1/2)')] }, {});
    // A run whose parts GitHub has not listed yet is not passed over for an older one: it is the run, not done.
    const notYet = github([runOf(1, at)], { 1: [] }, {});
    for (const { read } of [failed, partial, notYet]) {
      const merged = github([], {}, { [sha(1)]: at });
      const both = <T>(path: string) => (path.includes('/pulls') ? merged.read<T>(path) : read<T>(path));
      const taken = await readCiProof({ repo: REPO, proof, workflow: WORKFLOW, firstParent: [sha(1)], read: both });
      expect(taken.held).toBe(false);
      expect(taken.output).toMatch(/✗ (tests \(1\/2\), )?tests \(2\/2\) did not pass/);
    }

    const old = github(
      [runOf(1, at)],
      { 1: [passed('tests (1/2)'), passed('tests (2/2)')], 2: [] },
      { [sha(1)]: '2026-10-29T10:00:00Z', [sha(2)]: '2026-10-31T10:00:00Z' },
    );
    const taken = await readCiProof({
      repo: REPO,
      proof,
      workflow: WORKFLOW,
      firstParent: [sha(2), sha(1)],
      read: old.read,
    });
    expect(taken.held).toBe(false);
    expect(taken.output).toMatch(/48\.0 hours before main's head/);
    expect(taken.output).toMatch(/more than a day older/);
  });
});
