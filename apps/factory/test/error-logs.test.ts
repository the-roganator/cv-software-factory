import type { InboxSignal } from '@software-factory/events';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import { type LogRecord, Loki } from '../src/clients/loki.ts';
import type { Tempo } from '../src/clients/tempo.ts';
import { keptLine, signalForPattern } from '../src/logs/errors.ts';
import { errorRecords, sameError } from '../src/logs/patterns.ts';
import { ERROR_FIELDS, errorLogs, Watcher } from '../src/logs/watcher.ts';
import { fakeFetch, ns, streams } from './fakes.ts';

/** An error record with the metadata the collector gives one, a stack trace among it. */
const everything: Record<string, string> = {
  service_name: 'website',
  service_namespace: 'website',
  service_version: 'v1.4.2',
  route: '/departments/:department',
  path: '/departments/kitchen',
  method: 'GET',
  event: 'request failed',
  exception_type: 'TypeError',
  exception_message: 'no "slug" on 42',
  exception_stacktrace: `TypeError: no "slug" on 42\n${'    at render (/app/server.js:120:7)\n'.repeat(40)}`,
  trace_id: '0af7651916cd43dd8448eb211c80319c',
  span_id: 'b7ad6b7169203331',
  severity_text: 'ERROR',
  severity_number: '17',
  detected_level: 'error',
  k8s_pod_name: 'website-6d9f7c-abcde',
  process_command_args: '["node","server.js"]',
};

const record = (fields: Record<string, string>): LogRecord => ({
  ns: ns('2026-10-17T08:00:00Z'),
  time: new Date('2026-10-17T08:00:00Z'),
  line: 'GET /departments/kitchen failed',
  fields,
});

/** The record as Loki gives it under `keep`: its fields cut to those named. */
const kept = (fields: Record<string, string>) =>
  Object.fromEntries(Object.entries(fields).filter(([name]) => (ERROR_FIELDS as readonly string[]).includes(name)));

describe('the error records Loki is asked for', () => {
  it('carry only the fields their readers use, narrowed first by any filter', () => {
    const query = errorLogs(objectives, ' | route="/about"');
    expect(query).toMatch(/\| route="\/about" \| keep route, path, [a-z_, ]+$/);
    expect(errorLogs(objectives)).toMatch(/\| severity_text=~"\(\?i\)error\|fatal" \| keep /);
  });

  it('are read the same with only those fields as with all of them', async () => {
    const whole = record(everything);
    const cut = record(kept(everything));
    expect(Object.keys(cut.fields).length).toBeLessThan(Object.keys(whole.fields).length);

    expect(errorRecords([cut])[0]?.pattern).toBe(errorRecords([whole])[0]?.pattern);
    expect(keptLine(cut)).toEqual(keptLine(whole));
    const line = 'GET /departments/garden failed: TypeError: no "slug" on 7';
    expect(sameError(cut, keptLine(cut).message, line, everything.route ?? '')).toBe(true);

    const tempo = { spans: async () => undefined } as unknown as Tempo;
    const signal = async (r: LogRecord) => signalForPattern({ pattern: 'p', records: [r], count: 1 }, tempo);
    expect(await signal(cut)).toEqual(await signal(whole));

    // A record with no exception is told by its line, its path put back to its route, and its level by its severity.
    const { exception_type, exception_message, exception_stacktrace, detected_level, ...plain } = everything;
    const bare = record({ ...plain, severity_text: 'warn' });
    const bareCut = record(kept(bare.fields));
    expect(errorRecords([bareCut])[0]?.pattern).toBe('/departments/:department GET /departments/:department failed');
    expect(keptLine(bareCut)).toEqual(keptLine(bare));
    expect(keptLine(bareCut).level).toBe('warn');
    expect(await signal(bareCut)).toEqual(await signal(bare));
  });

  it('keeps a line cut where it was with no emoji, and never cuts inside one', () => {
    const long = (line: string): LogRecord => ({ ...record({}), line });
    const plain = `GET /departments/kitchen failed: ${'x'.repeat(400)}`;
    expect(keptLine(long(plain)).message).toBe(plain.slice(0, 300));
    const emoji = `${'x'.repeat(299)}😀 failed`;
    expect(keptLine(long(emoji)).message).toBe('x'.repeat(299));
    expect(sameError(long(emoji), keptLine(long(emoji)).message, keptLine(long(emoji)).message, '*')).toBe(true);
  });
});

