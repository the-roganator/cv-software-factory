#!/usr/bin/env node
/**
 * The patching tests' harness (../TESTS.md): it resets the scratch copies, runs the real scan, and
 * watches each move to the end or to wherever it stops, reading only GitHub and the scratch cluster. One line a test.
 *
 * Its only acts: `./copies.sh reset`, dispatching `vulnerabilities.yml` on a copy's main, restarting the scratch
 * cluster's GitHub worker and dependency sense so their passes come now and not on the hour, and, for an app test,
 * telling the line which ticket it takes (W3 turns it to a second ticket and back). It never approves, queues, re-runs
 * a check, answers a hold or sets a variable (a test's `variables` are read, and confirm.sh sets them). Everything else
 * is a read.
 *
 *     node harness.ts factory [--only 1,2,N4] [--limit 60] [--lights-out] [--no-reset] [--no-scan] [--no-kick] [--no-forge] [--once]
 *     node harness.ts only 1,2,N4       the batch.env line for a small run of those tests
 *     node harness.ts variables W1a,W1b the repository variables those tests need, for confirm.sh to set
 *     node harness.ts app X1a --with X1b   an app run, and the app's forgeries beside its test
 *     node harness.ts resume <run>      carry on a run that was stopped
 *     node harness.ts report [<run>]    the lines of a run (the latest by default)
 */
// biome-ignore-all lint/suspicious/noExplicitAny: it reads GitHub's and the cluster's JSON as each gives it, untyped
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP, FACTORY, TESTS, type Test } from './catalogue.ts';
import { BIN, WORK as CLONES, RUNS, SKILL } from './paths.ts';

const CONTEXT = 'k3d-software-factory-scratch';
const APP_BOT = 'the-roganator-scratch-factory[bot]';
const REVIEW_APP = 5470762;
const POLL_MS = 120_000;
const WORK = join(CLONES, 'factory');

// ── The only doors out ──────────────────────────────────────────────────────────────────────────────────────────────

const COPIES_ONLY = new Set([FACTORY, APP]);
function sh(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 120_000,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function repoOk(repo: string) {
  if (!COPIES_ONLY.has(repo)) throw new Error(`harness: ${repo} is not a scratch copy`);
}
/** A read of GitHub's API in a copy; every page, flattened. */
function api<T = any>(repo: string, path: string): T {
  repoOk(repo);
  for (let attempt = 0; ; attempt++) {
    try {
      const pages = JSON.parse(sh('gh', ['api', '--paginate', '--slurp', `repos/${repo}/${path}`])) as any[];
      if (pages.every(Array.isArray)) return pages.flat() as T;
      if (pages.length === 1) return pages[0] as T;
      // An object a page (check runs, workflow runs): its lists joined, as one page would give them.
      const joined: Record<string, unknown> = { ...pages[0] };
      for (const key of Object.keys(joined))
        if (Array.isArray(joined[key])) joined[key] = pages.flatMap((page) => page[key] ?? []);
      return joined as T;
    } catch (error) {
      if (attempt >= 3) throw error;
      sleep(15_000 * (attempt + 1));
    }
  }
}
/** A query of GitHub's GraphQL API about a copy (never a mutation): its `data`. `$owner` and `$name` are the copy's. */
function graphql<T = any>(repo: string, query: string, vars: Record<string, number> = {}): T {
  repoOk(repo);
  if (/\bmutation\b/.test(query)) throw new Error('graphql: the harness only reads');
  const [owner = '', name = ''] = repo.split('/');
  const args = ['api', 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `query=${query}`];
  for (const [key, value] of Object.entries(vars)) args.push('-F', `${key}=${value}`);
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(sh('gh', args)).data as T;
    } catch (error) {
      if (attempt >= 3) throw error;
      sleep(15_000 * (attempt + 1));
    }
  }
}
/**
 * What a run stands on, checked after its reset and before its scan, so a set-up fault stops the run in its first
 * minutes and is never read as a verdict on the code.
 */
/** The moves the scratch pin watch must take for these tests (a forgery copies postgres's). */
function pinWatchNames(tests: Test[]): string[] {
  return [
    ...new Set(
      tests.flatMap((t) =>
        t.pr.by === 'forged'
          ? ['postgres']
          : t.pr.by === 'pin' || t.pr.by === 'lockfile'
            ? [...t.moves, ...(t.alsoTakes ?? [])]
            : [],
      ),
    ),
  ];
}

