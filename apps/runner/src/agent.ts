/**
 * The agent step, in the agent pod: the one of a runner's two pods that reaches the gateway and the line's handback,
 * and nothing else. It holds no credential: its job token is good for its work item and agent, at the gateway and
 * the handback, until the job ends.
 *
 * 1. It checks its own fence before it starts: the network policy that holds it reaches a pod a moment after the
 *    pod starts, so it waits until the internet is out of reach and the gateway is in it.
 * 2. It runs the agent on the Agent SDK (Claude Code), in the checkout the prepare pod left, with the gateway as
 *    its API and the step's turn limit. The working folder and the system prompt are the same on every run, so the
 *    gateway's cassettes replay a step run again. A step that names a skill has that one skill, from the runner's
 *    own plugin (`../plugin`), and is told to use it; a step that names none has no skills at all, and asks the model
 *    exactly what it asked before skills came in, so its cassettes still replay.
 * 3. It says what the agent does as it does it, a JSON line each (`log.ts`): each turn, each tool it calls, by name
 *    alone, and each call that failed. Never what a tool was given or gave back.
 * 4. It ends with the agent's result: it closes the SDK's query and ends whatever the agent's tools left running
 *    (`processes.ts`), rather than wait on a command Claude Code moved to the background.
 * 5. It hands back a patch of what the agent changed and the agent's last word, and its structured result when the
 *    step asks for one. The patch is data: the line checks it against the spec's scope, and the GitHub worker
 *    applies it outside the sandbox. The result is data too: the line reads it through the agent's schema.
 */
