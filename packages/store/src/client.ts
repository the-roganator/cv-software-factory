/**
 * The store's client: postgres.js, with metrics of its own, since OpenTelemetry's `pg` instrumentation does not cover
 * it. Every worker, the console and the store's own commands make their client here, so the series cover each once.
 *
 * - `store.query.duration`, in seconds, by `operation` (the statement's first word: `select`, `insert`, `begin`,
 *   or `other`) and `outcome` (`ok` or `error`), with the error's `code` when it failed: Postgres's SQLSTATE, such as
 *   `23505`, or the client's own, such as `CONNECTION_CLOSED` or `ECONNREFUSED`. It runs from when the query is asked
 *   for to its answer, so a wait for a free connection counts too.
 * - `store.connections`: the connections the client holds open now.
 * - `store.connection.attempts`, by `outcome`: `connected`, or `failed` for one that never became ready to take a
 *   query: refused, closed, timed out or turned away at login.
 *
 * Never a work item, a row or the statement's text: they would make a series of each, and a statement's text or
 * parameters can hold what a visitor wrote. Until `telemetry.ts` starts an SDK, the instruments are no-ops.
 *
 * postgres.js publishes what it does on Node's diagnostics channels, and the counts are read from there. The channels
 * are the process's, so they count every client of postgres.js in it from the first `connect` on: the clients made
 * here, the connection each keeps for `listen`, and any made otherwise.
 */
import { subscribe } from 'node:diagnostics_channel';
import { metrics } from '@opentelemetry/api';
import postgres, { type Sql } from 'postgres';

type Options = NonNullable<Parameters<typeof postgres>[1]>;

/** A value postgres.js sends as JSON, as `sql.json` takes it. */
export type JSONValue = postgres.JSONValue;

/**
 * A client of the store, by URL, or by the standard PG* variables without one, with its notices kept off the log. The
 * options are postgres.js's own.
 */
export function connect(url?: string, options: Options = {}): Sql {
  observe();
  const settings = { onnotice: () => {}, ...options };
  return url ? postgres(url, settings) : postgres(settings);
}

// Made when they are first used, so the SDK telemetry.ts starts is the one they report to, and made again if another
// takes its place, as a test's does.
let made: { provider: unknown; instruments: ReturnType<typeof make> } | undefined;
function instruments() {
  const provider = metrics.getMeterProvider();
  if (made?.provider !== provider) made = { provider, instruments: make() };
  return made.instruments;
}
function make() {
  const meter = metrics.getMeter('factory-store');
  const kept = {
    duration: meter.createHistogram('store.query.duration', {
      description: 'How long a query to the store took, a wait for a connection included',
      unit: 's',
      // Most of the store's queries take a few milliseconds; the default buckets start at five seconds.
      advice: {
        explicitBucketBoundaries: [0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      },
    }),
    connections: meter.createUpDownCounter('store.connections', {
      description: 'Connections to the store the client holds open',
    }),
    attempts: meter.createCounter('store.connection.attempts', {
      description: 'Connections to the store the client tried to open, by whether they opened',
    }),
  };
  // From 0, so the first of each is counted, as Prometheus's `increase` reads nothing into a series' first sample. An
  // attempt within the same export as its zero, such as a worker's first, goes out with it and is still lost.
  for (const outcome of ['connected', 'failed']) kept.attempts.add(0, { outcome });
  return kept;
}

// The statement's first word, if it is one of these: anything else is `other`, so no text of a query makes a series.
const OPERATIONS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'with',
  'begin',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'listen',
  'unlisten',
  'notify',
  'set',
  'lock',
  'copy',
  'create',
  'alter',
  'drop',
  'grant',
  'revoke',
  'truncate',
  'do',
]);
function operation(text: string | null | undefined): string {
  const word = text?.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase();
  return word && OPERATIONS.has(word) ? word : 'other';
}

// An error's code, if it looks like one: Postgres's five-character SQLSTATE, postgres.js's and Node's upper-case names.
const code = (error: unknown) => {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' && /^[A-Z0-9_]{1,40}$/.test(value) ? value : 'unknown';
};

// Counting is never worth a query: a subscriber that throws would end the process, as Node raises its error again.
function counted(count: () => void) {
  try {
    count();
  } catch {}
}

/** What postgres.js publishes of a query once it has settled, and of an attempt to connect. */
interface Traced {
  query?: string | null;
  queued?: number;
  complete?: number | null;
  error?: unknown;
}

// Once in the process, as the channels are: a second copy of this module, such as a bundler's beside Node's own, would
// otherwise count everything twice. It holds the ids of the connections seen opening, so a connection opened before the
// first `connect`, by a client made otherwise, is never taken off the count as it closes.
const OBSERVING = Symbol.for('@software-factory/store.observing');

/** Subscribes to postgres.js's channels, once in the process. */
function observe() {
  // The instruments, and the connection attempts' zeros, before the first attempt, which is often moments away.
  counted(instruments);
  const shared = globalThis as { [OBSERVING]?: Set<unknown> };
  if (shared[OBSERVING]) return;
  const open = new Set<unknown>();
  shared[OBSERVING] = open;
  // A query is published from when postgres.js is asked to run it, and its tracing channel's `asyncEnd` once it has
  // settled, failed or not: a transaction's `begin` and `commit`, and a cursor, each once. A fragment nested in another
  // query never runs, and is never published.
  subscribe('tracing:postgres:query:asyncEnd', (message) =>
    counted(() => {
      const query = message as Traced;
      // A query published without when it was asked for has no time to record.
      if (typeof query.queued !== 'number') return;
      const seconds = ((query.complete ?? performance.now()) - query.queued) / 1000;
      const outcome = query.error === undefined ? { outcome: 'ok' } : { outcome: 'error', code: code(query.error) };
      instruments().duration.record(seconds, { operation: operation(query.query), ...outcome });
    }),
  );
  // Each attempt to connect to a host, settled once the connection is ready for queries or has failed. One that was ready
  // is `connected` even if the pool then lets it go unused, as it does when it is ending.
  subscribe('tracing:postgres:connect:asyncEnd', (message) =>
    counted(() => {
      const outcome = (message as Traced).error === undefined ? 'connected' : 'failed';
      instruments().attempts.add(1, { outcome });
    }),
  );
  // A connection the pool opened, and the same connection closing: a failed attempt is never one of the pool's.
  subscribe('postgres:pool', (message) =>
    counted(() => {
      const { event, connection } = message as { event?: string; connection?: unknown };
      if (event === 'open' && !open.has(connection)) {
        open.add(connection);
        instruments().connections.add(1);
      } else if (event === 'close' && open.delete(connection)) instruments().connections.add(-1);
    }),
  );
}
