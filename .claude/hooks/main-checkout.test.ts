import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judge, lex, mainGitDir, mutates, realRepo } from './main-checkout.ts';

const HOOK = join(import.meta.dirname, 'main-checkout.ts');
// Away from the machine's own git configuration.
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

let dir: string;
const at: Record<string, string> = {};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: ENV,
  });
}

// A main checkout with a subdirectory and a worktree under it, as scratch/worktrees/<key> is; a repository of its own
// beside it; and a directory in none.
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'main-checkout-')));
  at.main = join(dir, 'main');
  mkdirSync(join(at.main, 'scratch'), { recursive: true });
  git(at.main, 'init', '-q', '-b', 'main');
  git(at.main, 'commit', '-q', '--allow-empty', '-m', 'main');
  at.sub = join(at.main, 'scratch');
  at.wt = join(at.main, 'scratch', 'worktrees', 'k');
  git(at.main, 'worktree', 'add', '-q', at.wt, '-b', 'feat/k');
  at.other = join(dir, 'other');
  mkdirSync(at.other);
  git(at.other, 'init', '-q', '-b', 'main');
  at.none = join(dir, 'none');
  mkdirSync(at.none);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Whether the hook refuses the command run from `cwd`, with {main}, {wt}, {sub} and {other} put in. */
function refused(command: string, cwd: keyof typeof at | string): boolean {
  const filled = command.replace(/\{(\w+)\}/g, (_, k: string) => at[k] as string);
  return judge(filled, at[cwd] as string, realRepo, join(at.main as string, '.git')) !== undefined;
}

// [command, where it runs from, refused]
const TABLE: [string, string, boolean][] = [
  // Each refused subcommand in the main checkout, and from a subdirectory of it.
  ...[
    'checkout feat/k',
    'switch -c x',
    'reset --hard',
    'stash',
    'stash push -m x',
    'rebase main',
    'merge feat/k',
    'cherry-pick abc',
    'revert abc',
    'apply x.patch',
    'am x.mbox',
    'restore .',
    'clean -fd',
    'commit -m x',
    'add .',
    'rm a',
    'mv a b',
    'pull',
    'pull --rebase',
  ].map((sub): [string, string, boolean] => [`git ${sub}`, 'main', true]),
  ['git commit -m x', 'sub', true],
  // Reading, in the main checkout, is never refused.
  ...[
    'status',
    'log --oneline -3',
    'diff HEAD',
    'grep -n x',
    'fetch origin',
    'worktree add ../x -b y',
    'worktree remove ../x',
    'worktree list',
    'branch -D old',
    'stash list',
    'stash show',
    'apply --check x.patch',
    'clean -n',
    'rev-parse HEAD',
    'merge-base main HEAD',
    'push origin HEAD',
  ].map((sub): [string, string, boolean] => [`git ${sub}`, 'main', false]),
  ['git pull --ff-only', 'main', false],
  // Anywhere else, nothing is refused.
  ['git commit -m x', 'wt', false],
  ['git reset --hard', 'wt', false],
  ['git checkout -b x', 'other', false],
  ['git commit -m x', 'none', false],
  // Judged by where they act, not where the session is.
  ['git -C {wt} commit -m x', 'main', false],
  ['git -C {main} commit -m x', 'wt', true],
  ['git -C scratch/worktrees/k commit -m x', 'main', false],
  ['git -C scratch -C worktrees/k reset --hard', 'main', false],
  ['git -C .. commit -m x', 'sub', true],
  ['cd {wt} && git commit -m x', 'main', false],
  ['cd {main} && git commit -m x', 'wt', true],
  ['cd scratch/worktrees/k; git add . && git commit -m "a; b"', 'main', false],
  ['(cd {wt} && git commit -m x); git commit -m y', 'main', true],
  ['(cd {wt} && git commit -m x) && git status', 'main', false],
  ['cd ~ && cd {wt} && git stash', 'main', false],
  ['wt={wt}; cd "$wt" && git commit -m x', 'main', false],
  ['git --git-dir={main}/.git --work-tree={main} reset', 'wt', true],
  ['GIT_DIR={main}/.git git commit -m x', 'wt', true],
  ['git --work-tree={wt} status', 'main', false],
  // Read inside what runs it.
  ['bash -c "git checkout main"', 'main', true],
  ['bash -c "cd {wt} && git checkout main"', 'main', false],
  ["sh -c 'git -C {main} reset --hard'", 'wt', true],
  ['eval git reset --hard', 'main', true],
  ['env FOO=1 git commit -m x', 'main', true],
  ['echo a | xargs git rm', 'main', true],
  ['echo "$(git -C {main} stash)"', 'wt', true],
  ['x=`git checkout main`', 'main', true],
  ['gh pr checkout 12', 'main', true],
  ['gh pr checkout 12', 'wt', false],
  ['gh pr view 12', 'main', false],
  // Text that only names a command is not one.
  ['grep -rn "git checkout" docs', 'main', false],
  ["echo 'git reset --hard' > notes.txt", 'main', false],
  ['git log --grep "revert"', 'main', false],
  ['cat <<EOF > x.md\ngit reset --hard\nEOF\ngit status', 'main', false],
  ['git commit -F - <<EOF\nmessage\nEOF', 'wt', false],
  ['git commit -F - <<EOF\nmessage\nEOF', 'main', true],
  ['git status > out.txt 2>&1 && git log', 'main', false],
  // When it cannot tell, it refuses a refused subcommand, and only one.
  ['cd "$SOMEWHERE" && git commit -m x', 'wt', true],
  ['git -C "$WT" commit -m x', 'wt', true],
  ['cd - && git reset --hard', 'wt', true],
  ['cd "$SOMEWHERE" && git status', 'wt', false],
  ['git commit -m "unclosed', 'wt', true],
  ['echo "unclosed', 'main', false],
  ['git $SUB', 'main', true],
];

