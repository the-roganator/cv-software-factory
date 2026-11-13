import { describe, expect, it } from 'vitest';
import { retried } from '../../src/gates/retry.ts';

/** A call that fails `times` times with the errors given in turn (the last repeated), then answers. */
function flaky(errors: unknown[], times: number) {
  let tries = 0;
  return {
    what: async () => {
      tries++;
      if (tries <= times) throw errors[Math.min(tries, errors.length) - 1];
      return 'answer';
    },
    tries: () => tries,
  };
}

describe('a call tried again', () => {
  it('waits each wait in turn, and throws the last failure when they run out', async () => {
    const waited: number[] = [];
    const last = new Error('third');
    const call = flaky([new Error('first'), new Error('second'), last], 9);
    await expect(retried(call.what, { waits: [10, 20], wait: async (ms) => void waited.push(ms) })).rejects.toBe(last);
    expect([call.tries(), waited]).toEqual([3, [10, 20]]);
  });

  it('gives the first answer it gets, and is told of each failure tried again', async () => {
    const failed: unknown[] = [];
    const call = flaky([new Error('once')], 1);
    const answer = await retried(call.what, { waits: [10, 20], failed: (e) => failed.push(e), wait: async () => {} });
    expect([answer, call.tries(), failed.length]).toEqual(['answer', 2, 1]);
  });

  it('throws an answer at once, untold and unwaited', async () => {
    const waited: number[] = [];
    const failed: unknown[] = [];
    const answer = new Error('404');
    const call = flaky([answer], 9);
    await expect(
      retried(call.what, {
        waits: [10],
        permanent: (e) => e === answer,
        failed: (e) => failed.push(e),
        wait: async (ms) => void waited.push(ms),
      }),
    ).rejects.toBe(answer);
    expect([call.tries(), waited, failed]).toEqual([1, [], []]);
  });

  it('waits as long as a failure asks instead, when the caller reads one', async () => {
    const waited: number[] = [];
    const call = flaky([Object.assign(new Error('429'), { after: 60_000 }), new Error('500')], 2);
    await retried(call.what, {
      waits: [10, 20],
      after: (e, planned) => (e as { after?: number }).after ?? planned,
      wait: async (ms) => void waited.push(ms),
    });
    expect(waited).toEqual([60_000, 20]);
  });

  it('tries once with no waits', async () => {
    const call = flaky([new Error('down')], 9);
    await expect(retried(call.what, { waits: [] })).rejects.toThrow('down');
    expect(call.tries()).toBe(1);
  });
});
