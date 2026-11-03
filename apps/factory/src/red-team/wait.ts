/**
 * Waiting for something the store or the cluster will show, up to an attack's limit, giving up promptly when the
 * worker stops. An attack waits for the refusal it expects, matched to its own attempt, never by timing alone: this
 * only decides how often to look and when to stop.
 */

export interface WaitOptions {
  /** How long to keep looking, in milliseconds. */
  limitMs: number;
  /** How often to look. */
  everyMs?: number;
  /** Rejects when the worker is stopping. */
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Looks with `get` until it returns something other than undefined, the limit passes, or the worker stops, and gives
 * back what it found or undefined. `get` is tried once at the start, so a limit already passed still looks once.
 */
export async function waitFor<T>(get: () => Promise<T | undefined>, options: WaitOptions): Promise<T | undefined> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const every = options.everyMs ?? 3000;
  const until = now() + options.limitMs;
  for (;;) {
    if (options.signal.aborted) return undefined;
    const found = await get();
    if (found !== undefined) return found;
    if (now() >= until) return undefined;
    await sleep(Math.min(every, Math.max(0, until - now()))).catch(() => undefined);
  }
}
