/**
 * One worker over one fake repository (`FakeRepo`), as service.ts wires it: the real pin watch, the real pin queue, and the real HTTP door (`createWorkerServer`) over the live actions and
 * their guards, with `pinHeads`. The gate's verdict and the required checks are stubbed as passing at whatever head a
 * pull request has: what is under test is what the queue and the door add to the gate, not the gate.
 *
 * Closed pull requests are listed with GitHub's `closed_at` and `merged_at`, which a test sets (`times`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { APP_LOGIN, LiveActions } from '../../src/github/actions.ts';
import { WatchedHeads } from '../../src/github/branches.ts';
import { GitHubError } from '../../src/github/client.ts';
import { dependencyPulls } from '../../src/github/dependabot.ts';
import {
  type DeployQueueDependencies,
  type LabelEvents,
  pinHeadsOf,
  pinQueueWatch,
} from '../../src/github/deploy-queue.ts';
import { APP_USER, IssueGuard, openedBy } from '../../src/github/issues.ts';
import { PASS_MS, type PinScope, pinWatch } from '../../src/github/pins.ts';
import type { PullRequestState, Reads } from '../../src/github/reads.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import type { Moves } from '../../src/github/scanning.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { client, quiet, type Route, type Sent } from './fake.ts';
import { FACTORY, type FakeRepo } from './pins-harness.ts';

export const REQUIRED = ['lint, types, tests', 'image builds', 'platform', 'review'];
export const MARTIN = 49_699_333;

export interface Times {
  closed_at?: string | null;
  merged_at?: string | null;
}

export async function worker(repo: FakeRepo, only: PinScope, today: () => Moves, closing: (() => void)[] = []) {
  const events = new Map<number, LabelEvents>();
  /** GitHub's times for each closed pull request, by number. */
  const times = new Map<number, Times>();
  /** How often each pull request's events were read. */
  const eventReads = new Map<number, number>();
  /** Set to make the next read of a pull request's events fail. */
  const failing = { events: false };
  const headOf = (branch: string) => repo.refs.get(branch) ?? 'c'.repeat(40);
  const sent: Sent[] = [];
  const listed: Route[] = [
    {
      method: 'GET',
      path: /\/pulls\?state=open&per_page=100&sort=created&direction=asc&page=\d+$/,
      answer: ({ path }) => ({
        body: path.endsWith('page=1')
          ? repo.pulls
              .filter((p) => p.state === 'open')
              .map((p) => ({
                number: p.number,
                title: p.title,
                draft: false,
                user: { id: p.user === APP_LOGIN ? APP_USER : 1 },
                labels: p.labels.map((name) => ({ name })),
                head: { ref: p.head, sha: headOf(p.head), repo: { full_name: p.from ?? FACTORY } },
                base: { ref: 'main' },
              }))
          : [],
      }),
    },
    {
      // The queue's own read of a branch's closed pull requests, newest first, with GitHub's times.
      method: 'GET',
      path: /\/pulls\?state=closed&sort=created&direction=desc&per_page=100&page=\d+&head=/,
      answer: ({ path }) => {
        const q = new URLSearchParams(path.split('?')[1]);
        const head = q.get('head')?.split(':')[1];
        const all = repo.pulls
          .filter((p) => p.state === 'closed' && p.head === head)
          .sort((a, b) => b.number - a.number)
          .map((p) => ({
            number: p.number,
            title: p.title,
            user: { id: p.user === APP_LOGIN ? APP_USER : MARTIN },
            head: { ref: p.head, repo: { full_name: p.from ?? FACTORY } },
            merged_at: times.get(p.number)?.merged_at ?? p.merged_at,
            closed_at: times.get(p.number)?.closed_at,
          }));
        const page = Number(q.get('page'));
        return { body: all.slice((page - 1) * 100, page * 100) };
      },
    },
    {
      method: 'GET',
      path: /\/issues\/\d+\/events\?per_page=100&page=\d+$/,
      answer: ({ path }) => {
        const [, number, page] = /issues\/(\d+)\/events\?per_page=100&page=(\d+)/.exec(path) ?? [];
        if (failing.events) return { status: 502, body: { message: 'Bad Gateway' } };
        eventReads.set(Number(number), (eventReads.get(Number(number)) ?? 0) + 1);
        const pull = repo.pulls.find((p) => p.number === Number(number));
        const all =
          events.get(Number(number)) ??
          (pull?.labels ?? []).map((name) => ({ event: 'labeled', actor: { id: APP_USER }, label: { name } }));
        return { body: page === '1' ? all : [] };
      },
    },
    {
      method: 'POST',
      path: /\/issues\/\d+\/labels$/,
      answer: ({ path, body }) => {
        const number = Number(path.split('/').at(-2));
        const pull = repo.pulls.find((p) => p.number === number);
        for (const name of (body as { labels: string[] }).labels) {
          pull?.labels.push(name);
          const kept = events.get(number);
          if (kept) kept.push({ event: 'labeled', actor: { id: APP_USER }, label: { name } });
        }
        return { body: [] };
      },
    },
    { method: 'POST', path: `/repos/${FACTORY}/check-runs`, answer: () => ({ status: 201, body: { id: 9001 } }) },
    { method: 'PATCH', path: new RegExp(`^/repos/${FACTORY}/check-runs/\\d+$`), answer: () => ({ body: {} }) },
  ];
  const { github } = client([...listed, ...repo.routes()], sent, { sleep: async () => {} });
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'redteam5-')));
  const recorder = new RefusalRecorder({ artifacts, log: quiet });
  const guard = new IssueGuard({ openedBy: openedBy(github), recorder });
  const actions = new LiveActions(github, { guard });
  let clock = Date.parse('2026-11-12T07:00:00Z');
  // One record of the watch's commits for both, as service.ts gives it.
  const heads = new WatchedHeads();
  const watch = pinWatch(
    {
      github,
      reads: {
        moves: async () => today(),
        dependencyPulls: (r: string) => dependencyPulls(github, r, async () => 'version: 2\nupdates: []\n'),
      },
      actions,
      recorder,
      heads,
      log: quiet,
      now: () => clock,
      only,
    },
    FACTORY,
  );
  const head = (number: number) => headOf(repo.pulls.find((p) => p.number === number)?.head ?? '');
  /** Each enqueue the queue made: the pull request and the head GitHub would take it at. */
  const enqueued: { number: number; head: string }[] = [];
  const queueReads: DeployQueueDependencies['reads'] = {
    reviewVerdict: async (_repo, number) => ({
      number,
      head: head(number),
      check: null,
      verdict: null,
      judged: { number, head: head(number), rule: 'pin-move', tags: [] },
      problem: null,
    }),
    checkRuns: async () =>
      REQUIRED.filter((name) => name !== 'review').map((name, i) => ({
        id: i + 1,
        name,
        status: 'completed',
        conclusion: 'success',
        app: 'github-actions',
        startedAt: null,
        completedAt: null,
        title: null,
      })),
    requiredChecks: async () => REQUIRED,
    mergeability: async (_repo, number) => ({ number, head: head(number), conflicts: false, state: 'clean' }),
    mergeQueue: async (_repo, number) => ({
      number,
      head: head(number),
      state: 'open',
      queued: null,
      added: null,
      removed: null,
      checks: [],
    }),
  };
  /** Set to make the next enqueue fail as a failure that may pass (a 502). */
  const failEnqueue = { times: 0 };
  const queue = pinQueueWatch(
    {
      github,
      reads: queueReads,
      actions: {
        enqueuePullRequest: async (_repo: string, number: number, at: string) => {
          if (failEnqueue.times > 0) {
            failEnqueue.times -= 1;
            throw new GitHubError('server', 'GraphQL answered 502', 502);
          }
          enqueued.push({ number, head: at });
          return { position: 1, state: 'QUEUED' };
        },
      },
      heads,
      log: quiet,
    },
    FACTORY,
    only,
  );

  // The door, as service.ts wires it.
  const doorReads = {
    pullRequest: async (_repo: string, number: number): Promise<PullRequestState> => {
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) throw new GitHubError('not-found', `#${number} is not a pull request.`, 404);
      return { head: { ref: pull.head, sha: repo.refs.get(pull.head) } } as PullRequestState;
    },
    requiredChecks: async () => REQUIRED,
  } as unknown as Reads;
  const server = createWorkerServer({
    actions,
    reads: doorReads,
    repositories: [FACTORY],
    health: () => ({}),
    recorder,
    pinHeads: pinHeadsOf(github),
    log: quiet,
  });
  const { url } = await listenLocal(server);
  closing.push(() => server.close());

  /** One action asked of the door, as any pod sends it. */
  const ask = async (action: string, body: Record<string, unknown>) => {
    const response = await fetch(`${url}/v1/actions/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: FACTORY, ...body }),
    });
    const answer = (await response.json()) as { error?: string; message?: string; result?: unknown };
    return { status: response.status, error: answer.error, message: answer.message, result: answer.result };
  };

  return {
    repo,
    sent,
    events,
    times,
    eventReads,
    failing,
    failEnqueue,
    enqueued,
    ask,
    watchOnly: async () => {
      clock += PASS_MS;
      await watch();
    },
    queueOnly: async () => {
      await queue();
    },
    pass: async () => {
      clock += PASS_MS;
      await watch();
      await queue();
    },
  };
}

/** A pull request's `pin` label events: the App's label, then Martin's taking it off. */
export const heldByMartin = (): LabelEvents => [
  { event: 'labeled', actor: { id: APP_USER }, label: { name: 'pin' } },
  { event: 'unlabeled', actor: { id: MARTIN }, label: { name: 'pin' } },
];
export const labelledByApp = (): LabelEvents => [{ event: 'labeled', actor: { id: APP_USER }, label: { name: 'pin' } }];
