import { describe, expect, it } from 'vitest';
import type { Target } from '../../src/vulnerabilities/fixes.ts';
import {
  APP,
  type Context,
  dependabotDirectories,
  directPackages,
  furthest,
  isMajor,
  type Judged,
  MOVES_VERSION,
  moves,
  movesFile,
  table,
} from '../../src/vulnerabilities/moves.ts';
import type { Finding, Severity } from '../../src/vulnerabilities/sarif.ts';

/**
 * The day's results grouped into moves (moves.ts), on invented results: the plan's tests for it
 * (docs/PLAN/M07-ADMIN-AND-GUARDRAILS.md, task 31) that a pure function can show.
 */
const NOW = Date.parse('2026-11-10T04:30:00Z');
const DAY = 86_400_000;
const REPOSITORY = 'the-roganator/cv-software-factory';
const DIGEST = `sha256:${'e'.repeat(64)}`;
const context = (over: Partial<Context> = {}): Context => ({
  repository: REPOSITORY,
  app: false,
  dependabot: ['/apps/factory', '/deploy/base/postgres'],
  direct: new Set(['example-a']),
  now: NOW,
  ...over,
});

let advisory = 30000;
/** One judged result: a High in an image, fixed by a newer one on its line, unless told otherwise. */
const result = (
  over: Partial<Omit<Judged, 'finding'>> & {
    target?: Target | undefined;
    severity?: Severity;
    finding?: Partial<Finding>;
  } = {},
): Judged => {
  const { target: given, finding, ...rest } = over;
  // A target given as undefined is a result with no fix.
  const target: Target | undefined = 'target' in over ? given : { kind: 'image', tag: '2.17.0', digest: DIGEST };
  const id = `CVE-2099-${advisory++}`;
  return {
    finding: {
      item: 'deploy/x.yaml example/image',
      label: 'example/image:2.17.0',
      file: 'deploy/x.yaml',
      line: 3,
      type: 'debian',
      package: 'libexample',
      installed: '1.0-1',
      fixed: '1.0-2',
      advisory: id,
      severity: over.severity ?? 'HIGH',
      fix: target ? { target, day: NOW - 3 * DAY } : undefined,
      ...finding,
    },
    severity: 'HIGH',
    excepted: false,
    due: target ? NOW + 4 * DAY : undefined,
    firstSeenToday: false,
    kind: 'third-party',
    name: 'example/image',
    pin: { file: 'deploy/x.yaml', line: 3 },
    from: '2.17.0',
    ...rest,
  };
};

