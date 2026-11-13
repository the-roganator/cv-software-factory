#!/usr/bin/env node
// A PreToolUse hook on the Bash tool (.claude/settings.json): refuses, in the main checkout only, a git command that
// moves HEAD or rewrites its index or tree. Sessions share that checkout, and one session's checkout, reset or commit
// there takes another's work with it; every session works in a worktree of its own (scratch/worktrees/<key>).
//
// Refused where they act on the main checkout: checkout, switch, reset, stash (but `stash list` and `stash show`),
// rebase, merge, cherry-pick, revert, apply (but a check or a stat), am, restore, clean (but a dry run), commit, add,
// rm, mv, bisect, the plumbing that writes the index, HEAD or a ref (update-index, read-tree, checkout-index, update-ref,
// symbolic-ref with a target), pull unless it is `--ff-only` with HEAD on main, and `gh pr checkout`. Everything else
// passes: status, log, diff, grep, fetch, push, branch, worktree add, remove and list.
//
// Where a command acts is worked out as the shell would: the session's working directory, each `cd` and `pushd` before
// it in the same command line (a subshell's undone at its close), `git -C <dir>` (each relative to the one before),
// `--git-dir` and `--work-tree`, and GIT_DIR and GIT_WORK_TREE given before it. `bash -c`, `eval`, `xargs`, `env` and
// command substitutions are read inside. A directory is the main checkout when git's directory for it is the
// repository's common one: a worktree has a git directory of its own under it, and is never refused.
//
// When it cannot tell, it refuses: a refused git command, or `gh pr checkout`, whose directory comes from a variable it
// does not know, `cd -`, `popd`, or a command line it cannot read (an unclosed quote) that names one of them. The
// refusal says to write the worktree's path out in full. A command it cannot read that names none of them passes.
//
// Claude Code gives the hook the call as JSON on stdin (`cwd`, `tool_input.command`); it refuses by printing a
// PreToolUse `permissionDecision: "deny"` with the reason, and says nothing to let the call through.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** What the hook asks git of a directory. */
export interface Repo {
  /** The absolute git directory for a directory, or undefined when it is in no repository. */
  gitDir(dir: string): string | undefined;
  /** The branch HEAD is on there, or undefined when it is detached or unknown. */
  branch(dir: string): string | undefined;
}

const MUTATING = new Set([
  'checkout',
  'switch',
  'reset',
  'stash',
  'rebase',
  'merge',
  'cherry-pick',
  'revert',
  'apply',
  'am',
  'restore',
  'clean',
  'commit',
  'add',
  'rm',
  'mv',
  'bisect',
  'update-index',
  'read-tree',
  'checkout-index',
  'update-ref',
  'symbolic-ref',
  'pull',
]);
/** Any of these after git or gh in a command line it cannot read is taken as possibly refused. */
const NAMES_ONE = new RegExp(`\\b(git|gh)\\b[\\s\\S]*\\b(${[...MUTATING].join('|')})\\b`);

/**
 * A word: its text, whether part of it cannot be known (a substitution's output, `$1`), the substitutions in it, and
 * the variables it names, each written into the text as NUL, its name, NUL, and put in once the walk knows them.
 */
type Word = { text: string; dynamic: boolean; subs: string[] };
const REF = /\0([A-Za-z_][A-Za-z0-9_]*)\0/g;
/** The word with the variables known by now put in; one not known makes it dynamic. */
function expand(w: Word, vars: Record<string, string>): Word {
  let dynamic = w.dynamic;
  const text = w.text.replace(REF, (_, name: string) => {
    const value = name === 'HOME' ? homedir() : vars[name];
    if (value === undefined) dynamic = true;
    return value ?? '';
  });
  return { ...w, text, dynamic };
}
type Token = { word: Word } | { op: string };

