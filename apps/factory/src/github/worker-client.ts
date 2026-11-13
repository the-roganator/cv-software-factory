/**
 * The GitHub worker, as the other workers call it (`github/server.ts`). Every action in GitHub goes through it: it
 * holds the App's key, and nothing else does. Reads go through it too (`reads.ts`), so it is the one place that
 * talks to GitHub.
 *
 * Every call goes over `fetch`, but for `moves`, which goes over `node:http` (`longPost`): Node's `fetch` stops waiting
 * for a response's headers after 300 s whatever the caller's signal, and the worker answers `moves`, the first time for
 * each scan run, only once it has read every open alert, which can take longer. There the only limit is the read's own
 * timeout.
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
 * How long `moves` may take: the first read of a scan run pages every open alert of the scan, a hundred to a page, one
 * page after another (the factory's ten thousand took 108 s on 12 November); the worker keeps it for the next.
 */
export const MOVES_TIMEOUT_MS = 10 * 60_000;

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
  readonly #movesTimeoutMs: number;

  /**
   * With `dryRun`, every action is recorded by the worker and none is done. `onRefusal` is told of each refusal an
   * action is answered with, to relay; it must not throw, and the action fails as it would have. `movesTimeoutMs` is
   * for a test of the deadline; the client's own is `MOVES_TIMEOUT_MS`.
   */
  constructor(
    url: string,
    {
      dryRun = false,
      onRefusal,
      movesTimeoutMs = MOVES_TIMEOUT_MS,
    }: { dryRun?: boolean; onRefusal?: OnRefusal; movesTimeoutMs?: number } = {},
  ) {
    this.#url = url.replace(/\/$/, '');
    this.#dryRun = dryRun;
    this.#onRefusal = onRefusal;
    this.#movesTimeoutMs = movesTimeoutMs;
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
    if (read === 'moves') return this.#longPost(`reads/${read}`, repo, args, headers, this.#movesTimeoutMs);
    return this.#post(`reads/${read}`, repo, args, headers);
  }

  async #post<T>(path: string, repo: string, args: object, headers: Record<string, string>): Promise<T> {
    const response = await fetch(`${this.#url}/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ repo, ...args }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json()) as { result?: T; error?: string; message?: string; refusal?: unknown };
    if (!response.ok) {
      throw new GitHubWorkerError(
        response.status,
        body.error ?? 'unknown',
        body.message ?? `${path} failed`,
        body.refusal,
      );
    }
    return body.result as T;
  }

  /**
   * `#post` over `node:http`, for a read that may answer after `fetch` stops waiting. An answer that is not the
   * worker's JSON is not the worker's error, so it is never a `GitHubWorkerError`, whose status callers route on.
   */
  async #longPost<T>(
    path: string,
    repo: string,
    args: object,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<T> {
    const { status, text } = await post(
      `${this.#url}/v1/${path}`,
      { 'content-type': 'application/json', ...headers },
      JSON.stringify({ repo, ...args }),
      timeoutMs,
    );
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (typeof body !== 'object' || body === null)
      throw new Error(`The GitHub worker's ${path} answered ${status} with something other than its JSON`);
    const answer = body as { result?: T; error?: string; message?: string; refusal?: unknown };
    if (status < 200 || status >= 300) {
      throw new GitHubWorkerError(
        status,
        answer.error ?? 'unknown',
        answer.message ?? `${path} failed`,
        answer.refusal,
      );
    }
    return answer.result as T;
  }
}

/**
 * One POST, its status and its body as text, all within `timeoutMs` from the start, with no other limit on the wait.
 * Past it the call fails naming the address and the time it was allowed.
 */
function post(
  url: string,
  headers: Record<string, string>,
  payload: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done();
    };
    const req = send(
      target,
      { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          settle(() => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })),
        );
        res.on('error', (error) => settle(() => reject(error)));
        // A body cut short ends in neither `end` nor, on every Node, `error`.
        res.on('close', () => settle(() => reject(new Error(`${target.pathname} closed before its answer ended`))));
      },
    );
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`${target.pathname} gave no whole answer within ${timeoutMs / 1000} s`)));
      req.destroy();
    }, timeoutMs);
    req.on('error', (error) => settle(() => reject(error)));
    req.end(payload);
  });
}
