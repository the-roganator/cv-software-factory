/**
 * When the dependency sense reads: as it starts, then an hour after each pass ends; and fifteen seconds after a pass the
 * worker's door or the store refused (it is starting, as when a deploy restarts it beside the sense, or its policy has
 * not admitted the sense). The scan runs once a day (`.github/workflows/vulnerabilities.yml`), and the pull requests
 * and issues that carry its moves change at any hour: an hourly read has each within the hour.
 */

const HOUR = 3_600_000;

/**
 * How old the last day appended may be before the sense appends one again though nothing in it changed: so the console
 * and the line can tell a quiet day from a sense that has stopped.
 */
export const KEEP_DAY_HOURS = 12;

/** When the next read is: an hour on, or shortly (the worker's door or the store refused the pass). */
export type Next = 'hour' | 'shortly';

/** How soon a pass the worker's door refused is taken again: the worker listens within seconds of starting. */
export const SHORTLY_MS = 15_000;

/** How long to wait after a pass. */
export const waitAfter = (next: Next): number => (next === 'shortly' ? SHORTLY_MS : HOUR);

/** Runs passes until `signal` aborts: one now, then as `waitAfter` says. */
export async function everyHour(pass: () => Promise<{ next: Next }>, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const { next } = await pass();
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const stop = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', stop);
        resolve();
      }, waitAfter(next));
      signal.addEventListener('abort', stop, { once: true });
    });
  }
}
