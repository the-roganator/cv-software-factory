/**
 * The App's own pin pull requests in this repository, added to the merge queue by the worker itself (ADR 0027): the
 * local profile's deploy pin, and each of the pin watch's pull requests the gate passed as a move. The deploy watch (`deploys.ts`) opens and
 * moves the factory's own deploy pull request, which the review gate passes as an exact pin (`exact-pin`: every changed
 * line a digest under `deploy/`, each image signed by `build.yml` on main, from a commit ahead of the pin it replaces);
 * the pin watch (`pins.ts`) opens one pull request for the vulnerability scan's moves at each set of files, which the
 * gate passes as a move (`move`, or `major` for one across a major that clears no Critical) when it is exactly the
 * scan's moves, which the gate makes itself. These watches add each to the queue, so a pin the gate passed reaches `main` with nobody's hand
 * on it: the deploy pin at every autonomy level, as it runs only what Martin already merged, and a move only when the
 * level in force allows its rule and auto-merge is on (`enqueues`, `policy/line.ts`, read as `level.ts` reads them), as the line's are, and the line is not stopped. The app's deploy pull request is the line's, within
 * Martin's autonomy level and auto-merge (`line/deploy.ts`); a pull request the gate held, even one Martin then
 * approved, a release, and anything else, is his.
 *
 * Each pass reads the open pull requests it watches, and adds each to the queue at its head only when every one of
 * these holds; otherwise it waits, and says why once for each head:
 *
 * - **the positive check, first**: its head is the very commit its watch last wrote to its branch (`WatchedHeads`), or,
 *   after a restart, one the watch found already to be the commit it would write (`own-commit.ts`), so a branch
 *   moved by anyone, by any route, is not the watch's work and is not added; the watch writes its own again;
 * - **the deploy pin**: it is the App's (`APP_USER`), from this repository's deploy branch into main, not a draft, with
 *   the profile's label (`deploy: local`) and a title the deploy watch writes (`chore(deploy): run … on the local
 *   cluster`), and the gate's rule is `exact-pin`;
 * - **a pin move**: it is the App's, from this repository's `factory/pin/<files>` (the pin watch's branch, one segment,
 *   as `guardPinBranch` has it) into main, not a draft, labelled `pin` by the App and by nobody else, every time it was
 *   labelled, and none Martin holds on its branch, the gate's
 *   rule is `move` or `major`, and the autonomy level in force, read just before the enqueue, queues that rule
 *   with auto-merge on (Supervised, and off, when they cannot be read), and the line is not stopped (stopped, when
 *   that cannot be read): a stopped line queues as Supervised does. The gate trusts no branch, label or title; the queue reads
 *   them so that nothing but the pin watch's own pull request rides the rule, and the verdict is what passes it;
 * - the review App's own `review` check on that head concluded with a verdict that passes it by that rule at that head
 *   (`merging.ts`): no other rule, and never a hold, a pending one, Martin's approval, or one for another head;
 * - every other check main's rulesets require has a latest run on that head, by anyone but the factory's App, that
 *   finished and did not fail (a skipped one passes, as GitHub has it); one still running is waited for, and one that
 *   failed is run again (below), or waits for a newer build;
 * - GitHub says it does not conflict with main, and it is not in the queue already.
 *
 * The enqueue is the one the line uses (`enqueuePullRequest`): the issue guard asks whether the App opened it, the
 * queue's guard whether it is from a branch the factory owns at the head named, and GitHub takes it only at that head
 * (`expectedHeadOid`), so a push after the verdict cannot ride it. A failure that may pass (the head moved, a rate
 * limit, an outage, GitHub saying the request does not fit the state it found) is tried again on the next pass, up to
 * `MAX_TRIES`. A refusal, the guard's or GitHub's 403, is kept in the artifact store, signed and logged as the worker's
 * HTTP door keeps one (`refusalOf`, `refusals.ts`), with no worker asking to relay it; it, and any other failure,
 * leaves the head for Martin.
 *
 * The queue then merges it, or takes it out, which GitHub shows on the pull request. A head the queue took out because
 * a check failed on its commit is added again, on the next pass that finds all of the above still true: main's checks
 * can fail for a reason that is not the change's (a test that flakes, a runner that dies), and a pin that waits a day
 * for it is a day unpatched. The queue's run is the only test of the merged result, so the worker does not judge why
 * it failed: a change that breaks main fails every time, and after `QUEUE_TRIES` failures at one head, counted from
 * GitHub's record of the pull request so a restart does not start the count again, the worker stops and says so in a
 * comment on the pull request, naming the checks that failed last. That head is then Martin's; a new head, as when the
 * next scan moves the pin further, starts again. Any other removal the queue itself made (`queueOwn`, `merging.ts`:
 * a group ahead of it failed, the queue was cleared, GitHub found a conflict) goes in again the same way and counts
 * toward the same `QUEUE_TRIES`, so no move is stranded by a removal nobody chose and none loops; a head that
 * conflicts with main waits on the conflict first, as any does. A head a person took out stays out: by GitHub's own
 * record of the removal, who made it and its reason, so a worker that restarts does not add it either. Where GitHub
 * names nobody and gives a reason that is not the queue's, it counts as a person's. The worker says
 * so once in a comment on its own pull request, and a new head starts again. A removal is of the head when the pull
 * request last went into the queue after that head was committed (`MergeQueue.removed.atHead`): the queue dropping
 * a pull request because its branch moved is a removal of the head before, and holds nothing.
 *
 * A required check can fail on the head itself for the same reasons, before the queue sees it, and a hung job is
 * cancelled by its own time limit and fails. Once the gate passed the head and every required check there finished, a
 * failed one GitHub Actions ran is run again from a new head: the watch's commit written again (`commitAgain`), the
 * same tree on the same parent, with a `Checks-run:` line in its message, which GitHub runs every check and the gate on
 * afresh, and which is recorded as the watch's. The App starts no run itself. After `RUN_TRIES` runs, counted from
 * the head's own message so a restart does not start the count again, the worker says so once in a comment, naming
 * the checks that failed, and the head is Martin's; one he runs again and passes goes on. A failed check another app
 * posted is not run again.
 *
 * In a dry run the watches write nothing to GitHub and record no commit, so no head in GitHub is one a watch wrote: the
 * queues add nothing and record no enqueue. A dry run's own deploy and pin pull requests, which GitHub never had, are
 * not seen here: the dry run's reads merge its deploy on their own clock (`dry-run-reads.ts`).
 *
 * One pull request that is not the App's is queued the same way, in the app's repository (`workflowPinQueueWatch`):
 * Dependabot's bump of the commit the factory's own workflows are called at, which the App cannot write, having no
 * `workflows` permission. Dependabot writes it, the gate judges it, and the worker only adds it:
 *
 * - Dependabot opened it (`DEPENDABOT_USER`), from a `dependabot/github_actions/` branch of the repository into main,
 *   not a draft;
 * - the gate passed that head as `exact-pin`: every changed line a call of the factory's workflows, each moved from
 *   one commit to one later commit on the factory's main, and nothing else (`workflowPin`, scripts/review-routing.ts).
 *   No watch of the worker's wrote this head, so there is no positive check to make first: the gate's verdict at the
 *   very head, which the enqueue then names (`expectedHeadOid`), is the proof of what it is;
 * - the autonomy level in force, read just before the enqueue, queues an exact pin with auto-merge on (Guarded and
 *   Lights-out; Supervised, and off, when they cannot be read), and the line is not stopped: a new commit of the
 *   factory's workflows is new change to the app, as the local deploy pin is not;
 * - its checks, the conflict and the queue, as for the others. The worker writes nothing to Dependabot's branch and
 *   says nothing on its pull request, so a required check that failed on the head is not run again from a new head,
 *   and a head out of tries, or out of the queue for good, is said in the log alone: either waits for Martin, or for
 *   Dependabot's next rebase.
 *
 * In a dry run this watch does nothing: the pull request is one GitHub has, and a dry run adds nothing there.
 *
 * The pin and workflow pin queues say what they decide of each head for the read `pulls` (`pull-states.ts`): the gate's
 * rule there, its required checks with the try, whether it is in the queue, and why not (`PATCH_HOLDS`), each wait by
 * the same decision that holds it here.
 */
