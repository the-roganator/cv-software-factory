import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNS, SKILL, STATE, WORK } from './paths.ts';

const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' });
const main = dirname(git('-C', SKILL, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.trim());

describe("the patching harness's state", () => {
  it.skipIf(process.env.PATCHING_HARNESS_STATE)("is the main checkout's, from whichever worktree runs it", () => {
    expect(STATE).toBe(join(main, 'scratch/patching-harness'));
  });

  it.skipIf(process.env.PATCHING_HARNESS_STATE)(
    'is never tracked: git ignores its runs, its clones and the rest',
    () => {
      for (const path of [join(STATE, 'batch.env'), join(STATE, 'images.env'), join(RUNS, 'x/state.json'), WORK])
        expect(git('-C', main, 'check-ignore', '-q', path).status, path).toBe(0);
    },
  );
});
