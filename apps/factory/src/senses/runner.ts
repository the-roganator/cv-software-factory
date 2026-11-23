/**
 * Runs a sense on a schedule, and again at once when the app's version changes, and turns what it finds into
 * signals. The rules are the milestone's decisions:
 *
 * - A check that passes writes nothing, and ends its streak.
 * - A check that fails becomes a signal only when it has failed twice in a row, so one blip opens nothing. After
 *   that each failing run sends another, which triage counts without making an event of it.
 * - Never two runs at once, and a run that the app changed under is thrown away and repeated.
 * - A signal the inbox could not take because the store is away, as it is for the seconds a patch restarts Postgres,
 *   is kept and handed over again at each poll until the store has it. Any other signal the inbox refuses is dropped.
 *
 * The clock and the polling are the caller's: `tick()` does one poll of the version, and `start()` calls it on a
 * timer. Tests call `tick()` themselves.
 */
import { cutTo, type InboxSignal } from '@software-factory/events';
import { storeAway } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Look } from '../pictures/index.ts';
import { PassLog } from '../store-absence.ts';
import type { Finding, Observation, Sense } from './types.ts';

export interface RunnerOptions {
  sense: Sense;
  /** The app's version as its `/version` says now. Rejects when the app does not answer. */
  version(): Promise<string>;
  /** Leaves a signal in the inbox. Sent again with the same id, a signal is left as it was the first time. */
  send(signal: InboxSignal, id: string): Promise<void>;
  /** Remembers where a signal's finding boxed the elements it found, for the release's pictures (`pictures/`). */
  remember?(look: Look, at: Date): Promise<void>;
  log: Logger;
  /** Milliseconds between scheduled runs. Five minutes by default. */
  every?: number;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

/** Why a run began. */
export type Reason = 'first run' | 'new version' | 'schedule';

export interface Run {
  reason: Reason;
  version: string;
  checks: number;
  failed: number;
  signalled: number;
}

export const FAILURES_BEFORE_A_SIGNAL = 2;

/** A failed check's observation as the signal the runner leaves in the inbox for it. */
export function signalOf(
  sense: Sense['name'],
  { check, route, finding, artifacts }: Observation & { finding: Finding },
  version: string,
  at: Date,
): InboxSignal {
  const evidence = finding.evidence?.slice(0, 8);
  return {
    sense,
    check,
    route,
    version,
    symptom: finding.symptom,
    ...(evidence?.length && { evidence }),
    observedAt: at.toISOString(),
    summary: cutTo(finding.message.trim(), 200),
    artifacts,
  };
}

export class SenseRunner {
  private readonly options: RunnerOptions;
  private readonly now: () => number;
  /** For each check, what it last failed with and how many runs in a row. A check that passed has none. */
  private readonly streaks = new Map<string, { fingerprint: string; runs: number }>();
  /** The version the last complete run saw, and when the last run, complete or not, began. */
  private probedVersion: string | undefined;
  private lastRunAt: number | undefined;
  /** When each limited check last ran. */
  private readonly ranAt = new Map<string, number>();
  private busy = false;
  /**
   * The signals the inbox could not take while the store is away, the newest of each check under the id it was sent
   * with, so the store keeps one of it however the first send ended. Empty unless the store is away.
   */
  private readonly kept = new Map<string, { signal: InboxSignal; id: string }>();
  /** Says how each hand-over to the inbox ended: a short absence of the store as a warning, anything else as an error. */
  private readonly handovers: PassLog;

  constructor(options: RunnerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.handovers = new PassLog(options.log.child({ sense: options.sense.name }), () => new Date(this.now()), {
      away: 'the inbox did not take a signal, as the store is away: it is kept, and sent again when the store is back',
      stillAway: 'the inbox did not take a signal: the store has been away for over a minute',
      failed: 'the inbox did not take a signal',
      back: (seconds) => `the store is back after ${seconds} s: the inbox took the signals kept for it`,
    });
  }

  /**
   * Hands the kept signals over, then looks at the version, and runs the sense if it is new or the schedule says it is
   * time. Null if it did not.
   */
  async tick(): Promise<Run | null> {
    if (this.busy) return null;
    await this.handOver();
    let version: string;
    try {
      version = await this.options.version();
    } catch (error) {
      this.options.log.warn({ err: describe(error) }, 'the app did not report its version');
      return null;
    }
    if (this.lastRunAt === undefined) return this.run(version, 'first run');
    if (this.probedVersion !== version) return this.run(version, 'new version');
    const due = this.now() - this.lastRunAt >= (this.options.every ?? 5 * 60_000);
    return due ? this.run(version, 'schedule') : null;
  }

