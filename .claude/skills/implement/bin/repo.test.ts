import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_SH = join(import.meta.dirname, 'repo.sh');
// Away from the machine's own git configuration: its hooks, its default branch, its pruning.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

let dir: string;
let checkout: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: ENV,
    encoding: 'utf8',
  }).trim();
}

function ownCommits(worktree: string): number {
  return Number(
    execFileSync('bash', ['-c', `. "${REPO_SH}" && own_commits "$1"`, 'test', worktree], {
      env: ENV,
      encoding: 'utf8',
    }),
  );
}

/** A worktree made as worktree.sh makes one, from `base`, with `commits` commits of its own on it. */
function worktree(name: string, base: string, commits: number): string {
  const path = join(dir, name);
  git(checkout, 'worktree', 'add', '-q', '--no-track', path, '-b', name, base);
  for (let i = 0; i < commits; i++) git(path, 'commit', '-q', '--allow-empty', '-m', `${name} ${i}`);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'own-commits-'));
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(dir, 'clone', '-q', 'origin.git', 'checkout');
  checkout = join(dir, 'checkout');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'main');
  git(checkout, 'push', '-q', 'origin', 'HEAD:main');
  git(checkout, 'switch', '-q', '-c', 'below');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'below 1');
  git(checkout, 'commit', '-q', '--allow-empty', '-m', 'below 2');
  git(checkout, 'push', '-q', 'origin', 'below');
  git(checkout, 'switch', '-q', '--detach');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('own_commits', () => {
  it('counts nothing on a worktree made from the branch below in a stack', () => {
    expect(ownCommits(worktree('above', 'origin/below', 0))).toBe(0);
  });

  it('counts the commits made on a stacked worktree since it was made', () => {
    expect(ownCommits(worktree('above', 'origin/below', 1))).toBe(1);
  });

  it('counts the commits made on a worktree from origin/main', () => {
    expect(ownCommits(worktree('alone', 'origin/main', 2))).toBe(2);
  });

  it('still counts from the branch below once it has merged and been pruned', () => {
    const above = worktree('above', 'origin/below', 0);
    git(checkout, 'push', '-q', 'origin', '--delete', 'below');
    git(checkout, 'branch', '-q', '-D', 'below');
    git(checkout, 'fetch', '-q', '--prune', 'origin');
    expect(ownCommits(above)).toBe(0);
  });
});

describe('pr_files', () => {
  /**
   * The files pull request 7 changes, as pr_files lists them, from a gh on PATH that answers the files API with these
   * pages as `gh api --paginate` does, running the -q filter on each page alone, and fails on anything else: so on
   * `gh pr diff`, as GitHub does past 300 files.
   */
  function prFiles(pages: string[][]): string[] {
    writeFileSync(join(dir, 'pages.json'), JSON.stringify(pages.map((page) => page.map((filename) => ({ filename })))));
    const gh = join(dir, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
[[ "$*" == "api repos/owner/name/pulls/7/files?per_page=100 --paginate -q "* ]] || { echo "gh: refused: $*" >&2; exit 1; }
jq -c '.[]' "${join(dir, 'pages.json')}" | while IFS= read -r page; do jq -r "$5" <<<"$page"; done
`,
    );
    chmodSync(gh, 0o755);
    const out = execFileSync('bash', ['-c', `. "${REPO_SH}" && pr_files owner/name 7`], {
      env: { ...ENV, PATH: `${dir}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  }

  it('lists every file across pages, past the 300 gh pr diff gives up at', () => {
    const files = Array.from({ length: 423 }, (_, i) => `tests/snapshots/${i}.png`);
    const pages = [
      files.slice(0, 100),
      files.slice(100, 200),
      files.slice(200, 300),
      files.slice(300, 400),
      files.slice(400),
    ];
    expect(prFiles(pages)).toEqual(files);
  });

  it('keeps a path with spaces whole', () => {
    expect(prFiles([['docs/a file.md', '.github/CODEOWNERS']])).toEqual(['docs/a file.md', '.github/CODEOWNERS']);
  });
});
