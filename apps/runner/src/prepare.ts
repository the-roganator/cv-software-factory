/**
 * The prepare step, in the prepare pod: the one of a runner's two pods that may reach GitHub and the npm registry.
 * It checks out the step's commit onto the job's volume and installs its dependencies there, so the agent pod,
 * which reaches nothing but the gateway and the handback, finds everything it needs.
 *
 * The volume is the agent's too, so the agent may have left anything there. This pod has the internet, so it runs
 * nothing from the volume: each step it deletes the checkout and makes a fresh one at the commit the line names (the
 * branch's head on GitHub), with git, pnpm and pnpm's store, home and settings of its own (`PREPARE`, an empty
 * folder each time). No lifecycle script or pnpmfile runs. The agent's session, in its own home on the volume, stays,
 * so a later round resumes it.
 *
 * A step that reads a change (the reviewer's) names its base as well as its commit. Both are fetched with the commits
 * between them and none before, and the base is the checkout's branch `base`: `git diff base` is the change,
 * `git log base..HEAD` its commits, every round's, and `git show base:<path>` a file as it was before it, such as the
 * rules a review holds the change to.
 *
 * A dry run's pull request has commits GitHub never had: the step names the real commit they went on, and each of
 * them as a patch and its message, and they are committed here on it, after the base is fetched, as the pull
 * request's own commits.
 *
 * A seed is committed by a fixed author, under a fixed message, at a fixed time, so the same seed on the same commit
 * makes the same base every time: its sha can reach the agent's prompt (Claude Code shows it the latest commits), and
 * the gateway's cassettes replay only what is sent again exactly. The message says nothing of what the seed is, since
 * real work never comes with such a hint. For the same reason every file of the checkout is given that time too,
 * since the agent's searches list files by when they changed.
 *
 * A dependency's work item names its move, and the pin step (`pins.ts`) writes it after the checkout and before the
 * install, committing it by a fixed author under a message that names the move: the agent starts from the moved pins,
 * and its patch never holds them. The step prints the pins as a patch, which the line reads from this pod's log before
 * the agent starts, or that they wait for Martin, and then ends without installing anything, since no agent runs on
 * them. `runner lockfile` (`lockfile`) is the pin step after a coder's step that changed a manifest, in a prepare pod
 * of its own: it prints only the lockfile pnpm wrote.
 *
 * pnpm is the image's own, this repository's (`apps/runner/Dockerfile`), whatever the checkout's `packageManager`
 * names: the app pins pnpm on its own, and nothing here may fetch another. The step says which it runs beside the one
 * the checkout names, and stops at a different major, which the lockfile may not be read by.
 */