describe('the day’s moves', () => {
  it('makes one move of every result on one pin with one target, and counts what it clears and leaves', () => {
    const list = moves(
      [
        result({ severity: 'CRITICAL', due: NOW + DAY }),
        result({ firstSeenToday: true }),
        result({ severity: 'MEDIUM', due: NOW + 20 * DAY }),
        result({ target: undefined, severity: 'LOW' }),
        result({ excepted: true }),
      ],
      context(),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: 'example/image',
      from: '2.17.0',
      to: { kind: 'image', tag: '2.17.0', digest: DIGEST },
      pins: [{ file: 'deploy/x.yaml', line: 3 }],
      clears: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 0, UNKNOWN: 0 },
      leaves: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1, UNKNOWN: 0 },
      deadline: NOW + DAY,
      newToday: 1,
    });
    expect(list[0]?.results).toHaveLength(3);
  });

  it('makes a move of three pins of one image (Node’s, in three Dockerfiles)', () => {
    const node = (file: string) =>
      result({
        kind: 'dockerfile',
        name: 'node',
        from: '24.22.1-trixie-slim',
        pin: { file, line: 11 },
        target: { kind: 'image', tag: '24.23.0-trixie-slim', digest: DIGEST },
        finding: { file, line: 11, item: `${file} node` },
      });
    const list = moves(
      [node('apps/factory/Dockerfile'), node('apps/runner/Dockerfile'), node('apps/console/Dockerfile')],
      context({ dependabot: ['/apps/factory', '/apps/runner', '/apps/console'] }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.pins).toEqual([
      { file: 'apps/console/Dockerfile', line: 11 },
      { file: 'apps/factory/Dockerfile', line: 11 },
      { file: 'apps/runner/Dockerfile', line: 11 },
    ]);
  });

  it('makes two moves of two charts that run one image', () => {
    const sidecar = (chart: string) =>
      result({
        kind: 'chart',
        name: `${chart}: quay.io/kiwigrid/k8s-sidecar`,
        from: '2.14.3',
        pin: { file: `deploy/base/telemetry/values/${chart}.yaml`, line: 32 },
        target: { kind: 'image', tag: '2.14.4', digest: DIGEST },
      });
    const list = moves([sidecar('grafana'), sidecar('loki')], context());
    expect(list.map((move) => move.name)).toEqual([
      'grafana: quay.io/kiwigrid/k8s-sidecar',
      'loki: quay.io/kiwigrid/k8s-sidecar',
    ]);
    // A value's pin moves forward on its line: the worker's.
    expect(list.map((move) => move.lane)).toEqual(['worker', 'worker']);
  });

  it('makes one move of a package in two versions', () => {
    const copy = (installed: string, line: number) =>
      result({
        kind: 'lockfile',
        name: 'example-a',
        from: '1.0.0, 2.0.0',
        pin: { file: 'pnpm-lock.yaml', line },
        target: { kind: 'version', versions: ['1.0.1', '2.0.3'] },
        finding: { type: 'pnpm', package: 'example-a', installed, file: 'pnpm-lock.yaml', line },
      });
    const list = moves([copy('1.0.0, 2.0.0', 120)], context());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ lockfile: true, to: { kind: 'version', versions: ['1.0.1', '2.0.3'] } });
  });

  describe('each lane, worked out', () => {
    const laneOf = (judged: Judged, over: Partial<Context> = {}) => moves([judged], context(over))[0]?.lane;

    it('none: a line no longer built, which has nowhere to move to', () => {
      expect(laneOf(result({ target: { kind: 'unbuilt', built: NOW - 400 * DAY }, due: undefined }))).toBe('none');
    });
    it('line: the app’s', () => {
      expect(laneOf(result(), { repository: APP, app: true })).toBe('line');
    });
    it('cluster: k3s', () => {
      expect(
        laneOf(result({ kind: 'k3s-release', name: 'k3s', target: { kind: 'k3s', release: 'v1.37.2+k3s1' } })),
      ).toBe('cluster');
    });
    it('approval: a major, of any kind; a chart within its major is the worker’s, even in a directory Dependabot reads', () => {
      const chart = (major: boolean) =>
        result({
          kind: 'chart',
          name: 'grafana',
          pin: { file: 'deploy/base/telemetry/grafana.yaml', line: 14 },
          target: { kind: 'chart', chart: 'grafana', version: major ? '14.3.1' : '13.7.0', major },
          severity: 'MEDIUM',
          due: NOW + 20 * DAY,
        });
      expect(laneOf(chart(true))).toBe('approval');
      expect(laneOf(chart(false), { dependabot: ['/deploy/base/telemetry'] })).toBe('worker');
      expect(moves([chart(true)], context())[0]?.major).toBe(true);
    });
    it('issue: what mise pins, a workflow, a tool', () => {
      expect(laneOf(result({ kind: 'k3d', pin: { file: 'mise.lock', line: 40 } }))).toBe('issue');
      expect(laneOf(result({ kind: 'chart', name: 'argocd', pin: { file: 'Makefile', line: 7 } }))).toBe('issue');
      // Argo CD's chart, which the Makefile pins, even at a major.
      expect(
        laneOf(
          result({
            kind: 'chart',
            name: 'argocd',
            pin: { file: 'Makefile', line: 7 },
            target: { kind: 'chart', chart: 'argo-cd', version: '11.0.0', major: true },
          }),
        ),
      ).toBe('issue');
      expect(laneOf(result({ kind: 'workflow', pin: { file: '.github/workflows/check.yml', line: 30 } }))).toBe(
        'issue',
      );
      expect(
        laneOf(result({ kind: 'ours', name: 'pnpm', target: { kind: 'tool', tool: 'pnpm', version: '12.17.0' } })),
      ).toBe('issue');
    });
    it('a lockfile’s package: Dependabot’s while direct and within its day, else an issue', () => {
      const npm = (name: string, over: Partial<Judged> = {}) => {
        const each = result({
          kind: 'lockfile',
          name,
          from: '1.0.0',
          pin: { file: 'pnpm-lock.yaml', line: 120 },
          target: { kind: 'version', versions: ['1.0.1'] },
          ...over,
        });
        return each;
      };
      const recent = npm('example-a');
      if (recent.finding.fix) recent.finding.fix.day = NOW - DAY / 2;
      expect(laneOf(recent)).toBe('dependabot');
      // Dependabot has had its day.
      expect(laneOf(npm('example-a'))).toBe('issue');
      // An indirect package.
      const indirect = npm('example-b');
      if (indirect.finding.fix) indirect.finding.fix.day = NOW - DAY / 2;
      expect(laneOf(indirect)).toBe('issue');
      // An image of ours with the same package: its other half is the lockfile.
      const both = [
        recent,
        {
          ...npm('example-a', { pin: { file: 'deploy/overlays/local/image/kustomization.yaml', line: 9 } }),
          finding: recent.finding,
        },
      ];
      expect(moves(both, context())[0]?.lane).toBe('issue');
    });
    it('dependabot: a pin its docker entries read, with no High or Critical on a deadline; else the worker', () => {
      const postgres = (severity: Severity, due?: number) =>
        result({ severity, due, name: 'postgres', pin: { file: 'deploy/base/postgres/statefulset.yaml', line: 20 } });
      expect(laneOf(postgres('MEDIUM', NOW + 20 * DAY))).toBe('dependabot');
      expect(laneOf(postgres('HIGH', undefined))).toBe('dependabot');
      expect(laneOf(postgres('HIGH', NOW + 4 * DAY))).toBe('worker');
      expect(laneOf(result())).toBe('worker');
    });
  });

  it('prints a lockfile’s move by its file alone: no package, version or line', () => {
    const lockfile = result({
      kind: 'lockfile',
      name: 'example-secret',
      from: '1.0.0',
      pin: { file: 'pnpm-lock.yaml', line: 4242 },
      target: { kind: 'version', versions: ['1.0.1'] },
      finding: { type: 'pnpm', package: 'example-secret', file: 'pnpm-lock.yaml', line: 4242 },
    });
    const file = movesFile(moves([lockfile, result()], context()), context());
    const text = JSON.stringify(file) + table(file).join('\n');
    expect(text).not.toContain('example-secret');
    expect(text).not.toContain('4242');
    expect(text).not.toContain('1.0.1');
    expect(file.moves.find((move) => move.name === 'a package in `pnpm-lock.yaml`')).toMatchObject({
      pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
      from: '',
      to: '',
      lockfile: true,
    });
    expect(file.moves.find((move) => move.name === 'example/image')?.lockfile).toBe(false);
    expect(file).toMatchObject({ version: MOVES_VERSION, repository: REPOSITORY, totals: { fixed: 2, moves: 2 } });
    expect(file.scanned).toEqual([]);
    expect(table(file)).toContain(
      `| example/image | 2.17.0 | image 2.17.0@${DIGEST} | 1 high | nothing | 0 | 2026-11-14T04:30:00Z | worker |`,
    );
  });

  it('puts the earliest deadline first', () => {
    const list = moves(
      [result({ name: 'later', due: NOW + 9 * DAY }), result({ name: 'sooner', due: NOW + DAY })],
      context(),
    );
    expect(list.map((move) => move.name)).toEqual(['sooner', 'later']);
  });
});

