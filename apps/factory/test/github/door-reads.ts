import { GitHubError } from '../../src/github/client.ts';
import type { PullRequestState, Reads } from '../../src/github/reads.ts';

/**
 * The reads the worker's door asks before an action on a pull request by its number, which it refuses on the pin
 * watch's: each number given is a pull request from that branch, and any other is an issue's (not found as a pull
 * request), so a test about something else is not held by it.
 */
export function doorReads(heads: Record<number, string> = {}): Reads {
  const pullRequest = async (_repo: string, number: number): Promise<PullRequestState> => {
    const ref = heads[number];
    if (ref === undefined) throw new GitHubError('not-found', `#${number} is not a pull request.`, 404);
    return { head: { ref } } as PullRequestState;
  };
  return { pullRequest } as unknown as Reads;
}
