/**
 * Guardrail 10 (public means hostile), as the GitHub worker keeps it: the factory acts only on the issues and pull
 * requests it opened, and reads no issue as work. Martin asks the line for work with the console's "+"; no issue, and
 * no label on one, does.
 *
 * - **The guard.** Any action on an issue or pull request the App did not open (commenting, labelling, closing,
 *   reopening; updating, describing, readying or drafting, reviewing, resolving threads, adding to the merge queue)
 *   is refused before GitHub is asked to change anything, whoever asks: the line through the worker's step API, or a
 *   watch. Each refusal is kept, logged and signed as `github-guard` (`refusals.ts`), and the action fails with
 *   `IssueRefused`, carrying it, which the worker answers 403, as GitHub answers an issue the App may not change. A
 *   pull request is an issue to GitHub, so one the App opened passes, as its issues do.
 * - **The reply.** An issue opened by anyone but Martin or the App gets one comment, `OUTSIDE_REPLY`, the one
 *   exception the guard makes, and only with those words: it echoes nothing of the issue, so nothing anyone writes
 *   in one is repeated by the App. Nothing else is done to it.
 * - **The watch.** Once a minute, with a conditional request, the worker reads each repository's newest open issues,
 *   and replies to each outside one it has not answered. It keeps no cursor: the worker touches no store. Saying it
 *   once is the memory (the live actions read an issue's comments before commenting), so a restarted worker reads
 *   the comments of each open outside issue once more, and says nothing twice.
 *
 * People are known by their numeric ids, which an account keeps when it is renamed, never by their logins.
 */

import type { Logger } from 'pino';
import { z } from 'zod';
import type { SignedRefusal } from '../signed-refusals.ts';
import type { Actions } from './actions.ts';
import { type GitHub, GitHubError } from './client.ts';
import type { Watch } from './poller.ts';
import type { RefusalRecorder } from './refusals.ts';

/** Martin's GitHub account (`mrogan`), as `scripts/review-gate.ts` knows him. */
export const MARTIN = 6206459;

/** The App's bot account (`mrogan-software-factory[bot]`): the user that opens its issues and pull requests. */
export const APP_USER = 337_765_427;

/** What an issue opened by anyone else is told, once. Fixed: it says nothing of the issue, or of who opened it. */
export const OUTSIDE_REPLY = [
  'Thank you for opening this.',
  '',
  'This repository is looked after by an automated software factory. It acts only on what it finds itself and on ' +
    'what its operators ask of it directly, so it will not act on this issue. A human will read this issue.',
].join('\n');

/** The actions the guard holds to the App's own issues and pull requests: every one that names one. */
export type IssueAction =
  | 'comment'
  | 'addLabels'
  | 'closeIssue'
  | 'reopenIssue'
  | 'updatePullRequest'
  | 'describeDeploy'
  | 'readyForReview'
  | 'convertToDraft'
  | 'review'
  | 'resolveThreads'
  | 'closePullRequest'
  | 'enqueuePullRequest';

/** What an issue's opener is, as the guard asks: their numeric id (null for a deleted account), and whether it is a pull request. */
export interface Opened {
  by: number | null;
  pullRequest: boolean;
}

export type OpenedBy = (repo: string, number: number) => Promise<Opened>;

const ISSUE = z.object({
  user: z.object({ id: z.number().int() }).nullable(),
  pull_request: z.unknown().optional(),
});

/** Who opened an issue or pull request, read from GitHub. One it does not have is GitHub's 404, and refuses nothing. */
export function openedBy(github: GitHub): OpenedBy {
  return async (repo, number) => {
    const issue = await github.read(repo, `/repos/${repo}/issues/${number}`, ISSUE);
    return { by: issue.user?.id ?? null, pullRequest: issue.pull_request !== undefined };
  };
}

/** Whether an issue's opener is someone the factory replies to: neither Martin nor the App. */
export const outside = (by: number | null) => by !== MARTIN && by !== APP_USER;

export class IssueRefused extends Error {
  override name = 'IssueRefused';
  /** The refusal as the recorder kept and signed it, when there is a recorder with somewhere to keep it. */
  readonly refusal: SignedRefusal | undefined;

  constructor(message: string, refusal: SignedRefusal | undefined) {
    super(message);
    this.refusal = refusal;
  }
}

const DOING: Record<IssueAction, string> = {
  comment: 'Comment on',
  addLabels: 'Label',
  closeIssue: 'Close',
  reopenIssue: 'Reopen',
  updatePullRequest: 'Update',
  describeDeploy: 'Describe the deploy on',
  readyForReview: 'Ready',
  convertToDraft: 'Put back to draft',
  review: 'Review',
  resolveThreads: 'Resolve the threads on',
  closePullRequest: 'Close',
  enqueuePullRequest: 'Add to the merge queue',
};

