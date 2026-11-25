import type { InboxSignal } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import type { LogRecord } from '../src/clients/loki.ts';
import { Loki } from '../src/clients/loki.ts';
import { Prometheus } from '../src/clients/prometheus.ts';
import { Tempo } from '../src/clients/tempo.ts';
import { checkTurns, turn } from '../src/commands/logs.ts';
import { reportSignalId, signalForReport } from '../src/logs/reports.ts';
import { Watcher } from '../src/logs/watcher.ts';
import { printing } from '../src/outbox.ts';
import { fakeFetch, ns, streams, VERSION, vector } from './fakes.ts';

/** What a visitor wrote. Nothing the factory logs, counts or throws may contain it. */
const TEXT = 'The teapot lid will not stay on, ZEBRA-7731 is my order';
const NOW = new Date('2026-10-03T21:00:00Z');

const widgetRecord = (time: string, fields: Record<string, string>): LogRecord => ({
  ns: ns(time),
  time: new Date(time),
  line: 'report',
  fields: { event: 'report', service_version: VERSION, ...fields },
});

describe('a report record becomes a report signal', () => {
  it('carries the page and the text, and the route when it can be told', () => {
    const signal = signalForReport(
      widgetRecord('2026-10-03T20:59:00Z', { page: '/products/teapot-lid', text: TEXT }),
      (page) => (page === '/products/teapot-lid' ? '/products/:slug' : undefined),
    );
    expect(signal).toEqual({
      sense: 'report',
      check: 'report widget',
      route: '/products/:slug',
      version: VERSION,
      observedAt: '2026-10-03T20:59:00.000Z',
      report: { page: '/products/teapot-lid', text: TEXT },
      artifacts: [],
    });
    expect(validateSignal(signal)).toEqual({ ok: true });
  });

  it('is about the page itself when the logs cannot say which route served it', () => {
    const signal = signalForReport(widgetRecord('2026-10-03T20:59:00Z', { page: '/odd', text: TEXT }), () => undefined);
    expect(signal?.route).toBe('/odd');
  });

  it('keeps the page’s path only, because its query is the visitor’s too', () => {
    const signal = signalForReport(
      widgetRecord('2026-10-03T20:59:00Z', { page: '/search?q=my+secret#top', text: TEXT }),
      () => undefined,
    );
    expect(signal?.report?.page).toBe('/search');
  });

  it('reads a record whose body is the JSON of the report', () => {
    const record = {
      ...widgetRecord('2026-10-03T20:59:00Z', {}),
      line: JSON.stringify({ page: '/about', text: TEXT }),
    };
    expect(signalForReport(record, () => undefined)?.report).toEqual({ page: '/about', text: TEXT });
  });

  it('leaves out what it cannot make a signal of: no text, no page, no version', () => {
    const none = () => undefined;
    expect(signalForReport(widgetRecord('2026-10-03T20:59:00Z', { page: '/about', text: '  ' }), none)).toBeUndefined();
    expect(signalForReport(widgetRecord('2026-10-03T20:59:00Z', { page: 'about', text: TEXT }), none)).toBeUndefined();
    expect(signalForReport(widgetRecord('2026-10-03T20:59:00Z', { text: TEXT }), none)).toBeUndefined();
    const unversioned = {
      ...widgetRecord('2026-10-03T20:59:00Z', { page: '/about', text: TEXT }),
      fields: { page: '/about', text: TEXT },
    };
    expect(signalForReport(unversioned, none)).toBeUndefined();
  });

  it('takes an id from its record, the same at every reading and its own to the record', () => {
    const record = widgetRecord('2026-10-03T20:59:00Z', { page: '/about', text: TEXT });
    const id = reportSignalId(record);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(reportSignalId(structuredClone(record))).toBe(id);
    expect(reportSignalId(widgetRecord('2026-10-03T20:59:00Z', { page: '/about', text: `${TEXT}!` }))).not.toBe(id);
    expect(reportSignalId({ ...record, ns: (BigInt(record.ns) + 1n).toString() })).not.toBe(id);
    expect(id).not.toContain('ZEBRA');
  });

  it('cuts a very long text to what the inbox accepts', () => {
    const signal = signalForReport(
      widgetRecord('2026-10-03T20:59:00Z', { page: '/about', text: 'x'.repeat(5000) }),
      () => undefined,
    );
    expect(signal?.report?.text).toHaveLength(2000);
    expect(validateSignal(signal)).toEqual({ ok: true });
  });
});

