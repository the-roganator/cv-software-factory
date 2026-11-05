/**
 * The app's deploy pull request, as each work item held for a deploy sees it. After a fix merges, the line holds the
 * work item at Release until a release carries it (`machine.ts`), and the deploy pull request that will carry it is
 * opened by the App's deploy watch (`github/deploys.ts`), once main has a newer signed build. Until it is open and its
 * checks have passed, there is nothing to merge; so the line records where that pull request stands for each held work
 * item it carries (`deploy.changed`), and the console says what the wait waits for, and links it.
 *
 * Once a minute, beside telling the pull request what it carries, the line reads the watch's open proposal, works out
 * the held work items it carries (`carried`, as the Carries section does), and reads the pull request and the checks on
 * its head through the GitHub worker, judged as the gates are (`judge`): its checks running, all passed, or one that
 * failed; merged; or closed unmerged. A newer build moves the same pull request to a new head, whose checks run again.
 * A work item's record is the latest `deploy.changed` since its hold started; a state that differs is appended, so the
 * decision is the store's, and a line that restarts appends nothing twice.
 *
 * Once its checks have passed, the line adds it to the merge queue itself (`queueDeploy`), at that head, when every one
 * of these holds; otherwise it waits for Martin to merge it, and its record says why (`waits`):
 *
 * - the review gate's verdict on that head, read through the GitHub worker from the review App's own `review` check
 *   alone, as for a fix (`merging.ts`), passed it as an exact pin (`exact-pin`): every changed line a digest of an
 *   image `build.yml` signed on main. No other rule, and never a hold or one for another head. While the gate's check
 *   on the head runs, or concluded with a hold marked `pending` less than `PENDING_LIMIT_MS` ago, it is still being
 *   judged, and the record says its checks are running (`gateJudging`): the gate is not among the checks `judge` waits
 *   for;
 * - the autonomy level adds to the queue by that rule, with auto-merge on (`ENQUEUES`, `policy/line.ts`): at Guarded
 *   and Lights-out, never at Supervised;
 * - it does not conflict with main, and the GitHub worker and GitHub add it.
 *
 * It does so once for each head: once it has added it (`queued`), the queue merges it, which the read of the pull
 * request records, or takes it out (`dequeued`, with GitHub's reason and the checks that failed on the queue's commit),
 * and it waits for Martin. Nor does it try again a head the worker or GitHub refused (`waits: 'refused'`): the worker
 * signs a refusal, which is relayed as for any action (`refusals.ts`), on the first held work item the pull request
 * carries, as the action is for that one. A newer build's head is judged afresh. A refusal for a head that moved since
 * (409) is no refusal: nothing is recorded, and the next pass reads the new head.
 *
 * Only the app's deploy pull requests: the factory's own deploys are Martin's, and the line does not watch them. Acting
 * on one work item (`only`), the line adds one only when it carries no other (`worker.ts`). A
 * pull request recorded for a work item that is no longer the proposal (merged and gone, closed, or not known yet to a
 * GitHub worker that restarted) is read by its number, and only what GitHub says of it is recorded: an empty proposal
 * is never taken for a merge or a close. A dry run's deploy pull request, which GitHub never had, is never recorded.
 */
import type { PayloadOf } from '@software-factory/events';
import { cutAt, cutTo } from '@software-factory/events';
import type { Logger } from 'pino';
import { type Controls, enqueues } from '../../../../policy/line.ts';
import { DRY_RUN_NUMBERS_FROM } from '../github/actions.ts';
import type { DeployProposal } from '../github/deploys.ts';
import type { ReviewVerdict } from '../github/merging.ts';
import { type CheckRun, outcomeOf, type PullRequestState } from '../github/reads.ts';
import { GitHubWorkerError } from '../github/worker-client.ts';
import { type Draft, judge, latestRuns } from './gates.ts';
import { PENDING_LIMIT_MS } from './merging.ts';
import type { GitHubPort } from './worker.ts';

