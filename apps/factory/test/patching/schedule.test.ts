import { describe, expect, it } from 'vitest';
import { everyDay, nextDaily, timeOfDay, waitAfter } from '../../src/patching/schedule.ts';

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
});
