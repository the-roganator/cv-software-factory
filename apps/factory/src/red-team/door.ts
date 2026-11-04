/**
 * The GitHub worker's attack door, as the harness calls it (apps/factory/src/github/attacks.ts): one POST an attack,
 * which the worker makes with content fixed in its own code and answers with each refusal signed. The door is on a
 * port of its own, which only the harness's pod may reach (a NetworkPolicy), because attack 2 asks GitHub past the
 * guard, which the line must never be able to do.
 *
 * The call may be slow: attack 3 opens a pull request and waits for the app's gates and the review check before it
 * reads the verdict. The worker holds the request until the attempt is done, so the harness makes one call an attack,
 * over `node:http` rather than `fetch`, whose headers timeout (five minutes) would give up on it; the call keeps to
 * the attack's remaining limit, and gives up when the harness stops.
 */
import { request } from 'node:http';
import { z } from 'zod';
import { SIGNED_MECHANISMS } from '../signed-refusals.ts';
import type { AttackDoor, DoorResult } from './github.ts';

/**
 * What the door answers, read strictly: the harness relays each refusal into the store as the GitHub worker gave it,
 * so an answer in another shape is an error here, not an event the store refuses later. The store's own checks on an
 * `action.refused` still apply to what is relayed.
 */
const SIGNED_REFUSAL = z.object({
  repo: z.string(),
  number: z.number().int().positive().nullable(),
  at: z.string(),
  payload: z.object({
    mechanism: z.enum(SIGNED_MECHANISMS),
    action: z.string(),
    output: z.string(),
    guardrails: z.array(z.number().int()),
    subject: z.object({ kind: z.string(), name: z.string() }).optional(),
  }),
  record: z.string(),
  signature: z.string().optional(),
});
const DOOR_RESULT = z.object({
  refusals: z.array(SIGNED_REFUSAL),
  pullRequest: z.object({ repository: z.string(), number: z.number().int().positive(), head: z.string() }).optional(),
  gotThrough: z.object({ what: z.string() }).optional(),
  unconcluded: z.object({ what: z.string() }).optional(),
});
const DOOR_ERROR = z.object({ error: z.string().optional(), message: z.string().optional() });

/** The most bytes an answer may have: a few signed refusals, each with an output of at most 4000 characters. */
const MOST_ANSWER_BYTES = 256 * 1024;

/** One POST to the door, held open as long as `signal` allows: the status and the body, parsed as JSON. */
function post(url: URL, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2 }, signal },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MOST_ANSWER_BYTES) {
            res.destroy(new Error(`the attack door's answer is over ${MOST_ANSWER_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) });
          } catch (error) {
            reject(new Error(`the attack door answered ${res.statusCode} with no JSON: ${String(error)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

export function attackDoor(url: string, send: typeof post = post): AttackDoor {
  const base = url.replace(/\/$/, '');
  return async (attack, { signal, limitMs }) => {
    // Within the attack's own limit, and no longer: a door that holds the call past it would end the attack late,
    // after the line has paged it unfinished and the admin service let the next one be launched.
    const within = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, limitMs))]);
    const { status, body } = await send(new URL(`${base}/v1/attacks/${attack}`), within);
    if (status < 200 || status >= 300) {
      const said = DOOR_ERROR.safeParse(body);
      const why = said.success ? (said.data.message ?? said.data.error ?? '') : '';
      throw new Error(`the GitHub worker's attack door answered ${status}: ${why}`);
    }
    const result = DOOR_RESULT.safeParse(body);
    if (!result.success) {
      throw new Error(
        `the GitHub worker's attack door answered in a shape the harness does not read: ${result.error.message}`,
      );
    }
    return result.data as DoorResult;
  };
}
