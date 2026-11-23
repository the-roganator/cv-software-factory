/**
 * The scan's making of the moves no pin's line writes (github/made.ts): vulnerabilities.yml's `pins` job runs this
 * after the scan, with the scan's state key alone, from this repository's whole checkout at the workflow's commit, on a
 * checkout of the commit the scan read, in either repository.
 *
 *     node scripts/pins.ts <moves.json> <state.sealed> <checkout> <out>
 *
 * It opens the run's state for what `moves.json` withholds, as the GitHub worker does (github/scanning.ts's
 * `joined`), and makes each move the pin step makes, grouped by the files it writes, each group on a worktree of its
 * own at that commit, in the order of `moves.json` (scripts/derive.ts), as of the scan's time (`judged`): in the
 * factory those of the worker's lanes, which the pin watch commits; in the app those of the line's, whose pin step makes
 * them again with the digests this step was given. The review gate makes them again on main's tip, as of the same
 * time and with the same digests. What it made is sealed with the key, for this repository and run, and written to
 * `<out>`, the artifact `pins`: it names the packages a lockfile's moves withhold.
 *
 * It prints what it made by group and count alone, and a move the step refused by its place in `moves.json`: never a
 * package or the step's words, which the sealed file keeps for the worker's log.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  groupKey,
  groupOf,
  MADE_VERSION,
  type Made,
  type MadeGroup,
  type MadeStep,
  madeByLine,
  madeByStep,
  sealMade,
  stepOf,
} from '../apps/factory/src/github/made.ts';
import { joined, MOVES_FILE_SCHEMA, type ReadMove } from '../apps/factory/src/github/scanning.ts';
import { APP_REPOSITORY } from '../apps/factory/src/repositories.ts';
import type { MovesFile } from '../apps/factory/src/vulnerabilities/moves.ts';
import { open, readKey, STATE_KEY } from '../apps/factory/src/vulnerabilities/state.ts';
import { askedList, lockedVersions, type Move as PinStepMove } from '../apps/runner/src/pins.ts';
import { type Derivation, deriveOn, gitIn } from './derive.ts';

/** The state's key, read once and out of the environment before anything runs. */
const KEY = process.env[STATE_KEY];
delete process.env[STATE_KEY];

/** The lanes whose moves the pin watch commits (github/pins.ts). */
const PULL_LANES = new Set(['worker', 'cluster']);

/** Whether the pin step makes a move: in the factory one the pin watch commits, in the app one the line makes. */
const stepMakes = (move: ReadMove, app: boolean) =>
  app ? move.lane === 'line' && madeByLine(move) : PULL_LANES.has(move.lane) && madeByStep(move);

/** The most of the step's words kept for one refusal. */
const MOST_WORDS = 4000;

const words = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, MOST_WORDS);

/** The moves to make, by group, in the order of `moves.json`. */
export function groupsOf(moves: readonly ReadMove[], repository: string): Map<string, ReadMove[]> {
  const out = new Map<string, ReadMove[]>();
  for (const move of moves) {
    if (!stepMakes(move, repository === APP_REPOSITORY)) continue;
    const key = groupKey(groupOf(move));
    out.set(key, [...(out.get(key) ?? []), move]);
  }
  return out;
}

/** What each made move moved, as its diff shows it: a package's versions in the lockfile, or the step's own. */
function stepsOf(
  made: readonly { index: number; step: PinStepMove }[],
  before: (path: string) => string,
  after: Map<string, string>,
): MadeStep[] {
  return made.map(({ index, step }) => {
    if (step.ecosystem !== 'npm')
      return { move: index, ecosystem: step.ecosystem, name: step.name, before: [step.from], after: [step.to] };
    const lock = 'pnpm-lock.yaml';
    return {
      move: index,
      ecosystem: step.ecosystem,
      name: step.name,
      before: lockedVersions(before(lock), step.name),
      after: lockedVersions(after.get(lock) ?? before(lock), step.name),
    };
  });
}

/**
 * Makes one group's moves on a worktree of the checkout at its commit, as of the scan's time (`asOf`), keeping each
 * digest a tag was found at. The factory's checkout is a workspace whose projects name each other; the app's is held to
 * the registry, as its line's and the gate's are.
 */