function preflight(state: State) {
  const wrong: string[] = [];
  // The moves the scratch GitHub worker takes, which a reset writes to the ConfigMap `scratch-pin-watch` from
  // batch.env (copies.sh's pin_watch) and the worker reads as it starts: every move a small run's tests stand on.
  if (state.campaign === 'factory' && state.only) {
    const needed = pinWatchNames(TESTS.filter((t) => inRun(state, t) && t.campaign === 'factory'));
    let told = '';
    try {
      told = kubectl(['-n', 'factory', 'get', 'configmap', 'scratch-pin-watch', '-o', 'jsonpath={.data.only}']).trim();
    } catch {}
    const names = told.split(',').map((name) => name.trim());
    const missing = needed.filter((name) => told !== '*' && !names.includes(name));
    if (!told) wrong.push('the pin watch is told no move (no ConfigMap scratch-pin-watch): ./copies.sh reset factory');
    else if (missing.length)
      wrong.push(
        `the pin watch takes ${told}, not ${missing.join(', ')}: put \`node harness.ts only\`'s line in batch.env`,
      );
    else say(state, `pre-flight: the pin watch takes ${told}`);
  }
  // A test's own set-up beyond the shared baseline (`staged/<side>-<name>/`, a Test's `staged`): on the baseline exactly
  // when one of the run's tests asks for it, as it changes what the others do. Read from what `build` committed.
  const asked = new Set(
    TESTS.filter((t) => inRun(state, t) && t.staged).map((t) => `${t.repo === APP ? 'app' : 'factory'}-${t.staged}`),
  );
  for (const side of ['factory', 'app']) {
    const built = sh('git', ['-C', join(CLONES, side), 'log', '--format=%s', '-40']);
    for (const folder of readdirSync(join(SKILL, 'staged')).filter((f) => f.startsWith(`${side}-`))) {
      const patches = readdirSync(join(SKILL, 'staged', folder)).filter((f) => f.endsWith('.patch'));
      const on =
        patches.length > 0 &&
        patches.every((f) => built.includes(`chore(scratch): staged, ${f.replace(/\.patch$/, '')}`));
      if (on && !asked.has(folder))
        wrong.push(
          `the ${side} baseline carries staged/${folder}/, which no test of this run asks for: build one without it`,
        );
      if (!on && asked.has(folder))
        wrong.push(
          `the ${side} baseline lacks staged/${folder}/, which this run's tests need: build with STAGED_EXTRA=${folder.slice(side.length + 1)} in batch.env`,
        );
    }
  }
  // The store at the baseline's newest migration: a restore's dump predates some, and the GitHub worker reads the
  // level through one (0054), queueing nothing without it.
  const newest = Math.max(
    ...readdirSync(join(WORK, 'packages/store/migrations'))
      .map((name) => Number.parseInt(name, 10))
      .filter(Number.isFinite),
  );
  const applied = Number(store('select max(version) from schema_migrations')[0]?.[0] ?? 0);
  if (applied !== newest)
    wrong.push(
      `the store is at migration ${applied}, and the baseline's newest is ${newest}: ./copies.sh store-restore`,
    );
  // The app's release whole, on the copy's main: a reset takes the app back to its baseline, which is a release through
  // the full canary, and one the canary may abort (back past an ordinary fix, its journeys fail; during a store restore
  // the traffic generator is stopped, and it has too few requests). No test judges that release: the baseline is the
  // tests' starting point. So the run promotes it whole while it is in flight or aborted, and waits for the Rollout
  // to be Healthy on main before the clock starts. A test's own release comes after the scan, and is never promoted.
  const appMain = sh('gh', ['api', `repos/${APP}/commits/main`, '-q', '.sha']).trim();
  let rollout = '';
  let promoted = false;
  for (let i = 0; i < 60; i++) {
    const synced = kubectl(['-n', 'argocd', 'get', 'app', 'website', '-o', 'jsonpath={.status.sync.revision}']).trim();
    rollout = kubectl([
      '-n',
      'website',
      'get',
      'rollout',
      'website',
      '-o',
      'jsonpath={.status.phase} {.status.abort}',
    ]).trim();
    if (synced === appMain && rollout.startsWith('Healthy')) break;
    if (synced === appMain && rollout) {
      // Again on each look while it is not Healthy: a full promotion asked twice is the same promotion.
      if (!promoted) say(state, `pre-flight: the app's release of its baseline is ${rollout}; promoting it whole`);
      sh('kubectl', ['argo', 'rollouts', '--context', CONTEXT, '-n', 'website', 'promote', '--full', 'website']);
      promoted = true;
    } else if (i === 0) say(state, `pre-flight: waiting for the app's release of main (${rollout || 'no rollout'})`);
    sleep(20_000);
  }
  if (!rollout.startsWith('Healthy') || rollout.endsWith('true'))
    wrong.push(
      `the app's rollout is "${rollout}" after 20 minutes, not Healthy on main: kubectl argo rollouts --context ${CONTEXT} -n website get rollout website`,
    );
  // Every dependency of the app's a plain range of the registry's: the pin step refuses a lockfile move in a checkout
  // that names an alias, a tarball, a folder or a git source (apps/runner/src/pins.ts), whatever the move.
  const manifest = JSON.parse(readFileSync(join(CLONES, 'app/package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
    for (const [name, spec] of Object.entries(manifest[field] ?? {}))
      if (typeof spec !== 'string' || /^(npm:|file:|link:|git|https?:|workspace:)|\//.test(spec))
        wrong.push(
          `the app baseline's ${name} is ${JSON.stringify(spec)}, which the pin step refuses: no lockfile move can be made`,
        );
  if (wrong.length)
    throw new Error(`pre-flight, no verdict: the set-up is wrong, not the code\n  ${wrong.join('\n  ')}`);
  say(
    state,
    `pre-flight: the store at migration ${applied}, the app's rollout ${rollout.split(' ')[0]}, the app's manifest the registry's`,
  );
}
function kubectl(args: string[], timeout = 120_000): string {
  return sh('kubectl', ['--context', CONTEXT, ...args], { timeout });
}
/** A make target of the factory copy's, which names the scratch cluster, without the real cluster's keys. */
function make(args: string[]): string {
  if (!/^CLUSTER := software-factory-scratch$/m.test(readFileSync(join(WORK, 'Makefile'), 'utf8')))
    throw new Error('work/factory does not name the scratch cluster');
  const env = { ...process.env };
  // As copies.sh's in_copy: nothing that names the real App's key, Pushover, a private checkout or other repositories.
  for (const key of [
    'GITHUB_APP_PRIVATE_KEY',
    'PUSHOVER_APP_TOKEN',
    'PUSHOVER_USER_KEY',
    'PRIVATE_DIR',
    'KUBECONFIG',
    'FACTORY_REPOSITORY',
    'APP_REPOSITORY',
  ])
    delete env[key];
  return execFileSync('make', args, {
    cwd: WORK,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
/** A read of the scratch store, as rows of text. The query holds no double quote, dollar or backtick. */
function store(query: string): string[][] {
  if (/["$`]/.test(query)) throw new Error('store: a query the shell would read');
  const out = kubectl([
    '-n',
    'factory',
    'exec',
    'postgres-0',
    '--',
    'sh',
    '-c',
    `psql -U "\${POSTGRES_USER:-postgres}" -d factory -AtF '\t' -c "${query}"`,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
}
function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── The run's state ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Scan {
  id: number;
  createdAt: string;
  conclusion?: string;
  moves?: Move[];
}
interface Move {
  name: string;
  lane: string;
  from: string;
  to: string;
  pins: { file: string }[];
  lockfile?: boolean;
  clears?: Record<string, number>;
}
interface Pull {
  number: number;
  state: string;
  author: string;
  title: string;
  createdAt: string;
  mergedAt?: string;
  mergeCommit?: string;
  head: string;
  files: string[];
  red: string[];
  pending: string[];
  rule?: string | undefined;
  gatePending?: string | undefined;
  gateWords?: string | undefined;
  touched: string[];
  queuedBy?: string | undefined;
  queuedAt?: string | undefined;
}
/**
 * What a pull request's timeline says of the recoveries, for a test that asks: its head's run of its
 * checks (`Checks-run:`), each time the App wrote its head again for one, the App's out-of-tries comments, and the
 * merge queue's adds and removals.
 */
interface Timeline {
  head: string;
  checksRun: number;
  rewrites: { at: string; run: number }[];
  /** The App's comment that a head's checks are out of runs, with the head it names. */
  spentRuns: { at: string; head: string }[];
  /** The App's comment that the merge queue took a head out too often. */
  spentQueue: { at: string; head: string }[];
  adds: { at: string; by: string }[];
  /** GitHub's reason, lower-case: `failed_checks`, `merged`, … */
  removals: { at: string; reason: string }[];
}
interface Seen {
  moves: Move[];
  missing: string[];
  pulls: Pull[];
  issues: number[];
  deployedAt?: string;
  notDeployed?: string | undefined;
  timeline?: Timeline;
  /** For a test with `removes`: each line, whether the pull request's diff takes it out ('moved'), or not. */
  removed?: string[];
}
interface State {
  id: string;
  campaign: 'factory' | 'app';
  /** The one test an app run is. */
  test?: string | undefined;
  /** An app run's forgeries beside its test (`app <test> --with X1a,X1b`): judged from the same scan, by the gate alone. */
  with?: string[] | undefined;
  workItem?: string | undefined;
  startedAt?: string;
  stoppedAt?: string;
  /** What the store says of the work item: its hold, its end, and steps the line started for any other. */
  line?: {
    held?: string | undefined;
    closed?: string | undefined;
    stalled?: string | undefined;
    strays: string[];
    events: string[];
    /** The heads the line added to the merge queue, and each removal it recorded. */
    enqueued?: string[];
    dequeued?: { reason: string; commit: string; failed: string }[];
  };
  /**
   * A test's second ticket (`then`): taken once the first merged, given back to the first once it ends. What
   * the store says of it, and its issue as GitHub has it.
   */
  then?: {
    workItem: string;
    takenAt?: string;
    backAt?: string;
    closed?: { outcome: string; reason: string };
    held?: string | undefined;
    failures?: number;
    events: string[];
    issue?: { number: number; state?: string; reason?: string; by?: string };
  };
  limitMin: number;
  flags: string[];
  /** A small run: the only tests this run stands for (`--only 1,2,N4`). The rest are not run, and not judged from it. */
  only?: string[] | undefined;
  resetAt?: string | undefined;
  scan1?: Scan | undefined;
  kickedAt?: string;
  pods0?: Record<string, number>;
  /** Pods already failed when the run began (a canary's journeys Job from before it): no dirt of this run's. */
  failed0?: string[];
  watchedUntil?: string;
  scan2?: Scan | undefined;
  /** `errorAt`: when each error line was logged (ISO; '' where the line gave no time), so a move answers only for those since its pull request opened. */
  clean?: { errors: string[]; unhealthy: string[]; restarted: string[]; errorAt?: string[] };
  /** The forgeries forge.ts made for this run: each test's pull request and the commit that must be held. */
  forged?: Record<string, { number: number; head: string }>;
  seen: Record<string, Seen>;
  done?: boolean;
}

/**
 * Whether a run stands for a test: one of its campaign's, the one an app run names and the forgeries it carries
 * (`--with`), or one a small run names. A test that turns a check red on purpose (`variables`) stands on a move another
 * test has too (W1a on test 2's), and one that needs a baseline of its own (`staged`) changes what others do: a factory
 * run has either only by name, and the first never beside a test of the same move.
 */
function inRun(state: Pick<State, 'campaign' | 'test' | 'only' | 'with'>, test: Test): boolean {
  if (test.campaign !== state.campaign || test.notRun) return false;
  if (state.with?.includes(test.id)) return true;
  if (state.test && test.id !== state.test) return false;
  // One that turns a check red or stands on a baseline of its own is in a run only by name.
  return state.only ? state.only.includes(test.id) : Boolean(state.test) || !(test.variables || test.staged);
}
const dirOf = (id: string) => join(RUNS, id);
const save = (state: State) => writeFileSync(join(dirOf(state.id), 'state.json'), JSON.stringify(state, null, 2));
const load = (id: string): State => JSON.parse(readFileSync(join(dirOf(id), 'state.json'), 'utf8'));
function say(state: State, text: string) {
  const line = `${new Date().toISOString().slice(11, 19)}Z ${text}`;
  console.log(line);
  appendFileSync(join(dirOf(state.id), 'log.txt'), `${line}\n`);
}

// ── The scan ────────────────────────────────────────────────────────────────────────────────────────────────────────

function latestScan(repo: string, since?: string, event?: string): Scan | undefined {
  repoOk(repo);
  // The newest page alone: every page of a copy's runs is hundreds, and none but the newest matters.
  const runs =
    JSON.parse(sh('gh', ['api', `repos/${repo}/actions/workflows/vulnerabilities.yml/runs?branch=main&per_page=20`]))
      .workflow_runs ?? [];
  const run = runs.find(
    (r: any) => (!since || r.created_at >= since) && (!event || r.event === event) && r.event !== 'pull_request',
  );
  return (
    run && {
      id: run.id,
      createdAt: run.created_at,
      conclusion: run.status === 'completed' ? run.conclusion : undefined,
    }
  );
}
/**
 * The scan the push of the reset's commit to main started, which the worker opens its pull requests from: the one a
 * run stands on when there is one. None when the reset found main at the baseline already and pushed nothing, or when
 * it has not appeared within two minutes.
 */
function pushScan(repo: string, since: string): { scan?: Scan; main: string } {
  repoOk(repo);
  // The sha alone: the commit's own page lists its files, hundreds for a baseline.
  const main = sh('gh', ['api', `repos/${repo}/commits/main`, '--jq', '.sha']).trim();
  for (let i = 0; i < 12; i++) {
    const runs =
      JSON.parse(
        sh('gh', [
          'api',
          `repos/${repo}/actions/workflows/vulnerabilities.yml/runs?branch=main&event=push&per_page=20`,
        ]),
      ).workflow_runs ?? [];
    const run = runs.find((r: any) => r.head_sha === main && r.created_at >= since);
    if (run)
      return {
        main,
        scan: {
          id: run.id,
          createdAt: run.created_at,
          conclusion: run.status === 'completed' ? run.conclusion : undefined,
        },
      };
    if (i < 11) sleep(10_000);
  }
  return { main };
}
function dispatchScan(_state: State, repo: string): Scan {
  repoOk(repo);
  const since = new Date(Date.now() - 5_000).toISOString();
  sh('gh', ['workflow', 'run', 'vulnerabilities.yml', '-R', repo, '--ref', 'main']);
  for (let i = 0; i < 20; i++) {
    sleep(6_000);
    const run = latestScan(repo, `${since.slice(0, 19)}Z`, 'workflow_dispatch');
    if (run) return run;
  }
  throw new Error(`the scan dispatched in ${repo} never appeared`);
}
function awaitScan(state: State, repo: string, scan: Scan, label: string): Scan {
  for (;;) {
    const run = api<any>(repo, `actions/runs/${scan.id}`);
    if (run.status === 'completed') {
      scan.conclusion = run.conclusion;
      break;
    }
    sleep(30_000);
  }
  const into = join(dirOf(state.id), label);
  mkdirSync(into, { recursive: true });
  try {
    sh('gh', ['run', 'download', String(scan.id), '-R', repo, '-n', 'moves', '-D', into]);
    scan.moves = JSON.parse(readFileSync(join(into, 'moves.json'), 'utf8')).moves;
  } catch {
    say(state, `${label}: run ${scan.id} (${scan.conclusion}) left no moves.json`);
  }
  return scan;
}

// ── What GitHub says of a pull request ──────────────────────────────────────────────────────────────────────────────

const requiredOf = new Map<string, string[]>();
function required(repo: string): string[] {
  if (!requiredOf.has(repo)) {
    const names: string[] = [];
    for (const set of api<any[]>(repo, 'rulesets')) {
      for (const rule of api<any>(repo, `rulesets/${set.id}`).rules ?? []) {
        if (rule.type === 'required_status_checks')
          names.push(...rule.parameters.required_status_checks.map((c: any) => c.context));
      }
    }
    requiredOf.set(repo, [...new Set(names)]);
  }
  return requiredOf.get(repo) ?? [];
}

const cache = new Map<string, { updatedAt: string; pull: Pull }>();
/** When the run's scan started: a person's act on a pull request counts as a touch from here on. */
let clockStart = '';
function readPull(repo: string, listed: any): Pull {
  const key = `${repo}#${listed.number}`;
  const kept = cache.get(key);
  if (kept && kept.updatedAt === listed.updated_at && kept.pull.pending.length === 0 && kept.pull.state !== 'open')
    return kept.pull;
  const n = listed.number;
  const full = api<any>(repo, `pulls/${n}`);
  const head: string = full.head.sha;
  const files = api<any[]>(repo, `pulls/${n}/files?per_page=100`).map((f) => f.filename);
  const runs: any[] = api<any>(repo, `commits/${head}/check-runs?per_page=100`).check_runs ?? [];
  const latest = (name: string, app?: number) =>
    runs.filter((r) => r.name === name && (!app || r.app?.id === app)).sort((a, b) => b.id - a.id)[0];

  const red: string[] = [];
  const pending: string[] = [];
  for (const name of required(repo)) {
    if (name === 'review') continue;
    const run = latest(name);
    if (run?.status !== 'completed') pending.push(name);
    else if (!['success', 'skipped', 'neutral'].includes(run.conclusion)) red.push(name);
  }

  // The gate's verdict: only from the review App's own check, at this head.
  let rule: string | undefined;
  let gatePending: string | undefined;
  let gateWords: string | undefined;
  const review = latest('review', REVIEW_APP);
  if (review?.status !== 'completed') pending.push('review');
  else {
    const summary: string = review.output?.summary ?? '';
    const block = /<!-- review-verdict v1\n([\s\S]*?)\n-->/.exec(summary);
    try {
      const entry = JSON.parse(block?.[1] ?? '{}').judged?.find((j: any) => j.number === n);
      rule = entry?.rule;
      gatePending = entry?.pending;
    } catch {
      rule = undefined;
    }
    gateWords = `${review.output?.title ?? ''} ${summary.replace(/<!--[\s\S]*?-->/g, '')}`
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 260);
  }

  // Anything a person did to it, after it opened: an event of theirs, or a check run again at their word.
  const touched: string[] = [];
  let queuedBy: string | undefined;
  let queuedAt: string | undefined;
  for (const event of api<any[]>(repo, `issues/${n}/timeline?per_page=100`)) {
    const who = event.actor ?? event.user;
    if (event.event === 'added_to_merge_queue') {
      queuedBy = who?.login;
      queuedAt = event.created_at;
    }
    // What the reset did before the scan (its `@dependabot recreate` on a pull request it keeps) is the harness's own.
    const at: string = event.created_at ?? event.submitted_at ?? '';
    if (who?.type === 'User' && at >= clockStart) touched.push(`${event.event} by ${who.login}`);
  }
  for (const run of api<any>(repo, `actions/runs?head_sha=${head}&per_page=100`).workflow_runs ?? []) {
    if (run.run_attempt > 1 && run.triggering_actor?.type === 'User')
      touched.push(`${run.name} run again (attempt ${run.run_attempt}) by ${run.triggering_actor.login}`);
  }

  const pull: Pull = {
    number: n,
    state: full.merged_at ? 'merged' : full.state,
    author: full.user.login,
    title: full.title,
    createdAt: full.created_at,
    mergedAt: full.merged_at ?? undefined,
    mergeCommit: full.merged_at ? full.merge_commit_sha : undefined,
    head,
    files,
    red,
    pending,
    rule,
    gatePending,
    gateWords,
    touched: [...new Set(touched)],
    queuedBy,
    queuedAt,
  };
  cache.set(key, { updatedAt: listed.updated_at, pull });
  return pull;
}

/** The App as GraphQL names an actor or author: its login without `[bot]`. */
const APP_ACTOR = APP_BOT.replace(/\[bot\]$/, '');
/** The line a commit written again for a run of its checks carries (the worker's `withChecksRun`). */
const CHECKS_RUN = /^Checks-run: (\d+)$/m;
const TIMELINE = `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) {
  commits(last: 1) { nodes { commit { oid message } } }
  timelineItems(first: 100, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, ISSUE_COMMENT]) {
    nodes { __typename
      ... on HeadRefForcePushedEvent { createdAt actor { login } afterCommit { message } }
      ... on AddedToMergeQueueEvent { createdAt actor { login } }
      ... on RemovedFromMergeQueueEvent { createdAt reason }
      ... on IssueComment { createdAt author { login } body } } } } } }`;
function timelineOf(repo: string, number: number): Timeline {
  const pull = graphql(repo, TIMELINE, { n: number }).repository.pullRequest;
  const head = pull.commits.nodes[0]?.commit ?? {};
  const items: any[] = pull.timelineItems.nodes;
  const said = (mark: RegExp) =>
    items
      .filter((i) => i.__typename === 'IssueComment' && i.author?.login === APP_ACTOR && mark.test(i.body ?? ''))
      .map((i) => ({ at: i.createdAt as string, head: mark.exec(i.body)?.[1] ?? '' }));
  return {
    head: head.oid ?? '',
    checksRun: Number(CHECKS_RUN.exec(head.message ?? '')?.[1] ?? 1),
    rewrites: items
      .filter(
        (i) =>
          i.__typename === 'HeadRefForcePushedEvent' &&
          i.actor?.login === APP_ACTOR &&
          CHECKS_RUN.test(i.afterCommit?.message ?? ''),
      )
      .map((i) => ({ at: i.createdAt, run: Number(CHECKS_RUN.exec(i.afterCommit.message)?.[1]) })),
    spentRuns: said(/<!-- factory: checks out of tries ([0-9a-f]{40}) -->/),
    spentQueue: said(/<!-- factory: out of tries ([0-9a-f]{40}) -->/),
    adds: items
      .filter((i) => i.__typename === 'AddedToMergeQueueEvent')
      .map((i) => ({ at: i.createdAt, by: i.actor?.login ?? '' })),
    removals: items
      .filter((i) => i.__typename === 'RemovedFromMergeQueueEvent')
      .map((i) => ({ at: i.createdAt, reason: String(i.reason ?? '').toLowerCase() })),
  };
}

/** For each line, whether the pull request's diff of `file` takes it out and puts it nowhere back: 'moved', or why not. */
function removedOf(repo: string, number: number, file: string, lines: string[]): string[] {
  const patch: string | undefined = api<any[]>(repo, `pulls/${number}/files?per_page=100`).find(
    (f) => f.filename === file,
  )?.patch;
  if (patch === undefined) return lines.map(() => `GitHub gives no diff of ${file}`);
  const diff = patch.split('\n');
  return lines.map((line) =>
    diff.some((l) => l.startsWith(`+${line}`))
      ? 'kept'
      : diff.some((l) => l.startsWith(`-${line}`))
        ? 'moved'
        : 'not in the diff',
  );
}

// ── What the cluster runs ───────────────────────────────────────────────────────────────────────────────────────────

interface Cluster {
  apps: Map<string, { sync: string; health: string; revision?: string; charts: Map<string, string> }>;
  pods: { name: string; ready: boolean; phase: string; images: string[]; restarts: number }[];
}
function cluster(): Cluster {
  const apps = new Map<string, { sync: string; health: string; revision?: string; charts: Map<string, string> }>();
  for (const app of JSON.parse(kubectl(['-n', 'argocd', 'get', 'applications', '-o', 'json'])).items) {
    const charts = new Map<string, string>();
    for (const source of [app.spec.source, ...(app.spec.sources ?? [])])
      if (source?.chart) charts.set(source.chart, String(source.targetRevision));
    apps.set(app.metadata.name, {
      sync: app.status?.sync?.status ?? '',
      health: app.status?.health?.status ?? '',
      revision: app.status?.sync?.revision,
      charts,
    });
  }
  const pods = JSON.parse(kubectl(['get', 'pods', '-A', '-o', 'json'])).items.map((pod: any) => {
    const statuses = [...(pod.status.containerStatuses ?? []), ...(pod.status.initContainerStatuses ?? [])];
    return {
      name: `${pod.metadata.namespace}/${pod.metadata.name}`,
      phase: pod.status.phase,
      ready: (pod.status.conditions ?? []).some((c: any) => c.type === 'Ready' && c.status === 'True'),
      images: [
        ...[...(pod.spec.containers ?? []), ...(pod.spec.initContainers ?? [])].map((c: any) => c.image),
        ...statuses.map((s: any) => s.imageID),
      ],
      restarts: statuses.reduce((sum: number, s: any) => sum + (s.restartCount ?? 0), 0),
    };
  });
  return { apps, pods };
}
/** Whether `later` is `commit` or comes after it on main. */
function past(repo: string, commit: string, later?: string): boolean {
  if (!later) return false;
  if (later === commit) return true;
  try {
    return ['ahead', 'identical'].includes(api<any>(repo, `compare/${commit}...${later}`).status);
  } catch {
    return false;
  }
}

/** Why a merged move is not yet deployed, or nothing when it is. */
function notDeployed(test: Test, seen: Seen, pull: Pull, now: Cluster, listed: any[]): string | undefined {
  const merge = pull.mergeCommit ?? '';
  const settled = (name: string) => {
    const app = now.apps.get(name);
    if (!app) return `no Application ${name}`;
    if (app.sync !== 'Synced' || app.health !== 'Healthy') return `${name} is ${app.sync}, ${app.health}`;
    return undefined;
  };
  if (test.deployed.kind === 'none') return undefined;
  const root = now.apps.get('root');
  if ((test.deployed.kind === 'chart' || test.deployed.kind === 'image') && !past(test.repo, merge, root?.revision))
    return `Argo CD's root is at ${root?.revision?.slice(0, 7) ?? 'nothing'}, before the merge`;

  if (test.deployed.kind === 'chart') {
    for (const move of seen.moves) {
      const [, chart, version] = /^chart (\S+) (\S+)/.exec(move.to) ?? [];
      for (const name of test.deployed.apps) {
        const app = now.apps.get(name);
        if (app?.charts.get(chart ?? '') !== version)
          return `${name} names ${chart} ${app?.charts.get(chart ?? '') ?? 'nothing'}, not ${version}`;
        const why = settled(name);
        if (why) return why;
      }
    }
    return undefined;
  }
  if (test.deployed.kind === 'image') {
    for (const move of seen.moves) {
      if (test.deployed.hooks?.includes(move.name)) continue;
      const digest = /sha256:[0-9a-f]{64}/.exec(move.to)?.[0];
      if (!digest) return `the move's target names no digest: ${move.to}`;
      if (!now.pods.some((pod) => pod.ready && pod.images.some((image) => image?.includes(digest))))
        return `no ready pod runs ${move.name} at ${digest.slice(0, 19)}`;
    }
    for (const name of test.deployed.apps ?? []) {
      const why = settled(name);
      if (why) return why;
    }
    return undefined;
  }
  // An image of ours: the App's deploy pull request for a build of the merge, or of a later commit, merged and synced.
  for (const candidate of listed) {
    // The app's "run <sha>"; the factory's "run the factory <sha>", or "run console <sha> and the factory <sha>".
    const sha = /^chore\(deploy\): run (?:console [0-9a-f]{7,40} and )?(?:the factory )?([0-9a-f]{7,40})\b/.exec(
      candidate.title,
    )?.[1];
    if (!sha || candidate.user.login !== APP_BOT || !candidate.merged_at) continue;
    if (candidate.merged_at < (pull.mergedAt ?? '')) continue;
    if (!past(test.repo, merge, sha)) continue;
    if (test.deployed.kind === 'app-deploy') {
      const website = now.apps.get('website');
      if (!past(test.repo, candidate.merge_commit_sha, website?.revision))
        return `deploy #${candidate.number} merged, and Argo CD's website is before it`;
      const rollout = JSON.parse(kubectl(['-n', 'website', 'get', 'rollout', 'website', '-o', 'json']));
      const done =
        rollout.status?.phase === 'Healthy' &&
        rollout.status?.stableRS === rollout.status?.currentPodHash &&
        rollout.status?.currentStepIndex === (rollout.spec?.strategy?.canary?.steps ?? []).length;
      return done
        ? undefined
        : `deploy #${candidate.number} synced; the canary is ${rollout.status?.phase}, step ${rollout.status?.currentStepIndex}`;
    }
    if (!past(test.repo, candidate.merge_commit_sha, root?.revision))
      return `deploy #${candidate.number} merged, and Argo CD's root is before it`;
    const down = now.pods.filter((pod) => pod.name.startsWith('factory/') && pod.phase === 'Running' && !pod.ready);
    return down.length
      ? `deploy #${candidate.number} synced; not ready: ${down.map((p) => p.name).join(', ')}`
      : undefined;
  }
  return 'no deploy pull request for a build of it has merged';
}

// ── One pass over the tests ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether a move is the app's lockfile move a test with `lockfile` stands on: one of a package in the image (its pins
 * name the overlay too), which clears a Critical or none. A development dependency's (W4's, named by `moves`) is not.
 */
const appLockfile = (m: Move, test: Test) =>
  Boolean(m.lockfile) &&
  m.lane === 'line' &&
  m.pins.some((p) => p.file !== 'pnpm-lock.yaml') &&
  (m.clears?.CRITICAL ?? 0) > 0 === (test.lockfile === 'critical');

function observe(state: State, tests: Test[], final = false) {
  if (final) cache.clear();
  clockStart = state.scan1?.createdAt ?? '';
  const since = state.resetAt ?? state.scan1?.createdAt ?? '';
  const listedOf = new Map<string, any[]>();
  const issuesOf = new Map<string, any[]>();
  let now: Cluster | undefined;

  for (const test of tests) {
    const seen: Seen = state.seen[test.id] ?? { moves: [], missing: [], pulls: [], issues: [] };
    const all = state.scan1?.moves ?? [];
    seen.moves = [];
    seen.missing = [];
    // Which of a name's moves, and where it stands among them: the pin watch's issues come in the scan's order.
    let nth = 0;
    for (const name of test.moves) {
      const named = all.filter((m) => m.name === name);
      const want = test.clears;
      const move = want
        ? named.find((m) =>
            want.CRITICAL
              ? (m.clears?.CRITICAL ?? 0) > 0
              : want.HIGH
                ? (m.clears?.HIGH ?? 0) > 0
                : (m.clears?.HIGH ?? 0) === 0 && m.clears?.MEDIUM === want.MEDIUM,
          )
        : named[0];
      if (move) {
        seen.moves.push(move);
        nth = named.indexOf(move);
      } else seen.missing.push(want ? `${name} (clearing ${JSON.stringify(want)})` : name);
    }
    if (test.lockfile) {
      const move = all.find((m) => appLockfile(m, test));
      if (move) seen.moves.push(move);
      else seen.missing.push(`a lockfile package that clears ${test.lockfile === 'critical' ? 'a' : 'no'} Critical`);
    }

    if (!listedOf.has(test.repo)) {
      // The newest hundred, and every open one: a pull request Dependabot keeps open is older than a campaign's hundred.
      const newest = JSON.parse(
        sh('gh', ['api', `repos/${test.repo}/pulls?state=all&sort=created&direction=desc&per_page=100`]),
      ) as any[];
      const open = api<any[]>(test.repo, 'pulls?state=open&per_page=100');
      listedOf.set(test.repo, [...newest, ...open.filter((p) => !newest.some((n) => n.number === p.number))]);
    }
    const listed = listedOf.get(test.repo) ?? [];
    const fresh = listed.filter((p) => p.created_at >= since);
    // The moves a pin pull request carries: the names its description marks (one pull request for a file's
    // moves), or the one its title names.
    const pinMoves = (p: any): string[] => {
      const mark = /<!-- factory: pin-moves ([A-Za-z0-9%._~!*'()-]*) -->/.exec(p.body ?? '')?.[1];
      if (mark) return JSON.parse(decodeURIComponent(mark)) as string[];
      const named = /^chore\(pin\): move (.+) to \S+/.exec(p.title.replace(/^\[reset\] /, ''))?.[1];
      return named ? [named] : /^chore\(pin\): /.test(p.title.replace(/^\[reset\] /, '')) ? ['?'] : [];
    };

    let mine: any[] = [];
    const issues = () => {
      if (!issuesOf.has(test.repo))
        issuesOf.set(test.repo, api<any[]>(test.repo, `issues?state=all&since=${since}&per_page=100`));
      return (issuesOf.get(test.repo) ?? []).filter((i) => !i.pull_request && i.created_at >= since);
    };
    const forgedNumbers = new Set(Object.values(state.forged ?? {}).map((f) => f.number));
    if (test.pr.by === 'forged') {
      mine = listed.filter((p) => p.number === state.forged?.[test.id]?.number);
    } else if (test.pr.by === 'pin') {
      mine = fresh.filter(
        (p) =>
          p.user.login === APP_BOT &&
          pinMoves(p).some((name) => test.moves.includes(name)) &&
          !forgedNumbers.has(p.number),
      );
      seen.issues = issues()
        .filter((i) => test.moves.some((name) => i.title.startsWith(`Move ${name} to `)))
        .map((i) => i.number);
    } else if (test.pr.by === 'line') {
      const from = state.startedAt ?? since;
      mine = listed.filter(
        // A later reset retitles a release pull request `chore(reset): …`: it is known by its branch, for a `reread`.
        (p) =>
          p.user.login === APP_BOT &&
          p.created_at >= from &&
          !/^chore\((deploy|main)\)/.test(p.title) &&
          !p.head?.ref?.startsWith('release-please--') &&
          !forgedNumbers.has(p.number),
      );
    } else if (test.pr.by === 'dependabot') {
      const title = test.pr.title;
      mine = listed.filter(
        (p) =>
          p.user.login === 'dependabot[bot]' && title.test(p.title) && (p.state === 'open' || p.closed_at >= since),
      );
    } else {
      // The App's pull requests that are no deploy's or release's and write the lockfile. The pin watch opens one for
      // the day's lockfile moves, marked with the lockfile's public name once a move, and the lockfile tests share it;
      // with none marked, each unmarked one is a test's own, the nth of them.
      const writers = fresh
        .filter(
          (p) => p.user.login === APP_BOT && !/^chore\((deploy|main)\)/.test(p.title) && !forgedNumbers.has(p.number),
        )
        .map((p) => ({ p, pull: readPull(test.repo, p) }))
        .filter(({ pull }) => pull.files.includes('pnpm-lock.yaml'))
        .map(({ p }) => p);
      const marked = writers.filter((p) => pinMoves(p).some((name) => name.startsWith('a package in ')));
      mine = marked.length
        ? marked
        : writers
            .filter((p) => pinMoves(p).length === 0)
            .reverse()
            .slice(nth, nth + 1);
      seen.issues = issues()
        .filter((i) => /^Move a package in /.test(i.title))
        .sort((a, b) => a.number - b.number)
        .slice(nth, nth + 1)
        .map((i) => i.number);
    }
    seen.pulls = mine.map((p) => readPull(test.repo, p)).sort((a, b) => a.number - b.number);
    // What the recoveries left on the pull request, and what its diff takes out (N4): one pull request.
    const one = seen.pulls.length === 1 ? seen.pulls[0] : undefined;
    if (one && (test.checksRun || test.queueRuns)) seen.timeline = timelineOf(test.repo, one.number);
    if (one && test.removes) seen.removed = removedOf(test.repo, one.number, test.removes.file, test.removes.lines);

    const merged = seen.pulls.length === 1 && seen.pulls[0]?.mergedAt ? seen.pulls[0] : undefined;
    if (merged && !seen.deployedAt) {
      now ??= cluster();
      seen.notDeployed = notDeployed(test, seen, merged, now, listed);
      if (!seen.notDeployed) seen.deployedAt = new Date().toISOString();
    }
    state.seen[test.id] = seen;
  }
  save(state);
}

// ── Whether the cluster is clean ────────────────────────────────────────────────────────────────────────────────────

/**
 * What the GitHub worker's pin queue last said each pull request waits for, by `<number> <head>`, from its log since
 * the run restarted it: `level` (a rule the autonomy level does not queue), `verdict` (a rule no level queues, or no
 * verdict yet), `checks`, `failed` and the rest (deploy-queue.ts's `QueueWait`). It says each once a head.
 */
function workerWaits(state: State): Map<string, string> {
  const waits = new Map<string, string>();
  const since = state.kickedAt ?? state.resetAt;
  if (!since) return waits;
  const text = kubectl(['-n', 'factory', 'logs', 'deployment/github', `--since-time=${since}`], 300_000);
  for (const line of text.split('\n')) {
    if (!line.includes('pull request waits to be queued')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.number && entry.head && entry.waits) waits.set(`${entry.number} ${entry.head}`, entry.waits);
    } catch {}
  }
  return waits;
}

/**
 * Whether a test that must not merge (a refusal, a forgery, or a major the level holds) is decided before the limit:
 * its verdict passes and nothing left can change it. Each of its pull requests is unmerged and never queued, with
 * every required check and the gate's verdict at its head in. A forgery's is then final: no watch owns its branch and
 * nothing but a person queues it. Any other's needs its checks green too, so no recovery writes its head again for
 * the gate to judge anew, and the worker to have said, at that head, that it waits for the level or the verdict, which
 * nothing in the run changes. With no pull request yet one may still open: not decided.
 */
function decidedHeld(state: State, test: Test, waits: Map<string, string>): boolean {
  const pulls = state.seen[test.id]?.pulls ?? [];
  if (!pulls.length || !verdict(state, test).pass) return false;
  return pulls.every((p) => {
    if (p.mergedAt || p.queuedBy || p.pending.length || p.gatePending) return false;
    if (test.pr.by === 'forged') return true;
    return (
      !p.red.length && p.rule !== undefined && ['level', 'verdict'].includes(waits.get(`${p.number} ${p.head}`) ?? '')
    );
  });
}

const podRestarts = () => Object.fromEntries(cluster().pods.map((pod) => [pod.name, pod.restarts]));
function clean(state: State): NonNullable<State['clean']> {
  const since = state.scan1?.createdAt ?? state.resetAt ?? new Date().toISOString();
  const now = cluster();
  const errors: string[] = [];
  const errorAt: string[] = [];
  for (const pod of now.pods.filter((p) => p.name.startsWith('factory/'))) {
    const [namespace, name] = pod.name.split('/') as [string, string];
    let text = '';
    try {
      text = kubectl(['-n', namespace, 'logs', name, '--all-containers', `--since-time=${since}`], 300_000);
      // Kept with the run: a pod's log goes with the pod at the next reset or deploy, and a stall is read from it.
      mkdirSync(join(dirOf(state.id), 'logs'), { recursive: true });
      writeFileSync(join(dirOf(state.id), 'logs', `${name}.log`), text);
    } catch {
      continue;
    }
    const bad = text.split('\n').filter((line) => /"level":(5|6)\d\b/.test(line));
    for (const line of bad) {
      let at = '';
      try {
        const time = JSON.parse(line).time;
        if (typeof time === 'number' || typeof time === 'string') at = new Date(time).toISOString();
      } catch {}
      errorAt.push(at);
    }
    if (bad.length) {
      let first = bad[0] ?? '';
      try {
        const parsed = JSON.parse(first);
        first = parsed.msg ?? parsed.err?.message ?? first;
      } catch {}
      errors.push(`${name}: ${bad.length} (${first.slice(0, 160)})`);
    }
  }
  const unhealthy = now.pods
    .filter((p) => !['Succeeded'].includes(p.phase) && !(p.phase === 'Running' && p.ready))
    .filter((p) => !(p.phase === 'Failed' && state.failed0?.includes(p.name)))
    .map((p) => `${p.name} ${p.phase}`);
  const restarted = now.pods
    .filter((p) => state.pods0 && p.name in state.pods0 && p.restarts > (state.pods0[p.name] ?? 0))
    .map((p) => `${p.name} +${p.restarts - (state.pods0?.[p.name] ?? 0)}`);
  return { errors, unhealthy, restarted, errorAt };
}

// ── The verdict, one line a test ────────────────────────────────────────────────────────────────────────────────────

function clock(state: State, at?: string): string {
  if (!at || !state.scan1) return '?';
  const minutes = Math.max(0, Math.round((Date.parse(at) - Date.parse(state.scan1.createdAt)) / 60_000));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}
function where(pull: Pull): string {
  if (pull.mergedAt) return 'merged';
  if (pull.state === 'closed') return 'closed unmerged';
  if (pull.red.length) return `red: ${pull.red.join(', ')}`;
  if (pull.rule === 'held' && !pull.gatePending) return `held by the gate: ${pull.gateWords ?? ''}`;
  if (pull.pending.length) return `waiting on ${pull.pending.join(', ')}`;
  if (pull.rule === 'held') return `the gate waits: ${pull.gatePending}`;
  if (pull.queuedBy) return `gate passed it as ${pull.rule}, queued by ${pull.queuedBy}, not merged`;
  return `green, gate passed it as ${pull.rule}, never queued`;
}
/** How long the run watches a head said to be out of runs for anything after it (W1b). */
const SETTLE_MS = 10 * 60_000;

/**
 * A move whose required check fails every time (W1b): its head written again `runs - 1` times, then one
 * comment naming the last head, which stays: never merged, nobody touching it, and nothing after for `SETTLE_MS`.
 */
function spentVerdict(state: State, test: Test, runs: number): { pass: boolean; why: string } {
  const seen = state.seen[test.id];
  const fail = (why: string) => ({ pass: false, why });
  if (!state.scan1?.moves) return fail('the scan left no moves');
  if (!seen) return fail('not observed');
  if (seen.missing.length) return fail(`the scan made no move of ${seen.missing.join(', ')}`);
  if (seen.pulls.length !== 1) return fail(`${seen.pulls.length} pull requests, not one`);
  const pull = seen.pulls[0] as Pull;
  const tag = `#${pull.number}`;
  const tl = seen.timeline;
  if (pull.mergedAt) return fail(`${tag} merged at ${clock(state, pull.mergedAt)}, and must not`);
  if (pull.touched.length) return fail(`${tag} touched: ${pull.touched.join('; ')}`);
  if (!tl) return fail(`${tag}: its timeline was not read`);
  const said = tl.spentRuns;
  const written = `its head is run ${tl.checksRun}, written again ${tl.rewrites.length} times`;
  if (!said.length) return fail(`${tag} not out of runs: ${written}; ${where(pull)}`.slice(0, 420));
  if (said.length > 1) return fail(`${tag} said out of runs ${said.length} times, not once`);
  if (tl.checksRun !== runs || tl.rewrites.length !== runs - 1)
    return fail(`${tag} out of runs, but ${written}, not ${runs - 1}`);
  const [comment] = said as [Timeline['spentRuns'][number]];
  if (comment.head !== pull.head)
    return fail(
      `${tag} moved after the comment: it named ${comment.head.slice(0, 7)}, the head is ${pull.head.slice(0, 7)}`,
    );
  if (!pull.red.includes('title'))
    return fail(`${tag}: \`title\` is not red at its head, so not the failure staged (${where(pull)})`);
  const end = Date.parse(state.watchedUntil ?? new Date().toISOString());
  if (end - Date.parse(comment.at) < SETTLE_MS)
    return fail(`${tag} out of runs at ${clock(state, comment.at)}; watching for anything after`);
  const dirt = state.clean;
  const errors = dirt?.errorAt
    ? dirt.errorAt.filter((at) => !at || at >= pull.createdAt).length
    : (dirt?.errors.length ?? 0);
  if (dirt && errors + dirt.unhealthy.length + dirt.restarted.length)
    return fail(`${tag} out of runs; not clean (see the run's last lines)`);
  return {
    pass: true,
    why: `${tag} written again ${runs - 1} times, out of runs at ${clock(state, comment.at)}, said once, nothing after, nobody touched it`,
  };
}

/** What a recovery test asks beyond its move's outcome (W1 to W4), of its one merged pull request: why it fails, if it does. */
function recoveryFault(state: State, test: Test, seen: Seen, pull: Pull): string | undefined {
  const tag = `#${pull.number}`;
  const tl = seen.timeline;
  if ((test.checksRun || test.queueRuns) && !tl) return `${tag}: its timeline was not read`;
  if (test.checksRun && tl) {
    const runs = test.checksRun.runs;
    if (tl.checksRun !== runs || tl.rewrites.length !== runs - 1)
      return `${tag} merged at run ${tl.checksRun} of its checks, written again ${tl.rewrites.length} times, not ${runs - 1} (are ${Object.keys(test.variables ?? {}).join(', ')} set?)`;
    if (tl.spentRuns.length) return `${tag} merged, yet the App said its checks were out of runs`;
  }
  if (test.queueRuns && tl) {
    const runs = test.queueRuns;
    const adds = tl.adds.filter((a) => a.by === APP_ACTOR).length;
    const failed = tl.removals.filter((r) => r.reason === 'failed_checks').length;
    const other = tl.removals.filter((r) => !['failed_checks', 'merged'].includes(r.reason)).map((r) => r.reason);
    if (adds !== runs || failed !== runs - 1 || other.length)
      return `${tag} added to the queue ${adds} times, taken out ${failed} for failed checks${other.length ? ` and for ${other.join(', ')}` : ''}, not ${runs} and ${runs - 1}`;
    const heads = state.line?.enqueued ?? [];
    if (heads.length !== runs || new Set(heads).size !== 1)
      return `${tag}: the store has the line add it ${heads.length} times, at ${[...new Set(heads)].map((h) => h.slice(0, 7)).join(', ')}, not ${runs} at one head`;
    if (tl.spentQueue.length) return `${tag} merged, yet it was said out of tries in the queue`;
  }
  // The gate's rule for it (X2: a major that clears a Trivy Critical passes as `move`), and the files it may write (X4).
  if (test.rule && pull.rule !== test.rule)
    return `${tag} passed by the gate as ${pull.rule ?? 'nothing'}, not ${test.rule}`;
  if (test.files) {
    const exact = pull.files.length === test.files.length && test.files.every((f) => pull.files.includes(f));
    if (!exact) return `${tag} writes ${pull.files.join(', ')}, not exactly ${test.files.join(', ')}`;
  }
  if (test.removes) {
    const left = test.removes.lines.filter((_, i) => seen.removed?.[i] !== 'moved');
    if (left.length)
      return `${tag} leaves ${left.map((l) => l.trim()).join(', ')} in ${test.removes.file} (${seen.removed?.join(', ') ?? 'not read'})`;
  }
  if (test.then) {
    const then = state.then;
    if (!then) return `no ticket for ${test.then.dependency} to take after ${tag}`;
    if (!then.takenAt) return `#${then.workItem} (${test.then.dependency}) never taken`;
    if (then.held) return `#${then.workItem} held for Martin: ${then.held}`.slice(0, 420);
    if (!then.closed) return `#${then.workItem} not closed: ${then.events.join(' ') || 'no event'}`.slice(0, 420);
    if (then.closed.outcome !== test.then.closes || !test.then.reason.test(then.closed.reason))
      return `#${then.workItem} closed ${then.closed.outcome}: ${then.closed.reason}`.slice(0, 420);
    if (then.failures) return `#${then.workItem} closed ${then.closed.outcome} after ${then.failures} failed steps`;
    const issue = then.issue;
    if (!issue) return `#${then.workItem} closed ${then.closed.outcome} with no issue of its own`;
    if (issue.state !== 'closed' || issue.reason !== 'completed' || issue.by !== APP_BOT)
      return `#${then.workItem}'s issue #${issue.number} is ${issue.state} (${issue.reason ?? 'no reason'}, by ${issue.by ?? 'nobody'}), not closed as completed by the App`;
  }
  return undefined;
}

/** What a passing recovery test adds to its line. */
function recoveryWords(state: State, test: Test, seen: Seen): string {
  const tl = seen.timeline;
  const words = [
    test.checksRun && tl ? `written again ${tl.rewrites.length} time${tl.rewrites.length === 1 ? '' : 's'}` : '',
    test.queueRuns && tl ? `queued ${tl.adds.length} times` : '',
    test.then && state.then?.closed
      ? `#${state.then.workItem} closed ${state.then.closed.outcome}, issue #${state.then.issue?.number} completed`
      : '',
    test.removes ? `both copies moved` : '',
  ].filter(Boolean);
  return words.length ? `, ${words.join(', ')}` : '';
}

function verdict(state: State, test: Test): { pass: boolean; why: string } {
  const seen = state.seen[test.id];
  const fail = (why: string) => ({ pass: false, why });
  if (test.checksRun?.spent) return spentVerdict(state, test, test.checksRun.runs);
  // A major is held at Guarded, the level the scratch line is set to, and merges only in a run told --lights-out.
  if (test.mustNot || (test.major && !state.flags.includes('--lights-out'))) {
    if (!seen) return fail('not observed');
    if (test.pr.by === 'forged') {
      // A forgery passes only when the gate itself held the forged commit: a queue that never took it proves nothing.
      const made = state.forged?.[test.id];
      const pull = seen.pulls[0];
      if (!made || !pull) return fail('not forged');
      if (pull.mergedAt) return fail(`#${pull.number} merged at ${clock(state, pull.mergedAt)}, and must not`);
      if (pull.head !== made.head)
        return fail(`#${pull.number} is no longer at the forged commit ${made.head.slice(0, 7)}`);
      if (pull.pending.includes('review')) return fail(`#${pull.number} not judged yet`);
      if (pull.rule !== 'held') return fail(`#${pull.number}: the gate passed the forgery as ${pull.rule}`);
      // Held for the reason the forgery is about, not another (a read that failed, a tag alone): X1's "not a move".
      if (test.heldFor && !test.heldFor.test(pull.gateWords ?? ''))
        return fail(`#${pull.number} held, but not for what it forged: ${pull.gateWords ?? 'no words'}`.slice(0, 420));
      if (pull.queuedBy) return fail(`#${pull.number} held by the gate, yet queued by ${pull.queuedBy}`);
      return { pass: true, why: `#${pull.number} ${where(pull)}`.slice(0, 420) };
    }
    const merged = seen.pulls.find((p) => p.mergedAt);
    if (merged) return fail(`#${merged.number} merged at ${clock(state, merged.mergedAt)}, and must not`);
    if (!seen.pulls.length) return { pass: true, why: 'no pull request opened' };
    const waiting = seen.pulls.filter((p) => p.state === 'open' && p.pending.length);
    if (waiting.length) return fail(`#${waiting[0]?.number} not settled: ${where(waiting[0] as Pull)}`);
    return {
      pass: true,
      why: seen.pulls
        .map((p) => `#${p.number} not merged: ${where(p)}`)
        .join('; ')
        .slice(0, 420),
    };
  }
  if (!state.scan1?.moves) return fail('the scan left no moves');
  if (!seen) return fail('not observed');
  if (seen.missing.length) return fail(`the scan made no move of ${seen.missing.join(', ')}`);
  const lanes = [...new Set(seen.moves.map((m) => m.lane))].join(', ');
  if (seen.pulls.length === 0 && state.line?.held)
    return fail(`no pull request; held on the line: ${state.line.held}`.slice(0, 420));
  if (seen.pulls.length === 0 && state.line?.stalled)
    return fail(`no pull request; stuck on the line: ${state.line.stalled}`.slice(0, 420));
  if (seen.pulls.length === 0 && state.line?.closed)
    return fail(`no pull request; the work item closed as ${state.line.closed}`);
  if (seen.pulls.length === 0)
    return fail(
      `no pull request (lane ${lanes}${seen.issues.length ? `; issue #${seen.issues.join(', #')} instead` : ''})`,
    );
  if (seen.pulls.length > 1)
    return fail(
      `${seen.pulls.length} pull requests, not one: ${seen.pulls
        .map((p) => `#${p.number} ${where(p)}`)
        .join('; ')
        .slice(0, 400)}`,
    );
  const pull = seen.pulls[0] as Pull;
  const tag = `#${pull.number}`;
  if (state.line?.strays.length) return fail(`the run is spoiled: the line worked ${state.line.strays.join(', ')} too`);
  if (state.line?.stalled && !pull.mergedAt)
    return fail(`${tag} stuck on the line: ${state.line.stalled}`.slice(0, 420));
  if (state.line?.held && !pull.mergedAt) return fail(`${tag} held on the line: ${state.line.held}`.slice(0, 420));
  if (test.pr.by === 'pin') {
    const pins = new Set(seen.moves.flatMap((m) => m.pins.map((p) => p.file)));
    const extra = pull.files.filter((f) => !pins.has(f) && !(test.brings ?? []).some((b) => b.test(f)));
    const left = [...pins].filter((f) => !pull.files.includes(f));
    if (extra.length) return fail(`${tag} changes more than its pins: ${extra.join(', ')}`);
    if (left.length) return fail(`${tag} leaves pins behind: ${left.join(', ')}`);
  }
  if (!pull.mergedAt) return fail(`${tag} ${where(pull)}`.slice(0, 420));
  if (pull.touched.length)
    return fail(`${tag} merged at ${clock(state, pull.mergedAt)}, touched: ${pull.touched.join('; ')}`);
  const fault = recoveryFault(state, test, seen, pull);
  if (fault) return fail(fault);
  if (!seen.deployedAt)
    return fail(`${tag} merged at ${clock(state, pull.mergedAt)}, not deployed: ${seen.notDeployed}`);
  const took = (Date.parse(seen.deployedAt) - Date.parse(state.scan1.createdAt)) / 60_000;
  const so = `${tag} merged ${clock(state, pull.mergedAt)}, deployed ${clock(state, seen.deployedAt)}`;
  if (took > state.limitMin) return fail(`${so}, past the limit of ${state.limitMin} min`);
  if (!state.scan2?.moves) return fail(`${so}; the next scan has not run`);
  const mine = (m: Move) => (test.lockfile ? appLockfile(m, test) : test.moves.includes(m.name));
  const before = (state.scan1.moves ?? []).filter(mine).length;
  const after = state.scan2.moves.filter(mine).length;
  if (after > 0 && !(test.clears !== undefined && after < before)) return fail(`${so}; the next scan still reports it`);
  const dirt = state.clean;
  // An error logged before the move's pull request opened is not the move's; one with no time counts against all.
  const errors = dirt?.errorAt
    ? dirt.errorAt.filter((at) => !at || at >= pull.createdAt).length
    : (dirt?.errors.length ?? 0);
  if (dirt && errors + dirt.unhealthy.length + dirt.restarted.length)
    return fail(`${so}, cleared; not clean (see the run's last lines)`);
  return { pass: true, why: `${so}, cleared${recoveryWords(state, test, seen)}, nobody touched it` };
}

function report(state: State) {
  const t0 = state.scan1?.createdAt;
  console.log(
    `\nrun ${state.id}  ${state.done ? 'finished' : 'not finished'}  limit ${state.limitMin} min${state.workItem ? `  work item #${state.workItem}` : ''}`,
  );
  console.log(
    `scan ${state.scan1?.id ?? '-'} at ${t0 ?? '-'} (${state.scan1?.conclusion ?? 'running'}); next scan ${state.scan2?.id ?? 'not run'}\n`,
  );
  for (const test of TESTS.filter((t) => inRun(state, t))) {
    const { pass, why } = verdict(state, test);
    console.log(`${test.id.padEnd(3)} ${pass ? 'PASS    ' : 'FAIL    '} ${test.title.padEnd(46)} ${why}`);
  }
  if (state.line?.events.length) console.log(`\nthe work item's events: ${state.line.events.join(' ')}`);
  if (state.line?.dequeued?.length)
    console.log(
      `the merge queue took it out: ${state.line.dequeued.map((d) => `${d.reason} at ${d.commit.slice(0, 7)} ${d.failed}`).join('; ')}`,
    );
  if (state.then)
    console.log(
      `the second ticket #${state.then.workItem}: taken ${state.then.takenAt ?? 'never'}, given back ${state.then.backAt ?? 'never'}; ${state.then.events.join(' ') || 'no event'}`,
    );
  for (const test of TESTS) {
    const tl = state.seen[test.id]?.timeline;
    if (tl)
      console.log(
        `${test.id} timeline: run ${tl.checksRun} at ${tl.head.slice(0, 7)}; written again at ${tl.rewrites.map((r) => clock(state, r.at)).join(', ') || 'no time'}; queued at ${tl.adds.map((a) => clock(state, a.at)).join(', ') || 'no time'}; out at ${tl.removals.map((r) => `${clock(state, r.at)} (${r.reason})`).join(', ') || 'no time'}; out of runs said ${tl.spentRuns.length}, out of tries said ${tl.spentQueue.length}`,
      );
  }
  if (state.clean) {
    const { errors, unhealthy, restarted } = state.clean;
    console.log(`\nclean: ${errors.length + unhealthy.length + restarted.length ? 'no' : 'yes'}`);
    for (const line of errors) console.log(`  error lines  ${line}`);
    for (const line of unhealthy) console.log(`  unhealthy    ${line}`);
    for (const line of restarted) console.log(`  restarted    ${line}`);
  }
  if (state.kickedAt)
    console.log(`\nthe harness restarted the GitHub worker and the dependency sense at ${state.kickedAt}`);
}

/** Every test, one line each, from the latest finished run that held it. */
function summary() {
  const runs = readdirSync(RUNS)
    .filter((d) => existsSync(join(RUNS, d, 'state.json')))
    .sort()
    .map(load)
    .filter((r) => r.done && !r.flags.includes('--once'));
  for (const test of TESTS) {
    const id = test.id.padEnd(3);
    const title = test.title.padEnd(46);
    const run = runs.filter((r) => inRun(r, test)).at(-1);
    if (test.notRun) console.log(`${id} NOT RUN  ${title} ${test.notRun}`);
    else if (!run) console.log(`${id} NOT RUN  ${title} no finished run yet`);
    else {
      const { pass, why } = verdict(run, test);
      console.log(`${id} ${pass ? 'PASS    ' : 'FAIL    '} ${title} ${why}  [${run.id}]`);
    }
  }
}

// ── The campaign ────────────────────────────────────────────────────────────────────────────────────────────────────

function run(state: State) {
  const tests = TESTS.filter((t) => inRun(state, t));
  const only = state.test ? tests.find((t) => t.id === state.test) : undefined;
  if (state.campaign === 'app' && !only) throw new Error(`no app test ${state.test}`);
  const repo = state.campaign === 'app' ? APP : FACTORY;
  const reset =
    state.campaign === 'app' ? ['reset', 'app', ...(only?.dependency ? ['--store'] : [])] : ['reset', 'factory'];
  const has = (flag: string) => state.flags.includes(flag);
  if (!kubectl(['config', 'get-contexts', '-o', 'name']).split('\n').includes(CONTEXT))
    throw new Error(`no kube context ${CONTEXT}`);

  // The switches of the title check that fails on purpose (staged/factory/15-…): exactly what these tests need, and
  // nothing left over from another run, which would make every pull request it names red. Read, never set.
  for (const test of tests.filter((t) => t.variables)) {
    const beside = tests.filter((t) => t !== test && t.moves.some((m) => test.moves.includes(m)));
    if (beside.length)
      throw new Error(`${test.id} turns its move's check red: run it without ${beside.map((t) => t.id).join(', ')}`);
  }
  const wanted: Record<string, string> = Object.assign({}, ...tests.map((t) => t.variables ?? {}));
  const set: Record<string, string> = Object.fromEntries(
    (api<any>(repo, 'actions/variables?per_page=100').variables ?? [])
      .filter((v: any) => v.name.startsWith('SCRATCH_RED_'))
      .map((v: any) => [v.name, v.value]),
  );
  // The step they switch is in the factory copy's title check, which the app calls at the factory's baseline: a
  // baseline built before staged/factory/15-… has none, and the variables would do nothing.
  if (Object.keys(wanted).length) {
    const workflow = sh('gh', [
      'api',
      `repos/${FACTORY}/contents/.github/workflows/pull-request.yml?ref=baseline`,
      '-H',
      'Accept: application/vnd.github.raw',
    ]);
    const missing = Object.keys(wanted).filter((name) => !workflow.includes(`vars.${name}`));
    if (missing.length)
      throw new Error(
        `the factory copy's baseline has no check that reads ${missing.join(', ')}: build a baseline with staged/factory/15-checks-red-on-purpose.patch`,
      );
  }
  const wrong = [...new Set([...Object.keys(wanted), ...Object.keys(set)])].filter(
    (name) => wanted[name] !== set[name],
  );
  if (wrong.length)
    throw new Error(
      `${repo}'s variables are not what these tests need:\n${wrong
        .map((name) =>
          wanted[name] === undefined
            ? `  gh variable delete ${name} -R ${repo}`
            : `  gh variable set ${name} -R ${repo} -b '${wanted[name]}'`,
        )
        .join('\n')}`,
    );

  if (!state.resetAt && !has('--no-reset')) {
    say(state, `reset: ./copies.sh ${reset.join(' ')}`);
    const out = sh(join(BIN, 'copies.sh'), reset, { cwd: BIN, timeout: 30 * 60_000 });
    writeFileSync(join(dirOf(state.id), 'reset.log'), out);
    state.resetAt = new Date().toISOString();
    save(state);
  }
  if (!state.scan1) preflight(state);
  if (!state.scan1 && state.resetAt && !has('--no-reset') && !has('--no-scan')) {
    // The push of the reset's commit started a scan of its own, and the worker opens its pull requests from it: the
    // run stands on that one, and its clock starts there. From a minute before the reset, for any skew between the
    // Mac's clock and GitHub's.
    const since = new Date(Date.parse(state.resetAt) - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const { scan, main } = pushScan(repo, since);
    if (scan) {
      state.scan1 = scan;
      say(
        state,
        `scan ${scan.id}, started ${scan.createdAt}: the push of main at ${main.slice(0, 7)} started it, and the worker opens its pull requests from it`,
      );
    } else {
      say(
        state,
        `no scan of a push of main at ${main.slice(0, 7)} since the reset (the reset found main at the baseline, and pushed nothing): the run dispatches one`,
      );
    }
  }
  if (!state.scan1) {
    // A reset deletes the copy's code scanning analyses, and the scan cannot read its deadlines until main has one
    // again (CodeQL's run on the push): the scan waits for it, as the daily one never has to.
    for (let i = 0; !has('--no-scan'); i++) {
      let ready = false;
      try {
        ready =
          JSON.parse(sh('gh', ['api', `repos/${repo}/code-scanning/analyses?ref=refs/heads/main&per_page=1`])).length >
          0;
      } catch {}
      if (ready) break;
      if (i === 0) say(state, 'waiting for code scanning to have an analysis of main');
      if (i > 60) throw new Error(`code scanning has no analysis of ${repo}'s main after 30 minutes`);
      sleep(30_000);
    }
    state.scan1 = has('--no-scan') ? latestScan(repo) : dispatchScan(state, repo);
    if (!state.scan1) throw new Error('no scan to stand on');
    say(
      state,
      `scan ${state.scan1.id}, started ${state.scan1.createdAt}: ${has('--no-scan') ? "main's latest, as --no-scan asks" : 'dispatched'}`,
    );
  }
  if (!state.pods0) {
    say(state, `the clock starts at scan ${state.scan1.id}, ${state.scan1.createdAt}`);
    state.pods0 = podRestarts();
    state.failed0 = cluster()
      .pods.filter((p) => p.phase === 'Failed')
      .map((p) => p.name);
    save(state);
  }
  if (!state.scan1.moves) {
    awaitScan(state, repo, state.scan1, 'scan1');
    // awaitScan filled the moves in, which the check above narrowed away.
    const scan: Scan = state.scan1;
    say(state, `scan ${scan.id} ${scan.conclusion}: ${scan.moves?.length ?? 'no'} moves`);
    save(state);
  }
  // The forgeries, once the scan they copy is in: each on a branch of its own, which no watch owns or rewrites.
  for (const test of tests) {
    if (test.pr.by !== 'forged' || state.forged?.[test.id] || has('--no-forge')) continue;
    try {
      const out = sh('node', [join(BIN, 'forge.ts'), test.pr.forge, '--branch', `forged/${test.id.toLowerCase()}`], {
        cwd: BIN,
        timeout: 300_000,
      });
      const made = JSON.parse(out.slice(out.indexOf('{')));
      state.forged = { ...state.forged, [test.id]: { number: made.number, head: made.head } };
      say(state, `forged ${test.id}: #${made.number} at ${String(made.head).slice(0, 7)} (${made.forged?.what ?? ''})`);
    } catch (error) {
      say(state, `forging ${test.id} failed: ${String((error as any)?.stderr || error).slice(0, 300)}`);
    }
    save(state);
  }
  if (!state.kickedAt && !has('--no-kick')) {
    kubectl(['-n', 'factory', 'rollout', 'restart', 'deployment/github', 'deployment/patching']);
    kubectl(['-n', 'factory', 'rollout', 'status', 'deployment/patching', '--timeout=300s'], 320_000);
    kubectl(['-n', 'factory', 'rollout', 'status', 'deployment/github', '--timeout=300s'], 320_000);
    state.kickedAt = new Date().toISOString();
    say(state, 'restarted the GitHub worker and the dependency sense, for their passes now');
    save(state);
  }

  // An app test's move is the line's. The restored line is stopped: it is parked first (a take of just one, on a
  // ticket then closed, takes nothing), started so triage opens the scan's tickets, and then told the test's alone.
  if (only?.dependency && !state.startedAt) {
    const spare = store(
      `select o.work_item from events o where o.type = 'work-item.opened' and o.payload->>'kind' = 'defect-fix' and exists (select 1 from events t where t.work_item = o.work_item and t.type = 'ticket.opened') and not exists (select 1 from events c where c.work_item = o.work_item and c.type = 'work-item.closed') and not exists (select 1 from line l where l.work_item = o.work_item) order by o.seq limit 1`,
    )[0]?.[0];
    if (!spare) throw new Error('the store has no untaken defect ticket to park the line on');
    say(state, make(['take-the-line', `ONLY=${spare}`]).trim());
    say(state, make(['close-work-item', `ONLY=${spare}`, 'REASON=parks the line for a patching test']).trim());
    say(state, make(['start-the-line', 'REASON=a patching test']).trim());
    kubectl(['-n', 'factory', 'rollout', 'restart', 'deployment/patching']);
    const name = only.dependency.replace(/'/g, '');
    // A test's second ticket (`then`, W3) is found now too, from the same scan, and taken later.
    const second = only.then?.dependency.replace(/'/g, '');
    const scanned = state.scan1.createdAt;
    const ticket = (dependency: string, fresh: boolean) =>
      store(
        `select o.work_item from events o where o.type = 'work-item.opened' and o.payload->'dependency'->>'name' = '${dependency}' and not exists (select 1 from events c where c.work_item = o.work_item and c.type = 'work-item.closed')${fresh ? ` and exists (select 1 from events g where g.work_item = o.work_item and g.type = 'signal.received' and g.ts >= '${scanned}')` : ''} order by o.seq desc limit 1`,
      )[0]?.[0];
    for (let i = 0; !state.workItem || (second && !state.then); i++) {
      // The ticket the scan's send made or joined: one with a dependency signal since the scan started. A send that
      // says what the ticket already holds is only counted, and appends no event (test 8a, whose restored ticket has
      // the same findings), so after four minutes the open ticket for the dependency is taken as it stands.
      const fresh = i <= 8;
      if (i === 9)
        say(
          state,
          `no new signal on a ticket for ${name}${second ? ` or ${second}` : ''} in four minutes: taking the open ticket as it stands`,
        );
      state.workItem ??= ticket(name, fresh);
      const then = second && !state.then ? ticket(second, fresh) : undefined;
      // biome-ignore lint/suspicious/noThenProperty: the run's second ticket, never awaited
      if (then) state.then = { workItem: then, events: [] };
      if (state.workItem && (!second || state.then)) break;
      if (i > 40) {
        say(state, make(['stop-the-line', 'REASON=the patching test found no ticket']).trim());
        throw new Error(
          `triage opened no ticket for ${state.workItem ? second : only.dependency} from this scan within 20 minutes`,
        );
      }
      sleep(30_000);
    }
    if (state.then)
      say(
        state,
        `the second ticket, for ${second}: #${state.then.workItem}, taken once #${state.workItem}'s pull request merges`,
      );
    state.startedAt = new Date().toISOString();
    say(state, make(['take-the-line', `ONLY=${state.workItem}`]).trim());
    save(state);
  }
  const lineNow = () => {
    if (!state.workItem || !state.startedAt) return;
    const events = store(
      `select type, coalesce(payload->>'reason', payload->>'outcome', ''), coalesce(payload->>'cause', ''), coalesce(payload->>'commit', ''), coalesce((payload->'failed')::text, '') from events where work_item = '${state.workItem}' and ts >= '${state.startedAt}' order by seq`,
    );
    const types = events.map(([type]) => type ?? '');
    // The line's adds to the merge queue and the removals it recorded (W2).
    const enqueued = events.filter(([type]) => type === 'pull-request.enqueued').map(([, , , commit]) => commit ?? '');
    const dequeued = events
      .filter(([type]) => type === 'pull-request.dequeued')
      .map(([, reason, , commit, failed]) => ({ reason: reason ?? '', commit: commit ?? '', failed: failed ?? '' }));
    const lastHold = types.lastIndexOf('hold.started');
    // A merged fix waits at Release for its deploy pull request (cause `deploy`), which the line queues itself: a wait,
    // not a hold for Martin, and the run watches on.
    const waitsForDeploy = lastHold >= 0 && events[lastHold]?.[2] === 'deploy';
    const held =
      lastHold >= 0 && !waitsForDeploy && !types.slice(lastHold).includes('hold.answered')
        ? events[lastHold]?.[1] || 'no reason given'
        : undefined;
    const closed = events.find(([type]) => type === 'work-item.closed')?.[1];
    const also = state.then ? ` and work_item <> '${state.then.workItem}'` : '';
    const strays = store(
      `select distinct work_item from events where ts >= '${state.startedAt}' and work_item is not null and work_item <> '${state.workItem}'${also} and type in ('model.called', 'spec.written', 'pull-request.pushed', 'gates.started', 'issue.opened')`,
    ).map(([n]) => `#${n}`);
    // Nothing new for ten minutes, and no step running: the line is stuck, and its own log says on what. Not while the
    // line is told the second ticket alone (W3), which leaves the first waiting by design.
    let stalled: string | undefined;
    const lent = Boolean(state.then?.takenAt && !state.then.backAt);
    const [last] = store(
      `select extract(epoch from now() - greatest(max(ts), '${state.then?.backAt ?? state.startedAt}'::timestamptz))::int from events where work_item = '${state.workItem}'`,
    ); // from the take, for a ticket days old (test 8a)
    if (
      !lent &&
      !held &&
      !waitsForDeploy &&
      !closed &&
      Number(last?.[0] ?? 0) > 600 &&
      !kubectl(['-n', 'runners', 'get', 'pods', '--no-headers', '--field-selector=status.phase=Running']).trim()
    ) {
      const errors = kubectl(['-n', 'factory', 'logs', 'deployment/line', '--since=10m'], 300_000)
        .split('\n')
        .filter((line) => /"level":(5|6)\d\b/.test(line));
      let why = 'its log has no error';
      try {
        const parsed = JSON.parse(errors.at(-1) ?? '');
        why = `${parsed.msg}: ${parsed.err?.message ?? parsed.reason ?? ''}`.slice(0, 300);
      } catch {}
      stalled = `no event for ${Math.round(Number(last?.[0]) / 60)} minutes and no step running (the line: ${why})`;
    }
    state.line = { held, closed, stalled, strays, events: types, enqueued, dequeued };
    if (types.includes('hold.answered')) state.line.held = `a hold was answered: ${state.line.held ?? ''}`;
  };
  // The second ticket (W3), once taken: its end, its hold, its failed steps and its issue.
  const thenNow = () => {
    const then = state.then;
    if (!then?.takenAt) return;
    const events = store(
      `select type, coalesce(payload->>'outcome', ''), coalesce(payload->>'reason', ''), coalesce(payload->>'cause', ''), coalesce(payload->>'number', '') from events where work_item = '${then.workItem}' and ts >= '${then.takenAt}' order by seq`,
    );
    then.events = events.map(([type]) => type ?? '');
    const end = events.find(([type]) => type === 'work-item.closed');
    if (end) then.closed = { outcome: end[1] ?? '', reason: end[2] ?? '' };
    const lastHold = then.events.lastIndexOf('hold.started');
    then.held =
      lastHold >= 0 && !then.events.slice(lastHold).includes('hold.answered')
        ? events[lastHold]?.[2] || 'no reason given'
        : undefined;
    if (then.events.includes('hold.answered')) then.held = `a hold was answered: ${then.held ?? ''}`;
    then.failures = Number(
      store(`select coalesce(max(failures), 0) from line where work_item = '${then.workItem}'`)[0]?.[0] ?? 0,
    );
    // Its issue, the one the line opened for it (or holds from before), as GitHub has it.
    const number = Number(
      events.find(([type]) => type === 'issue.opened')?.[4] ||
        store(`select coalesce(max(issue), 0) from line where work_item = '${then.workItem}'`)[0]?.[0] ||
        0,
    );
    if (number) {
      const issue = api<any>(APP, `issues/${number}`);
      then.issue = {
        number,
        state: issue.state,
        reason: issue.state_reason ?? undefined,
        by: issue.closed_by?.login ?? undefined,
      };
    }
  };
  // W3's turns: the second ticket once the first's pull request merged and before its deploy (whose release would
  // let the take's look close it as cleared, not the pin step as made), then the first back for its deploy.
  const turns = () => {
    const then = state.then;
    if (!then || !state.workItem || then.backAt) return;
    if (!then.takenAt && only && state.seen[only.id]?.pulls.find((p) => p.mergedAt)) {
      then.takenAt = new Date().toISOString();
      say(
        state,
        `#${state.workItem}'s pull request merged: the line takes #${then.workItem} alone. ${make(['take-the-line', `ONLY=${then.workItem}`]).trim()}`,
      );
      save(state);
      return;
    }
    const waited = then.takenAt ? Date.now() - Date.parse(then.takenAt) : 0;
    if (then.takenAt && (then.closed || then.held || waited > 20 * 60_000)) {
      then.backAt = new Date().toISOString();
      const why = then.closed ? `closed ${then.closed.outcome}` : then.held ? 'held' : 'not closed in 20 minutes';
      say(
        state,
        `#${then.workItem} ${why}: the line takes #${state.workItem} back. ${make(['take-the-line', `ONLY=${state.workItem}`]).trim()}`,
      );
      save(state);
    }
  };

  // A test that ends out of tries (W1b) is watched past the limit, to see nothing comes after; the limit still judges
  // every deploy.
  const watchMin = Math.max(state.limitMin, ...tests.map((t) => t.watchMin ?? 0));
  const deadline = Date.parse(state.scan1.createdAt) + watchMin * 60_000;
  // Done: deployed (and a second ticket ended, W3), or out of runs and settled (W1b).
  const done = (t: Test) =>
    t.checksRun?.spent
      ? verdict(state, t).pass
      : Boolean(state.seen[t.id]?.deployedAt) && (!t.then || Boolean(state.then?.closed));
  while (!state.watchedUntil) {
    lineNow();
    thenNow();
    observe(state, tests);
    turns();
    const lines = tests.map((t) => `${t.id}:${verdict(state, t).why.slice(0, 60)}`);
    say(state, `watching (${clock(state, new Date().toISOString())})\n    ${lines.join('\n    ')}`);
    const refused = tests.every((t) => t.mustNot && verdict(state, t).pass);
    // A move that must not merge, or a major the level holds, counts as settled once it is decided (`decidedHeld`),
    // or, while it is still refused, an hour from the scan (Martin's first limit): a batch of them beside moves that
    // deployed ends then, not at a longer limit set for the slow ones.
    const hour = Date.now() >= Date.parse(state.scan1.createdAt) + 60 * 60_000;
    const mustHold = (t: Test) => t.mustNot || (t.major && !state.flags.includes('--lights-out'));
    const waits = tests.some((t) => mustHold(t) && t.pr.by !== 'forged') ? workerWaits(state) : new Map();
    const holds = (t: Test) =>
      Boolean(mustHold(t)) && ((hour && verdict(state, t).pass) || decidedHeld(state, t, waits));
    const all = refused || tests.every((t) => done(t) || holds(t));
    const stopped =
      Boolean(
        state.line?.held || state.line?.closed || state.line?.stalled || state.line?.strays.length || state.then?.held,
      ) && !all;
    if (all || stopped || Date.now() >= deadline || has('--once')) state.watchedUntil = new Date().toISOString();
    else sleep(Math.min(POLL_MS, Math.max(1_000, deadline - Date.now())));
  }
  save(state);

  if (state.startedAt && !state.stoppedAt) {
    say(state, make(['stop-the-line', 'REASON=the patching test is over']).trim());
    state.stoppedAt = new Date().toISOString();
    save(state);
  }
  if (!state.scan2 && !has('--once') && tests.some((t) => !t.mustNot && state.seen[t.id]?.deployedAt)) {
    state.scan2 = dispatchScan(state, repo);
    say(state, `the next scan: ${state.scan2.id}`);
    save(state);
  }
  if (state.scan2 && !state.scan2.moves) {
    awaitScan(state, repo, state.scan2, 'scan2');
    save(state);
  }
  lineNow();
  thenNow();
  observe(state, tests, true);
  state.clean = clean(state);
  state.done = true;
  save(state);
  report(state);
}

// ── The command line ────────────────────────────────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);
/** `--only 1,2,N4`: the tests a small run stands for, each one the catalogue's. */
/**
 * `app <test> --with X1a,X1b`: forgeries in the app copy that ride beside an app test's scan (or an app test that is
 * one itself), judged by the gate alone; the line works only the test's own ticket.
 */
function withOf(command: string | undefined, args: string[]): string[] | undefined {
  const at = args.indexOf('--with');
  if (at < 0) return undefined;
  const ids = (args[at + 1] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const wrong = ids.filter((id) => !TESTS.some((t) => t.id === id && t.campaign === 'app' && t.pr.by === 'forged'));
  if (command !== 'app' || !ids.length || wrong.length)
    throw new Error(
      `--with takes the app's forgeries, comma-separated, on an app run${wrong.length ? `: not ${wrong.join(', ')}` : ''}`,
    );
  return ids;
}
function onlyOf(args: string[]): string[] | undefined {
  const at = args.indexOf('--only');
  if (at < 0) return undefined;
  const ids = (args[at + 1] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !TESTS.some((t) => t.id === id));
  if (!ids.length || unknown.length)
    throw new Error(
      `--only takes tests of the catalogue's, comma-separated${unknown.length ? `: not ${unknown.join(', ')}` : ''}`,
    );
  return ids;
}
const latestRun = () =>
  readdirSync(RUNS)
    .filter((d) => existsSync(join(RUNS, d, 'state.json')))
    .sort()
    .at(-1);
mkdirSync(RUNS, { recursive: true });
if (command === 'factory' || command === 'app') {
  const limit = rest.indexOf('--limit');
  const test = command === 'app' ? rest[0] : undefined;
  const id = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}Z-${test ? `app-${test}` : 'factory'}`;
  mkdirSync(dirOf(id), { recursive: true });
  const state: State = {
    id,
    campaign: command,
    test,
    limitMin: limit >= 0 ? Number(rest[limit + 1]) : 60,
    flags: rest.filter((r) => r.startsWith('--no-') || r === '--once' || r === '--lights-out'),
    only: onlyOf(rest),
    with: withOf(command, rest),
    seen: {},
  };
  save(state);
  run(state);
} else if (command === 'only') {
  // The batch.env line that has the scratch pin watch take just these tests' moves (a forgery copies postgres's).
  const ids = (rest[0] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const tests = TESTS.filter((t) => ids.includes(t.id));
  if (!ids.length || tests.length !== ids.length)
    throw new Error("only <tests>: comma-separated tests of the catalogue's");
  const names = pinWatchNames(tests);
  const none = tests.filter((t) => t.campaign !== 'factory' || t.pr.by === 'dependabot').map((t) => t.id);
  if (none.length)
    console.error(
      `not the pin watch's: ${none.join(', ')} (an app test runs alone already; Dependabot's is kept by DEPENDABOT_KEEP_*)`,
    );
  if (!names.length) throw new Error('only: none of those tests stands on a move of the pin watch');
  console.log(`PIN_WATCH_ONLY='${names.join(',')}'`);
  console.log(`in batch.env; then: node harness.ts factory --only ${ids.join(',')}, whose reset gives it the worker`);
} else if (command === 'variables') {
  // The repository variables these tests need, `<repo>\t<name>\t<value>` a line, for confirm.sh to set and clear.
  const ids = (rest[0] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const tests = TESTS.filter((t) => ids.includes(t.id));
  if (!ids.length || tests.length !== ids.length)
    throw new Error("variables <tests>: comma-separated tests of the catalogue's");
  for (const test of tests)
    for (const [name, value] of Object.entries(test.variables ?? {})) console.log(`${test.repo}\t${name}\t${value}`);
} else if (command === 'resume') {
  run(load(rest[0] ?? latestRun() ?? ''));
} else if (command === 'report') {
  report(load(rest[0] ?? latestRun() ?? ''));
} else if (command === 'reread') {
  // A finished run read again from GitHub and the cluster as they stand: nothing is reset, scanned or restarted.
  const state = load(rest[0] ?? latestRun() ?? '');
  observe(
    state,
    TESTS.filter((t) => inRun(state, t)),
    true,
  );
  report(state);
} else if (command === 'summary') {
  summary();
} else {
  console.error(
    'usage: harness.ts factory | app <test> [--limit <min>] [--no-reset] [--no-scan] [--no-kick] [--once] | only <tests> | variables <tests> | resume [<run>] | report [<run>] | summary',
  );
  process.exit(2);
}
