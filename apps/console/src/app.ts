/**
 * The console's HTTP handler: the page and its built files, the events (as JSON and as a stream), the artifacts, the
 * checks of relayed refusals, `/health` and `/version`, each a route `policy/access.ts` gives the console, and nothing
 * else.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { ArtifactStore } from '@software-factory/store';
import { isHash } from '@software-factory/store';
import { routeOf, type ServedBy } from '../../../policy/access.ts';
import type { Feed } from './feed.ts';
import { log } from './log.ts';
import type { RefusalChecks } from './refusals.ts';
import type { File, Site } from './site.ts';
import { resumeFrom, stream } from './stream.ts';

export interface AppOptions {
  /** The commit the running build was made from. */
  commit: string;
  site: Site;
  feed: Feed;
  artifacts: ArtifactStore;
  /** Whether each relayed refusal is what the GitHub worker signed. */
  refusals: RefusalChecks;
}

/**
 * The page loads its own scripts, styles, fonts and images, talks only to this server, and runs nothing inline.
 * Development relaxes it (vite.config.ts); nothing else does.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The browser features the page may use: none of these. Passkeys are left to their default, this origin alone, which
 * signing in needs.
 */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/**
 * Sent with every response. The opener and embedder policies isolate the page from other origins' windows and
 * resources, so another site's page shares no process with it; everything it loads is its own.
 */
export const SECURITY_HEADERS = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': PERMISSIONS_POLICY,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const YEAR = 'public, max-age=31536000, immutable';

export function createApp({ commit, site, feed, artifacts, refusals }: AppOptions): RequestListener {
  const version = JSON.stringify({ commit });

  return (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://console');
    const path = url.pathname;
    res.on('finish', () => {
      if (path === '/health') return;
      const ms = Math.round(performance.now() - started);
      log.info({ method: req.method, path, status: res.statusCode, ms }, `${req.method} ${path} ${res.statusCode}`);
    });

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed. The console only reads; nothing here changes the factory.\n');
      return;
    }

    // Only what the access table gives the console, and every one of those, as a visitor reads it.
    const route = routeOf('console', req.method ?? 'GET', path);
    if (!route) return notFound(req, res);
    const handlers: Record<ServedBy<'console'>, () => void> = {
      health: () => send(req, res, 200, 'application/json', '{"status":"ok"}'),
      version: () => send(req, res, 200, 'application/json', version),
      page: () => serve(req, res, site.page, 'no-cache'),
      files: () => {
        const file = site.files.get(path);
        return file ? serve(req, res, file, YEAR) : notFound(req, res);
      },
      events: () => events(req, res, feed, url),
      stream: () => stream(feed, req, res, resumeFrom(req, url)),
      // Each relayed refusal's check, by seq: `verified`, `redacted` or `unverified`, and nothing of its record.
      refusals: () => {
        refusals.of(feed.signedRefusals).then(
          (checks) => {
            res.setHeader('cache-control', 'no-store');
            send(req, res, 200, 'application/json', JSON.stringify(checks));
          },
          (error: unknown) => {
            log.error({ err: error }, 'The refusals could not be checked');
            if (!res.headersSent)
              send(req, res, 500, 'text/plain; charset=utf-8', 'The refusals could not be checked.\n');
          },
        );
      },
      artifacts: () => {
        const hash = route.values.hash ?? '';
        // Nothing that goes wrong with one artifact may end the server: it ends that response.
        artifact(req, res, feed, artifacts, hash).catch((error: unknown) => {
          log.error({ err: error, hash }, 'An artifact could not be served');
          if (res.destroyed) return;
          if (res.headersSent) res.destroy();
          else send(req, res, 500, 'text/plain; charset=utf-8', 'The artifact could not be read.\n');
        });
      },
    };
    handlers[route.name]();
  };
}

const notFound = (req: IncomingMessage, res: ServerResponse) =>
  send(req, res, 404, 'text/plain; charset=utf-8', 'Not found. The console lives at /.\n');

