/**
 * A rehearsal of this repository's pin moves, on the Mac, pushing nothing: for each pull request the pin watch would
 * open (the day's moves at one file) one row, and one for each move it would not make, with the files it
 * changes and which of the repository's unit and database tests fail on it that pass on the base. The review gate's
 * verdict is not rehearsed: it makes the same moves with the watch's own edit (scripts/move.ts), so a move the watch
 * makes from a day's `moves.json` is that day's `move`.
 *
 *     node scripts/rehearse-pin-moves.ts --branches [--base origin/main]
 *     node scripts/rehearse-pin-moves.ts --moves <moves.json> [--base origin/main] [--scanned <ref>] [--compare]
 *
 * `--branches` rehearses the pin branches origin has now (`factory/pin/*`, fetched first unless `--no-fetch`).
 * `--moves` makes each move of a day's `moves.json` as the pin watch would: the watch itself runs (`pins.ts`'s
 * `pinWatch`), told a GitHub with no pull request and no issue open, reading the local checkout through a `PinSource`
 * of git's, and its `commitPins` is the guard's own `pinChanges` (`pin-guard.ts`), whose files become a local commit on
 * the base. `--compare` then says whether each such tree is the tree of origin's branch of the same name.
 *
 * Also: `--only <name>` (a move's name, or a branch's last segment; may repeat), `--no-tests`,
 * `--work <dir>` (default `scratch/rehearse`), `--scanned <ref>` (the commit the scan read; default the base).
 *
 * Everything is made in a repository of its own under the work directory, which borrows this checkout's objects and
 * changes nothing of it.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Actions } from '../apps/factory/src/github/actions.ts';
import { PIN_PREFIX } from '../apps/factory/src/github/branches.ts';
import type { GitHub } from '../apps/factory/src/github/client.ts';
import {
  segmentOf as keyOf,
  type PinCommit,
  type PinEdit,
  type PinSource,
  pinChanges,
} from '../apps/factory/src/github/pin-guard.ts';
import { branchOf, PIN_REPOS, type PinWatchDependencies, pinWatch } from '../apps/factory/src/github/pins.ts';
import type { Moves, ReadMove } from '../apps/factory/src/github/scanning.ts';

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');
const REPO = PIN_REPOS[0] as string;

interface Options {
  mode: 'branches' | 'moves';
  moves?: string;
  base: string;
  scanned?: string;
  only: string[];
  work: string;
  tests: boolean;
  compare: boolean;
  fetch: boolean;
}

function options(argv: string[]): Options {
  const out: Options = {
    mode: 'branches',
    base: 'origin/main',
    only: [],
    work: join(ROOT, 'scratch/rehearse'),
    tests: true,
    compare: false,
    fetch: true,
  };
  let mode: Options['mode'] | undefined;
  const value = (flag: string, at: number) => {
    const next = argv[at];
    if (next === undefined) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--branches') mode = 'branches';
    else if (arg === '--moves') {
      mode = 'moves';
      out.moves = resolve(value(arg, ++i));
    } else if (arg === '--base') out.base = value(arg, ++i);
    else if (arg === '--scanned') out.scanned = value(arg, ++i);
    else if (arg === '--only') out.only.push(value(arg, ++i));
    else if (arg === '--work') out.work = resolve(value(arg, ++i));
    else if (arg === '--no-tests') out.tests = false;
    else if (arg === '--no-fetch') out.fetch = false;
    else if (arg === '--compare') out.compare = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!mode) throw new Error('Say --branches, or --moves <moves.json>.');
  out.mode = mode;
  return out;
}

/** git in this checkout, reading only (and fetching origin's refs). */
const here = (...args: string[]) =>
  execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }).trim();

/** One row to rehearse: a pull request's moves by name, the commit that makes them, and what the watch said of a move it made no commit for. */
interface Candidate {
  name: string;
  branch: string;
  /** The commit that makes the move, in the work repository; absent when the watch made none. */
  head?: string;
  edits?: PinEdit[];
  /** Why there is no commit: an issue the watch would open, a refusal of the guard's, a wait. */
  unmade?: string;
}

interface Failure {
  file: string;
  test: string;
}

interface Row extends Candidate {
  files: string[];
  failures?: Failure[];
  /** `--compare`: how its tree differs from origin's branch of the same name. */
  compared?: string;
}

/** The repository everything is made in: its own refs, index and tree, this checkout's objects. */
function workRepository(work: string) {
  const dir = join(work, 'repo');
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=rehearsal',
        '-c',
        'user.email=rehearsal@localhost',
        '-c',
        'advice.detachedHead=false',
        ...args,
      ],
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
    ).trim();
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '--quiet', dir]);
    const common = resolve(ROOT, here('rev-parse', '--git-common-dir'));
    writeFileSync(join(dir, '.git/objects/info/alternates'), `${join(common, 'objects')}\n`);
  }
  return { dir, git };
}