describe('what the lanes are read from', () => {
  it('reads dependabot.yml’s docker directories, and no other ecosystem’s', () => {
    const text = [
      'version: 2',
      'updates:',
      '  - package-ecosystem: npm',
      '    directory: /',
      '  - package-ecosystem: docker',
      '    directory: /apps/factory # the factory',
      '  - package-ecosystem: docker',
      '    directories:',
      '      - /apps/console',
      "      - '/deploy/base/postgres'",
      '    schedule:',
      '      interval: weekly',
      '  - package-ecosystem: github-actions',
      '    directory: /',
    ].join('\n');
    expect(dependabotDirectories(text)).toEqual(['/apps/factory', '/apps/console', '/deploy/base/postgres']);
  });

  it('reads a lockfile’s direct dependencies from its importers alone', () => {
    const lockfile = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    devDependencies:',
      '      example-a:',
      '        specifier: ^1.0.0',
      '        version: 1.0.0',
      '  apps/factory:',
      '    dependencies:',
      "      '@example/b':",
      '        specifier: ^2.0.0',
      '        version: 2.0.0',
      'packages:',
      '  example-c@3.0.0:',
      '    resolution: {}',
    ].join('\n');
    expect([...directPackages(lockfile)]).toEqual(['example-a', '@example/b']);
  });
});

