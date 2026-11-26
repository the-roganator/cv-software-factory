#!/usr/bin/env node
/**
 * The patching tests' harness (../TESTS.md): it resets the scratch copies, runs the real scan, and
 * watches each move to the end or to wherever it stops, reading only GitHub and the scratch cluster. One line a test.
 *
 * Its only acts: `./copies.sh reset`, dispatching `vulnerabilities.yml` on a copy's main, restarting the scratch
 * cluster's GitHub worker and dependency sense so their passes come now and not on the hour, asking Argo CD to look at
 * git now once a watched pull request has merged (a refresh, which hastens its poll and changes nothing in the
 * cluster), `./copies.sh summon-dependabot` for the tests of Dependabot's own pull requests (20, and 22 on the
 * factory copy, between its reset and the worker's start), and, for an app test,
 * telling the line which ticket it takes (W3 turns it to a second ticket and back). Three tests stage what they stand
 * on as the run goes: W3b puts its image's move on the app copy's main before the line takes the ticket
 * (`./copies.sh move-on-main`), 21 lifts the factory copy's exception once the pull request is open
 * (`./copies.sh lift-exception`) and scans the app copy again, and W5 leaves a report through the app's widget and
 * deletes the store's pod. An app run with 24 tells the pin watch that test's move by name (the ConfigMap
 * `scratch-pin-watch`), as the worker opens an issue only for a move it was told. Four more are a run's own: a factory
 * run's reset holds the pin watch at no move until the scan the run stands on is in, and then gives it the batch's
 * (`./copies.sh pin-watch`); a run whose pull requests the worker queues has the scratch line running, with new work
 * off (`./stop.sh running`), as a stopped line queues no move; test 25 asks for changes on its pull request, as
 * Martin's login (`gh pr review --request-changes`); and test 27 puts a merged move's pins back on the factory copy's
 * main (`./copies.sh revert-move`), scans again, and restarts the scratch GitHub worker once that scan is in, so its
 * pin watch reads it. It never approves, queues, re-runs a check, answers a hold or sets
 * a variable (a test's `variables` are read, and confirm.sh sets them). Everything else is a read.
 *
 *     node harness.ts factory [--only 1,2,N4] [--limit 60] [--lights-out] [--no-reset] [--no-scan] [--no-kick] [--no-forge] [--once]
 *     node harness.ts only 1,2,N4       the batch.env line for a small run of those tests
 *     node harness.ts variables W1a,W1b the repository variables those tests need, for confirm.sh to set
 *     node harness.ts app X1a --with X1b   an app run, and the app's forgeries beside its test
 *     node harness.ts app W5            the store restarted under a report: no reset, no scan
 *     node harness.ts batch 1,2 | none  the pin watch's moves for those tests, or none, written to batch.env
 *     node harness.ts waits <since> stopped|supervised|either   whether every move's pull request opened since waits
 *                                       as that says, by the worker's own word (confirm.sh's batch D asks)
 *     node harness.ts resume <run>      carry on a run that was stopped
 *     node harness.ts report [<run>]    the lines of a run (the latest by default)
 */
// biome-ignore-all lint/suspicious/noExplicitAny: it reads GitHub's and the cluster's JSON as each gives it, untyped
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP, FACTORY, TESTS, type Test } from './catalogue.ts';
import {
  besideWords,
  branchFits,
  certainFail,
  changesVerdict,
  type DuplicateFacts,
  dependabotMissing,
  duplicateVerdict,
  extraSpoils,
  factoryBusy,
  holdBroken,
  holdDecided,
  isRoutine,
  issueFault,
  issueOfMove,
  leftAloneFault,
  lineTooEarly,
  type MovesFile,
  majorNext,
  majorNextFault,
  majorNotFirst,
  moveFits,
  N10_RULESETS,
  newerFault,
  notListed,
  PIN_PASS_LIMIT_MS,
  pickScan,
  pinsFault,
  pinWatchLacks,
  pinWatchLine,
  printOf,
  probeQuery,
  queuedFault,
  queueWords,
  REFUSAL_KINDS,
  restartVerdict,
  revertedVerdict,
  rolloutProgressing,
  routineBranch,
  rulesetsFault,
  saysNotPulled,
  seenToTheGates,
  settleMs,
  shownAs,
  startingPods,
  stillListed,
  type TicketFacts,
  ticketFault,
  unreadMoves,
  WAITING_KEY,
  waitedVerdict,
  waitsFault,
  watcherRode,
  watchRead,
  withoutDependabot,
  withSetting,
  workflowPins,
} from './decide.ts';
import { BIN, WORK as CLONES, RUNS, SKILL, STATE as STATE_DIR } from './paths.ts';

const CONTEXT = 'k3d-software-factory-scratch';
const APP_BOT = 'the-roganator-scratch-factory[bot]';
const REVIEW_APP = 5470762;
/**
 * How often the watch looks. A look is cheap: two lists of the copy's pull requests and one of its issues (REST), and
 * one GraphQL query that says which pull requests changed (`probe`); only a changed one is read in full, five requests.
 * A batch of nine pull requests is some 550 REST requests an hour for the looks and 700 for the reads, of the 5,000 an
 * hour Martin's login has.
 */
const POLL_MS = 20_000;
/** The same, when the cheap look failed and every open pull request is read in full. */
const SLOW_POLL_MS = 120_000;
/** A watch says where each test stands when that changes, and at least this often. */
const SAY_MS = 120_000;
const WORK = join(CLONES, 'factory');

// ── The only doors out ──────────────────────────────────────────────────────────────────────────────────────────────

const COPIES_ONLY = new Set([FACTORY, APP]);
function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: Record<string, string> } = {},
): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
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
/** The moves the scratch pin watch must take for these tests (a forgery's are those it copies, `needs`). */
function pinWatchNames(tests: Test[]): string[] {
  return [
    ...new Set(
      tests.flatMap((t) =>
        t.pr.by === 'forged'
          ? t.repo === FACTORY
            ? (t.needs ?? [])
            : []
          : t.pr.by === 'pin' || t.pr.by === 'lockfile'
            ? [...t.moves, ...(t.alsoTakes ?? [])]
            : [],
      ),
    ),
  ];
}

/**
 * For an app run with a test that ends as an issue of the worker's (24): the pin watch is told that test's move by
 * name and nothing else, in the ConfigMap the worker reads as it starts, which the run's restart of the worker then
 * gives it. An issue rolls nothing, so the factory copy stays at rest; its own scan lists no move of that name. The
 * next reset writes the ConfigMap from batch.env again.
 */
function issueWatch(state: State, tests: Test[]) {
  const names = [...new Set(tests.filter((t) => t.campaign === 'app' && t.issue).flatMap((t) => t.moves))];
  if (state.campaign !== 'app' || !names.length) return;
  const only = names.join(',');
  try {
    kubectl([
      '-n',
      'factory',
      'patch',
      'configmap',
      'scratch-pin-watch',
      '--type',
      'merge',
      '-p',
      JSON.stringify({ data: { only } }),
    ]);
  } catch {
    try {
      kubectl(['-n', 'factory', 'create', 'configmap', 'scratch-pin-watch', `--from-literal=only=${only}`]);
    } catch {}
  }
  say(state, `told the pin watch to take ${only} alone, for the worker's issue: it reads it as the run restarts it`);
}

