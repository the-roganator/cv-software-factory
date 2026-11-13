import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { judge, mainGitDir, placeOf } from './main-checkout.ts';

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

// A main checkout with a subdirectory and a worktree under it, as scratch/worktrees/<key> is; a symlink to the main
// checkout, as a project path may be; a repository beside it; and a directory in none.
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'main-checkout-')));
  at.main = join(dir, 'main');
  mkdirSync(join(at.main, 'scratch'), { recursive: true });
  git(at.main, 'init', '-q', '-b', 'main');
  git(at.main, 'commit', '-q', '--allow-empty', '-m', 'main');
  at.sub = join(at.main, 'scratch');
  at.wt = join(at.main, 'scratch', 'worktrees', 'k');
  git(at.main, 'worktree', 'add', '-q', at.wt, '-b', 'feat/k');
  at.link = join(dir, 'link');
  symlinkSync(at.main, at.link);
  at.other = join(dir, 'other');
  mkdirSync(at.other);
  git(at.other, 'init', '-q', '-b', 'main');
  at.none = join(dir, 'none');
  mkdirSync(at.none);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Whether the hook refuses the command run from `cwd`, with {main}, {wt}, {link} and {other} put in. */
function refused(command: string, cwd: string): boolean {
  const filled = command.replace(/\{(\w+)\}/g, (_, k: string) => at[k] as string);
  return judge(filled, at[cwd] as string, mainGitDir(at.link)) !== undefined;
}

const HEREDOC = `git commit -m "$(cat <<'EOF'\nfix: don't drop the lock\n\nIt's kept.\nEOF\n)"`;

// [command, where it starts, refused]
const TABLE: [string, string, boolean][] = [
  // From a worktree, another repository or none, with nothing that moves it: never refused.
  [HEREDOC, 'wt', false],
  ["git commit -F - <<< 'it's a message'", 'wt', false],
  ['git reset --hard && git checkout -b x && git stash', 'wt', false],
  ['git commit -m x', 'other', false],
  ['git commit -m x', 'none', false],
  ['git commit -m "cd into the folder"', 'wt', false],
  // From the main checkout, with nothing that moves it: every refused word is refused, wherever it is.
  ...['checkout x', 'switch -c x', 'reset --hard', 'stash', 'rebase main', 'commit -m x', 'add .', 'restore .'].map(
    (sub): [string, string, boolean] => [`git ${sub}`, 'main', true],
  ),
  ['git commit -m x', 'sub', true],
  ["bash <<'EOF'\ngit checkout x\nEOF", 'main', true],
  ['bash <<\\EOF\ngit checkout x\nEOF', 'main', true],
  ['mise exec -- git checkout x', 'main', true],
  ['gh repo sync', 'main', true],
  ['gh pr checkout 12', 'main', true],
  ['git pull --ff-only origin some-feature', 'main', true],
  ['git pull --rebase', 'main', true],
  ['git pull --ff-only', 'main', false],
  ['git pull --ff-only origin main', 'main', false],
  [HEREDOC, 'main', true],
  // Reading passes everywhere: no refused word.
  ...[
    'status',
    'log --oneline -3',
    'diff HEAD',
    'fetch origin',
    'worktree add ../x -b y',
    'worktree remove ../x',
    'remote add up x',
    'branch -D old',
  ].map((sub): [string, string, boolean] => [`git ${sub}`, 'main', false]),
  ['grep -rn foo docs && gh pr view 12', 'main', false],
  // From the main checkout, moved to a worktree or another repository by a literal path.
  ['cd {wt} && git commit -m "x"', 'main', false],
  ['cd scratch/worktrees/k && git add . && git commit -m x', 'main', false],
  ['git -C {wt} reset --hard', 'main', false],
  ['git -C {wt} add . && git -C {other} commit -m x', 'main', false],
  ['cd {other} && gh pr checkout 12', 'main', false],
  // … and refused when it cannot be sure.
  ['cd gone; git add . && git commit -m x', 'main', true],
  ['cd {wt}; git commit -m x', 'main', true],
  ['cd {wt} || git commit -m x', 'main', true],
  ['cd "$WT" && git reset --hard', 'main', true],
  ['cd - && git reset --hard', 'main', true],
  ['popd && git reset --hard', 'main', true],
  ['cd {main} && git commit -m x', 'main', true],
  ['cd {none} && git commit -m x', 'main', true],
  ['git -C {wt} commit -m x && git reset --hard', 'main', true],
  ['git reset --hard && cd {wt} && git status', 'main', true],
  ['(cd {wt} && git commit -m x); git reset --hard', 'main', true],
  ['cd {wt} && cd scratch && git commit -m x', 'main', true],
  ['git -C "$WT" commit -m x', 'main', true],
  ['GIT_DIR={wt}/.git git commit -m x', 'main', true],
  // From elsewhere, a move into the main checkout is refused; one that cannot be followed is too.
  ['cd {main} && git commit -m x', 'wt', true],
  ['cd ../../.. && git reset --hard', 'wt', true],
  ['git -C {link} reset --hard', 'wt', true],
  ['git --git-dir={main}/.git --work-tree={main} reset', 'wt', true],
  ['GIT_DIR={main}/.git git commit -m x', 'other', true],
  ['cd "$SOMEWHERE" && git commit -m x', 'wt', true],
  ['cd /tmp && cd main && git commit -m x', 'wt', true],
  ['cd {other} && git commit -m x', 'wt', false],
  // A work tree named by --work-tree or GIT_WORK_TREE is a checkout directory, judged as a cd target is.
  ['GIT_WORK_TREE={main} git reset --hard', 'wt', true],
  ['git --work-tree={main} reset --hard', 'wt', true],
  ['git --work-tree {sub} checkout .', 'wt', true],
  ['GIT_WORK_TREE={main} git reset --hard', 'main', true],
  ['git --work-tree={main} reset --hard', 'main', true],
  ['GIT_WORK_TREE={other} git reset --hard', 'main', true],
  ['GIT_WORK_TREE={other} git status', 'wt', false],
  // A backgrounded list leaves what follows where it began; redirections with & are not that.
  ['cd {wt} && git commit -m x & git reset --hard', 'main', true],
  ['cd {wt} && git commit -m x 2>&1 && git log', 'main', false],
  ['cd {wt} && git commit -m x &> out.txt', 'main', false],
  ['(cd {wt} && git add x); git commit -m x', 'main', true],
  // The project's path through a symlink is still the main checkout.
  ['git reset --hard', 'link', true],
];

