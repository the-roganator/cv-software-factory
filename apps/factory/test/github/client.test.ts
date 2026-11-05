import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appJwt, InstallationTokens } from '../../src/github/app.ts';
import { GitHubError } from '../../src/github/client.ts';
import { CLIENT_ID, calls, client, PRIVATE_KEY, REPO, type Sent, verifyJwt } from './fake.ts';

describe('the App', () => {
  it('signs a JWT GitHub accepts: issued by the Client ID a minute ago, for nine minutes', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const claims = verifyJwt(appJwt(CLIENT_ID, createPrivateKey(PRIVATE_KEY), now));
    expect(claims).toEqual({ iss: CLIENT_ID, iat: now / 1000 - 60, exp: now / 1000 + 540 });
  });

  it('makes one token per repository, narrowed to it, and reuses it until shortly before it expires', async () => {
    let now = Date.parse('2026-10-04T12:00:00Z');
    const made: unknown[] = [];
    const tokens = new InstallationTokens(
      { clientId: CLIENT_ID, privateKey: PRIVATE_KEY },
      async (method, path, _jwt, body) => {
        if (method === 'GET') return { id: 42 };
        made.push({ path, body });
        return { token: `t${made.length}`, expires_at: new Date(now + 3600_000).toISOString() };
      },
      () => now,
    );
    const [a, b] = await Promise.all([tokens.token(REPO), tokens.token(REPO)]);
    expect([a, b]).toEqual(['t1', 't1']);
    expect(made).toEqual([
      { path: '/app/installations/42/access_tokens', body: { repositories: ['cv-worlds-worst-website'] } },
    ]);
    now += 54 * 60_000;
    expect(await tokens.token(REPO)).toBe('t1');
    now += 2 * 60_000; // four minutes left: inside the margin
    expect(await tokens.token(REPO)).toBe('t2');
  });

  it('refuses a key that is not a key when it starts, not at its first write', () => {
    expect(() => new InstallationTokens({ clientId: CLIENT_ID, privateKey: 'not a key' }, async () => ({}))).toThrow();
  });
});

const PULLS = z.array(z.object({ number: z.number() }));
const OK = z.object({ ok: z.boolean() });

