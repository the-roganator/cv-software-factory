#!/usr/bin/env node
// A PreToolUse hook on the Bash tool (.claude/settings.json): keeps a git command that moves HEAD or rewrites the index
// or tree out of the main checkout, which sessions share; each works in a worktree of its own (scratch/worktrees/<key>).
// It reads no shell syntax, so no quoting or here-document can hide a command from it. It decides from three things:
//   1. Where the command starts (the call's cwd): the main checkout (git's directory is the common one, and it is the
//      project's repository), a worktree, another repository, or no repository.
//   2. Whether the text names git or gh and, anywhere after, a refused subcommand (REFUSED, or gh's `repo sync`),
//      code and quoted text alike. If not, the command passes: reading is never refused.
//   3. Whether the text moves where commands act: cd, pushd, popd, -C, --git-dir, --work-tree, GIT_DIR, GIT_WORK_TREE,
//      as whole words.
// From a worktree, another repository or none, with no such word, it passes, whatever the text: a commit there is the
// common case. From the main checkout with none, it refuses, but `git pull --ff-only` (or `… origin main`) alone with
// HEAD on main. With such words, each target must be a literal path (no variable, no `cd -`, no popd), and only the
// first may be relative, as the others would be read from a directory the hook cannot know. From elsewhere, a target
// must not be the main checkout. From the main checkout, every target must exist and be a worktree or another
// repository, and either the text starts `cd <target> &&` or every `git` in it is `git -C <target>` and no gh command
// is refused. Anything else is refused, with what to do instead: false refusals from the main checkout are accepted,
// false passes are not.
// Should the hook throw, it refuses if step 2 matched; should node be missing, Claude Code takes the failed hook as no
// decision, and the call runs: the hook needs mise's Node on PATH.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const REFUSED =
  'checkout|switch|reset|stash|rebase|merge|cherry-pick|revert|apply|am|restore|clean|commit|add|rm|mv|bisect|update-index|read-tree|checkout-index|update-ref|symbolic-ref|pull';
// `worktree add` and `remote add` change no checkout: their `add` is not the refused one.
const NAMES = new RegExp(
  `\\b(git|gh)\\b[\\s\\S]*(?<!\\b(worktree|remote)\\s+)\\b(${REFUSED})\\b|\\bgh\\b[\\s\\S]*\\brepo\\s+sync\\b`,
);
const NAMES_GH = new RegExp(`\\bgh\\b[\\s\\S]*\\b(${REFUSED}|sync)\\b`);
/** A word that moves where commands act, and the target it takes (after a space, or after `=`). */
const MOVES = /(?<=^|[\s;&|(])(cd|pushd|popd|-C|--git-dir|--work-tree|GIT_DIR|GIT_WORK_TREE)(?=$|[\s;&|)=])/g;
const TARGET = /^(?:"([^"]*)"|'([^']*)'|([^\s;&|()<>]*))/;

export type Place = 'main' | 'worktree' | 'repository' | 'none' | 'missing';