/** The tokens of a command line, or undefined when it cannot be read. `vars` are those known so far. */
export function lex(src: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word: Word | undefined;
  const pendingHeredocs: { delimiter: string; strip: boolean }[] = [];
  const add = (text: string, dynamic = false) => {
    word ??= { text: '', dynamic: false, subs: [] };
    word.text += text;
    word.dynamic ||= dynamic;
  };
  const end = () => {
    if (word) tokens.push({ word });
    word = undefined;
  };
  /** The index just past the `)` closing a `$(` or `(` opened before `from`, or -1. */
  const closing = (from: number): number => {
    let depth = 1;
    for (let j = from; j < src.length; j++) {
      const c = src[j];
      if (c === '\\') j++;
      else if (c === "'") {
        j = src.indexOf("'", j + 1);
        if (j < 0) return -1;
      } else if (c === '"') {
        for (j++; j < src.length && src[j] !== '"'; j++) if (src[j] === '\\') j++;
        if (j >= src.length) return -1;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j + 1;
    }
    return -1;
  };
  /** A `$…` expansion at i (src[i] is `$`): adds it to the word; returns the index after it, or -1. */
  const dollar = (i: number): number => {
    const next = src[i + 1];
    if (next === '(') {
      const close = closing(i + 2);
      if (close < 0) return -1;
      word ??= { text: '', dynamic: false, subs: [] };
      word.subs.push(src.slice(i + 2, close - 1));
      add('', true);
      return close;
    }
    const name = /^\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(src.slice(i + 1));
    if (name) {
      const braced = name[0].startsWith('{');
      if (braced && !name[0].endsWith('}')) {
        // ${x:-y} and the like: not followed.
        const close = src.indexOf('}', i);
        if (close < 0) return -1;
        add('', true);
        return close + 1;
      }
      add(`\0${name[1]}\0`);
      return i + 1 + name[0].length;
    }
    add('$', /^[0-9@*#?$!-]/.test(next ?? ''));
    return i + 1 + (/^[0-9@*#?$!-]/.test(next ?? '') ? 1 : 0);
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '\n') {
      end();
      tokens.push({ op: ';' });
      i++;
      // The bodies of the here-documents opened on the line just ended are text, not commands.
      while (pendingHeredocs.length) {
        const { delimiter, strip } = pendingHeredocs.shift() as { delimiter: string; strip: boolean };
        for (;;) {
          if (i >= src.length) return tokens;
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break;
        }
      }
    } else if (c === ' ' || c === '\t') {
      end();
      i++;
    } else if (c === '#' && !word) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
    } else if (c === '\\') {
      if (src[i + 1] === '\n') i += 2;
      else {
        add(src[i + 1] ?? '');
        i += 2;
      }
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) return undefined;
      add(src.slice(i + 1, close));
      i = close + 1;
    } else if (c === '$' && src[i + 1] === "'") {
      const m = /^\$'((?:[^'\\]|\\.)*)'/.exec(src.slice(i));
      if (!m) return undefined;
      add((m[1] as string).replace(/\\(.)/g, '$1'));
      i += m[0].length;
    } else if (c === '"') {
      add('');
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i] as string;
        if (d === '\\' && /["\\$`\n]/.test(src[i + 1] ?? '')) {
          add(src[i + 1] === '\n' ? '' : (src[i + 1] as string));
          i += 2;
        } else if (d === '$') {
          i = dollar(i);
          if (i < 0) return undefined;
        } else if (d === '`') {
          const close = src.indexOf('`', i + 1);
          if (close < 0) return undefined;
          word?.subs.push(src.slice(i + 1, close));
          add('', true);
          i = close + 1;
        } else {
          add(d);
          i++;
        }
      }
      if (i >= src.length) return undefined;
      i++;
    } else if (c === '$') {
      i = dollar(i);
      if (i < 0) return undefined;
    } else if (c === '`') {
      const close = src.indexOf('`', i + 1);
      if (close < 0) return undefined;
      word ??= { text: '', dynamic: false, subs: [] };
      word.subs.push(src.slice(i + 1, close));
      add('', true);
      i = close + 1;
    } else if (c === '<' || c === '>') {
      // A redirection: its fd, if one was written, is not a word, and its target is skipped.
      if (word && /^\d+$/.test(word.text) && !word.dynamic) word = undefined;
      end();
      const m = /^(<<-?|<<<|<>|>>|>&|<&|>\||<\(|>\(|<|>)/.exec(src.slice(i)) as RegExpExecArray;
      const op = m[0];
      i += op.length;
      if (op === '<(' || op === '>(') {
        const close = closing(i);
        if (close < 0) return undefined;
        end();
        tokens.push({ word: { text: '', dynamic: true, subs: [src.slice(i, close - 1)] } });
        i = close;
      } else if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i++;
        const m2 = /^(['"]?)([^\s'";&|<>()]+)\1/.exec(src.slice(i));
        if (!m2) return undefined;
        pendingHeredocs.push({ delimiter: m2[2] as string, strip: op === '<<-' });
        i += m2[0].length;
      } else tokens.push({ op: 'redirect' });
    } else if (c === '&' && src[i + 1] === '>') {
      end();
      i += src[i + 2] === '>' ? 3 : 2;
      tokens.push({ op: 'redirect' });
    } else if (c === '&' || c === '|' || c === ';') {
      end();
      const m = /^(&&|\|\||;;|\|&|&|\||;)/.exec(src.slice(i)) as RegExpExecArray;
      tokens.push({ op: m[0] });
      i += m[0].length;
    } else if (c === '(' || c === ')') {
      end();
      tokens.push({ op: c });
      i++;
    } else {
      add(c);
      i++;
    }
  }
  end();
  return tokens;
}

/** Where a command line's refused git commands act, judged against the main checkout's git directory. */
export function judge(command: string, cwd: string, repo: Repo, mainGitDir: string): string | undefined {
  try {
    return walk(command, cwd, repo, same(mainGitDir), {}, 0);
  } catch (error) {
    return NAMES_ONE.test(command) ? `the hook could not read this command (${String(error)})` : undefined;
  }
}

const same = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Refusing words: why, or undefined to let the command line run. */
function walk(
  src: string,
  start: string | undefined,
  repo: Repo,
  main: string,
  inherited: Record<string, string>,
  depth: number,
): string | undefined {
  if (depth > 5) return NAMES_ONE.test(src) ? 'commands nested too deep to read' : undefined;
  const vars = { ...inherited };
  const tokens = lex(src);
  if (!tokens) return NAMES_ONE.test(src) ? 'a command line it cannot read (an unclosed quote?)' : undefined;
  let cwd = start;
  const stack: (string | undefined)[] = [];
  let words: Word[] = [];
  let piped = false;
  const run = (): string | undefined => {
    const ws = words.map((w) => expand(w, vars));
    words = [];
    if (!ws.length) return undefined;
    // Command substitutions run where the command line is.
    for (const w of ws) {
      for (const sub of w.subs) {
        const why = walk(sub, cwd, repo, main, vars, depth + 1);
        if (why) return why;
      }
    }
    const env: Record<string, Word> = {};
    let k = 0;
    for (; k < ws.length; k++) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec((ws[k] as Word).text);
      if (!m) break;
      env[m[1] as string] = { ...(ws[k] as Word), text: m[2] as string };
    }
    const rest = ws.slice(k);
    if (!rest.length) {
      // Assignments alone: known for what follows, as the shell keeps them.
      for (const [name, w] of Object.entries(env)) {
        if (w.dynamic) delete vars[name];
        else vars[name] = w.text;
      }
      return undefined;
    }
    return simple(rest, env);
  };
  const simple = (ws: Word[], env: Record<string, Word>): string | undefined => {
    let at = 0;
    const text = (n: number) => ws[n]?.text ?? '';
    while (['!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time'].includes(text(at))) at++;
    const name = text(at);
    const args = ws.slice(at + 1);
    if (name === 'cd' || name === 'pushd') {
      if (piped) return undefined;
      const target = args.find((w) => !/^-[LPe@]+$/.test(w.text));
      if (!target) cwd = homedir();
      else if (target.dynamic || target.text === '-') cwd = undefined;
      else cwd = at_(cwd, target.text);
      return undefined;
    }
    if (name === 'popd') {
      cwd = undefined;
      return undefined;
    }
    if (['env', 'command', 'exec', 'nohup', 'nice', 'sudo', 'xargs', 'timeout', 'caffeinate'].includes(name)) {
      // The command these run is the first word that names git, gh or a shell; env's assignments go with it.
      const inner = args.findIndex((w) => /^(git|gh|bash|sh|zsh|eval)$/.test(w.text.split('/').pop() ?? ''));
      if (inner < 0) return undefined;
      const more = { ...env };
      if (name === 'env') {
        for (const w of args.slice(0, inner)) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(w.text);
          if (m) more[m[1] as string] = { ...w, text: m[2] as string };
        }
      }
      return simple(args.slice(inner), more);
    }
    if (/^(bash|sh|zsh)$/.test(name.split('/').pop() ?? '')) {
      const flag = args.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.text));
      const script = flag >= 0 ? args[flag + 1] : undefined;
      if (!script) return undefined;
      if (script.dynamic) return NAMES_ONE.test(script.text) ? 'a shell given a script it cannot read' : undefined;
      return walk(script.text, cwd, repo, main, vars, depth + 1);
    }
    if (name === 'eval') {
      if (args.some((w) => w.dynamic)) {
        return NAMES_ONE.test(args.map((w) => w.text).join(' ')) ? 'an eval it cannot read' : undefined;
      }
      return walk(args.map((w) => w.text).join(' '), cwd, repo, main, vars, depth + 1);
    }
    if (name.split('/').pop() === 'gh') {
      if (text(at + 1) !== 'pr' || text(at + 2) !== 'checkout') return undefined;
      if (cwd === undefined) return refuse('gh pr checkout', undefined, undefined);
      const actsIn = repo.gitDir(cwd);
      return actsIn && same(actsIn) === main ? refuse('gh pr checkout', cwd, true) : undefined;
    }
    if (name.split('/').pop() === 'git') return git(args, env);
    return undefined;
  };
  const git = (args: Word[], env: Record<string, Word>): string | undefined => {
    let dir = cwd;
    let gitDir: string | undefined | null = env.GIT_DIR ? (env.GIT_DIR.dynamic ? null : env.GIT_DIR.text) : undefined;
    let workTree: string | undefined | null = env.GIT_WORK_TREE
      ? env.GIT_WORK_TREE.dynamic
        ? null
        : env.GIT_WORK_TREE.text
      : undefined;
    let n = 0;
    const value = (w: Word | undefined): string | null => (!w || w.dynamic ? null : w.text);
    for (; n < args.length; n++) {
      const a = args[n] as Word;
      if (a.text === '-C') {
        const to = value(args[++n]);
        dir = to === null ? undefined : at_(dir, to);
      } else if (a.text === '-c' || a.text === '--namespace' || a.text === '--config-env') n++;
      else if (a.text === '--git-dir') gitDir = value(args[++n]);
      else if (a.text.startsWith('--git-dir=')) gitDir = a.dynamic ? null : a.text.slice('--git-dir='.length);
      else if (a.text === '--work-tree') workTree = value(args[++n]);
      else if (a.text.startsWith('--work-tree=')) workTree = a.dynamic ? null : a.text.slice('--work-tree='.length);
      else if (!a.text.startsWith('-')) break;
    }
    const sub = args[n];
    if (!sub) return undefined;
    if (sub.dynamic) return refuse('git with a subcommand from a variable', undefined, undefined);
    const rest = args.slice(n + 1).map((w) => w.text);
    if (!mutates(sub.text, rest)) return undefined;
    const what = `git ${sub.text}`;
    if (gitDir === null || workTree === null) return refuse(what, undefined, undefined);
    if (gitDir !== undefined) {
      if (dir === undefined && !isAbsolute(gitDir)) return refuse(what, undefined, undefined);
      return same(at_(dir, gitDir) as string) === main ? refuse(what, dir, true) : undefined;
    }
    if (workTree !== undefined) dir = at_(dir, workTree);
    if (dir === undefined) return refuse(what, undefined, undefined);
    const actsIn = repo.gitDir(dir);
    if (!actsIn || same(actsIn) !== main) return undefined;
    if (sub.text === 'pull' && rest.includes('--ff-only') && repo.branch(dir) === 'main') return undefined;
    return refuse(what, dir, true);
  };
  let target = false;
  const skipped: string[] = [];
  for (const t of tokens) {
    if ('word' in t) {
      // A redirection's target is not one of the command's words; its substitutions still run.
      if (target) skipped.push(...t.word.subs);
      else words.push(t.word);
      target = false;
      continue;
    }
    if (t.op === 'redirect') {
      target = true;
      continue;
    }
    const why = run();
    if (why) return why;
    if (t.op === '(') stack.push(cwd);
    else if (t.op === ')') {
      if (stack.length) cwd = stack.pop();
    }
    piped = t.op === '|' || t.op === '|&';
  }
  for (const sub of skipped) {
    const why = walk(sub, cwd, repo, main, vars, depth + 1);
    if (why) return why;
  }
  return run();
}

