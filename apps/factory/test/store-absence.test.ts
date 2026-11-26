import { createServer, type Socket } from 'node:net';
import { listenLocal } from '@software-factory/testing';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { BackendAnswered, getJson, TELEMETRY_AWAY_MS, telemetryAway } from '../src/clients/http.ts';
import { checkTurns } from '../src/commands/logs.ts';
import { PassLog, STORE, STORE_AWAY_MS } from '../src/store-absence.ts';

/** A pass log on a clock the test moves, and the level and message of each line it logs. */
function passLog() {
  let at = 0;
  const lines: string[] = [];
  const say = (level: string) => (_: unknown, message: string) => lines.push(`${level}: ${message}`);
  const log = { info: say('info'), warn: say('warn'), error: say('error') } as unknown as Logger;
  const passes = new PassLog(log, () => new Date(at), {
    away: 'a pass could not reach the store',
    stillAway: 'a pass failed: the store is still away',
    failed: 'a pass failed',
    back: (seconds) => `the store is back, after ${seconds} s`,
  });
  return { passes, lines, after: (ms: number) => (at += ms) };
}

const refused = Object.assign(new Error('connect ECONNREFUSED 10.43.0.7:5432'), { code: 'ECONNREFUSED' });
const restarting = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });

describe('a pass at the store', () => {
  it('warns while the store is away for a restart, and says when it is back', () => {
    const { passes, lines, after } = passLog();
    passes.passed();
    passes.failed(restarting);
    after(15_000);
    passes.failed(refused);
    after(15_000);
    passes.passed();
    passes.passed();
    expect(lines).toEqual([
      'warn: a pass could not reach the store',
      'warn: a pass could not reach the store',
      'info: the store is back, after 30 s',
    ]);
  });

  it('fails loudly once the store has been away for a minute, and at every pass after', () => {
    const { passes, lines, after } = passLog();
    passes.failed(refused);
    after(STORE_AWAY_MS - 1);
    passes.failed(refused);
    after(1);
    passes.failed(refused);
    after(15_000);
    passes.failed(refused);
    expect(lines.map((line) => line.split(':')[0])).toEqual(['warn', 'warn', 'error', 'error']);
  });

  it('times a later absence from its own start', () => {
    const { passes, lines, after } = passLog();
    passes.failed(refused);
    after(50_000);
    passes.passed();
    after(50_000);
    passes.failed(refused);
    expect(lines.at(-1)?.startsWith('warn:')).toBe(true);
  });

  it('fails loudly at once for anything else', () => {
    const { passes, lines } = passLog();
    passes.failed(Object.assign(new Error('relation "events" does not exist'), { code: '42P01' }));
    passes.failed(new TypeError('cannot read properties of undefined'));
    expect(lines).toEqual(['error: a pass failed', 'error: a pass failed']);
  });
});

describe('a pass at several dependencies', () => {
  const telemetry = { away: (error: unknown) => error === 'loki', awayMs: 120_000 };
  const store = {
    ...STORE,
    words: {
      away: 'a pass could not reach the store',
      stillAway: 'a pass failed: the store is still away',
      back: (seconds: number) => `the store is back, after ${seconds} s`,
    },
  };
  function passLog() {
    let at = 0;
    const lines: string[] = [];
    const say = (level: string) => (_: unknown, message: string) => lines.push(`${level}: ${message}`);
    const log = { info: say('info'), warn: say('warn'), error: say('error') } as unknown as Logger;
    const words = {
      away: 'a pass could not reach Loki',
      stillAway: 'a pass failed: Loki is still away',
      failed: 'a pass failed',
      back: (seconds: number) => `Loki is back, after ${seconds} s`,
    };
    const passes = new PassLog(log, () => new Date(at), words, [telemetry, store]);
    return { passes, lines, after: (ms: number) => (at += ms) };
  }

  it('says which one is away in its own words, and for its own time', () => {
    const { passes, lines, after } = passLog();
    passes.failed(restarting);
    after(STORE_AWAY_MS);
    passes.failed('loki');
    passes.failed(refused);
    after(telemetry.awayMs - 1);
    passes.failed('loki');
    after(1);
    passes.failed('loki');
    expect(lines).toEqual([
      'warn: a pass could not reach the store',
      'warn: a pass could not reach Loki',
      'error: a pass failed: the store is still away',
      'warn: a pass could not reach Loki',
      'error: a pass failed: Loki is still away',
    ]);
  });

  it('says each one is back at the pass that fails nowhere, and fails loudly for anything else', () => {
    const { passes, lines, after } = passLog();
    passes.failed('loki');
    after(20_000);
    passes.failed(refused);
    after(10_000);
    passes.passed();
    passes.passed();
    passes.failed(new TypeError('cannot read properties of undefined'));
    expect(lines).toEqual([
      'warn: a pass could not reach Loki',
      'warn: a pass could not reach the store',
      'info: Loki is back, after 30 s',
      'info: the store is back, after 10 s',
      'error: a pass failed',
    ]);
  });
});

