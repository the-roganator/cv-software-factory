/**
 * Closing a work item's issue in the app's repository, as the line and its flag pass both do: through the GitHub
 * worker, as not planned or completed, with a comment saying why. One GitHub no longer has, or that the App may no
 * longer change, is left as it is, and logged: asking again would not help, and the work item closes all the same.
 * Any other failure is thrown, for the caller to try again later; the GitHub worker never says a comment twice.
 */
import type { Logger } from 'pino';
import type { ActionArgs } from '../github/server.ts';
import { GitHubWorkerError, issueGone } from '../github/worker-client.ts';
import type { GitHubPort } from './worker.ts';

export async function closeIssue(
  github: Pick<GitHubPort, 'act'>,
  repo: string,
  args: ActionArgs['closeIssue'],
  workItem: string,
  log: Pick<Logger, 'warn'>,
): Promise<void> {
  await github.act('closeIssue', repo, args, { workItem }).catch((error: unknown) => {
    if (!issueGone(error)) throw error;
    // The GitHub worker's guard refusing it (guardrail 10) is told apart from an issue that is gone: it is no issue
    // of the App's, and the worker kept a record of the refusal.
    const refused = error instanceof GitHubWorkerError && error.kind === 'issue-refused';
    log.warn(
      { workItem, issue: args.number, err: error },
      refused ? 'the GitHub worker refused to close an issue the App did not open' : 'the issue cannot be closed',
    );
  });
}

/**
 * The comment on a work item's pull request as the line closes it unmerged on Martin's answer: why it closed, in the
 * close's own reason, with his words when he gave them and may share them (`fold`), and that its issue goes with it.
 */
export function rejectedPullComment(reason: string, workItem: string): string {
  const said = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return [
    `The factory closes this pull request unmerged. ${said}`,
    '',
    `The factory’s work item #${workItem} is closed with no change, and its issue with it.`,
  ].join('\n');
}