import type { Autonomy } from '@software-factory/events';
import type { Logger } from 'pino';
import { z } from 'zod';
import { ACTIONS_APP } from '../gates/counts.ts';
import { FACTORY_REPOSITORY } from '../repositories.ts';
import type { Actions } from './actions.ts';
import { APP_LOGIN, checksRunOf } from './actions.ts';
import {
  BranchRefused,
  DEPENDABOT_ACTIONS_PREFIX,
  dependabotActionsBranch,
  pinBranch,
  type WatchedHeads,
} from './branches.ts';
import { type GitHub, GitHubError } from './client.ts';
import { DEPLOYS, type DeployTarget, deployLabel, isDeployTitle } from './deploys.ts';
import { APP_USER, DEPENDABOT_USER, IssueRefused, WORKFLOW_PIN_REPOS } from './issues.ts';
import { type LevelReader, type Merging, mergingWait } from './level.ts';
import {
  failedChecks,
  listedReviews,
  type MergeQueue,
  queueOwn,
  REVIEW_CHECK,
  REVIEW_RUNS,
  type ReviewVerdict,
  reviewCheckOf,
  reviewRunsPath,
  verdictOf,
} from './merging.ts';
import { guardPinBranch } from './pin-guard.ts';
import { PIN_LABEL, PIN_REPOS, type PinScope } from './pins.ts';
import type { Watch } from './poller.ts';
import { checksAt, gateHold, type PullSource, type PullStates, type QueueSay, ruleAt } from './pull-states.ts';
import { type CheckRun, finished, outcomeOf, type Reads } from './reads.ts';
import type { RefusalRecorder } from './refusals.ts';
import { refusalOf } from './server.ts';

/** The repository whose deploy pull requests the worker queues: this one's, never the app's, which are the line's. */
export const QUEUES_DEPLOYS_IN = FACTORY_REPOSITORY;

/** The deploys the worker adds to the merge queue itself: this repository's local profile alone. */
export const QUEUED_DEPLOYS: readonly DeployTarget[] = DEPLOYS.filter(
  (target) => target.repo === QUEUES_DEPLOYS_IN && target.profile === 'local',
);

/** The factory's App as GitHub names it on its check runs: its runs never pass a deploy's checks. */
const FACTORY_APP = APP_LOGIN.replace(/\[bot\]$/, '');

const PULLS = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    draft: z.boolean().optional(),
    user: z.object({ id: z.number().int() }).nullable(),
    labels: z.array(z.object({ name: z.string() })),
    head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
    base: z.object({ ref: z.string() }),
  }),
);
/** A pull request as the queue reads it from GitHub's list: a deploy's or a pin move's. */
export type QueuePull = z.infer<typeof PULLS>[number];

/** Why a pull request is not added to the queue now, in a few words, or undefined when it may be. */
export type QueueWait =
  | { waits: 'not-a-deploy'; why: string }
  | { waits: 'not-a-pin'; why: string }
  | { waits: 'not-a-workflow-pin'; why: string }
  | { waits: 'verdict'; why: string }
  | { waits: 'checks'; why: string }
  | { waits: 'stopped'; why: string }
  | { waits: 'level'; why: string }
  | { waits: 'auto-merge'; why: string }
  | { waits: 'failed'; why: string }
  | { waits: 'conflict'; why: string };

/** Whether a pull request is the deploy watch's own for a target: the App's, from its branch into main, labelled. */
export function deployPullWait(target: DeployTarget, pull: QueuePull): QueueWait | undefined {
  const not = (why: string): QueueWait => ({ waits: 'not-a-deploy', why });
  if (pull.user?.id !== APP_USER) return not('the App did not open it');
  if (pull.head.repo?.full_name !== target.repo || pull.head.ref !== target.branch) {
    return not(`it is not from ${target.repo}'s ${target.branch}`);
  }
  if (pull.base.ref !== 'main') return not(`it is into ${pull.base.ref}, not main`);
  if (pull.draft) return not('it is a draft');
  if (!pull.labels.some((l) => l.name === deployLabel(target))) return not(`it has no ${deployLabel(target)} label`);
  if (!isDeployTitle(target, pull.title)) return not('its title is not a deploy of the profile');
  return undefined;
}

/**
 * Whether a pull request is the pin watch's own in a repository, by what GitHub's list shows of it: the App's, from
 * `factory/pin/<files>` of that repository into main, not a draft, labelled `pin`. Who labelled it is read apart
 * (`labelWait`), from its events.
 */
export function pinPullWait(repo: string, pull: QueuePull): QueueWait | undefined {
  const not = (why: string): QueueWait => ({ waits: 'not-a-pin', why });
  if (pull.user?.id !== APP_USER) return not('the App did not open it');
  if (pull.head.repo?.full_name !== repo) return not(`it is not from a branch of ${repo}`);
  try {
    guardPinBranch(pull.head.ref);
  } catch (error) {
    if (error instanceof BranchRefused) return not(`${pull.head.ref} is not a pin move's branch`);
    throw error;
  }
  if (pull.base.ref !== 'main') return not(`it is into ${pull.base.ref}, not main`);
  if (pull.draft) return not('it is a draft');
  if (!pull.labels.some((l) => l.name === PIN_LABEL)) return not(`it has no ${PIN_LABEL} label`);
  return undefined;
}

export { WORKFLOW_PIN_REPOS };

/**
 * Whether a pull request is one of Dependabot's the worker may queue in a repository, by what GitHub's list shows of
 * it: Dependabot's, from one of its GitHub Actions branches of that repository into main, not a draft. That it moves
 * the factory's workflows' commit and nothing else is not read here: it is the gate's verdict (`exact-pin`).
 */