describe('judge', () => {
  for (const [command, cwd, expected] of TABLE) {
    it(`${expected ? 'refuses' : 'lets through'} \`${command.replace(/\n/g, '\\n')}\` from ${cwd}`, () => {
      expect(refused(command, cwd)).toBe(expected);
    });
  }

  it('lets `git pull --ff-only` through only with HEAD on main', () => {
    git(at.main as string, 'switch', '-q', '-c', 'side');
    try {
      expect(refused('git pull --ff-only', 'main')).toBe(true);
    } finally {
      git(at.main as string, 'switch', '-q', 'main');
    }
  });

  it('says in its reason what to do instead', () => {
    expect(judge('git reset --hard', at.main as string, mainGitDir(at.main))).toMatch(
      /Run it from your worktree, or as `cd \/full\/path\/to\/worktree && …` or `git -C \/full\/path\/to\/worktree …`/,
    );
  });
});

describe('placeOf', () => {
  it('tells the main checkout, its subdirectories and its symlink from a worktree, a repository and none', () => {
    const main = mainGitDir(at.main);
    expect(
      [at.main, at.sub, at.link, at.wt, at.other, at.none, join(dir, 'gone')].map((d) => placeOf(d as string, main)),
    ).toEqual(['main', 'main', 'main', 'worktree', 'repository', 'none', 'missing']);
  });
});

describe('the hook', () => {
  /** What the hook prints for a Bash call, as Claude Code gives it on stdin, run as `script`. */
  const hook = (script: string, command: string, cwd: string, project: string) =>
    spawnSync(process.execPath, [script], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      encoding: 'utf8',
    });

  it('denies a refused command in the main checkout, with the reason, run through a symlink to it too', () => {
    const linked = join(dir, 'hook.ts');
    symlinkSync(HOOK, linked);
    for (const script of [HOOK, linked]) {
      const r = hook(script, 'git reset --hard', at.link as string, at.link as string);
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout).hookSpecificOutput;
      expect(out).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
      expect(out.permissionDecisionReason).toMatch(/worktree/);
    }
  });

  it('says nothing, so the call goes on, from a worktree', () => {
    const r = hook(HOOK, HEREDOC, at.wt as string, at.main as string);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('refuses when it cannot read its input and the text names a refused command, and only then', () => {
    const run = (input: string) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' }).stdout;
    expect(run('not json')).toBe('');
    expect(JSON.parse(run(JSON.stringify({ cwd: 7, tool_input: { command: 'git reset' } })) || '{}')).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });
});
