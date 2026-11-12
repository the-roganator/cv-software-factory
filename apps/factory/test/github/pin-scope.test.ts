/**
 * The pin watch reads PIN_WATCH_ONLY by a move's exact name (`named.has(move.name)`, pins.ts), and so does the pin
 * queue (`toldWait`, deploy-queue.ts): by the branch the watch opens for that name and the title it gives it. A setting
 * whose name no move has, but which folds to the branch of a pull request left open from an earlier setting, opens
 * nothing and queues nothing.
 *
 * The watch and the queue are the real ones, over one fake repository. The gate's verdict and the checks are stubbed
 * as passing: what is shown is which pull request the queue takes, not what the gate would say of it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { type Logger, pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { APP_LOGIN, LiveActions } from '../../src/github/actions.ts';
import { dependencyPulls } from '../../src/github/dependabot.ts';
import { type DeployQueueDependencies, pinQueueWatch, toldWait } from '../../src/github/deploy-queue.ts';
import { APP_USER, IssueGuard, openedBy } from '../../src/github/issues.ts';
import { PASS_MS, type PinScope, pinWatch, readPinScope } from '../../src/github/pins.ts';
import { RefusalRecorder } from '../../src/github/refusals.ts';
import type { Moves } from '../../src/github/scanning.ts';
import { client, quiet, type Route, type Sent } from './fake.ts';
import { day, FACTORY, FakeRepo, FILES, factoryMoves, writes } from './pins-harness.ts';

const REQUIRED = ['lint, types, tests', 'image builds', 'review'];

/** The real pin watch over the fake repository, as pins.test.ts runs it. */
function watch(repo: FakeRepo, today: () => Moves, only: PinScope, log: Logger = quiet) {
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
  const pass = pinWatch({ github, reads, actions, recorder, log, now: () => clock, only }, FACTORY);
  return {
    sent,
    pass: async () => {
      clock += PASS_MS;
      await pass();
    },
  };
}

/** The real pin queue over the same repository: its list and events as GitHub would give them, the gate passing. */
function queue(repo: FakeRepo, only: PinScope) {
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
  const actions = {
    enqueuePullRequest: async (_repo: string, number: number, at: string) => {
      enqueued.push([number, at]);
      return { position: 1, state: 'QUEUED' };
    },
  };
  return { pass: pinQueueWatch({ github, reads, actions, log: quiet }, FACTORY, only), enqueued };
}

const heard = () => {
  const lines: { msg: string; [key: string]: unknown }[] = [];
  const log = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line)) });
  return { log, lines };
};