export function workflowPinPullWait(repo: string, pull: QueuePull): QueueWait | undefined {
  const not = (why: string): QueueWait => ({ waits: 'not-a-workflow-pin', why });
  if (pull.user?.id !== DEPENDABOT_USER) return not('Dependabot did not open it');
  if (pull.head.repo?.full_name !== repo) return not(`it is not from a branch of ${repo}`);
  if (!dependabotActionsBranch(pull.head.ref))
    return not(`${pull.head.ref} is not one of Dependabot's branches under ${DEPENDABOT_ACTIONS_PREFIX}`);
  if (pull.base.ref !== 'main') return not(`it is into ${pull.base.ref}, not main`);
  if (pull.draft) return not('it is a draft');
  return undefined;
}

const LABEL_EVENTS = z.array(
  z.object({
    event: z.string(),
    actor: z.object({ id: z.number().int() }).nullable(),
    label: z.object({ name: z.string() }).optional(),
    created_at: z.string().optional(),
  }),
);
export type LabelEvents = z.infer<typeof LABEL_EVENTS>;

/** How many pages of a pull request's events are read before it is held as one that cannot be read whole. */
const EVENT_PAGES = 5;

/**
 * Whether only the App ever gave a pull request the `pin` label or took it off, by its events: given at least once,
 * and never by anyone else, so a label someone else put back after the App's was taken off is no pin's; and never
 * taken off by anyone else, so Martin holds a pin move by taking its label off, though the pin watch puts it back; and
 * never reopened by the App. A pull request whose events run past `EVENT_PAGES` pages is not read whole, and waits.
 */
export function labelWait(events: LabelEvents, whole: boolean): QueueWait | undefined {
  const not = (why: string): QueueWait => ({ waits: 'not-a-pin', why });
  if (!whole) return not('its events run past what is read');
  const labelled = events.filter((e) => e.event === 'labeled' && e.label?.name === PIN_LABEL);
  if (!labelled.length) return not(`nobody labelled it ${PIN_LABEL}`);
  if (labelled.some((e) => e.actor?.id !== APP_USER)) return not(`someone but the App labelled it ${PIN_LABEL}`);
  if (heldByLabel(events)) return not(`someone but the App took its ${PIN_LABEL} label off`);
  // The pin watch never reopens a pull request: one the App reopened was closed, by Martin or the watch, and opened
  // again by a worker that asked, so it is not the watch's to queue.
  if (events.some((e) => e.event === 'reopened' && e.actor?.id === APP_USER)) return not('the App reopened it');
  return undefined;
}

/**
 * The gate's rules a pull request the worker queues may pass by: a deploy pin's (`exact-pin`), and a move's (`move`, or
 * `major` for one that crosses a major and clears no Critical), which the level then decides (`ENQUEUES`).
 */
export type QueueRule = 'exact-pin' | 'move' | 'major';

/** The rules a pin move may pass by: which of them the worker queues is the level's (`levelWait`). */
export const MOVE_RULES: readonly QueueRule[] = ['move', 'major'];

/** Whether the gate passed a head by one of the rules: its own verdict on that head, by one of them, and not pending. */
export function verdictWait(
  verdict: Pick<ReviewVerdict, 'head' | 'judged' | 'problem'>,
  head: string,
  rules: readonly QueueRule[],
): QueueWait | undefined {
  const { judged } = verdict;
  if (verdict.head !== head || judged?.head !== head) {
    return { waits: 'verdict', why: verdict.problem ?? 'the gate has not judged this head' };
  }
  if (judged.pending !== undefined) return { waits: 'verdict', why: `the gate waits: ${judged.pending}` };
  if (!(rules as readonly string[]).includes(judged.rule)) {
    return { waits: 'verdict', why: `the gate's rule is ${judged.rule}, not ${rules.join(' or ')}` };
  }
  return undefined;
}

const LEVEL_NAME: Record<Autonomy, string> = {
  supervised: 'Supervised',
  guarded: 'Guarded',
  'lights-out': 'Lights-out',
};

/**
 * Whether the line's stop, the autonomy level and auto-merge in force let the worker queue a pull request the gate
 * passed by a rule (`enqueues`, as the line asks it): the stop's wait first, then the level's, then the switch's.
 */
export function levelWait(merging: Merging, rule: QueueRule): QueueWait | undefined {
  const waits = mergingWait(merging, rule);
  const a = /^[aeiou]/.test(rule) ? 'an' : 'a';
  if (waits === 'stopped') return { waits, why: `the line is stopped, so ${a} ${rule} waits for Martin` };
  if (waits === 'level') return { waits, why: `at ${LEVEL_NAME[merging.autonomy]} ${a} ${rule} waits for Martin` };
  if (waits === 'auto-merge') return { waits, why: `with auto-merge off ${a} ${rule} waits for Martin` };
  return undefined;
}

/**
 * How the checks main requires stand on a head, by each one's latest run there: the review gate's is read as its
 * verdict, not here, and the factory's App's own runs count for nothing.
 */
export function checksWait(runs: readonly CheckRun[], required: readonly string[]): QueueWait | undefined {
  // No required check read is no check passed: a ruleset that could not be read, or moved, queues nothing.
  if (!required.length) return { waits: 'checks', why: "main's rulesets name no required check" };
  const latest = latestRequired(runs, required);
  const failed = latest.filter(failedRun).map((run) => run.name);
  if (failed.length) return { waits: 'failed', why: `failed: ${failed.join(', ')}` };
  const names = required.filter((name) => name !== REVIEW_CHECK);
  const running = names.filter((name) => {
    const run = latest.find((each) => each.name === name);
    return !run || !finished(run);
  });
  if (running.length) return { waits: 'checks', why: `waiting for ${running.join(', ')}` };
  return undefined;
}

/** The latest run of each check main requires but the gate's, as `checksWait` reads them: the App's own count for nothing. */
function latestRequired(runs: readonly CheckRun[], required: readonly string[]): CheckRun[] {
  const latest = new Map<string, CheckRun>();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) if (run.app !== FACTORY_APP) latest.set(run.name, run);
  return required.flatMap((name) => (name === REVIEW_CHECK ? [] : (latest.get(name) ?? [])));
}

const failedRun = (run: CheckRun): boolean => finished(run) && outcomeOf(run.conclusion) === 'failure';

/** How often a head is tried after a failure that may pass, before it is left for Martin. */
export const MAX_TRIES = 5;

/**
 * How often one head goes into the merge queue before the worker stops adding it: each time but the last, the queue
 * having taken it out itself, for a failed check or another reason of its own (`queueOwn`). Three, so one flake, or two, costs a pin minutes and not a day, and a move
 * that breaks main costs three runs of main's checks and no more.
 */
export const QUEUE_TRIES = 3;

/** The checks that failed on the queue's commit, by name. */
const failedOnQueue = (queue: Pick<MergeQueue, 'checks'>): string[] =>
  queue.checks.filter((run) => finished(run) && outcomeOf(run.conclusion) === 'failure').map((run) => run.name);

/**
 * What the worker, or the line for its own pull request, says on a pull request whose head the queue took out
 * `QUEUE_TRIES` times, with the checks that failed the last time: for failed checks each time, unless `reason` gives
 * the last removal's, when it was another of the queue's own.
 */
