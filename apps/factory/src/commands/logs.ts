/**
 * `factory logs`: the log watcher. It reads the app's records from Loki and leaves signals in the inbox.
 *
 *     node --import ./src/telemetry.ts src/cli.ts logs
 *     factory logs --dry-run [--since 24h]
 *
 * Runs until stopped: reports every few seconds (a visitor is waiting for an answer), error patterns and agreement
 * every minute. With `--dry-run` it makes one pass over the time since `--since` (default a day), prints what it
 * would send, and stops; a report's text is shown as its length. Otherwise it connects with DATABASE_URL, or the
 * PG* variables, as its own role (`factory_logs`). Prometheus, Loki and Tempo are found as `clients/env.ts` says.
 */
import { parseArgs } from 'node:util';
import { connect } from '@software-factory/store';
import type { Logger } from 'pino';
import { objectives } from '../../../../policy/objectives.ts';
import { telemetryFrom } from '../clients/env.ts';
import { TELEMETRY_AWAY_MS, telemetryAway } from '../clients/http.ts';
import { log } from '../log.ts';
import { reportsFrom as readReportsFrom } from '../logs/cursor.ts';
import { TIMING, Watcher } from '../logs/watcher.ts';
import { inbox, printing } from '../outbox.ts';
import { PassLog } from '../store-absence.ts';

export const USAGE = '  factory logs [--dry-run] [--since <duration, such as 90m or 24h>]';

const REPORT_EVERY_MS = 10_000;
const CHECK_EVERY_MS = 60_000;

/** "90m" or "24h" as milliseconds. */
export function duration(text: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(text);
  if (!match) throw new Error(`"${text}" is not a duration such as 90m or 24h`);
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
}

/**
 * Says how each turn of one check ended. Every check reads Loki, and agreement Prometheus and Tempo too, and patching
 * one restarts it: a turn that could not reach it, while it has been away under two minutes, is a warning, and its
 * next turn tries again. Once it has been away for longer, and for any other failure, the turn failed, as an error.
 */
export function checkTurns(log: Logger, now: () => Date, check: string): PassLog {
  return new PassLog(
    log.child({ check }),
    now,
    {
      away: 'a check could not reach the telemetry it reads, as for a restart: its next turn tries again',
      stillAway: 'check failed: the telemetry it reads has been away for over two minutes',
      failed: 'check failed',
      back: (seconds) => `the check reached the telemetry it reads again, after ${seconds} s`,
    },
    { away: telemetryAway, awayMs: TELEMETRY_AWAY_MS },
  );
}

export async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { 'dry-run': { type: 'boolean', default: false }, since: { type: 'string', default: '24h' } },
  });
  const { DATABASE_URL } = process.env;
  const dryRun = values['dry-run'];
  const sql = dryRun ? undefined : connect(DATABASE_URL);
  const outbox = sql ? inbox(sql, 'logs', 'report') : printing((line) => console.log(line));
  const now = () => new Date();
  const backends = { objectives, ...telemetryFrom(), outbox, log };

  if (dryRun) {
    const since = new Date(Date.now() - duration(values.since));
    const watcher = new Watcher(backends, { errors: since, reports: since });
    await watcher.learnPatterns();
    const errors = await watcher.checkErrors(now());
    const reports = await watcher.checkReports(now());
    // Agreement needs a finding twice in a row: the window before the latest, then the latest.
    await watcher.checkAgreement(new Date(Date.now() - TIMING.agreementWindowMs));
    const agreement = await watcher.checkAgreement(now());
    console.error(`Would send ${errors} error patterns, ${reports} reports and ${agreement} disagreements.`);
    return 0;
  }

  // A margin before the last report the inbox holds, and a day back on a fresh store; errors from a couple of minutes ago.
  const reportsFrom = sql
    ? await readReportsFrom(sql, new Date(), duration('24h'), TIMING.reportLateMs)
    : new Date(Date.now() - duration('24h'));
  const watcher = new Watcher(backends, { errors: new Date(Date.now() - 2 * 60_000), reports: reportsFrom });
  const learned = await watcher.learnPatterns();
  log.info({ learned, reportsFrom: reportsFrom.toISOString() }, 'log watcher started');

  // A check that fails is tried again at its next turn; one running still is not started twice.
  const every = (ms: number, name: string, check: () => Promise<number>) => {
    let running = false;
    const turns = checkTurns(log, now, name);
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await check();
        turns.passed();
      } catch (error) {
        turns.failed(error);
      } finally {
        running = false;
      }
    };
    void tick();
    return setInterval(tick, ms);
  };
  const timers = [
    every(REPORT_EVERY_MS, 'reports', () => watcher.checkReports(now())),
    every(CHECK_EVERY_MS, 'errors', () => watcher.checkErrors(now())),
    every(CHECK_EVERY_MS, 'agreement', () => watcher.checkAgreement(now())),
  ];

  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        log.info({ signal }, 'log watcher stopping');
        resolve();
      });
    }
  });
  for (const timer of timers) clearInterval(timer);
  await sql?.end();
  return 0;
}
