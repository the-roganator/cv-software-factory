/**
 * The intake: an HTTP server for Alertmanager's webhook (`POST /v1/alerts`). Each firing alert becomes one signal in
 * the inbox; a resolved alert writes nothing.
 *
 * Alertmanager sends again after a 5xx and never after a 4xx, so an alert the factory cannot use is answered 422 and
 * one that failed for a reason that may pass (a backend down, the database) is answered 503. Patching Prometheus, Loki
 * or Postgres restarts it, and an alert that could not reach it meanwhile is a warning: the alert Alertmanager sends
 * again is the pass that follows.
 */
import type { IncomingMessage, RequestListener } from 'node:http';
import type { Logger } from 'pino';
import { TELEMETRY_AWAY_MS, telemetryAway } from '../clients/http.ts';
import type { Outbox } from '../outbox.ts';
import { PassLog, STORE } from '../store-absence.ts';
import { type Backends, parse, Refused, signalFor } from './alerts.ts';

const MAX_BODY_BYTES = 1_000_000;

export interface Intake {
  backends: Backends;
  outbox: Outbox;
  log: Logger;
}

/**
 * Says how each firing alert ended: one that could not reach the telemetry it reads or the store, while that has been
 * away under its time (two minutes for telemetry, one for the store), as a warning, and any other failure as an error.
 */
function alertPasses(log: Logger, now: () => Date): PassLog {
  return new PassLog(
    log,
    now,
    {
      away: 'an alert could not reach the telemetry it reads, as for a restart; Alertmanager will send it again',
      stillAway:
        'alert failed: the telemetry it reads has been away for over two minutes; Alertmanager will send it again',
      failed: 'alert failed; Alertmanager will send it again',
      back: (seconds) => `an alert reached the telemetry it reads again, after ${seconds} s`,
    },
    [
      { away: telemetryAway, awayMs: TELEMETRY_AWAY_MS },
      {
        ...STORE,
        words: {
          away: 'an alert could not reach the store, as for a restart; Alertmanager will send it again',
          stillAway: 'alert failed: the store has been away for over a minute; Alertmanager will send it again',
          back: (seconds) => `an alert reached the store again, after ${seconds} s`,
        },
      },
    ],
  );
}

export function createIntake({ backends, outbox, log }: Intake): RequestListener {
  const passes = alertPasses(log, () => backends.now());
  return async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    const { pathname } = new URL(req.url ?? '/', 'http://intake');
    if (pathname === '/health') return send(200, { ok: true });
    if (pathname !== '/v1/alerts' || req.method !== 'POST') return send(404, { error: 'not found' });

    let alerts: ReturnType<typeof parse>;
    try {
      alerts = parse(JSON.parse(await readBody(req)));
    } catch {
      return send(400, { error: 'the body is not an Alertmanager webhook' });
    }

    let accepted = 0;
    let refused = 0;
    let failed = 0;
    for (const alert of alerts.filter((a) => a.status === 'firing')) {
      const route = alert.labels.route;
      try {
        await outbox.send(await signalFor(alert, backends));
        accepted += 1;
        passes.passed();
        log.info({ route, objective: alert.labels.objective }, 'alert became a signal');
      } catch (error) {
        if (error instanceof Refused) {
          refused += 1;
          log.warn({ route, objective: alert.labels.objective, reason: error.message }, 'alert refused');
        } else {
          failed += 1;
          passes.failed(error, { route, objective: alert.labels.objective });
        }
      }
    }
    send(failed ? 503 : refused && !accepted ? 422 : 200, { accepted, refused, failed });
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('The body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