export function spentComment(head: string, failed: readonly string[], reason?: string | null): string {
  const last = failed.length
    ? ` The last time, ${[...new Set(failed)].map((name) => `\`${name}\``).join(', ')} failed.`
    : '';
  const why =
    reason === undefined || failedChecks(reason)
      ? "each time because a required check failed on the queue's commit."
      : `each time by the queue itself and nobody's hand (GitHub's reason the last time: \`${word(reason).toLowerCase()}\`).`;
  return (
    `The merge queue has taken this pull request out ${QUEUE_TRIES} times at ${head.slice(0, 7)}, ` +
    `${why}${last} The factory adds this head no more: it is Martin's ` +
    'to add to the queue again or close. A new head starts again.\n\n' +
    `<!-- factory: out of tries ${head} -->`
  );
}

/** The mark of the comment that says a head is out of tries, by the head it names. */
const SPENT_MARK = /<!-- factory: out of tries ([0-9a-f]{40}) -->/;

/** A removal's reason or actor as a comment says it: GitHub's own word, and nothing that could end the comment. */
const word = (text: string | null) => (text ?? '').replace(/[^A-Za-z0-9_ [\]-]/g, '').slice(0, 60) || 'unknown';

/**
 * What the worker says on its own pull request whose head a person took out of the merge queue (or nobody GitHub
 * names, for no reason of the queue's): who took it out and GitHub's reason, and that the head stays out.
 */
export function removedComment(head: string, removed: { by: string | null; reason: string | null }): string {
  return (
    `This pull request left the merge queue at ${head.slice(0, 7)}, taken out by \`${word(removed.by)}\` ` +
    `(GitHub's reason: \`${word(removed.reason).toLowerCase()}\`). The factory adds a head again only when the queue ` +
    "itself took it out, so it adds this head no more: it is Martin's to add to the queue again or " +
    'close. A new head starts again.\n\n' +
    `<!-- factory: out of the queue ${head} -->`
  );
}

/** The mark of the comment that says a head left the queue for good, by the head it names. */
const REMOVED_MARK = /<!-- factory: out of the queue ([0-9a-f]{40}) -->/;

/**
 * How many runs of its checks one commit of a watch's gets, its first and each time it is written again
 * (`commitAgain`), before the queue stops writing it again: a required check that failed or hung on the App's own move
 * (a hung job is cancelled by its own time limit, and fails) may be a flake, as in the queue (`QUEUE_TRIES`), and a
 * move left red waits for its branch's next write, the next day's scan. Counted from the head's own message (its
 * `Checks-run:` line, `checksRunOf`), so a restart does not start the count again.
 */
export const RUN_TRIES = 3;

/** What the worker says on a pull request whose required checks failed on the `RUN_TRIES`th run of them. */
export function spentRunsComment(head: string, failed: readonly string[]): string {
  return (
    `A required check failed on this pull request in ${RUN_TRIES} runs, the factory writing its commit again for ` +
    `each: ${failed.map((name) => `\`${name}\``).join(', ')} failed the last time, at ${head.slice(0, 7)}. The ` +
    "factory writes it again no more: it is Martin's to run the checks again or close.\n\n" +
    `<!-- factory: checks out of tries ${head} -->`
  );
}

/** The mark of the comment that says a head's checks are out of tries, by the head it names. */
const SPENT_RUNS_MARK = /<!-- factory: checks out of tries ([0-9a-f]{40}) -->/;

/** How many pages of a hundred comments are read of a pull request for the App's own. */
const COMMENT_PAGES = 10;

/**
 * Whether the App has already said on the pull request what a mark says of this head, by the mark its own comment
 * carries (the App's by its id, `APP_USER`): read from GitHub, so a worker that restarts says it no more than once,
 * whichever checks failed last when it reads. Every page, oldest first, up to `COMMENT_PAGES`; past them it is taken
 * as not said, since anyone may comment on a public repository: the App says it, perhaps again, and the head is left
 * for Martin, where a read that failed would have the queue try the head for ever.
 */
async function spentSaid(github: GitHub, repo: string, number: number, head: string, mark = SPENT_MARK) {
  for (let page = 1; page <= COMMENT_PAGES; page++) {
    const comments = await github.read(
      repo,
      `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
      z.array(z.object({ body: z.string().nullable(), user: z.object({ id: z.number().int() }).nullable() })),
    );
    if (comments.some((made) => made.user?.id === APP_USER && mark.exec(made.body ?? '')?.[1] === head)) return true;
    if (comments.length < 100) return false;
  }
  return false;
}

/** A commit's message, as git's data API gives it. */
const MESSAGE = z.object({ message: z.string() });

/**
 * What the queues do with a head of the App's own move, which the gate passed, whose required checks failed: once
 * every required check there has finished, the watch's commit is written again (`commitAgain`: the same tree on the
 * same parent, its `Checks-run:` line one more), so GitHub runs every check, and the gate, on a new head, which is
 * recorded as the watch's. At `RUN_TRIES` it says so once on the pull request and leaves the head red for Martin. A
 * failed check another app posted is not GitHub Actions' to run again, and is left as it is. Each case waits, and says
 * why once, as every wait does.
 */
async function writeAgain(
  deps: DeployQueueDependencies,
  state: ReturnType<typeof queueState>,
  repo: string,
  kind: string,
  pull: QueuePull,
  attempt: Attempt,
  latest: readonly CheckRun[],
  wait: QueueWait,
): Promise<void> {
  const { github, actions, heads, log } = deps;
  const { number } = pull;
  const head = pull.head.sha;
  const failed = latest.filter(failedRun);
  if (!actions.commitAgain || !heads.set || attempt.ranOut || failed.some((run) => run.app !== ACTIONS_APP)) {
    state.note(number, head, { hold: 'checks-spent' });
    return state.wait(number, head, wait);
  }
  // Each case below runs the checks again, but where it says they are out of tries.
  state.note(number, head, { hold: 'checks' });
  const going = latest.filter((run) => !finished(run)).map((run) => run.name);
  if (going.length)
    return state.wait(number, head, { waits: 'checks', why: `${wait.why}; waiting for ${going.join(', ')}` });
  const names = failed.map((run) => run.name);
  const { body: commit } = await github.poll(repo, `/repos/${repo}/git/commits/${head}`, MESSAGE);
  const run = checksRunOf(commit.message);
  if (run >= RUN_TRIES) {
    // Said before the head is left, so a comment that could not be made is tried on the next pass: made once, across
    // restarts. A check Martin runs again and passes lets the head on, as any green check does.
    if (actions.comment && !(await spentSaid(github, repo, number, head, SPENT_RUNS_MARK)))
      await actions.comment(repo, number, spentRunsComment(head, names));
    attempt.ranOut = true;
    state.note(number, head, { hold: 'checks-spent' });
    log.warn(
      { repo, number, head, checks: names },
      `the ${kind} pull request's checks failed in ${RUN_TRIES} runs: it waits for Martin`,
    );
    return state.wait(number, head, wait);
  }
  let again: string;
  try {
    again = await actions.commitAgain(repo, pull.head.ref, head, run + 1);
  } catch (error) {
    if (error instanceof GitHubError && PASSING.includes(error.kind) && ++attempt.failures < MAX_TRIES) {
      log.info({ repo, number, head, err: error }, `the ${kind} pull request's head was not written again yet`);
      return;
    }
    // Refused, or a failure that will not pass: the head is Martin's, and says why in the log.
    attempt.ranOut = true;
    state.note(number, head, { hold: 'checks-spent' });
    log.warn(
      { repo, number, head, err: error },
      `the ${kind} pull request's head was not written again: it waits for Martin`,
    );
    return;
  }
  heads.set(repo, pull.head.ref, again);
  attempt.done = true;
  log.info(
    { repo, number, head, commit: again, run: run + 1, checks: names },
    `wrote the ${kind} pull request's head again, so its checks run again`,
  );
}

