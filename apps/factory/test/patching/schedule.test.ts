import { describe, expect, it, vi } from 'vitest';
import { everyHour, SHORTLY_MS, waitAfter } from '../../src/patching/schedule.ts';

describe("the sense's reads", () => {
  it('are an hour apart, or fifteen seconds after a pass the worker’s door refused', () => {
    expect(waitAfter('hour')).toBe(3_600_000);
    expect(waitAfter('shortly')).toBe(SHORTLY_MS);
    expect(SHORTLY_MS).toBe(15_000);
  });

  it('leave no listener on the signal after a wait the timer ended', async () => {
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
      const done = everyHour(async () => ({ next: (++passes > 0 ? 'hour' : 'shortly') as 'hour' }), signal);
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(3_600_000);
      expect(passes).toBeGreaterThanOrEqual(5);
      expect(listening).toBe(1);
      abort.abort();
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('start as the sense starts, and stop when it is told to', async () => {
    const abort = new AbortController();
    let passes = 0;
    await everyHour(async () => {
      passes++;
      abort.abort();
      return { next: 'hour' as const };
    }, abort.signal);
    expect(passes).toBe(1);
  });

  it('run one pass at a time, however long a pass takes, and wait only after it ends', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      let running = 0;
      let most = 0;
      let passes = 0;
      // Each pass takes nine minutes, and the next is an hour on.
      const pass = async () => {
        running++;
        most = Math.max(most, running);
        passes++;
        await new Promise((resolve) => setTimeout(resolve, 9 * 60_000));
        running--;
        return { next: 'hour' as const };
      };
      const done = everyHour(pass, abort.signal);
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
