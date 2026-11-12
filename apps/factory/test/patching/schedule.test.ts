import { describe, expect, it, vi } from 'vitest';
import { everyDay, nextDaily, stale, timeOfDay, waitAfter } from '../../src/patching/schedule.ts';

const at = timeOfDay('05:30');
const t = (iso: string) => Date.parse(iso);

describe("the sense's day", () => {
  it('is read at the time it is given, in UTC', () => {
    expect(nextDaily(t('2026-11-11T04:00:00Z'), at)).toBe(t('2026-11-11T05:30:00Z'));
    expect(nextDaily(t('2026-11-11T05:30:00Z'), at)).toBe(t('2026-11-12T05:30:00Z'));
    expect(() => timeOfDay('5:30')).toThrow('HH:MM');
    expect(() => timeOfDay('24:00')).toThrow('HH:MM');
  });

  it('is read again an hour after a pass that failed, but never past the next day’s read', () => {
    expect(waitAfter(t('2026-11-11T06:00:00Z'), at, true)).toBe(3_600_000);
    expect(waitAfter(t('2026-11-12T05:00:00Z'), at, true)).toBe(1_800_000);
    expect(waitAfter(t('2026-11-11T06:00:00Z'), at, false)).toBe(t('2026-11-12T05:30:00Z') - t('2026-11-11T06:00:00Z'));
  });

  it('counts a scan read after the day’s scan time and finished before it as yesterday’s', () => {
    expect(stale('2026-11-10T04:58:00Z', t('2026-11-11T05:30:00Z'))).toBe(true);
    expect(stale('2026-11-11T04:58:00Z', t('2026-11-11T05:30:00Z'))).toBe(false);
    // Before the day's scan time, yesterday's is the latest there can be.
    expect(stale('2026-11-10T04:58:00Z', t('2026-11-11T03:00:00Z'))).toBe(false);
  });

  it('leaves no listener on the signal after a wait the timer ended', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const signal = abort.signal;
      let listening = 0;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((...args: Parameters<typeof add>) => {
        listening++;
        add(...args);
      }) as typeof add;
      signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
        listening--;
        remove(...args);
      }) as typeof remove;
      let passes = 0;
      const done = everyDay(
        async () => ({ failed: ++passes > 0 }),
        at,
        signal,
        () => Date.now(),
      );
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(3_600_000);
      expect(passes).toBeGreaterThanOrEqual(5);
      expect(listening).toBe(1);
      abort.abort();
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('is read as the sense starts, and stops when it is told to', async () => {
    const abort = new AbortController();
    let passes = 0;
    await everyDay(
      async () => {
        passes++;
        abort.abort();
        return { failed: false };
      },
      at,
      abort.signal,
    );
    expect(passes).toBe(1);
  });

  it('runs one pass at a time, however long a pass takes, and waits only after it ends', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      let running = 0;
      let most = 0;
      let passes = 0;
      // Each pass takes nine minutes, as a moves read of ten thousand alerts may, and fails, so the next is an hour on.
      const pass = async () => {
        running++;
        most = Math.max(most, running);
        passes++;
        await new Promise((resolve) => setTimeout(resolve, 9 * 60_000));
        running--;
        return { failed: true };
      };
      const done = everyDay(pass, at, abort.signal, () => Date.now());
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(most).toBe(1);
      // 180 minutes: a pass of 9, a wait of 60, and so on: three passes begun.
      expect(passes).toBe(3);
      abort.abort();
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});