import { constants } from 'node:fs';
import { access, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { git } from './git.ts';
import { bounded, cutTo, type Log, runnerLog } from './log.ts';
import { descendants, endAll, type Proc, processTable } from './processes.ts';
import {
  type Ending,
  type Handback,
  RESULT_BYTES,
  repoDir,
  resultFilePath,
  resultPath,
  type Step,
  stepFrom,
} from './step.ts';

/** Somewhere on the internet the fence must keep the pod from, by address: the pod has no DNS. */
const CANARY = 'https://1.1.1.1';
const FENCE_WAIT_MS = 60_000;
const NOTE_LENGTH = 4000;
/** What a pod can be asked to hand back. */
const PATCH_BYTES = 1024 * 1024;

/**
 * How an attempt to reach an address went: reached it; blocked, as a network policy blocks (the connection refused,
 * reset or never answered); or failed some other way, such as a name that does not resolve, which proves nothing
 * about a fence.
 */
export async function attempt(url: string): Promise<'reached' | 'blocked' | 'unclear'> {
  try {
    // Any answer is a reach, a redirect too: one followed to a name the pod cannot resolve would read as unclear.
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return 'reached';
  } catch (error) {
    const code = ((error as Error)?.cause as { code?: string } | undefined)?.code ?? (error as Error)?.name;
    const blocks = [
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
      'TimeoutError',
    ];
    return blocks.includes(code ?? '') ? 'blocked' : 'unclear';
  }
}

/**
 * Waits until the pod is fenced: the canary blocked, as a policy blocks it, and the gateway reached. A canary that
 * cannot be resolved, or answers oddly, is not taken for a fence.
 */
export async function awaitFence(gateway: string, canary = CANARY, waitMs = FENCE_WAIT_MS): Promise<void> {
  const until = Date.now() + waitMs;
  for (;;) {
    const [out, gate] = await Promise.all([attempt(canary), attempt(`${gateway}/health`)]);
    if (out === 'blocked' && gate === 'reached') return;
    if (Date.now() > until) {
      throw new Error(
        gate !== 'reached'
          ? 'This pod cannot reach the gateway.'
          : `This pod's way to ${canary} is ${out}, not blocked: its fence is not shown to be up.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * The tools an agent may use: its checkout's files and a shell. Not the web (WebSearch asks the model's API for a
 * search, WebFetch reaches out), and not Claude Code's agents, schedules or worktrees.
 */
export const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];

/**
 * The runner's plugin, which holds every skill a step may name: in the image, read-only, beside this module. Not the
 * checkout's skills, nor any in the agent's home on the volume: the SDK is given no setting sources.
 */
export const PLUGIN = { name: 'factory', path: fileURLToPath(new URL('../plugin', import.meta.url)) };

/** A skill by the name the agent knows it by: the plugin's name, then the skill's. */
const skillName = (skill: string) => `${PLUGIN.name}:${skill}`;

/** What the SDK is given for a step's skill: the plugin, that skill alone, and the tool that loads it. */
async function skillOptions(step: Step) {
  if (!step.skill) return { tools: TOOLS };
  try {
    await access(join(PLUGIN.path, 'skills', step.skill, 'SKILL.md'));
  } catch {
    throw new Error(`The runner holds no skill called ${step.skill}.`);
  }
  return {
    tools: [...TOOLS, 'Skill'],
    plugins: [{ type: 'local' as const, path: PLUGIN.path }],
    skills: [skillName(step.skill)],
  };
}

/**
 * The system prompt's addition: who the agent is, which skill to use, where its result goes, and what its last
 * message is for.
 */
function instructions(step: Step, result: string, env: NodeJS.ProcessEnv): string {
  const files = Object.entries(step.resultFiles ?? {}).map(
    ([field, name]) => `its \`${field}\` to ${resultFilePath(name, env)}, as Markdown`,
  );
  return [
    `You are the factory's ${step.agent}, working in a checkout of the app's repository with no network.`,
    step.skill ? `Use the ${skillName(step.skill)} skill for this step.` : '',
    step.result
      ? `Write the step's result, as JSON, to ${result}: it is handed back beside your changes and is not one of them.`
      : '',
    files.length ? `Leave out of the JSON, and write as a file of its own, ${files.join(', and ')}.` : '',
    'Your last message is handed back with your changes: make it a short note of the decisions you made, for the next reader.',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface AgentOptions {
  /** False only in tests, which run without a cluster's network policy. */
  checkFence?: boolean;
  /** Where its JSON lines go (`log.ts`). */
  log?: (line: string) => void;
}

/**
 * Says, of each message the Agent SDK gives, what the agent is doing: a turn as it starts, with the model that answered
 * it, each tool it calls, and each call that failed, by the tool's name. A streamed turn comes as one message a block, all with the turn's id.
 */
export function narrator(log: Log): (message: SDKMessage) => void {
  let turn = 0;
  let current: string | undefined;
  const tools = new Map<string, string>();
  return (message) => {
    if (message.type === 'system' && message.subtype === 'init') {
      // Not the SDK's model, which no call uses: the gateway sends each to the policy's, and each turn names it.
      log('the agent started', { session: message.session_id });
    } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      if (message.message.id !== current) {
        current = message.message.id;
        // The model that answered, from the gateway's reply: the policy's, whatever the SDK asked for.
        log('turn', { turn: ++turn, model: message.message.model });
      }
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue;
        tools.set(block.id, block.name);
        log('tool call', { turn, tool: block.name });
      }
    } else if (
      message.type === 'user' &&
      message.parent_tool_use_id === null &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result' && block.is_error) {
          log('a tool call failed', { level: 'warn', turn, tool: tools.get(block.tool_use_id) ?? null });
        }
      }
    } else if (message.type === 'result') {
      log('the agent ended', {
        ...(message.subtype === 'success' ? {} : { level: 'warn' }),
        subtype: message.subtype,
        turns: message.num_turns,
        durationMs: message.duration_ms,
      });
    }
  };
}

export async function runAgent(
  env = process.env,
  { checkFence = true, log: write = console.log }: AgentOptions = {},
): Promise<Handback> {
  const log = runnerLog(env, 'agent', write);
  const step = stepFrom(env);
  const gateway = env.ANTHROPIC_BASE_URL;
  if (!gateway || !env.ANTHROPIC_API_KEY) throw new Error('The gateway and the job token are not set.');
  if (checkFence) {
    await awaitFence(gateway);
    log('the fence is up: the gateway in reach, and the internet out of it');
  }
  const cwd = repoDir(env);
  // What the step started from, so a commit the agent makes is still part of its patch.
  const base = (await git(cwd, 'rev-parse', 'HEAD')).trim();
  // The volume outlives the step: a result left by an earlier one must not be handed back as this one's.
  const resultFile = resultPath(env);
  const resultFiles = Object.fromEntries(
    Object.entries(step.resultFiles ?? {}).map(([field, name]) => [field, resultFilePath(name, env)]),
  );
  await Promise.all([resultFile, ...Object.values(resultFiles)].map((file) => rm(file, { force: true })));
  await mkdir(dirname(resultFile), { recursive: true });
  const { tools, ...skill } = await skillOptions(step);

  let result: SDKResultMessage | undefined;
  let error: string | undefined;
  let leftover: Proc[] = [];
  const narrate = narrator(log);
  try {
    for await (const message of query({
      prompt: step.prompt,
      options: {
        cwd,
        maxTurns: step.maxTurns,
        tools,
        ...skill,
        ...(step.resume ? { resume: step.resume } : {}),
        // The sandbox is the fence: inside it, the agent needs no one's permission to edit or run.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // No settings from the checkout: a file in the app's repository cannot change how the agent runs.
        settingSources: [],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: instructions(step, resultFile, env),
          excludeDynamicSections: true,
        },
        env: {
          ...env,
          // Nothing leaves but model calls, and those go to the gateway.
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          DISABLE_AUTOUPDATER: '1',
        },
        stderr: (line) => log('the Agent SDK said', { level: 'warn', line: bounded(line.trimEnd()) }),
      },
    })) {
      narrate(message);
      if (message.type === 'result') {
        // The step ends with the agent's result. Claude Code would hold the session open while a command its tools
        // moved to the background runs, and then wake the agent to say it ended: the step has its result, so what
        // its tools started is snapshotted, the query is closed, and anything of theirs still running is ended.
        result = message;
        leftover = descendants(processTable());
        break;
      }
    }
  } catch (thrown) {
    error = (thrown as Error)?.message ?? String(thrown);
    log('the Agent SDK failed', { level: 'error', error: bounded(error) });
  }
  const ended = endAll(leftover);
  if (ended) log('ended what the agent’s tools left running', { processes: ended });

  if (!error && !result) error = 'The agent ended without a result.';
  if (!error && result?.subtype !== 'success') error = result?.errors.join('; ') || result?.subtype;
  const ending: Ending =
    result?.subtype === 'success' ? 'finished' : result?.subtype === 'error_max_turns' ? 'max-turns' : 'failed';
  let patch = await changes(cwd, base);
  const tooBig = Buffer.byteLength(patch) > PATCH_BYTES;
  if (tooBig) {
    patch = '';
    error = `The patch is over ${PATCH_BYTES} bytes, so none is handed back.`;
  }
  const written: { result?: unknown; problem?: string } = step.result ? await readResult(resultFile, resultFiles) : {};
  if (!error && written.problem) error = written.problem;
  return {
    ending: tooBig ? 'failed' : ending,
    patch,
    note: cutTo(result?.subtype === 'success' ? result.result : '', NOTE_LENGTH),
    turns: result?.num_turns ?? 0,
    session: result?.session_id ?? null,
    ...(error ? { error: cutTo(error, NOTE_LENGTH) } : {}),
    ...('result' in written ? { result: written.result } : {}),
  };
}

