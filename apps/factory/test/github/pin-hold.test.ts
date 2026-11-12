/**
 * Martin holds a pin move by taking its `pin` label off (ADR 0017, `labelWait`). A day the scan does not list the
 * move, the pin watch closes the pull request; when the scan lists it again, to the same target, the watch opens a new
 * one, whose own events hold nothing. The queue carries the hold to it from the closed one (`heldBefore`).
 *
 * The watch and the queue are the real ones, over one fake repository; the gate's verdict and the checks are stubbed as
 * passing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import { APP_LOGIN, LiveActions } from '../../src/github/actions.ts';
import { WatchedHeads } from '../../src/github/branches.ts';
import { dependencyPulls } from '../../src/github/dependabot.ts';
import { type DeployQueueDependencies, type LabelEvents, pinQueueWatch } from '../../src/github/deploy-queue.ts';
import { APP_USER, IssueGuard, MARTIN, openedBy } from '../../src/github/issues.ts';
import { PASS_MS, type PinScope, pinWatch, readPinScope } from '../../src/github/pins.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import type { Moves } from '../../src/github/scanning.ts';
import { client, quiet, type Route } from './fake.ts';
import { day, FACTORY, FakeRepo, FILES, factoryMoves } from './pins-harness.ts';

const REQUIRED = ['lint, types, tests', 'image builds', 'review'];

/** One worker: the pin watch and the pin queue, told the same moves, over one repository whose day a test sets. */
function worker(repo: FakeRepo, only: PinScope, today: () => Moves) {
  /** The events GitHub keeps of each pull request's labels; one with none kept was labelled by the App alone. */
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
      // The App's label, given through the API, is an event of the pull request's.
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
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'redteam3-hold-')));
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
    /** One pass of each, an hour on: the watch, then the queue. */
    pass: async () => {
      clock += PASS_MS;
      await watch();
      await queue();
    },
  };
}

describe('Martin’s hold of a pin move, by its label', () => {
  it('holds when the scan leaves the move out for a day and the watch opens it again to the same target', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    let moves = factoryMoves();
    const only = readPinScope('example-dashboards');
    const w = worker(repo, only, () => day(scanned, moves));
    const open = () => repo.pulls.filter((p) => p.head === 'factory/pin/example-dashboards' && p.state === 'open');

    // Martin takes the label off the watch's pull request before the queue's first pass.
    await pinFirst(repo, only, scanned);
    const [first] = open();
    if (!first) throw new Error('the pin watch opened nothing');
    first.labels = [];
    w.events.set(first.number, [
      { event: 'labeled', actor: { id: APP_USER }, label: { name: 'pin' } },
      { event: 'unlabeled', actor: { id: MARTIN }, label: { name: 'pin' } },
    ]);

    // The watch puts the label back, and the queue holds it, pass after pass: the hold works.
    await w.pass();
    await w.pass();
    expect(first.labels).toEqual(['pin']);
    expect(w.enqueued).toEqual([]);

    // A day the scan does not list the move: the watch closes its pull request.
    moves = factoryMoves().filter((m) => m.name !== 'example-dashboards');
    await w.pass();
    expect(first.state).toBe('closed');
    expect(w.enqueued).toEqual([]);

    // The scan lists it again, to the same target: a new pull request, and Martin's hold is carried to it.
    moves = factoryMoves();
    await w.pass();
    await w.pass();
    const [second] = open();
    expect(second?.number).not.toBe(first.number);
    expect(second?.title).toBe(first.title);
    expect(w.enqueued).toEqual([]);
  });
});

/** The watch's first pass alone, before any queue pass: the pull request Martin then holds. */
async function pinFirst(repo: FakeRepo, only: PinScope, scanned: string) {
  const { github } = client(repo.routes());
  const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'redteam3-hold-')));
  const recorder = new RefusalRecorder({ artifacts, log: quiet });
  const guard = new IssueGuard({ openedBy: openedBy(github), recorder });
  await pinWatch(
    {
      github,
      reads: {
        moves: async () => day(scanned, factoryMoves()),
        dependencyPulls: (r: string) => dependencyPulls(github, r, async () => 'version: 2\nupdates: []\n'),
      },
      actions: new LiveActions(github, { guard }),
      recorder,
      log: quiet,
      only,
    },
    FACTORY,
  )();
}