/** The failures that may pass: a 409, or a GraphQL error that does not fit the state now; a limit; an outage. */
const PASSING: readonly string[] = ['conflict', 'rate-limited', 'server', 'network'];

export interface DeployQueueDependencies {
  github: GitHub;
  reads: Pick<Reads, 'checkRuns' | 'requiredChecks' | 'reviewVerdict' | 'mergeability' | 'mergeQueue'>;
  /**
   * The enqueue, the comment that says a head is out of tries, and the watch's commit written again for a failed check
   * at a head: without `comment` that is only logged, and without `commitAgain` a failed check waits for Martin.
   */
  actions: Pick<Actions, 'enqueuePullRequest'> & Partial<Pick<Actions, 'comment' | 'commitAgain'>>;
  /** What keeps, logs and signs a refusal; without it, a refusal is only logged. */
  recorder?: RefusalRecorder | undefined;
  /**
   * The commit each watch last wrote to its branch (`WatchedHeads`): a pull request is added only at that commit, the
   * watch's own work for its move or build, however its branch got anywhere else. A commit the queue writes again for
   * a failed check is recorded there as the watch's (`set`); without `set`, none is written.
   */
  heads: Pick<WatchedHeads, 'get'> & Partial<Pick<WatchedHeads, 'set'>>;
  /** Where the pin and workflow pin queues say what they decided of each pull request, for the read `pulls`. */
  pulls?: PullStates | undefined;
  log: Logger;
}

/** The pin queue's: the queue's, and the line's stop, the level and auto-merge in force, which decide which moves it adds (`level.ts`). */
export interface PinQueueDependencies extends DeployQueueDependencies {
  level: LevelReader;
}

/**
 * The workflow pin queue's: what it reads, the enqueue and nothing else it could do to Dependabot's pull request, and
 * the level and auto-merge in force. It keeps no record of heads: no watch of the worker's writes Dependabot's branch.
 */
export interface WorkflowPinQueueDependencies {
  github: GitHub;
  /**
   * The checks, the conflict and the queue. The gate's verdict the watch reads itself, from the review App's check on
   * the head GitHub lists (`merging.ts`): `reviewVerdict` keeps and signs the gate's hold as a refusal of a merge the
   * factory asked for, and of Dependabot's pull request, most of which the gate holds for Martin, it asked for none.
   */
  reads: Omit<DeployQueueDependencies['reads'], 'reviewVerdict'>;
  /** The enqueue; in a dry run (`dryRun`), the watch asks for none. */
  actions: Pick<Actions, 'enqueuePullRequest' | 'dryRun'>;
  recorder?: RefusalRecorder | undefined;
  level: LevelReader;
  pulls?: PullStates | undefined;
  log: Logger;
}

/**
 * Whether a pull request's head is the commit its watch wrote to its branch: the positive check every queue makes
 * before it reads anything more. A head at any other commit, whoever put it there, is not the watch's.
 */
export function headWait(
  heads: Pick<WatchedHeads, 'get'>,
  repo: string,
  pull: QueuePull,
  waits: 'not-a-deploy' | 'not-a-pin',
): QueueWait | undefined {
  if (heads.get(repo, pull.head.ref) === pull.head.sha) return undefined;
  return { waits, why: `its head is not the commit the watch wrote to ${pull.head.ref}` };
}

/** A head the queue last tried to add, and how often a failure that may pass was met there. */
interface Attempt {
  at: string;
  failures: number;
  /** Once this worker added it, or found it in the queue: out of the queue with no removal of the queue's own read, it is not added again. */
  queued: boolean;
  /** Once it is refused, out of tries, or out of the queue for good. */
  done: boolean;
  /** Once the pull request says its checks are out of runs at this head (`RUN_TRIES`): nothing runs them again. */
  ranOut: boolean;
}

/**
 * What one watch keeps of the pull requests it queues, each by number: the head it last tried and what it last said of
 * it, so it tries each head once and says each wait once. Only the current head of each is kept. A watch of moves
 * (`source`) also says what it decided of each head, for the read `pulls` (`note`).
 */
function queueState(deps: DeployQueueDependencies, repo: string, kind: string, source?: PullSource) {
  const { log } = deps;
  const tried = new Map<number, Attempt>();
  const said = new Map<number, string>();
  const pulls = source ? deps.pulls : undefined;
  return {
    /** Whether what the queue decides is said for the read `pulls`. */
    noting: pulls !== undefined,
    /** What the queue decided of a head: in place of what it said there before when `replace`, else added to it. */
    note(number: number, head: string, say: QueueSay, replace = false) {
      pulls?.say(repo, number, head, say, replace);
    },
    /** The pass made, with the pull requests it read as open. */
    passed(open: ReadonlySet<number>) {
      if (source === 'pin-queue' || source === 'workflow-queue') pulls?.passedQueue(repo, source, open);
    },
    attempt(number: number, head: string): Attempt {
      const at = `${number} ${head}`;
      const kept = tried.get(number);
      if (kept?.at === at) return kept;
      const attempt = { at, failures: 0, queued: false, done: false, ranOut: false };
      tried.set(number, attempt);
      return attempt;
    },
    wait(number: number, head: string, w: QueueWait) {
      const key = `${head} ${w.waits} ${w.why}`;
      if (said.get(number) === key) return;
      said.set(number, key);
      log.info({ repo, number, head, waits: w.waits, why: w.why }, `the ${kind} pull request waits to be queued`);
    },
    /** Forgets the pull requests no longer open, so a long-lived worker keeps nothing of them. */
    keep(open: ReadonlySet<number>) {
      for (const number of tried.keys()) if (!open.has(number)) tried.delete(number);
      for (const number of said.keys()) if (!open.has(number)) said.delete(number);
    },
  };
}

/**
 * Adds one pull request, already known to be one of its kind the worker queues, to the queue at its head once the gate
 * passed that head by the rule and its checks are green; otherwise says why it waits. `confirm`, when given, is read
 * last, once all else passes and just before the enqueue, as it costs more and should be fresh: a wait it gives is
 * said as the others are. `level`, when given, is asked whether it queues the rule. `theirs`, for a head the worker
 * did not write and never writes, is what a required check that failed there waits for, in place of the head written
 * again.
 */
