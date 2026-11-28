/**
 * The dependency sense's days, as its role appends them (`factory patching`): both repositories' moves, as each scan's
 * last finished run on main wrote them, the pins that wait, the pull requests and issues that carry each move as the
 * GitHub worker read them, and the rows its look at the cluster's pods made. Two days: the one before, whose moves the
 * last one no longer lists (one merged, one no longer listed, one closed at an older target), and the last morning,
 * when the factory's scan failed with a move due within a day and the app's passed.
 *
 * The last morning holds a move in each state Patching's sheet draws: one for each group of what waits on Martin (a
 * major the level holds, a third-party action's pull request of Dependabot's, the agent loop's bench run, a move undone
 * on main holding another with it, changes asked for, a head taken out of the queue, checks failed on every try, a
 * branch someone else holds, a refusal of the pin step, a workflow's pin, the cluster, a line no longer built, an image
 * no pin names), and of what moves by itself (checks running, in the merge queue, not judged yet, waiting its day, a
 * major clearing the rest, nothing to move to, the line's). Three of the factory's lockfile moves wait on Martin, so a
 * visitor reads them withheld.
 *
 * Every move is invented: each name is the kind of thing the factory pins, under `example`, and each version, count,
 * digest, date and number is made up. No package or advisory of a finding open on any real day is in it.
 */
import type { NewEvent } from '@software-factory/events';
import { commitFor, digestFor, uuidFor } from './build.ts';
import { WITHHELD } from './patching-withheld.ts';

type Day = NewEvent<'patching.read'>['payload'];
type Repository = Day['repositories'][number];
type Move = Repository['moves'][number];
type Pull = Repository['pulls'][number];

const FACTORY = 'the-roganator/cv-software-factory';
const APP = 'the-roganator/cv-worlds-worst-website';
const counts = (critical: number, high: number, medium: number, low: number, unknown = 0) => ({
  critical,
  high,
  medium,
  low,
  unknown,
});
const none = counts(0, 0, 0, 0);
const run = (repository: string, id: number, conclusion: string, finished: string, day: string) => ({
  id,
  event: 'schedule' as const,
  conclusion,
  commit: commitFor(`${repository}/scan/${day}`),
  finished,
  url: `https://github.com/${repository}/actions/runs/${id}`,
});
const image = (tag: string, name: string) => `image ${tag}@${digestFor(name)}`;

/** A lockfile's move is named by its file alone, as the scan's log names it; its package is apart. */
const LOCKFILE = 'a package in `pnpm-lock.yaml`';
const lockfile = (
  pkg: { name: string; from: string; to: string; line: number },
  fields: Pick<Move, 'clears' | 'lane'> & Partial<Move>,
): Move => ({
  name: LOCKFILE,
  pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
  from: '',
  to: '',
  major: false,
  leaves: none,
  newToday: 0,
  lockfile: true,
  ...fields,
  package: { name: pkg.name, from: pkg.from, to: pkg.to, pins: [{ file: 'pnpm-lock.yaml', line: pkg.line }] },
});
/** A pull request's or issue's move, by the day's name, whether it is a lockfile's, and a lockfile's package apart. */
const carries = (name: string, pkg?: string) => ({ name, lockfile: pkg !== undefined, ...(pkg && { package: pkg }) });
const checks = (
  state: 'running' | 'passed' | 'failed',
  attempt: number,
  failed: { name: string; run: number }[] = [],
) => ({
  state,
  try: attempt,
  of: 3,
  failed,
});

const TOKENS = { name: '@example/tokens', from: '3.0.1', to: '3.0.2', line: 2140 };
const WS = { name: '@example/ws', from: '8.18.2', to: '8.18.3', line: 2211 };
const SDK = { name: '@example/agent-sdk', from: '0.4.2', to: '0.4.3', line: 96 };
const HOOKS = { name: '@example/hooks', from: '2.2.1', to: '2.2.2', line: 1530 };
const WS_LIB = { name: '@example/ws-lib', from: '1.6.0', to: '1.6.2', line: 2215 };

