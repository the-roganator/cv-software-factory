/**
 * Starts the console.
 *
 *     node --import ./src/telemetry.ts src/server.ts
 *
 * Where the events come from, in order of preference:
 *
 * - The event store, when PGHOST or DATABASE_URL is set. The console connects as its read-only role, and serves
 *   artifacts from ARTIFACTS_DIR.
 * - An event-log folder, when EVENT_LOG is set: its events and its artifacts, fixed when the server starts, and
 *   moved so the last event is now. EVENT_LOG_NOW sets that "now" instead, so tests can pin the time.
 * - Otherwise nothing: the console shows an empty store.
 *
 * PORT sets the port (default 8080), and HOST the one address to listen on: unset, as in the cluster, it listens on every
 * address; the browser tests set 127.0.0.1, the address they ask, so they cannot reach another program on the port.
 * REFUSAL_PUBLIC_KEY is the GitHub worker's public key (PEM), from the ConfigMap `refusal-key`, which each relayed
 * refusal is checked with (`refusals.ts`); an event-log folder may carry its own, as `refusal-key.pem`. With neither,
 * every relayed refusal reads as unverified.
 * GIT_COMMIT is the commit the build was made from, set by the image. FACTORY_PROFILE (default local) and ALL_LOCAL, as
 * the gateway's, are written into the page (`site.ts`).
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACTS_DIR } from '@software-factory/events';
import { REFUSAL_KEY_FILE } from '@software-factory/events/signed';
import { connect, DiskArtifacts } from '@software-factory/store';
import { createApp } from './app.ts';
import { Feed, logFeed, storeFeed } from './feed.ts';
import { listenOn } from './listen.ts';
import { log } from './log.ts';
import { RefusalChecks, refusalKey } from './refusals.ts';
import { loadSite, pageSettings } from './site.ts';
import { sendMetrics, shutdownTelemetry } from './telemetry.ts';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST || undefined;
const commit = process.env.GIT_COMMIT ?? 'dev';
const { DATABASE_URL, PGHOST, EVENT_LOG, EVENT_LOG_NOW } = process.env;
const logNow = () => (EVENT_LOG_NOW ? Date.parse(EVENT_LOG_NOW) : Date.now());

const sql = DATABASE_URL || PGHOST ? connect(DATABASE_URL, { max: 4 }) : undefined;
const source = sql
  ? { feed: await storeFeed(sql), artifacts: process.env.ARTIFACTS_DIR }
  : EVENT_LOG
    ? { feed: logFeed(EVENT_LOG, logNow()), artifacts: join(EVENT_LOG, ARTIFACTS_DIR) }
    : { feed: new Feed(), artifacts: undefined };
if (!sql && !EVENT_LOG) log.warn('no event store or event log configured: the console will show an empty store');

const artifacts = new DiskArtifacts(source.artifacts ?? mkdtempSync(join(tmpdir(), 'no-artifacts-')));
// The cluster's key, or, serving an event-log folder, the folder's own.
const logKey = !sql && EVENT_LOG ? join(EVENT_LOG, REFUSAL_KEY_FILE) : undefined;
const keyPem =
  process.env.REFUSAL_PUBLIC_KEY ?? (logKey && existsSync(logKey) ? readFileSync(logKey, 'utf-8') : undefined);
const key = refusalKey(keyPem);
if (!key) log.warn('no REFUSAL_PUBLIC_KEY: every relayed refusal reads as unverified');

const server = createServer(
  createApp({
    commit,
    site: loadSite(undefined, pageSettings(process.env)),
    feed: source.feed,
    artifacts,
    refusals: new RefusalChecks(artifacts, key),
  }),
);
// The event stream's count from 0 (stream.ts), before a browser that was waiting reconnects.
await sendMetrics();
try {
  await listenOn(server, port, host);
} catch (error) {
  // A port another program holds, or an address this host does not have: said in the log, and the process ends.
  log.error({ err: error, port, host }, 'console could not listen');
  await Promise.allSettled([sql?.end(), shutdownTelemetry()]);
  process.exit(1);
}
log.info({ port, host, commit }, `console listening on ${host ?? ''}:${port}`);

// Kubernetes sends SIGTERM before it stops the pod: finish the requests in flight, then flush telemetry.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'console stopping');
    server.close(() => void Promise.all([sql?.end(), shutdownTelemetry()]).finally(() => process.exit(0)));
    // Event streams never finish on their own.
    server.closeAllConnections();
  });
}