  /** Runs the sense once, unless a run is going. */
  async run(version: string, reason: Reason): Promise<Run | null> {
    if (this.busy) return null;
    this.busy = true;
    const { sense, log } = this.options;
    const started = this.now();
    this.lastRunAt = started;
    try {
      const observations = await sense.pass(version, this.skipped(reason, started));
      for (const { check } of observations) this.ranAt.set(check.split('/')[0] ?? check, started);
      const after = await this.options.version().catch(() => version);
      if (after !== version) {
        // The app changed while the sense looked, so the results mix two versions. The next tick runs again.
        log.warn({ sense: sense.name, version, after }, 'the app changed during the run; its results are dropped');
        return null;
      }
      const run: Run = { reason, version, checks: observations.length, failed: 0, signalled: 0 };
      // The checks that could not tell, by route and why: one missing page leaves every check on its route not knowing,
      // and a warning for each would say the same thing many times a run.
      const untold = new Map<string, { route: string; trouble: string; checks: string[] }>();
      for (const observation of observations) {
        const { check, finding, route } = observation;
        if (observation.trouble) {
          const key = `${route}\n${observation.trouble}`;
          const same = untold.get(key) ?? { route, trouble: observation.trouble, checks: [] };
          same.checks.push(check);
          untold.set(key, same);
          continue;
        }
        if (!finding) {
          this.streaks.delete(check);
          continue;
        }
        run.failed++;
        const fingerprint = `${route} ${finding.symptom}`;
        const before = this.streaks.get(check);
        const runs = before?.fingerprint === fingerprint ? before.runs + 1 : 1;
        this.streaks.set(check, { fingerprint, runs });
        const signalled = runs >= FAILURES_BEFORE_A_SIGNAL;
        log.info(
          { sense: sense.name, check, route, symptom: finding.symptom, runs, signalled },
          `a check failed: ${finding.message}`,
        );
        if (!signalled) continue;
        const signal = signalOf(sense.name, { ...observation, finding }, version, new Date(this.now()));
        if (await this.send(signal, crypto.randomUUID())) run.signalled++;
        if (observation.look && this.options.remember) {
          const look = { sense: sense.name, check, route, ...observation.look };
          await this.options.remember(look, new Date(this.now())).catch((error) => {
            log.warn({ sense: sense.name, check, err: describe(error) }, 'where the finding was is not remembered');
          });
        }
      }
      for (const { route, trouble, checks } of untold.values()) {
        log.warn({ sense: sense.name, route, checks, trouble }, 'checks could not tell');
      }
      this.probedVersion = version;
      log.info(
        {
          sense: sense.name,
          reason,
          version,
          checks: run.checks,
          failed: run.failed,
          signalled: run.signalled,
          ms: this.now() - started,
        },
        'a run finished',
      );
      return run;
    } catch (error) {
      log.error({ sense: sense.name, err: describe(error) }, 'a run failed');
      return null;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Leaves a signal in the inbox, and says whether the inbox took it. While the store is away the signal is kept for
   * the next poll instead, without another try at a store that has just refused one, so an absence is one line a poll.
   */
  private async send(signal: InboxSignal, id: string): Promise<boolean> {
    if (this.kept.size === 0) {
      try {
        await this.options.send(signal, id);
        return true;
      } catch (error) {
        this.handovers.failed(error, { check: signal.check });
        if (!storeAway(error)) return false;
      }
    }
    this.kept.set(signal.check, { signal, id });
    return false;
  }

  /** Hands over the signals kept while the store was away, and stops at the first the store is still away for. */
  private async handOver(): Promise<void> {
    for (const [check, { signal, id }] of this.kept) {
      try {
        await this.options.send(signal, id);
      } catch (error) {
        this.handovers.failed(error, { check });
        // Kept only while the store is away: a signal the inbox refuses for another reason is dropped, as in a run.
        if (storeAway(error)) return;
      }
      this.kept.delete(check);
    }
    this.handovers.passed();
  }

  /** The checks that ran too lately to run again, unless the app is new. */
  private skipped(reason: Reason, now: number): Set<string> {
    const skip = new Set<string>();
    if (reason === 'new version') return skip;
    for (const [check, every] of Object.entries(this.options.sense.intervals ?? {})) {
      const last = this.ranAt.get(check);
      if (last !== undefined && now - last < every) skip.add(check);
    }
    return skip;
  }

  /** Polls the version every `pollMs` until the returned function is called. The first poll is at once. */
  start(pollMs = 15_000): () => Promise<void> {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let current: Promise<unknown> = Promise.resolve();
    const poll = () => {
      current = this.tick().finally(() => {
        if (!stopped) timer = setTimeout(poll, pollMs);
      });
    };
    poll();
    return async () => {
      stopped = true;
      clearTimeout(timer);
      await current;
    };
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