function preflight(state: State, appJustReset: boolean) {
  const wrong: string[] = [];
  // The moves the scratch GitHub worker takes, which a reset writes to the ConfigMap `scratch-pin-watch` from
  // batch.env (copies.sh's pin_watch) and the worker reads as it starts: every move a small run's tests stand on.
  if (state.campaign === 'factory' && state.only) {
    const needed = pinWatchNames(TESTS.filter((t) => inRun(state, t) && t.campaign === 'factory'));
    let told = '';
    try {
      // While the run holds the watch at no move, what it will be given once the scan is in: batch.env's, as
      // copies.sh reads it.
      told = state.held?.at
        ? // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own default, for bash to read
          sh('bash', ['-c', 'source "$1"; printf %s "${PIN_WATCH_ONLY-*}"', '-', join(STATE_DIR, 'batch.env')])
        : kubectl(['-n', 'factory', 'get', 'configmap', 'scratch-pin-watch', '-o', 'jsonpath={.data.only}']).trim();
    } catch {}
    const missing = pinWatchLacks(told, needed);
    if (!told)
      wrong.push(
        `the pin watch is told no move: \`node harness.ts batch ${state.only.join(',')}\`, then ./copies.sh reset factory`,
      );
    else if (missing.length)
      wrong.push(
        `the pin watch takes ${told}, not ${missing.join(', ')}: put \`node harness.ts only\`'s line in batch.env`,
      );
    else if (told === '*')
      say(
        state,
        `pre-flight: the pin watch takes every move (*), not these tests' alone (${needed.join(', ')}): every pull request of the day opens and may merge beside them. \`node harness.ts batch ${state.only.join(',')}\` names them in batch.env`,
      );
    else
      say(
        state,
        `pre-flight: the pin watch takes ${told}${state.held?.at ? ', once the scan the run stands on is in: no move until then' : ''}`,
      );
  }
  // An app run's test that ends as an issue of the worker's (24): the worker's pass over the app's repository follows
  // the same setting, so the pin watch must take its move by name, which the run wrote before this (`issueWatch`).
  // Told otherwise, the test is dropped with no verdict beside another, and alone it stops the run.
  const issued = TESTS.filter((t) => inRun(state, t) && t.campaign === 'app' && t.issue);
  if (issued.length) {
    let told = '';
    try {
      told = kubectl(['-n', 'factory', 'get', 'configmap', 'scratch-pin-watch', '-o', 'jsonpath={.data.only}']).trim();
    } catch {}
    const alone = TESTS.filter((t) => inRun(state, t)).length === issued.length;
    for (const test of issued) {
      const lacks = pinWatchLacks(told, test.moves);
      if (!lacks.length) continue;
      const why = `the pin watch is told ${told || 'no move'}, not ${lacks.join(', ')}, so the worker opens no issue for it`;
      if (alone) wrong.push(`test ${test.id}: ${why}`);
      else {
        state.dropped = { ...state.dropped, [test.id]: why };
        say(state, `pre-flight, no verdict for ${test.id}, which is dropped from this run: ${why}`);
      }
    }
    if (!wrong.length && issued.some((t) => !state.dropped?.[t.id]))
      say(state, `pre-flight: the pin watch takes ${told}`);
  }
  // The rulesets N10's two pushes must be refused by, on the copy and enforced: a reset applies no settings
  // (`./copies.sh settings` does), and a script that died with them off leaves them off. Read, never written.
  for (const test of TESTS.filter((t) => inRun(state, t) && t.pr.by === 'forged' && t.pr.forge === 'N10')) {
    const fault = rulesetsFault(test.repo, JSON.parse(sh('gh', ['api', `repos/${test.repo}/rulesets`])));
    if (fault) wrong.push(fault);
    else
      say(
        state,
        `pre-flight: ${test.repo} has its rulesets ${N10_RULESETS.map((r) => `"${r.name}"`).join(' and ')}, active`,
      );
  }
  // A test's own set-up beyond the shared baseline (`staged/<side>-<name>/`, a Test's `staged`): on the baseline exactly
  // when one of the run's tests asks for it, as it changes what the others do. Read from what `build` committed.
  // A set-up may have a folder for each side (test 21: the app's package, the factory's exception for it).
  const asked = new Set(
    TESTS.filter((t) => inRun(state, t) && t.staged).flatMap((t) => [`app-${t.staged}`, `factory-${t.staged}`]),
  );
  for (const side of ['factory', 'app']) {
    const built = sh('git', ['-C', join(CLONES, side), 'log', '--format=%s', '-40']);
    for (const folder of readdirSync(join(SKILL, 'staged')).filter((f) => f.startsWith(`${side}-`))) {
      const patches = readdirSync(join(SKILL, 'staged', folder)).filter((f) => f.endsWith('.patch'));
      const on =
        patches.length > 0 &&
        patches.every((f) => built.includes(`chore(scratch): staged, ${f.replace(/\.patch$/, '')}`));
      // One that serves the app's tests alone leaves a factory run as it was (decide.ts's `extraSpoils`).
      const serves = TESTS.filter((t) => t.staged === folder.slice(side.length + 1)).map((t) => t.campaign);
      if (on && !asked.has(folder) && !extraSpoils(state.campaign, serves))
        say(state, `pre-flight: the ${side} baseline carries staged/${folder}/, for the app's tests alone`);
      if (on && !asked.has(folder) && extraSpoils(state.campaign, serves))
        wrong.push(
          `the ${side} baseline carries staged/${folder}/, which no test of this run asks for: build one without it`,
        );
      if (!on && asked.has(folder))
        wrong.push(
          `the ${side} baseline lacks staged/${folder}/, which this run's tests need: build with STAGED_EXTRA=${folder.slice(side.length + 1)} in batch.env`,
        );
    }
  }
  // The factory copy at rest under an app's test: nothing of the App's open there that would merge and roll the
  // factory while the app's test is judged clean (decide.ts's `factoryBusy`).
  if (state.campaign === 'app') {
    const busy = factoryBusy({
      pulls: api<any[]>(FACTORY, 'pulls?state=open&per_page=100').map((p) => ({
        number: p.number,
        title: p.title,
        author: p.user.login,
      })),
      app: APP_BOT,
      main: mainOf(FACTORY),
      baseline: sh('gh', ['api', `repos/${FACTORY}/commits/baseline`, '--jq', '.sha']).trim(),
    });
    if (busy)
      wrong.push(
        `${busy}: \`node harness.ts batch none\`, then ./copies.sh reset factory, and wait for root to be Synced and Healthy`,
      );
  }
  // The pull requests of Dependabot's the run's tests are judged on or beside, open and without a conflict, and, for
  // one a reset opened again by hand, made since main was last put at the baseline: a reset keeps them, opens one that
  // is closed again and asks Dependabot to make it again, so here the run opens once more what is closed and waits,
  // five minutes, or ten for one only a summon brings (22's, which the reset summoned for when none was open).
  // Without one its test would pass or fail on nothing: it is dropped from the run with no verdict, and the run stops
  // only when no test is left (decide.ts's `withoutDependabot`). Test 20's is summoned later, by the run.
  const kept = TESTS.filter((t) => inRun(state, t)).flatMap((t) => [
    ...(t.pr.by === 'dependabot' && !t.summons
      ? [{ test: t.id, title: t.pr.title, anyAge: Boolean(t.duplicate) }]
      : []),
    ...(t.duplicate ? [{ test: t.id, title: t.duplicate.leaves, asIs: true }] : []),
  ]);
  if (kept.length) {
    const repo = state.campaign === 'app' ? APP : FACTORY;
    const baselineAt = baselinePushedAt(repo);
    const lacking = () => {
      const open = api<any[]>(repo, 'pulls?state=open&per_page=100')
        .filter((p) => p.user.login === 'dependabot[bot]' && kept.some((need) => need.title.test(p.title)))
        .map((p) => {
          // The list says nothing of a conflict: the pull request's own read does, once GitHub has worked it out.
          const { mergeable } = api<{ mergeable: boolean | null }>(repo, `pulls/${p.number}`);
          const head = api<any>(repo, `commits/${p.head.sha}`);
          return {
            number: p.number as number,
            title: p.title as string,
            headAt: head.commit.committer.date as string,
            conflicting: mergeable === null ? undefined : !mergeable,
          };
        });
      return kept.flatMap((need) =>
        dependabotMissing([need], open, baselineAt).map((why) => ({ test: need.test, why, summoned: need.anyAge })),
      );
    };
    let missing = lacking();
    if (missing.length) {
      const minutes = missing.some((m) => m.summoned) ? 10 : 5;
      say(
        state,
        `pre-flight: ${missing.map((m) => m.why).join('; ')}: opening again what is closed, asking Dependabot to recreate it, and waiting ${minutes} minutes`,
      );
      sh(join(BIN, 'copies.sh'), ['reopen-dependabot', repo === APP ? 'app' : 'factory'], {
        cwd: BIN,
        timeout: 5 * 60_000,
      });
      for (let i = 0; i < minutes * 3 && missing.length; i++) {
        sleep(20_000);
        missing = lacking();
      }
      missing = missing.map((m) => ({ ...m, why: `${m.why}, ${minutes} minutes after Dependabot was asked for it` }));
    }
    const without = withoutDependabot(
      missing,
      TESTS.filter((t) => inRun(state, t)).map((t) => t.id),
    );
    wrong.push(...without.stop);
    for (const [id, why] of Object.entries(without.dropped)) {
      state.dropped = { ...state.dropped, [id]: why };
      say(
        state,
        `pre-flight, no verdict for ${id}, which is dropped from this run: ${why}. The run's other tests go on`,
      );
    }
    save(state);
  }
  // The store at the baseline's newest migration: a restore's dump predates some, and the GitHub worker reads the
  // level and the line's stop through two of them, queueing nothing without either.
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
  // tests' starting point. So a run that has just reset the app copy promotes it whole while it is in flight or
  // aborted; any other run (a factory campaign, `--no-reset`, a resume) promotes only an aborted one, as what is in
  // flight there may be a test's own. Either waits for the Rollout to be Healthy on main before the clock starts.
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
    if (synced === appMain && rollout && (appJustReset || rollout.endsWith('true'))) {
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
  /** What its `moves.json` lists as waiting (decide.ts's `WAITING_KEY`); undefined for a scan that does not say. */
  waiting?: unknown;
}
/** A scan as decide.ts reads one: its id, its moves and what it says waits. */
const fileOf = (scan: Scan): { id: number } & MovesFile => ({
  id: scan.id,
  ...(scan.moves ? { moves: scan.moves } : {}),
  ...(scan.waiting === undefined ? {} : { [WAITING_KEY]: scan.waiting }),
});
interface Move {
  name: string;
  lane: string;
  from: string;
  to: string;
  pins: { file: string }[];
  lockfile?: boolean;
  /** Whether its target is on another major than its pin. */
  major?: boolean;
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
  /** Its branch, and the moves its description marks or its title names (`pinMoves`). */
  branch?: string;
  carries?: string[];
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
  /** For a test that ends as an issue: when the run first saw the issue with no pull request beside it. */
  issuedAt?: string | undefined;
  /** Why the test has failed for good before its limit (`certainFail`), once it has. */
  certain?: string | undefined;
  /** For a test with `calls`: why the caller's pins are not one commit of the called repository's main, or '' when they are. */
  pinned?: string | undefined;
  /** For a test with `unread`: what the scan's run left and said, and the open alerts at the image's file. */
  unread?: { artifacts: string[]; said: string[]; alertsBefore?: number; alertsAfter?: number };
  /**
   * For a test that must not merge: the first head at which its hold was decided (`decidedHeld`), and when. From then
   * the test stays held unless the hold is broken (decide.ts's `holdBroken`), whatever a later head still waits for.
   */
  heldAt?: { head: string; at: string };
  /** For a test with `keeps`: each line, as `removed` reads it; 'moved' is the fault. */
  kept?: string[];
  /**
   * For a test with `refused`: the App's issue for the move the pin step refused, the kind of reason it gives, what it
   * lacks, and its text as read, which a reset deletes with the issue.
   */
  refusal?: { number?: number; kind?: string; fault?: string; body?: string };
  /** For a test with `says`: whether each issue found is the App's and says it. */
  issueSays?: boolean;
  /** For a test with `duplicate`: Dependabot's pull request, and those of its that main lacks the lines of. */
  duplicate?: DuplicateFacts | undefined;
  /** For a test with `beside`: Dependabot's pull request for the same pin, if there is one. */
  besideOf?: DuplicateFacts | undefined;
  /** For a test with `duplicate`: the lines Dependabot's diff adds and those the App's merged move added. */
  duplicateLines?: { theirs: string[]; ours: string[] };
  leftAlone?: DuplicateFacts[];
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
  /** W3b: when the run put the move on main, and the ticket the line then took. */
  made?: { at: string; said: string; ticket: TicketFacts };
  /**
   * Test 21: the pull request's head and its issue's text when it opened, the lift of the exception, the scan
   * dispatched after it, when the sense was restarted on that scan, and the issue and the lockfile's lines since.
   */
  later?: {
    issue?: number | undefined;
    headAtOpen?: string;
    issueAtOpen?: string | undefined;
    liftedAt?: string;
    scan?: number;
    toldAt?: string;
    issueNow?: string | undefined;
    adds?: string[];
  };
  /** W5: the report, the store's restart, and what came of them. */
  restart?: {
    at: string;
    posted: number;
    restarted: boolean;
    inbox: number;
    arrivedS?: number;
    errors: string[];
    unhealthy: string[];
    /** How long the store's pod was kept away, in seconds, and what the log watcher's log says of it. */
    awayS?: number;
    watcher?: { away: boolean; back: boolean };
  };
  limitMin: number;
  flags: string[];
  /** A small run: the only tests this run stands for (`--only 1,2,N4`). The rest are not run, and not judged from it. */
  only?: string[] | undefined;
  resetAt?: string | undefined;
  /**
   * The reset's own push, which the scan its run stands on is found by: when it began, and `main`'s commit before and
   * after it. A reset that found `main` at the baseline has the two the same, and pushed nothing.
   */
  reset?: { startedAt: string; before: string; after: string } | undefined;
  scan1?: Scan | undefined;
  /**
   * The first scan after the run's reset, when the run stands on the one after it: with no state to read, it lists no
   * image or chart whose content it first saw that day, and `scan1` reads the state it left, its sightings put back.
   */
  scan0?: Scan | undefined;
  /** A scan after the confirming one: after test 27's revert, or for a major a move within it must be followed by. */
  scan3?: Scan | undefined;
  /** The reset held the pin watch at no move (`at`), and the run gave it the batch's once its scan was in (`released`). */
  held?: { at: string; released?: string };
  /** The run found the line stopped and set it running, with new work off, for the worker to queue. */
  idledAt?: string;
  /** Test 25: the review that asks for changes, the head it was posted on and the required checks running then. */
  review?: { number: number; head: string; at: string; pending: string[] };
  /**
   * Test 27: the merge put back, the commit that did it, and what came after: the scan, the worker's restart once it
   * was in (and the worker's error lines until then, which go with its pod), the pin watch's pass on that scan as its
   * log has it, and the App's pull requests and issues for the move since.
   */
  reverted?: {
    merge: string;
    commit?: string;
    at?: string;
    scannedAt?: string;
    restartedAt?: string;
    before?: { errors: string[]; errorAt: string[] };
    read?: { at: string; run: number };
    watchedUntil?: string;
    pulls: number[];
    issues: { number: number; author: string; body: string; at?: string }[];
  };
  kickedAt?: string;
  /** When the run summoned Dependabot (test 20; test 22, at its reset). */
  summonedAt?: string;
  /** The scratch GitHub worker's poll, in seconds, as its Deployment sets it (60 when it sets none). */
  workerPollS?: number;
  pods0?: Record<string, number>;
  /** Pods already failed when the run began (a canary's journeys Job from before it): no dirt of this run's. */
  failed0?: string[];
  watchedUntil?: string;
  scan2?: Scan | undefined;
  /** `errorAt`: when each error line was logged (ISO; '' where the line gave no time), so a move answers only for those since its pull request opened. */
  clean?: { errors: string[]; unhealthy: string[]; restarted: string[]; errorAt?: string[] };
  /** The forgeries forge.ts made for this run: each test's pull request and the commit that must be held. */
  forged?: Record<string, { number?: number; head?: string; refused?: string; landed?: string }>;
  seen: Record<string, Seen>;
  /**
   * Tests dropped at the pre-flight, each with why: its pull request of Dependabot's could not be had. The run goes
   * on without them, and each reads "pre-flight, no verdict".
   */
  dropped?: Record<string, string>;
  done?: boolean;
}

/**
 * Whether a run stands for a test: one of its campaign's, the one an app run names and the forgeries it carries
 * (`--with`), or one a small run names. A test that turns a check red on purpose (`variables`) stands on a move another
 * test has too (W1a on test 2's), so does one Martin asks for changes on (25 on 14b's), and one that needs a baseline
 * of its own (`staged`) changes what others do: a factory run has each only by name, and the first two never beside a
 * test of the same move.
 */
function inRun(state: Pick<State, 'campaign' | 'test' | 'only' | 'with'>, test: Test): boolean {
  if (test.campaign !== state.campaign || test.notRun) return false;
  if (state.with?.includes(test.id)) return true;
  if (state.test && test.id !== state.test) return false;
  // One that turns a check red or stands on a baseline of its own is in a run only by name.
  return state.only
    ? state.only.includes(test.id)
    : Boolean(state.test) || !(test.variables || test.staged || test.asksChanges);
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
/** `main`'s commit now: the sha alone, as the commit's own page lists its files, hundreds for a baseline. */
/**
 * When a copy's `main` was last put at its baseline: the newest move of `main` to the baseline's commit, as GitHub's
 * activity has it, which a reset's push is; where the activity no longer reaches it, when the baseline's commit was
 * made, which is before any push of it.
 */
function baselinePushedAt(repo: string): string {
  repoOk(repo);
  const baseline = JSON.parse(sh('gh', ['api', `repos/${repo}/commits/baseline`])) as {
    sha: string;
    commit: { committer: { date: string } };
  };
  const moves = JSON.parse(sh('gh', ['api', `repos/${repo}/activity?ref=refs/heads/main&per_page=100`])) as {
    after: string;
    timestamp: string;
  }[];
  return moves.find((move) => move.after === baseline.sha)?.timestamp ?? baseline.commit.committer.date;
}
function mainOf(repo: string): string {
  repoOk(repo);
  return sh('gh', ['api', `repos/${repo}/commits/main`, '--jq', '.sha']).trim();
}
/**
 * The scan the push of `commit` to main started since `since`, which the worker opens its pull requests from: the one
 * a run stands on when there is one. Asked for by its commit, so pushes to main after it (the worker's merges) do not
 * hide it; none when it has not appeared within two minutes.
 */
function pushScan(repo: string, commit: string, since: string): Scan | undefined {
  repoOk(repo);
  for (let i = 0; i < 12; i++) {
    const runs =
      JSON.parse(
        sh('gh', [
          'api',
          `repos/${repo}/actions/workflows/vulnerabilities.yml/runs?branch=main&event=push&head_sha=${commit}&per_page=20`,
        ]),
      ).workflow_runs ?? [];
    const run = runs.find((r: any) => r.head_sha === commit && r.created_at >= since);
    if (run)
      return {
        id: run.id,
        createdAt: run.created_at,
        conclusion: run.status === 'completed' ? run.conclusion : undefined,
      };
    if (i < 11) sleep(10_000);
  }
  return undefined;
}
/**
 * The warnings of a scan's run that name one of these moves' pins: by the move's name, or the image's repository or
 * its last part, as the scan words a pin it lists no fix for.
 */
function scanWarnings(repo: string, scan: Scan, names: string[]): string[] {
  const parts = names.flatMap((name) => {
    const pin = name.includes(': ') ? (name.split(': ').at(-1) ?? name) : name;
    return [...new Set([name, pin, pin.split('/').at(-1) ?? pin])];
  });
  const said: string[] = [];
  try {
    for (const job of api<any>(repo, `actions/runs/${scan.id}/jobs?per_page=100`).jobs ?? [])
      for (const note of api<any[]>(repo, `check-runs/${job.id}/annotations?per_page=100`)) {
        const message = String(note.message ?? '');
        if (note.annotation_level === 'warning' && parts.some((part) => message.includes(part)))
          said.push(message.replace(/\s+/g, ' ').slice(0, 220));
      }
  } catch {}
  return [...new Set(said)].slice(0, 6);
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
  // Afresh: the folder may hold another run's, from a scan that was replaced or a re-read.
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  delete scan.moves;
  try {
    sh('gh', ['run', 'download', String(scan.id), '-R', repo, '-n', 'moves', '-D', into]);
    const file = JSON.parse(readFileSync(join(into, 'moves.json'), 'utf8'));
    scan.moves = file.moves;
    scan.waiting = file[WAITING_KEY];
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

const cache = new Map<string, { updatedAt: string; pull: Pull; print?: string | undefined }>();
/** What was last read of a pull request of Dependabot's (test 22), by `<repo>#<number>`, until it changes. */
const duplicates = new Map<string, { updatedAt: string; facts: DuplicateFacts }>();
/** Who closed a pull request of Dependabot's, what was said on it, and when it was last opened. */
function duplicateOf(repo: string, listed: any): DuplicateFacts {
  const key = `${repo}#${listed.number}`;
  const kept = duplicates.get(key);
  if (kept && kept.updatedAt === listed.updated_at) return kept.facts;
  const n = listed.number;
  const issue = api<any>(repo, `issues/${n}`);
  const reopened = api<any[]>(repo, `issues/${n}/timeline?per_page=100`)
    .filter((event) => event.event === 'reopened')
    .map((event) => event.created_at as string)
    .sort()
    .at(-1);
  const facts: DuplicateFacts = {
    number: n,
    state: listed.merged_at ? 'merged' : issue.state,
    closedAt: issue.closed_at ?? undefined,
    closedBy: issue.closed_by?.login ?? undefined,
    openedAt: reopened ?? listed.created_at,
    comments: api<any[]>(repo, `issues/${n}/comments?per_page=100`).map((c) => ({
      author: c.user?.login ?? '',
      body: c.body ?? '',
      at: c.created_at,
    })),
  };
  duplicates.set(key, { updatedAt: listed.updated_at, facts });
  return facts;
}
/**
 * What this pass's cheap look said of each pull request the last pass read and may yet change, by `<repo>#<number>`:
 * its print (decide.ts's `printOf`), or undefined where the look cannot stand for a reading. A pull request whose
 * print is what it was when it was last read in full is not read again; any other is. The look comes before the
 * readings, so a change between the two only costs a reading at the next pass, never a stale one kept.
 */
const probed = new Map<string, string | undefined>();
/** Whether the last look failed: every open pull request was then read in full, and the watch waits longer. */
let probeFailed = false;
function probe(repo: string) {
  const numbers = [...cache.entries()]
    .filter(([key, kept]) => key.startsWith(`${repo}#`) && (kept.pull.pending.length > 0 || kept.pull.state === 'open'))
    .map(([key]) => Number(key.slice(repo.length + 1)));
  probed.clear();
  probeFailed = false;
  for (let i = 0; i < numbers.length; i += 30) {
    const some = numbers.slice(i, i + 30);
    try {
      const said = graphql(repo, probeQuery(some)).repository;
      for (const n of some) probed.set(`${repo}#${n}`, printOf(said[`p${n}`], required(repo)));
    } catch {
      probeFailed = true;
    }
  }
}
/** The moves a pin pull request carries: the names its description marks (one pull request for a file's moves), or the one its title names. */
function pinMoves(p: { title: string; body?: string | null }): string[] {
  const mark = /<!-- factory: pin-moves ([A-Za-z0-9%._~!*'()-]*) -->/.exec(p.body ?? '')?.[1];
  if (mark) return JSON.parse(decodeURIComponent(mark)) as string[];
  const named = /^chore\(pin\): move (.+) to \S+/.exec(p.title.replace(/^\[reset\] /, ''))?.[1];
  return named ? [named] : /^chore\(pin\): /.test(p.title.replace(/^\[reset\] /, '')) ? ['?'] : [];
}
/** When the run's scan started: a person's act on a pull request counts as a touch from here on. */
let clockStart = '';
function readPull(repo: string, listed: any): Pull {
  const key = `${repo}#${listed.number}`;
  const kept = cache.get(key);
  if (kept && kept.updatedAt === listed.updated_at && kept.pull.pending.length === 0 && kept.pull.state !== 'open')
    return kept.pull;
  const print = probed.get(key);
  if (kept && print !== undefined && kept.print === print) return kept.pull;
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
    branch: full.head.ref,
    carries: pinMoves(full),
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
  cache.set(key, { updatedAt: listed.updated_at, pull, print });
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
  pods: {
    name: string;
    ready: boolean;
    phase: string;
    images: string[];
    restarts: number;
    waiting: string[];
    deployment?: string | undefined;
  }[];
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
      waiting: statuses.flatMap((s: any) => (s.state?.waiting?.reason ? [s.state.waiting.reason as string] : [])),
      // A Deployment's pod is its ReplicaSet's, named `<deployment>-<hash>`.
      deployment: (pod.metadata.ownerReferences ?? [])
        .filter((owner: any) => owner.kind === 'ReplicaSet')
        .map((owner: any) => `${pod.metadata.namespace}/${String(owner.name).replace(/-[^-]+$/, '')}`)[0],
    };
  });
  return { apps, pods };
}
/** What GitHub said of two commits: one never comes to be before or after another, so each pair is asked once. */
const pasts = new Map<string, boolean>();
/**
 * Asks Argo CD to look at git now, for root and the app, at most twice a minute: it would look within its own two or
 * three minutes anyway, and a refresh reads git and each resource's health again and changes nothing in the cluster.
 */
let refreshedAt = 0;
function refresh() {
  if (Date.now() - refreshedAt < 30_000) return;
  refreshedAt = Date.now();
  try {
    kubectl([
      '-n',
      'argocd',
      'annotate',
      'application',
      'root',
      'website',
      'argocd.argoproj.io/refresh=normal',
      '--overwrite',
    ]);
  } catch {}
}

/** Whether `later` is `commit` or comes after it on main. */
function past(repo: string, commit: string, later?: string): boolean {
  if (!later) return false;
  if (later === commit) return true;
  const key = `${repo} ${commit}...${later}`;
  const known = pasts.get(key);
  if (known !== undefined) return known;
  try {
    const is = ['ahead', 'identical'].includes(api<any>(repo, `compare/${commit}...${later}`).status);
    pasts.set(key, is);
    return is;
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
  !isRoutine(m) &&
  m.lane === 'line' &&
  m.pins.some((p) => p.file !== 'pnpm-lock.yaml') &&
  (m.clears?.CRITICAL ?? 0) > 0 === (test.lockfile === 'critical');

/**
 * For a test whose pull request moves a caller's pins of another repository's workflows (`calls`): why the caller's
 * main, after the merge, does not pin every one at a single commit that is on the called repository's main and after
 * the one pinned before, or '' when it does.
 */
function pinnedFault(test: Test, merged: Pull): string {
  const calls = test.calls;
  if (!calls) return '';
  const at = merged.mergeCommit ?? 'main';
  const read = (ref: string) =>
    Object.fromEntries(
      api<any[]>(test.repo, `contents/.github/workflows?ref=${ref}`)
        .filter((f) => /\.ya?ml$/.test(f.name))
        .map((f) => [
          f.path as string,
          sh('gh', [
            'api',
            `repos/${test.repo}/contents/${f.path}?ref=${ref}`,
            '-H',
            'Accept: application/vnd.github.raw',
          ]),
        ]),
    );
  const after = read(at);
  const to = Object.values(after).flatMap((text) => workflowPins(text, calls.repo))[0]?.commit;
  if (!to) return `no pin of ${calls.repo}'s workflows on main`;
  const fault = pinsFault(after, calls.repo, to, calls.count);
  if (fault) return fault;
  const parent = api<any>(test.repo, `commits/${at}`).parents?.[0]?.sha as string | undefined;
  const was = Object.values(parent ? read(parent) : {}).flatMap((text) => workflowPins(text, calls.repo))[0]?.commit;
  if (!past(calls.repo, to, mainOf(calls.repo))) return `${to.slice(0, 7)} is not on ${calls.repo}'s main`;
  if (!was || was === to || !past(calls.repo, was, to))
    return `${to.slice(0, 7)} is not after ${was?.slice(0, 7) ?? 'nothing'}, the commit pinned before`;
  return '';
}

/** Open code scanning alerts on main whose newest instance is at `path`: every page, the numbers alone. */
function openAlertsAt(repo: string, path: string): number {
  repoOk(repo);
  if (/["\\]/.test(path)) throw new Error('openAlertsAt: a path jq would read');
  const out = sh(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`,
      '--jq',
      `.[] | select(.most_recent_instance.location.path == "${path}") | .number`,
    ],
    { timeout: 600_000 },
  );
  return out.split('\n').filter(Boolean).length;
}

/**
 * For the test of an image the registry will not serve (`unread`): what the run's scan uploaded, each annotation of
 * its jobs that names the image, and the open alerts at the image's file, counted once the scan is in and again at
 * the run's end.
 */
function unreadOf(state: State, test: Test, kept: Seen['unread'], final: boolean): NonNullable<Seen['unread']> {
  const unread = test.unread;
  const scan = state.scan1;
  if (!unread || !scan) return kept ?? { artifacts: [], said: [] };
  const seen = kept ?? { artifacts: [], said: [] };
  if (!kept) {
    seen.artifacts = (api<any>(test.repo, `actions/runs/${scan.id}/artifacts?per_page=100`).artifacts ?? []).map(
      (a: any) => a.name as string,
    );
    for (const job of api<any>(test.repo, `actions/runs/${scan.id}/jobs?per_page=100`).jobs ?? []) {
      for (const note of api<any[]>(test.repo, `check-runs/${job.id}/annotations?per_page=100`))
        if (saysNotPulled(String(note.message ?? ''), unread.image))
          seen.said.push(`${note.annotation_level}: ${String(note.message).slice(0, 200)}`);
    }
    if (unread.alerts) seen.alertsBefore = openAlertsAt(test.repo, unread.file);
  }
  if (final && unread.alerts) seen.alertsAfter = openAlertsAt(test.repo, unread.file);
  return seen;
}

function observe(state: State, tests: Test[], final = false) {
  if (final) cache.clear();
  if (final) duplicates.clear();
  clockStart = state.scan1?.createdAt ?? '';
  const since = state.resetAt ?? state.scan1?.createdAt ?? '';
  const listedOf = new Map<string, any[]>();
  const issuesOf = new Map<string, any[]>();
  let now: Cluster | undefined;
  if (!final) for (const repo of new Set(tests.map((t) => t.repo))) probe(repo);

  for (const test of tests) {
    const seen: Seen = state.seen[test.id] ?? { moves: [], missing: [], pulls: [], issues: [] };
    const all = state.scan1?.moves ?? [];
    seen.moves = [];
    seen.missing = [];
    // Which of a name's moves, and where it stands among them: the pin watch's issues come in the scan's order.
    let nth = 0;
    for (const name of test.moves) {
      // A routine move and a finding's may share a name (a lockfile's names no package): a test stands on one kind.
      const named = all.filter((m) => m.name === name && moveFits(m, test));
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
      } else
        seen.missing.push(
          want ? `${name} (clearing ${JSON.stringify(want)})` : test.routine ? `${name} (a routine update)` : name,
        );
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

    let mine: any[] = [];
    const issues = () => {
      if (!issuesOf.has(test.repo))
        issuesOf.set(test.repo, api<any[]>(test.repo, `issues?state=all&since=${since}&per_page=100`));
      return (issuesOf.get(test.repo) ?? []).filter((i) => !i.pull_request && i.created_at >= since);
    };
    const forgedNumbers = new Set(Object.values(state.forged ?? {}).map((f) => f.number));
    if (test.pr.by === 'none') {
      mine = [];
    } else if (test.pr.by === 'forged') {
      mine = listed.filter((p) => p.number === state.forged?.[test.id]?.number);
    } else if (test.pr.by === 'pin') {
      mine = fresh.filter(
        (p) =>
          p.user.login === APP_BOT &&
          pinMoves(p).some((name) => test.moves.includes(name)) &&
          branchFits(p.head?.ref, test) &&
          !forgedNumbers.has(p.number),
      );
      // In the app's repository no pin watch opens a pull request: any of the App's since that names the move is one.
      if (test.repo === APP)
        mine = fresh.filter((p) => p.user.login === APP_BOT && test.moves.some((name) => p.title.includes(name)));
      const found = issues().filter((i) => test.moves.some((name) => issueOfMove(i.title, name)));
      seen.issues = found.map((i) => i.number);
      const says = test.says;
      if (says) seen.issueSays = found.every((i) => i.user?.login === APP_BOT && says.test(i.body ?? ''));
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
          (p) =>
            p.user.login === APP_BOT &&
            !/^chore\((deploy|main)\)/.test(p.title) &&
            branchFits(p.head?.ref, test) &&
            !forgedNumbers.has(p.number),
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
    // Its timeline too while it is red with nothing running: whether the App has said its head is out of runs.
    const stuck = one?.state === 'open' && one.red.length > 0 && one.pending.length === 0 && !test.mustNot;
    if (one && (test.checksRun || test.queueRuns || stuck)) seen.timeline = timelineOf(test.repo, one.number);
    if (one && test.removes) seen.removed = removedOf(test.repo, one.number, test.removes.file, test.removes.lines);
    if (one && test.keeps) seen.kept = removedOf(test.repo, one.number, test.keeps.file, test.keeps.lines);
    if (test.refused) {
      const all = issues().map((i) => ({
        number: i.number,
        author: i.user?.login ?? '',
        title: i.title,
        body: i.body ?? '',
      }));
      const read = issueFault(all, APP_BOT, { ...test.refused, kinds: REFUSAL_KINDS });
      const body = all.find((i) => i.number === read.number)?.body;
      // One read before stays read: the issue is closed once the move is made, and deleted at the next reset.
      if (read.number !== undefined || !seen.refusal?.number) seen.refusal = { ...read, ...(body ? { body } : {}) };
    }
    if (test.beside) {
      const title = test.beside;
      const [newest] = listed
        .filter((p) => p.user.login === 'dependabot[bot]' && title.test(p.title))
        .filter((p) => p.state === 'open' || p.closed_at >= since)
        .sort((a, b) => b.number - a.number);
      seen.besideOf = newest ? duplicateOf(test.repo, newest) : undefined;
    }
    if (test.duplicate) {
      const leaves = test.duplicate.leaves;
      // The newest of its pull requests: an open one, or the one this run saw closed.
      const newest = [...mine].sort((a, b) => b.number - a.number);
      const own = newest.find((p) => p.state === 'open') ?? newest[0];
      seen.duplicate = own ? duplicateOf(test.repo, own) : undefined;
      // What each diff adds, read once the App's move has merged: the same lines, or main never has Dependabot's.
      const merged = state.seen[test.duplicate.of]?.pulls.find((p) => p.mergedAt);
      const added = (n: number) =>
        api<any[]>(test.repo, `pulls/${n}/files?per_page=100`).flatMap((f) =>
          String(f.patch ?? '')
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
            .map((line) => line.slice(1).trim())
            .filter(Boolean),
        );
      if (own && merged && !seen.duplicateLines)
        seen.duplicateLines = { theirs: added(own.number), ours: added(merged.number) };
      seen.leftAlone = listed
        .filter((p) => p.user.login === 'dependabot[bot]' && leaves.test(p.title))
        .filter((p) => p.state === 'open' || p.closed_at >= since)
        .map((p) => duplicateOf(test.repo, p));
    }

    const merged = seen.pulls.length === 1 && seen.pulls[0]?.mergedAt ? seen.pulls[0] : undefined;
    if (merged && !seen.deployedAt) {
      if (!final && test.deployed.kind !== 'none') refresh();
      now ??= cluster();
      seen.notDeployed = notDeployed(test, seen, merged, now, listed);
      if (!seen.notDeployed) seen.deployedAt = new Date().toISOString();
    }
    if (test.issue)
      seen.issuedAt =
        seen.issues.length && !seen.pulls.length ? (seen.issuedAt ?? new Date().toISOString()) : undefined;
    // The caller's pins after the merge (test 20): each of its workflow files on main, read once.
    if (merged && test.calls && seen.pinned === undefined) seen.pinned = pinnedFault(test, merged);
    if (test.unread && state.scan1?.conclusion) seen.unread = unreadOf(state, test, seen.unread, final);
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
/** The GitHub worker's log since the run restarted it (or since the reset). */
function workerLog(state: State): string {
  const since = state.kickedAt ?? state.resetAt;
  if (!since) return '';
  try {
    return kubectl(['-n', 'factory', 'logs', 'deployment/github', `--since-time=${since}`], 300_000);
  } catch {
    return '';
  }
}
function workerWaits(text: string): Map<string, string> {
  const waits = new Map<string, string>();
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
 * the gate to judge anew, and the worker's last word at that head to be the one that ends its pass for good: for a
 * head the gate held, `verdict` (a rule no level queues); for one it passed (`major`, `move`), `level`, which the worker
 * says only once the verdict, the checks and mergeability are through, the last step before it would queue. The
 * worker also says `verdict` while the gate judges again, so that alone decides nothing for a head the gate passed.
 * With no pull request yet one may still open: not decided.
 */
function decidedHeld(state: State, test: Test, waits: Map<string, string>): boolean {
  const pulls = state.seen[test.id]?.pulls ?? [];
  // A forgery GitHub refused at the push has no pull request, and nothing left to wait for.
  if (state.forged?.[test.id]?.refused || state.forged?.[test.id]?.landed) return verdict(state, test).pass;
  if (!pulls.length || !verdict(state, test).pass) return false;
  return pulls.every((p) => holdDecided(p, waits.get(`${p.number} ${p.head}`), test.pr.by === 'forged'));
}

const podRestarts = () => Object.fromEntries(cluster().pods.map((pod) => [pod.name, pod.restarts]));
/**
 * Before the one look at the cluster: the rollouts in flight are given five minutes to settle (decide.ts's
 * `startingPods`). A deploy that merged as the watch ended is still starting its pods a minute later; a pod that is
 * not Ready when the wait is over is unhealthy in the look that follows, as any is.
 */
function settle(state: State) {
  const until = Date.now() + 5 * 60_000;
  let said = '';
  for (;;) {
    const progressing = JSON.parse(kubectl(['get', 'deployments', '-A', '-o', 'json']))
      .items.filter((d: any) => rolloutProgressing(d.status?.conditions ?? []))
      .map((d: any) => `${d.metadata.namespace}/${d.metadata.name}`);
    const starting = startingPods(cluster().pods, progressing);
    if (!starting.length) {
      if (said) say(state, 'the rollouts in flight have settled');
      return;
    }
    if (Date.now() >= until) {
      say(state, `still starting after five minutes, and judged as they stand: ${starting.join(', ')}`);
      return;
    }
    if (said !== starting.join(', ')) say(state, `waiting for pods of a rollout in flight: ${starting.join(', ')}`);
    said = starting.join(', ');
    sleep(10_000);
  }
}
function clean(state: State): NonNullable<State['clean']> {
  const since = state.scan1?.createdAt ?? state.resetAt ?? new Date().toISOString();
  const now = cluster();
  const { errors, errorAt } = errorLines(state, now, since);
  const unhealthy = now.pods
    .filter((p) => !['Succeeded'].includes(p.phase) && !(p.phase === 'Running' && p.ready))
    .filter((p) => !(p.phase === 'Failed' && state.failed0?.includes(p.name)))
    .map((p) => `${p.name} ${p.phase}`);
  const restarted = now.pods
    .filter((p) => state.pods0 && p.name in state.pods0 && p.restarts > (state.pods0[p.name] ?? 0))
    .map((p) => `${p.name} +${p.restarts - (state.pods0?.[p.name] ?? 0)}`);
  return { errors, unhealthy, restarted, errorAt };
}
/** Each factory worker's error lines since a time, a line a pod, and when each was logged; its log is kept with the run. */
function errorLines(state: State, now: Cluster, since: string): { errors: string[]; errorAt: string[] } {
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
  return { errors, errorAt };
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

/**
 * A move whose required check fails every time (W1b): its head written again `runs - 1` times, then one
 * comment naming the last head, which stays: never merged, nobody touching it, and nothing after for nine of the worker's passes (`settleMs`).
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
  if (end - Date.parse(comment.at) < settleMs(state.workerPollS))
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
  if (test.keeps) {
    const gone = test.keeps.lines.filter((_, i) => !['kept', 'not in the diff'].includes(seen.kept?.[i] ?? ''));
    if (gone.length)
      return `${tag} does not leave ${gone.map((l) => l.trim()).join(', ')} in ${test.keeps.file} (${seen.kept?.join(', ') ?? 'not read'})`;
  }
  if (test.refused && (!seen.refusal || seen.refusal.fault))
    return `${tag} merged without it, but ${seen.refusal?.fault ?? 'its issue was not looked for'}`;
  if (test.then) {
    const then = state.then;
    if (!then) return `no ticket for ${test.then.dependency} to take after ${tag}`;
    const fault = ticketFault(then, test.then, APP_BOT);
    if (fault) return fault;
  }
  if (test.newer) {
    const later = state.later ?? {};
    const fault = newerFault({
      number: pull.number,
      first: test.newer.first,
      later: test.newer.later,
      name: test.newer.package,
      issueAtOpen: later.issueAtOpen,
      issueNow: later.issueNow,
      headAtOpen: later.headAtOpen,
      headNow: pull.head,
      mergedAt: pull.mergedAt,
      toldAt: later.toldAt,
      adds: later.adds ?? [],
    });
    if (fault) return fault;
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
    test.beside ? besideWords(seen.besideOf, APP_BOT, seen.pulls[0]?.mergedAt) : '',
    test.refused && seen.refusal?.number
      ? `issue #${seen.refusal.number} says why the refused one waits (${seen.refusal.kind})`
      : '',
    test.newer && state.later?.issue
      ? `it and issue #${state.later.issue} took ${test.newer.later} in place of ${test.newer.first}`
      : '',
  ].filter(Boolean);
  return words.length ? `, ${words.join(', ')}` : '';
}

/**
 * Whether a test read from the scan and GitHub alone (an issue for Martin, the unread image) passes as things stand,
 * its end-of-run count aside.
 */
function verdictSoFar(state: State, test: Test): boolean {
  if (test.issue) return verdict(state, test).pass;
  const seen = state.seen[test.id]?.unread;
  if (!test.unread || !seen) return false;
  return verdict(
    {
      ...state,
      seen: {
        ...state.seen,
        [test.id]: { ...state.seen[test.id], unread: { ...seen, alertsAfter: seen.alertsBefore ?? 0 } } as Seen,
      },
    },
    test,
  ).pass;
}

/** Whether a test stands on a move of the scan's, which the next scan must stop listing. */
const standsOnMove = (test: Test) => test.moves.length > 0 || Boolean(test.lockfile);

/**
 * The scan with one image the registry will not serve (test 19): its run says so by name and ends red, yet leaves
 * `moves.json` and the state, a move of it merges, and no alert at the image's file closes.
 */
function unreadVerdict(state: State, test: Test): { pass: boolean; why: string } {
  const fail = (why: string) => ({ pass: false, why });
  const seen = state.seen[test.id]?.unread;
  const scan = state.scan1;
  if (!scan?.conclusion || !seen) return fail('the scan has not finished');
  if (!scan.moves) return fail(`scan ${scan.id} left no moves.json: one image cost the whole run`);
  if (!seen.artifacts.includes('state')) return fail(`scan ${scan.id} kept no state`);
  if (scan.conclusion !== 'failure') return fail(`scan ${scan.id} ended ${scan.conclusion}, not red`);
  if (!seen.said.length) return fail(`scan ${scan.id} names ${test.unread?.image} in no annotation`);
  const others = TESTS.filter((t) => inRun(state, t) && t !== test && !t.mustNot && !t.issue && standsOnMove(t));
  const merged = others.filter((t) => state.seen[t.id]?.pulls.some((p) => p.mergedAt));
  if (!merged.length) return fail(`scan ${scan.id} said so and listed ${scan.moves.length} moves; none has merged`);
  const so = `scan ${scan.id} red, ${seen.said[0]?.slice(0, 90)}; ${scan.moves.length} moves listed, ${merged.length} of this run's merged`;
  // An image the scan has never read has no alert to close; one it read before (`alerts`) is counted before and after.
  if (!test.unread?.alerts) return { pass: true, why: `${so}; the image was never read, so it has no alert to close` };
  if (seen.alertsAfter === undefined) return fail('its alerts have not been counted at the end');
  if (seen.alertsAfter < (seen.alertsBefore ?? 0))
    return fail(`${(seen.alertsBefore ?? 0) - seen.alertsAfter} alerts at ${test.unread?.file} closed`);
  return { pass: true, why: `${so}; ${seen.alertsAfter} alerts open at its file, ${seen.alertsBefore ?? 0} before` };
}

/** The mark of a line that is neither a pass nor a failure: what the staging can show, seen, and the rest said. */
const TO_THE_GATES = 'SEEN TO THE GATES';
function verdict(state: State, test: Test): { pass: boolean; why: string; mark?: string } {
  const seen = state.seen[test.id];
  const fail = (why: string) => ({ pass: false, why });
  const dropped = state.dropped?.[test.id];
  if (dropped) return fail(`pre-flight, no verdict: ${dropped}`.slice(0, 520));
  if (test.restart)
    return state.restart ? restartVerdict(state.restart) : fail('the store was not restarted under a report');
  if (test.waits) {
    const move = test.waits.move;
    const [first, second] = [state.scan0, state.scan1];
    // Every pull request of the App's this run read that carries the move, opened before the scan the run stands on.
    const early = Object.values(state.seen)
      .flatMap((each) => each?.pulls ?? [])
      .filter((p) => second && p.carries?.includes(move) && Date.parse(p.createdAt) < Date.parse(second.createdAt))
      .map((p) => p.number);
    return waitedVerdict({
      move,
      first: first?.moves ? { id: first.id, shown: shownAs(fileOf(first), move) } : undefined,
      second: second?.moves ? { id: second.id, listed: shownAs(fileOf(second), move) === 'listed' } : undefined,
      early: [...new Set(early)],
    });
  }
  if (test.reverted) {
    const of = state.seen[test.reverted.of];
    const merged = of?.pulls.length === 1 && of.pulls[0]?.mergedAt ? of.pulls[0] : undefined;
    const done = state.reverted;
    return revertedVerdict({
      of: test.reverted.of,
      move: of?.moves[0],
      merged: merged?.number,
      revert: done?.commit,
      scan: state.scan3 && done?.scannedAt ? { id: state.scan3.id, moves: state.scan3.moves } : undefined,
      pulls: done?.pulls ?? [],
      issues: done?.issues ?? [],
      app: APP_BOT,
      read: done?.read,
      watchedUntil: done?.watchedUntil,
      settleMs: revertSettleMs(state.workerPollS),
    });
  }
  if (test.asksChanges) {
    const pulls = seen?.pulls ?? [];
    const [pull] = pulls;
    return changesVerdict({
      pulls,
      review: state.review,
      says: test.heldFor ?? /$^/,
      // The worker's word is read in the watch, which keeps the first head the hold was decided at.
      decided: false,
      heldAt: pull && seen?.heldAt,
    });
  }
  if (test.duplicate) {
    const of = state.seen[test.duplicate.of]?.pulls.find((p) => p.mergedAt);
    const closed = duplicateVerdict({
      pull: seen?.duplicate,
      app: APP_BOT,
      merge: of && { number: of.number, commit: of.mergeCommit ?? '', at: of.mergedAt ?? '' },
      lines: seen?.duplicateLines,
    });
    if (!closed.pass) return { pass: false, why: closed.why.slice(0, 520) };
    const left = leftAloneFault(seen?.leftAlone ?? [], APP_BOT);
    if (left) return fail(`${closed.why}; but ${left}`.slice(0, 420));
    const others = (seen?.leftAlone ?? []).map((p) => `#${p.number} ${p.state}`).join(', ');
    return { pass: true, why: `${closed.why}; ${others}, whose lines main lacks, left alone` };
  }
  if (test.made) {
    if (!state.scan1?.moves) return fail('the scan left no moves');
    if (!seen) return fail('not observed');
    if (seen.missing.length) return fail(`the scan made no move of ${seen.missing.join(', ')}`);
    if (!state.made) return fail('the move was not put on main');
    if (seen.pulls.length)
      return fail(`the line opened #${seen.pulls.map((p) => p.number).join(', #')} for a move main already has`);
    if (state.line?.strays.length)
      return fail(`the run is spoiled: the line worked ${state.line.strays.join(', ')} too`);
    const fault = ticketFault(state.made.ticket, test.made, APP_BOT);
    if (fault) return fail(fault);
    const ticket = state.made.ticket;
    const dirt = state.clean;
    if (dirt && dirt.errors.length + dirt.unhealthy.length + dirt.restarted.length)
      return fail(`#${ticket.workItem} closed ${ticket.closed?.outcome}; not clean (see the run's last lines)`);
    return {
      pass: true,
      why: `#${ticket.workItem} closed ${ticket.closed?.outcome} (${ticket.closed?.reason}), issue #${ticket.issue?.number} completed, no pull request`.slice(
        0,
        420,
      ),
    };
  }
  if (test.checksRun?.spent) return spentVerdict(state, test, test.checksRun.runs);
  // A major is held at Guarded, the level the scratch line is set to, and merges only in a run told --lights-out.
  if (test.mustNot || (test.major && !state.flags.includes('--lights-out'))) {
    if (!seen) return fail('not observed');
    if (test.pr.by === 'forged') {
      // A forgery passes only when the gate itself held the forged commit: a queue that never took it proves nothing.
      const made = state.forged?.[test.id];
      const pull = seen.pulls[0];
      // A forgery of a workflow file is the App's push, which GitHub itself refuses for want of the permission: the
      // refusal, in GitHub's words, is the pass. Had the push landed, the gate's hold is judged below as any other's.
      if (made?.refused)
        return test.refusedPush?.test(made.refused)
          ? { pass: true, why: `GitHub refused the App's push: ${made.refused}`.slice(0, 420) }
          : fail(`the forge's push was refused, but not as this test expects: ${made.refused}`.slice(0, 420));
      if (made?.landed) return fail(`GitHub did not refuse it: ${made.landed}`.slice(0, 420));
      if (!made || !pull) return fail('not forged');
      if (pull.mergedAt) return fail(`#${pull.number} merged at ${clock(state, pull.mergedAt)}, and must not`);
      if (pull.head !== made.head)
        return fail(`#${pull.number} is no longer at the forged commit ${(made.head ?? '').slice(0, 7)}`);
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
    // A major the level holds is one the gate passed as a major: held by the gate for anything else, it proves nothing.
    const expected = test.rule ?? 'major';
    // A hold decided at an earlier head stands unless it is broken: what a later head still waits for undoes nothing.
    const heldAt = seen.heldAt;
    if (heldAt && seen.pulls.length) {
      const broken = holdBroken(seen.pulls, test.major ? expected : undefined);
      if (broken) return fail(broken);
      return {
        pass: true,
        why: seen.pulls
          .map(
            (p) =>
              `#${p.number} not merged: its hold was decided at ${heldAt.head.slice(0, 7)}, ${clock(state, heldAt.at)}; now ${where(p)}`,
          )
          .join('; ')
          .slice(0, 420),
      };
    }
    const misjudged =
      test.major && seen.pulls.find((p) => p.state === 'open' && p.rule !== undefined && p.rule !== expected);
    if (misjudged)
      return fail(`#${misjudged.number}: the gate's rule is ${misjudged.rule}, not ${expected}: ${where(misjudged)}`);
    // Queued is what a held move must never be: unmerged yet, it is no pass.
    const queued = queuedFault(seen.pulls);
    if (queued) return fail(queued);
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
  if (test.unread) return unreadVerdict(state, test);
  if (!state.scan1?.moves) return fail('the scan left no moves');
  if (!seen) return fail('not observed');
  if (seen.missing.length) return fail(`the scan made no move of ${seen.missing.join(', ')}`);
  const lanes = [...new Set(seen.moves.map((m) => m.lane))].join(', ');
  if (test.issue) {
    // A move that is Martin's to make: an issue, and no pull request of the App's, whatever the level.
    const lane = test.lane ?? 'issue';
    if (lanes !== lane) return fail(`the scan's lane for it is ${lanes}, not ${lane}`);
    if (seen.pulls.length)
      return fail(`the App opened #${seen.pulls.map((p) => p.number).join(', #')} for it, and must open none`);
    if (!seen.issues.length) return fail('no issue for it, and no pull request');
    if (test.says && !seen.issueSays)
      return fail(`issue #${seen.issues.join(', #')} is not the App's, or does not say ${test.says.source}`);
    return { pass: true, why: `issue #${seen.issues.join(', #')}, and no pull request of the App's` };
  }
  if (test.noIssue && seen.issues.length)
    return fail(`issue #${seen.issues.join(', #')} for it: the move is the App's to write, not Martin's`);
  // A move that must stay within its pin's major (test 2): a major named by the first scan fails it before any wait.
  const within = test.thenMajor ? seen.moves[0] : undefined;
  if (within?.major) return fail(majorNextFault(within, []) ?? '');
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
  // A later target with advisories of its own (21's staging) ends at the scan's gates, with the line's part done.
  if (test.newer?.gates && !pull.mergedAt) {
    const later = state.later ?? {};
    const seenSoFar = seenToTheGates({
      number: pull.number,
      first: test.newer.first,
      later: test.newer.later,
      name: test.newer.package,
      issueAtOpen: later.issueAtOpen,
      issueNow: later.issueNow,
      headAtOpen: later.headAtOpen,
      headNow: pull.head,
      mergedAt: pull.mergedAt,
      toldAt: later.toldAt,
      adds: later.adds ?? [],
      state: pull.state,
      red: pull.red,
      pending: pull.pending,
      touched: pull.touched,
      gates: test.newer.gates,
    });
    if (seenSoFar)
      return { pass: false, mark: TO_THE_GATES, why: `${tag}, issue #${later.issue ?? '?'}: ${seenSoFar}` };
  }
  if (state.line?.stalled && !pull.mergedAt)
    return fail(`${tag} stuck on the line: ${state.line.stalled}`.slice(0, 420));
  if (state.line?.held && !pull.mergedAt) return fail(`${tag} held on the line: ${state.line.held}`.slice(0, 420));
  if (test.pr.by === 'pin') {
    const pins = new Set(seen.moves.flatMap((m) => m.pins.map((p) => p.file)));
    const extra = pull.files.filter((f) => !pins.has(f) && !(test.brings ?? []).some((b) => b.test(f)));
    const left = [...pins].filter((f) => !pull.files.includes(f));
    if (extra.length) return fail(`${tag} changes more than its pins: ${extra.join(', ')}`);
    if (left.length) return fail(`${tag} leaves pins behind: ${left.join(', ')}`);
    // A routine update rides apart from the moves a finding asks for: on a pin branch, carrying routine moves alone.
    if (test.routine) {
      if (!routineBranch(pull.branch)) return fail(`${tag} is on ${pull.branch}, not a branch of routine updates`);
      const found = (pull.carries ?? []).filter((name) =>
        (state.scan1?.moves ?? []).some((m) => m.name === name && !isRoutine(m)),
      );
      // A lockfile's moves share one public name, routine or not, so the names cannot say for them.
      const told = found.filter((name) => !name.startsWith('a package in '));
      if (told.length) return fail(`${tag} carries a finding's move too: ${told.join(', ')}`);
    }
  }
  if (!pull.mergedAt) return fail(`${tag} ${where(pull)}`.slice(0, 420));
  if (pull.touched.length)
    return fail(`${tag} merged at ${clock(state, pull.mergedAt)}, touched: ${pull.touched.join('; ')}`);
  const fault = recoveryFault(state, test, seen, pull);
  if (fault) return fail(fault);
  if (test.calls && seen.pinned) return fail(`${tag} merged at ${clock(state, pull.mergedAt)}; ${seen.pinned}`);
  if (test.queuedBy === 'app' && pull.queuedBy !== APP_BOT)
    return fail(`${tag} queued by ${pull.queuedBy ?? 'nobody'}, not the worker`);
  if (!seen.deployedAt)
    return fail(`${tag} merged at ${clock(state, pull.mergedAt)}, not deployed: ${seen.notDeployed}`);
  const took = (Date.parse(seen.deployedAt) - Date.parse(state.scan1.createdAt)) / 60_000;
  const so = `${tag} merged ${clock(state, pull.mergedAt)}, deployed ${clock(state, seen.deployedAt)}`;
  if (took > state.limitMin) return fail(`${so}, past the limit of ${state.limitMin} min`);
  // A test that stands on no move of the scan's (test 20) has nothing for the next scan to stop listing.
  const scanned = standsOnMove(test);
  if (scanned && !state.scan2?.moves) return fail(`${so}; the next scan has not run`);
  // The test's own kind of move: a routine update and a finding's move may share a name, and each test is one kind.
  const mine = (m: Move) => (test.lockfile ? appLockfile(m, test) : test.moves.includes(m.name) && moveFits(m, test));
  // Still there is a move of the first scan's: one of its name from another version is the next move of that pin.
  const listed = (state.scan1.moves ?? []).filter(mine);
  const before = listed.length;
  const after = stillListed(listed, (state.scan2?.moves ?? []).filter(mine)).length;
  // Moves that share a name (a lockfile's names no package) are told apart by what they clear, or, routine, counted.
  const shared = test.clears !== undefined || (test.routine && test.moves.some((n) => n.startsWith('a package in ')));
  if (after > 0 && !(shared && after < before))
    return fail(`${so}; the next scan still ${test.routine ? 'lists' : 'reports'} it`);
  // The major it leaves for another day: listed by a scan after the merge, as a move of its own.
  let then = '';
  if (within) {
    const later = [state.scan2, state.scan3].filter((scan): scan is Scan => Boolean(scan?.moves)).map(fileOf);
    const fault = majorNextFault(within, later);
    if (fault) return fail(`${so}; ${fault}`.slice(0, 520));
    // Either is the scan's own word, after the merge: the major as a move, or its pin said to wait for its content.
    const by = majorNext(within, later);
    if (!by) return fail(`${so}; no scan after the merge was read for its major`);
    then = by.listed
      ? `, its major listed after as a move of its own (scan ${by.scan})`
      : `, its major said by scan ${by.scan} to wait for its content's day`;
  }
  const ended = !scanned ? 'merged' : test.routine ? 'no longer listed' : 'cleared';
  const dirt = state.clean;
  // An error logged before the move's pull request opened is not the move's; one with no time counts against all.
  const errors = dirt?.errorAt
    ? dirt.errorAt.filter((at) => !at || at >= pull.createdAt).length
    : (dirt?.errors.length ?? 0);
  if (dirt && errors + dirt.unhealthy.length + dirt.restarted.length)
    return fail(`${so}, ${ended}; not clean (see the run's last lines)`);
  return { pass: true, why: `${so}, ${ended}${then}${recoveryWords(state, test, seen)}, nobody touched it` };
}

/**
 * How long the worker is watched after the first sign that its pin watch read the scan that lists a reverted move
 * again (test 27): five of its polls, and four minutes at least. The watch writes a scan's pull requests and issues in
 * the one pass that reads it, so this is room for that pass to end, not a count of passes that might each open one.
 */
const revertSettleMs = (workerPollS: number | undefined) =>
  Math.max(4 * 60_000, 5 * (workerPollS && workerPollS > 0 ? workerPollS : 60) * 1000);

function report(state: State) {
  const t0 = state.scan1?.createdAt;
  console.log(
    `\nrun ${state.id}  ${state.done ? 'finished' : 'not finished'}  limit ${state.limitMin} min${state.workItem ? `  work item #${state.workItem}` : ''}`,
  );
  console.log(
    `scan ${state.scan1?.id ?? '-'} at ${t0 ?? '-'} (${state.scan1?.conclusion ?? 'running'}); next scan ${state.scan2?.id ?? 'not run'}\n`,
  );
  for (const test of TESTS.filter((t) => inRun(state, t))) {
    const { pass, why, mark: other } = verdict(state, test);
    const mark = other ?? (state.dropped?.[test.id] ? 'NOT RUN ' : pass ? 'PASS    ' : 'FAIL    ');
    console.log(`${test.id.padEnd(3)} ${mark} ${test.title.padEnd(46)} ${why}`);
  }
  if (state.line?.events.length) console.log(`\nthe work item's events: ${state.line.events.join(' ')}`);
  if (state.line?.dequeued?.length)
    console.log(
      `the merge queue took it out: ${state.line.dequeued.map((d) => `${d.reason} at ${d.commit.slice(0, 7)} ${d.failed}`).join('; ')}`,
    );
  if (state.scan0)
    console.log(
      `the first scan after the reset, with no state: ${state.scan0.id} (${state.scan0.conclusion}), ${state.scan0.moves?.length ?? 'no'} moves; the run stands on ${state.scan1?.id}, which read its state`,
    );
  if (state.review)
    console.log(
      `the review: changes asked on #${state.review.number} at ${state.review.head.slice(0, 7)}, ${state.review.at}, while ${state.review.pending.join(', ') || 'no required check'} still ran`,
    );
  if (state.reverted)
    console.log(
      `the revert: ${state.reverted.merge.slice(0, 7)} put back at ${state.reverted.commit?.slice(0, 7) ?? 'no commit'} (${state.reverted.at ?? 'never'}); scan ${state.scan3?.id ?? 'none'} after it; the worker restarted ${state.reverted.restartedAt ?? 'never'}; the pin watch read ${state.reverted.read ? `scan ${state.reverted.read.run} at ${state.reverted.read.at}` : 'no scan since, by its log'}; watched until ${state.reverted.watchedUntil ?? 'never'}`,
    );
  if (state.made) console.log(`the move on main: ${state.made.said} (${state.made.at})`);
  if (state.later)
    console.log(
      `the target moved on: issue #${state.later.issue ?? '?'}, head ${state.later.headAtOpen?.slice(0, 7) ?? '?'} when it opened; lifted ${state.later.liftedAt ?? 'never'}, scan ${state.later.scan ?? 'none'}, given to the line ${state.later.toldAt ?? 'never'}; the pull request adds ${state.later.adds?.map((l) => l.trim()).join(', ') || 'no copy'}`,
    );
  if (state.restart) {
    const r = state.restart;
    console.log(
      `the report: left at ${r.at}, answered ${r.posted}; the store away ${r.awayS ?? '?'} s, ${r.restarted ? 'and back' : 'and not back'}; the log watcher ${r.watcher?.away ? 'warned' : 'gave no warning'}${r.watcher?.back ? ' and reached it again' : ''}; in the inbox ${r.inbox} time${r.inbox === 1 ? '' : 's'}${r.arrivedS === undefined ? '' : `, after ${r.arrivedS} s`}`,
    );
    for (const line of r.errors) console.log(`  error lines  ${line}`);
    for (const line of r.unhealthy) console.log(`  unhealthy    ${line}`);
  }
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
      const { pass, why, mark: other } = verdict(run, test);
      const mark = other ?? (run.dropped?.[test.id] ? 'NOT RUN ' : pass ? 'PASS    ' : 'FAIL    ');
      console.log(`${id} ${mark} ${title} ${why}  [${run.id}]`);
    }
  }
}

// ── The campaign ────────────────────────────────────────────────────────────────────────────────────────────────────

function run(state: State) {
  // The run's tests; one the pre-flight drops (its pull request of Dependabot's could not be had) is taken out there.
  const tests = TESTS.filter((t) => inRun(state, t) && !state.dropped?.[t.id]);
  const only = state.test ? tests.find((t) => t.id === state.test) : undefined;
  if (state.campaign === 'app' && !only) throw new Error(`no app test ${state.test}`);
  const repo = state.campaign === 'app' ? APP : FACTORY;
  const reset =
    state.campaign === 'app' ? ['reset', 'app', ...(only?.dependency ? ['--store'] : [])] : ['reset', 'factory'];
  const has = (flag: string) => state.flags.includes(flag);
  if (!kubectl(['config', 'get-contexts', '-o', 'name']).split('\n').includes(CONTEXT))
    throw new Error(`no kube context ${CONTEXT}`);

  // A test of Dependabot's pull request for a pin the App moves is judged against that move's merge.
  for (const test of tests.filter((t) => t.duplicate)) {
    const of = test.duplicate?.of ?? '';
    if (!tests.some((t) => t.id === of)) throw new Error(`${test.id} stands on test ${of}'s merge: run them together`);
  }
  // A move put back on main is another test's, merged in this run.
  for (const test of tests.filter((t) => t.reverted)) {
    const of = test.reverted?.of ?? '';
    if (!tests.some((t) => t.id === of)) throw new Error(`${test.id} puts back test ${of}'s move: run them together`);
  }
  // Martin asks for changes on a move another test wants merged: never beside it.
  for (const test of tests.filter((t) => t.asksChanges)) {
    const beside = tests.filter((t) => t !== test && t.moves.some((m) => test.moves.includes(m)));
    if (beside.length)
      throw new Error(`${test.id} holds its move's pull request: run it without ${beside.map((t) => t.id).join(', ')}`);
  }
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

  // Whether this process reset the app copy, so the release in flight on its main is the baseline's (preflight).
  let appJustReset = false;
  if (!state.resetAt && !has('--no-reset')) {
    say(state, `reset: ./copies.sh ${reset.join(' ')}`);
    const startedAt = new Date().toISOString();
    const before = mainOf(repo);
    // A run with a test of Dependabot's own pull request for a pin the App moves (22) resets with the worker stopped,
    // and looks for that pull request, which a reset keeps. Only with none open does it summon Dependabot on the
    // factory copy, as the last of its reset: one commit on main past the baseline, whose push is then the reset's
    // own. The scan of that push is the one the run stands on and its clock starts at, as below; the baseline's own
    // push's scan, a minute older and of the same pins, may be replaced by it. The worker starts on the main it leaves.
    const duplicate = state.campaign === 'factory' ? tests.find((t) => t.duplicate) : undefined;
    // A factory run's reset starts the worker with the pin watch told no move: the first scan after a reset has no
    // state, so it lists no image or chart whose content it first saw that day, and the worker would open the batch's
    // other moves from it and the rest from the next. The run gives the watch the batch's once its scan is in.
    const hold: Record<string, string> = state.campaign === 'factory' ? { PIN_WATCH_HOLD: '1' } : {};
    let out = sh(join(BIN, 'copies.sh'), reset, {
      cwd: BIN,
      timeout: 30 * 60_000,
      env: { ...hold, ...(duplicate ? { KEEP_WORKER_DOWN: '1' } : {}) },
    });
    if (state.campaign === 'factory') state.held = { at: new Date().toISOString() };
    if (duplicate) {
      const title = duplicate.pr.by === 'dependabot' ? duplicate.pr.title : /$^/;
      const open = api<any[]>(repo, 'pulls?state=open&per_page=100').filter(
        (p) => p.user.login === 'dependabot[bot]' && title.test(p.title),
      );
      if (open.length) say(state, `Dependabot's #${open[0].number} is open for test ${duplicate.id}: no summon`);
      else {
        out += sh(join(BIN, 'copies.sh'), ['summon-dependabot', 'factory'], { cwd: BIN, timeout: 10 * 60_000 });
        state.summonedAt = new Date().toISOString();
        say(state, `no pull request of Dependabot's is open for test ${duplicate.id}: summoned it on the factory copy`);
      }
      out += sh(join(BIN, 'copies.sh'), ['worker', '1'], { cwd: BIN, timeout: 10 * 60_000, env: hold });
    }
    writeFileSync(join(dirOf(state.id), 'reset.log'), out);
    state.resetAt = new Date().toISOString();
    state.reset = { startedAt, before, after: mainOf(repo) };
    appJustReset = reset.includes('app');
    save(state);
  }
  // An app test's ticket is restored with the store, and the line's look as it takes a ticket, or after a release,
  // reads the app's newest scan: the first after a reset has no state and lists no image's move, so its findings are
  // in no move and the look would close the ticket as cleared. The line therefore stays stopped from the restore
  // until the scan the run stands on is in, when the run starts it (below); a store saved with it running is stopped.
  if (only?.dependency && !state.scan1 && !state.startedAt) {
    const early = lineTooEarly(
      store("select type from events where type in ('line.started', 'line.stopped') order by seq desc limit 1")[0]?.[0],
    );
    if (early) {
      say(state, `${early}: ${make(['stop-the-line', 'REASON=a patching test waits for its scan']).trim()}`);
    }
  }
  if (!state.scan1) issueWatch(state, tests);
  if (!state.scan1) preflight(state, appJustReset);
  for (const id of Object.keys(state.dropped ?? {})) {
    const at = tests.findIndex((t) => t.id === id);
    if (at >= 0) tests.splice(at, 1);
  }
  if (!state.scan1 && state.resetAt && !has('--no-reset') && !has('--no-scan')) {
    // The push of the reset's commit started a scan of its own, and the worker opens its pull requests from it: the
    // run stands on that one, and its clock starts there. Its commit and its time are the reset's own, recorded as it
    // ran: main may have moved since (the pre-flight takes minutes, and the worker merges). From two minutes before
    // the reset began, as the push is among its first acts, for any skew between the Mac's clock and GitHub's; a
    // shared baseline's earlier pushes of the same commit are older than that.
    const reset = state.reset;
    if (!reset) {
      say(
        state,
        "no scan of the reset's push to stand on: this run's state does not record main's commit at its reset; the run dispatches one",
      );
    } else if (reset.before === reset.after) {
      say(
        state,
        `the reset found main at the baseline, ${reset.after.slice(0, 7)}, and pushed nothing, so no scan started: the run dispatches one`,
      );
    } else {
      const since = new Date(Date.parse(reset.startedAt) - 120_000).toISOString().replace(/\.\d+Z$/, 'Z');
      const scan = pushScan(repo, reset.after, since);
      if (scan) {
        state.scan1 = scan;
        say(
          state,
          `scan ${scan.id}, started ${scan.createdAt}: the reset's push of main at ${reset.after.slice(0, 7)} started it, and the worker opens its pull requests from it`,
        );
      } else {
        say(
          state,
          `the reset pushed main to ${reset.after.slice(0, 7)}, and no scan of that push appeared since ${since}: the run dispatches one`,
        );
      }
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
  if (!state.scan1.moves) {
    awaitScan(state, repo, state.scan1, 'scan1');
    // awaitScan filled the moves in, which the check above narrowed away.
    const scan: Scan = state.scan1;
    say(state, `scan ${scan.id} ${scan.conclusion}: ${scan.moves?.length ?? 'no'} moves`);
    save(state);
  }
  // The first scan after a reset has no state, so every image's digest and chart's version it finds is first seen
  // that day and waits a day: it lists none of them. Where it lacks a move the run's tests stand on, the run stands on
  // the scan after it, which reads the state the first left, its sightings put days back by the copy's own scan
  // (staged/factory/28-…, `SCRATCH_CONTENT_SEEN_DAYS_AGO`). A run that made no reset, or whose first scan lists every
  // move, reads one scan.
  const needed = [
    ...new Set(tests.flatMap((t) => [...t.moves, ...(t.needs ?? []), ...(t.waits ? [t.waits.move] : [])])),
  ];
  const lacking = notListed(needed, state.scan1.moves);
  const afresh = Boolean(state.reset) && !has('--no-reset') && !has('--no-scan');
  if (!state.scan0 && !state.pods0 && afresh && state.scan1.moves && lacking.length) {
    state.scan0 = state.scan1;
    say(
      state,
      `scan ${state.scan0.id}, the first after the reset, has no state and does not list ${lacking.join(', ')}: content first seen today waits a day. The run stands on the scan after it, which reads the state it left`,
    );
    state.scan1 = dispatchScan(state, repo);
    save(state);
    awaitScan(state, repo, state.scan1, 'scan1');
    const scan: Scan = state.scan1;
    say(state, `scan ${scan.id} ${scan.conclusion}: ${scan.moves?.length ?? 'no'} moves`);
    save(state);
  }
  // A move still not listed is said now, with any warning of the scan's that names its pin: a fix none of whose
  // candidates is better than the pin is no move, and the scan says so by name.
  const absent = state.pods0 ? [] : notListed(needed, state.scan1.moves);
  if (absent.length) {
    const said = scanWarnings(repo, state.scan1, absent);
    say(
      state,
      `scan ${state.scan1.id} lists no move of ${absent.join(', ')}${said.length ? `; it warns: ${said.join(' | ')}` : ', and warns of none of them by name'}`,
    );
  }
  // A test of a pin's major whose scan lists a move within the major first has no major to judge: it is dropped,
  // with why, and the run's other tests go on. The move within the major still opens and merges, as test 2's does.
  for (const t of tests.filter((t) => t.major && !t.routine && !t.mustNot && !state.dropped?.[t.id])) {
    const why = majorNotFirst((state.scan1.moves ?? []).find((m) => t.moves.includes(m.name) && moveFits(m, t)));
    if (!why) continue;
    state.dropped = { ...state.dropped, [t.id]: why };
    tests.splice(tests.indexOf(t), 1);
    say(state, `pre-flight, no verdict for ${t.id}, which is dropped from this run: ${why}`);
    save(state);
  }
  if (!state.pods0) {
    say(state, `the clock starts at scan ${state.scan1.id}, ${state.scan1.createdAt}`);
    state.pods0 = podRestarts();
    state.failed0 = cluster()
      .pods.filter((p) => p.phase === 'Failed')
      .map((p) => p.name);
    save(state);
  }
  // The pin watch, held at no move since the reset, is given the batch's now that the scan is in: the worker reads
  // them as it starts, so it is restarted below, whatever `--no-kick` says of the rest.
  if (state.held && !state.held.released) {
    sh(join(BIN, 'copies.sh'), ['pin-watch'], { cwd: BIN, timeout: 5 * 60_000 });
    state.held.released = new Date().toISOString();
    if (has('--no-kick')) kubectl(['-n', 'factory', 'rollout', 'restart', 'deployment/github']);
    save(state);
  }
  // A stopped line queues no move and no workflow pin of Dependabot's: a run whose pull requests the worker queues,
  // and which gives the line no ticket of its own, has the line running with new work off, so it takes nothing.
  const queues = tests.some((t) => (t.repo === FACTORY && t.pr.by !== 'none') || t.queuedBy === 'app');
  if (queues && !only?.dependency && !state.idledAt) {
    const line = sh(join(BIN, 'stop.sh'), ['running'], { cwd: BIN }).trim().split('\n').at(-1);
    state.idledAt = new Date().toISOString();
    say(state, `the line is ${line}, with new work off: a stopped line queues no move`);
    save(state);
  }
  // The forgeries, once the scan they copy is in: each on a branch of its own, which no watch owns or rewrites.
  for (const test of tests) {
    if (test.pr.by !== 'forged' || state.forged?.[test.id] || has('--no-forge')) continue;
    if (test.id !== test.pr.forge)
      throw new Error(`${test.id} is forged as ${test.pr.forge}: the forge names its branch by its own`);
    try {
      // Each on the forge's own branch for it: under `factory/` for one the App pushes, which the rulesets let it
      // write and no watch owns; `forged/` for one Martin's login pushes.
      const out = sh('node', [join(BIN, 'forge.ts'), test.pr.forge], { cwd: BIN, timeout: 300_000 });
      const made = JSON.parse(out.slice(out.indexOf('{')));
      state.forged = {
        ...state.forged,
        [test.id]: made.landed
          ? { landed: String(made.landed) }
          : made.refused
            ? { refused: String(made.refused) }
            : { number: made.number, head: made.head },
      };
      say(
        state,
        made.landed
          ? `forging ${test.id}: GitHub did not refuse it: ${String(made.landed).slice(0, 300)}`
          : made.refused
            ? `forging ${test.id}: GitHub refused the push: ${String(made.refused).slice(0, 200)}`
            : `forged ${test.id}: #${made.number} at ${String(made.head).slice(0, 7)} on ${made.branch} (${made.forged?.what ?? ''})`,
      );
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
    // The worker's poll, as its Deployment sets it: how long "nothing after" is (W1b) counts its passes.
    const poll = kubectl([
      '-n',
      'factory',
      'get',
      'deployment/github',
      '-o',
      'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="GITHUB_POLL_SECONDS")].value}',
    ]).trim();
    state.workerPollS = Number(poll) > 0 ? Number(poll) : 60;
    say(state, 'restarted the GitHub worker and the dependency sense, for their passes now');
    save(state);
  }

  // Dependabot is summoned for the test of its own pull request (20), once the forgeries stand on the main it will
  // leave: a commit of Martin's on the copy's main that changes dependabot.yml starts its run within a minute.
  if (tests.some((t) => t.summons) && !state.summonedAt) {
    const out = sh(join(BIN, 'copies.sh'), ['summon-dependabot'], { cwd: BIN, timeout: 10 * 60_000 });
    state.summonedAt = new Date().toISOString();
    say(state, `summoned Dependabot: ${out.trim().split('\n').at(-1)}`);
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
    // What triage made of this scan's send for a dependency: the work item it put the signal on, whatever it made of
    // it. A send that says what the ticket already holds is counted and appends no event (test 8a, whose restored
    // ticket has the same findings), but the inbox's row says which ticket it counted on, and that it has.
    const triaged = (dependency: string) => {
      const row = store(
        `select work_item, outcome from inbox where sense = 'dependency' and signal->'move'->>'name' = '${dependency}' and received_at >= '${scanned}' and triaged_at is not null and work_item is not null order by received_at desc limit 1`,
      )[0];
      const open = row?.[0] && row[0] === ticket(dependency, false) ? row[0] : undefined;
      if (open) say(state, `triage put this scan's signal for ${dependency} on #${open} (${row?.[1]})`);
      return open;
    };
    for (let i = 0; !state.workItem || (second && !state.then); i++) {
      // The ticket the scan's send made or joined: one with a dependency signal since the scan started, or the one the
      // inbox says triage counted the send on. With neither in four minutes (an inbox that cannot be read), the open
      // ticket for the dependency is taken as it stands.
      const fresh = i <= 24;
      if (i === 25)
        say(
          state,
          `no new signal on a ticket for ${name}${second ? ` or ${second}` : ''} in four minutes: taking the open ticket as it stands`,
        );
      state.workItem ??= ticket(name, fresh) ?? (fresh ? triaged(name) : undefined);
      const then = second && !state.then ? (ticket(second, fresh) ?? (fresh ? triaged(second) : undefined)) : undefined;
      // biome-ignore lint/suspicious/noThenProperty: the run's second ticket, never awaited
      if (then) state.then = { workItem: then, events: [] };
      if (state.workItem && (!second || state.then)) break;
      if (i > 120) {
        say(state, make(['stop-the-line', 'REASON=the patching test found no ticket']).trim());
        throw new Error(
          `triage opened no ticket for ${state.workItem ? second : only.dependency} from this scan within 20 minutes`,
        );
      }
      sleep(10_000);
    }
    if (state.then)
      say(
        state,
        `the second ticket, for ${second}: #${state.then.workItem}, taken once #${state.workItem}'s pull request merges`,
      );
    // W3b: the move goes onto main now, as another change would have made it, before the line takes its ticket.
    if (only.made && !state.made) {
      const move = (state.scan1.moves ?? []).find((m) => only.moves.includes(m.name));
      const to = /^image (\S+)$/.exec(move?.to ?? '')?.[1];
      const file = move?.pins[0]?.file;
      if (!move || !to || !file) {
        say(state, make(['stop-the-line', 'REASON=the patching test has no move to put on main']).trim());
        throw new Error(`the scan lists no image move of ${only.moves.join(', ')} to put on main`);
      }
      const out = sh(join(BIN, 'copies.sh'), ['move-on-main', file, move.name, move.from, to], {
        cwd: BIN,
        timeout: 10 * 60_000,
      });
      const said = out.trim().split('\n').at(-1)?.replace(/^== /, '') ?? '';
      state.made = { at: new Date().toISOString(), said, ticket: { workItem: state.workItem, events: [] } };
      say(state, `put the move on main: ${said}`);
    }
    state.startedAt = new Date().toISOString();
    if (state.made) state.made.ticket.takenAt = state.startedAt;
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
  // A ticket that must close with no change (W3's second, W3b's own), once taken: its end, its hold, its failed
  // steps and its issue.
  const thenNow = () => {
    for (const ticket of [state.then, state.made?.ticket]) if (ticket?.takenAt) ticketNow(ticket);
  };
  const ticketNow = (then: TicketFacts) => {
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
  // Test 21: once the line's pull request is open, the exception is lifted and the app scanned again; once that scan
  // is in, the dependency sense is restarted, as it reads a scan only as it starts or on its hour. After the watch
  // (`over`) nothing is staged, and what the issue and the pull request then say is read.
  const laterNow = (over = false) => {
    const want = only?.newer;
    const pulls = only ? (state.seen[only.id]?.pulls ?? []) : [];
    const pull = pulls.length === 1 ? pulls[0] : undefined;
    if (!want || !pull || !state.workItem) return;
    state.later ??= {};
    const later = state.later;
    later.issue ??=
      Number(store(`select coalesce(max(issue), 0) from line where work_item = '${state.workItem}'`)[0]?.[0] ?? 0) ||
      undefined;
    const body = () => (later.issue ? String(api<any>(APP, `issues/${later.issue}`).body ?? '') : undefined);
    if (!later.liftedAt) {
      if (over || pull.state !== 'open') return;
      later.headAtOpen = pull.head;
      later.issueAtOpen = body();
      const out = sh(join(BIN, 'copies.sh'), ['lift-exception', want.package, ...want.lifts], {
        cwd: BIN,
        timeout: 10 * 60_000,
      });
      later.liftedAt = new Date().toISOString();
      later.scan = dispatchScan(state, APP).id;
      say(
        state,
        `#${pull.number} is open at ${pull.head.slice(0, 7)}: ${out.trim().split('\n').at(-1)?.replace(/^== /, '')}; scan ${later.scan} of the app dispatched`,
      );
      save(state);
      return;
    }
    if (!later.toldAt && !over && later.scan) {
      if (api<any>(APP, `actions/runs/${later.scan}`).status !== 'completed') return;
      kubectl(['-n', 'factory', 'rollout', 'restart', 'deployment/patching']);
      later.toldAt = new Date().toISOString();
      say(state, `scan ${later.scan} is in: restarted the dependency sense, which reads it as it starts`);
    }
    later.issueNow = body();
    const key = new RegExp(`^\\+(  ${want.package.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@[^:(]+)[:(]`);
    const patch: string =
      api<any[]>(APP, `pulls/${pull.number}/files?per_page=100`).find((f) => f.filename === 'pnpm-lock.yaml')?.patch ??
      '';
    later.adds = [
      ...new Set(patch.split('\n').flatMap((line) => (key.exec(line)?.[1] ? [`${key.exec(line)?.[1]}:`] : []))),
    ];
    save(state);
  };
  // Test 25: Martin's review, asking for changes, posted as his login the first time the watch sees the move's pull
  // request, with what its required checks were doing then: one still running means no pass of the worker could have
  // queued the head before the review, as it queues only a head whose checks are all in.
  const askChanges = () => {
    const test = tests.find((t) => t.asksChanges);
    const pulls = test ? (state.seen[test.id]?.pulls ?? []) : [];
    const pull = pulls.length === 1 ? pulls[0] : undefined;
    if (!test || !pull || state.review || pull.state !== 'open') return;
    const pending = pull.pending.filter((name) => name !== 'review');
    sh('gh', [
      'pr',
      'review',
      String(pull.number),
      '-R',
      test.repo,
      '--request-changes',
      '-b',
      `Changes asked for by the patching harness, as Martin, for test ${test.id}: this pull request must now wait for him, whatever rule would pass it.`,
    ]);
    state.review = { number: pull.number, head: pull.head, at: new Date().toISOString(), pending };
    say(
      state,
      `asked for changes on #${pull.number} at ${pull.head.slice(0, 7)}, as Martin, while ${pending.join(', ') || 'no required check'} still ran`,
    );
    save(state);
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
  // Done: deployed (and a second ticket ended, W3), or out of runs and settled (W1b), or a ticket closed with no change
  // (W3b), or Dependabot's pull request closed, or left when the App's move it stands on is deployed (22).
  // One read from the run's scans alone (28), or after the watch (27), never holds it.
  const done = (t: Test) =>
    t.waits || t.reverted
      ? true
      : t.checksRun?.spent
        ? verdict(state, t).pass
        : t.made
          ? Boolean(state.made?.ticket.closed)
          : t.duplicate
            ? verdict(state, t).pass || Boolean(state.seen[t.duplicate.of]?.deployedAt)
            : Boolean(state.seen[t.id]?.deployedAt) && (!t.then || Boolean(state.then?.closed));
  let said = '';
  let saidAt = 0;
  while (!state.watchedUntil) {
    lineNow();
    thenNow();
    observe(state, tests);
    turns();
    laterNow();
    askChanges();
    const lines = tests.map((t) => `${t.id}:${verdict(state, t).why.slice(0, 60)}`).join('\n    ');
    if (lines !== said || Date.now() - saidAt >= SAY_MS) {
      say(state, `watching (${clock(state, new Date().toISOString())})\n    ${lines}`);
      said = lines;
      saidAt = Date.now();
    }
    const refused = tests.every((t) => t.mustNot && verdict(state, t).pass);
    // A move that must not merge, or a major the level holds, counts as settled once it is decided (`decidedHeld`),
    // or, while it is still refused, an hour from the scan (Martin's first limit): a batch of them beside moves that
    // deployed ends then, not at a longer limit set for the slow ones.
    const hour = Date.now() >= Date.parse(state.scan1.createdAt) + 60 * 60_000;
    const mustHold = (t: Test) => t.mustNot || (t.major && !state.flags.includes('--lights-out'));
    // The worker's log, for its word on why a head waits, and on a scan it cannot read.
    const byWorker = (t: Test) => t.repo === FACTORY && (t.pr.by === 'pin' || t.pr.by === 'lockfile');
    const log = tests.some((t) => byWorker(t) || (mustHold(t) && t.pr.by !== 'forged')) ? workerLog(state) : '';
    const waits = workerWaits(log);
    const unread = unreadMoves(log, Date.now());
    // The first head a hold is decided at is kept: the worker says its word once a head, and a later head, written
    // when main moves under a held pull request, may have neither its checks nor that word before the watch ends.
    for (const t of tests) {
      const seen = state.seen[t.id];
      if (!seen || seen.heldAt || !mustHold(t) || t.pr.by === 'forged') continue;
      // One Martin asked for changes on is decided as any hold is, once the gate's words say he asked.
      const asked = t.asksChanges
        ? changesVerdict({
            pulls: seen.pulls,
            review: state.review,
            says: t.heldFor ?? /$^/,
            decided: seen.pulls.every((p) => holdDecided(p, waits.get(`${p.number} ${p.head}`), false)),
          }).pass
        : decidedHeld(state, t, waits);
      if (!asked) continue;
      seen.heldAt = { head: seen.pulls[0]?.head ?? '', at: new Date().toISOString() };
      say(state, `${t.id} is held: decided at ${seen.heldAt.head.slice(0, 7)}`);
    }
    const holds = (t: Test) =>
      Boolean(mustHold(t)) &&
      ((hour && verdict(state, t).pass) ||
        (state.seen[t.id]?.heldAt ? verdict(state, t).pass : decidedHeld(state, t, waits)));
    // A failure nothing left can undo ends that test's wait too: its verdict is read after the watch, as every one is.
    for (const t of tests) {
      const seen = state.seen[t.id];
      if (!seen || seen.certain || t.checksRun?.spent || t.unread || t.duplicate || t.made) continue;
      const tl = seen.timeline;
      seen.certain = certainFail({
        mustHold: Boolean(mustHold(t)),
        // One that ends as an issue has no pull request to judge: only the worker's own word can end it.
        pulls: t.issue ? [] : seen.pulls,
        spent: [...(tl?.spentRuns ?? []), ...(tl?.spentQueue ?? [])].map((c) => c.head),
        moves: t.pr.by === 'pin' ? seen.moves : [],
        unread: byWorker(t) ? unread : undefined,
      });
      if (seen.certain) say(state, `${t.id} has failed, whatever comes: ${seen.certain}`);
    }
    // One read from the scan and GitHub alone is settled once it passes: an issue opened and no pull request beside
    // it five minutes on (the pin watch's pass that made the issue is long over), or the scan's run and a merge.
    const settled = (t: Test) => {
      // One that rides beside an app's test (24) is read as it stands once that test is done: it never holds the run.
      if (t.issue && only && t !== only && done(only)) return true;
      if (!(t.issue || t.unread) || !verdictSoFar(state, t)) return false;
      const issued = state.seen[t.id]?.issuedAt;
      return Boolean(t.unread) || (issued !== undefined && Date.now() - Date.parse(issued) >= 5 * 60_000);
    };
    // A forgery GitHub refused at the push, or let through where it must refuse, is over, whichever way its verdict
    // reads: nothing more comes of it.
    const refusedPush = (t: Test) => Boolean(state.forged?.[t.id]?.refused || state.forged?.[t.id]?.landed);
    const all =
      refused ||
      tests.every((t) => done(t) || holds(t) || settled(t) || refusedPush(t) || Boolean(state.seen[t.id]?.certain));
    const stopped =
      Boolean(
        state.line?.held || state.line?.closed || state.line?.stalled || state.line?.strays.length || state.then?.held,
      ) && !all;
    if (all || stopped || Date.now() >= deadline || has('--once')) state.watchedUntil = new Date().toISOString();
    else sleep(Math.min(probeFailed ? SLOW_POLL_MS : POLL_MS, Math.max(1_000, deadline - Date.now())));
  }
  save(state);

  if (state.startedAt && !state.stoppedAt) {
    say(state, make(['stop-the-line', 'REASON=the patching test is over']).trim());
    state.stoppedAt = new Date().toISOString();
    save(state);
  }
  if (
    !state.scan2 &&
    !has('--once') &&
    tests.some((t) => !t.mustNot && standsOnMove(t) && state.seen[t.id]?.deployedAt)
  ) {
    confirmingScan(state, repo, tests);
  }
  lineNow();
  thenNow();
  observe(state, tests, true);
  laterNow(true);
  // After every other test is read for the last time, so nothing here changes what they are judged on.
  if (!has('--once')) {
    revertNow(state, repo, tests);
    majorNow(state, repo, tests);
  }
  settle(state);
  state.clean = clean(state);
  // The worker the run restarted for test 27 took its log with it: its error lines until then count as any do.
  const before = state.reverted?.before;
  if (before) {
    state.clean.errors.push(...before.errors);
    state.clean.errorAt?.push(...before.errorAt);
  }
  state.done = true;
  save(state);
  report(state);
}

/** A scan after the confirming one, dispatched and read into `scan3`. */
function laterScan(state: State, repo: string, why: string): Scan {
  const scan = awaitScan(state, repo, dispatchScan(state, repo), 'scan3');
  state.scan3 = scan;
  say(state, `a later scan, ${why}: ${scan.id} (${scan.conclusion}), ${scan.moves?.length ?? 'no'} moves`);
  save(state);
  return scan;
}

/**
 * Test 27: the merged move of the test it names is put back on main, as Martin reverting its merge
 * (`./copies.sh revert-move`), and the copy scanned again. The pin watch reads a scan as the worker starts and then
 * once in `PIN_PASS_MS`, so the worker is restarted once that scan is in, its error lines until then kept for the look
 * at the cluster, and the run waits, `PIN_PASS_LIMIT_MS` at most, for a sign that the watch made a pass on the scan:
 * its log's word that it read it, its issue for the move, or a pull request of the App's that carries the move again,
 * which fails the test at once. From the first sign it watches for `revertSettleMs` more. With no sign by the limit
 * the test has no verdict: a watch that has not read the scan opens nothing, whatever its code would do.
 */
function revertNow(state: State, repo: string, tests: Test[]) {
  const test = tests.find((t) => t.reverted);
  if (!test?.reverted || state.reverted?.watchedUntil) return;
  const of = state.seen[test.reverted.of];
  const merged = of?.pulls.length === 1 && of.pulls[0]?.mergeCommit ? of.pulls[0] : undefined;
  const move = of?.moves[0];
  if (!merged?.mergeCommit || !move) return;
  state.reverted ??= { merge: merged.mergeCommit, pulls: [], issues: [] };
  const done = state.reverted;
  if (!done.commit) {
    const out = sh(join(BIN, 'copies.sh'), ['revert-move', merged.mergeCommit], { cwd: BIN, timeout: 10 * 60_000 });
    done.commit = /main at ([0-9a-f]{40}):/.exec(out)?.[1] ?? mainOf(repo);
    done.at = new Date().toISOString();
    say(state, `put #${merged.number}'s move of ${move.name} back on main, as Martin, at ${done.commit.slice(0, 7)}`);
    save(state);
  }
  if (!done.scannedAt) {
    laterScan(state, repo, `after ${move.name} was put back`);
    done.scannedAt = new Date().toISOString();
    save(state);
  }
  if (!done.restartedAt) {
    // The pod's log goes with the pod: its error lines since the run's scan are read now, for the look at the cluster.
    const now = cluster();
    const worker = { ...now, pods: now.pods.filter((p) => p.name.startsWith('factory/github-')) };
    done.before = errorLines(state, worker, state.scan1?.createdAt ?? state.resetAt ?? done.scannedAt);
    const since = new Date().toISOString();
    kubectl(['-n', 'factory', 'rollout', 'restart', 'deployment/github']);
    kubectl(['-n', 'factory', 'rollout', 'status', 'deployment/github', '--timeout=300s'], 320_000);
    done.restartedAt = since;
    say(state, `scan ${state.scan3?.id} is in: restarted the GitHub worker, whose pin watch reads it as it starts`);
    save(state);
  }
  const limit = Date.parse(done.restartedAt) + PIN_PASS_LIMIT_MS;
  for (;;) {
    readReverted(state, repo, move.name);
    const signs = [done.read?.at, ...done.issues.filter((i) => i.author === APP_BOT).map((i) => i.at)]
      .filter((at): at is string => Boolean(at))
      .sort();
    const until = signs[0] ? Date.parse(signs[0]) + revertSettleMs(state.workerPollS) : limit;
    if (done.pulls.length || Date.now() >= until) break;
    sleep(POLL_MS);
  }
  done.watchedUntil = new Date().toISOString();
  save(state);
}
/**
 * Test 27's look: the App's pull requests since the revert that carry the move, the issues for it since, and, once,
 * the pin watch's pass on the later scan as the worker's log since its restart has it.
 */
function readReverted(state: State, repo: string, name: string) {
  const done = state.reverted;
  const since = done?.at ?? done?.scannedAt;
  if (!done || !since) return;
  done.pulls = api<any[]>(repo, 'pulls?state=all&sort=created&direction=desc&per_page=30')
    .filter((p) => p.created_at >= since && p.user.login === APP_BOT && pinMoves(p).includes(name))
    .map((p) => p.number as number);
  done.issues = api<any[]>(repo, `issues?state=all&since=${since}&per_page=100`)
    .filter((i) => !i.pull_request && (issueOfMove(i.title, name) || String(i.body ?? '').includes(`\`${name}\``)))
    .map((i) => ({
      number: i.number as number,
      author: i.user?.login ?? '',
      body: String(i.body ?? ''),
      at: i.created_at as string,
    }));
  if (done.read || !done.restartedAt || !state.scan3) return;
  let log = '';
  try {
    log = kubectl(['-n', 'factory', 'logs', 'deployment/github', `--since-time=${done.restartedAt}`], 300_000);
  } catch {}
  const read = watchRead(log, repo, state.scan3.id);
  if (read) {
    done.read = read;
    say(state, `the pin watch read scan ${read.run} at ${read.at}`);
    save(state);
  }
}

/**
 * Test 2's major: where the confirming scan does not list it (its content was first seen by that scan, and waits),
 * one more scan reads the state that one left. A run that has scanned again already (test 27) reads that scan.
 */
function majorNow(state: State, repo: string, tests: Test[]) {
  const test = tests.find((t) => t.thenMajor);
  const first = test ? state.seen[test.id]?.moves[0] : undefined;
  if (!test || !first || !state.scan2?.moves || state.scan3 || !state.seen[test.id]?.deployedAt) return;
  if (!majorNextFault(first, [fileOf(state.scan2)])) return;
  laterScan(state, repo, `for the major ${first.name} is to be followed by`);
}

/**
 * The scan that confirms a run's merges, read into `scan2`: the newest finished scan of main on a commit that holds
 * every merged test's merge commit and left a `moves.json` (decide.ts's `pickScan`). The pushes of those merges start
 * scans of their own, and the scan's job keeps one pending run, so one this run dispatched may be cancelled for a later
 * push's: the later one is on a commit that holds the merges too, and is taken or waited for. One is dispatched only
 * when none is finished, queued or running on such a commit. A scan cancelled or replaced is no test's failure; with
 * none read in 40 minutes the run says so, and its lines read "the next scan has not run".
 */
function confirmingScan(state: State, repo: string, tests: Test[]) {
  repoOk(repo);
  const merges = [
    ...new Set(
      tests
        .filter((t) => !t.mustNot && standsOnMove(t))
        .flatMap((t) => (state.seen[t.id]?.pulls ?? []).map((p) => p.mergeCommit ?? ''))
        .filter(Boolean),
    ),
  ];
  const holds = (head: string) => merges.every((merge) => past(repo, merge, head));
  const since = state.scan1?.createdAt ?? '';
  const spent = new Set<number>();
  const until = Date.now() + 40 * 60_000;
  let said = 0;
  while (Date.now() < until) {
    const runs = (
      JSON.parse(sh('gh', ['api', `repos/${repo}/actions/workflows/vulnerabilities.yml/runs?branch=main&per_page=30`]))
        .workflow_runs ?? []
    )
      .filter((r: any) => r.created_at > since && r.id !== state.scan1?.id)
      .map((r: any) => ({
        id: r.id as number,
        event: r.event as string,
        status: r.status as string,
        conclusion: r.conclusion as string | null,
        headSha: r.head_sha as string,
        createdAt: r.created_at as string,
      }));
    const pick = pickScan(runs, holds, spent);
    if ('dispatch' in pick) {
      const made = dispatchScan(state, repo);
      say(
        state,
        `the next scan: ${made.id}, dispatched, as none is on a commit that holds the run's ${merges.length} merges`,
      );
      continue;
    }
    if ('wait' in pick) {
      if (said !== pick.wait.id)
        say(
          state,
          `the next scan: waiting for ${pick.wait.id} (${pick.wait.event}, at ${pick.wait.headSha.slice(0, 7)})`,
        );
      said = pick.wait.id;
      sleep(POLL_MS);
      continue;
    }
    const scan = awaitScan(state, repo, { id: pick.use.id, createdAt: pick.use.createdAt }, 'scan2');
    if (scan.moves) {
      state.scan2 = scan;
      say(
        state,
        `the next scan: ${scan.id} (${pick.use.event}, at ${pick.use.headSha.slice(0, 7)}, ${scan.conclusion}), ${scan.moves.length} moves`,
      );
      save(state);
      return;
    }
    spent.add(pick.use.id);
  }
  say(state, `the next scan: none on a commit that holds the run's merges left a moves.json in 40 minutes`);
}

// ── The store restarted under a report (W5) ─────────────────────────────────────────────────────────────────────────

/** The app's own host on the scratch cluster's HTTP port, asked for by name at the loopback address. */
const APP_AT = { url: 'http://127.0.0.1:9080', host: 'website.localhost' };
/**
 * W5, a step of its own with no reset and no scan: a report is left through the app's widget, as a visitor's browser
 * sends one, and the store's pod is deleted at once, so the log watcher's send of that report finds the store away.
 * Argo CD's StatefulSet puts the pod back. The run waits for the report in the inbox (the watcher reads back ten
 * minutes, so twelve at most), then two minutes more for a second copy, and reads every factory worker's log from
 * the report on.
 */
function runRestart(state: State) {
  if (!kubectl(['config', 'get-contexts', '-o', 'name']).split('\n').includes(CONTEXT))
    throw new Error(`no kube context ${CONTEXT}`);
  // The report's words: plain ones the store's query can hold, told apart from every other run's by the run's name.
  const text = `A patching test left this report, ${state.id}. There is no fault to find.`;
  const count = () =>
    Number(
      store(`select count(*) from inbox where sense = 'report' and signal->'report'->>'text' = '${text}'`)[0]?.[0] ?? 0,
    );
  const uid = () => {
    try {
      return kubectl(['-n', 'factory', 'get', 'pod', 'postgres-0', '-o', 'jsonpath={.metadata.uid} {.status.phase}']);
    } catch {
      return '';
    }
  };
  const ready = () => {
    try {
      return kubectl([
        '-n',
        'factory',
        'get',
        'pod',
        'postgres-0',
        '-o',
        'jsonpath={.status.containerStatuses[0].ready}',
      ]);
    } catch {
      return '';
    }
  };
  const was = uid().split(' ')[0] ?? '';
  if (!was) throw new Error('pre-flight, no verdict: the scratch store has no pod postgres-0');
  const at = new Date().toISOString();
  const posted = Number(
    sh('curl', [
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-m',
      '20',
      '-H',
      `Host: ${APP_AT.host}`,
      '-H',
      'content-type: application/json',
      '-d',
      JSON.stringify({ page: '/', text }),
      `${APP_AT.url}/api/reports`,
    ]).trim(),
  );
  // Away for some 25 seconds, so at least two of the watcher's turns (every ten) fall inside: the StatefulSet puts the
  // pod back within seconds, so it is deleted again each time it is there. Only ever the pod.
  const awayFrom = Date.now();
  const gone = new Set<string>([was]);
  while (Date.now() - awayFrom < 25_000) {
    try {
      kubectl(['-n', 'factory', 'delete', 'pod', 'postgres-0', '--wait=false', '--ignore-not-found']);
    } catch {}
    sleep(2_000);
    const now = uid().split(' ')[0] ?? '';
    if (now) gone.add(now);
  }
  // The last one deleted may still be going: a pod met in the window is never the one that counts as back.
  const awayS = Math.round((Date.now() - awayFrom) / 1000);
  say(state, `left a report through the app (${posted}) and kept the store's pod away for ${awayS} s`);
  state.restart = { at, posted, restarted: false, inbox: 0, errors: [], unhealthy: [], awayS };
  save(state);
  // Back: a pod of another uid than any deleted, ready.
  for (let i = 0; i < 60 && !state.restart.restarted; i++) {
    sleep(5_000);
    const now = uid().split(' ')[0] ?? '';
    state.restart.restarted = Boolean(now) && !gone.has(now) && ready() === 'true';
  }
  say(state, state.restart.restarted ? 'the store is back' : 'the store did not come back in five minutes');
  for (let i = 0; state.restart.restarted && posted === 202 && i < 72; i++) {
    try {
      state.restart.inbox = count();
    } catch {}
    if (state.restart.inbox > 0) {
      state.restart.arrivedS = Math.round((Date.now() - Date.parse(at)) / 1000);
      say(
        state,
        `the report is in the inbox, ${state.restart.arrivedS} s after it was left; watching for a second copy`,
      );
      sleep(120_000);
      state.restart.inbox = count();
      break;
    }
    sleep(10_000);
  }
  const now = cluster();
  state.restart.errors = errorLines(state, now, at).errors;
  try {
    state.restart.watcher = watcherRode(
      kubectl(['-n', 'factory', 'logs', 'deployment/logs', '--all-containers', `--since-time=${at}`], 300_000),
    );
  } catch {}
  state.restart.unhealthy = now.pods
    .filter(
      (p) => p.name.startsWith('factory/') && !['Succeeded'].includes(p.phase) && !(p.phase === 'Running' && p.ready),
    )
    .map((p) => `${p.name} ${p.phase}`);
  state.done = true;
  save(state);
  report(state);
}

// ── The command line ────────────────────────────────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);
/** `--only 1,2,N4`: the tests a small run stands for, each one the catalogue's. */
/**
 * `app <test> --with X1a,X1b`: forgeries in the app copy that ride beside an app test's scan (or an app test that is
 * one itself), judged by the gate alone, and tests that end as an issue of the worker's (24); the line works only the
 * test's own ticket.
 */
function withOf(command: string | undefined, args: string[]): string[] | undefined {
  const at = args.indexOf('--with');
  if (at < 0) return undefined;
  const ids = (args[at + 1] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const beside = (t: Test) => t.campaign === 'app' && (t.pr.by === 'forged' || Boolean(t.issue));
  const wrong = ids.filter((id) => !TESTS.some((t) => t.id === id && beside(t)));
  if (command !== 'app' || !ids.length || wrong.length)
    throw new Error(
      `--with takes the app's forgeries and its tests that end as an issue, comma-separated, on an app run${wrong.length ? `: not ${wrong.join(', ')}` : ''}`,
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
  if (TESTS.some((t) => t.id === test && t.restart)) runRestart(state);
  else run(state);
} else if (command === 'batch') {
  // `only`'s line written to the state folder's batch.env, in place of any there, and read back as copies.sh reads it.
  // `batch none` writes the line with no name: the pin watch takes no move, as the app's tests need of it.
  const none = rest[0] === 'none';
  const ids = (none ? '' : (rest[0] ?? ''))
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const tests = TESTS.filter((t) => ids.includes(t.id));
  if (!none && (!ids.length || tests.length !== ids.length))
    throw new Error("batch <tests> | none: comma-separated tests of the catalogue's");
  const names = pinWatchNames(tests);
  if (!none && !names.length) throw new Error('batch: none of those tests stands on a move of the pin watch');
  const file = join(STATE_DIR, 'batch.env');
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    file,
    withSetting(existsSync(file) ? readFileSync(file, 'utf8') : '', 'PIN_WATCH_ONLY', pinWatchLine(names)),
  );
  const back = sh('bash', ['-c', 'source "$1"; printf %s "$PIN_WATCH_ONLY"', '-', file]);
  if (back !== names.join(',')) throw new Error(`batch.env reads back as ${back}, not ${names.join(',')}`);
  console.log(`the pin watch takes: ${back || 'no move'}`);
} else if (command === 'waits') {
  // Batch D's question: whether every move's pull request the App opened since <since> waits as <want> says, unqueued,
  // its checks in, by the worker's last word at its head (decide.ts's `waitsFault`). Said, and the exit status. The
  // worker says a wait once a head, so a word may be older than a change of the level or the stop it must answer:
  // with <said since>, the time of a restart of the worker after that change, only its words from then count.
  const [since = '', want = '', saidSince = since] = rest;
  const time = /^\d{4}-\d\d-\d\dT[\d:]+Z$/;
  if (!time.test(since) || !['stopped', 'supervised', 'either'].includes(want) || !time.test(saidSince))
    throw new Error('waits <since, as 2026-11-26T20:00:00Z> stopped|supervised|either [<said since>]');
  const open = api<any[]>(FACTORY, 'pulls?state=open&per_page=100').filter(
    (p) => p.user.login === APP_BOT && p.created_at >= since && p.title.startsWith('chore(pin): '),
  );
  const queue: number[] =
    graphql(
      FACTORY,
      'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: "main") { entries(first: 50) { nodes { pullRequest { number } } } } } }',
    ).repository.mergeQueue?.entries.nodes.map((n: any) => n.pullRequest.number) ?? [];
  const pulls = open.map((p) => ({
    number: p.number as number,
    head: p.head.sha as string,
    queued: queue.includes(p.number),
    pending: (api<any>(FACTORY, `commits/${p.head.sha}/check-runs?per_page=100`).check_runs ?? []).filter(
      (run: any) => run.status !== 'completed',
    ).length,
  }));
  const words = queueWords(
    kubectl(['-n', 'factory', 'logs', 'deployment/github', `--since-time=${saidSince}`], 300_000),
  );
  const fault = waitsFault(pulls, words, want as 'stopped' | 'supervised' | 'either');
  for (const p of pulls) {
    const word = words.get(`${p.number} ${p.head}`);
    console.log(
      `#${p.number} at ${p.head.slice(0, 7)}: ${word ? `waits for ${word.waits} (${word.why})` : 'no word yet'}`,
    );
  }
  console.log(fault ?? `every move's pull request waits, unqueued: ${want}`);
  process.exit(fault ? 1 : 0);
} else if (command === 'rests') {
  // Whether the factory copy rests, as an app's test needs it to (decide.ts's `factoryBusy`): said, and the exit status.
  const busy = factoryBusy({
    pulls: api<any[]>(FACTORY, 'pulls?state=open&per_page=100').map((p) => ({
      number: p.number,
      title: p.title,
      author: p.user.login,
    })),
    app: APP_BOT,
    main: mainOf(FACTORY),
    baseline: sh('gh', ['api', `repos/${FACTORY}/commits/baseline`, '--jq', '.sha']).trim(),
  });
  console.log(busy ?? "the factory copy rests: nothing of the App's open on it would merge");
  process.exit(busy ? 1 : 0);
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
  const apps = tests.filter((t) => t.campaign !== 'factory').map((t) => t.id);
  const dependabots = tests.filter((t) => t.campaign === 'factory' && t.pr.by === 'dependabot').map((t) => t.id);
  if (apps.length) console.error(`not the pin watch's: ${apps.join(', ')} (an app test runs alone already)`);
  if (dependabots.length)
    console.error(
      `not the pin watch's: ${dependabots.join(', ')} (Dependabot's own pull request, which the run summons Dependabot for)`,
    );
  if (!names.length) throw new Error('only: none of those tests stands on a move of the pin watch');
  console.log(pinWatchLine(names));
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
  // A finished run judged again from what it recorded: nothing is read from the copy or the cluster as they stand,
  // which a later reset has emptied (its issues, its open pull requests, what was deployed). `--scan2 <id>` names the
  // scan that confirms it, whose moves.json is read afresh: one that finished after the run stopped waiting.
  const named = rest.indexOf('--scan2');
  const state = load((named === 0 ? undefined : rest[0]) ?? latestRun() ?? '');
  if (named >= 0) {
    const id = Number(rest[named + 1]);
    if (!Number.isInteger(id) || id <= 0) throw new Error('reread <run> --scan2 <id>: the id of a run of the scan');
    const repo = state.campaign === 'app' ? APP : FACTORY;
    const run = api<any>(repo, `actions/runs/${id}`);
    if (run.path !== '.github/workflows/vulnerabilities.yml' || run.head_branch !== 'main')
      throw new Error(`run ${id} is no scan of ${repo}'s main`);
    const scan = awaitScan(state, repo, { id, createdAt: run.created_at }, 'scan2');
    if (!scan.moves) throw new Error(`scan ${id} left no moves.json to read`);
    state.scan2 = scan;
    save(state);
  }
  report(state);
} else if (command === 'summary') {
  summary();
} else {
  console.error(
    'usage: harness.ts factory | app <test> [--limit <min>] [--no-reset] [--no-scan] [--no-kick] [--once] | batch <tests>|none | only <tests> | rests | waits <since> stopped|supervised|either [<said since>] | variables <tests> | resume [<run>] | report [<run>] | reread [<run>] | summary',
  );
  process.exit(2);
}
