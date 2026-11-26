import { createServer, type Server } from 'node:http';
import type { InboxSignal } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import { BackendAnswered } from '../src/clients/http.ts';
import { Loki } from '../src/clients/loki.ts';
import { Prometheus } from '../src/clients/prometheus.ts';
import { type Backends, parse, signalFor } from '../src/intake/alerts.ts';
import { createIntake } from '../src/intake/server.ts';
import type { Outbox } from '../src/outbox.ts';
import { STORE_AWAY_MS } from '../src/store-absence.ts';
import { fakeFetch, matrix, ns, streams, VERSION, vector } from './fakes.ts';

const NOW = new Date('2026-10-03T21:00:00Z');

const errorAlert = {
  status: 'firing',
  labels: {
    alertname: 'RouteErrorRatioAboveObjective',
    route: '/products/glove-left',
    http_route: '/products/glove-left',
    symptom: 'server-error',
    objective: 'error-ratio',
  },
  annotations: { threshold: '0.05' },
  startsAt: '2026-10-03T20:40:00Z',
};
const webhook = (...alerts: unknown[]) => ({ version: '4', status: 'firing', alerts });
function alertOf(alert: unknown) {
  const [parsed] = parse(webhook(alert));
  if (!parsed) throw new Error('the test alert did not parse');
  return parsed;
}

function backends(seen: URL[] = [], overrides: { versions?: unknown; failPrometheus?: boolean } = {}): Backends {
  const points: [number, number][] = Array.from({ length: 61 }, (_, i) => [
    NOW.getTime() / 1000 - 3600 + i * 60,
    i < 40 ? 0.01 : 0.2,
  ]);
  const prometheus = fakeFetch(
    [
      {
        path: '/api/v1/query_range',
        answer: () => {
          if (overrides.failPrometheus) throw new Error('Prometheus is down');
          return matrix(points);
        },
      },
      { path: '/api/v1/query', answer: () => overrides.versions ?? vector([{ service_version: VERSION }, 30]) },
    ],
    seen,
  );
  const loki = fakeFetch(
    [
      {
        path: '/loki/api/v1/query_range',
        answer: () =>
          streams([
            ns('2026-10-03T20:50:00Z'),
            'GET /products/glove-left 200',
            { path: '/products/glove-left', route: '/products/:slug' },
          ]),
      },
    ],
    seen,
  );
  return {
    objectives,
    prometheus: new Prometheus('http://prometheus', prometheus),
    loki: new Loki('http://loki', loki),
    now: () => NOW,
  };
}

describe('the intake, from an alert to a signal', () => {
  it('makes a metrics signal of an error-ratio alert, with the series behind it', async () => {
    const seen: URL[] = [];
    const alert = alertOf(errorAlert);
    const signal = await signalFor(alert, backends(seen));

    expect(signal).toMatchObject({
      sense: 'metrics',
      check: 'error ratio',
      // The metrics know the path; the log knows the route it was served by.
      route: '/products/:slug',
      version: VERSION,
      symptom: 'server-error',
      observedAt: NOW.toISOString(),
    });
    expect(validateSignal(signal)).toEqual({ ok: true });

    const [picture] = signal.evidence ?? [];
    expect(picture).toMatchObject({
      kind: 'metric',
      unit: 'ratio',
      objective: 0.05,
      stepSeconds: 60,
      start: '2026-10-03T20:00:00.000Z',
      marker: { index: 40, label: 'alert fired' },
    });
    expect(picture?.kind === 'metric' && picture.values).toHaveLength(61);
    expect(picture?.kind === 'metric' && picture.values[45]).toBeCloseTo(0.2);

    // The series asked for is the objective's, for that route and no other.
    const asked = seen.find((url) => url.pathname === '/api/v1/query_range')?.searchParams.get('query');
    expect(asked).toContain('http_route="/products/glove-left"');
    expect(asked).toContain('5..');
  });

  it('makes a slow-response signal of a latency alert, in seconds', async () => {
    const alert = alertOf({
      ...errorAlert,
      labels: { ...errorAlert.labels, symptom: 'slow-response', objective: 'latency' },
      annotations: { threshold: '1' },
    });
    const signal = await signalFor(alert, backends());
    expect(signal).toMatchObject({ check: 'latency p95', symptom: 'slow-response' });
    expect(signal.evidence?.[0]).toMatchObject({ kind: 'metric', unit: 's', objective: 1, name: 'p95 latency' });
  });

  it('falls back to the path when the log does not know the route', async () => {
    const empty = backends();
    empty.loki = new Loki('http://loki', fakeFetch([{ path: '/loki/api/v1/query_range', answer: () => streams() }]));
    const alert = alertOf(errorAlert);
    expect((await signalFor(alert, empty)).route).toBe('/products/glove-left');
  });

  it('refuses an alert whose symptom the factory does not know, and one for an objective it lacks', async () => {
    const bad = alertOf({ ...errorAlert, labels: { ...errorAlert.labels, symptom: 'on-fire' } });
    await expect(signalFor(bad, backends())).rejects.toThrow('symptom class the factory lacks');
    const other = alertOf({ ...errorAlert, labels: { ...errorAlert.labels, objective: 'happiness' } });
    await expect(signalFor(other, backends())).rejects.toThrow('objective the factory does not know');
  });

  it('will not guess the version', async () => {
    const alert = alertOf(errorAlert);
    await expect(signalFor(alert, backends([], { versions: vector() }))).rejects.toThrow('no version');
  });
});