/** What a directory is: the main checkout of the project's repository (its git directory `mainGitDir`), or else. */
export function placeOf(dir: string, mainGitDir: string): Place {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return 'missing';
  }
  const r = spawnSync(
    'git',
    ['-C', real, 'rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return 'none';
  const [gitDir = '', common = ''] = r.stdout.trim().split('\n').map(canonical);
  if (gitDir !== common) return 'worktree';
  return common === canonical(mainGitDir) ? 'main' : 'repository';
}

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const branch = (dir: string): string =>
  spawnSync('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

const ADVICE =
  'Run it from your worktree, or as `cd /full/path/to/worktree && …` or `git -C /full/path/to/worktree …`, the path written out.';

/** Why the command is refused, or undefined to let it run. */
export function judge(command: string, cwd: string, mainGitDir: string): string | undefined {
  if (!NAMES.test(command)) return undefined;
  const from = placeOf(cwd, mainGitDir);
  if (from === 'missing') return `the hook cannot find ${cwd}, where the command starts. ${ADVICE}`;
  const moves = [...command.matchAll(MOVES)];
  if (!moves.length) {
    if (from !== 'main') return undefined;
    const pull = /^\s*git pull --ff-only( origin main)?\s*$/.test(command) && branch(cwd) === 'main';
    return pull ? undefined : `this would change the main checkout, which sessions share. ${ADVICE}`;
  }
  const targets: { word: string; at: number; path: string | undefined; dir: string | undefined; after: string }[] = [];
  for (const [i, m] of moves.entries()) {
    const word = m[1] as string;
    const rest = command.slice((m.index as number) + m[0].length);
    const t = TARGET.exec(rest.replace(/^(=|[ \t]+)/, '')) as RegExpExecArray;
    let path = t[1] ?? t[2] ?? t[3];
    const after = rest.replace(/^(=|[ \t]+)/, '').slice(t[0].length);
    if ((word === 'cd' || word === 'pushd') && path === '' && /^\s*($|[;&|)])/.test(after)) path = homedir();
    if (word === 'popd' || !path || path === '-' || /[$`*?[\]{}~'"\\]/.test(path.replace(/^~(?=\/|$)/, ''))) {
      return `the hook cannot tell where \`${word}\` leads. ${ADVICE}`;
    }
    path = path.replace(/^~(?=\/|$)/, homedir());
    if (!isAbsolute(path) && i > 0) return `\`${word} ${path}\`: only the first target may be relative. ${ADVICE}`;
    const dir = word === '--git-dir' || word === 'GIT_DIR' ? undefined : resolve(cwd, path);
    targets.push({ word, at: m.index as number, path: resolve(cwd, path), dir, after });
  }
  for (const t of targets) {
    const place = t.dir ? placeOf(t.dir, mainGitDir) : undefined;
    const isMain = place === 'main' || (!t.dir && canonical(t.path as string) === canonical(mainGitDir));
    if (isMain) return `\`${t.word} ${t.path}\` is the main checkout, which sessions share. ${ADVICE}`;
    if (from !== 'main') continue;
    const ok = t.dir ? place === 'worktree' || place === 'repository' : existsSync(t.path as string);
    if (!ok) return `\`${t.word} ${t.path}\` is not a worktree or a repository. ${ADVICE}`;
    if ((t.word === 'cd' || t.word === 'pushd') && !/^\s*&&/.test(t.after)) {
      return `\`${t.word} ${t.path}\` is not followed by \`&&\`, so what follows may run in the main checkout. ${ADVICE}`;
    }
  }
  if (from !== 'main') return undefined;
  if (/^\s*(cd|pushd)\s/.test(command) && targets[0]?.at === command.search(/\S/)) return undefined;
  const gits = [...command.matchAll(/\bgit\b/g)];
  const covered = gits.every((g) => /^\s+-C\s/.test(command.slice((g.index as number) + 3)));
  if (covered && !NAMES_GH.test(command) && !targets.some((t) => t.word !== '-C')) return undefined;
  return `from the main checkout, start with \`cd <worktree> &&\`, or give every git \`-C <worktree>\`. ${ADVICE}`;
}

/** The main checkout's git directory: the common one of the project's repository, or of this hook's. */
export function mainGitDir(project = process.env.CLAUDE_PROJECT_DIR ?? import.meta.dirname): string {
  const r = spawnSync('git', ['-C', canonical(project), 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git cannot say where the project's repository is: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// Run as the hook (through a symlink too, as each side is resolved), not when the tests import it.
if (process.argv[1] && canonical(process.argv[1]) === canonical(import.meta.filename)) {
  let command = '';
  let why: string | undefined;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as { cwd?: string; tool_input?: { command?: unknown } };
    command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
    why = judge(command, input.cwd ?? process.cwd(), mainGitDir());
  } catch (error) {
    why = NAMES.test(command) ? `the main-checkout hook failed, so it refuses: ${String(error)}` : undefined;
  }
  if (why) {
    const output = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
  }
}