/** The factory's moves on the last morning. */
const FACTORY_MOVES: Move[] = [
  {
    name: 'example/scanner-proxy',
    pins: [{ file: 'apps/console/zap/scan.ts', line: 32 }],
    from: `2.17.0@${digestFor('scanner-proxy/old')}`,
    to: image('2.17.0', 'scanner-proxy/new'),
    major: false,
    clears: counts(3, 112, 890, 367),
    leaves: none,
    deadline: '2026-10-06T22:40:00.000Z',
    newToday: 4,
    lane: 'worker',
    lockfile: false,
  },
  {
    name: 'example-cd',
    pins: [
      { file: 'Makefile', line: 7 },
      { file: 'mise.toml', line: 27 },
    ],
    from: '10.9.5',
    to: 'chart example-cd 10.15.0',
    major: false,
    clears: counts(2, 45, 60, 12),
    leaves: none,
    deadline: '2026-10-06T23:20:00.000Z',
    newToday: 2,
    lane: 'issue',
    lockfile: false,
  },
  {
    name: 'example-logs',
    pins: [{ file: 'deploy/base/telemetry/logs.yaml', line: 14 }],
    from: '18.13.7',
    to: 'chart example-logs 21.1.1 (a major)',
    major: true,
    clears: counts(1, 21, 30, 4),
    leaves: none,
    deadline: '2026-10-07T00:00:00.000Z',
    newToday: 0,
    lane: 'worker',
    lockfile: false,
  },
  {
    name: 'k3s',
    pins: [{ file: 'deploy/k3d/cluster.yaml', line: 8 }],
    from: 'v1.34.4+k3s1',
    to: 'k3s v1.34.5+k3s1',
    major: false,
    clears: counts(0, 21, 44, 9),
    leaves: none,
    deadline: '2026-10-11T04:16:00.000Z',
    newToday: 0,
    lane: 'cluster',
    lockfile: false,
  },
  {
    name: 'example-dashboards',
    pins: [{ file: 'deploy/base/telemetry/dashboards.yaml', line: 14 }],
    from: '13.2.7',
    to: 'chart example-dashboards 13.7.2',
    major: false,
    clears: counts(0, 8, 14, 2),
    leaves: counts(0, 2, 0, 0),
    deadline: '2026-10-11T04:16:00.000Z',
    newToday: 0,
    lane: 'worker',
    lockfile: false,
  },
  {
    name: 'example/sbom-tool',
    pins: [{ file: 'deploy/images/sbom-tool/Dockerfile', line: 6 }],
    from: 'v1.54.0',
    to: image('v1.55.1', 'sbom-tool/new'),
    major: false,
    clears: counts(0, 7, 12, 3),
    leaves: none,
    deadline: '2026-10-11T04:16:00.000Z',
    newToday: 0,
    lane: 'worker',
    lockfile: false,
  },
  {
    name: 'example/sidecar',
    pins: [
      { file: 'deploy/base/telemetry/values/dashboards.yaml', line: 31 },
      { file: 'deploy/base/telemetry/values/logs.yaml', line: 58 },
    ],
    from: '2.11.2',
    to: image('2.14.3', 'sidecar/new'),
    major: false,
    clears: counts(2, 30, 22, 6),
    leaves: none,
    deadline: '2026-10-10T04:16:00.000Z',
    newToday: 0,
    lane: 'worker',
    lockfile: false,
  },
  {
    name: 'example-metrics',
    pins: [{ file: 'deploy/base/telemetry/metrics.yaml', line: 14 }],
    from: '30.0.1',
    to: 'chart example-metrics 30.2.0',
    major: false,
    clears: counts(0, 4, 9, 2),
    leaves: none,
    deadline: '2026-10-11T04:16:00.000Z',
    newToday: 0,
    lane: 'worker',
    lockfile: false,
  },
  {
    name: 'example-traces',
    pins: [{ file: 'deploy/base/telemetry/traces.yaml', line: 14 }],
    from: '1.24.1',
    to: 'chart example-traces 1.24.3',
    major: false,
    clears: counts(0, 2, 3, 0),
    leaves: none,
    deadline: '2026-10-11T05:16:00.000Z',
    newToday: 0,
    lane: 'worker',
    lockfile: false,
  },
  {
    name: 'example/ingress',
    pins: [{ file: 'deploy/base/ingress/ingress.yaml', line: 22 }],
    from: 'v3.6.1',
    to: image('v3.6.4', 'ingress/new'),
    major: false,
    clears: counts(0, 3, 2, 1),
    leaves: none,
    deadline: '2026-10-10T05:16:00.000Z',
    newToday: 0,
    lane: 'worker',
    lockfile: false,
  },
  {
    name: 'example/scan-action',
    pins: [{ file: '.github/workflows/vulnerabilities.yml', line: 88 }],
    from: 'v4.31.2',
    to: 'version v4.31.6',
    major: false,
    clears: counts(0, 1, 0, 0),
    leaves: none,
    deadline: '2026-10-12T04:16:00.000Z',
    newToday: 0,
    lane: 'issue',
    lockfile: false,
  },
  {
    name: 'example/setup-tool',
    pins: [
      { file: '.github/workflows/check.yml', line: 31 },
      { file: '.github/workflows/build.yml', line: 44 },
      { file: '.github/workflows/vulnerabilities.yml', line: 52 },
    ],
    from: 'v6.0.0',
    to: 'version v6.1.0',
    major: false,
    clears: none,
    leaves: none,
    newToday: 0,
    lane: 'issue',
    lockfile: false,
  },
  lockfile(TOKENS, { clears: counts(0, 2, 1, 0), lane: 'worker', deadline: '2026-10-09T04:16:00.000Z' }),
  lockfile(WS, { clears: counts(0, 1, 0, 0), lane: 'worker', deadline: '2026-10-09T04:16:00.000Z' }),
  lockfile(SDK, { clears: counts(0, 1, 0, 0), lane: 'issue', deadline: '2026-10-12T04:16:00.000Z' }),
  lockfile(HOOKS, { clears: none, lane: 'worker' }),
  {
    name: 'example/cluster-proxy',
    pins: [{ file: 'mise.lock', line: 141 }],
    from: '5.9.0',
    to: '',
    major: false,
    clears: none,
    leaves: counts(0, 2, 5, 1),
    newToday: 0,
    lane: 'none',
    lockfile: false,
  },
];