describe('the intake, over HTTP', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function post(body: unknown, options: { backends?: Backends; sent?: InboxSignal[] } = {}) {
    const sent = options.sent ?? [];
    const outbox: Outbox = { send: async (signal) => void sent.push(signal) };
    server = createServer(
      createIntake({ backends: options.backends ?? backends(), outbox, log: pino({ level: 'silent' }) }),
    );
    const { url } = await listenLocal(server);
    const response = await fetch(`${url}/v1/alerts`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('leaves one signal for each firing alert, and none for a resolved one', async () => {
    const sent: InboxSignal[] = [];
    const answer = await post(
      webhook(errorAlert, { ...errorAlert, status: 'resolved' }, { ...errorAlert, labels: { ...errorAlert.labels } }),
      { sent },
    );
    expect(answer).toEqual({ status: 200, body: { accepted: 2, refused: 0, failed: 0 } });
    expect(sent).toHaveLength(2);
  });

  it('answers 400 to what is not a webhook, so that nobody sends it again', async () => {
    expect((await post('{nope')).status).toBe(400);
    expect((await post({ alerts: 'many' })).status).toBe(400);
  });

  it('answers 422 to an alert that can never be a signal', async () => {
    const answer = await post(webhook({ ...errorAlert, labels: { route: '/x' } }));
    expect(answer).toEqual({ status: 422, body: { accepted: 0, refused: 1, failed: 0 } });
  });

  it('answers 503 when a backend fails, so that Alertmanager tries again', async () => {
    const answer = await post(webhook(errorAlert), { backends: backends([], { failPrometheus: true }) });
    expect(answer).toEqual({ status: 503, body: { accepted: 0, refused: 0, failed: 1 } });
  });

  describe('while what it depends on restarts', () => {
    const cut = () => Object.assign(new Error('write CONNECTION_CLOSED postgres:5432'), { code: 'CONNECTION_CLOSED' });

    /** An intake on a clock the test moves, whose sends end as `ends` says, and each line it logs. */
    async function intake(ends: { send?: () => void; prometheus?: () => void }) {
      let at = NOW.getTime();
      const lines: { level: number; msg: string }[] = [];
      const log = pino({ level: 'trace' }, { write: (line: string) => void lines.push(JSON.parse(line)) });
      const reads = backends();
      const range = reads.prometheus.range.bind(reads.prometheus);
      reads.prometheus.range = async (...args) => {
        ends.prometheus?.();
        return range(...args);
      };
      const sent: InboxSignal[] = [];
      const outbox: Outbox = {
        send: async (signal) => {
          ends.send?.();
          sent.push(signal);
        },
      };
      server = createServer(createIntake({ backends: { ...reads, now: () => new Date(at) }, outbox, log }));
      const { url } = await listenLocal(server);
      const alert = async () => {
        const response = await fetch(`${url}/v1/alerts`, { method: 'POST', body: JSON.stringify(webhook(errorAlert)) });
        return response.status;
      };
      const logged = () => lines.map(({ level, msg }) => `${pino.levels.labels[level]}: ${msg}`);
      return { alert, logged, sent, after: (ms: number) => (at += ms) };
    }

    it('warns while the store restarts, still answering 503, and says when the alert sent again reaches it', async () => {
      let away = true;
      const { alert, logged, sent, after } = await intake({
        send: () => {
          if (away) throw cut();
        },
      });
      expect(await alert()).toBe(503);
      after(10_000);
      away = false;
      expect(await alert()).toBe(200);
      expect(sent).toHaveLength(1);
      expect(logged()).toEqual([
        'warn: an alert could not reach the store, as for a restart; Alertmanager will send it again',
        'info: an alert reached the store again, after 10 s',
        'info: alert became a signal',
      ]);
    });

    it('warns while Prometheus restarts, and says when the alert sent again reaches it', async () => {
      let away = true;
      const { alert, logged, after } = await intake({
        prometheus: () => {
          if (away) throw new BackendAnswered('query:9090/api/v1/query_range answered 502', 502);
        },
      });
      expect(await alert()).toBe(503);
      after(30_000);
      away = false;
      expect(await alert()).toBe(200);
      expect(logged()).toEqual([
        'warn: an alert could not reach the telemetry it reads, as for a restart; Alertmanager will send it again',
        'info: an alert reached the telemetry it reads again, after 30 s',
        'info: alert became a signal',
      ]);
    });

    it('fails loudly once the store has been away a minute, and at once for anything else', async () => {
      let failure = cut;
      const { alert, logged, after } = await intake({
        send: () => {
          throw failure();
        },
      });
      expect(await alert()).toBe(503);
      after(STORE_AWAY_MS);
      expect(await alert()).toBe(503);
      failure = () => Object.assign(new Error('permission denied for table inbox'), { code: '42501' });
      expect(await alert()).toBe(503);
      expect(logged()).toEqual([
        'warn: an alert could not reach the store, as for a restart; Alertmanager will send it again',
        'error: alert failed: the store has been away for over a minute; Alertmanager will send it again',
        'error: alert failed; Alertmanager will send it again',
      ]);
    });
  });

  it('answers a health check', async () => {
    server = createServer(
      createIntake({ backends: backends(), outbox: { send: async () => {} }, log: pino({ level: 'silent' }) }),
    );
    const { url } = await listenLocal(server);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});