type Work = ReturnType<typeof workRepository>;

const segmentOf = (branch: string) => branch.slice(PIN_PREFIX.length);

/** The guard's reads (`PinSource`), from git here: a file as a commit's tree names it, its mode and its text. */
function localSource(head: string): PinSource {
  return {
    head: async () => head,
    async file(_repo, ref, path) {
      if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`${ref} is not a commit.`);
      const listed = here('ls-tree', ref, '--', path);
      const entry = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(listed);
      if (!entry) return null;
      const [, mode = '', type, sha = ''] = entry;
      if (type !== 'blob') return { mode, text: '' };
      const bytes = execFileSync('git', ['-C', ROOT, 'cat-file', 'blob', sha], { maxBuffer: 64 * 1024 * 1024 });
      return { mode, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
    },
  };
}

/**
 * A day's moves made as the pin watch makes them: `pinWatch` run once on a GitHub that has nothing of the watch's open,
 * each `commitPins` answered by the guard's `pinChanges` and committed here.
 */
async function fromMoves(o: Options, work: Work, base: string): Promise<Candidate[]> {
  const file = JSON.parse(readFileSync(o.moves as string, 'utf-8')) as {
    repository: string;
    run?: string;
    moves: Omit<ReadMove, 'index' | 'findings'>[];
  };
  if (file.repository !== REPO) throw new Error(`${o.moves} is ${file.repository}'s, and the watch moves ${REPO}'s.`);
  const scanned = here('rev-parse', '--verify', `${o.scanned ?? base}^{commit}`);
  // moves.json alone, without the scan's sealed state: no finding, which the watch never reads to make a pull request.
  const moves: ReadMove[] = file.moves.map((move, i) => ({ ...move, index: i + 1, findings: [] }));
  const { moves: _, ...rest } = file;
  const day: Moves = {
    repository: REPO,
    run: {
      id: Number(file.run ?? 0),
      event: 'schedule',
      conclusion: 'success',
      headSha: scanned,
      updatedAt: new Date().toISOString(),
      url: `https://github.com/${REPO}/actions/runs/${file.run ?? 0}`,
    },
    file: rest as unknown as Moves['file'],
    moves,
  };

  const source = localSource(base);
  const made = new Map<string, Candidate>();
  const unmade = new Map<string, string>();
  const said: string[] = [];
  const issues: { title: string; body: string }[] = [];
  let pulls = 0;

  const actions: PinWatchDependencies['actions'] = {
    dryRun: false,
    // As `Actions.commitPins` (actions.ts) asks the guard, and no further: the files it gives back are the commit.
    async commitPins(repo: string, commit: PinCommit) {
      const changes = await pinChanges(repo, commit, source);
      const index = join(work.dir, '.git', `rehearse-index-${process.pid}`);
      const env = { ...process.env, GIT_INDEX_FILE: index };
      const git = (args: string[], input?: Uint8Array) =>
        execFileSync('git', ['-C', work.dir, ...args], { env, input, encoding: 'utf-8' }).trim();
      git(['read-tree', commit.base]);
      for (const change of changes) {
        const mode = /^(\d+) /.exec(here('ls-tree', commit.base, '--', change.path))?.[1] ?? '100644';
        const blob = git(['hash-object', '-w', '--stdin'], change.contents);
        git(['update-index', '--cacheinfo', `${mode},${blob},${change.path}`]);
      }
      const tree = git(['write-tree']);
      const sha = work.git('commit-tree', tree, '-p', commit.base, '-m', commit.message);
      work.git('update-ref', `refs/rehearse/${segmentOf(commit.branch)}`, sha);
      made.set(commit.branch, { name: commit.message, branch: commit.branch, head: sha, edits: commit.pins });
      return sha;
    },
    openPullRequest: async () => ({ number: ++pulls, url: '', nodeId: '' }),
    updatePullRequest: async () => {},
    addLabels: async () => {},
    closePullRequest: async () => {},
    async openIssue(_repo: string, issue: { title: string; body: string }) {
      issues.push(issue);
      return issues.length;
    },
    updateIssue: async () => {},
    closeIssue: async () => {},
    reopenIssue: async () => {},
  } as unknown as PinWatchDependencies['actions'];

  const log = (level: string) => (about: Record<string, unknown>, message: string) => {
    const branch = typeof about.branch === 'string' ? about.branch : undefined;
    const err = about.err instanceof Error ? `: ${about.err.message}` : '';
    if (branch && level !== 'info') unmade.set(branch, `${message}${err}`);
    else if (branch && !/opened|made/.test(message)) unmade.set(branch, message);
    said.push(`${level} ${message}${err}`);
  };

  const watch = pinWatch(
    {
      // Nothing of the watch's is open, and nothing closed: every list it reads is empty.
      github: {
        poll: async (_repo: string, path: string) => {
          if (/\/(pulls|issues)\?/.test(path)) return { body: [] };
          throw new Error(`The rehearsal has no answer for ${path}`);
        },
      } as unknown as GitHub,
      reads: { moves: async () => day },
      actions: actions as Pick<Actions, keyof PinWatchDependencies['actions']>,
      source,
      log: { info: log('info'), warn: log('warn'), error: log('error') } as unknown as PinWatchDependencies['log'],
      only: o.only.length ? moves.filter((move) => wanted(o, move)).map((move) => move.name) : '*',
    },
    REPO,
  );
  await watch();

  const rows = new Map<string, Candidate>();
  for (const move of moves.filter((each) => wanted(o, each))) {
    const branch = branchOf(move);
    const commit = made.get(branch);
    // The pull request it is in, when the commit on its branch writes its pins: one row for all its moves.
    if (commit?.edits?.some((edit) => move.pins.some((pin) => pin.file === edit.file && pin.line === edit.line))) {
      const row = rows.get(branch);
      rows.set(branch, { ...commit, name: row ? `${row.name}, ${move.name}` : move.name });
      continue;
    }
    // An issue is found by its mark (`issueKey` in pins.ts): a lockfile's by its place in the day, any other by its name.
    const mark = `<!-- factory: pin-issue ${move.lockfile ? `lockfile-${move.index}` : keyOf(move.name)} -->`;
    const issue = issues.find((each) => each.body.includes(mark));
    const why =
      (issue
        ? `an issue, not a pull request (lane ${move.lane}${move.lockfile ? ', a lockfile’s' : ''}): ${issue.title}`
        : undefined) ??
      unmade.get(branch) ??
      `the watch makes nothing of it (lane ${move.lane})`;
    rows.set(`${branch} ${move.name}`, { name: move.name, branch, unmade: why });
  }
  return [...rows.values()];
}