/** The pull requests and issues that carry the factory's moves, as the worker read them on the last morning. */
const FACTORY_PULLS: Pull[] = [
  {
    kind: 'pin',
    number: 1342,
    moves: [carries('example/scanner-proxy')],
    opened: '2026-10-06T04:31:00.000Z',
    state: 'open',
    rule: 'move',
    checks: checks('running', 1),
    hold: 'checks',
  },
  {
    kind: 'issue',
    number: 1341,
    moves: [carries('example-cd')],
    opened: '2026-10-05T04:30:00.000Z',
    state: 'open',
    issue: 'other',
  },
  {
    kind: 'pin',
    number: 1344,
    moves: [carries('example-logs')],
    opened: '2026-10-05T04:32:00.000Z',
    state: 'open',
    rule: 'major',
    checks: checks('passed', 1),
    hold: 'level',
  },
  {
    kind: 'pin',
    number: 1345,
    moves: [carries('k3s')],
    opened: '2026-10-05T04:33:00.000Z',
    state: 'open',
    rule: 'move',
    checks: checks('passed', 1),
    hold: 'held',
  },
  {
    kind: 'pin',
    number: 1343,
    moves: [carries('example-dashboards')],
    opened: '2026-10-06T04:32:00.000Z',
    state: 'open',
    rule: 'move',
    checks: checks('passed', 1),
    queued: true,
  },
  {
    kind: 'pin',
    number: 1339,
    moves: [carries('example/sbom-tool')],
    opened: '2026-10-06T05:02:00.000Z',
    state: 'open',
    checks: checks('running', 1),
    hold: 'verdict',
  },
  {
    kind: 'pin',
    number: 1348,
    moves: [carries('example/sidecar')],
    opened: '2026-10-05T04:34:00.000Z',
    state: 'open',
    rule: 'move',
    checks: checks('failed', 3, [{ name: 'database tests', run: 19220481337 }]),
    hold: 'checks-spent',
  },
  {
    kind: 'pin',
    number: 1355,
    moves: [carries('example-metrics')],
    opened: '2026-10-04T04:35:00.000Z',
    state: 'open',
    rule: 'held',
    checks: checks('passed', 1),
    hold: 'changes-requested',
  },
  {
    kind: 'pin',
    number: 1356,
    moves: [carries('example-traces')],
    opened: '2026-10-04T04:36:00.000Z',
    state: 'open',
    rule: 'move',
    checks: checks('passed', 1),
    hold: 'dequeued',
  },
  {
    kind: 'issue',
    number: 1361,
    moves: [carries('example/ingress')],
    opened: '2026-10-05T04:37:00.000Z',
    state: 'open',
    issue: 'branch-held',
  },
  {
    kind: 'issue',
    number: 1347,
    moves: [carries('example/scan-action')],
    opened: '2026-10-05T04:38:00.000Z',
    state: 'open',
    issue: 'workflow',
  },
  {
    kind: 'dependabot',
    number: 1350,
    moves: [carries('example/setup-tool')],
    opened: '2026-10-05T09:12:00.000Z',
    state: 'open',
    checks: checks('passed', 1),
    hold: 'martin',
  },
  // The pin watch's issue for the same routine workflow pin: the row stands by Dependabot's, which is his to merge.
  {
    kind: 'issue',
    number: 1351,
    moves: [carries('example/setup-tool')],
    opened: '2026-10-05T04:39:00.000Z',
    state: 'open',
    issue: 'workflow',
  },
  {
    kind: 'issue',
    number: 1357,
    moves: [carries(LOCKFILE, TOKENS.name), carries(LOCKFILE, WS.name)],
    opened: '2026-10-05T04:40:00.000Z',
    state: 'open',
    issue: 'reverted',
  },
  {
    kind: 'issue',
    number: 1352,
    moves: [carries(LOCKFILE, SDK.name)],
    opened: '2026-10-04T04:41:00.000Z',
    state: 'open',
    issue: 'bench',
  },
  {
    kind: 'issue',
    number: 1211,
    moves: [carries(LOCKFILE, HOOKS.name)],
    opened: '2026-10-05T04:42:00.000Z',
    state: 'open',
    issue: 'refused',
    refusal: 'provenance',
  },
  // Settled since the day before: one merged, one at a lockfile, and one the worker closed for a newer target.
  {
    kind: 'pin',
    number: 1336,
    moves: [carries('example/old-sidecar')],
    opened: '2026-10-04T04:30:00.000Z',
    state: 'merged',
    settled: '2026-10-05T16:20:00.000Z',
    rule: 'move',
  },
  {
    kind: 'pin',
    number: 1327,
    moves: [carries(LOCKFILE, WS_LIB.name)],
    opened: '2026-10-04T04:31:00.000Z',
    state: 'merged',
    settled: '2026-10-05T12:00:00.000Z',
    rule: 'move',
  },
  {
    kind: 'pin',
    number: 1180,
    moves: [carries('example-dashboards')],
    opened: '2026-10-04T04:32:00.000Z',
    state: 'closed',
    settled: '2026-10-06T04:31:00.000Z',
    closedByPerson: false,
  },
];

