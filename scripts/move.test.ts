import { describe, expect, it } from 'vitest';
import type { Move as PinStepMove } from '../apps/runner/src/pins.ts';
import {
  type Changed,
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