/** The directory `to` names from `dir` (a `~` expanded), or undefined when it is relative to a directory not known. */
function at_(dir: string | undefined, to: string): string | undefined {
  const path = to === '~' ? homedir() : to.startsWith('~/') ? resolve(homedir(), to.slice(2)) : to;
  if (isAbsolute(path)) return resolve(path);
  return dir === undefined ? undefined : resolve(dir, path);
}

/** Whether git's subcommand, with these arguments, writes HEAD, the index or the tree. */
export function mutates(sub: string, args: string[]): boolean {
  if (!MUTATING.has(sub)) return false;
  const has = (...flags: string[]) => args.some((a) => flags.includes(a));
  switch (sub) {
    case 'stash':
      return !['list', 'show'].includes(args[0] ?? '');
    case 'apply':
      return !(has('--check', '--stat', '--numstat', '--summary') && !has('--apply'));
    case 'clean':
      return !args.some((a) => a === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a));
    case 'symbolic-ref':
      return args.filter((a) => !a.startsWith('-')).length > 1 || has('-d', '--delete');
    case 'bisect':
      return !['log', 'view', 'visualize', 'help'].includes(args[0] ?? '');
    default:
      return true;
  }
}

function refuse(what: string, dir: string | undefined, known: true | undefined): string {
  return known
    ? `${what} in the main checkout (${dir}) is refused: sessions share it, and this would move its HEAD or rewrite its index or tree under them. Work in a worktree of your own (scratch/worktrees/<key>, made with .claude/skills/implement/bin/worktree.sh), and write its path out: git -C <worktree> ${what.replace(/^git /, '')} …`
    : `${what} is refused: the hook cannot tell which checkout it acts in (a directory from a variable, \`cd -\`, or a command it cannot read), and it may be the main checkout, which sessions share. Write the worktree's path out in full: git -C /full/path/to/worktree …`;
}

/** Git as the hook asks it, of the real file system. */
export const realRepo: Repo = {
  gitDir(dir) {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : undefined;
  },
  branch(dir) {
    const r = spawnSync('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : undefined;
  },
};

/** The main checkout's git directory: the common one of the repository this hook is in. */
export function mainGitDir(): string {
  const r = spawnSync('git', ['-C', import.meta.dirname, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git cannot say where this repository is: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

if (process.argv[1] === import.meta.filename) {
  const input = JSON.parse(readFileSync(0, 'utf8')) as { cwd?: string; tool_input?: { command?: unknown } };
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
  let why: string | undefined;
  try {
    why = judge(command, input.cwd ?? process.cwd(), realRepo, mainGitDir());
  } catch (error) {
    why = NAMES_ONE.test(command) ? `the main-checkout hook failed, so it refuses: ${String(error)}` : undefined;
  }
  if (why) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why },
      }),
    );
  }
}