export async function makeGroup(
  checkout: string,
  moves: readonly ReadMove[],
  work: string,
  derive: (dir: string, steps: PinStepMove[], derivation: Derivation) => Promise<Map<string, string>> = deriveOn,
  asOf?: number,
): Promise<MadeGroup> {
  const { files, major } = groupOf(moves[0] as ReadMove);
  const dir = join(work, 'checkout');
  await gitIn(checkout)('worktree', 'add', '--quiet', '--detach', dir, 'HEAD');
  try {
    const before = (path: string) => {
      try {
        return readFileSync(join(dir, path), 'utf-8');
      } catch {
        return '';
      }
    };
    const refused: MadeGroup['refused'] = [];
    const steps: { index: number; step: PinStepMove }[] = [];
    const lock = before('mise.lock');
    for (const move of moves) {
      const step = stepOf(move, lock || undefined);
      if (typeof step === 'string') refused.push({ move: move.index, reason: step });
      else steps.push({ index: move.index, step });
    }
    const lockBefore = new Map([['pnpm-lock.yaml', before('pnpm-lock.yaml')]]);
    const refusedSteps = new Set<PinStepMove>();
    const own = join(work, 'derive');
    mkdirSync(own);
    const asked = new Map<string, string>();
    const changed = await derive(
      dir,
      steps.map(({ step }) => step),
      {
        work: own,
        workspace: (moves[0] as ReadMove).repository !== APP_REPOSITORY,
        token: process.env.GH_TOKEN,
        asOf,
        asked,
        refused: (step, error) => {
          refusedSteps.add(step);
          const index = steps.find((each) => each.step === step)?.index;
          if (index !== undefined) refused.push({ move: index, reason: words(error) });
        },
      },
    );
    const made = steps.filter(({ step }) => !refusedSteps.has(step));
    return {
      files,
      major,
      moves: made.map(({ index }) => index),
      refused: refused.sort((a, b) => a.move - b.move),
      changed: [...changed].map(([path, text]) => ({ path, text })).sort((a, b) => (a.path < b.path ? -1 : 1)),
      steps: stepsOf(made, (path) => lockBefore.get(path) ?? before(path), changed),
      asked: askedList(asked),
    };
  } finally {
    await gitIn(checkout)('worktree', 'remove', '--force', dir).catch(() => {});
  }
}

async function main(argv: string[]) {
  const [movesPath, statePath, checkout, out] = argv;
  if (!movesPath || !statePath || !checkout || !out) {
    console.error('Usage: node scripts/pins.ts <moves.json> <state.sealed> <checkout> <out>');
    process.exit(2);
  }
  if (!KEY) throw new Error(`the pins job holds no ${STATE_KEY} to read the scan's state with`);
  const key = readKey(KEY);
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const run = process.env.GITHUB_RUN_ID ?? '';
  const file = MOVES_FILE_SCHEMA.parse(JSON.parse(readFileSync(movesPath, 'utf-8'))) as MovesFile;
  const state = open(readFileSync(statePath), key, repository, run);
  const scanRun = { id: Number(run), event: '', conclusion: null, headSha: '', updatedAt: '', url: '' };
  const { moves } = joined(repository, scanRun, file, state);
  const commit = (await gitIn(checkout)('rev-parse', 'HEAD')).trim();
  const groups: MadeGroup[] = [];
  for (const each of groupsOf(moves, repository).values()) {
    const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'pins-'));
    try {
      const group = await makeGroup(checkout, each, work, deriveOn, Date.parse(file.judged));
      groups.push(group);
      console.log(
        `${group.files.join(', ')}${group.major ? ' (major)' : ''}: made ${group.moves.length} of ${each.length} moves, wrote ${group.changed.length} files${group.refused.length ? `; the step refused move ${group.refused.map((r) => r.move).join(', ')} of moves.json` : ''}.`,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  if (!groups.length) console.log('No move of the day is one the pin step makes.');
  const made: Made = { version: MADE_VERSION, repository, run, commit, groups };
  writeFileSync(out, sealMade(made, key));
}

if (import.meta.main) {
  await main(process.argv.slice(2));
  process.exit();
}
