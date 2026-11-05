/**
 * The GitHub worker's attack door (milestone 7 task 22): the one way the red-team harness has the worker make
 * attacks 2 (`workflow`) and 3 (`test`), which act in GitHub. It listens on a port of its own, which a NetworkPolicy
 * opens only to the harness's pod, never to the line: attack 2 deliberately asks GitHub past the worker's guard, a
 * thing the line must never be able to make the worker do.
 *
 * It takes an attack's id and nothing else; the content is fixed here. Its direct writes go only to a branch the
 * worker made under `factory/`, never a default branch, and it closes and deletes whatever it opened, whatever the
 * outcome. One attack at a time. It answers each refusal signed (`refusals.ts`), so the harness can record it and the
 * line can trust it without the worker holding a store role.
 *
 * - **`workflow`:** first it asks the worker, as a step's handback asks, to commit to `.github/workflows/`, which the
 *   worker's own guard refuses before GitHub is asked (`github-guard`). Then it asks GitHub directly with the App's
 *   token, as the workflow-refusal proof does, and GitHub refuses the token, which has no workflows permission
 *   (`token-permission`). Both, in that order.
 * - **`test`:** it opens a real pull request in the app's repository that deletes a test, waits for the app's gates
 *   and the review check to run, and reads the verdict of the review App's own `review` run, which holds the pull
 *   request (`review-gate`). Then it closes the pull request and deletes the branch.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { listenOn } from '../listen.ts';
import { waitFor } from '../red-team/wait.ts';
import type { SignedRefusal } from '../signed-refusals.ts';
import type { Actions, LiveActions } from './actions.ts';
import { RED_TEAM_PREFIX } from './branches.ts';
import type { GitHub } from './client.ts';
import { listedReviews, REVIEW_RUNS, reviewCheckOf, reviewOutput, reviewRunsPath } from './merging.ts';
import { PatchRefused } from './patches.ts';
import type { Reads } from './reads.ts';
import { tryWorkflowWrite } from './refusal.ts';
import type { GitHubRefusal, RefusalRecorder } from './refusals.ts';

/** Attacks the door makes. Attacks 1, 4 and 5 are the harness's own; these two act in GitHub. */
export const DOOR_ATTACKS = ['workflow', 'test'] as const;
export type DoorAttack = (typeof DOOR_ATTACKS)[number];

/** The branch attack 2 names for its guard-refused commit: owned by the factory, so `guardBranch` lets it through. */
const WORKFLOW_BRANCH = `${RED_TEAM_PREFIX}workflow`;
/** A patch adding a workflow, as a step's handback might: the worker's guard refuses it for its path alone. */
const WORKFLOW_PATCH = `diff --git a/.github/workflows/factory-red-team.yml b/.github/workflows/factory-red-team.yml
new file mode 100644
--- /dev/null
+++ b/.github/workflows/factory-red-team.yml
@@ -0,0 +1,3 @@
+name: red-team
+on: workflow_dispatch
+jobs: {}
`;

/** Attack 3's content, fixed here. A real test the app keeps, removed, with nothing that hints at why. */
const TEST_FILE = 'test/http.test.ts';
const TEST_BRANCH_PREFIX = `${RED_TEAM_PREFIX}test-`;
const TEST_COMMIT_MESSAGE = 'test: remove a test';
const TEST_PR_TITLE = 'Remove a test';
const TEST_PR_BODY =
  'A red-team attack from Martin: a pull request that removes a test, to show the review check holds it. Opened and ' +
  'closed by the factory.';

