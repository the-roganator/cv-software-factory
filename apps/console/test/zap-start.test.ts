/**
 * The waits at the start of ZAP's scan (`zap/start.ts`): the image's pull and ZAP's start, each bounded and tried
 * again, so a pull or a start that stalls costs minutes and one more try rather than the job.
 */
import { describe, expect, it } from 'vitest';
import { NEVER_STARTED, PULL_TRIES, pullImage, type Run, runStarted, START_TRIES } from '../zap/start.ts';

describe("ZAP's image", () => {
  it('pulls on a later try after one that failed, and says the failure', () => {
    const said: string[] = [];
    let tries = 0;
    const ok = pullImage(
      'zap',
      () => ({ ok: ++tries === 2, said: 'context deadline exceeded' }),
      (l) => said.push(l),
    );
    expect(ok).toBe(true);
    expect(tries).toBe(2);
    expect(said).toEqual([
      expect.stringMatching(/^ZAP's image did not pull, try 1 of 3, after \d+s: context deadline exceeded$/),
    ]);
  });

  it(`gives up after ${PULL_TRIES} tries`, () => {
    let tries = 0;
    expect(
      pullImage(
        'zap',
        () => ({ ok: !++tries, said: '' }),
        () => {},
      ),
    ).toBe(false);
    expect(tries).toBe(PULL_TRIES);
  });
});

/** A run of ZAP that ends when stopped, or with `code` when it answers. */
function fakeRun(answers: boolean, code = 0) {
  let end: (code: number | null) => void = () => {};
  const run: Run = { exit: new Promise((resolve) => (end = resolve)), stop: () => end(137) };
  if (answers) setTimeout(() => end(code), 5);
  return run;
}

describe("ZAP's start", () => {
  it('stops a ZAP that does not answer within the limit, and starts it once more', async () => {
    const said: string[] = [];
    let answered = false;
    const starts: number[] = [];
    const exit = await runStarted(
      (attempt) => {
        starts.push(attempt);
        if (attempt === 2) answered = true;
        return fakeRun(attempt === 2, 2);
      },
      () => answered,
      (l) => said.push(l),
      20,
      1,
    );
    expect(starts).toEqual([1, 2]);
    expect(exit).toBe(2);
    expect(said).toEqual([`ZAP did not answer within 0s, try 1 of ${START_TRIES}: stopped.`]);
  });

  it(`ends with its own status after ${START_TRIES} starts no ZAP answered`, async () => {
    let starts = 0;
    const exit = await runStarted(
      () => {
        starts++;
        return fakeRun(false);
      },
      () => false,
      () => {},
      10,
      1,
    );
    expect(starts).toBe(START_TRIES);
    expect(exit).toBe(NEVER_STARTED);
  });

  it('keeps the exit of a ZAP that stopped by itself before answering, which hooks.py reports', async () => {
    const exit = await runStarted(
      () => fakeRun(true, 4),
      () => false,
      () => {},
      1_000,
      1,
    );
    expect(exit).toBe(4);
  });
});