export type DeployChange = PayloadOf<'deploy.changed'>;

/** Where a deploy pull request stands, from what GitHub says of it and of the checks on its head. */
export function deployState(
  pr: PullRequestState,
  runs: readonly CheckRun[],
  required: readonly string[],
): Pick<DeployChange, 'state' | 'failed'> {
  if (pr.merged) return { state: 'merged' };
  if (pr.state === 'closed') return { state: 'closed' };
  const latest = latestRuns(runs);
  // No check has started on the head yet: GitHub starts them a moment after a push.
  if (latest.size === 0) return { state: 'checking' };
  const { waiting, failed } = judge(latest, required);
  if (waiting) return { state: 'checking' };
  return failed.length ? { state: 'failed', failed: failed.slice(0, 40) } : { state: 'passed' };
}

/**
 * Why the line does not add a deploy pull request whose checks passed at `head` to the merge queue, by the gate's
 * verdict and Martin's controls, or undefined when it may: only an exact pin of that head, at a level that adds one,
 * with auto-merge on.
 */
export function deployWait(
  verdict: Pick<ReviewVerdict, 'head' | 'judged'>,
  head: string,
  merging: Pick<Controls, 'autonomy' | 'autoMerge'>,
): Pick<DeployChange, 'waits' | 'rule'> | undefined {
  const { judged } = verdict;
  // A verdict for another head says nothing of this one, and a pending one says only that the gate has not judged.
  const of = verdict.head === head && judged?.head === head && judged.pending === undefined ? judged : null;
  if (of?.rule !== 'exact-pin') return { waits: 'verdict', ...(of ? { rule: of.rule } : {}) };
  if (!enqueues({ autonomy: merging.autonomy, autoMerge: true }, 'exact-pin')) return { waits: 'level' };
  if (!merging.autoMerge) return { waits: 'auto-merge' };
  return undefined;
}

/**
 * Whether the review gate has yet to judge a deploy pull request's head, so the line waits for it rather than hand the
 * pull request to Martin: its `review` check on the head is running, or concluded with a hold it marked `pending`, less
 * than `PENDING_LIMIT_MS` ago, as for a fix (`merging.ts`). The gate's checks are not among those `judge` waits for, so
 * the others can pass before it posts. With no check at all on the head, there is nothing to wait for: it is Martin's.
 */
export function gateJudging(
  verdict: Pick<ReviewVerdict, 'head' | 'check' | 'judged'>,
  head: string,
  now: Date,
): boolean {
  const { check, judged } = verdict;
  if (verdict.head !== head || !check) return false;
  if (check.status !== 'completed') return true;
  if (judged?.pending === undefined || check.completedAt === null) return false;
  return now.getTime() - Date.parse(check.completedAt) < PENDING_LIMIT_MS;
}

/**
 * The latest record of a work item's deploy pull request under the hold in force (`hold`, the payload the line's
 * `fold` took): the last `deploy.changed` since that hold's `hold.started`. A hold that starts again (after a rollback,
 * say) waits for a deploy of its own; a `hold.started` the fold passed over (one a release in flight already answered)
 * starts nothing.
 */
export function latestDeploy(
  events: readonly { type: string; payload: unknown }[],
  hold: unknown,
): DeployChange | undefined {
  let latest: DeployChange | undefined;
  for (const { type, payload } of events) {
    if (type === 'hold.started' && payload === hold) latest = undefined;
    if (type === 'deploy.changed') latest = payload as DeployChange;
  }
  return latest;
}

/**
 * Whether a deploy pull request, as recorded, waits for Martin: its checks passed and the line did not add it to the
 * queue, or the queue took it out. Queued, it waits for the queue.
 */
export const waitsForMartin = (change: DeployChange | undefined): boolean =>
  change?.state === 'passed' || change?.state === 'dequeued';

/** Whether a deploy pull request's record has ended: merged or closed, it changes no more. */
export const settled = (change: DeployChange | undefined) => change?.state === 'merged' || change?.state === 'closed';