describe('learning the day’s patterns when the watcher starts', () => {
  const at = new Date('2026-10-17T09:00:00Z');
  /**
   * A day as Loki pages it: `full` pages of 5,000 records of one error, a millisecond apart from where each is asked
   * to start, then a short page of another error, three hours before the watcher starts.
   */
  const day = (full: number) => {
    let asked = 0;
    return (url: URL) => {
      const last = asked++ >= full;
      const start = Number(BigInt(url.searchParams.get('start') ?? '0') / 1_000_000n);
      const base = last ? Date.parse('2026-10-17T06:00:00Z') : start + 1;
      return streams(
        ...Array.from({ length: last ? 3 : 5000 }, (_, i): [string, string, Record<string, string>] => [
          String(BigInt(base + i) * 1_000_000n),
          last ? 'GET /about failed' : 'GET /departments/kitchen failed',
          { route: last ? '/about' : '/departments/:department', service_version: 'v1.4.2' },
        ]),
      );
    };
  };

  it('reads Loki a page at a time', async () => {
    const loki = new Loki('http://loki', fakeFetch([{ path: '/loki/api/v1/query_range', answer: day(1) }]));
    const sizes: number[] = [];
    for await (const page of loki.pages('{}', new Date(at.getTime() - 86_400_000), at)) sizes.push(page.length);
    expect(sizes).toEqual([5000, 3]);
    const again = new Loki('http://loki', fakeFetch([{ path: '/loki/api/v1/query_range', answer: day(1) }]));
    expect(await again.records('{}', new Date(at.getTime() - 86_400_000), at)).toHaveLength(5003);
  });

  it('learns every page’s patterns, however many, so that none of them is new afterwards', async () => {
    const seen: URL[] = [];
    const loki = new Loki('http://loki', fakeFetch([{ path: '/loki/api/v1/query_range', answer: day(5) }], seen));
    const sent: unknown[] = [];
    const outbox = { send: async (signal: unknown) => void sent.push(signal) } as never;
    const tempo = { spans: async () => undefined } as unknown as Tempo;
    const watcher = new Watcher(
      { objectives, loki, tempo, outbox, log: pino({ level: 'silent' }) } as never,
      { errors: at, reports: at },
      { settleMs: 0, agreementWindowMs: 300_000, agreementLagMs: 0, reportLateMs: 0 },
    );
    // More than the 20,000 records a read stops at otherwise: the last hours before the start are learned too.
    expect(await watcher.learnPatterns()).toBe(25_003);
    expect(seen).toHaveLength(6);

    await watcher.checkErrors(new Date(at.getTime() + 60_000));
    expect(sent).toEqual([]);
  });
});

/** A Loki that holds these records and answers a range as it does: from `start` on, before `end`, `limit` at most. */
function lokiOf(held: [bigint, string, Record<string, string>][], seen: URL[] = []) {
  return new Loki('http://loki', heldBy(held, seen));
}

/** The `fetch` of a Loki that holds these records, as `lokiOf` says. */
function heldBy(held: [bigint, string, Record<string, string>][], seen: URL[] = []) {
  return fakeFetch(
    [
      {
        path: '/loki/api/v1/query_range',
        answer: (url) => {
          const start = BigInt(url.searchParams.get('start') ?? '0');
          const end = BigInt(url.searchParams.get('end') ?? '0');
          const limit = Number(url.searchParams.get('limit'));
          const range = held.filter(([ns]) => ns >= start && ns < end).slice(0, limit);
          return streams(
            ...range.map(([ns, line, fields]): [string, string, Record<string, string>] => [String(ns), line, fields]),
          );
        },
      },
    ],
    seen,
  );
}

