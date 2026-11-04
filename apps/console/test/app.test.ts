import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { RawEvent } from '@software-factory/events';
import { type ArtifactStore, DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS, type Access, type Name, routeOf, type ServedBy } from '../../../policy/access.ts';
import { createApp, PERMISSIONS_POLICY, SECURITY_HEADERS } from '../src/app.ts';
import { Feed } from '../src/feed.ts';
import { RefusalChecks } from '../src/refusals.ts';
import { loadSite, pageSettings } from '../src/site.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** A build as Vite lays one out: the page, a hashed script and its manifest. */
function fakeBuild(): string {
  const dist = mkdtempSync(join(tmpdir(), 'dist-'));
  mkdirSync(join(dist, '.vite'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Software Factory · Martin Rogan</title>');
  writeFileSync(join(dist, 'assets/index-AbC123.js'), `console.log(${JSON.stringify('x'.repeat(2000))});`);
  writeFileSync(
    join(dist, '.vite/manifest.json'),
    JSON.stringify({ 'index.html': { file: 'assets/index-AbC123.js' } }),
  );
  return dist;
}

const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
const feed = new Feed();
let screenshot: string;
let server: Server;
let base: string;

const event = (seq: number, extra: Partial<RawEvent> = {}) => ({
  event: {
    id: crypto.randomUUID(),
    seq,
    ts: new Date(Date.UTC(2026, 9, 3, 9, seq)).toISOString(),
    work_item: '1296',
    type: 'work-item.summarised',
    version: 1,
    actor: 'planner',
    summary: `Event ${seq}`,
    payload: { title: 'Prices go negative', description: '…', story: '…' },
    artifacts: [],
    ...extra,
  } as RawEvent & { seq: number },
  appendedAt: Date.now(),
});

beforeAll(async () => {
  screenshot = await artifacts.put(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  feed.add([
    event(1),
    event(2, {
      artifacts: [{ kind: 'file', hash: screenshot, type: 'image/png', size: 4, name: 'a picture' }],
    } as never),
    event(3),
  ]);
  server = createServer(
    createApp({
      commit: COMMIT,
      site: loadSite(fakeBuild()),
      feed,
      artifacts,
      refusals: new RefusalChecks(artifacts, undefined),
    }),
  );
  base = (await listenLocal(server)).url;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Reads an event stream until it has seen `count` events, then hangs up, with the first `count`: the server writes a
 * backlog in one go, and how much of it one chunk holds is up to the socket.
 */
function readStream(path: string, headers: Record<string, string>, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ids: string[] = [];
    const req = request(`${base}${path}`, { headers }, (res) => {
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        for (const [, id] of buffer.matchAll(/^id: (\d+)$/gm)) if (id && !ids.includes(id)) ids.push(id);
        if (ids.length >= count) {
          req.destroy();
          resolve(ids.slice(0, count));
        }
      });
    });
    req.on('error', (error) => (ids.length >= count ? resolve(ids.slice(0, count)) : reject(error)));
    req.end();
  });
}

describe('the console server', () => {
  it('reports its health and the commit it was built from', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
    expect(await (await fetch(`${base}/version`)).json()).toEqual({ commit: COMMIT });
  });

  it('serves the page uncached, so a deploy shows at once', async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>Software Factory · Martin Rogan</title>');
  });

  it('serves built files by the manifest, cached for a year and compressed', async () => {
    const res = await fetch(`${base}/assets/index-AbC123.js`, { headers: { 'accept-encoding': 'br' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(await res.text()).toContain('console.log');
    expect((await fetch(`${base}/assets/not-built.js`)).status).toBe(404);
  });

  it('sets a strict content security policy, with scripts and connections to itself only', async () => {
    const policy = (await fetch(`${base}/`)).headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("connect-src 'self';");
    expect(policy).not.toContain('unsafe');
  });

  it('isolates the page from other origins, and gives away no browser feature it does not use', async () => {
    for (const path of ['/', '/assets/index-AbC123.js', '/api/events?after=0', '/nowhere']) {
      const res = await fetch(`${base}${path}`);
      await res.body?.cancel();
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), path).toBe(value);
    }
    expect(SECURITY_HEADERS).toMatchObject({
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
    });
    // Passkeys keep their default, this origin alone: signing in needs them.
    expect(PERMISSIONS_POLICY).not.toContain('publickey-credentials');
  });

  it('serves the events after a seq, as JSON', async () => {
    const res = await fetch(`${base}/api/events?after=1`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { seq: number }[]).map((e) => e.seq)).toEqual([2, 3]);
    expect((await fetch(`${base}/api/events?after=-1`)).status).toBe(400);
  });

  it('compresses a large answer, with brotli where the browser takes it', async () => {
    feed.add(Array.from({ length: 20 }, (_, i) => event(10 + i)));
    const fetchRaw = (accept: string) =>
      new Promise<{ encoding: string | undefined; body: Buffer }>((resolve) =>
        request(`${base}/api/events?after=0`, { headers: { 'accept-encoding': accept } }, (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c)).on('end', () =>
            resolve({ encoding: r.headers['content-encoding'], body: Buffer.concat(chunks) }),
          );
        }).end(),
      );
    const br = await fetchRaw('gzip, deflate, br');
    expect(br.encoding).toBe('br');
    expect(JSON.parse(brotliDecompressSync(br.body).toString())).toHaveLength(23);
    const gzip = await fetchRaw('gzip');
    expect(gzip.encoding).toBe('gzip');
    expect(JSON.parse(gunzipSync(gzip.body).toString())).toHaveLength(23);
  });

  it('streams events from the start, then resumes from Last-Event-ID with none repeated', async () => {
    expect(await readStream('/api/events/stream?after=0', {}, 3)).toEqual(['1', '2', '3']);
    const resumed = readStream('/api/events/stream', { 'last-event-id': '29' }, 2);
    feed.add([event(30), event(31)]);
    expect(await resumed).toEqual(['30', '31']);
  });

  it('tells an open stream when an empty store learns what it holds', async () => {
    feed.kind = null;
    const messages = await new Promise<string[]>((resolve, reject) => {
      const req = request(`${base}/api/events/stream?after=0`, (res) => {
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const stores = buffer.split('\n\n').filter((part) => part.startsWith('event: store'));
          // \`make real-store\` marks the store while the console is open: the stream says so again.
          if (stores.length === 1 && feed.kind === null) feed.kind = 'real';
          if (stores.length === 2) {
            req.destroy();
            resolve(stores);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
    expect(messages).toEqual(['event: store\ndata: {"kind":null}', 'event: store\ndata: {"kind":"real"}']);
  });

  it('says first on every stream what the store holds, as a message that is not an event', async () => {
    const first = (kind: Feed['kind']) =>
      new Promise<string>((resolve, reject) => {
        feed.kind = kind;
        const req = request(`${base}/api/events/stream?after=0`, (res) => {
          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const message = buffer.split('\n\n').find((part) => part.startsWith('event:'));
            if (message) {
              req.destroy();
              resolve(message);
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    expect(await first('real')).toBe('event: store\ndata: {"kind":"real"}');
    expect(await first(null)).toBe('event: store\ndata: {"kind":null}');
  });

  it('serves an artifact a public event refers to, with its recorded type, for good', async () => {
    const res = await fetch(`${base}/artifacts/${screenshot}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe('4');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it('serves nothing it was not asked to publish', async () => {
    const unpublished = await artifacts.put(new TextEncoder().encode('not in any public event'));
    expect((await fetch(`${base}/artifacts/${unpublished}`)).status).toBe(404);
    expect((await fetch(`${base}/artifacts/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  it('says where to go when a page is missing', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('The console lives at /.');
  });

  it('answers every route the access table gives it, and nothing the table does not', async () => {
    // A path for each of the console's routes in policy/access.ts: a test of a route the table lacks fails here.
    const paths: Record<ServedBy<'console'>, string[]> = {
      page: ['/', '/index.html'],
      files: ['/assets/index-AbC123.js'],
      events: ['/api/events'],
      // A stream never ends, so it is read by the tests above.
      stream: [],
      artifacts: [`/artifacts/${screenshot}`],
      refusals: ['/api/refusals'],
      health: ['/health'],
      version: ['/version'],
    };
    for (const [name, access] of Object.entries(ACCESS) as [Name, Access][]) {
      if (access.server !== 'console') continue;
      expect(paths[name as ServedBy<'console'>], name).toBeDefined();
      for (const path of paths[name as ServedBy<'console'>]) {
        expect(routeOf('console', 'GET', path)?.name, path).toBe(name);
        const res = await fetch(`${base}${path}`, { method: 'HEAD' });
        expect(res.status, path).toBe(200);
      }
    }
    expect(routeOf('console', 'GET', '/api/events/stream')?.name).toBe('stream');
    expect(Object.keys(paths).sort()).toEqual(
      (Object.entries(ACCESS) as [Name, Access][])
        .filter(([, a]) => a.server === 'console')
        .map(([n]) => n)
        .sort(),
    );
    for (const path of ['/admin/', '/admin/sign-in', '/index.htm', '/assets', '/api', '/favicon.ico']) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
  });

  it('refuses methods other than GET and HEAD', async () => {
    const res = await fetch(`${base}/api/events`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('an artifact that goes wrong partway', () => {
  /** A console whose store hands out `body` for any artifact, as if it were a large file. */
  async function consoleWith(
    body: Readable,
    overrides: Partial<ArtifactStore> = {},
  ): Promise<{ url: string; app: Server; close: () => Promise<void> }> {
    const store: ArtifactStore = {
      put: () => Promise.reject(new Error('read-only')),
      // The console takes the size from `open`, never apart from it.
      size: () => Promise.reject(new Error('asked for the size apart from opening the file')),
      open: async () => ({ body, size: 1_000_000 }),
      ...overrides,
    };
    const app = createServer(
      createApp({
        commit: COMMIT,
        site: loadSite(fakeBuild()),
        feed,
        artifacts: store,
        refusals: new RefusalChecks(store, undefined),
      }),
    );
    const { url } = await listenLocal(app);
    return {
      url,
      app,
      close: () => {
        app.closeAllConnections();
        return new Promise<void>((resolve) => app.close(() => resolve()));
      },
    };
  }

  it('closes the file when the browser stops loading it', async () => {
    const body = new Readable({ read() {} });
    body.push(Buffer.alloc(1024));
    const { url, close } = await consoleWith(body);
    await new Promise<void>((resolve) => {
      const req = request(`${url}/artifacts/${screenshot}`, (res) => res.once('data', () => req.destroy()));
      req.on('error', () => {}).on('close', () => resolve());
      req.end();
    });
    await expect.poll(() => body.destroyed).toBe(true);
    await close();
  });

  it('ends the response, not the console, when a read fails', async () => {
    const body = new Readable({
      read() {
        this.destroy(Object.assign(new Error('i/o error'), { code: 'EIO' }));
      },
    });
    const { url, close } = await consoleWith(body);
    const cut = await new Promise<boolean>((resolve) => {
      request(`${url}/artifacts/${screenshot}`, (res) => {
        res
          .on('data', () => {})
          .on('error', () => resolve(true))
          .on('end', () => resolve(false));
      })
        .on('error', () => resolve(true))
        .end();
    });
    expect(cut).toBe(true);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await close();
  });

  it('closes the file, and keeps answering, when the browser left before the file was opened', async () => {
    const body = new Readable({ read() {} });
    // The store opens the file only once the browser has gone and the server has seen its response close.
    let gone: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      gone = resolve;
    });
    let asked: () => void = () => {};
    const opening = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const { url, app, close } = await consoleWith(body, {
      open: async () => {
        asked();
        await closed;
        return { body, size: 1_000_000 };
      },
    });
    app.on('request', (_req, res: ServerResponse) => res.on('close', gone));
    const req = request(`${url}/artifacts/${screenshot}`).on('error', () => {});
    req.end();
    await opening;
    req.destroy();
    await expect.poll(() => body.destroyed).toBe(true);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await close();
  });

  /**
   * A stream that fails, with ENOENT, when `fail` is called and not before, so a test says when the failure comes rather
   * than racing a timer. It fails once, however often asked.
   */
  function failingStream(): { body: Readable; fail: () => void } {
    let failing = false;
    let opened: ((error: Error) => void) | undefined;
    const failNow = () => {
      const callback = opened;
      opened = undefined;
      callback?.(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
    };
    const body = new Readable({
      construct(callback) {
        opened = callback;
        if (failing) failNow();
      },
      read() {},
    });
    return {
      body,
      fail: () => {
        failing = true;
        failNow();
      },
    };
  }

  it('keeps answering when a stream it closes unread then fails', async () => {
    // A stream can fail as it closes, after the console has closed it unread: the listener the console adds is all that
    // keeps that from ending the server. Node's own `destroy` option waits for `construct`, so it would never run here
    // and the test would hang: the instance's `destroy` is wrapped instead.
    const { body, fail } = failingStream();
    const destroy = body.destroy.bind(body);
    body.destroy = (error) => {
      destroy(error);
      fail();
      return body;
    };
    const { url, close } = await consoleWith(body);
    expect((await fetch(`${url}/artifacts/${screenshot}`, { method: 'HEAD' })).status).toBe(200);
    await expect.poll(() => body.errored).toBeTruthy();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await close();
  });

  it('answers 500, not by stopping, when the store cannot open the file', async () => {
    const { url, close } = await consoleWith(new Readable({ read() {} }), {
      open: () => Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
    });
    expect((await fetch(`${url}/artifacts/${screenshot}`)).status).toBe(500);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await close();
  });
});

describe('the page’s settings', () => {
  it('writes the profile and ALL_LOCAL into the page, from the environment the gateway reads, and refuses a profile it does not know', () => {
    const dist = fakeBuild();
    writeFileSync(
      join(dist, 'index.html'),
      '<!doctype html><meta name="sf-profile" content="local"><meta name="sf-all-local" content="false"><meta name="sf-app" content="">',
    );
    const page = loadSite(dist, pageSettings({ FACTORY_PROFILE: 'local', ALL_LOCAL: 'true' })).page.body.toString();
    expect(page).toContain('<meta name="sf-profile" content="local">');
    expect(page).toContain('<meta name="sf-all-local" content="true">');
    expect(page).toContain('<meta name="sf-app" content="">');
    expect(pageSettings({})).toEqual({ profile: 'local', allLocal: false });
    expect(pageSettings({ FACTORY_PROFILE: 'do' })).toEqual({ profile: 'do', allLocal: false });
    expect(() => pageSettings({ FACTORY_PROFILE: 'mars' })).toThrow(/FACTORY_PROFILE/);
    expect(() => pageSettings({ FACTORY_PROFILE: 'do', ALL_LOCAL: 'true' })).toThrow(/has none/);
  });

  it('writes the app’s origin alone, which a flag’s preview opens, and refuses an address a link should not take', () => {
    const dist = fakeBuild();
    writeFileSync(join(dist, 'index.html'), '<!doctype html><meta name="sf-app" content="">');
    const settings = pageSettings({ APP_URL: 'http://website.localhost:8080/some/page?x="y"' });
    expect(settings.app).toBe('http://website.localhost:8080');
    expect(loadSite(dist, settings).page.body.toString()).toContain(
      '<meta name="sf-app" content="http://website.localhost:8080">',
    );
    for (const app of ['javascript:alert(1)', 'http://martin:secret@website.localhost', 'website.localhost']) {
      expect(() => pageSettings({ APP_URL: app }), app).toThrow(/APP_URL/);
    }
  });
});