/** The app's moves on the last morning: two the line carries, and a line no longer built. */
const APP_MOVES: Move[] = [
  {
    name: LOCKFILE,
    pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
    from: '',
    to: '',
    major: false,
    clears: counts(1, 0, 0, 1),
    leaves: none,
    deadline: '2026-10-08T00:20:00.000Z',
    newToday: 0,
    lane: 'line',
    lockfile: true,
    package: WITHHELD,
  },
  {
    name: 'example/node-base',
    pins: [{ file: 'Dockerfile', line: 3 }],
    from: '24.9.0-slim',
    to: image('24.9.1-slim', 'node-base/new'),
    major: false,
    clears: counts(0, 1, 0, 0),
    leaves: none,
    deadline: '2026-10-13T04:20:00.000Z',
    newToday: 0,
    lane: 'line',
    lockfile: false,
  },
  {
    name: 'example/devcontainer-base',
    pins: [{ file: '.devcontainer/Dockerfile', line: 1 }],
    from: 'ubuntu-24.04',
    to: 'another line (this one last built 2026-03-02T00:00:00Z)',
    major: false,
    clears: none,
    leaves: counts(0, 0, 0, 0),
    newToday: 0,
    lane: 'none',
    lockfile: false,
  },
];

const factory = (day: string, finished: string, fields: Partial<Repository>): Repository => ({
  repository: FACTORY,
  run: run(FACTORY, day === '2026-10-06' ? 1834977 : 1832101, 'failure', finished, day),
  judged: new Date(Date.parse(finished) - 60_000).toISOString(),
  failed: ['due-within-a-day', 'new-high-or-critical'],
  totals: {
    fixed: 1690,
    moves: 18,
    lanes: { line: 0, worker: 12, cluster: 1, issue: 4, none: 1 },
    noFix: 14844,
    excepted: 0,
    overdue: 0,
    dueWithinDay: 6,
    newHighWithFix: 6,
    newHighWithoutFix: 35,
    open: counts(12, 1388, 11021, 4087),
  },
  scanned: 52,
  moves: [],
  waiting: [],
  pulls: [],
  ...fields,
});

