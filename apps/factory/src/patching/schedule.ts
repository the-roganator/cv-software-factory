/**
 * When the dependency sense reads: as it starts, then each day once the scan has had time to finish, and an hour after
 * a pass that failed, until the day's time comes round again. The scan runs at 04:17 UTC
 * (`.github/workflows/vulnerabilities.yml`) and takes under an hour, so the day's read is at 05:30 UTC by default.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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

/** How long to wait after a pass: to the next day's read, or an hour after a failure if that comes first. */
export function waitAfter(now: number, at: number, failed: boolean): number {
  const daily = nextDaily(now, at) - now;
  return failed ? Math.min(HOUR, daily) : daily;
}

/** Runs passes until `signal` aborts: one now, then as `waitAfter` says. */
export async function everyDay(
  pass: () => Promise<{ failed: boolean }>,
  at: number,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<void> {
  while (!signal.aborted) {
    const { failed } = await pass();
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitAfter(now(), at, failed));
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
