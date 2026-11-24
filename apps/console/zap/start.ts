/**
 * The two waits at the start of ZAP's scan (`scan.ts`), each bounded and tried again, since each has stalled on a tree
 * that passed when run again: the image's pull, whose token GHCR once did not give within Docker's own limit, and ZAP's
 * start, which once hung in its add-on update (`-addonupdate`, its add-on store never answering) until zap-baseline.py
 * gave up after ten minutes. ZAP answers zap-baseline.py within seconds when it starts, and its image pulls in about
 * thirty.
 */
import { spawnSync } from 'node:child_process';

/** Tries of the image's pull, and how long each may take. */
export const PULL_TRIES = 3;
export const PULL_LIMIT_MS = 2 * 60_000;

/** How long ZAP has to answer zap-baseline.py, and how many times it is started. */
export const START_LIMIT_MS = 3 * 60_000;
export const START_TRIES = 2;

/** The status a run that ZAP never answered in ends with: no status of zap-baseline.py's or `hooks.py`'s. */
export const NEVER_STARTED = 5;

type Say = (line: string) => void;

/** One pull of the image, within the limit: whether it pulled, and Docker's last words when it did not. */
export type Pull = (image: string, limitMs: number) => { ok: boolean; said: string };

export const dockerPull: Pull = (image, limitMs) => {
  const out = spawnSync('docker', ['pull', '--quiet', image], { encoding: 'utf-8', timeout: limitMs });
  const said = `${out.stderr ?? ''}${out.error ? ` ${out.error.message}` : ''}`.trim().split('\n').at(-1) ?? '';
  return { ok: out.status === 0, said };
};

/** Pulls the image, up to `PULL_TRIES` times; says each try that failed. Whether one pulled it. */
export function pullImage(image: string, pull: Pull = dockerPull, say: Say = console.error): boolean {
  for (let attempt = 1; attempt <= PULL_TRIES; attempt++) {
    const started = Date.now();
    const { ok, said } = pull(image, PULL_LIMIT_MS);
    if (ok) return true;
    say(
      `ZAP's image did not pull, try ${attempt} of ${PULL_TRIES}, after ${Math.round((Date.now() - started) / 1000)}s: ${said || 'no word from Docker'}`,
    );
  }
  return false;
}

/** How long a stopped run has to end before its client is killed, and then to go. */
export const STOP_WAIT_MS = 20_000;

/** One run of ZAP: its exit, a way to stop it (its container), and a way to end its client when that does not. */
export interface Run {
  exit: Promise<number | null>;
  stop: () => void;
  kill: () => void;
}

/** Whether `promise` settles within `ms`. */
const within = (promise: Promise<unknown>, ms: number) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/**
 * Starts ZAP up to `START_TRIES` times: a run whose ZAP has not answered (`answered`, asked of each attempt by its
 * number, which `hooks.py` makes true for its own attempt alone, so a stopped ZAP that answers late counts for nothing)
 * within `START_LIMIT_MS` is stopped and started again. A stopped run has `STOP_WAIT_MS` to end, then its client is
 * killed and given as long again, so a stop that does nothing (a Docker that does not answer) never holds the scan. The
 * last run's exit, or `NEVER_STARTED` when no run's ZAP answered.
 */
export async function runStarted(
  start: (attempt: number) => Run,
  answered: (attempt: number) => boolean,
  say: Say = console.error,
  limitMs = START_LIMIT_MS,
  everyMs = 2_000,
  stopWaitMs = STOP_WAIT_MS,
): Promise<number | null> {
  for (let attempt = 1; ; attempt++) {
    const run = start(attempt);
    let done = false;
    const exit = run.exit.then((code) => {
      done = true;
      return code;
    });
    const until = Date.now() + limitMs;
    while (!done && !answered(attempt) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    if (done || answered(attempt)) return exit;
    run.stop();
    let how = 'stopped';
    if (!(await within(exit, stopWaitMs))) {
      run.kill();
      how = (await within(exit, stopWaitMs)) ? 'stopped, its client killed' : 'its client killed, and not yet gone';
    }
    say(`ZAP did not answer within ${Math.round(limitMs / 1000)}s, try ${attempt} of ${START_TRIES}: ${how}.`);
    if (attempt >= START_TRIES) return NEVER_STARTED;
  }
}