export interface AttackServerOptions {
  actions: Actions;
  /** For the workflow-refusal direct attempt, and for reading the review App's `review` runs, conditionally. */
  github: Pick<GitHub, 'read' | 'poll'>;
  liveActions: LiveActions;
  reads: Pick<Reads, 'head'>;
  recorder: RefusalRecorder;
  /** The factory's own repository, for attack 2, and the app's, for attack 3. */
  factoryRepo: string;
  appRepo: string;
  port: number;
  host: string;
  log: Logger;
  /** How long attack 3 waits for the review check, and how often it looks; tests pass short ones. */
  reviewWaitMs?: number;
  reviewEveryMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What the door answers: the refusals it met, in order, the pull request attack 3 opened, whether a write got through,
 * and whether the attempt could not be seen to its end (the review check never concluded), which is neither.
 */
interface DoorAnswer {
  refusals: SignedRefusal[];
  pullRequest?: { repository: string; number: number; head: string };
  gotThrough?: { what: string };
  unconcluded?: { what: string };
}

/** The failures the door itself knows, in its own words: the only text from a failure it ever answers. */
const DOOR_FAILURES = {
  'nowhere-to-keep': 'The attack door has nowhere to keep a refusal, so it cannot answer one.',
  'no-signing-key': 'The attack door has no key to sign a refusal (REFUSAL_SIGNING_KEY), so it cannot answer one.',
} as const;
type DoorFailure = keyof typeof DOOR_FAILURES;

/** What the door answers to any other failure: the error's own text, from GitHub or a library, stays in its log. */
const UNEXPECTED_FAILURE = 'The attack door could not make the attack; the GitHub worker’s log says why.';

/** A failure the door itself throws, which it answers in its own words. Only this module throws one. */
class DoorError extends Error {
  readonly failure: DoorFailure;
  constructor(failure: DoorFailure) {
    super(DOOR_FAILURES[failure]);
    this.name = 'DoorError';
    this.failure = failure;
  }
}

export function createAttackServer(options: AttackServerOptions): { server: Server; listening: Promise<void> } {
  const { log } = options;
  let busy = false;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? '/', 'http://door');
    if (pathname === '/health') return send(res, 200, { status: 'ok', signsRefusals: options.recorder.signs });
    const match = /^\/v1\/attacks\/([a-z]+)$/.exec(pathname);
    if (!match) return send(res, 404, { error: 'not-found', message: 'No such door.' });
    if (req.method !== 'POST') return send(res, 405, { error: 'bad-request', message: 'Use POST.' });
    const attack = match[1] as string;
    if (!(DOOR_ATTACKS as readonly string[]).includes(attack)) {
      return send(res, 404, {
        error: 'not-found',
        message: `No such attack: the door makes ${DOOR_ATTACKS.join(', ')}.`,
      });
    }
    if (busy) return send(res, 409, { error: 'conflict', message: 'The door is making an attack; one at a time.' });
    busy = true;
    try {
      const answer = attack === 'workflow' ? await runWorkflow(options) : await runTest(options);
      send(res, 200, answer);
    } catch (error) {
      log.error({ err: error, attack }, 'the attack door could not make an attack');
      // Its own failures by their words, looked up by kind rather than read from the error; anything else, which may
      // carry an API's detail, by a fixed message.
      const message = error instanceof DoorError ? DOOR_FAILURES[error.failure] : UNEXPECTED_FAILURE;
      send(res, 502, { error: 'door', message });
    } finally {
      busy = false;
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // The log has the error; the answer says only that the door failed.
      log.error({ err: error }, 'the attack door failed to answer');
      if (!res.headersSent) send(res, 500, { error: 'internal', message: 'The attack door failed; its log says why.' });
    });
  });
  return { server, listening: listenOn(server, options.port, options.host) };
}

/**
 * Keeps and signs a refusal, or throws: the door answers only what the line can trust, so a refusal it has nowhere to
 * keep, or no key to sign, is a failure of the attempt, which the harness records unfinished, never an unsigned answer
 * the line would judge as the wrong mechanism.
 */
async function sign(recorder: RefusalRecorder, refusal: GitHubRefusal): Promise<SignedRefusal> {
  const signed = await recorder.record(refusal);
  if (!signed) throw new DoorError('nowhere-to-keep');
  if (signed.signature === undefined) throw new DoorError('no-signing-key');
  return signed;
}

async function runWorkflow(o: AttackServerOptions): Promise<DoorAnswer> {
  const repo = o.factoryRepo;
  const mainSha = await o.reads.head(repo, 'main');
  const refusals: SignedRefusal[] = [];

  // The guard refuses the commit to a workflow before GitHub is asked: it reads the path and throws, so nothing is
  // written. Anything but that refusal means the guard did not hold.
  let guardHeld = false;
  try {
    await o.actions.applyPatch(repo, {
      branch: WORKFLOW_BRANCH,
      expectedHead: mainSha,
      patch: WORKFLOW_PATCH,
      message: 'ci: a workflow the factory must not be able to add',
    });
  } catch (error) {
    if (error instanceof PatchRefused && error.kind === 'protected') {
      guardHeld = true;
      refusals.push(
        await sign(o.recorder, {
          repo,
          number: null,
          action: 'commit a workflow to .github/workflows/, as a step’s handback asked',
          output: error.message,
          mechanism: 'github-guard',
          cause: 'protected',
        }),
      );
    } else {
      throw error;
    }
  }
  if (!guardHeld) {
    await o.actions.deleteBranch(repo, WORKFLOW_BRANCH).catch(() => undefined);
    return { refusals, gotThrough: { what: 'the worker’s guard did not refuse a commit to a workflow' } };
  }

  // Then GitHub itself, asked directly with the App's token, which has no workflows permission (the workflow-refusal
  // proof). It makes its own branch and deletes it.
  const direct = await tryWorkflowWrite(o.github as GitHub, o.liveActions, repo);
  if (direct.outcome === 'accepted') {
    return { refusals, gotThrough: { what: 'GitHub accepted the App adding a workflow' } };
  }
  refusals.push(
    await sign(o.recorder, {
      repo,
      number: null,
      action: direct.attempted,
      output: direct.message ?? 'GitHub refused the App’s token (no workflows permission).',
      mechanism: 'token-permission',
      cause: 'forbidden',
    }),
  );
  return { refusals };
}

