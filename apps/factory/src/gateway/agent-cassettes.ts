/**
 * Cassettes for agents' calls: a Messages API response, recorded so that a runner's step can be replayed exactly,
 * call by call, and a step run again after a change pays only from the first call that differs.
 *
 * Two runs of the same agent on the same work send requests that differ in a few places: the request's metadata (a
 * session id); the date written into the prompt; the times the tools the agent runs print, such as how long Vitest
 * and Biome took and when the checkout's files were written; and the order of the results of tools the agent ran at
 * once, which come back as each finishes. The key leaves out the first three, without the colours a tool printed
 * them in, and puts those results in the order of their ids. Runners work in a fixed folder, on a seed committed at
 * a fixed time, so everything else that reaches the key is the work itself. A tool's time the key does not know
 * ends a replay at the call it reaches. The provider is part of the key, so a local model's recording never stands
 * in for Claude's.
 *
 * A cassette is `<key>.json` beside the judgements' cassettes, and holds the request as keyed and the response body
 * as it came over the wire: JSON, or the server-sent events of a stream.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const agentCassette = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.literal('messages'),
  provider: z.enum(['anthropic', 'local']),
  model: z.string().min(1),
  recordedAt: z.iso.datetime(),
  /** The request as keyed: what was sent, without what changes between identical runs. */
  request: z.record(z.string(), z.unknown()),
  stream: z.boolean(),
  response: z.string(),
});

export type AgentCassette = z.infer<typeof agentCassette>;

/** A cassette whose contents do not match its key: changed, or written by something else. */
export class CassetteDamaged extends Error {
  override name = 'CassetteDamaged';
}

/**
 * What changes from one run to the next and nothing else does, as it appears in a request's JSON, and what stands in
 * for it. A tool's output is a string in the JSON, so a line of it ends at `\\n` or at the string's end.
 */
const UNSTEADY: [RegExp, string][] = [
  // A terminal's colours, as `\u001b[34m`: they fall between the words a pattern below looks for.
  [/\\u001b\[[0-9;]*m/g, ''],
  [/Today's date is [^.\n"\\]+/g, "Today's date is (the day of the run)"],
  // Vitest: when it started, how long it took, and how long each test file and test took. It prints a test's time
  // only when the test is slow, so one near the threshold has a time in one run and none in the next: the key
  // drops that time rather than standing in for it. A test whose own name ends in a time loses it too, harmlessly.
  [/Start at {2}\d{2}:\d{2}:\d{2}/g, 'Start at  (the time)'],
  [/Duration {2}\d+(?:\.\d+)?m?s(?: \([^)"\\]*\))?/g, 'Duration  (how long)'],
  [/([✓×❯↓] [^"\\]*?) \d+(?:\.\d+)?m?s(?=\\n|")/g, '$1'],
  // Biome: `Checked 2 files in 7ms.`, and its formatter's `Formatted 1 file in 2ms.`
  [/((?:Checked|Formatted) \d+ files? in )\d+(?:\.\d+)?(?:µs|ms|s)/g, '$1(how long)'],
  // `ls -l`: a file's time, `Oct  5 23:14`, or its year when it is older, `Oct  5  2025`.
  [/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d (?:\d{2}:\d{2}| \d{4}) /g, '(a time) '],
];

/** A request as its cassette is keyed: without its metadata, and without what changes between identical runs. */
export function keyedRequest(body: Record<string, unknown>): Record<string, unknown> {
  const { metadata: _, ...rest } = body;
  const messages = Array.isArray(rest.messages) ? { messages: rest.messages.map(resultsInOrder) } : {};
  const json = UNSTEADY.reduce(
    (text, [pattern, stand]) => text.replace(pattern, stand),
    JSON.stringify({ ...rest, ...messages }),
  );
  return JSON.parse(json);
}

interface Block {
  type?: unknown;
  tool_use_id?: unknown;
}

/** A message with its tools' results in the order of their ids, each in a place a result held. */
function resultsInOrder(message: unknown): unknown {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return message;
  const isResult = (block: Block) => block?.type === 'tool_result';
  const results = (content as Block[])
    .filter(isResult)
    .map((block) => [String(block.tool_use_id), block] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, block]) => block);
  if (results.length < 2) return message;
  return { ...(message as object), content: (content as Block[]).map((b) => (isResult(b) ? results.shift() : b)) };
}

export function agentCassetteKey(provider: string, request: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(['messages', provider, request]))
    .digest('hex');
}

export class AgentCassettes {
  readonly #dirs: readonly string[];
  readonly #recordTo: string | undefined;

  constructor({ record, read = [] }: { record?: string | undefined; read?: readonly string[] }) {
    this.#recordTo = record;
    this.#dirs = [...(record ? [record] : []), ...read];
  }

  /** The cassette for a key from the first folder that has one, or undefined. A damaged one is an error. */
  find(key: string): AgentCassette | undefined {
    for (const dir of this.#dirs) {
      const file = join(dir, `${key}.json`);
      if (!existsSync(file)) continue;
      const damaged = new CassetteDamaged(`Cassette ${file} is damaged: its contents do not match its key.`);
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(file, 'utf-8'));
      } catch {
        throw damaged;
      }
      const parsed = agentCassette.safeParse(json);
      if (!parsed.success || agentCassetteKey(parsed.data.provider, parsed.data.request) !== key) throw damaged;
      return parsed.data;
    }
    return undefined;
  }

  record(cassette: AgentCassette): void {
    if (!this.#recordTo) throw new Error('This gateway has no folder to record cassettes in.');
    mkdirSync(this.#recordTo, { recursive: true });
    const file = join(this.#recordTo, `${cassette.key}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(cassette, null, 2)}\n`);
    renameSync(temporary, file);
  }
}