/** What a real read of a backend fails with, at an address that answers as `serve` does, or at none. */
async function failureOf(serve?: (socket: Socket) => void, timeoutMs = 10_000): Promise<unknown> {
  const server = createServer(serve ?? (() => {}));
  const { url } = await listenLocal(server);
  if (!serve) await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await getJson(fetch, url, '/loki/api/v1/query_range', {}, timeoutMs);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    if (serve) server.close();
  }
}

const answering = (status: number) => (socket: Socket) =>
  socket.end(`HTTP/1.1 ${status} Whatever\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);

describe('a read of telemetry that a restart fails', () => {
  it('is one while the backend is down, cut off, slow to answer, or answering 5xx', async () => {
    expect(telemetryAway(await failureOf())).toBe(true);
    expect(telemetryAway(await failureOf((socket) => socket.destroy()))).toBe(true);
    expect(telemetryAway(await failureOf(() => {}, 200))).toBe(true);
    expect(telemetryAway(await failureOf(answering(502)))).toBe(true);
    expect(telemetryAway(await failureOf(answering(503)))).toBe(true);
    expect(
      telemetryAway(await failureOf((socket) => socket.end('HTTP/1.1 200 OK\r\ncontent-length: 99\r\n\r\n{"a"'))),
    ).toBe(true);
  });

  it('is not one for a refusal, an answer of the wrong shape, or anything else', async () => {
    const refused = await failureOf(answering(400));
    expect(refused).toBeInstanceOf(BackendAnswered);
    expect(telemetryAway(refused)).toBe(false);
    expect(telemetryAway(await failureOf(answering(403)))).toBe(false);
    expect(telemetryAway(new Error('A backend answered an instant query with something else'))).toBe(false);
    expect(telemetryAway(new TypeError('cannot read properties of undefined'))).toBe(false);
    expect(telemetryAway(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(false);
  });
});

describe('a turn of a log watcher’s check', () => {
  function turns() {
    let at = 0;
    const lines: { level: string; check: unknown; message: string }[] = [];
    const say = (level: string, check: unknown) => (_: unknown, message: string) =>
      lines.push({ level, check, message });
    const logger = (bindings: Record<string, unknown>) => ({
      info: say('info', bindings.check),
      warn: say('warn', bindings.check),
      error: say('error', bindings.check),
    });
    const log = { child: (bindings: Record<string, unknown>) => logger(bindings) } as unknown as Logger;
    return { turns: checkTurns(log, () => new Date(at), 'reports'), lines, after: (ms: number) => (at += ms) };
  }
  const timedOut = new DOMException('The operation was aborted due to timeout', 'TimeoutError');

  it('warns while Loki restarts, says when it is back, and fails loudly once it has been away two minutes', () => {
    const { turns: reports, lines, after } = turns();
    reports.failed(timedOut);
    after(10_000);
    reports.failed(new BackendAnswered('query:3100/loki/api/v1/query_range answered 502', 502));
    after(10_000);
    reports.passed();
    reports.failed(timedOut);
    after(TELEMETRY_AWAY_MS);
    reports.failed(timedOut);
    reports.failed(new Error('A report could not be left in the inbox'));
    expect(lines).toEqual([
      expect.objectContaining({ level: 'warn', check: 'reports' }),
      expect.objectContaining({ level: 'warn', check: 'reports' }),
      { level: 'info', check: 'reports', message: 'the check reached the telemetry it reads again, after 20 s' },
      expect.objectContaining({ level: 'warn' }),
      expect.objectContaining({
        level: 'error',
        message: 'check failed: the telemetry it reads has been away for over two minutes',
      }),
      { level: 'error', check: 'reports', message: 'check failed' },
    ]);
  });

  it('warns while the store restarts, says when it is back, and fails loudly once it has been away a minute', () => {
    const { turns: reports, lines, after } = turns();
    const unsent = Object.assign(new Error('A report could not be left in the inbox'), { code: 'CONNECTION_CLOSED' });
    reports.failed(unsent);
    after(10_000);
    reports.failed(restarting);
    after(10_000);
    reports.passed();
    reports.failed(refused);
    after(STORE_AWAY_MS);
    reports.failed(refused);
    reports.failed(Object.assign(new Error('permission denied for table inbox'), { code: '42501' }));
    expect(lines).toEqual([
      {
        level: 'warn',
        check: 'reports',
        message: 'a check could not reach the store, as for a restart: its next turn tries again',
      },
      expect.objectContaining({ level: 'warn', check: 'reports' }),
      { level: 'info', check: 'reports', message: 'the check reached the store again, after 20 s' },
      expect.objectContaining({ level: 'warn' }),
      { level: 'error', check: 'reports', message: 'check failed: the store has been away for over a minute' },
      { level: 'error', check: 'reports', message: 'check failed' },
    ]);
  });
});
