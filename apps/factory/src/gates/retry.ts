/**
 * A call tried again after a failure, one way wherever the scan and the gates try one: a wait before each try after
 * the first, an answer that trying again cannot change thrown at once, and the last failure thrown when the waits run
 * out. What is worth another try is each caller's, as only it knows what its call's failures say.
 *
 * Node alone: the gates run from a sparse checkout with no dependencies.
 */

export interface Retry {
  /** The wait before each try after the first, in milliseconds: three waits are four tries. */
  waits: readonly number[];
  /** Whether a failure is an answer, thrown at once. None is, unless this says so. */
  permanent?: (error: unknown) => boolean;
  /** How long to wait after a failure instead of the planned wait: as long as a rate limit asks, say. */
  after?: (error: unknown, planned: number) => number;
  /** Told of each failure that is tried again. */
  failed?: (error: unknown) => void;
  wait?: (ms: number) => Promise<unknown>;
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** `what`, tried again on a failure after each of `waits` in turn, until it gives an answer or the waits run out. */
export async function retried<T>(
  what: () => Promise<T>,
  { waits, permanent, after, failed, wait = pause }: Retry,
): Promise<T> {
  for (let tried = 0; ; tried++) {
    try {
      return await what();
    } catch (error) {
      const planned = waits[tried];
      if (planned === undefined || permanent?.(error)) throw error;
      failed?.(error);
      const ms = after ? after(error, planned) : planned;
      if (ms > 0) await wait(ms);
    }
  }
}