/**
 * The result the agent wrote, if it is JSON and small enough, with each field it wrote as a file of its own read in.
 * What it says is the line's to judge, against the agent's schema; here it is only carried. Each file's size is
 * checked before it is read, against what is left of `RESULT_BYTES`, so a runaway file ends in a clean refusal rather
 * than in the pod running out of memory.
 */
export async function readResult(
  file: string,
  files: Record<string, string> = {},
): Promise<{ result?: unknown; problem?: string }> {
  const tooBig = { problem: `The result is over ${RESULT_BYTES} bytes.` };
  let left = RESULT_BYTES;
  /**
   * A file's text, if it is a file and fits in what is left; `undefined` if there is none. It is opened once, without
   * waiting (a pipe would never end), and measured and read through that one handle, never more than fits.
   */
  const read = async (path: string): Promise<string | undefined | typeof tooBig> => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
    if (!handle) return undefined;
    try {
      const found = await handle.stat();
      if (!found.isFile()) return undefined;
      if (found.size > left) return tooBig;
      // One byte more than is left shows a file that grew since it was measured.
      const buffer = Buffer.alloc(left + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > left) return tooBig;
      left -= length;
      return buffer.toString('utf-8', 0, length);
    } finally {
      await handle.close();
    }
  };
  const text = await read(file);
  if (text === undefined) return { problem: 'The agent wrote no result.' };
  if (typeof text !== 'string') return text;
  let result: unknown;
  try {
    result = JSON.parse(text) as unknown;
  } catch {
    return { problem: 'The result is not JSON.' };
  }
  if (Object.keys(files).length) {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      return { problem: 'The result is not a JSON object, so it cannot take the fields written as files.' };
    }
    for (const [field, path] of Object.entries(files)) {
      const written = await read(path);
      if (written === undefined) return { problem: `The agent wrote no ${field}.` };
      if (typeof written !== 'string') return written;
      (result as Record<string, unknown>)[field] = written;
    }
  }
  // JSON escapes some characters as several, so the whole is measured again as it is handed back.
  if (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES) return tooBig;
  return { result };
}

/**
 * What the agent changed since the commit the step started from, as a patch: committed or not, since an agent may
 * commit its work. Nothing of the sandbox's history leaves it: each step starts from a fresh checkout of the branch's
 * head on GitHub, so a round's patch holds that round's changes on what GitHub has, and a refused patch leaves nothing
 * behind. Renames are written as a deletion and an addition, which every patch reader understands.
 */
export async function changes(cwd: string, base: string): Promise<string> {
  // The runner's own `.claude/` is no part of the work, whether the agent left it alone or committed it.
  const work = ['--', '.', ':(exclude).claude'];
  await git(cwd, 'add', '--all', ...work);
  return git(cwd, 'diff', '--cached', '--no-renames', '--no-ext-diff', '--no-color', base, ...work);
}

/** Hands the result back to the line, with the job token. */
export async function handBack(env: NodeJS.ProcessEnv, handback: Handback): Promise<void> {
  const url = env.HANDBACK_URL;
  if (!url) throw new Error('HANDBACK_URL is not set.');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ANTHROPIC_API_KEY}` },
    body: JSON.stringify(handback),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`The handback was refused: ${response.status} ${await response.text()}`);
}
