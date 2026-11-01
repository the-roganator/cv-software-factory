import { describe, expect, it } from 'vitest';
import {
  axis,
  changedShare,
  count,
  countdown,
  duration,
  figure,
  isCommit,
  listed,
  lower,
  percent,
  shortVersion,
  sinceStart,
} from '../web/src/format.ts';

describe('a chart’s axis', () => {
  it.each([
    ['latency in milliseconds', 706, 800, [0, 400, 800]],
    ['an error rate', 0.03, 0.04, [0, 0.02, 0.04]],
    ['a latency in seconds', 0.8, 0.9, [0, 0.45, 0.9]],
    ['a share just under a whole', 0.27, 0.3, [0, 0.15, 0.3]],
    ['nothing at all', 0, 1, [0, 0.5, 1]],
  ])('fits %s', (_case, top, max, ticks) => {
    expect(axis(top)).toEqual({ max, ticks });
  });

  it('gives every tick its own value and label', () => {
    for (const top of [0.003, 0.03, 0.3, 3, 30, 300, 3000]) {
      const { ticks } = axis(top);
      expect(new Set(ticks.map(figure)).size).toBe(3);
    }
  });
});

describe('a figure', () => {
  it('keeps three significant figures, whatever the scale', () => {
    expect([642, 85, 0.015, 0.02345, 1500].map(figure)).toEqual(['642', '85', '0.015', '0.0235', '1,500']);
  });
});

describe('a version', () => {
  it('writes a commit by its first seven characters, as GitHub does', () => {
    expect(shortVersion('4f9c2e1b7d3a6058e9b1c4d2a7f3e6b9c0d1e2f3')).toBe('4f9c2e1');
    expect(shortVersion('4f9c2e1')).toBe('4f9c2e1');
  });

  it('writes a release as it is', () => {
    expect(shortVersion('v0.9.3')).toBe('v0.9.3');
    expect(isCommit('v0.9.3')).toBe(false);
  });
});

describe('a duration', () => {
  it('writes each part as one value, the parts held together', () => {
    const [s, min, h, d] = [1000, 60_000, 3_600_000, 86_400_000];
    expect([200, 40 * s, 31 * min, h + 4 * min, 2 * h, d + 19 * h, 9 * d + 5 * h].map(duration)).toEqual([
      '1s',
      '40s',
      '31min',
      '1h\u00a04min',
      '2h',
      '1d\u00a019h',
      '9d',
    ]);
  });
});

describe('the time since an item opened', () => {
  it('counts minutes, then hours, then days, each day as a duration writes it', () => {
    const [s, min, h, d] = [1000, 60_000, 3_600_000, 86_400_000];
    const times = [
      0,
      4 * min + 20 * s,
      h + 2 * min + 30 * s,
      23 * h + 59 * min + 59 * s,
      5 * d + 12 * h + 39 * min + 59 * s,
      5 * d + 2 * h,
    ];
    expect(times.map(sinceStart)).toEqual([
      'T+00:00',
      'T+04:20',
      'T+1:02:30',
      'T+23:59:59',
      'T+5d\u00a012:39:59',
      'T+5d\u00a002:00:00',
    ]);
  });
});

describe('the time left of a canary’s step, or until its next look', () => {
  it('counts down in minutes and seconds, a part second as a whole one, and never below nothing', () => {
    expect([151_000, 29_400, 60_000, 0, -5000].map(countdown)).toEqual(['2:31', '0:30', '1:00', '0:00', '0:00']);
  });
});

describe('a percentage', () => {
  it('writes a share to a tenth of a point, and a rate the canary judges to a hundredth', () => {
    expect(percent(0.046)).toBe('4.6%');
    expect(percent(0)).toBe('0.0%');
    expect(percent(0.0025, 2)).toBe('0.25%');
  });

  it('writes the share of pixels a change touched without ever showing a change as none', () => {
    expect(changedShare(0.123)).toBe('12.3%');
    expect(changedShare(0.0042)).toBe('0.42%');
    expect(changedShare(0.00001)).toBe('under 0.01%');
  });
});

describe('words in a sentence', () => {
  it('groups a count in thousands', () => {
    expect(count(1500)).toBe('1,500');
    expect(count(42)).toBe('42');
  });

  it('lists words with "and" before the last', () => {
    expect(listed([])).toBe('');
    expect(listed(['Playwright'])).toBe('Playwright');
    expect(listed(['Playwright', 'Loki', 'the widget'])).toBe('Playwright, Loki and the widget');
  });

  it('puts a sentence in the middle of another', () => {
    expect(lower('Waiting for Martin')).toBe('waiting for Martin');
    expect(lower('')).toBe('');
  });
});