describe('reading Loki a page at a time, where records share a nanosecond', () => {
  const from = new Date('2026-10-17T08:00:00Z');
  const to = new Date('2026-10-17T09:00:00Z');
  const at = (ms: number) => BigInt(from.getTime() + ms) * 1_000_000n;

  it('gives every record of a nanosecond a page ends among, once', async () => {
    // 4,998 records, then four at one nanosecond: the first page ends among them.
    const held: [bigint, string, Record<string, string>][] = [
      ...Array.from({ length: 4998 }, (_, i): [bigint, string, Record<string, string>] => [at(i), 'a', {}]),
      ...['b', 'c', 'd', 'e'].map((line): [bigint, string, Record<string, string>] => [at(5000), line, { n: line }]),
      [at(6000), 'f', {}],
    ];
    const records = await lokiOf(held).records('{}', from, to, Number.POSITIVE_INFINITY);
    expect(records).toHaveLength(held.length);
    expect(records.slice(-5).map((r) => r.line)).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('moves past a nanosecond with more records than a page holds, and does not go round', async () => {
    const held: [bigint, string, Record<string, string>][] = [
      ...Array.from({ length: 5500 }, (_, i): [bigint, string, Record<string, string>] => [at(10), `x${i}`, {}]),
      [at(20), 'after', {}],
    ];
    const seen: URL[] = [];
    const records = await lokiOf(held, seen).records('{}', from, to, Number.POSITIVE_INFINITY);
    // Loki cannot page within a nanosecond: the page it holds is read, and the reading goes on after it.
    expect(records).toHaveLength(5001);
    expect(records.at(-1)?.line).toBe('after');
    expect(seen.length).toBeLessThanOrEqual(3);
  });
});

describe('checking a window of errors bigger than a read used to hold', () => {
  const from = new Date('2026-10-17T08:00:00Z');
  const at = (ms: number) => BigInt(from.getTime() + ms) * 1_000_000n;
  const fields = (route: string) => ({ route, service_version: 'v1.4.2' });
  /** 24,000 records of an error the watcher has not seen, over five pages, and one of another after them all. */
  const held: [bigint, string, Record<string, string>][] = [
    ...Array.from({ length: 24_000 }, (_, i): [bigint, string, Record<string, string>] => [
      at(i),
      `GET /search failed after ${i} ms`,
      fields('/search'),
    ]),
    [at(30_000), 'GET /about failed', fields('/about')],
  ];

  const watcher = (loki: Loki, outbox: { send: (signal: InboxSignal) => Promise<void> }) =>
    new Watcher(
      {
        objectives,
        loki,
        tempo: { spans: async () => undefined } as unknown as Tempo,
        outbox,
        log: pino({ level: 'silent' }),
      } as never,
      { errors: from, reports: from },
      { settleMs: 0, agreementWindowMs: 300_000, agreementLagMs: 0, reportLateMs: 0 },
    );

  it('reads every record, and a pattern over many pages is one signal with them all counted', async () => {
    const sent: InboxSignal[] = [];
    const check = watcher(lokiOf(held), { send: async (signal) => void sent.push(signal) });
    expect(await check.checkErrors(new Date(from.getTime() + 60_000))).toBe(2);
    expect(sent.map((signal) => signal.route)).toEqual(['/search', '/about']);
    const evidence = sent[0]?.evidence?.[0];
    expect(evidence).toMatchObject({ kind: 'logs', requests: 24_000 });
    // The lines are the last twenty, as when the window was read at once.
    const lines = evidence?.kind === 'logs' ? evidence.lines.map((line) => line.message) : [];
    expect(lines).toHaveLength(20);
    expect(lines.at(-1)).toBe('GET /search failed after 23999 ms');
  });

  it('leaves the patterns new when a signal could not be sent, so the window is read again', async () => {
    let fail = true;
    const sent: InboxSignal[] = [];
    const check = watcher(lokiOf(held), {
      send: async (signal) => {
        if (fail) throw new Error('the inbox is away');
        sent.push(signal);
      },
    });
    const now = new Date(from.getTime() + 60_000);
    await expect(check.checkErrors(now)).rejects.toThrow('the inbox is away');
    fail = false;
    expect(await check.checkErrors(now)).toBe(2);
    expect(sent).toHaveLength(2);
  });
});

describe('checking errors after a check that could not reach Loki', () => {
  const from = new Date('2026-10-17T08:00:00Z');
  const minute = (m: number) => new Date(from.getTime() + m * 60_000);
  const fields = { route: '/search', service_version: 'v1.4.2' };

  it('reads again from where it failed, so a record the collector delivers late is not missed', async () => {
    const held: [bigint, string, Record<string, string>][] = [];
    const seen: URL[] = [];
    const up = heldBy(held, seen);
    let away = true;
    const loki = new Loki('http://loki', async (input, init) => {
      if (!away) return up(input, init);
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    });
    const sent: InboxSignal[] = [];
    const check = new Watcher(
      {
        objectives,
        loki,
        tempo: { spans: async () => undefined } as unknown as Tempo,
        outbox: { send: async (signal: InboxSignal) => void sent.push(signal) },
        log: pino({ level: 'silent' }),
      } as never,
      { errors: from, reports: from },
      { settleMs: 60_000, agreementWindowMs: 300_000, agreementLagMs: 0, reportLateMs: 10 * 60_000 },
    );
    const startOf = () => new Date(Number(BigInt(seen.at(-1)?.searchParams.get('start') ?? '0') / 1_000_000n));

    // Loki restarts: the check at 08:02 cannot reach it.
    await expect(check.checkErrors(minute(2))).rejects.toThrow('fetch failed');
    // Back at 08:03, before the collector's retry has delivered what the app wrote while it was away.
    away = false;
    expect(await check.checkErrors(minute(3))).toBe(0);
    held.push([BigInt(minute(1.5).getTime()) * 1_000_000n, 'GET /search failed', fields]);
    // The next check reads from 08:00 again, not from 08:02, and finds it.
    expect(await check.checkErrors(minute(4))).toBe(1);
    expect(startOf()).toEqual(from);
    expect(sent.map((signal) => signal.route)).toEqual(['/search']);
    // Read again, it is no new pattern.
    expect(await check.checkErrors(minute(5))).toBe(0);
    // Once it has read to ten minutes after the failure, the check reads from where the last one ended.
    expect(await check.checkErrors(minute(13))).toBe(0);
    expect(await check.checkErrors(minute(14))).toBe(0);
    expect(startOf()).toEqual(minute(12));
  });
});
