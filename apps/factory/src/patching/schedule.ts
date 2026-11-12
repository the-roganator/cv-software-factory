/**
 * When the dependency sense reads: as it starts, then each day once the scan has had time to finish; an hour after a
 * pass that failed, or that found a repository's last scan older than the day's (GitHub's schedule runs late); and ten
 * minutes after a read the worker asked for again (`READ_AGAIN`); fifteen seconds after a pass the worker's door or the store
 * refused (it is starting, as when a deploy restarts it beside the sense, or its policy has not admitted the sense); each until the day's time comes round again. The scan
 * runs at 04:17 UTC
 * (`.github/workflows/vulnerabilities.yml`) and takes under an hour, so the day's read is at 05:30 UTC by default.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** When the scan starts each day (`vulnerabilities.yml`'s schedule), as milliseconds into a UTC day. */
export const SCAN_AT = (4 * 60 + 17) * 60_000;

/**
 * Whether a scan that finished at `finished` is older than the day's: once the day's scan time has passed, a run that
 * finished before it is yesterday's, and the day's may still be queued.
 */
export function stale(finished: string, now: number): boolean {
  const today = Math.floor(now / DAY) * DAY + SCAN_AT;
  return now >= today && Date.parse(finished) < today;
}

/** `HH:MM`, UTC, as milliseconds into the day. */
export function timeOfDay(text: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) throw new Error(`PATCHING_AT is ${JSON.stringify(text)}; it must be a time of day, HH:MM, in UTC.`);
  return (Number(match[1]) * 60 + Number(match[2])) * 60_000;
}

/** The next day's read after `now`, at `at` into a UTC day. */
export function nextDaily(now: number, at: number): number {
  const today = Math.floor(now / DAY) * DAY + at;
  return today > now ? today : today + DAY;
}

/**
 * When the next read is: the day's, an hour on (after a failure, or a scan older than today's), soon (a read to take
 * again), or shortly (the worker's door refused the pass).
 */
export type Next = 'daily' | 'hour' | 'soon' | 'shortly';

/** How soon a read to take again is taken: the scan that made it was finishing, which takes minutes. */
export const SOON_MS = 10 * 60_000;

/** How soon a pass the worker's door refused is taken again: the worker listens within seconds of starting. */
export const SHORTLY_MS = 15_000;

/** How long to wait after a pass: to the next day's read, or sooner as `next` says if that comes first. */
export function waitAfter(now: number, at: number, next: Next): number {
  const daily = nextDaily(now, at) - now;
  if (next === 'daily') return daily;
  return Math.min(next === 'soon' ? SOON_MS : next === 'shortly' ? SHORTLY_MS : HOUR, daily);
}

/** Runs passes until `signal` aborts: one now, then as `waitAfter` says. */
export async function everyDay(
  pass: () => Promise<{ next: Next }>,
  at: number,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<void> {
  while (!signal.aborted) {
    const { next } = await pass();
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const stop = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(
        () => {
          signal.removeEventListener('abort', stop);
          resolve();
        },
        waitAfter(now(), at, next),
      );
      signal.addEventListener('abort', stop, { once: true });
    });
  }
}