const sameChange = (a: DeployChange | undefined, b: DeployChange) =>
  a !== undefined &&
  a.pullRequest === b.pullRequest &&
  a.commit === b.commit &&
  a.state === b.state &&
  (a.failed ?? []).join('\n') === (b.failed ?? []).join('\n') &&
  a.waits === b.waits &&
  a.rule === b.rule &&
  a.position === b.position &&
  a.reason === b.reason &&
  a.said === b.said;

/** The checks that failed, in a few words: "e2e", "e2e and 2 more". */
const failedWords = (failed: readonly string[] | undefined) =>
  `${failed?.[0] ?? 'a check'}${(failed?.length ?? 0) > 1 ? ` and ${(failed?.length ?? 0) - 1} more` : ''}`;

/** Why a deploy pull request whose checks passed waits for Martin, as its event's summary ends. */
function waitWords({ waits, rule }: DeployChange): string {
  switch (waits) {
    case undefined:
      return 'it waits for Martin to merge it';
    case 'verdict':
      return `the review gate did not pass it as an exact pin${rule ? ` (${rule})` : ''}, so the line does not add it to the merge queue: it waits for Martin to merge it`;
    case 'level':
      return 'at Supervised the line adds nothing to the merge queue: it waits for Martin to merge it';
    case 'auto-merge':
      return 'with auto-merge off it waits for Martin to merge it';
    case 'conflict':
      return 'it conflicts with main: it waits for Martin';
    case 'refused':
      return 'it was not added to the merge queue: it waits for Martin to merge it';
  }
}

/** A deploy pull request's change, as its event's summary says it. */
export function deployLine(change: DeployChange): string {
  const { pullRequest, state, failed, reason } = change;
  const pr = `Deploy pull request #${pullRequest}`;
  switch (state) {
    case 'checking':
      return `${pr} carries it; its checks are running`;
    case 'passed':
      return `${pr} carries it, and its checks passed: ${waitWords(change)}`;
    case 'failed':
      return `${pr} carries it, and ${failedWords(failed)} failed on it`;
    case 'queued':
      return `${pr} carries it, and the line added it to the merge queue, as the review gate passed it as an exact pin`;
    case 'dequeued':
      return `${pr} carries it, and the merge queue took it out (${reason})${failed ? `: ${failedWords(failed)} failed` : ''}. It waits for Martin`;
    case 'merged':
      return `${pr}, which carries it, merged: its release starts once Argo CD syncs`;
    case 'closed':
      return `${pr} was closed unmerged: the next build’s carries it`;
  }
}

/** A work item held for a deploy, and its record under that hold. */
export interface HeldForDeploy {
  workItem: string;
  recorded: DeployChange | undefined;
}

export interface DeployContext {
  github: GitHubPort;
  repo: string;
  log: Logger;
  append: (workItem: string, drafts: Draft[]) => Promise<void>;
  /**
   * Martin's autonomy level and auto-merge switch, as the line read them this pass, when it may add the deploy pull
   * request to the merge queue: the app's alone. Without them it adds nothing, and records none of why.
   */
  merging?: Pick<Controls, 'autonomy' | 'autoMerge'>;
  /**
   * Whether the line may add it this pass: not when it acts on one work item and the pull request carries another. What
   * it did at the head already is still followed, so the queue's word is recorded and a head is never added twice.
   */
  mayEnqueue?: boolean;
  now?: () => Date;
}

/**
 * What the line did already about the merge queue at a deploy pull request's head, as any held work item's record says:
 * added it, saw the queue take it out, or was refused. It stands until the head moves, whatever its checks say since,
 * so the line adds a head to the queue once.
 */
const doneAt = (records: readonly (DeployChange | undefined)[], { pullRequest, commit }: DeployChange) =>
  records.find(
    (r) =>
      r?.pullRequest === pullRequest &&
      r.commit === commit &&
      (r.state === 'queued' || r.state === 'dequeued' || r.waits === 'refused'),
  );

