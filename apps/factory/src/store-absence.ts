import { storeAway } from '@software-factory/store';
import type { Logger } from 'pino';

/**
 * How long the store may be away before a pass that cannot reach it is a fault: a minute. Patching Postgres restarts
 * its StatefulSet, and the store is back within seconds; a minute is several times that, and four passes at a worker's
 * fifteen seconds. A store away for longer is a fault, logged as an error at every pass, as any other failure is.
 */
export const STORE_AWAY_MS = 60_000;

/** What a worker's passes at one dependency are called in its log, while it is away and once it is back. */
export interface AwayWords {
  /** A pass that could not reach it, while it has been away less than its time: a warning. */
  away: string;
  /** A pass that could not reach it once it has been away for longer: an error. */
  stillAway: string;
  /** The pass that reached it again, after so many seconds: an info line. */
  back(seconds: number): string;
}

/** What a worker's passes are called in its log. */
export interface PassWords extends AwayWords {
  /** A pass that failed in any other way: an error. */
  failed: string;
}

/** What a worker's passes depend on, when it is not the store alone: how its absence fails a pass, and for how long. */
export interface Dependency {
  /** Whether a pass failed with this error because the dependency is away for now, rather than for a fault. */
  away(error: unknown): boolean;
  /** How long it may be away before a pass that cannot reach it is a fault. */
  awayMs: number;
  /** What a pass is called while this one is away, where the worker's words are of another. */
  words?: AwayWords;
}

/** The store: away while `storeAway` says so, for up to `STORE_AWAY_MS`. */
export const STORE: Dependency = { away: storeAway, awayMs: STORE_AWAY_MS };

/**
 * Says how each pass of a worker at what it depends on ended, the store unless it is told otherwise: a pass that could
 * not reach a dependency, while that one has been away less than its time, as a warning, and the pass that reaches
 * everything again with how long each was away; any other failure, and every one once the dependency has been away
 * for longer, as an error. Of several dependencies, a failure is the first's whose `away` knows it, and each one's
 * absence is timed from the first pass it failed. The worker must go on making passes while one is away, as only a
 * pass that fails nowhere ends an absence.
 */
export class PassLog {
  /** When the first pass of each dependency's absence failed, while it lasts. */
  readonly #awaySince = new Map<Dependency, number>();
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #words: PassWords;
  readonly #on: readonly Dependency[];

  constructor(log: Logger, now: () => Date, words: PassWords, on: Dependency | readonly Dependency[] = STORE) {
    this.#log = log;
    this.#now = now;
    this.#words = words;
    this.#on = [on].flat();
  }

  passed(): void {
    const now = this.#now().getTime();
    for (const [dependency, since] of this.#awaySince) {
      const seconds = Math.round((now - since) / 1000);
      this.#log.info({ awaySeconds: seconds }, (dependency.words ?? this.#words).back(seconds));
    }
    this.#awaySince.clear();
  }

  /** A pass failed, with `error`; `about` is what the worker's line says of the pass besides. */
  failed(error: unknown, about: Record<string, unknown> = {}): void {
    const dependency = this.#on.find((one) => one.away(error));
    if (!dependency) {
      this.#log.error({ ...about, err: error }, this.#words.failed);
      return;
    }
    const words = dependency.words ?? this.#words;
    const now = this.#now().getTime();
    const since = this.#awaySince.get(dependency) ?? now;
    this.#awaySince.set(dependency, since);
    const away = now - since;
    if (away < dependency.awayMs) this.#log.warn({ ...about, err: error, awayMs: away }, words.away);
    else this.#log.error({ ...about, err: error, awayMs: away }, words.stillAway);
  }
}