async function queueOne(
  deps: DeployQueueDependencies,
  state: ReturnType<typeof queueState>,
  repo: string,
  kind: string,
  pull: QueuePull,
  rules: readonly QueueRule[],
  attempt: Attempt,
  {
    confirm,
    level,
    theirs,
  }: { confirm?: () => Promise<QueueWait | undefined>; level?: LevelReader; theirs?: string } = {},
): Promise<void> {
  const { github, reads, actions, recorder, log } = deps;
  const { number } = pull;
  const head = pull.head.sha;
  // Each a conditional request, read together: one that has not changed costs nothing against the rate limit.
  const [verdict, runs, required, mergeable] = await Promise.all([
    reads.reviewVerdict(repo, number),
    reads.checkRuns(repo, head),
    reads.requiredChecks(repo, 'main'),
    reads.mergeability(repo, number),
  ]);
  if (state.noting) {
    // What the head is, said afresh each pass: the gate's rule there, and its checks, of the tries the worker gives.
    const judged = ruleAt(verdict, head);
    const names = required.filter((name) => name !== REVIEW_CHECK);
    const of = theirs === undefined && actions.commitAgain ? RUN_TRIES : 1;
    const checks = await checksAt(github, repo, head, latestRequired(runs, required), names, of);
    state.note(number, head, { ...(judged ? { rule: judged } : {}), ...(names.length ? { checks } : {}) }, true);
  }
  const gate = verdictWait(verdict, head, rules);
  if (gate) {
    if (state.noting)
      state.note(number, head, { hold: await gateHold(github, repo, number, verdict, head, theirs !== undefined) });
    return state.wait(number, head, gate);
  }
  // The rule it passed by, one of `rules`: the verdict was read for this head.
  const rule = verdict.judged?.rule as QueueRule;
  const checks = checksWait(runs, required);
  if (checks?.waits === 'failed') {
    if (theirs !== undefined) {
      state.note(number, head, { hold: 'checks-spent' });
      return state.wait(number, head, { waits: 'failed', why: `${checks.why}: ${theirs}` });
    }
    return writeAgain(deps, state, repo, kind, pull, attempt, latestRequired(runs, required), checks);
  }
  if (checks) {
    state.note(number, head, { hold: 'checks' });
    return state.wait(number, head, checks);
  }
  if (mergeable.head !== head || mergeable.conflicts !== false) {
    const why = mergeable.conflicts ? 'it conflicts with main' : 'GitHub has not said whether it conflicts';
    // GitHub not having said yet is no conflict: it says on a later pass.
    if (mergeable.conflicts) state.note(number, head, { hold: 'conflict' });
    return state.wait(number, head, { waits: 'conflict', why });
  }
  const queue = await reads.mergeQueue(repo, number);
  if (queue.head === head && queue.queued) {
    attempt.queued = true;
    state.note(number, head, { queued: true });
    return;
  }
  // Out of the queue, or never in it. Taken out by the queue itself (a failed check, a group ahead that failed, a
  // stack below it that changed, a conflict that has since gone: `queueOwn`), it goes in again, up to `QUEUE_TRIES`
  // times.
  const out = queue.head === head ? queue.removed : null;
  const failed = out !== null && queueOwn(out);
  if (failed && out.failures >= QUEUE_TRIES) {
    // Said before the head is left, so a comment that could not be made is tried on the next pass, and only when the
    // pull request does not say it already: it is made once, across restarts.
    if (actions.comment && !(await spentSaid(github, repo, number, head)))
      await actions.comment(repo, number, spentComment(head, failedOnQueue(queue), out.reason));
    attempt.done = true;
    state.note(number, head, { hold: 'queue-spent' });
    log.warn(
      { repo, number, head, failures: out.failures, reason: out.reason },
      `the merge queue took the ${kind} pull request out itself ${QUEUE_TRIES} times: it waits for Martin`,
    );
    return;
  }
  // Taken out at this head by a person, by GitHub's record of it (or by nobody it names, for no reason of the
  // queue's), it stays out, as a restart reads the same record. Said before the head is left, once across restarts,
  // as above.
  if (out?.atHead && !failed) {
    if (actions.comment && !(await spentSaid(github, repo, number, head, REMOVED_MARK)))
      await actions.comment(repo, number, removedComment(head, out));
    attempt.done = true;
    state.note(number, head, { hold: 'dequeued' });
    log.warn(
      { repo, number, head, reason: out.reason, by: out.by },
      `someone took the ${kind} pull request out of the merge queue: it waits for Martin`,
    );
    return;
  }
  // Added by this worker and gone from the queue with no removal of the queue's own read: not added again.
  if (attempt.queued && !failed) {
    attempt.done = true;
    return;
  }
  // The line's stop, the level and auto-merge, read now, just before the enqueue, so what Martin changed holds from
  // this pass: none read is stopped, at Supervised, with auto-merge off (`level.ts`).
  if (level) {
    const allowed = levelWait(await level(), rule);
    if (allowed) {
      if (allowed.waits === 'stopped' || allowed.waits === 'level') state.note(number, head, { hold: allowed.waits });
      return state.wait(number, head, allowed);
    }
  }
  // Read the last thing before the enqueue, so what it confirms (who labelled a pin move) is as fresh as it can be:
  // GitHub's enqueue takes no condition on a label: a label taken off in the one request between is not seen, and
  // nothing takes a pull request out of the queue once it is in. Martin takes it out by hand.
  const confirmed = await confirm?.();
  if (confirmed) {
    // What is confirmed last is who labelled a pin move: a label someone else took off, now or on an earlier pull
    // request of the move, or events that cannot be read whole, which hold as a label taken off.
    state.note(number, head, { hold: 'label' });
    return state.wait(number, head, confirmed);
  }

  try {
    const entry = await actions.enqueuePullRequest(repo, number, head);
    attempt.queued = true;
    state.note(number, head, { queued: true });
    log.info(
      { repo, number, head, rule, position: entry.position, ...(failed ? { again: out.failures } : {}) },
      `added the ${kind} pull request to the merge queue`,
    );
  } catch (error) {
    if (error instanceof GitHubError && PASSING.includes(error.kind) && ++attempt.failures < MAX_TRIES) {
      log.info({ repo, number, head, err: error }, `the ${kind} pull request was not queued yet: tries again`);
      return;
    }
    attempt.done = true;
    state.note(number, head, { hold: 'martin' });
    // The guard's refusal of an issue the App did not open is kept by the guard; a branch's, a deploy's or GitHub's
    // 403 is kept here, as the worker's door keeps one.
    const refusal =
      error instanceof IssueRefused ? undefined : refusalOf(error, 'enqueuePullRequest', repo, { number });
    if (refusal && recorder) {
      await recorder.record(refusal).catch((kept: unknown) => {
        log.error({ repo, number, err: kept }, 'could not keep a refusal');
      });
    }
    log.warn(
      { repo, number, head, err: error, refused: refusal !== undefined || error instanceof IssueRefused },
      `the ${kind} pull request was not added to the merge queue: it waits for Martin`,
    );
  }
}

