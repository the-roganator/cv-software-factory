/**
 * The GitHub worker, as the other workers call it (`github/server.ts`). Every action in GitHub goes through it: it
 * holds the App's key, and nothing else does. Reads go through it too (`reads.ts`), so it is the one place that
 * talks to GitHub.
 *
 * It calls the worker over `node:http`, not `fetch`: Node's `fetch` stops waiting for a response's headers after 300 s
 * whatever the caller's signal, and the worker answers a read only once it has read it all, which for `moves` can take
 * longer. Here the only limit is the call's own timeout.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { READ_AGAIN } from './client.ts';
import {
  type ActingFor,
  type ActionArgs,
  type ActionName,
  type ActionResult,
  AGENT_HEADER,
  type ReadArgs,
  type ReadName,
  type ReadResult,
  WORK_ITEM_HEADER,
} from './server.ts';

/**
 * What GitHub says of an issue that is gone (deleted or moved) or that the App may not change: asking again won't help.
 * The line reads a pull request it closes the same way (`#closePullRequest` in `line/worker.ts`), so a change here
 * changes when it gives up on one too.
 */
export const ISSUE_GONE = [403, 404, 410];

/** Whether an action failed on an issue that is gone, or that the App may not change. */
export const issueGone = (error: unknown) => error instanceof GitHubWorkerError && ISSUE_GONE.includes(error.status);

/**
 * The kind the worker answers, with a 409, when a read should simply be asked again (`scanning.ts`: a scan ran while
 * its moves were read). GitHub's own 409 or 422 is relayed as `conflict`, never as this.
 */
export { READ_AGAIN };

/** How long an action or a read may take. */
const TIMEOUT_MS = 120_000;

/**
 * The reads that page through more than GitHub answers in two minutes: `moves` reads every open alert of the scan, a
 * hundred to a page, one page after another (the factory's ten thousand took 108 s on 12 November).
 */
const READ_TIMEOUTS: Partial<Record<ReadName, number>> = { moves: 10 * 60_000 };

export class GitHubWorkerError extends Error {
  readonly status: number;
  readonly kind: string;
  /** The signed refusal the worker answered with, as it came: unverified (`../signed-refusals.ts`). */
  readonly refusal: unknown;

  constructor(status: number, kind: string, message: string, refusal?: unknown) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.refusal = refusal;
  }
}

/** Told of each refusal the worker answers an action with, and what the action was for, before the action fails. */
export type OnRefusal = (refusal: unknown, on: ActingFor) => void;

export class GitHubWorker {
  readonly #url: string;
  readonly #dryRun: boolean;
  readonly #onRefusal: OnRefusal | undefined;

  /**
   * With `dryRun`, every action is recorded by the worker and none is done. `onRefusal` is told of each refusal an
   * action is answered with, to relay; it must not throw, and the action fails as it would have.
   */
  constructor(url: string, { dryRun = false, onRefusal }: { dryRun?: boolean; onRefusal?: OnRefusal } = {}) {
    this.#url = url.replace(/\/$/, '');
    this.#dryRun = dryRun;
    this.#onRefusal = onRefusal;
  }

  /** `on` names the work item, and the agent, an action is taken for, for the worker's log of it. */
  async act<K extends ActionName>(
    action: K,
    repo: string,
    args: ActionArgs[K],
    on: ActingFor = {},
  ): Promise<ActionResult<K>> {
    try {
      return await this.#post(`actions/${action}`, repo, args, {
        ...(this.#dryRun ? { 'x-factory-dry-run': 'true' } : {}),
        ...(on.workItem ? { [WORK_ITEM_HEADER]: on.workItem } : {}),
        ...(on.agent ? { [AGENT_HEADER]: on.agent } : {}),
      });
    } catch (error) {
      if (error instanceof GitHubWorkerError && error.refusal !== undefined) this.#onRefusal?.(error.refusal, on);
      throw error;
    }
  }

  /**
   * Reads from GitHub. In a dry run, what the dry run made (a branch, a commit, a pull request) reads as it would
   * have been, and anything else as GitHub has it.
   */
  async read<K extends ReadName>(read: K, repo: string, args: ReadArgs[K]): Promise<ReadResult<K>> {
    const headers = this.#dryRun ? { 'x-factory-dry-run': 'true' } : {};
    return this.#post(`reads/${read}`, repo, args, headers, READ_TIMEOUTS[read] ?? TIMEOUT_MS);
  }

  async #post<T>(
    path: string,
    repo: string,
    args: object,
    headers: Record<string, string>,
    timeoutMs = TIMEOUT_MS,
  ): Promise<T> {
    const { status, text } = await post(
      `${this.#url}/v1/${path}`,
      { 'content-type': 'application/json', ...headers },
      JSON.stringify({ repo, ...args }),
      timeoutMs,
    );
    let body: { result?: T; error?: string; message?: string; refusal?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new GitHubWorkerError(status, 'malformed', `${path} answered ${status} with something other than JSON`);
    }
    if (status < 200 || status >= 300) {
      throw new GitHubWorkerError(status, body.error ?? 'unknown', body.message ?? `${path} failed`, body.refusal);
    }
    return body.result as T;
  }
}

/** One POST, its status and its body as text, within `timeoutMs` from the start: no other limit on the wait. */
function post(
  url: string,
  headers: Record<string, string>,
  payload: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(payload) },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
