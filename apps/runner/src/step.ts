/**
 * What a runner's job is told, through its environment, and what it hands back. The line writes the first and reads
 * the second (`apps/factory/src/runners`); the shapes are here so both sides agree.
 *
 *     RUNNER_STEP   the step, as JSON (`Step`)
 *     WORK          the job's volume, which lives until the work item merges or ends (default /work)
 *     PREPARE       the prepare pod's own folder, empty each time, for what it must not share with the agent
 *     RUNNER_JOB, RUNNER_WORK_ITEM   the step's job and work item, which each line it prints names (`log.ts`)
 *
 * The agent pod also has ANTHROPIC_BASE_URL (the gateway), ANTHROPIC_API_KEY (its job token, which is not a key) and
 * HANDBACK_URL (the line's handback endpoint). The prepare pod has neither.
 *
 * A step that asks for a result has the agent write it as JSON to `$WORK/out/result.json`: on the volume, outside the
 * checkout, so it is never part of the patch. The agent pod reads it and hands it back beside the patch; the line
 * checks it against the agent's own schema. A field of prose, such as a pull request's description, the agent writes
 * as a file of its own beside the result (`resultFiles`): Markdown is easier to write well as a file than inside a
 * JSON string. The agent pod reads each into its field.
 */
import { join } from 'node:path';
import { z } from 'zod';
import type { Move } from './pins.ts';

export interface Step {
  /** The agent: planner, coder, reviewer or describer. */
  agent: string;
  /** The app's repository, to clone over HTTPS, and the commit to start from. */
  repository: string;
  commit: string;
  /**
   * The commit a change is measured from, for a step that reads a change rather than making one (the reviewer's):
   * fetched beside `commit` with every commit between them, and named `base` in the checkout, so `git diff base` is
   * the change and `git log base..HEAD` its commits. Such a step takes no seed.
   */
  base?: string;
  /** What the agent is asked to do. */
  prompt: string;
  /** The skill the prompt names, which the runner tells the agent to use rather than leaving it to choose. */
  skill?: string;
  maxTurns: number;
  /** The agent's own session to carry on, for a round after review. */
  resume?: string;
  /**
   * A patch applied to the checkout before the agent starts, and committed as its base: the smoke run's seeded
   * defect, in a scratch copy of the app. Never set for real work.
   */
  seed?: string;
  /**
   * Commits to make on `commit` before the step starts, each a patch and its message, oldest first: a dry run's
   * pushes, which GitHub never had. They are the pull request's own commits, so with a base they are part of the
   * change, and `git log base..HEAD` lists them. Never set for live work, whose commits GitHub has.
   */
  commits?: { message: string; patch: string }[];
  /** Whether the step ends with a structured result, written to `resultPath`. */
  result?: boolean;
  /** Fields of the result the agent writes as files of their own beside it, by field: their file names in `out/`. */
  resultFiles?: Record<string, string>;
  /**
   * A dependency's move, which the pin step writes before the agent starts and commits as its base (`pins.ts`): only
   * on a dependency's work item, before its pull request has the move.
   */
  move?: Move;
  /** For the lockfile step (`runner lockfile`): the pin step's earlier patch, committed on the commit first. */
  pins?: string;
  /** For the lockfile step: the coder's patch, applied on the pins, whose manifests the lockfile is written for. */
  change?: string;
}

export type Ending = 'finished' | 'max-turns' | 'failed';

/** What the agent pod sends the line's handback endpoint at the end of its step. */
export interface Handback {
  ending: Ending;
  /** The changes the agent made to the checkout, as a unified diff against where it started. Empty for none. */
  patch: string;
  /** The agent's last word: for the coder, a short note of the decisions it made. */
  note: string;
  turns: number;
  /** The agent's session, to resume in a later round. */
  session: string | null;
  /** Why the step failed, when it did: the SDK's own words. */
  error?: string;
  /** The agent's structured result, when the step asked for one and the agent wrote it as JSON. */
  result?: unknown;
}

/** The most a result may be, as JSON. */
export const RESULT_BYTES = 64 * 1024;
/** The most fields of a result a step may have written as files of their own. */
export const RESULT_FILES = 4;

export const work = (env = process.env) => env.WORK ?? '/work';
export const repoDir = (env = process.env) => join(work(env), 'repo');
/** Where the agent writes its result: on the volume, beside the checkout and not in it. */
export const resultPath = (env = process.env) => join(work(env), 'out', 'result.json');
/** Where the agent writes a field of its result that is a file of its own. */
export const resultFilePath = (name: string, env = process.env) => join(work(env), 'out', name);

const STEP = z
  .strictObject({
    agent: z.string().min(1),
    repository: z.url(),
    commit: z.string().regex(/^[0-9a-f]{40}$/, 'a full commit sha'),
    base: z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'a full commit sha')
      .optional(),
    prompt: z.string().min(1),
    skill: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,40}$/, 'a skill’s name')
      .optional(),
    maxTurns: z.number().int().positive(),
    resume: z.string().optional(),
    seed: z.string().optional(),
    commits: z
      .array(z.strictObject({ message: z.string().min(1).max(10_000), patch: z.string().min(1) }))
      .max(20)
      .optional(),
    result: z.boolean().optional(),
    resultFiles: z
      .record(z.string().regex(/^[a-z][A-Za-z]{0,30}$/), z.string().regex(/^[a-z][a-z0-9-]{0,40}\.md$/, 'a file name'))
      .refine((files) => Object.keys(files).length <= RESULT_FILES, `at most ${RESULT_FILES} files`)
      .optional(),
    move: z
      .strictObject({
        ecosystem: z.enum(['npm', 'node', 'docker']),
        // One word each, as the work item names them: they reach a command line as arguments, never a shell.
        name: z
          .string()
          .regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w./:-]*$/, 'a package, an image or node')
          .max(200),
        from: z
          .string()
          .regex(/^[\w.:@+-]+$/, 'a version, or a tag and its digest')
          .max(200),
        to: z
          .string()
          .regex(/^[\w.:@+-]+$/, 'a version, or a tag and its digest')
          .max(200),
      })
      .optional(),
    pins: z.string().min(1).optional(),
    change: z.string().min(1).optional(),
  })
  // A seed is committed on the commit, so `git diff base` would show it as part of the change.
  .refine((step) => !(step.seed && step.base), { message: 'a step with a base reads a change, and takes no seed' })
  // The files are fields of the result: with no result, nothing would read them.
  .refine((step) => !step.resultFiles || step.result, { message: 'a step’s result files are part of its result' });

export function stepFrom(env = process.env): Step {
  const text = env.RUNNER_STEP;
  if (!text) throw new Error('RUNNER_STEP is not set: the job says what to do there.');
  const parsed = STEP.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `RUNNER_STEP is not a step (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`,
    );
  }
  return parsed.data as Step;
}