/** The public events after `?after=`, as a JSON array, compressed when the browser accepts it. */
function events(req: IncomingMessage, res: ServerResponse, feed: Feed, url: URL): void {
  const after = Number(url.searchParams.get('after') ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) {
    send(req, res, 400, 'text/plain; charset=utf-8', '`after` is the seq of the last event you have.\n');
    return;
  }
  const json = feed.after(after).map((event) => event.json);
  const body = Buffer.from(`[${json.join(',')}]`);
  res.setHeader('cache-control', 'no-store');
  // Brotli at quality 5 makes the samples 15% smaller than gzip for about the same time: 2 ms for 200 KB.
  const encoding =
    body.length < 1024 ? undefined : accepts(req, 'br') ? 'br' : accepts(req, 'gzip') ? 'gzip' : undefined;
  if (!encoding) {
    send(req, res, 200, 'application/json', body);
    return;
  }
  const done = (error: Error | null, compressed: Buffer) => {
    if (!error) {
      res.setHeader('content-encoding', encoding);
      res.setHeader('vary', 'accept-encoding');
    }
    send(req, res, 200, 'application/json', error ? body : compressed);
  };
  if (encoding === 'br') brotliCompress(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }, done);
  else gzip(body, done);
}

/** An artifact a public event refers to, with the type recorded when it was stored. Nothing else is served. */
async function artifact(req: IncomingMessage, res: ServerResponse, feed: Feed, store: ArtifactStore, hash: string) {
  const type = isHash(hash) ? feed.artifactType(hash) : undefined;
  // Opened once, its size taken from the same opening: a file replaced or removed meanwhile cannot send a length that
  // is not the length of the bytes that follow.
  const opened = type ? await store.open(hash) : null;
  // A stream closed unread can still fail as it closes: an error with no listener would end the server. pipeline
  // reports a failed read; a file closed unread has nothing worth reporting.
  opened?.body.on('error', () => {});
  // A browser that left while the file was being found is owed nothing, and piping to its closed response throws.
  if (res.destroyed) {
    opened?.body.destroy();
    return;
  }
  if (!type || !opened) return send(req, res, 404, 'text/plain; charset=utf-8', 'No such artifact.\n');
  const { body, size } = opened;
  try {
    res.writeHead(200, {
      'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
      'content-length': size,
      'cache-control': YEAR,
      // Opened on its own, an artifact is inert: no script, no styles, no requests.
      'content-security-policy': "default-src 'none'; sandbox",
    });
  } catch (error) {
    // A header it refuses (a recorded type no header may carry) leaves the file open unless it is closed here.
    body.destroy();
    throw error;
  }
  if (req.method === 'HEAD') {
    body.destroy();
    res.end();
    return;
  }
  // A browser that stops loading partway (a card flicked past, a tab closed) leaves the file to be closed, and a
  // read can fail: pipeline closes the file either way, and a failed read ends this response, not the server.
  pipeline(body, res, (error) => {
    if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE')
      log.warn({ err: error, hash }, 'An artifact failed to send');
  });
}

function serve(req: IncomingMessage, res: ServerResponse, file: File, cacheControl: string): void {
  res.setHeader('cache-control', cacheControl);
  if (file.br || file.gzip) res.setHeader('vary', 'accept-encoding');
  const [encoding, body] =
    file.br && accepts(req, 'br')
      ? ['br', file.br]
      : file.gzip && accepts(req, 'gzip')
        ? ['gzip', file.gzip]
        : [undefined, file.body];
  if (encoding) res.setHeader('content-encoding', encoding);
  send(req, res, 200, file.type, body);
}

const accepts = (req: IncomingMessage, encoding: string) =>
  String(req.headers['accept-encoding'] ?? '')
    .split(',')
    .some((part) => part.trim().split(';')[0] === encoding);

function send(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}