export interface IssueGuardOptions {
  openedBy: OpenedBy;
  /** What keeps, logs and signs each refusal (`refusals.ts`); without it, a refusal is only thrown. */
  recorder?: RefusalRecorder | undefined;
}

export class IssueGuard {
  readonly #openedBy: OpenedBy;
  readonly #recorder: RefusalRecorder | undefined;
  /** Who opened each issue it has asked about, which never changes: asked of GitHub once. */
  readonly #opened = new Map<string, Promise<Opened>>();

  constructor({ openedBy, recorder }: IssueGuardOptions) {
    this.#openedBy = openedBy;
    this.#recorder = recorder;
  }

  /**
   * Passes an action on an issue or pull request the App opened, and the outside reply, word for word, on an issue
   * opened by anyone but Martin or the App. Anything else is recorded, and thrown as `IssueRefused`.
   */
  async check(repo: string, number: number, action: IssueAction, body?: string): Promise<void> {
    const opened = await this.#openerOf(repo, number);
    if (opened.by === APP_USER) return;
    if (action === 'comment' && body === OUTSIDE_REPLY && !opened.pullRequest && outside(opened.by)) return;
    const what = opened.pullRequest ? 'pull request' : 'issue';
    const output =
      `${repo}#${number} was opened by ${opened.by === null ? 'a deleted account' : `user ${opened.by}`}, ` +
      `not the factory's App: the factory acts only on the issues and pull requests it opened (guardrail 10).`;
    const refusal = await this.#recorder?.record({
      mechanism: 'github-guard',
      cause: 'issue',
      repo,
      number,
      action: `${DOING[action]} ${what} #${number} in ${repo}`,
      output,
    });
    throw new IssueRefused(output, refusal);
  }

  /** Asked once, even by actions asked at once: the read in flight is shared, and forgotten if it fails. */
  #openerOf(repo: string, number: number): Promise<Opened> {
    const key = `${repo}#${number}`;
    const known = this.#opened.get(key);
    if (known) return known;
    // A guard against a leak, not a working limit: the factory acts on a few hundred issues in a worker's life.
    if (this.#opened.size >= 10_000) this.#opened.clear();
    const opened = this.#openedBy(repo, number);
    this.#opened.set(key, opened);
    opened.catch(() => {
      if (this.#opened.get(key) === opened) this.#opened.delete(key);
    });
    return opened;
  }
}

/** A failure asking again would not mend: the guard's refusal, or GitHub's refused, not found or not valid. */
const final = (error: unknown) =>
  error instanceof IssueRefused ||
  (error instanceof GitHubError && ['refused', 'not-found', 'conflict'].includes(error.kind));

const OPEN_ISSUES = z.array(
  z.object({
    number: z.number().int().positive(),
    // GitHub gives a deleted account as null.
    user: z.object({ id: z.number().int() }).nullable(),
    pull_request: z.unknown().optional(),
  }),
);

/**
 * Watches a repository's open issues, newest first, and says `OUTSIDE_REPLY` once on each opened by anyone but
 * Martin or the App. A hundred at a minute's interval: more than that are not opened here in a minute. An issue whose
 * reply failed is tried again at the next poll, without holding back the others; one GitHub or the guard refuses (a
 * locked issue, one gone, one the guard will not pass) is logged once, and not tried again while the worker runs.
 */
export function outsideIssuesWatch(
  github: GitHub,
  repo: string,
  actions: Pick<Actions, 'comment' | 'dryRun'>,
  log: Logger,
): Watch {
  const answered = new Set<number>();
  let first = true;
  let retry = false;
  return async () => {
    const { changed, body } = await github.poll(
      repo,
      `/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=100`,
      OPEN_ISSUES,
    );
    if (!changed && !retry) return;
    const issues = body.filter((issue) => issue.pull_request === undefined);
    // Only what is open now is remembered: an issue closed since is forgotten.
    for (const number of answered) if (!issues.some((issue) => issue.number === number)) answered.delete(number);
    const due = issues.filter((issue) => !answered.has(issue.number) && outside(issue.user?.id ?? null));
    for (const issue of issues) if (!outside(issue.user?.id ?? null)) answered.add(issue.number);
    if (first) log.info({ repo, open: issues.length, outside: due.length }, 'read the open issues');
    else log.debug({ repo, open: issues.length, outside: due.length }, 'the open issues changed');
    first = false;
    let failure: unknown;
    for (const { number } of due) {
      try {
        await actions.comment(repo, number, OUTSIDE_REPLY);
        answered.add(number);
        log.info({ repo, issue: number, dryRun: actions.dryRun }, 'replied to an issue opened outside the factory');
      } catch (error) {
        if (final(error)) {
          answered.add(number);
          log.warn({ repo, issue: number, err: error }, 'cannot reply to an issue opened outside the factory');
        } else failure ??= error;
      }
    }
    retry = failure !== undefined;
    if (failure) throw failure;
  };
}
