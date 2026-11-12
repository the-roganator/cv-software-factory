/**
 * The App's own pin pull requests in this repository, added to the merge queue by the worker itself (ADR 0017): the
 * local profile's deploy pin, and each pin move the gate proved (ADR 0019). The deploy watch (`deploys.ts`) opens and
 * moves the factory's own deploy pull request, which the review gate passes as an exact pin (`exact-pin`: every changed
 * line a digest under `deploy/`, each image signed by `build.yml` on main, from a commit ahead of the pin it replaces);
 * the pin watch (`pins.ts`) opens one pull request for each move of the vulnerability scan's, which the gate passes as
 * a pin move (`pin-move`) when it can prove the move from the pull request itself. These watches add each to the queue,
 * so a pin the gate passed reaches `main` with nobody's hand on it. The app's deploy pull request is the line's, within
 * Martin's autonomy level and auto-merge (`line/deploy.ts`); a pull request the gate held, even one Martin then
 * approved, a release, and anything else, is his.
 *
 * Each pass reads the open pull requests it watches, and adds each to the queue at its head only when every one of
 * these holds; otherwise it waits, and says why once for each head:
 *
 * - **the positive check, first**: its head is the very commit its watch last wrote to its branch (`WatchedHeads`), so
 *   a branch moved by anyone, by any route, is not the watch's work and is not added; the watch writes its own again;
 * - **the deploy pin**: it is the App's (`APP_USER`), from this repository's deploy branch into main, not a draft, with
 *   the profile's label (`deploy: local`) and a title the deploy watch writes (`chore(deploy): run … on the local
 *   cluster`), and the gate's rule is `exact-pin`;
 * - **a pin move**: it is the App's, from this repository's `factory/pin/<move>` (the pin watch's branch, one segment,
 *   as `guardPinBranch` has it) into main, not a draft, labelled `pin` by the App and by nobody else, every time it was
 *   labelled, its move one `PIN_WATCH_ONLY` names, by its exact name, and none Martin holds on its branch, and the gate's
 *   rule is `pin-move`. The gate trusts no branch, label or title (ADR 0019); the queue reads
 *   them so that nothing but the pin watch's own pull request rides the rule, and the verdict is what passes it;
 * - the review App's own `review` check on that head concluded with a verdict that passes it by that rule at that head
 *   (`merging.ts`): no other rule, and never a hold, a pending one, Martin's approval, or one for another head;
 * - every other check main's rulesets require has a latest run on that head, by anyone but the factory's App, that
 *   finished and did not fail (a skipped one passes, as GitHub has it); one still running is waited for, and one that
 *   failed waits for a re-run or a newer build;
 * - GitHub says it does not conflict with main, and it is not in the queue already.
 *
 * It adds each head once. The enqueue is the one the line uses (`enqueuePullRequest`): the issue guard asks whether
 * the App opened it, the queue's guard whether it is from a branch the factory owns at the head named, and GitHub
 * takes it only at that head (`expectedHeadOid`), so a push after the verdict cannot ride it. A failure that may pass
 * (the head moved, a rate limit, an outage, GitHub saying the request does not fit the state it found) is tried again
 * on the next pass, up to `MAX_TRIES`. A refusal, the guard's or GitHub's 403, is kept in the artifact store, signed
 * and logged as the worker's HTTP door keeps one (`refusalOf`, `refusals.ts`), with no worker asking to relay it; it,
 * and any other failure, leaves the head for Martin. The queue then merges it, or takes it out, which GitHub shows on
 * the pull request, and the worker does not add that head again; a worker that restarts may, once, and the queue tests
 * it again as before.
 *
 * In a dry run the watches write nothing to GitHub and record no commit, so no head in GitHub is one a watch wrote: the
 * queues add nothing and record no enqueue. A dry run's own deploy and pin pull requests, which GitHub never had, are
 * not seen here: the dry run's reads merge its deploy on their own clock (`dry-run-reads.ts`).
 */
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Actions } from './actions.ts';
import { APP_LOGIN } from './actions.ts';
import { BranchRefused, pinBranch, type WatchedHeads } from './branches.ts';
import { type GitHub, GitHubError } from './client.ts';
import { DEPLOYS, type DeployTarget, deployLabel, isDeployTitle } from './deploys.ts';
import { APP_USER, IssueRefused } from './issues.ts';
import { REVIEW_CHECK, type ReviewVerdict } from './merging.ts';
import { guardPinBranch, pinBranchFor } from './pin-guard.ts';
import { PIN_LABEL, PIN_REPOS, type PinScope, pinTitle, titleIsExact } from './pins.ts';
import type { Watch } from './poller.ts';
import { type CheckRun, outcomeOf, type Reads } from './reads.ts';
import type { RefusalRecorder } from './refusals.ts';
import { refusalOf } from './server.ts';

