/**
 * `make guardrails` records proofs from a clean checkout of main's head alone (commands/guardrails.ts), so a loosened
 * script in a branch or a worktree cannot record a proof as held.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notMain } from '../../src/guardrails/command.ts';

let dir: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guardrails-main-'));
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', 'origin.git');
  git(dir, 'clone', '--quiet', 'origin.git', 'checkout');
  const checkout = join(dir, 'checkout');
  writeFileSync(join(checkout, 'a.txt'), 'a\n');
  git(checkout, 'add', 'a.txt');
  git(checkout, 'commit', '--quiet', '-m', 'a');
  git(checkout, 'push', '--quiet', 'origin', 'HEAD:main');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the checkout make guardrails records from', () => {
  it('is main’s head, clean', async () => {
    expect(await notMain(join(dir, 'checkout'))).toBeUndefined();
  });

  it('is not a commit of a branch, nor main with a change or a file not committed', async () => {
    const checkout = join(dir, 'checkout');
    writeFileSync(join(checkout, 'a.txt'), 'loosened\n');
    expect(await notMain(checkout)).toMatch(/the tree is not clean:\n M a\.txt/);
    git(checkout, 'checkout', '--quiet', '--', 'a.txt');
    writeFileSync(join(checkout, 'b.sh'), 'exit 0\n');
    expect(await notMain(checkout)).toMatch(/\?\? b\.sh/);
    rmSync(join(checkout, 'b.sh'));
    for (const flag of ['--skip-worktree', '--assume-unchanged']) {
      git(checkout, 'update-index', flag, 'a.txt');
      writeFileSync(join(checkout, 'a.txt'), 'loosened\n');
      expect(await notMain(checkout)).toMatch(/git status does not look at a\.txt/);
      git(checkout, 'update-index', flag.replace('--', '--no-'), 'a.txt');
      git(checkout, 'checkout', '--quiet', '--', 'a.txt');
    }
    writeFileSync(join(checkout, 'b.sh'), 'exit 0\n');
    git(checkout, 'add', 'b.sh');
    git(checkout, 'commit', '--quiet', '-m', 'b');
    expect(await notMain(checkout)).toMatch(/^HEAD is [0-9a-f]{40}, not origin\/main's head/);
  });
});