const app = (day: string, finished: string, fields: Partial<Repository>): Repository => ({
  repository: APP,
  run: run(APP, day === '2026-10-06' ? 1834981 : 1832105, 'success', finished, day),
  judged: new Date(Date.parse(finished) - 60_000).toISOString(),
  failed: [],
  totals: {
    fixed: 3,
    moves: 3,
    lanes: { line: 2, worker: 0, cluster: 0, issue: 0, none: 1 },
    noFix: 212,
    excepted: 0,
    overdue: 0,
    dueWithinDay: 0,
    newHighWithFix: 0,
    newHighWithoutFix: 0,
    open: counts(0, 4, 120, 91),
  },
  scanned: 6,
  moves: [],
  waiting: [],
  pulls: [],
  ...fields,
});

/** What the sense found running that no pin names. */
const UNLISTED: Day['rows'] = [
  {
    row: 'unlisted-image',
    namespace: 'default',
    pod: 'debug-shell-7c9f',
    container: 'shell',
    image: 'example/debug-shell:1.4',
    digest: digestFor('debug-shell/running'),
  },
];

/**
 * The day before: what the last morning no longer lists. A move the worker merged, a lockfile's it merged, one the
 * scan stopped listing with nothing merged, and example-dashboards at an older target, which the worker closed.
 */
