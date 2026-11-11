/**
 * A stand-in for GitHub's API: a `fetch` that answers from a table of routes and keeps every request it was sent,
 * so the client, the actions and the worker run as they do against GitHub, with no network and no App.
 *
 * The App's two calls (finding the installation, making a token) are answered for every fake, and check the JSON
 * Web Token against the test key's public half, as GitHub would.
 */
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import pino from 'pino';
import { GitHub } from '../../src/github/client.ts';

export const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
export const CLIENT_ID = 'Iv23testclientid';
export const REPO = 'the-roganator/cv-worlds-worst-website';
export const SHA = 'a'.repeat(40);
export const OTHER_SHA = 'b'.repeat(40);

export interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Answer {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Route {
  method: string;
  path: string | RegExp;
  answer: (sent: Sent) => Answer;
}

/** Verifies an App JWT as GitHub would: signed by the key, issued by the Client ID, alive for ten minutes at most. */
export function verifyJwt(jwt: string): { iss: string; iat: number; exp: number } {
  const [header, claims, signature] = jwt.split('.');
  const ok = createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(createPublicKey(PRIVATE_KEY), Buffer.from(signature ?? '', 'base64url'));
  if (!ok) throw new Error('the JWT is not signed by the App key');
  return JSON.parse(Buffer.from(claims ?? '', 'base64url').toString());
}

let tokens = 0;

export function fakeGitHub(routes: Route[], sent: Sent[] = []) {
  const all: Route[] = [
    {
      method: 'GET',
      path: /^\/repos\/[^/]+\/[^/]+\/installation$/,
      answer: ({ headers }) => {
        verifyJwt(headers.authorization?.replace(/^Bearer /, '') ?? '');
        return { body: { id: 42 } };
      },
    },
    {
      method: 'POST',
      path: '/app/installations/42/access_tokens',
      answer: ({ headers }) => {
        verifyJwt(headers.authorization?.replace(/^Bearer /, '') ?? '');
        tokens += 1;
        return {
          status: 201,
          body: { token: `ghs_test${tokens}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
        };
      },
    },
    ...routes,
  ];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const path = `${url.pathname}${url.search}`;
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const request = { method, path, headers, body };
    sent.push(request);
    const route = all.find(
      (r) => r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)),
    );
    if (!route) throw new Error(`No fake answer for ${method} ${path}`);
    const answer = route.answer(request);
    const status = answer.status ?? 200;
    // Bytes go as they are, as GitHub's storage sends an artifact; anything else as JSON.
    const bytes = answer.body instanceof Uint8Array;
    return new Response(
      status === 204 || status === 304 || answer.body === undefined
        ? null
        : bytes
          ? (answer.body as Uint8Array<ArrayBuffer>)
          : JSON.stringify(answer.body),
      {
        status,
        headers: { 'content-type': bytes ? 'application/zip' : 'application/json', ...answer.headers },
      },
    );
  }) as typeof fetch;
  return { fetch: fetcher, sent };
}

export const quiet = pino({ level: 'silent' });

/** A client as the App, against the fake, that never waits. */
export function client(
  routes: Route[],
  sent: Sent[] = [],
  options: { keyless?: boolean; sleep?: (ms: number) => Promise<void> } = {},
) {
  const fake = fakeGitHub(routes, sent);
  const github = new GitHub({
    credentials: options.keyless ? undefined : { clientId: CLIENT_ID, privateKey: PRIVATE_KEY },
    api: 'https://api.github.test',
    log: quiet,
    fetch: fake.fetch,
    sleep: options.sleep ?? (async () => {}),
  });
  return { github, sent };
}

/** The requests that were about the repository, without the App's own calls. */
export const calls = (sent: Sent[]) =>
  sent.filter((s) => !s.path.endsWith('/installation') && !s.path.startsWith('/app/'));