/** Watches one deploy's open pull request, and adds it to the merge queue once the gate and its checks pass it. */
export function deployQueueWatch(deps: DeployQueueDependencies, target: DeployTarget): Watch {
  const { github } = deps;
  const { repo } = target;
  if (!QUEUED_DEPLOYS.includes(target)) throw new Error(`The worker does not queue ${repo}'s ${target.branch}.`);
  const state = queueState(deps, repo, 'deploy');

  return async () => {
    const [owner] = repo.split('/');
    const { body: pulls } = await github.poll(
      repo,
      `/repos/${repo}/pulls?state=open&per_page=10&head=${owner}:${encodeURIComponent(target.branch)}`,
      PULLS,
    );
    // The deploy watch's own, if GitHub lists another from the same branch into another base beside it.
    const pull = pulls.find((p) => deployPullWait(target, p) === undefined) ?? pulls[0];
    state.keep(new Set(pull ? [pull.number] : []));
    if (!pull) return;
    const attempt = state.attempt(pull.number, pull.head.sha);
    if (attempt.done) return;
    const notOne = deployPullWait(target, pull) ?? headWait(deps.heads, repo, pull, 'not-a-deploy');
    if (notOne) return state.wait(pull.number, pull.head.sha, notOne);
    // The deploy pin runs only what Martin already merged: neither the level, auto-merge nor the line's stop governs it.
    await queueOne(deps, state, repo, 'deploy', pull, ['exact-pin'], attempt);
  };
}

/** How many pages of a hundred open pull requests a pass reads: the pin watch opens one for each file's moves. */
const OPEN_PAGES = 5;

const MATCHING_REFS = z.array(z.object({ ref: z.string(), object: z.object({ sha: z.string() }) }));

/** The commits the pin watch's branches (`factory/pin/…`, `factory/pin-next/…`) point at in a repository. */
export const pinHeadsOf =
  (github: GitHub) =>
  async (repo: string): Promise<string[]> => {
    const refs: z.infer<typeof MATCHING_REFS> = [];
    for (let page = 1; ; page++) {
      const { body } = await github.poll(
        repo,
        `/repos/${repo}/git/matching-refs/heads/factory/pin?per_page=100&page=${page}`,
        MATCHING_REFS,
      );
      refs.push(...body);
      if (body.length < 100) break;
      // Past what is read, a head may be missed: no branch is set until the pin branches are fewer.
      if (page === OPEN_PAGES) throw new Error(`More pin branches are in ${repo} than the door reads.`);
    }
    return refs.filter((ref) => pinBranch(ref.ref.replace(/^refs\/heads\//, ''))).map((ref) => ref.object.sha);
  };

/**
 * Whether anyone but the App ever took the `pin` label off a pull request, by its events: Martin's hold of it. Anyone's
 * hand holds, not his alone: a hold only ever keeps a move for Martin, so it fails closed, and what passes a pull
 * request is the gate's verdict, which has its own rule for who may.
 */
export function heldByLabel(events: LabelEvents): boolean {
  return events.some((e) => e.event === 'unlabeled' && e.label?.name === PIN_LABEL && e.actor?.id !== APP_USER);
}

/** When anyone but the App last took the `pin` label off, by GitHub's times, or undefined when it gives none. */
const heldSince = (events: LabelEvents): string | undefined =>
  events
    .filter((e) => e.event === 'unlabeled' && e.label?.name === PIN_LABEL && e.actor?.id !== APP_USER)
    .map((e) => e.created_at)
    .filter((t) => t !== undefined)
    .sort()
    .at(-1);

const CLOSED = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    user: z.object({ id: z.number().int() }).nullable(),
    head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
    merged_at: z.string().nullable().optional(),
    closed_at: z.string().nullable().optional(),
  }),
);

/** A repository's open pull requests, oldest first, up to `OPEN_PAGES` pages; any past them are left for the next pass. */
async function openPulls(deps: { github: GitHub; log: Logger }, repo: string, kind: string): Promise<QueuePull[]> {
  const pulls: QueuePull[] = [];
  for (let page = 1; page <= OPEN_PAGES; page++) {
    const { body } = await deps.github.poll(
      repo,
      `/repos/${repo}/pulls?state=open&per_page=100&sort=created&direction=asc&page=${page}`,
      PULLS,
    );
    pulls.push(...body);
    if (body.length < 100) return pulls;
  }
  deps.log.warn(
    { repo, read: pulls.length },
    `more pull requests are open than the ${kind} queue reads: it reads the oldest`,
  );
  return pulls;
}

/**
 * Watches the pin watch's open pull requests in a repository, and adds each to the merge queue once the gate passed
 * its head as a move the autonomy level queues and its checks are green. Only what the watch wrote is queued: the
 * watch commits only the moves it is told to take (`PIN_WATCH_ONLY`), and a head it did not write, one left open from
 * an earlier setting or opened by hand on a pin branch among them, waits (`headWait`); told none (`only`), it reads
 * nothing. A pull request on a pin branch or labelled `pin` that is not the pin watch's own waits, and says why; every
 * other open pull request is not read further.
 */
