import { storeAway } from '@software-factory/store';
import type { Logger } from 'pino';

/**
 * How long the store may be away before a pass that cannot reach it is a fault: a minute. Patching Postgres restarts
 * its StatefulSet, and the store is back within seconds; a minute is several times that, and four passes at a worker's
 * fifteen seconds. A store away for longer is a fault, logged as an error at every pass, as any other failure is.
 */
export const STORE_AWAY_MS = 60_000;

/** What a worker's passes are called in its log. */
export interface PassWords {
  /** A pass that could not reach what it depends on, while it has been away less than its time: a warning. */
  away: string;
  /** A pass that could not reach it once it has been away for longer: an error. */
  stillAway: string;
  /** A pass that failed in any other way: an error. */
  failed: string;
  /** The pass that reached it again, after so many seconds: an info line. */
  back(seconds: number): string;
}

/** What a worker's passes depend on, when it is not the store: how its absence fails a pass, and for how long. */
export interface Dependency {
  /** Whether a pass failed with this error because the dependency is away for now, rather than for a fault. */
  away(error: unknown): boolean;
  /** How long it may be away before a pass that cannot reach it is a fault. */
  awayMs: number;
}

/** The store: away while `storeAway` says so, for up to `STORE_AWAY_MS`. */
const STORE: Dependency = { away: storeAway, awayMs: STORE_AWAY_MS };

/**
 * Says how each pass of a worker at what it depends on ended, the store unless it is told another: a pass that could
 * not reach it, while it has been away less than its time, as a warning, and the pass that reaches it again with how
 * long it was away; any other failure, and every one once it has been away for longer, as an error. The worker must
 * go on making passes while it is away, as only a pass that reaches it ends the absence.
 */
export class PassLog {
  /** When the first pass of the absence failed, while it lasts. */
  #awaySince: number | null = null;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #words: PassWords;
  readonly #on: Dependency;

  constructor(log: Logger, now: () => Date, words: PassWords, on: Dependency = STORE) {
    this.#log = log;
    this.#now = now;
    this.#words = words;
    this.#on = on;
  }

  passed(): void {
    if (this.#awaySince === null) return;
    const seconds = Math.round((this.#now().getTime() - this.#awaySince) / 1000);
    this.#awaySince = null;
    this.#log.info({ awaySeconds: seconds }, this.#words.back(seconds));
  }

  /** A pass failed, with `error`; `about` is what the worker's line says of the pass besides. */
  failed(error: unknown, about: Record<string, unknown> = {}): void {
    if (!this.#on.away(error)) {
      this.#log.error({ ...about, err: error }, this.#words.failed);
      return;
    }
    const now = this.#now().getTime();
    this.#awaySince ??= now;
    const away = now - this.#awaySince;
    if (away < this.#on.awayMs) this.#log.warn({ ...about, err: error, awayMs: away }, this.#words.away);
    else this.#log.error({ ...about, err: error, awayMs: away }, this.#words.stillAway);
  }
}