/** The repository whose deploy pull requests the worker queues: this one's, never the app's, which are the line's. */
export const QUEUES_DEPLOYS_IN = 'the-roganator/cv-software-factory';

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
  | { waits: 'verdict'; why: string }
  | { waits: 'checks'; why: string }
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
 * `factory/pin/<move>` of that repository into main, not a draft, labelled `pin`. Who labelled it is read apart
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

/** The gate's rules a pull request the worker queues may pass by: a deploy pin's and a pin move's. */
export type QueueRule = 'exact-pin' | 'pin-move';

/** Whether the gate passed a head by a rule: its own verdict on that head, by that rule alone, and not pending. */
export function verdictWait(
  verdict: Pick<ReviewVerdict, 'head' | 'judged' | 'problem'>,
  head: string,
  rule: QueueRule,
) {
  const { judged } = verdict;
  if (verdict.head !== head || judged?.head !== head) {
    return { waits: 'verdict' as const, why: verdict.problem ?? 'the gate has not judged this head' };
  }
  if (judged.pending !== undefined) return { waits: 'verdict' as const, why: `the gate waits: ${judged.pending}` };
  if (judged.rule !== rule) return { waits: 'verdict' as const, why: `the gate's rule is ${judged.rule}, not ${rule}` };
  return undefined;
}

/**
 * How the checks main requires stand on a head, by each one's latest run there: the review gate's is read as its
 * verdict, not here, and the factory's App's own runs count for nothing.
 */
export function checksWait(runs: readonly CheckRun[], required: readonly string[]): QueueWait | undefined {
  const latest = new Map<string, CheckRun>();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) if (run.app !== FACTORY_APP) latest.set(run.name, run);
  // No required check read is no check passed: a ruleset that could not be read, or moved, queues nothing.
  if (!required.length) return { waits: 'checks', why: "main's rulesets name no required check" };
  const names = required.filter((name) => name !== REVIEW_CHECK);
  const failed = names.filter((name) => {
    const run = latest.get(name);
    return run?.status === 'completed' && outcomeOf(run.conclusion) === 'failure';
  });
  if (failed.length) return { waits: 'failed', why: `failed: ${failed.join(', ')}` };
  const running = names.filter((name) => latest.get(name)?.status !== 'completed');
  if (running.length) return { waits: 'checks', why: `waiting for ${running.join(', ')}` };
  return undefined;
}

/** How often a head is tried after a failure that may pass, before it is left for Martin. */
export const MAX_TRIES = 5;

/** The failures that may pass: a 409, or a GraphQL error that does not fit the state now; a limit; an outage. */
const PASSING: readonly string[] = ['conflict', 'rate-limited', 'server', 'network'];

export interface DeployQueueDependencies {
  github: GitHub;
  reads: Pick<Reads, 'checkRuns' | 'requiredChecks' | 'reviewVerdict' | 'mergeability' | 'mergeQueue'>;
  actions: Pick<Actions, 'enqueuePullRequest'>;
  /** What keeps, logs and signs a refusal; without it, a refusal is only logged. */
  recorder?: RefusalRecorder | undefined;
  /**
   * The commit each watch last wrote to its branch (`WatchedHeads`): a pull request is added only at that commit, the
   * watch's own work for its move or build, however its branch got anywhere else.
   */
  heads: Pick<WatchedHeads, 'get'>;
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
  /** Once it is added, found queued, refused, or out of tries. */
  done: boolean;
}

