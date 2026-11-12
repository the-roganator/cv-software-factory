/**
 * GitHub's REST and GraphQL APIs, with `fetch`, as the factory's App.
 *
 * Every call names the repository it is about, and carries an installation token for that repository alone
 * (`app.ts`). Without the App's key there are no tokens: calls go unauthenticated, which reads public repositories
 * and nothing more, and a write fails with a `GitHubError` of kind `read-only` before it is sent.
 *
 * A body is read only through a Zod schema (`read`, `write`, `poll`, `graphql`): what GitHub answers is checked
 * where it enters, and an answer that is not what the factory expects is a `GitHubError` of kind `malformed`.
 *
 * `poll` is a conditional GET: the client keeps each answer's ETag and asks again with `If-None-Match`, so an
 * answer that has not changed costs a 304 and nothing against the rate limit. It keeps the answer as GitHub sent it,
 * and reads it through the caller's schema each time, 304 or not: two callers may poll one path with different
 * schemas, and a schema drops the fields it does not name, so a body kept after one had read it would lack the
 * other's.
 *
 * A request is tried again after a rate limit, which GitHub answers before doing anything. After a timeout or a
 * server error it is tried again only if doing it twice is harmless: a GET, PATCH, PUT or DELETE. A POST that timed
 * out may have made its issue, comment or commit already.
 *
 * Failures are `GitHubError`s with a kind the caller can act on. They carry GitHub's own message, which says what
 * was refused and why; a token never appears in one, or in a log line.
 */
import type { Logger } from 'pino';
import type { z } from 'zod';
import { type AppCredentials, InstallationTokens } from './app.ts';

export const API = 'https://api.github.com';
const VERSION = '2022-11-28';
const USER_AGENT = 'mrogan-software-factory';

export type GitHubErrorKind =
  /** Not allowed: the App lacks the permission, a ruleset forbids it, or GitHub refused for its own reasons. */
  | 'refused'
  | 'not-found'
  /** The request is not valid for the state it found (a stale head, a branch that exists, a validation failure). */
  | 'conflict'
  | 'rate-limited'
  | 'server'
  | 'network'
  /** A write with no App key: the worker is running read-only. */
  | 'read-only'
  /** An answer that is not the shape the factory expects. */
  | 'malformed'
  /** A read that should simply be asked again: what it read changed while it read it (`READ_AGAIN`). */
  | 'read-again';

/** The kind of a read that should simply be asked again, which the worker answers with a 409 of its own. */
export const READ_AGAIN = 'read-again' satisfies GitHubErrorKind;

export class GitHubError extends Error {
  override name = 'GitHubError';
  readonly kind: GitHubErrorKind;
  readonly status: number | undefined;