/** A watcher over a fake Loki that holds the given reports, with everything it logs captured. */
function watching(
  reports: LogRecord[],
  send: (signal: InboxSignal, id?: string) => Promise<void>,
  from = new Date('2026-10-03T20:00:00Z'),
) {
  const logged: string[] = [];
  const seen: URL[] = [];
  const loki = fakeFetch(
    [
      {
        path: '/loki/api/v1/query_range',
        when: (url) => (url.searchParams.get('query') ?? '').includes('event="report"'),
        answer: () =>
          streams(...reports.map((r): [string, string, Record<string, string>] => [r.ns, r.line, r.fields])),
      },
      {
        path: '/loki/api/v1/query',
        answer: () => vector([{ path: '/products/teapot-lid', route: '/products/:slug' }, 4]),
      },
    ],
    seen,
  );
  const watcher = new Watcher(
    {
      objectives,
      loki: new Loki('http://loki', loki),
      prometheus: new Prometheus('http://prometheus', fakeFetch([])),
      tempo: new Tempo('http://tempo', fakeFetch([])),
      outbox: { send },
      log: pino({ level: 'trace' }, { write: (line: string) => void logged.push(line) }),
    },
    { errors: NOW, reports: from },
  );
  /** Where each of the report check's reads of Loki started. */
  const starts = () =>
    seen
      .filter((url) => (url.searchParams.get('query') ?? '').includes('event="report"'))
      .map((url) => new Date(Number(BigInt(url.searchParams.get('start') ?? '0') / 1_000_000n)).toISOString());
  return { watcher, logged, starts };
}