describe('judge', () => {
  for (const [command, cwd, expected] of TABLE) {
    it(`${expected ? 'refuses' : 'lets through'} \`${command.replace(/\n/g, '\\n')}\` from ${cwd}`, () => {
      expect(refused(command, cwd)).toBe(expected);
    });
  }

  it('lets `pull --ff-only` through only with HEAD on main', () => {
    git(at.main as string, 'switch', '-q', '-c', 'side');
    try {
      expect(refused('git pull --ff-only', 'main')).toBe(true);
    } finally {
      git(at.main as string, 'switch', '-q', 'main');
    }
  });

  it('says to use a worktree', () => {
    const why = judge('git reset --hard', at.main as string, realRepo, join(at.main as string, '.git'));
    expect(why).toMatch(/main checkout .* is refused/);
    expect(why).toMatch(/worktree/);
  });
});

describe('mutates', () => {
  it('takes the reading forms of stash, apply, clean, symbolic-ref and bisect as reading', () => {
    expect(mutates('stash', ['list'])).toBe(false);
    expect(mutates('apply', ['--stat', 'x.patch'])).toBe(false);
    expect(mutates('apply', ['--stat', '--apply', 'x.patch'])).toBe(true);
    expect(mutates('clean', ['-nd'])).toBe(false);
    expect(mutates('clean', ['-fd'])).toBe(true);
    expect(mutates('symbolic-ref', ['HEAD'])).toBe(false);
    expect(mutates('symbolic-ref', ['HEAD', 'refs/heads/x'])).toBe(true);
    expect(mutates('bisect', ['log'])).toBe(false);
    expect(mutates('bisect', ['start'])).toBe(true);
    expect(mutates('status', [])).toBe(false);
  });
});

describe('lex', () => {
  it('cannot read an unclosed quote', () => {
    expect(lex('echo "a')).toBeUndefined();
    expect(lex("echo 'a")).toBeUndefined();
  });

  it('keeps quoted separators in their word', () => {
    expect(lex('git commit -m "a; b && c"')?.length).toBe(4);
  });
});

describe('the hook', () => {
  /** What the hook prints for a Bash call, as Claude Code gives it on stdin. */
  const hook = (command: string, cwd: string) =>
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }),
      encoding: 'utf8',
    });

  it("denies a refused command in this repository's main checkout, with the reason", () => {
    const main = join(mainGitDir(), '..');
    const r = hook(`git -C ${main} reset --hard`, at.none as string);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/worktree/);
  });

  it('says nothing, so the call goes on, anywhere else', () => {
    const r = hook('git reset --hard', at.wt as string);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