/**
 * What one watch keeps of the pull requests it queues, each by number: the head it last tried and what it last said of
 * it, so it tries each head once and says each wait once. Only the current head of each is kept.
 */
function queueState(deps: DeployQueueDependencies, repo: string, kind: string) {
  const { log } = deps;
  const tried = new Map<number, Attempt>();
  const said = new Map<number, string>();
  return {
    attempt(number: number, head: string): Attempt {
      const at = `${number} ${head}`;
      const kept = tried.get(number);
      if (kept?.at === at) return kept;
      const attempt = { at, failures: 0, done: false };
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
 * Adds one pull request, already known to be the App's own of its kind, to the queue at its head once the gate passed
 * that head by the rule and its checks are green; otherwise says why it waits. `confirm`, when given, is read last,
 * once all else passes and just before the enqueue, as it costs more and should be fresh: a wait it gives is said as
 * the others are.
 */
async function queueOne(
  deps: DeployQueueDependencies,
  state: ReturnType<typeof queueState>,
  repo: string,
  kind: string,
  pull: QueuePull,
  rule: QueueRule,
  attempt: Attempt,
  confirm?: () => Promise<QueueWait | undefined>,
): Promise<void> {
  const { reads, actions, recorder, log } = deps;
  const { number } = pull;
  const head = pull.head.sha;
  // Each a conditional request, read together: one that has not changed costs nothing against the rate limit.
  const [verdict, runs, required, mergeable] = await Promise.all([
    reads.reviewVerdict(repo, number),
    reads.checkRuns(repo, head),
    reads.requiredChecks(repo, 'main'),
    reads.mergeability(repo, number),
  ]);
  const gate = verdictWait(verdict, head, rule);
  if (gate) return state.wait(number, head, gate);
  const checks = checksWait(runs, required);
  if (checks) return state.wait(number, head, checks);
  if (mergeable.head !== head || mergeable.conflicts !== false) {
    const why = mergeable.conflicts ? 'it conflicts with main' : 'GitHub has not said whether it conflicts';
    return state.wait(number, head, { waits: 'conflict', why });
  }
  const queue = await reads.mergeQueue(repo, number);
  if (queue.head === head && queue.queued) {
    attempt.done = true;
    return;
  }
  // Read the last thing before the enqueue, so what it confirms (who labelled a pin move) is as fresh as it can be:
  // GitHub's enqueue takes no condition on a label: a label taken off in the one request between is not seen, and
  // nothing takes a pull request out of the queue once it is in. Martin takes it out by hand.
  const confirmed = await confirm?.();
  if (confirmed) return state.wait(number, head, confirmed);

  try {
    const entry = await actions.enqueuePullRequest(repo, number, head);
    attempt.done = true;
    log.info(
      { repo, number, head, rule, position: entry.position },
      `added the ${kind} pull request to the merge queue`,
    );
  } catch (error) {
    if (error instanceof GitHubError && PASSING.includes(error.kind) && ++attempt.failures < MAX_TRIES) {
      log.info({ repo, number, head, err: error }, `the ${kind} pull request was not queued yet: tries again`);
      return;
    }
    attempt.done = true;
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
    await queueOne(deps, state, repo, 'deploy', pull, 'exact-pin', attempt);
  };
}

/** How many pages of a hundred open pull requests a pass reads: the pin watch opens one for each move. */
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

/** Whether a title is the one the pin watch gives a move of this name: the name, then one version, and nothing else. */
const titleNames = (title: string, name: string): boolean => {
  const prefix = `chore(pin): move ${name} to `;
  if (!title.startsWith(prefix)) return false;
  const to = title.slice(prefix.length);
  // The name and version whole, as the watch writes them: one it would alter or cut gets an issue, so none is it.
  return /^\S+$/.test(to) && titleIsExact(name, to) && pinTitle(name, to) === title;
};

/** Whether a pin branch is that of a move the pin watch is told to take (`PIN_WATCH_ONLY`), by the branch it opens. */
export function toldWait(only: PinScope, pull: Pick<QueuePull, 'title' | 'head'>): QueueWait | undefined {
  if (only === '*') return undefined;
  // The move by its exact name, as the watch reads the setting: the branch the watch opens for that name, and the
  // title it gives it, which no worker that asks can change (the door refuses any action on a pin pull request).
  const told = only.some((name) => pinBranchFor(name) === pull.head.ref && titleNames(pull.title, name));
  if (told) return undefined;
  return { waits: 'not-a-pin', why: 'its move is not one the pin watch is told to take (PIN_WATCH_ONLY)' };
}

/** Whether anyone but the App ever took the `pin` label off a pull request, by its events: Martin's hold of it. */
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

/**
 * Watches the pin watch's open pull requests in a repository, and adds each to the merge queue once the gate passed
 * its head as a pin move and its checks are green. Only a move the watch is told to take (`only`, `PIN_WATCH_ONLY`) is
 * queued, as the watch opens only those: one left open from an earlier setting, or opened by hand on a pin branch,
 * waits; told none, it reads nothing. A pull request on a pin branch or labelled `pin` that is not the pin watch's own
 * waits, and says why; every other open pull request is not read further.
 */
export function pinQueueWatch(deps: DeployQueueDependencies, repo: string, only: PinScope = []): Watch {
  const { github } = deps;
  if (!PIN_REPOS.includes(repo)) throw new Error(`The worker does not queue ${repo}'s pin moves.`);
  const state = queueState(deps, repo, 'pin');

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

  /** Each closed pull request of the App's found held, or not read whole, by its number and when it closed. */
  const heldWhenClosed = new Map<string, { since: string | undefined }>();

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
      const key = `${c.number} ${c.closed_at ?? ''}`;
      let held: { since: string | undefined } | 'unread' | false | undefined = heldWhenClosed.get(key);
      if (held === undefined) {
        const { events, whole } = await eventsOf(c.number);
        held = !whole ? 'unread' : heldByLabel(events) ? { since: heldSince(events) } : false;
        // Kept only once GitHub says when it closed, and only a hold: Martin may take the label off a closed pull
        // request later, so one not held is read again each pass (a conditional request), as is one not read whole.
        // A pull request reopened and closed again is read again too.
        if (c.closed_at && typeof held === 'object') heldWhenClosed.set(key, held);
      }
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

  /** The open pull requests, oldest first, up to `OPEN_PAGES` pages; any past them are left for the next pass. */
  const openPulls = async (): Promise<QueuePull[]> => {
    const pulls: QueuePull[] = [];
    for (let page = 1; page <= OPEN_PAGES; page++) {
      const { body } = await github.poll(
        repo,
        `/repos/${repo}/pulls?state=open&per_page=100&sort=created&direction=asc&page=${page}`,
        PULLS,
      );
      pulls.push(...body);
      if (body.length < 100) return pulls;
    }
    deps.log.warn(
      { repo, read: pulls.length },
      'more pull requests are open than the pin queue reads: it reads the oldest',
    );
    return pulls;
  };

  return async () => {
    if (only !== '*' && only.length === 0) return;
    const pulls = await openPulls();
    const candidates = pulls.filter((p) => pinBranch(p.head.ref) || p.labels.some((l) => l.name === PIN_LABEL));
    state.keep(new Set(candidates.map((p) => p.number)));
    for (const pull of candidates) {
      const { number } = pull;
      const head = pull.head.sha;
      const attempt = state.attempt(number, head);
      if (attempt.done) continue;
      const notOne = pinPullWait(repo, pull) ?? toldWait(only, pull) ?? headWait(deps.heads, repo, pull, 'not-a-pin');
      if (notOne) {
        state.wait(number, head, notOne);
        continue;
      }
      // Who labelled it is read last, once the gate and the checks pass it: its events are the dearest read.
      const labelled = async () => {
        const { events, whole } = await eventsOf(number);
        return labelWait(events, whole) ?? (await heldBefore(pull));
      };
      // One pull request that cannot be read (closed since the list, an answer that does not parse) holds only itself.
      await queueOne(deps, state, repo, 'pin', pull, 'pin-move', attempt, labelled).catch((error: unknown) => {
        deps.log.warn({ repo, number, head, err: error }, 'could not read the pin pull request: tries again next pass');
      });
    }
  };
}
