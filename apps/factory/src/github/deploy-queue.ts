/**
 * The local profile's deploy pins in this repository, added to the merge queue by the worker itself (ADR 0017). The
 * deploy watch (`deploys.ts`) opens and moves the factory's own deploy pull request; the review gate passes it as an
 * exact pin (`exact-pin`: every changed line a digest under `deploy/`, each image signed by `build.yml` on main, from a
 * commit ahead of the pin it replaces); and this watch adds it to the queue, so an image built on main reaches the
 * local cluster with nobody's hand on it. The app's deploy pull request is the line's, within Martin's autonomy level
 * and auto-merge (`line/deploy.ts`); a release, and anything else, is his.
 *
 * Each pass reads the one open pull request from the deploy branch, and adds it to the queue at its head only when
 * every one of these holds; otherwise it waits, and says why once for each head:
 *
 * - it is the App's (`APP_USER`), from this repository's deploy branch into main, not a draft, with the profile's label
 *   (`deploy: local`) and a title the deploy watch writes (`chore(deploy): run … on the local cluster`);
 * - the review App's own `review` check on that head concluded with a verdict that passes it as `exact-pin` at that
 *   head (`merging.ts`): no other rule, and never a hold, a pending one, or one for another head;
 * - every other check main's rulesets require has a latest run on that head, by anyone but the factory's App, that
 *   finished and did not fail (a skipped one passes, as GitHub has it); one still running is waited for, and one that
 *   failed waits for a re-run or a newer build;
 * - GitHub says it does not conflict with main, and it is not in the queue already.
 *
 * It tries once for each head. The enqueue is the one the line uses (`enqueuePullRequest`): the issue guard asks
 * whether the App opened it, the queue's guard whether it is from a branch the factory owns at the head named, and
 * GitHub takes it only at that head (`expectedHeadOid`), so a push after the verdict cannot ride it. A refusal, the
 * guard's or GitHub's 403, is kept in the artifact store, signed and logged as the worker's HTTP door keeps one
 * (`refusalOf`, `refusals.ts`), with no worker asking to relay it; any other failure is logged, and the head waits
 * for Martin. A head that moved first (409) is read again next pass. The queue then merges it, or takes it out, which GitHub shows on the pull request, and the
 * worker does not add that head again; a worker that restarts may, once, and the queue tests it again as before.
 *
 * In a dry run the actions record the enqueue in the artifact store and change nothing in GitHub (`DryRunActions`).
 */
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Actions } from './actions.ts';
import { APP_LOGIN } from './actions.ts';
import { type GitHub, GitHubError } from './client.ts';
import { DEPLOYS, type DeployTarget, deployLabel, isDeployTitle } from './deploys.ts';
import { APP_USER, IssueRefused } from './issues.ts';
import { type Mergeability, REVIEW_CHECK, type ReviewVerdict } from './merging.ts';
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
export type DeployPull = z.infer<typeof PULLS>[number];

/** Why a deploy pull request is not added to the queue now, in a few words, or undefined when it may be. */
export type QueueWait =
  | { waits: 'not-a-deploy'; why: string }
  | { waits: 'verdict'; why: string }
  | { waits: 'checks'; why: string }
  | { waits: 'failed'; why: string }
  | { waits: 'conflict'; why: string };

