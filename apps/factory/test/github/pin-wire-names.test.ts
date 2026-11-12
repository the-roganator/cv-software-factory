/**
 * The names, below the door. The URL parser Node's fetch runs takes every tab, line feed and carriage return out of a
 * URL, and a `.` segment, before it is sent; reads a backslash as a slash and ends the path at a `#`; and GitHub reads
 * a percent-escape in a ref's path as the character it stands for. So `plainBranch` (in `guardBranch`) allows a branch
 * name of letters, digits, dots, dashes and slashes alone, and the client's `#send` sends only a URL that parses to
 * exactly what was built, with no stray `%`, refusing anything else as a `GitHubError`.
 *
 * The real client and the real fetch, as the worker runs them: only GitHub's address is a stand-in, an HTTP server
 * that keeps the request line it was sent.
 */
import { createServer } from 'node:http';
import { listenLocal } from '@software-factory/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveActions } from '../../src/github/actions.ts';
import { guardWritable, pinBranch, plainBranch } from '../../src/github/branches.ts';
import { GitHub, GitHubError } from '../../src/github/client.ts';
import { CLIENT_ID, PRIVATE_KEY, quiet } from './fake.ts';
import { FACTORY } from './pins-harness.ts';

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

async function wire() {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/installation')) return res.end(JSON.stringify({ id: 42 }));
    if (req.url?.endsWith('/access_tokens')) {
      res.statusCode = 201;
      return res.end(JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() }));
    }
    if (req.method === 'DELETE') {
      res.statusCode = 204;
      return res.end();
    }
    return res.end(JSON.stringify({ object: { sha: 'a'.repeat(40) } }));
  });
  const { url: api } = await listenLocal(server);
  closing.push(() => server.close());
  const github = new GitHub({ credentials: { clientId: CLIENT_ID, privateKey: PRIVATE_KEY }, api, log: quiet });
  return { seen, actions: new LiveActions(github), github };
}

const PIN = 'factory/pin/example-dashboards';
const _SCRATCH = 'factory/deploy/local';
const at = (branch: string) => `/repos/${FACTORY}/git/refs/heads/${branch}`;

describe('a name the actions or the client would send as another branch', () => {
  const sent = (seen: string[]) => seen.filter((s) => !/installation|access_tokens/.test(s));

  // Each would be sent as the pin branch's own path, or the deploy watch's scratch branch's.
  const names = [
    ['a tab in a segment', 'factory/pi\tn/example-dashboards'],
    ['a line feed in a segment', 'factory/pin\n/example-dashboards'],
    ['a carriage return before the prefix’s slash', 'factory/pin\r/example-dashboards'],
    ['a tab in the deploy watch’s scratch branch', 'factory/deploy/lo\tcal'],
    ['an escaped letter', 'factory/%70in/example-dashboards'],
    ['an escaped slash', 'factory/pin%2Fexample-dashboards'],
    ['an escaped slash, lower case', 'factory/pin%2fexample-dashboards'],
  ] as const;
  for (const [what, name] of names) {
    it(`refuses ${what}, by the actions, before anything is sent`, async () => {
      const { seen, actions } = await wire();
      expect(plainBranch(name)).toBe(false);
      expect(() => guardWritable(name)).toThrow(/plain branch/);
      await expect(actions.setBranch(FACTORY, name, 'e'.repeat(40), { force: true })).rejects.toThrow(/plain branch/);
      await expect(actions.deleteBranch(FACTORY, name)).rejects.toThrow(/plain branch/);
      expect(sent(seen)).toEqual([]);
    });
  }

  it('refuses, in the client, any path that would be sent as another, as a GitHubError', async () => {
    const { seen, github } = await wire();
    const any = { safeParse: (x: unknown) => ({ success: true, data: x }) } as never;
    for (const path of [
      at('factory/./pin/example-dashboards'),
      at('factory/x/../pin/example-dashboards'),
      at('factory/%2e/pin/example-dashboards'),
      at('factory/%2E%2e/pin/example-dashboards'),
      at('factory\\pin\\example-dashboards'),
      at('factory/pin#/example-dashboards'),
      at('factory/pi\tn/example-dashboards'),
      at('factory/pin\n/example-dashboards'),
      at('factory/pin%/example-dashboards'),
      `/repos/${FACTORY}/pulls?state=closed&head=the-roganator:fix/#12-thing`,
    ]) {
      const failed = await github.read(FACTORY, path, any).catch((e: unknown) => e);
      expect(failed, JSON.stringify(path)).toBeInstanceOf(GitHubError);
      expect((failed as Error).message, JSON.stringify(path)).toMatch(/not sent/);
    }
    expect(sent(seen)).toEqual([]);
  });

  it('refuses no path the worker builds with a dot, an escape or a query in it', async () => {
    const { seen, github } = await wire();
    const any = { safeParse: (x: unknown) => ({ success: true, data: x }) } as never;
    for (const path of [
      `/repos/${FACTORY}/contents/.github/workflows/build.yml?ref=${'a'.repeat(40)}`,
      `/repos/${FACTORY}/contents/.github/dependabot.yml?ref=main`,
      `/repos/${FACTORY}/compare/${'a'.repeat(40)}...${'b'.repeat(40)}?per_page=100&page=1`,
      `/repos/${FACTORY}/compare/main...${'b'.repeat(40)}?per_page=100&page=1`,
      `/repos/${FACTORY}/contents/apps/console/..hidden/x.ts?ref=main`,
      `/repos/${FACTORY}/contents/a/.../x.ts?ref=main`,
      `/repos/${FACTORY}/issues/7/comments?per_page=100&since=${encodeURIComponent('2026-11-12T07:00:00Z')}`,
      `/repos/${FACTORY}/contents/${['docs', 'C# notes.md'].map(encodeURIComponent).join('/')}?ref=main`,
      `/repos/${FACTORY}/pulls?state=closed&head=the-roganator:${encodeURIComponent('fix/#12-thing')}`,
      `/repos/${FACTORY}/git/matching-refs/heads/factory/pin?per_page=100&page=1`,
    ]) {
      await github.read(FACTORY, path, any);
      expect(seen.at(-1)).toBe(`GET ${path}`);
    }
  });

  it('still refuses the pin branch by its name, and a dot-led segment', async () => {
    const { seen, actions } = await wire();
    for (const name of ['factory/./pin/example-dashboards', 'factory/.x/pin', `${PIN} `]) {
      await expect(actions.setBranch(FACTORY, name, 'e'.repeat(40), { force: true })).rejects.toThrow(/plain branch/);
    }
    await expect(actions.setBranch(FACTORY, PIN, 'e'.repeat(40), { force: true })).rejects.toThrow(/pin watch's/);
    expect(pinBranch(PIN)).toBe(true);
    expect(sent(seen)).toEqual([]);
  });
});