export function pinQueueWatch(deps: PinQueueDependencies, repo: string, only: PinScope = []): Watch {
  const { github } = deps;
  if (!PIN_REPOS.includes(repo)) throw new Error(`The worker does not queue ${repo}'s pin moves.`);
  const state = queueState(deps, repo, 'pin', 'pin-queue');

  /** Every event of a pull request, page by page, up to `EVENT_PAGES`; whole only when no event lies past them. */
  const eventsOf = async (number: number): Promise<{ events: LabelEvents; whole: boolean }> => {
    const events: LabelEvents = [];
    for (let page = 1; ; page++) {
      const { body } = await github.poll(
        repo,
        `/repos/${repo}/issues/${number}/events?per_page=100&page=${page}`,
        LABEL_EVENTS,
      );
      if (page > EVENT_PAGES) return { events, whole: body.length === 0 };
      events.push(...body);
      if (body.length < 100) return { events, whole: true };
    }
  };

  /**
   * Martin's hold of a move carried across the pin watch closing its pull request and opening another (a day the scan
   * left it out, or Dependabot took it), at any target: an earlier closed, unmerged pull request of the App's from the
   * same branch whose `pin` label anyone but the App took off holds this one, unless a pull request from the branch
   * merged after it closed: a merge ends every hold before it. Without GitHub's times, a merge listed newer (they are
   * read newest first) ends it. One that cannot be read whole holds too, saying so, as do more than `OPEN_PAGES` pages.
   */
  const heldBefore = async (pull: QueuePull): Promise<QueueWait | undefined> => {
    const [owner] = repo.split('/');
    const head = `${owner}:${encodeURIComponent(pull.head.ref)}`;
    const closed: z.infer<typeof CLOSED> = [];
    for (let page = 1; ; page++) {
      const { body } = await github.poll(
        repo,
        `/repos/${repo}/pulls?state=closed&sort=created&direction=desc&per_page=100&page=${page}&head=${head}`,
        CLOSED,
      );
      closed.push(...body.filter((c) => c.head.repo?.full_name === repo && c.head.ref === pull.head.ref));
      if (body.length < 100) break;
      if (page === OPEN_PAGES) {
        return { waits: 'not-a-pin', why: 'more of its branch’s pull requests are closed than the queue reads' };
      }
    }
    const merges = closed.filter((c) => c.merged_at);
    const lastMerged = merges
      .map((c) => c.merged_at as string)
      .sort()
      .at(-1);
    for (const [i, c] of closed.entries()) {
      if (c.merged_at || c.user?.id !== APP_USER) continue;
      // Read each pass (a conditional request): Martin may take the label off a closed pull request, or put it back
      // and take it off again, at any time. One that cannot be read whole holds, saying so: it fails closed.
      const { events, whole } = await eventsOf(c.number);
      const held = !whole ? 'unread' : heldByLabel(events) ? { since: heldSince(events) } : false;
      if (held === 'unread') return { waits: 'not-a-pin', why: `#${c.number}, of this move, runs past what is read` };
      if (!held) continue;
      // A merge from the branch after Martin took the label off ends the hold: by when he took it off, which may be
      // after the pull request closed; without GitHub's time for it, by when it closed, or else by the list's order.
      const since = held.since ?? c.closed_at ?? undefined;
      const ended =
        lastMerged !== undefined &&
        (since !== undefined ? since < lastMerged : closed.slice(0, i).some((newer) => newer.merged_at));
      if (ended) continue;
      return {
        waits: 'not-a-pin',
        why: `Martin held this move on #${c.number} by taking its ${PIN_LABEL} label off, and nothing has merged since`,
      };
    }
    return undefined;
  };

  return async () => {
    // Told no move, it queues none: its pass is made, with nothing to say.
    if (only !== '*' && only.length === 0) return state.passed(new Set());
    const pulls = await openPulls(deps, repo, 'pin');
    const candidates = pulls.filter((p) => pinBranch(p.head.ref) || p.labels.some((l) => l.name === PIN_LABEL));
    state.keep(new Set(candidates.map((p) => p.number)));
    for (const pull of candidates) {
      const { number } = pull;
      const head = pull.head.sha;
      const attempt = state.attempt(number, head);
      if (attempt.done) continue;
      const notOne = pinPullWait(repo, pull) ?? headWait(deps.heads, repo, pull, 'not-a-pin');
      if (notOne) {
        // No pin move of the watch's at this head, or not yet one it wrote: nothing is said of it.
        state.note(number, head, {}, true);
        state.wait(number, head, notOne);
        continue;
      }
      // Who labelled it is read last, once the gate and the checks pass it: its events are the dearest read.
      const labelled = async () => {
        const { events, whole } = await eventsOf(number);
        return labelWait(events, whole) ?? (await heldBefore(pull));
      };
      // One pull request that cannot be read (closed since the list, an answer that does not parse) holds only itself.
      await queueOne(deps, state, repo, 'pin', pull, MOVE_RULES, attempt, {
        confirm: labelled,
        level: deps.level,
      }).catch((error: unknown) => {
        deps.log.warn({ repo, number, head, err: error }, 'could not read the pin pull request: tries again next pass');
      });
    }
    state.passed(new Set(candidates.map((p) => p.number)));
  };
}

/**
 * What a required check that failed on Dependabot's head waits for: the worker writes nothing to Dependabot's branch,
 * so nothing of its own makes a new head for the checks to run on.
 */
export const THEIRS =
  "the factory writes nothing to Dependabot's branch, so it waits for Martin to run the check again, or for " +
  "Dependabot's next rebase of it (`@dependabot rebase`, or main moving on)";

/**
 * Watches Dependabot's open pull requests for GitHub Actions in a repository that calls the factory's workflows, and
 * adds each to the merge queue once the gate passed its head as an exact pin, the autonomy level queues one and its
 * checks are green. Only a pull request Dependabot opened from a `dependabot/github_actions/` branch is read further:
 * one from a fork, into another branch or a draft waits, and says why; every other open pull request, Dependabot's of
 * another ecosystem among them, is not looked at. One of third-party actions, or of them and the factory's together,
 * is read, and waits on the gate's rule, which is never `exact-pin` for it: that pull request is Martin's.
 *
 * It does to Dependabot's pull request the one thing the worker's guard lets through, the enqueue, which the guard
 * lets through for this watch alone: no commit, comment or label. In a dry run it does nothing at all.
 */
export function workflowPinQueueWatch(deps: WorkflowPinQueueDependencies, repo: string): Watch {
  if (!WORKFLOW_PIN_REPOS.includes(repo)) throw new Error(`The worker does not queue ${repo}'s workflow pins.`);
  const { github } = deps;
  /** The head GitHub's list gave each pull request this pass: the head its verdict is read at, and it is queued at. */
  const listed = new Map<number, string>();
  /** The review App's verdict on a pull request at the head listed, and nothing kept of a hold. */
  const reviewVerdict = async (_repo: string, number: number): Promise<ReviewVerdict> => {
    const head = listed.get(number) ?? '';
    const { body } = await github.poll(repo, reviewRunsPath(repo, head), REVIEW_RUNS);
    const check = reviewCheckOf(listedReviews(body), head);
    return { number, head, check, ...verdictOf(number, head, check) };
  };
  // What the queue is given: no comment and no commit to make, and no head of its own to vouch for.
  const queue: DeployQueueDependencies = {
    github,
    // Each read named and called on the reads themselves: they are an object of a class, whose methods a spread
    // would leave behind.
    reads: {
      checkRuns: (where, sha) => deps.reads.checkRuns(where, sha),
      requiredChecks: (where, branch) => deps.reads.requiredChecks(where, branch),
      mergeability: (where, number) => deps.reads.mergeability(where, number),
      mergeQueue: (where, number) => deps.reads.mergeQueue(where, number),
      reviewVerdict,
    },
    // Said in this call alone: the guard adds Dependabot's pull request for this watch, and for no worker that asks.
    actions: {
      enqueuePullRequest: (where, number, head) =>
        deps.actions.enqueuePullRequest(where, number, head, 'workflow-pin-watch'),
    },
    recorder: deps.recorder,
    heads: { get: () => undefined },
    pulls: deps.pulls,
    log: deps.log,
  };
  const state = queueState(queue, repo, 'workflow pin', 'workflow-queue');

  return async () => {
    // A dry run queues nothing, and says nothing of what it would have.
    if (deps.actions.dryRun) return state.passed(new Set());
    const pulls = await openPulls(deps, repo, 'workflow pin');
    const candidates = pulls.filter(
      (p) => p.user?.id === DEPENDABOT_USER && p.head.ref.startsWith(DEPENDABOT_ACTIONS_PREFIX),
    );
    state.keep(new Set(candidates.map((p) => p.number)));
    listed.clear();
    for (const pull of candidates) {
      const { number } = pull;
      const head = pull.head.sha;
      listed.set(number, head);
      const attempt = state.attempt(number, head);
      if (attempt.done) continue;
      const notOne = workflowPinPullWait(repo, pull);
      if (notOne) {
        state.note(number, head, {}, true);
        state.wait(number, head, notOne);
        continue;
      }
      // One pull request that cannot be read (closed since the list, an answer that does not parse) holds only itself.
      await queueOne(queue, state, repo, 'workflow pin', pull, ['exact-pin'], attempt, {
        level: deps.level,
        theirs: THEIRS,
      }).catch((error: unknown) => {
        deps.log.warn(
          { repo, number, head, err: error },
          'could not read the workflow pin pull request: tries again next pass',
        );
      });
    }
    state.passed(new Set(candidates.map((p) => p.number)));
  };
}