export const PATCHING_BEFORE: NewEvent<'patching.read'> = {
  id: uuidFor('patching/2026-10-05'),
  ts: '2026-10-05T05:10:00.000Z',
  work_item: null,
  type: 'patching.read',
  version: 5,
  actor: 'factory',
  summary: 'The day’s moves: 5 in the factory, 1 in the app; 1 unscanned image running',
  payload: {
    repositories: [
      factory('2026-10-05', '2026-10-05T04:17:00.000Z', {
        moves: [
          {
            name: 'example/old-sidecar',
            pins: [{ file: 'deploy/base/telemetry/values/logs.yaml', line: 41 }],
            from: '2.9.0',
            to: image('2.11.2', 'old-sidecar/new'),
            major: false,
            clears: counts(2, 30, 22, 6),
            leaves: none,
            deadline: '2026-10-08T04:16:00.000Z',
            newToday: 0,
            lane: 'worker',
            lockfile: false,
          },
          {
            name: 'example/runtime',
            pins: [{ file: 'apps/factory/Dockerfile', line: 41 }],
            from: `nonroot@${digestFor('runtime/old')}`,
            to: image('nonroot', 'runtime/new'),
            major: false,
            clears: counts(1, 2, 0, 0),
            leaves: none,
            deadline: '2026-10-09T04:16:00.000Z',
            newToday: 0,
            lane: 'worker',
            lockfile: false,
          },
          {
            name: 'example-dashboards',
            pins: [{ file: 'deploy/base/telemetry/dashboards.yaml', line: 14 }],
            from: '13.2.7',
            to: 'chart example-dashboards 13.5.0',
            major: false,
            clears: counts(0, 6, 9, 1),
            leaves: counts(0, 4, 5, 1),
            deadline: '2026-10-11T04:16:00.000Z',
            newToday: 0,
            lane: 'worker',
            lockfile: false,
          },
          lockfile(WS_LIB, { clears: counts(0, 1, 0, 0), lane: 'worker', deadline: '2026-10-10T04:16:00.000Z' }),
          FACTORY_MOVES.find((move) => move.name === 'k3s') as Move,
        ],
      }),
      app('2026-10-05', '2026-10-05T04:21:00.000Z', { moves: [APP_MOVES[1] as Move] }),
    ],
    compared: true,
    containers: 61,
    rows: UNLISTED,
  },
  artifacts: [],
};

/** The last morning. */
export const PATCHING: NewEvent<'patching.read'> = {
  id: uuidFor('patching/2026-10-06'),
  ts: '2026-10-06T05:12:00.000Z',
  work_item: null,
  type: 'patching.read',
  version: 5,
  actor: 'factory',
  summary: 'The day’s moves: 18 in the factory, 3 in the app; 1 unscanned image running',
  payload: {
    repositories: [
      factory('2026-10-06', '2026-10-06T04:17:00.000Z', {
        moves: FACTORY_MOVES,
        waiting: [
          {
            name: 'example/cache',
            pins: [{ file: 'deploy/base/cache/cache.yaml', line: 17 }],
            from: '8.2.2',
            why: 'content',
            to: image('8.2.3', 'cache/new'),
            until: '2026-10-06T18:40:00.000Z',
            clears: counts(0, 1, 2, 0),
            deadline: '2026-10-12T04:16:00.000Z',
          },
          {
            name: 'example/store-cache',
            pins: [{ file: 'deploy/base/cache/store-cache.yaml', line: 19 }],
            from: '8.1.3-alpine',
            why: 'no-better',
            clears: counts(1, 4, 0, 0),
            deadline: '2026-10-07T10:16:00.000Z',
          },
        ],
        pulls: FACTORY_PULLS,
      }),
      app('2026-10-06', '2026-10-06T04:21:00.000Z', {
        moves: APP_MOVES,
        pulls: [
          {
            kind: 'issue',
            number: 81,
            moves: [carries('example/devcontainer-base')],
            opened: '2026-10-04T04:22:00.000Z',
            state: 'open',
            issue: 'none',
          },
        ],
      }),
    ],
    read: '2026-10-06T05:12:00.000Z',
    compared: true,
    containers: 61,
    rows: UNLISTED,
  },
  artifacts: [],
};
