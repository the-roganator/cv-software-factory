/**
 * Runs a sense on a schedule, and again at once when the app's version changes, and turns what it finds into
 * signals. The rules are the milestone's decisions:
 *
 * - A check that passes writes nothing, and ends its streak.
 * - A check that fails becomes a signal only when it has failed twice in a row, so one blip opens nothing. After
 *   that each failing run sends another, which triage counts without making an event of it.
 * - Never two runs at once, and a run that the app changed under is thrown away and repeated.
 *
 * The clock and the polling are the caller's: `tick()` does one poll of the version, and `start()` calls it on a
 * timer. Tests call `tick()` themselves.
 */
import { cutTo, type InboxSignal } from '@software-factory/events';
import type { Logger } from 'pino';
import type { Look } from '../pictures/index.ts';
import type { Finding, Observation, Sense } from './types.ts';

export interface RunnerOptions {
  sense: Sense;
  /** The app's version as its `/version` says now. Rejects when the app does not answer. */
  version(): Promise<string>;
  /** Leaves a signal in the inbox. */
  send(signal: InboxSignal): Promise<void>;
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

  constructor(options: RunnerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Looks at the version, and runs the sense if it is new or the schedule says it is time. Null if it did not. */
  async tick(): Promise<Run | null> {
    if (this.busy) return null;
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
        try {
          await this.options.send(signalOf(sense.name, { ...observation, finding }, version, new Date(this.now())));
          run.signalled++;
        } catch (error) {
          log.error({ sense: sense.name, check, err: describe(error) }, 'the inbox did not take a signal');
        }
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