describe('the log watcher and reports', () => {
  const reports = [
    widgetRecord('2026-10-03T20:30:00Z', { page: '/products/teapot-lid', text: TEXT }),
    widgetRecord('2026-10-03T20:45:00Z', { page: '/about', text: `${TEXT} again` }),
  ];

  it('sends each report once, and not again at its next check', async () => {
    const sent: InboxSignal[] = [];
    const { watcher } = watching(reports, async (signal) => void sent.push(signal));
    expect(await watcher.checkReports(NOW)).toBe(2);
    expect(sent.map((s) => s.route)).toEqual(['/products/:slug', '/about']);
    expect(await watcher.checkReports(NOW)).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it('puts the text in the inbox and in no log line the factory writes', async () => {
    const { watcher, logged } = watching(reports, async () => {});
    await watcher.checkReports(NOW);
    await watcher.checkReports(NOW);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain('teapot lid');
      expect(line).not.toContain('ZEBRA');
      expect(line).not.toContain('/about');
    }
  });

  it('puts the text in no error message when the inbox refuses it, and does not move on', async () => {
    const { watcher, logged } = watching(reports, async (signal) => {
      throw new Error(`The inbox refuses this signal: ${JSON.stringify(signal)}`);
    });
    const failure = await watcher.checkReports(NOW).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('ZEBRA');
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('ZEBRA');
    expect(logged.join('')).not.toContain('ZEBRA');

    // The next check tries the same report again, rather than losing it.
    const retried: InboxSignal[] = [];
    const again = watching(reports, async (signal) => void retried.push(signal));
    expect(await again.watcher.checkReports(NOW)).toBe(2);
  });

  it('rides out a store that restarts as a report is sent: a warning, and the report in the inbox once', async () => {
    // The inbox as the store keeps it: the first signal of an id, and no other. Its second send is cut off after the
    // store took the signal, the worst a restart does.
    const inbox = new Map<string | undefined, InboxSignal>();
    let sends = 0;
    const { watcher, logged } = watching(reports, async (signal, id) => {
      if (!inbox.has(id)) inbox.set(id, signal);
      sends += 1;
      if (sends === 2) throw Object.assign(new Error(`write CONNECTION_CLOSED ${TEXT}`), { code: 'CONNECTION_CLOSED' });
    });
    const lines: { level: number; msg: string }[] = [];
    const log = pino({ level: 'trace' }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const turns = checkTurns(log, () => NOW, 'reports');

    await turn(turns, () => watcher.checkReports(NOW));
    await turn(turns, () => watcher.checkReports(NOW));
    await turn(turns, () => watcher.checkReports(NOW));

    expect(lines.map(({ level, msg }) => [pino.levels.labels[level], msg])).toEqual([
      ['warn', 'a check could not reach the store, as for a restart: its next turn tries again'],
      ['info', 'the check reached the store again, after 0 s'],
    ]);
    expect(sends).toBe(3);
    expect([...inbox.values()].map((signal) => signal.report?.page)).toEqual(['/products/teapot-lid', '/about']);
    expect(JSON.stringify(lines) + logged.join('')).not.toContain('ZEBRA');
  });

  it('shows a dry run’s report as its length', async () => {
    const lines: string[] = [];
    const { watcher } = watching(reports, (signal) => printing((line) => lines.push(line)).send(signal));
    await watcher.checkReports(NOW);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('ZEBRA');
    expect(JSON.parse(lines[0] ?? '').report).toEqual({
      page: '/products/teapot-lid',
      text: `(${TEXT.length} characters)`,
    });
  });

  it('reads back ten minutes at each check, and sends a report that reached Loki late once', async () => {
    const late: LogRecord[] = [];
    const sent: InboxSignal[] = [];
    const { watcher, starts } = watching(late, async (signal) => void sent.push(signal));
    const after = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

    expect(await watcher.checkReports(NOW)).toBe(0);
    expect(await watcher.checkReports(after(10))).toBe(0);
    expect(await watcher.checkReports(after(20))).toBe(0);
    // The first read goes back to where the watcher started; each after it only ten minutes.
    expect(starts()).toEqual(['2026-10-03T20:00:00.000Z', '2026-10-03T20:50:00.000Z', '2026-10-03T20:50:10.000Z']);

    // Written seven minutes ago, inside the margin, and only now in Loki.
    late.push(widgetRecord('2026-10-03T20:53:00Z', { page: '/about', text: TEXT }));
    expect(await watcher.checkReports(after(30))).toBe(1);
    expect(await watcher.checkReports(after(40))).toBe(0);
    expect(sent).toHaveLength(1);
    // Each read starts where the one before it would have settled.
    expect(starts().at(-1)).toBe('2026-10-03T20:50:30.000Z');
  });

  it('sends a report that reaches Loki after a newer one was sent', async () => {
    const inLoki: LogRecord[] = [widgetRecord('2026-10-03T20:59:00Z', { page: '/about', text: `${TEXT} later` })];
    const sent: InboxSignal[] = [];
    const { watcher } = watching(inLoki, async (signal) => void sent.push(signal));
    expect(await watcher.checkReports(NOW)).toBe(1);

    // Written a minute before the one already sent, by a pod whose export was retried.
    inLoki.unshift(widgetRecord('2026-10-03T20:58:00Z', { page: '/products/teapot-lid', text: TEXT }));
    expect(await watcher.checkReports(new Date(NOW.getTime() + 10_000))).toBe(1);
    expect(await watcher.checkReports(new Date(NOW.getTime() + 20_000))).toBe(0);
    expect(sent.map((s) => s.report?.page)).toEqual(['/about', '/products/teapot-lid']);
  });

  it('gives a report the same id when a restarted watcher reads it again, so the inbox keeps it once', async () => {
    const inLoki = [widgetRecord('2026-10-03T20:58:00Z', { page: '/about', text: TEXT })];
    const ids: (string | undefined)[] = [];
    const first = watching(inLoki, async (_signal, id) => void ids.push(id));
    expect(await first.watcher.checkReports(NOW)).toBe(1);

    // Restarted from the last report the inbox holds, it reads back over the margin before it.
    const restarted = watching(inLoki, async (_signal, id) => void ids.push(id), new Date('2026-10-03T20:58:00Z'));
    await restarted.watcher.checkReports(new Date(NOW.getTime() + 60_000));
    expect(restarted.starts()).toEqual(['2026-10-03T20:51:00.000Z']);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[0]).toBe(reportSignalId(inLoki[0] as LogRecord));
  });
});
