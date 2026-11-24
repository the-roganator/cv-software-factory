/**
 * Where the harness's files are. The skill's own (TESTS.md, baseline.env, app.env, staged/) are tracked beside this
 * folder; everything a run makes or keeps is in the state folder, never in the tracked tree: the main checkout's
 * git-ignored `scratch/patching-harness/`, found from any worktree, or `PATCHING_HARNESS_STATE`. copies.sh finds it the
 * same way.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export const BIN = import.meta.dirname;
export const SKILL = dirname(BIN);

const mainCheckout = () =>
  dirname(
    execFileSync('git', ['-C', BIN, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
    }).trim(),
  );

export const STATE = process.env.PATCHING_HARNESS_STATE || join(mainCheckout(), 'scratch/patching-harness');
/** The runs: each one's log, state, scans and workers' logs. */
export const RUNS = join(STATE, 'runs');
/** The two baselines' clones, as copies.sh builds them. */
export const WORK = join(STATE, 'work');