/**
 * What the line does with the open deploy pull request whose checks passed at a head (`base`): adds it to the merge
 * queue, or says why it waits for Martin; and once it has added it, whether the queue still has it or took it out.
 * `records` are the held work items' records, any of which may say what the line did at this head already; `by` is the
 * work item the action is for. Null when nothing is to be recorded this pass: the pull request moved, or the queue
 * could not be read.
 */
async function queueDeploy(
  o: DeployContext & { merging: Pick<Controls, 'autonomy' | 'autoMerge'> },
  base: DeployChange,
  records: readonly (DeployChange | undefined)[],
  by: string,
): Promise<DeployChange | null> {
  const { github, repo, log } = o;
  const { pullRequest: number, commit: head } = base;
  const done = doneAt(records, base);
  if (done?.state === 'queued') {
    const queue = await github.read('mergeQueue', repo, { number }).catch((error: unknown) => {
      // Unread, it stands as recorded, and what GitHub says of the pull request itself is still recorded below.
      log.warn({ number, err: error }, 'could not read the merge queue for the deploy pull request: asks again');
      return null;
    });
    // Merged, the read of the pull request says so; still queued, or moved on, there is nothing new. GitHub names a
    // removal only when it has not gone back in since, so one at this head is of the line's addition, or later.
    if (!queue || queue.head !== head || queue.state !== 'open' || queue.queued || !queue.removed) return done;
    const reason = cutAt((queue.removed.reason ?? 'unknown').toLowerCase(), 60);
    if (reason === 'merged') return done;
    // Each check's latest run on the queue's commit, as the gates read them: a re-run is not counted twice.
    const failed = [...latestRuns(queue.checks).values()]
      .filter((run) => run.status === 'completed' && outcomeOf(run.conclusion) === 'failure')
      .map((run) => cutAt(run.name, 80))
      .slice(0, 40);
    return { pullRequest: number, commit: head, state: 'dequeued', reason, ...(failed.length ? { failed } : {}) };
  }
  if (done) return done;
  const verdict = await github.read('reviewVerdict', repo, { number });
  // While the gate is still judging the head, nothing is the line's or Martin's yet: one of its checks still runs.
  if (gateJudging(verdict, head, (o.now ?? (() => new Date()))())) return { ...base, state: 'checking' };
  const wait = deployWait(verdict, head, o.merging);
  if (wait) return { ...base, ...wait };
  const mergeable = await github.read('mergeability', repo, { number });
  if (mergeable.head === head && mergeable.conflicts === true) return { ...base, waits: 'conflict' };
  const queued = (position: number | null | undefined): DeployChange => ({
    pullRequest: number,
    commit: head,
    state: 'queued',
    rule: 'exact-pin',
    ...(position ? { position } : {}),
  });
  try {
    const enqueued = await github.act('enqueuePullRequest', repo, { number, expectedHead: head }, { workItem: by });
    log.info({ number, head, workItem: by }, 'added the deploy pull request to the merge queue');
    return queued(enqueued.position);
  } catch (error) {
    if (!(error instanceof GitHubWorkerError) || ![403, 409, 422].includes(error.status)) throw error;
    if (error.status === 409) {
      log.info({ number, err: error }, 'the deploy pull request moved before it was queued: read again');
      return null;
    }
    if (error.status === 422) {
      // Already in the queue at that head: the line added it and stopped before recording it.
      const queue = await github.read('mergeQueue', repo, { number }).catch((read: unknown) => {
        log.warn(
          { number, err: read },
          'could not read whether GitHub already queued the deploy pull request: asks again',
        );
        return null;
      });
      if (!queue) return null;
      if (queue.queued && queue.head === head) return queued(queue.queued.position);
    }
    log.warn({ number, err: error }, 'the deploy pull request was not added to the merge queue: it waits for Martin');
    return { ...base, waits: 'refused', said: cutTo(error.message.trim() || `GitHub answered ${error.status}`, 300) };
  }
}