/** Whether a pull request is the deploy watch's own for a target: the App's, from its branch into main, labelled. */
export function deployPullWait(target: DeployTarget, pull: DeployPull): QueueWait | undefined {
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

/** Whether the gate passed a head as an exact pin: its own verdict on that head, by that rule, and not pending. */
export function verdictWait(verdict: Pick<ReviewVerdict, 'head' | 'judged' | 'problem'>, head: string) {
  const { judged } = verdict;
  if (verdict.head !== head || judged?.head !== head) {
    return { waits: 'verdict' as const, why: verdict.problem ?? 'the gate has not judged this head' };
  }
  if (judged.pending !== undefined) return { waits: 'verdict' as const, why: `the gate waits: ${judged.pending}` };
  if (judged.rule !== 'exact-pin') return { waits: 'verdict' as const, why: `the gate's rule is ${judged.rule}` };
  return undefined;
}

/**
 * How the checks main requires stand on a head, by each one's latest run there: the review gate's is read as its
 * verdict, not here, and the factory's App's own runs count for nothing.
 */
export function checksWait(runs: readonly CheckRun[], required: readonly string[]): QueueWait | undefined {
  const latest = new Map<string, CheckRun>();
  for (const run of [...runs].sort((a, b) => a.id - b.id)) if (run.app !== FACTORY_APP) latest.set(run.name, run);
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

export interface DeployQueueDependencies {
  github: GitHub;
  reads: Pick<Reads, 'checkRuns' | 'requiredChecks' | 'reviewVerdict' | 'mergeability' | 'mergeQueue'>;
  actions: Pick<Actions, 'enqueuePullRequest'>;
  /** What keeps, logs and signs a refusal; without it, a refusal is only logged. */
  recorder?: RefusalRecorder | undefined;
  log: Logger;
}

/** Watches one deploy's open pull request, and adds it to the merge queue once the gate and its checks pass it. */
export function deployQueueWatch(deps: DeployQueueDependencies, target: DeployTarget): Watch {
  const { github, reads, actions, recorder, log } = deps;
  const { repo } = target;
  if (!QUEUED_DEPLOYS.includes(target)) throw new Error(`The worker does not queue ${repo}'s ${target.branch}.`);
  /** The heads it has tried to add, or found queued: each once. */
  const tried = new Set<string>();
  /** What it last said of each head's wait, so it says each once. */
  let said: string | undefined;

  const wait = (number: number, head: string, w: QueueWait) => {
    const key = `${number} ${head} ${w.waits} ${w.why}`;
    if (said === key) return;
    said = key;
    log.info({ repo, number, head, waits: w.waits, why: w.why }, 'the deploy pull request waits to be queued');
  };

  return async () => {
    const [owner] = repo.split('/');
    const { body: pulls } = await github.poll(
      repo,
      `/repos/${repo}/pulls?state=open&per_page=10&head=${owner}:${encodeURIComponent(target.branch)}`,
      PULLS,
    );
    const pull = pulls[0];
    if (!pull) return;
    const { number } = pull;
    const head = pull.head.sha;
    const at = `${number} ${head}`;
    if (tried.has(at)) return;
    const notOne = deployPullWait(target, pull);
    if (notOne) return wait(number, head, notOne);

    const verdict = await reads.reviewVerdict(repo, number);
    const gate = verdictWait(verdict, head);
    if (gate) return wait(number, head, gate);
    const [runs, required] = await Promise.all([reads.checkRuns(repo, head), reads.requiredChecks(repo, 'main')]);
    const checks = checksWait(runs, required);
    if (checks) return wait(number, head, checks);
    const mergeable: Mergeability = await reads.mergeability(repo, number);
    if (mergeable.head !== head || mergeable.conflicts !== false) {
      const why = mergeable.conflicts ? 'it conflicts with main' : 'GitHub has not said whether it conflicts';
      return wait(number, head, { waits: 'conflict', why });
    }
    const queue = await reads.mergeQueue(repo, number);
    if (queue.head === head && queue.queued) {
      tried.add(at);
      return;
    }

    tried.add(at);
    try {
      const entry = await actions.enqueuePullRequest(repo, number, head);
      log.info({ repo, number, head, position: entry.position }, 'added the deploy pull request to the merge queue');
    } catch (error) {
      if (error instanceof GitHubError && error.status === 409) {
        // It moved, or closed, before it was queued: read again next pass.
        tried.delete(at);
        log.info({ repo, number, head, err: error }, 'the deploy pull request moved before it was queued');
        return;
      }
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
        'the deploy pull request was not added to the merge queue: it waits for Martin',
      );
    }
  };
}
