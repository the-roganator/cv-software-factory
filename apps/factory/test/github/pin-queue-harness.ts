/**
 * A worker: the real pin watch and the real pin queue, told the same moves, over one fake repository whose day a test
 * sets (as pin-hold.test.ts's, with a pass of the watch alone). The gate's verdict and
 * the checks are stubbed as passing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { APP_LOGIN, LiveActions } from '../../src/github/actions.ts';
import { WatchedHeads } from '../../src/github/branches.ts';
import { dependencyPulls } from '../../src/github/dependabot.ts';
import { type DeployQueueDependencies, type LabelEvents, pinQueueWatch } from '../../src/github/deploy-queue.ts';
import { APP_USER, IssueGuard, openedBy } from '../../src/github/issues.ts';
import { PASS_MS, type PinScope, pinWatch } from '../../src/github/pins.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import type { Moves } from '../../src/github/scanning.ts';
import { client, quiet, type Route } from './fake.ts';
import { FACTORY, type FakeRepo } from './pins-harness.ts';

const REQUIRED = ['lint, types, tests', 'image builds', 'review'];

export function worker(repo: FakeRepo, only: PinScope, today: () => Moves) {
  const events = new Map<number, LabelEvents>();
  const headOf = (branch: string) => repo.refs.get(branch) ?? 'c'.repeat(40);
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
      method: 'GET',
      path: /\/issues\/\d+\/events\?per_page=100&page=\d+$/,
      answer: ({ path }) => {
        const [, number, page] = /issues\/(\d+)\/events\?per_page=100&page=(\d+)/.exec(path) ?? [];
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
  ];
  const { github } = client([...listed, ...repo.routes()]);
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'redteam4-hold-')));
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
  const enqueued: number[] = [];
  const reads: DeployQueueDependencies['reads'] = {
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
  const queue = pinQueueWatch(
    {
      github,
      reads,
      actions: {
        enqueuePullRequest: async (_repo: string, number: number) => {
          enqueued.push(number);
          return { position: 1, state: 'QUEUED' };
        },
      },
      heads,
      log: quiet,
    },
    FACTORY,
    only,
  );
  return {
    events,
    enqueued,
    /** The watch alone, an hour on. */
    watchOnly: async () => {
      clock += PASS_MS;
      await watch();
    },
    /** One pass of each, an hour on: the watch, then the queue. */
    pass: async () => {
      clock += PASS_MS;
      await watch();
      await queue();
    },
  };
}
