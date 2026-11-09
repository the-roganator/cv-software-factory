import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * The app's gates compare a change with the commit base.sh names (app-gates.yml). A pull request that opened before
 * main moved is the case that matters: GitHub's event still names the base as it was then, while the change checked out
 * is its merge commit on main as it is now, so only the merge commit's first parent leaves main's own changes out.
 */

const SCRIPT = resolve('apps/factory/src/gates/base.sh');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf-8',
  }).trim();

/** A commit on the branch checked out that writes `file`, and its id. */
function commit(repo: string, file: string, text: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', `write ${file}`);
  return git(repo, 'rev-parse', 'HEAD');
}

/** GitHub's merge commit for the pull request on main as main is now, at refs/pull/1/merge, and its id. */
function mergeRef(repo: string): string {
  git(repo, 'checkout', '-q', '--detach', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge the pull request', 'pr');
  const merge = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/pull/1/merge', merge);
  git(repo, 'checkout', '-q', 'main');
  return merge;
}

/** The change's checkout as app-gates.yml makes it: `ref` alone, fetched two deep. */
function checkout(origin: string, ref: string): string {
  const change = mkdtempSync(join(tmpdir(), 'base-change-'));
  dirs.push(change);
  git(change, 'init', '-q');
  git(change, 'fetch', '-q', '--depth', '2', `file://${origin}`, ref);
  git(change, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  return change;
}

const base = (change: string, env: Record<string, string>) =>
  spawnSync(SCRIPT, [change], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf-8' });

/** A pull request that opened on main's first commit, and main moved on after it by a change to a test. */
function movedOn() {
  const origin = mkdtempSync(join(tmpdir(), 'base-origin-'));
  dirs.push(origin);
  git(origin, 'init', '-q');
  const opened = commit(origin, 'cart.test.ts', "expect(header).toBe('no-store');\n");
  git(origin, 'checkout', '-q', '-b', 'pr');
  commit(origin, 'cart.ts', 'export const total = 2;\n');
  git(origin, 'checkout', '-q', 'main');
  const first = mergeRef(origin);
  const moved = commit(origin, 'cart.test.ts', "expect(header).toBe('public, max-age=60');\n");
  const now = mergeRef(origin);
  return { origin, opened, first, moved, now };
}

describe("the app's gates' base (base.sh)", () => {
  it('is the base a pull request would merge into now, not the one it opened on', () => {
    const { origin, opened, moved, now } = movedOn();
    const change = checkout(origin, 'refs/pull/1/merge');
    expect(git(change, 'rev-parse', 'HEAD')).toBe(now);

    const found = base(change, { GITHUB_EVENT_NAME: 'pull_request' });
    expect(found.stderr).toBe('');
    expect(found.status).toBe(0);
    expect(found.stdout).toBe(`${moved}\n`);
    expect(found.stdout).not.toContain(opened);
  });

  it('is the base it opened on while main has not moved', () => {
    const { origin, opened, first } = movedOn();
    const change = checkout(origin, first);
    expect(base(change, { GITHUB_EVENT_NAME: 'pull_request' }).stdout).toBe(`${opened}\n`);
  });

  it('is none on a pull request whose checkout is not a merge commit', () => {
    const { origin } = movedOn();
    const change = checkout(origin, 'pr');
    const found = base(change, { GITHUB_EVENT_NAME: 'pull_request' });
    expect(found.status).toBe(1);
    expect(found.stdout).toBe('');
    expect(found.stderr).toMatch(
      /^::error::The change's checkout \([0-9a-f]{40}\) is not a pull request's merge commit/,
    );
  });

  it("is the merge group's in the merge queue", () => {
    const { origin, moved } = movedOn();
    const change = checkout(origin, 'main');
    const sha = 'a'.repeat(40);
    expect(base(change, { GITHUB_EVENT_NAME: 'merge_group', MERGE_GROUP_BASE_SHA: sha }).stdout).toBe(`${sha}\n`);
    for (const missing of [{}, { MERGE_GROUP_BASE_SHA: '' }, { MERGE_GROUP_BASE_SHA: moved.slice(0, 7) }]) {
      const found = base(change, { GITHUB_EVENT_NAME: 'merge_group', ...missing });
      expect(found.status).toBe(1);
      expect(found.stdout).toBe('');
    }
  });

  it('is none on any other event', () => {
    const { origin } = movedOn();
    const change = checkout(origin, 'refs/pull/1/merge');
    for (const event of ['push', 'pull_request_target', '']) {
      const found = base(change, { GITHUB_EVENT_NAME: event });
      expect(found.status).toBe(1);
      expect(found.stdout).toBe('');
    }
  });
});