const wanted = (o: Options, move: ReadMove) =>
  !o.only.length || o.only.includes(move.name) || o.only.includes(segmentOf(branchOf(move)));

/** Origin's pin branches as they are now: one it deleted is gone here too. */
const fetchPins = () =>
  here('fetch', '--quiet', '--prune', 'origin', 'refs/heads/factory/pin/*:refs/remotes/origin/factory/pin/*');

/** The pin branches origin has, each as the move its branch names. */
function fromBranches(o: Options, work: Work): Candidate[] {
  if (o.fetch) fetchPins();
  const prefix = `refs/remotes/origin/${PIN_PREFIX}`;
  return here('for-each-ref', '--format=%(objectname) %(refname)', prefix)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', ref = ''] = line.split(' ');
      const segment = ref.slice(prefix.length);
      return { name: segment, branch: `${PIN_PREFIX}${segment}`, head: sha };
    })
    .filter((each) => !o.only.length || o.only.includes(each.name))
    .map((each) => {
      work.git('update-ref', `refs/rehearse/${each.name}`, each.head);
      return each;
    });
}

/** The unit and database tests (`make check-tests`) on a commit, checked out in the work repository: what failed. */
async function tested(work: Work, sha: string, name: string): Promise<Failure[]> {
  work.git('checkout', '--quiet', '--detach', '--force', sha);
  const lock = createHash('sha256')
    .update(readFileSync(join(work.dir, 'pnpm-lock.yaml')))
    .digest('hex');
  const stamp = join(work.dir, 'node_modules/.rehearse-lock');
  // Read in one step: a stamp that is not there is one that does not match.
  let installed = '';
  try {
    installed = readFileSync(stamp, 'utf-8');
  } catch {
    installed = '';
  }
  if (installed !== lock) {
    await exec('pnpm', ['install', '--frozen-lockfile'], { cwd: work.dir, maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(stamp, lock);
  }
  const results = join(work.dir, '..', 'results');
  mkdirSync(results, { recursive: true });
  const out = join(results, `${name}.json`);
  const logFile = join(results, `${name}.log`);
  // Never a result an earlier run left: a run that writes none has none.
  rmSync(out, { force: true });
  await new Promise<void>((done, fail) => {
    const log = createWriteStream(logFile);
    const child = spawn(
      'pnpm',
      ['exec', 'vitest', 'run', '--project', 'unit', '--project', 'database', '--reporter=json', `--outputFile=${out}`],
      { cwd: work.dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true' } },
    );
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('error', fail);
    child.on('close', () => done());
  });
  let written: string;
  try {
    written = readFileSync(out, 'utf-8');
  } catch {
    throw new Error(`vitest wrote no results for ${name}: see ${logFile}`);
  }
  const report = JSON.parse(written) as {
    testResults: {
      name: string;
      status: string;
      message?: string;
      assertionResults: { fullName: string; status: string }[];
    }[];
  };
  const failures: Failure[] = [];
  for (const file of report.testResults) {
    const path = file.name.startsWith(work.dir) ? file.name.slice(work.dir.length + 1) : file.name;
    const failed = file.assertionResults.filter((each) => each.status === 'failed');
    for (const each of failed) failures.push({ file: path, test: each.fullName.trim() });
    if (file.status === 'failed' && !failed.length)
      failures.push({ file: path, test: `(the file) ${(file.message ?? '').split('\n')[0]?.slice(0, 160)}` });
  }
  return failures;
}

const key = (failure: Failure) => `${failure.file}\0${failure.test}`;
const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(rows: Row[], o: Options, baseline: Failure[] | undefined): string {
  const head = ['Move', 'Files', 'Checks that fail (not on the base)', ...(o.compare ? ['Against origin'] : [])];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const row of rows) {
    const files = row.edits
      ? row.edits.map((edit) => `${edit.file}:${edit.line} ${edit.from} → ${edit.to}`).join('; ')
      : row.files.join(', ');
    const checks = row.unmade
      ? `no change made: ${row.unmade}`
      : !row.failures
        ? 'not run'
        : row.failures.length
          ? row.failures.map((each) => `${each.file}: ${each.test}`).join('; ')
          : 'none';
    lines.push(
      `| ${[row.name, files || '-', checks, ...(o.compare ? [row.compared ?? '-'] : [])].map(cell).join(' | ')} |`,
    );
  }
  lines.push('', "The rehearsal reads none of the watch's own open pull requests.");
  if (baseline?.length)
    lines.push(
      '',
      `Failing on the base too, and left out of every row: ${baseline.map((each) => `${each.file}: ${each.test}`).join('; ')}`,
    );
  return lines.join('\n');
}

async function main() {
  const o = options(process.argv.slice(2));
  const base = here('rev-parse', '--verify', `${o.base}^{commit}`);
  const work = workRepository(o.work);
  work.git('update-ref', 'refs/rehearse/base', base);
  // What `--compare` reads is origin's branches as they are now.
  if (o.mode === 'moves' && o.compare && o.fetch) fetchPins();
  const candidates = o.mode === 'moves' ? await fromMoves(o, work, base) : fromBranches(o, work);
  console.error(`${candidates.length} move${candidates.length === 1 ? '' : 's'} on ${base.slice(0, 8)}, in ${o.work}`);

  let baseline: Failure[] | undefined;
  if (o.tests && candidates.some((each) => each.head)) {
    console.error('the base: tests');
    baseline = await tested(work, base, 'base');
  }
  const known = new Set((baseline ?? []).map(key));

  const rows: Row[] = [];
  for (const candidate of candidates) {
    const row: Row = { ...candidate, files: [] };
    rows.push(row);
    const { head } = candidate;
    if (!head) continue;
    const segment = segmentOf(candidate.branch);
    row.files = work
      .git('diff', '--name-only', work.git('merge-base', base, head), head)
      .split('\n')
      .filter(Boolean);
    if (o.tests) console.error(`${candidate.name}: tests`);
    // A move whose tests could not be run is a row that says so, and the rehearsal goes on.
    const failures = o.tests
      ? await tested(work, head, segment).catch((error: unknown): Failure[] => [
          { file: 'the tests could not be run', test: error instanceof Error ? error.message : String(error) },
        ])
      : undefined;
    if (failures) row.failures = failures.filter((each) => !known.has(key(each)));
    if (o.compare) {
      const theirs = `refs/remotes/origin/${candidate.branch}`;
      let there: string | undefined;
      try {
        there = here('rev-parse', '--verify', '--quiet', `${theirs}^{tree}`);
      } catch {
        there = undefined;
      }
      if (!there) row.compared = 'origin has no such branch';
      else if (there === work.git('rev-parse', `${head}^{tree}`)) row.compared = 'the same tree';
      else row.compared = `differs: ${work.git('diff', '--stat', there, `${head}^{tree}`).split('\n').join('; ')}`;
    }
  }
  const out = table(rows, o, baseline);
  mkdirSync(o.work, { recursive: true });
  writeFileSync(join(o.work, `rehearsal-${o.mode}.json`), `${JSON.stringify({ base, rows, baseline }, null, 2)}\n`);
  writeFileSync(join(o.work, `rehearsal-${o.mode}.md`), `${out}\n`);
  console.log(out);
}

if (import.meta.main) {
  await main();
  // A reader ended at its deadline may leave Trivy or Helm running.
  process.exit();
}