describe('one pin with several targets', () => {
  it('is one move, to the furthest target any of its results needs', () => {
    const chart = (version: string, major: boolean) =>
      result({
        kind: 'chart',
        name: 'grafana',
        from: '13.2.7',
        target: { kind: 'chart', chart: 'grafana', version, major },
      });
    const list = moves([chart('13.7.0', false), chart('14.4.1', true), chart('14.4.1', true)], context());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      to: { kind: 'chart', version: '14.4.1', major: true },
      major: true,
      lane: 'approval',
    });
    expect(list[0]?.clears.HIGH).toBe(3);
  });
});

describe('a pin’s target, joined', () => {
  it('keeps a fix for each copy of a package in two versions', () => {
    expect(
      furthest([
        { kind: 'version', versions: ['1.0.1', '2.0.1'] },
        { kind: 'version', versions: ['1.0.5', '2.0.0'] },
      ]),
    ).toEqual({ kind: 'version', versions: ['1.0.5', '2.0.1'] });
  });

  it('reads dependabot.yml’s globs', () => {
    const pin = { file: 'apps/console/Dockerfile', line: 1 };
    const list = moves(
      [result({ pin, severity: 'MEDIUM', due: NOW + 20 * DAY })],
      context({ dependabot: ['/apps/*'] }),
    );
    expect(list[0]?.lane).toBe('dependabot');
    expect(moves([result({ pin, severity: 'MEDIUM' })], context({ dependabot: ['/deploy/**'] }))[0]?.lane).toBe(
      'worker',
    );
  });
});

describe('a major, of any kind', () => {
  it('is a chart’s later major, or a version past every copy’s major', () => {
    expect(isMajor({ kind: 'chart', chart: 'grafana', version: '14.3.1', major: true }, '13.2.7')).toBe(true);
    expect(isMajor({ kind: 'version', versions: ['4.0.1'] }, '3.2.0')).toBe(true);
    expect(isMajor({ kind: 'version', versions: ['1.0.5', '2.0.1'] }, '1.0.0, 2.0.0')).toBe(false);
    expect(isMajor({ kind: 'version', versions: ['3.2.1'] }, '3.2.0')).toBe(false);
    expect(isMajor({ kind: 'image', tag: '24.23.0-trixie-slim', digest: `sha256:${'a'.repeat(64)}` }, '24.22.1')).toBe(
      false,
    );
    const npm = result({
      kind: 'lockfile',
      name: 'example-a',
      from: '3.2.0',
      pin: { file: 'pnpm-lock.yaml', line: 9 },
      target: { kind: 'version', versions: ['4.0.1'] },
    });
    expect(moves([npm], context())[0]).toMatchObject({ major: true, lane: 'approval' });
  });
});