  constructor(kind: GitHubErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface GitHubOptions {
  /** The App's key and Client ID. Without them the client reads public repositories and writes nothing. */
  credentials?: AppCredentials | undefined;
  /** Without a trailing slash. Tests point it at a fake. */
  api?: string;
  log: Logger;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** For one attempt, in milliseconds. */
  timeoutMs?: number;
  /** Retries after the first attempt, for a rate limit, a server error or the network. */
  maxRetries?: number;
}

/** The longest the client waits for a rate limit to lift before it gives up and lets the caller try later. */
const MAX_WAIT_MS = 60_000;
const BACKOFF_MS = 1_000;
/**
 * Conditional answers kept, and their text in all, in UTF-16 code units: the polled set is small, so these are guards
 * against a leak and not working limits. Paths that name a commit (its commits, a pinned file at it) are new with each
 * head, so the oldest answers go first.
 */
const MAX_CACHED = 500;
const MAX_CACHED_LENGTH = 32 * 1024 * 1024;

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface Polled<T> {
  /**
   * False when GitHub answered 304: the body is the one it gave last time this client asked for the path, whoever
   * asked, so a caller that acts only on a change must be the path's only poller.
   */
  changed: boolean;
  body: T;
}

export class GitHub {
  readonly api: string;
  readonly #tokens: InstallationTokens | undefined;
  readonly #log: Logger;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  /** Each polled path's last answer a caller could read: its ETag, and its body as GitHub sent it. */
  readonly #etags = new Map<string, { etag: string; text: string }>();
  #cachedLength = 0;

  constructor(options: GitHubOptions) {
    this.api = options.api ?? API;
    this.#log = options.log;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#tokens = options.credentials
      ? new InstallationTokens(
          options.credentials,
          async (method, path, jwt, body) => (await this.#send(method, path, `Bearer ${jwt}`, body)).json(),
          this.#now,
        )
      : undefined;
  }

  /** Whether the client holds the App's key, and so may write. */
  get writable(): boolean {
    return this.#tokens !== undefined;
  }

  /** What the App's token for a repository may do, as GitHub stated it; undefined with no key, or when it did not say. */
  async permissions(repo: string): Promise<Record<string, string> | undefined> {
    return this.#tokens?.permissions(repo);
  }

  /**
   * An installation token for one repository, for a library that makes its own calls (release-please). It stays in
   * memory and goes only to GitHub.
   */
  async token(repo: string): Promise<string> {
    if (!this.#tokens) throw new GitHubError('read-only', 'The worker has no App key, so it has no token to lend.');
    return this.#tokens.token(repo);
  }

  /** A GET about one repository (`owner/name`), its body read through `schema`. The path is from the API's root. */
  async read<T>(repo: string, path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.#authorised(repo, 'GET', path);
    return parse(schema, json(await response.text(), `GET ${path}`), `GET ${path}`);
  }

  /** A write about one repository. Its answer is read through `schema` when one is given, and ignored when not. */
  async write<T = undefined>(
    repo: string,
    method: Exclude<Method, 'GET'>,
    path: string,
    body?: unknown,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    if (!this.#tokens) throw new GitHubError('read-only', `The worker has no App key, so it cannot ${method} ${path}.`);
    const response = await this.#authorised(repo, method, path, body);
    if (!schema) {
      await response.body?.cancel();
      return undefined as T;
    }
    return parse(schema, json(await response.text(), `${method} ${path}`), `${method} ${path}`);
  }

  /** A conditional GET: unchanged answers come from the client's cache and cost nothing against the rate limit. */
  async poll<T>(repo: string, path: string, schema: z.ZodType<T>): Promise<Polled<T>> {
    const key = `${repo} ${path}`;
    const cached = this.#etags.get(key);
    const response = await this.#authorised(repo, 'GET', path, undefined, cached?.etag);
    if (response.status === 304 && cached) {
      return { changed: false, body: parse(schema, json(cached.text, `GET ${path}`), `GET ${path}`) };
    }
    const text = await response.text();
    // Read through the caller's schema before it is kept, so an answer no caller has read is asked for again.
    const body = parse(schema, json(text, `GET ${path}`), `GET ${path}`);
    const etag = response.headers.get('etag');
    this.#forget(key);
    if (etag && text.length <= MAX_CACHED_LENGTH) {
      this.#etags.set(key, { etag, text });
      this.#cachedLength += text.length;
      for (const [oldest] of this.#etags) {
        if (this.#etags.size <= MAX_CACHED && this.#cachedLength <= MAX_CACHED_LENGTH) break;
        this.#forget(oldest);
      }
    }
    return { changed: true, body };
  }

  /**
   * A file GitHub hands out by redirect, such as a run's artifact: the API answers 302 with a short-lived link to its
   * storage, which is followed without the token, since the link carries its own grant and the token belongs to
   * GitHub alone. Its bytes, at most `maxBytes`, or a `GitHubError`.
   */
  async download(repo: string, path: string, maxBytes: number): Promise<Buffer> {
    const response = await this.#authorised(repo, 'GET', path, undefined, undefined, 'manual');
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (response.status !== 302 || !location?.startsWith('https://')) {
      throw new GitHubError('malformed', `GET ${path} answered ${response.status} with no link to follow`);
    }
    let stored: Response;
    try {
      stored = await this.#fetch(location, { signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch {
      throw new GitHubError('network', `GET ${path}'s file failed to download`);
    }
    if (!stored.ok) {
      await stored.body?.cancel();
      throw new GitHubError(
        stored.status >= 500 ? 'server' : 'not-found',
        `GET ${path}'s file answered ${stored.status}`,
      );
    }
    const declared = Number(stored.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      await stored.body?.cancel();
      throw new GitHubError('malformed', `GET ${path}'s file is over ${maxBytes} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of stored.body ?? []) {
      length += chunk.length;
      if (length > maxBytes) throw new GitHubError('malformed', `GET ${path}'s file is over ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  #forget(key: string) {
    const cached = this.#etags.get(key);
    if (!cached) return;
    this.#etags.delete(key);
    this.#cachedLength -= cached.text.length;
  }

  /** A GraphQL call. GitHub answers errors with a 200 and an `errors` list; those are thrown as `GitHubError`s. */
  async graphql<T>(repo: string, query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    if (!this.#tokens) throw new GitHubError('read-only', 'The worker has no App key, so it cannot use GraphQL.');
    const response = await this.#authorised(repo, 'POST', '/graphql', { query, variables });
    const answer = json(await response.text(), 'GraphQL') as {
      data?: unknown;
      errors?: { type?: string; message?: string }[];
    };
    const [first] = Array.isArray(answer?.errors) ? answer.errors : [];
    if (first) {
      const kind: GitHubErrorKind =
        first.type === 'FORBIDDEN'
          ? 'refused'
          : first.type === 'NOT_FOUND'
            ? 'not-found'
            : first.type === 'RATE_LIMITED'
              ? 'rate-limited'
              : // Most others are a request that does not fit the state it found: a stale expected head, for one.
                'conflict';
      // GraphQL answers its FORBIDDEN, REST's 403, with a 200: it carries 403, so it reads as GitHub refusing the token.
      throw new GitHubError(
        kind,
        String(first.message ?? first.type ?? 'GraphQL error'),
        kind === 'refused' ? 403 : undefined,
      );
    }
    return parse(schema, answer?.data, 'GraphQL');
  }

  async #authorised(
    repo: string,
    method: Method,
    path: string,
    body?: unknown,
    etag?: string,
    redirect: 'follow' | 'manual' = 'follow',
  ): Promise<Response> {
    for (let renewed = false; ; renewed = true) {
      const token = this.#tokens ? await this.#tokens.token(repo) : undefined;
      try {
        return await this.#send(method, path, token && `token ${token}`, body, etag, redirect);
      } catch (error) {
        // A token GitHub no longer accepts (revoked, or a clock that drifted) is made again, once.
        if (error instanceof GitHubError && error.status === 401 && this.#tokens && !renewed) {
          this.#tokens.forget(repo);
          continue;
        }
        throw error;
      }
    }
  }

  async #send(
    method: Method,
    path: string,
    authorization?: string,
    body?: unknown,
    etag?: string,
    redirect: 'follow' | 'manual' = 'follow',
  ) {
    const url = `${this.api}${path}`;
    // Doing it twice is harmless: anything but a POST.
    const repeatable = method !== 'POST';
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': VERSION,
        'user-agent': USER_AGENT,
      };
      if (authorization) headers.authorization = authorization;
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (etag) headers['if-none-match'] = etag;
      const started = this.#now();
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(redirect === 'follow' ? {} : { redirect }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        const failure = new GitHubError('network', `${method} ${path} ${timedOut ? 'timed out' : 'failed to connect'}`);
        if (repeatable && attempt < this.#maxRetries) {
          await this.#sleep(BACKOFF_MS * 2 ** attempt);
          continue;
        }
        throw failure;
      }
      this.#log.debug({ method, path, status: response.status, ms: this.#now() - started }, 'github');
      if (response.ok || response.status === 304 || (redirect === 'manual' && response.status === 302)) return response;

      const failure = await errorOf(method, path, response, this.#now());
      const wait = failure.kind === 'rate-limited' ? failure.waitMs : BACKOFF_MS * 2 ** attempt;
      const retry =
        (failure.kind === 'rate-limited' || (failure.kind === 'server' && repeatable)) && wait <= MAX_WAIT_MS;
      if (retry && attempt < this.#maxRetries) {
        this.#log.warn({ method, path, status: response.status, waitMs: wait }, 'github asked us to wait');
        await this.#sleep(wait);
        continue;
      }
      throw failure;
    }
  }
}

async function errorOf(method: string, path: string, response: Response, now: number) {
  const { status, headers } = response;
  let message = '';
  try {
    const body = (await response.json()) as { message?: string; errors?: { message?: string }[] };
    message = [body.message, ...(body.errors ?? []).map((e) => e.message)].filter(Boolean).join('; ');
  } catch {
    // Not JSON: the status says enough.
  }
  const text = `${method} ${path} answered ${status}${message ? `: ${message}` : ''}`;
  // GitHub signals its rate limits with 403 or 429, and either a Retry-After or a spent quota and when it refills.
  const retryAfter = Number(headers.get('retry-after'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  const limited =
    status === 429 || (status === 403 && (headers.has('retry-after') || headers.get('x-ratelimit-remaining') === '0'));
  if (limited) {
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.max(0, reset * 1000 - now);
    return Object.assign(new GitHubError('rate-limited', text, status), { waitMs });
  }
  const kind: GitHubErrorKind =
    status >= 500
      ? 'server'
      : status === 404
        ? 'not-found'
        : status === 401 || status === 403
          ? 'refused'
          : status === 409 || status === 422
            ? 'conflict'
            : 'refused';
  return Object.assign(new GitHubError(kind, text, status), { waitMs: 0 });
}

/** A body as JSON, or a `GitHubError` of kind `malformed`: an empty or cut-off answer is one GitHub did not mean. */
function json(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHubError('malformed', `${where} answered with something other than JSON`);
  }
}

/** A body as the schema reads it, or a `malformed` error naming where, never what: a body can hold a person's words. */
function parse<T>(schema: z.ZodType<T>, body: unknown, where: string): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(body)'}: ${i.code}`);
  throw new GitHubError('malformed', `${where} answered with something else (${problems.join('; ')})`);
}
