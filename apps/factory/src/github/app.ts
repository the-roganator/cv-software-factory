/**
 * The factory's GitHub App, `mrogan-software-factory`: how its private key becomes the short-lived installation
 * tokens that every call to GitHub carries.
 *
 * The key signs a JSON Web Token that says "I am the App" for ten minutes at most. GitHub exchanges that for an
 * installation token, which says "the App, on this installation" for an hour. Each token here is narrowed to the one
 * repository it is for, and is made when it is first needed and again shortly before it expires.
 *
 * Neither the key nor a token is ever logged, put in an error, or written anywhere: they live in this module's memory.
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { z } from 'zod';

export interface AppCredentials {
  /** The App's Client ID (`Iv23…`), which GitHub accepts as the token's issuer as it does the numeric App ID. */
  clientId: string;
  /** The private key, as the PEM GitHub issued. */
  privateKey: string;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * A JSON Web Token for the App, signed with RS256. Its issue time is a minute in the past, as GitHub advises, so a
 * clock a little ahead of GitHub's is not refused; it expires nine minutes from now, inside GitHub's ten.
 */
export function appJwt(clientId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: clientId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key);
  return `${header}.${claims}.${base64url(signature)}`;
}

const installation = z.object({ id: z.number().int().positive() });
const accessToken = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
  // What the token may do, as GitHub granted it: the installation's permissions, as Martin accepted them.
  permissions: z.record(z.string(), z.string()).optional(),
});

/** A token is made again this long before it expires, so none goes out in a request that outlives it. */
const RENEW_BEFORE_MS = 5 * 60_000;

interface Cached {
  token: string;
  expiresMs: number;
  permissions: Record<string, string> | undefined;
}

/** What `InstallationTokens` needs from the API: the two calls that are made as the App rather than an installation. */
export type AppRequest = (method: 'GET' | 'POST', path: string, jwt: string, body?: unknown) => Promise<unknown>;

export class InstallationTokens {
  readonly clientId: string;
  readonly #key: KeyObject;
  readonly #request: AppRequest;
  readonly #now: () => number;
  readonly #tokens = new Map<string, Cached>();
  readonly #installations = new Map<string, number>();
  readonly #pending = new Map<string, Promise<string>>();

  constructor(credentials: AppCredentials, request: AppRequest, now: () => number = Date.now) {
    this.clientId = credentials.clientId;
    // Parsed once, here, so a key that is not a key fails when the worker starts rather than at its first write.
    this.#key = createPrivateKey(credentials.privateKey);
    this.#request = request;
    this.#now = now;
  }

  /** An installation token for one repository (`owner/name`), from the cache while it has long enough to live. */
  async token(repo: string): Promise<string> {
    const cached = this.#tokens.get(repo);
    if (cached && cached.expiresMs - this.#now() > RENEW_BEFORE_MS) return cached.token;
    // Calls that arrive together while a token is being made wait for that one, rather than each making their own.
    let pending = this.#pending.get(repo);
    if (!pending) {
      pending = this.#make(repo).finally(() => this.#pending.delete(repo));
      this.#pending.set(repo, pending);
    }
    return pending;
  }

  /**
   * What a repository's token may do, as GitHub stated when it made it (`contents: write`…), or undefined when it did
   * not say. Makes the token if there is none yet.
   */
  async permissions(repo: string): Promise<Record<string, string> | undefined> {
    await this.token(repo);
    return this.#tokens.get(repo)?.permissions;
  }

  /** Forgets a repository's token, after GitHub refused it as expired or revoked. */
  forget(repo: string): void {
    this.#tokens.delete(repo);
  }

  async #make(repo: string): Promise<string> {
    const jwt = appJwt(this.clientId, this.#key, this.#now());
    let installation = this.#installations.get(repo);
    if (installation === undefined) {
      installation = installationOf(await this.#request('GET', `/repos/${repo}/installation`, jwt));
      this.#installations.set(repo, installation);
    }
    const [, name] = repo.split('/');
    // Narrowed to the one repository: a token that leaks from a call about the app's repository is no use on this one.
    const made = tokenOf(
      await this.#request('POST', `/app/installations/${installation}/access_tokens`, jwt, { repositories: [name] }),
    );
    this.#tokens.set(repo, {
      token: made.token,
      expiresMs: Date.parse(made.expires_at),
      permissions: made.permissions,
    });
    return made.token;
  }
}

/** The installation's id from GitHub's answer. Its words never reach an error: they could hold a token. */
function installationOf(answer: unknown): number {
  const parsed = installation.safeParse(answer);
  if (!parsed.success) throw new Error('GitHub answered the installation lookup with something else.');
  return parsed.data.id;
}

function tokenOf(answer: unknown): z.infer<typeof accessToken> {
  const parsed = accessToken.safeParse(answer);
  if (!parsed.success) throw new Error('GitHub answered the request for a token with something else.');
  return parsed.data;
}