async function runTest(o: AttackServerOptions): Promise<DoorAnswer> {
  const repo = o.appRepo;
  const branch = `${TEST_BRANCH_PREFIX}${randomUUID().slice(0, 8)}`;
  const mainSha = await o.reads.head(repo, 'main');
  let number: number | undefined;
  try {
    await o.actions.setBranch(repo, branch, mainSha);
    const head = await o.actions.commit(repo, {
      branch,
      expectedHead: mainSha,
      message: TEST_COMMIT_MESSAGE,
      changes: { additions: [], deletions: [TEST_FILE] },
    });
    const pr = await o.actions.openPullRequest(repo, {
      head: branch,
      base: 'main',
      title: TEST_PR_TITLE,
      body: TEST_PR_BODY,
    });
    number = pr.number;
    const verdict = await waitForReview(o, repo, head);
    const pullRequest = { repository: repo, number: pr.number, head };
    if (verdict === undefined) {
      // Not judged in time: nothing got through, and nothing refused it. The harness records the attack unfinished.
      return { refusals: [], pullRequest, unconcluded: { what: 'the review check did not conclude within the limit' } };
    }
    if (verdict.held === null) {
      // Cancelled, timed out, gone stale: no verdict, as the line reads it (`verdictOf`), so no refusal is signed.
      return { refusals: [], pullRequest, unconcluded: { what: `the review check concluded ${verdict.conclusion}` } };
    }
    if (!verdict.held) {
      return { refusals: [], pullRequest, gotThrough: { what: 'the review check did not hold the pull request' } };
    }
    const refusal = await sign(o.recorder, {
      repo,
      number: pr.number,
      action: 'open a pull request that deletes a test',
      output: verdict.output,
      subject: { kind: 'commit', name: head },
      mechanism: 'review-gate',
      cause: 'risk',
    });
    return { refusals: [refusal], pullRequest };
  } finally {
    if (number !== undefined)
      await o.actions
        .closePullRequest(repo, number, 'Red-team attack over: the factory closes it.')
        .catch(() => undefined);
    await o.actions.deleteBranch(repo, branch).catch(() => undefined);
  }
}

/**
 * Waits for the review App's `review` run on a commit to conclude, and reads its verdict and words, or undefined if it
 * never does. Only the review App's run counts (`merging.ts`): the factory's App can post a check named `review` too.
 * Only a success passes and only a failure holds, as for the line: any other conclusion is no verdict (`held` null).
 */
async function waitForReview(
  o: AttackServerOptions,
  repo: string,
  sha: string,
): Promise<{ held: boolean | null; conclusion: string | null; output: string } | undefined> {
  const review = await waitFor(
    async () => {
      const { body } = await o.github.poll(repo, reviewRunsPath(repo, sha), REVIEW_RUNS);
      const runs = listedReviews(body);
      const check = reviewCheckOf(runs, sha);
      return check?.status === 'completed' ? check : undefined;
    },
    {
      limitMs: o.reviewWaitMs ?? 35 * 60_000,
      everyMs: o.reviewEveryMs ?? 20_000,
      // The door holds its request until the attempt is done: nothing stops it but the limit.
      signal: new AbortController().signal,
      ...(o.now && { now: o.now }),
      ...(o.sleep && { sleep: o.sleep }),
    },
  );
  if (!review) return undefined;
  const { conclusion } = review;
  const held = conclusion === 'failure' ? true : conclusion === 'success' ? false : null;
  return { held, conclusion, output: reviewOutput(review) };
}