/**
 * Records where the deploy pull request stands for each work item held for a deploy: the proposal's, for each it
 * carries (`carried`, the work items its range carries); else the one recorded, while it has not merged or closed.
 * Each pull request is read once in a pass, and the proposal's added to the queue at most once. A work item whose reads
 * fail is tried again on the next pass.
 */
export async function recordDeploys(
  o: DeployContext,
  proposal: DeployProposal | null,
  carried: ReadonlySet<string>,
  held: readonly HeldForDeploy[],
): Promise<void> {
  const { github, repo, log } = o;
  // A dry run's deploy pull request is one GitHub never had: it carries nothing real.
  const open = proposal && proposal.number < DRY_RUN_NUMBERS_FROM ? proposal.number : undefined;
  const reads = new Map<number, Promise<DeployChange>>();
  let required: Promise<string[]> | undefined;
  const read = (number: number) => {
    let change = reads.get(number);
    if (!change) {
      change = (async () => {
        const pr = await github.read('pullRequest', repo, { number });
        // Only an open one's checks say anything: merged or closed, it has ended.
        if (pr.state !== 'open') return { pullRequest: number, commit: pr.head.sha, ...deployState(pr, [], []) };
        const runs = await github.read('checkRuns', repo, { sha: pr.head.sha });
        required ??= github.read('requiredChecks', repo, { branch: 'main' }).catch((error: unknown) => {
          // Read again by the next work item that needs it, not kept failed for the pass.
          required = undefined;
          throw error;
        });
        return { pullRequest: number, commit: pr.head.sha, ...deployState(pr, runs, await required) };
      })();
      // A read that failed is read again on the next pass, not kept.
      change.catch(() => reads.delete(number));
      reads.set(number, change);
    }
    return change;
  };
  // The open proposal as the line records it, once in a pass: what GitHub says of it and, once its checks passed, what
  // the line does about the merge queue, for the first held work item it carries.
  const by = held.find((h) => carried.has(h.workItem))?.workItem;
  let standing: Promise<DeployChange | null> | undefined;
  const stand = (number: number) => {
    standing ??= (async () => {
      const base = await read(number);
      const { merging } = o;
      const records = held.map((h) => h.recorded);
      if (!merging || by === undefined || settled(base)) return base;
      const done = doneAt(records, base);
      if (!done && (base.state !== 'passed' || o.mayEnqueue === false)) return base;
      return queueDeploy({ ...o, merging }, base, records, by);
    })();
    standing.catch(() => {
      standing = undefined;
    });
    return standing;
  };
  for (const { workItem, recorded } of held) {
    try {
      const drafts: Draft[] = [];
      let last = recorded;
      const record = (change: DeployChange | null) => {
        if (!change || sameChange(last, change)) return;
        drafts.push({ type: 'deploy.changed', actor: 'factory', summary: deployLine(change), payload: change });
        last = change;
      };
      // The pull request recorded, if it is not the open proposal's: merged or closed, as GitHub says, or still open.
      if (recorded && !settled(recorded) && recorded.pullRequest !== (carried.has(workItem) ? open : undefined)) {
        record(await read(recorded.pullRequest));
      }
      // Once the one that carries it merged, it waits for Argo CD: a newer build's, which still counts it from the
      // version the app runs, is not its deploy.
      if (open !== undefined && carried.has(workItem) && last?.state !== 'merged') record(await stand(open));
      if (drafts.length) {
        await o.append(workItem, drafts);
        log.info(
          { workItem, deploy: drafts.map((d) => (d.payload as DeployChange).pullRequest), state: last?.state },
          'recorded where the deploy pull request stands',
        );
      }
    } catch (error) {
      log.warn({ workItem, err: error }, 'could not read the deploy pull request that carries a held work item');
    }
  }
}
