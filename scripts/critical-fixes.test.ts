import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHub, PullRequest, Run } from './review-gate.ts';

/**
 * The `critical fix` job's own deadline (`readCriticalFix`): reads that outlast it answer the pull request with a hold,
 * the job goes on, and a reader that opens after it is closed as it opens, so its directory is not left behind.
 */

const opened: { close: ReturnType<typeof vi.fn> }[] = [];
let open: (() => void) | undefined;
vi.mock('./critical-fix-readers.ts', () => ({
  realCriticalFixIO: () =>
    new Promise((resolve) => {
      const reader = { close: vi.fn() };
      opened.push(reader);
      open = () => resolve(reader);
    }),
}));

const SHA = 'b'.repeat(40);
const run = { repo: 'owner/app', read: 'token' } as Run;
const pr = {
  number: 7,
  state: 'open',
  created_at: '2026-11-14T00:00:00Z',
  base: { ref: 'main' },
  head: { sha: 'a'.repeat(40), ref: 'factory/fix', repo: { full_name: 'owner/app' } },
} as unknown as PullRequest;
const github: GitHub = {
  paged: async () => [],
  api: async <T>() => ({ merge_base_commit: { sha: SHA }, base_commit: { sha: SHA } }) as T,
};

afterEach(() => {
  vi.useRealTimers();
  opened.length = 0;
});

describe('the critical fix job’s deadline', () => {
  it('holds when the reader outlasts it, with no unhandled rejection, and closes the reader that opens late', async () => {
    vi.useFakeTimers();
    const { readCriticalFix, CRITICAL_FIXES_MS } = await import('./critical-fixes.ts');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const answer = readCriticalFix(run, pr, github);
      await vi.advanceTimersByTimeAsync(CRITICAL_FIXES_MS);
      expect(await answer).toEqual({
        reason: 'the gate could not read what it proves a critical fix by (the critical fix job ran out of time)',
      });
      expect(opened).toHaveLength(1);
      expect(opened[0]?.close).not.toHaveBeenCalled();
      open?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(opened[0]?.close).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('holds, and the job goes on, when GitHub’s reads before the reader outlast it', async () => {
    vi.useFakeTimers();
    const { readCriticalFix, CRITICAL_FIXES_MS } = await import('./critical-fixes.ts');
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let slowed = 0;
      const slow: GitHub = {
        ...github,
        // The first read alone is slow: the deadline passes while it is out.
        paged: <T>() =>
          new Promise<T[]>((resolve) => setTimeout(() => resolve([]), slowed++ ? 0 : CRITICAL_FIXES_MS + 1000)),
      };
      const answer = readCriticalFix(run, pr, slow);
      await vi.advanceTimersByTimeAsync(CRITICAL_FIXES_MS + 5000);
      expect(await answer).toHaveProperty('reason');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
