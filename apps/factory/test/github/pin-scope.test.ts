/**
 * The pin watch reads PIN_WATCH_ONLY by a move's exact name (`named.has(move.name)`, pins.ts), and commits only the
 * moves it takes. The pin queue reads no name: it adds only a head the watch wrote since the worker started
 * (`headWait`, deploy-queue.ts), so a pull request left open from an earlier setting, which this worker's watch does
 * not write, is not queued.
 *
 * The watch and the queue are the real ones, over one fake repository, sharing the commits the watch wrote as the
 * worker's do (`WatchedHeads`). The gate's verdict and the checks are stubbed as passing: what is shown is which pull
 * request the queue takes, not what the gate would say of it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { type Logger, pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { APP_LOGIN, LiveActions } from '../../src/github/actions.ts';
import { WatchedHeads } from '../../src/github/branches.ts';
import { dependencyPulls } from '../../src/github/dependabot.ts';
import { type DeployQueueDependencies, pinQueueWatch } from '../../src/github/deploy-queue.ts';
import { APP_USER, IssueGuard, openedBy } from '../../src/github/issues.ts';
import { PASS_MS, type PinScope, pinWatch, readPinScope } from '../../src/github/pins.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import type { Moves } from '../../src/github/scanning.ts';
import { client, quiet, type Route, type Sent } from './fake.ts';
import { day, FACTORY, FakeRepo, FILES, factoryMoves, pinBranchOf, writes } from './pins-harness.ts';

const REQUIRED = ['lint, types, tests', 'image builds', 'review'];

/** The real pin watch over the fake repository, as pins.test.ts runs it. */
function watch(repo: FakeRepo, today: () => Moves, only: PinScope, log: Logger = quiet, heads?: WatchedHeads) {
  const sent: Sent[] = [];
  const { github } = client(repo.routes(), sent);
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'redteam3-')));
  const recorder = new RefusalRecorder({ artifacts, log: quiet });
  const guard = new IssueGuard({ openedBy: openedBy(github), recorder });
  const actions = new LiveActions(github, { guard });
  let clock = Date.parse('2026-11-12T07:00:00Z');
  const reads = {
    moves: async () => today(),
    dependencyPulls: (r: string) => dependencyPulls(github, r, async () => 'version: 2\nupdates: []\n'),
  };
  const pass = pinWatch(
    { github, reads, actions, recorder, log, now: () => clock, only, ...(heads && { heads }) },
    FACTORY,
  );
  return {
    sent,
    pass: async () => {
      clock += PASS_MS;
      await pass();
    },
  };
}

/** The real pin queue over the same repository: its list and events as GitHub would give them, the gate passing. */
function queue(repo: FakeRepo, only: PinScope, heads: WatchedHeads) {
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
      // Every label in the fake repository was given by the App, through the live actions.
      method: 'GET',
      path: /\/issues\/\d+\/events\?per_page=100&page=\d+$/,
      answer: ({ path }) => {
        const [, number, page] = /issues\/(\d+)\/events\?per_page=100&page=(\d+)/.exec(path) ?? [];
        const pull = repo.pulls.find((p) => p.number === Number(number));
        return {
          body:
            page === '1'
              ? (pull?.labels ?? []).map((name) => ({ event: 'labeled', actor: { id: APP_USER }, label: { name } }))
              : [],
        };
      },
    },
  ];
  const { github } = client([...listed, ...repo.routes()]);
  const head = (number: number) => headOf(repo.pulls.find((p) => p.number === number)?.head ?? '');
  const enqueued: [number, string][] = [];
  const reads: DeployQueueDependencies['reads'] = {
    reviewVerdict: async (_repo, number) => ({
      number,
      head: head(number),
      check: null,
      verdict: null,
      judged: { number, head: head(number), rule: 'move', tags: [] },
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
  const actions = {
    enqueuePullRequest: async (_repo: string, number: number, at: string) => {
      enqueued.push([number, at]);
      return { position: 1, state: 'QUEUED' };
    },
  };
  return {
    pass: pinQueueWatch(
      {
        github,
        reads,
        actions,
        heads,
        level: async () => ({ autonomy: 'guarded', autoMerge: true }) as const,
        log: quiet,
      },
      FACTORY,
      only,
    ),
    enqueued,
  };
}

const heard = () => {
  const lines: { msg: string; [key: string]: unknown }[] = [];
  const log = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line)) });
  return { log, lines };
};

describe('PIN_WATCH_ONLY, read by the watch, and the queue adding only what the watch wrote', () => {
  // Each is a setting whose name no move of the day has: the watch says so, and takes none.
  const SETTINGS = ['Example-Dashboards', 'example_dashboards', 'example-dashboards*', 'example dashboards'];

  for (const setting of SETTINGS) {
    it(`PIN_WATCH_ONLY=${JSON.stringify(setting)}: the watch takes no move, and the queue adds nothing`, async () => {
      const repo = new FakeRepo(FILES);
      const scanned = repo.main;
      // An earlier setting, every move: the watch opens each, labelled pin by the App.
      await watch(repo, () => day(scanned, factoryMoves()), '*').pass();
      const left = repo.pulls.find((p) => p.head === pinBranchOf('example-dashboards'));
      expect(left).toMatchObject({ state: 'open', labels: ['pin'], user: APP_LOGIN });

      // The setting now, read as config.ts reads it.
      const only = readPinScope(setting);
      expect(only).toEqual([setting]);
      const { log, lines } = heard();
      // A worker started with it knows no commit of the earlier one's.
      const heads = new WatchedHeads();
      const narrowed = watch(repo, () => day(scanned, factoryMoves()), only, log, heads);
      await narrowed.pass();
      // The watch: the name is no move's. It takes none, and writes nothing.
      expect(lines.find((l) => /pin watch takes/.test(l.msg))).toMatchObject({ taken: 0, unknown: [setting] });
      expect(writes(narrowed.sent)).toEqual([]);

      // The queue, given the same setting, as service.ts gives it: no head the watch wrote, none it adds.
      const q = queue(repo, only, heads);
      await q.pass();
      expect(q.enqueued).toEqual([]);
    });
  }

  it('control: a setting that names another move queues that move’s pull request, and leaves example-dashboards’ out', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    await watch(repo, () => day(scanned, factoryMoves()), '*').pass();
    const left = repo.pulls.find((p) => p.head === pinBranchOf('example-dashboards'));
    const told = repo.pulls.find((p) => p.head === pinBranchOf('k3s'));
    // A worker started told `k3s` alone: its watch writes k3s's branch again, and no other.
    const only = readPinScope('k3s');
    const heads = new WatchedHeads();
    await watch(repo, () => day(scanned, factoryMoves()), only, quiet, heads).pass();
    expect(left?.state).toBe('open');
    const q = queue(repo, only, heads);
    await q.pass();
    expect(q.enqueued.map(([number]) => number)).toEqual([told?.number]);
  });
});