describe('the client', () => {
  it('calls as the installation, with a token for that repository', async () => {
    const { github, sent } = client([{ method: 'GET', path: `/repos/${REPO}`, answer: () => ({ body: { id: 1 } }) }]);
    expect(await github.read(REPO, `/repos/${REPO}`, z.object({ id: z.number() }))).toEqual({ id: 1 });
    const [call] = calls(sent);
    expect(call?.headers.authorization).toMatch(/^token ghs_test\d+$/);
    expect(call?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('with no key, reads unauthenticated and refuses to write before sending anything', async () => {
    const { github, sent } = client(
      [{ method: 'GET', path: `/repos/${REPO}`, answer: () => ({ body: { id: 1 } }) }],
      [],
      { keyless: true },
    );
    expect(github.writable).toBe(false);
    await github.read(REPO, `/repos/${REPO}`, z.unknown());
    expect(sent[0]?.headers.authorization).toBeUndefined();
    await expect(github.write(REPO, 'POST', `/repos/${REPO}/issues`, {})).rejects.toMatchObject({
      kind: 'read-only',
    });
    await expect(github.graphql(REPO, 'query { viewer { login } }', {}, z.unknown())).rejects.toMatchObject({
      kind: 'read-only',
    });
    expect(sent).toHaveLength(1);
  });

  it('polls with the last ETag, and an answer GitHub says has not changed comes from the cache', async () => {
    let state = 1;
    const { github, sent } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}/pulls`,
        answer: ({ headers }) =>
          headers['if-none-match'] === `"v${state}"`
            ? { status: 304, headers: { etag: `"v${state}"` } }
            : { body: [{ number: state }], headers: { etag: `"v${state}"` } },
      },
    ]);
    expect(await github.poll(REPO, `/repos/${REPO}/pulls`, PULLS)).toEqual({ changed: true, body: [{ number: 1 }] });
    expect(await github.poll(REPO, `/repos/${REPO}/pulls`, PULLS)).toEqual({ changed: false, body: [{ number: 1 }] });
    state = 2;
    expect(await github.poll(REPO, `/repos/${REPO}/pulls`, PULLS)).toEqual({ changed: true, body: [{ number: 2 }] });
    expect(calls(sent).map((s) => s.headers['if-none-match'])).toEqual([undefined, '"v1"', '"v1"']);
  });

  it('reads an unchanged answer through each caller’s own schema, so one that names fewer fields spoils no other', async () => {
    const PULL = `/repos/${REPO}/pulls/7`;
    const answer = { number: 7, mergeable: true, head: { sha: 'abc', ref: 'fix' }, base: { ref: 'main' } };
    const { github, sent } = client([
      {
        method: 'GET',
        path: PULL,
        answer: ({ headers }) =>
          headers['if-none-match'] === '"v1"'
            ? { status: 304, headers: { etag: '"v1"' } }
            : { body: answer, headers: { etag: '"v1"' } },
      },
    ]);
    const MERGEABLE = z.object({ mergeable: z.boolean().nullable() });
    const WHOLE = z.object({
      number: z.number(),
      head: z.object({ sha: z.string(), ref: z.string() }),
      base: z.object({ ref: z.string() }),
    });
    expect(await github.poll(REPO, PULL, MERGEABLE)).toEqual({ changed: true, body: { mergeable: true } });
    expect(await github.poll(REPO, PULL, WHOLE)).toEqual({
      changed: false,
      body: { number: 7, head: { sha: 'abc', ref: 'fix' }, base: { ref: 'main' } },
    });
    // A schema that does not fit is malformed, and leaves the kept answer for the others.
    await expect(github.poll(REPO, PULL, OK)).rejects.toMatchObject({ kind: 'malformed' });
    expect(await github.poll(REPO, PULL, MERGEABLE)).toEqual({ changed: false, body: { mergeable: true } });
    // One request each, all but the first answered 304: the schemas share the path's ETag.
    expect(calls(sent).map((s) => s.headers['if-none-match'])).toEqual([undefined, '"v1"', '"v1"', '"v1"']);
  });

  it('keeps no answer its caller could not read, and calls a body that is not JSON malformed', async () => {
    let answer: Record<string, unknown> = { ok: 'yes' };
    const { github, sent } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}/thing`,
        answer: ({ headers }) =>
          headers['if-none-match'] === '"v1"'
            ? { status: 304, headers: { etag: '"v1"' } }
            : { body: answer, headers: { etag: '"v1"' } },
      },
    ]);
    await expect(github.poll(REPO, `/repos/${REPO}/thing`, OK)).rejects.toMatchObject({ kind: 'malformed' });
    // Asked again in full, so a watch that failed on it sees it as a change when it does read.
    answer = { ok: true };
    expect(await github.poll(REPO, `/repos/${REPO}/thing`, OK)).toEqual({ changed: true, body: { ok: true } });
    expect(calls(sent).map((s) => s.headers['if-none-match'])).toEqual([undefined, undefined]);

    const empty = client([
      { method: 'GET', path: `/repos/${REPO}/thing`, answer: () => ({ headers: { etag: '"e"' } }) },
      { method: 'POST', path: `/repos/${REPO}/thing`, answer: () => ({}) },
      { method: 'POST', path: '/graphql', answer: () => ({}) },
    ]);
    await expect(empty.github.poll(REPO, `/repos/${REPO}/thing`, OK)).rejects.toMatchObject({
      kind: 'malformed',
      message: `GET /repos/${REPO}/thing answered with something other than JSON`,
    });
    // So is every other read of a body.
    await expect(empty.github.read(REPO, `/repos/${REPO}/thing`, OK)).rejects.toMatchObject({ kind: 'malformed' });
    await expect(empty.github.write(REPO, 'POST', `/repos/${REPO}/thing`, {}, OK)).rejects.toMatchObject({
      kind: 'malformed',
      message: `POST /repos/${REPO}/thing answered with something other than JSON`,
    });
    await expect(empty.github.graphql(REPO, 'query { viewer { login } }', {}, OK)).rejects.toMatchObject({
      kind: 'malformed',
      message: 'GraphQL answered with something other than JSON',
    });
  });

  it('waits out a rate limit GitHub names, then tries again', async () => {
    const waits: number[] = [];
    const { github } = client(
      [
        {
          method: 'GET',
          path: `/repos/${REPO}`,
          answer: () =>
            waits.length
              ? { body: { ok: true } }
              : { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '7' } },
        },
      ],
      [],
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(await github.read(REPO, `/repos/${REPO}`, OK)).toEqual({ ok: true });
    expect(waits).toEqual([7000]);
  });

  it('makes the token again, once, when GitHub no longer accepts it', async () => {
    const seen: string[] = [];
    const { github } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}`,
        answer: ({ headers }) => {
          seen.push(headers.authorization ?? '');
          return seen.length === 1 ? { status: 401, body: { message: 'Bad credentials' } } : { body: { ok: true } };
        },
      },
    ]);
    expect(await github.read(REPO, `/repos/${REPO}`, OK)).toEqual({ ok: true });
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("gives GitHub's reason and a kind to act on, and never a token", async () => {
    const sent: Sent[] = [];
    const { github } = client(
      [
        {
          method: 'POST',
          path: `/repos/${REPO}/pulls`,
          answer: () => ({
            status: 422,
            body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] },
          }),
        },
        {
          method: 'GET',
          path: `/repos/${REPO}/nothing`,
          answer: () => ({ status: 404, body: { message: 'Not Found' } }),
        },
        { method: 'GET', path: `/repos/${REPO}/broken`, answer: () => ({ status: 502 }) },
      ],
      sent,
    );
    const conflict = (await github.write(REPO, 'POST', `/repos/${REPO}/pulls`, {}).catch((e) => e)) as GitHubError;
    expect(conflict).toBeInstanceOf(GitHubError);
    expect(conflict).toMatchObject({ kind: 'conflict', status: 422 });
    expect(conflict.message).toBe(
      `POST /repos/${REPO}/pulls answered 422: Validation Failed; A pull request already exists`,
    );
    await expect(github.read(REPO, `/repos/${REPO}/nothing`, z.unknown())).rejects.toMatchObject({ kind: 'not-found' });
    const server = (await github.read(REPO, `/repos/${REPO}/broken`, z.unknown()).catch((e) => e)) as GitHubError;
    expect(server).toMatchObject({ kind: 'server', status: 502 });
    expect(calls(sent).filter((s) => s.path.endsWith('/broken'))).toHaveLength(4); // the first try and three more
    const token = calls(sent)[0]?.headers.authorization?.replace('token ', '') ?? '';
    for (const error of [conflict, server])
      expect(JSON.stringify({ ...error, message: error.message })).not.toContain(token);
  });

  it('throws GraphQL errors, which GitHub sends with a 200, with their kind', async () => {
    const { github } = client([
      {
        method: 'POST',
        path: '/graphql',
        answer: () => ({
          body: { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] },
        }),
      },
    ]);
    // FORBIDDEN is REST's 403, so it carries that status: GitHub refusing the token, which the worker signs.
    await expect(github.graphql(REPO, 'mutation { x }', {}, z.unknown())).rejects.toMatchObject({
      kind: 'refused',
      status: 403,
      message: 'Resource not accessible by integration',
    });
  });

  it('reads a body only through its schema, and says where an answer was not what it should be', async () => {
    const { github } = client([{ method: 'GET', path: `/repos/${REPO}`, answer: () => ({ body: { id: 'one' } }) }]);
    await expect(github.read(REPO, `/repos/${REPO}`, z.object({ id: z.number() }))).rejects.toMatchObject({
      kind: 'malformed',
      message: `GET /repos/${REPO} answered with something else (id: invalid_type)`,
    });
  });

  it('does not send a POST again after a server error: it may have made its issue already', async () => {
    const sent: Sent[] = [];
    const { github } = client(
      [{ method: 'POST', path: `/repos/${REPO}/issues`, answer: () => ({ status: 502 }) }],
      sent,
    );
    await expect(github.write(REPO, 'POST', `/repos/${REPO}/issues`, {})).rejects.toMatchObject({ kind: 'server' });
    expect(calls(sent)).toHaveLength(1);
  });
});
