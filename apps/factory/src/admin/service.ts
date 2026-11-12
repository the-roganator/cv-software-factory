/** Starts the admin service: its store, its full-event streams and its server, and how to stop them. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from '@software-factory/store';
import type { Sql } from 'postgres';
import { listenOn } from '../listen.ts';
import { log } from '../log.ts';
import { type KubeWriter, kubeFrom } from '../runners/kube.ts';
import { createAdminApp } from './app.ts';
import { observeAutoRollback } from './auto-rollback.ts';
import type { AdminConfig } from './config.ts';
import { FlagStages } from './flags.ts';
import { FlagsHeld, observeHeld } from './flags-held.ts';
import { observePhone } from './phone.ts';
import { ReleaseControls } from './rollout.ts';
import { AdminStore } from './store.ts';
import { FullEvents, RECHECK_MS } from './stream.ts';

export interface AdminService {
  server: Server;
  events: FullEvents;
  stop(): Promise<void>;
}

/**
 * Listens on the configured port, or on `port` if given (0 for any, in the tests), on every address, or on `host` alone.
 * A test names the address it connects to: on macOS, a port picked for every address can be one another program already
 * listens on over IPv4, and that program, not the service, then answers requests to 127.0.0.1.
 */
export async function startAdmin(
  config: AdminConfig,
  {
    sql = connect(process.env.DATABASE_URL),
    port = config.port,
    host,
    recheckMs = RECHECK_MS,
    stopWaitMs,
    kube,
    held: given,
  }: {
    sql?: Sql;
    port?: number;
    host?: string;
    recheckMs?: number;
    /** How long Stop the line waits between its looks at the Rollout: a second unless the tests say less. */
    stopWaitMs?: number;
    kube?: KubeWriter;
    /** Whether the app holds the flags as set: by default checked when it has both `flags` and the Rollout; false, never. */
    held?: FlagsHeld | false;
  } = {},
): Promise<AdminService> {
  const store = new AdminStore(sql);
  const events = new FullEvents(sql, store, log, recheckMs);
  await events.start();
  // The app's Rollout, through the admin service's own service account (or `kubectl proxy` on a host), when it has one.
  const api = config.rollout || config.flags ? (kube ?? kubeFrom()) : undefined;
  const controls =
    api && config.rollout ? new ReleaseControls(api, config.rollout, sql, log, { waitMs: stopWaitMs }) : undefined;
  // Whether the app holds the flags as set: its pods, behind the Rollout's Services, asked for the revision of theirs.
  const held =
    given !== undefined
      ? given || undefined
      : api && config.flags && config.rollout
        ? new FlagsHeld({ kube: api, flags: config.flags, rollout: config.rollout, log })
        : undefined;
  // The feature flags' stages, judged against the canary in flight that `controls` reads, each write checked by `held`.
  const flags = api && config.flags ? new FlagStages(api, config.flags, sql, log, controls, held) : undefined;
  const server = createServer(
    createAdminApp({
      config,
      store,
      events,
      log,
      ...(controls && { controls }),
      ...(flags && { flags }),
      ...(held && { held }),
    }),
  );
  // Slow requests are cut off: nothing here takes long to send.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  try {
    await listenOn(server, port, host);
  } catch (error) {
    // A port it cannot have: what it opened is let go, and the caller is told why, whatever the letting go says.
    await (async () => {
      try {
        await events.stop();
      } finally {
        await sql.end();
      }
    })().catch((cleanup: unknown) =>
      log.warn({ err: cleanup }, 'could not close the admin service after it failed to listen'),
    );
    throw error;
  }
  // A narrowing or Off written just before this start: its minute goes on, rather than being forgotten by the restart.
  if (held && given === undefined) await narrowedBefore(sql, held);
  held?.start();
  const unobserve = held && observeHeld(held);
  const unobservePhone = observePhone(sql, config.profile, log);
  // Whether auto-rollback is on: the canary's analysis pauses a bad canary only while this and the line's say off.
  const unobserveAutoRollback = observeAutoRollback(sql, log);
  const bound = (server.address() as AddressInfo).port;
  log.info(
    {
      host: host ?? null,
      port: bound,
      origin: config.origin,
      rpId: config.rpId,
      rollout: config.rollout ?? null,
      flags: config.flags ?? null,
      checksFlagsHeld: held !== undefined,
    },
    `admin service listening on ${host ?? ''}:${bound}`,
  );

  const stop = async () => {
    unobserve?.();
    unobservePhone();
    unobserveAutoRollback();
    await held?.stop();
    await events.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await sql.end();
  };
  return { server, events, stop };
}

/** Gives the check the last narrowing or Off Martin recorded, if any: it counts only one written minutes ago. */
async function narrowedBefore(sql: Sql, held: FlagsHeld): Promise<void> {
  try {
    const [last] = await sql<{ ts: Date }[]>`
      select ts from events
      where type = 'flag.staged' and (payload->>'action' in ('flag.narrow', 'flag.off') or payload ? 'dropped')
        and appended_by = 'factory_admin' and not sample
      order by seq desc limit 1`;
    if (last) held.narrowedBefore(last.ts.getTime());
  } catch (error) {
    log.warn({ err: error }, 'could not read the last narrowing of a flag: one made before this start is not counted');
  }
}