describe('PIN_WATCH_ONLY, read the same by the watch and the queue', () => {
  // Each is a setting whose name no move of the day has: the watch says so, and takes none.
  const SETTINGS = ['Example-Dashboards', 'example_dashboards', 'example-dashboards*', 'example dashboards'];

  for (const setting of SETTINGS) {
    it(`PIN_WATCH_ONLY=${JSON.stringify(setting)}: the watch takes no move, and the queue adds nothing`, async () => {
      const repo = new FakeRepo(FILES);
      const scanned = repo.main;
      // An earlier setting, every move: the watch opens each, labelled pin by the App.
      await watch(repo, () => day(scanned, factoryMoves()), '*').pass();
      const left = repo.pulls.find((p) => p.head === 'factory/pin/example-dashboards');
      expect(left).toMatchObject({ state: 'open', labels: ['pin'], user: APP_LOGIN });

      // The setting now, read as config.ts reads it.
      const only = readPinScope(setting);
      expect(only).toEqual([setting]);
      const { log, lines } = heard();
      const narrowed = watch(repo, () => day(scanned, factoryMoves()), only, log);
      await narrowed.pass();
      // The watch: the name is no move's. It takes none, and writes nothing.
      expect(lines.find((l) => /pin watch takes/.test(l.msg))).toMatchObject({ taken: 0, unknown: [setting] });
      expect(writes(narrowed.sent)).toEqual([]);

      // The queue, given the same setting, as service.ts gives it: no move the watch takes, none it adds.
      const q = queue(repo, only);
      await q.pass();
      expect(q.enqueued).toEqual([]);
    });
  }

  it('control: a setting that names another move leaves example-dashboards’ pull request out of the queue', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    await watch(repo, () => day(scanned, factoryMoves()), '*').pass();
    const left = repo.pulls.find((p) => p.head === 'factory/pin/example-dashboards');
    const q = queue(repo, readPinScope('k3s'));
    await q.pass();
    expect(q.enqueued.map(([number]) => number)).not.toContain(left?.number);
    expect(q.enqueued).toHaveLength(1);
  });

  it('two moves that fold to one branch: the watch refuses the named one, and the queue adds neither', async () => {
    // A second chart, `example_dashboards`, pinned on a line of its own: another move, whose name folds to the branch
    // of `example-dashboards`.
    const repo = new FakeRepo({
      ...FILES,
      'deploy/base/telemetry/other.yaml': ['spec:', '  source:', '    targetRevision: 13.2.7', ''].join('\n'),
    });
    const scanned = repo.main;
    const first = factoryMoves();
    await watch(repo, () => day(scanned, first), '*').pass();
    const theirs = repo.pulls.find((p) => p.head === 'factory/pin/example-dashboards');
    expect(theirs).toMatchObject({ state: 'open', title: 'chore(pin): move example-dashboards to 13.7.2' });

    // Martin names the other chart alone. Both are in the day's scan.
    const dashboards = first.find((m) => m.name === 'example-dashboards');
    if (!dashboards) throw new Error('the fixture has no example-dashboards');
    const rival = {
      ...dashboards,
      name: 'example_dashboards',
      pins: [{ file: 'deploy/base/telemetry/other.yaml', line: 3 }],
    };
    const only = readPinScope('example_dashboards');
    const { log, lines } = heard();
    const narrowed = watch(repo, () => day(scanned, [...first, rival]), only, log);
    await narrowed.pass();
    const refused = lines.find((l) => /pin guard refused/.test(l.msg)) as { err?: { message?: string } } | undefined;
    expect(refused?.err?.message).toMatch(/make one branch, factory\/pin\/example-dashboards: neither is opened/);
    expect(writes(narrowed.sent)).toEqual([]);
    expect(theirs?.state).toBe('open');

    // The queue, told `example_dashboards` alone, leaves the pull request that moves `example-dashboards`.
    const q = queue(repo, only);
    await q.pass();
    expect(q.enqueued).toEqual([]);
  });

  it('two different move names are two names to the queue, though they fold to one branch', () => {
    // Each pair: the name set, and the branch of another move's pull request it also names.
    const pairs: [string, string][] = [
      ['docker.io/library/postgres', 'factory/pin/docker.io-library-postgres'],
      ['docker.io library postgres', 'factory/pin/docker.io-library-postgres'],
      ['DOCKER.IO/LIBRARY/POSTGRES', 'factory/pin/docker.io-library-postgres'],
      ['docker.io/library/postgres!!', 'factory/pin/docker.io-library-postgres'],
      ['postgres*', 'factory/pin/postgres'],
      ['*postgres', 'factory/pin/postgres'],
      ['a.lock', 'factory/pin/a.lock-pin'],
      ['a.lock-pin', 'factory/pin/a.lock-pin'],
      [`${'x'.repeat(80)}-one`, `factory/pin/${'x'.repeat(80)}`],
      [`${'x'.repeat(80)}-two`, `factory/pin/${'x'.repeat(80)}`],
    ];
    // The pull request of the move named by the branch's own name, as the watch titles it: the other name is not it.
    const named: Record<string, string> = {
      'factory/pin/docker.io-library-postgres': 'docker.io/library/postgres',
      'factory/pin/postgres': 'postgres',
      'factory/pin/a.lock-pin': 'a.lock',
      [`factory/pin/${'x'.repeat(80)}`]: `${'x'.repeat(80)}-one`,
    };
    for (const [name, branch] of pairs) {
      const pull = { title: `chore(pin): move ${named[branch]} to 2.0.0`, head: { ref: branch, sha: '', repo: null } };
      const wait = toldWait(readPinScope(name), pull);
      if (name === named[branch]) expect(wait, name).toBeUndefined();
      else expect(wait?.waits, name).toBe('not-a-pin');
    }
  });
});