import { execFile } from 'node:child_process';
import { lutimes, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { git, gitInput, gitWith } from './git.ts';
import { bounded, type Log, runnerLog } from './log.ts';
import {
  type Move,
  OWN_PNPM,
  OWN_PNPM_FLAG,
  PinsHeld,
  type PinTools,
  pnpmIn,
  writeLockfile,
  writePins,
} from './pins.ts';
import { repoDir, stepFrom } from './step.ts';

const exec = promisify(execFile);

/** When every seed is committed. */
const SEED_DATE = '2026-01-01T00:00:00Z';
/** The seed's commit message, which the agent sees among the latest commits: it says nothing of what the seed is. */
export const SEED_MESSAGE = 'chore: the starting point';

/** Prepares the checkout, printing a JSON line as each part is done (`log.ts`) to `write`. */
export async function prepare(
  env = process.env,
  write = (line: string) => console.log(line),
  tools: Partial<PinTools> = {},
): Promise<void> {
  const log = runnerLog(env, 'prepare', write);
  const { step, dir, pnpmEnv } = await checkout(env, log);
  if (step.move) {
    // Written on a checkout of their own, in this pod's own folder: the volume is the agents', and one of an earlier
    // step's may not have ended yet. Then committed on the agent's checkout, as its base, never part of its patch.
    const own = join(prepareDir(env), 'pins');
    await checkout(env, () => {}, own);
    const pins = await pinsOf(own, step.move, { ...pinTools(env, pnpmEnv), ...tools }, log);
    if (pins === undefined) return;
    if (pins) await commitPatch(dir, pins, { message: pinsMessage(step.move), author: 'pins' });
  }
  const install = ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--reporter=silent'];
  await exec('pnpm', [OWN_PNPM_FLAG, ...install], { cwd: dir, env: pnpmEnv, maxBuffer: 64 * 1024 * 1024 });
  log('installed the dependencies');
}

/** The pin step's commit message, which the agent sees among the latest commits: what moved, and to what. */
export const pinsMessage = (move: Move) => `chore(deps): move ${move.name} from ${move.from} to ${move.to}`;

/**
 * The pins of a move, written and printed (`the pins`, with the patch), or printed as held (`the pins wait for
 * Martin`, with the file and why), when they are undefined: the step ends there, and no agent runs on it. An empty
 * patch is a move already made.
 */
async function pinsOf(dir: string, move: Move, tools: PinTools, log: Log): Promise<string | undefined> {
  try {
    await writePins(dir, move, tools);
  } catch (error) {
    if (!(error instanceof PinsHeld)) throw error;
    log('the pins wait for Martin', { held: { path: error.path, reason: bounded(error.message) } });
    return undefined;
  }
  await git(dir, 'add', '--all');
  const pins = await git(
    dir,
    'diff',
    '--cached',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    'HEAD',
  );
  log('the pins', { move, pins });
  return pins;
}

/**
 * The lockfile after a coder's step that changed a manifest: in a pod whose `WORK` is a folder of its own, never the
 * volume the agent may still be writing to (`apps/factory/src/runners/jobs.ts`), on a fresh checkout of the step's commit, with the pins
 * committed on it and the coder's patch applied, `pnpm install --lockfile-only`, and only the lockfile's change
 * printed (`the lockfile`, with the patch: empty when it needs none).
 */
export async function lockfile(
  env = process.env,
  write = (line: string) => console.log(line),
  tools: Partial<PinTools> = {},
): Promise<void> {
  const log = runnerLog(env, 'prepare', write);
  const { step, dir, pnpmEnv } = await checkout(env, log);
  if (!step.change) throw new Error('A lockfile step names the change it writes the lockfile for.');
  if (step.pins) await commitPatch(dir, step.pins, { message: 'chore(deps): the pins', author: 'pins' });
  await writeLockfile(dir, step.change, { ...pinTools(env, pnpmEnv), ...tools });
  const written = await git(
    dir,
    'diff',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    'HEAD',
    '--',
    'pnpm-lock.yaml',
    '**/pnpm-lock.yaml',
  );
  log('the lockfile', { lockfile: written });
}

const pinTools = (env: NodeJS.ProcessEnv, pnpmEnv: NodeJS.ProcessEnv): PinTools => ({
  pnpm: pnpmIn(pnpmEnv),
  get: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }),
  aside: prepareDir(env),
});

/** The prepare pod's own folder, which only it can write: never a folder others share, such as the system's. */
function prepareDir(env: NodeJS.ProcessEnv): string {
  if (!env.PREPARE) throw new Error('PREPARE is not set: the prepare pod names its own folder there.');
  return env.PREPARE;
}

/**
 * A fresh checkout of the step's commit, with its base, a dry run's commits and its seed, and the pnpm that runs: on
 * the volume (`repoDir`), or in `dir`.
 */
async function checkout(env: NodeJS.ProcessEnv, log: Log, dir = repoDir(env)) {
  const step = stepFrom(env);
  // Only `rm`, which reads nothing it deletes, touches what the agent left.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '--quiet');
  await git(dir, 'fetch', '--quiet', '--depth=1', step.repository, step.commit);
  await git(dir, 'checkout', '--quiet', '--detach', step.commit);
  log('checked out the commit', { commit: step.commit, repository: step.repository });
  if (step.base) {
    await fetchBase(dir, step.repository, step.commit, step.base);
    log('named its base, with the commits since', { base: step.base });
  }
  for (const { message, patch } of step.commits ?? []) {
    await commitPatch(dir, patch, { message, author: 'dry-run' });
  }
  if (step.commits?.length) log("made the dry run's commits on it", { commits: step.commits.length });
  if (step.seed) {
    await commitPatch(dir, step.seed, { message: SEED_MESSAGE, author: 'runner' });
    log('applied the seed, and committed it as the base');
  } else {
    await settleTimes(dir);
  }
  const pnpmEnv = { ...env, ...OWN_PNPM, CI: 'true' };
  const runs = (await exec('pnpm', [OWN_PNPM_FLAG, '--version'], { cwd: dir, env: pnpmEnv })).stdout.trim();
  const named = await namedPnpm(dir);
  log('runs its own pnpm', { pnpm: runs, packageManager: named ?? null });
  samePnpmMajor(named, runs);
  return { step, dir, pnpmEnv };
}

/**
 * The pnpm version a checkout names, if it names pnpm: by `packageManager`, or by `devEngines.packageManager`, whose
 * version may be a range.
 */
export async function namedPnpm(dir: string): Promise<string | undefined> {
  const manifest = await readFile(join(dir, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text) as { packageManager?: unknown; devEngines?: { packageManager?: unknown } })
    .catch(() => undefined);
  if (typeof manifest?.packageManager === 'string') {
    return /^pnpm@(\d+\.\d+\.\d+[^+]*)/.exec(manifest.packageManager)?.[1];
  }
  const engines = [manifest?.devEngines?.packageManager].flat() as { name?: unknown; version?: unknown }[];
  const pnpm = engines.find((engine) => engine?.name === 'pnpm');
  return typeof pnpm?.version === 'string' ? pnpm.version : undefined;
}

/** Fails, saying so, when the pnpm a checkout names is of another major than the one that runs. */
export function samePnpmMajor(named: string | undefined, runs: string): void {
  const major = (version: string) => /\d+/.exec(version)?.[0];
  if (!named || major(named) === major(runs)) return;
  throw new Error(
    `The checkout asks for pnpm ${named}, and the runner runs pnpm ${runs}: pnpm moves to a new major in both ` +
      "repositories, and the runner image's pnpm is this repository's (mise.lock).",
  );
}

/** Times the history between a step's commit and its base is deepened before the prepare step gives up. */
const DEEPENINGS = 10;

/**
 * Fetches a step's base, names it `base`, and deepens the commit's history until it meets it, so `git log base..HEAD`
 * lists every commit of the change and nothing older: the coder's commit of each round, and any merge of main. Both
 * start without their history; each deepening doubles what is fetched, and deepens the base's as well, so a commit
 * of main that the change's history reaches is known as one of the base's too. Commits the change has but the base
 * has not are complete once none of them is a shallow root.
 */
async function fetchBase(dir: string, repository: string, commit: string, base: string): Promise<void> {
  await git(dir, 'fetch', '--quiet', '--depth=1', repository, base);
  await git(dir, 'branch', 'base', base);
  for (let deepen = 1, tries = 0; tries < DEEPENINGS; deepen *= 2, tries++) {
    const shallow = new Set(await shallowRoots(dir));
    const since = (await git(dir, 'rev-list', 'HEAD', '--not', 'base')).split('\n').filter(Boolean);
    if (!since.some((sha) => shallow.has(sha))) return;
    await git(dir, 'fetch', '--quiet', `--deepen=${deepen}`, repository, commit);
  }
}

/** The shallow roots of a checkout, from the file git keeps them in: none when the file is not there. */
async function shallowRoots(dir: string): Promise<string[]> {
  const file = (await git(dir, 'rev-parse', '--git-path', 'shallow')).trim();
  const text = await readFile(join(dir, file), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean);
}

/**
 * Commits a patch on the checkout's head, by `author`, at the seed's time and under `message`, and gives every file
 * that time: the same patch on the same commit makes the same sha on every run. The patch reaches `git apply` on its
 * standard input, so no file is written for it; one `applied` already, as the pin step writes its pins, is committed
 * as the checkout has it.
 */
export async function commitPatch(
  dir: string,
  patch: string,
  { message, author }: { message: string; author: string },
  { applied = false } = {},
): Promise<void> {
  if (!applied) await gitInput(patch, dir, 'apply', '--whitespace=nowarn', '-');
  await git(dir, 'add', '--all');
  await gitWith(
    { GIT_AUTHOR_DATE: SEED_DATE, GIT_COMMITTER_DATE: SEED_DATE },
    dir,
    '-c',
    `user.name=${author}`,
    '-c',
    `user.email=${author}@factory.invalid`,
    'commit',
    '--quiet',
    '--message',
    message,
  );
  await settleTimes(dir);
}

/**
 * Gives every file of the checkout the same time, the seed's. A checkout's files take the time they were written,
 * and Claude Code lists what it finds by when each file last changed, so without this the same search answers in
 * another order on every run and a replay ends there. A link is given the time itself, not its target, which may be
 * outside the checkout or nowhere.
 */
async function settleTimes(dir: string): Promise<void> {
  const at = new Date(SEED_DATE);
  const files = (await git(dir, 'ls-files', '-z')).split('\0').filter(Boolean);
  await Promise.all(files.map((file) => lutimes(join(dir, file), at, at)));
}
