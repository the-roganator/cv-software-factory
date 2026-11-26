import { describe, expect, it } from 'vitest';
import type { Target } from '../../src/vulnerabilities/fixes.ts';
import {
  APP,
  type Behind,
  type Context,
  furthest,
  isMajor,
  isRoutine,
  type Judged,
  MOVES_VERSION,
  moves,
  movesFile,
  publicMove,
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
      context(),
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
    it('line, in the app: an image under deploy/ as one at the root, on a deadline or not', () => {
      const app = { repository: APP, app: true };
      const syft = { pin: { file: 'deploy/images/syft/Dockerfile', line: 5 } };
      expect(laneOf(result(syft), app)).toBe('line');
      expect(laneOf(result({ ...syft, severity: 'LOW', due: undefined }), app)).toBe('line');
      expect(laneOf(result({ pin: { file: 'Dockerfile', line: 5 } }), app)).toBe('line');
    });
    it('worker: what judges a move (Kyverno, Trivy, Syft) is a move as any other', () => {
      const value = (name: string) => laneOf(result({ kind: 'chart', name }));
      expect(value('kyverno: reg.kyverno.io/kyverno/kyverno')).toBe('worker');
      expect(value('kyverno: ghcr.io/kyverno/readiness-checker')).toBe('worker');
      const trivy = { name: 'ghcr.io/aquasecurity/trivy', pin: { file: 'deploy/images/trivy/Dockerfile', line: 3 } };
      expect(laneOf(result(trivy))).toBe('worker');
      expect(laneOf(result({ ...trivy, severity: 'LOW', due: undefined }))).toBe('worker');
      expect(laneOf(result({ name: 'ghcr.io/anchore/syft' }))).toBe('worker');
    });
    it('worker: one chart at two Applications’ pins, as one move', () => {
      const chart = { kind: 'chart' as const, name: 'opentelemetry-collector', from: '0.174.0' };
      const target = { kind: 'chart' as const, chart: 'opentelemetry-collector', version: '0.178.3', major: false };
      const list = moves(
        [
          result({ ...chart, target, pin: { file: 'deploy/base/telemetry/otel-collector.yaml', line: 14 } }),
          result({ ...chart, target, pin: { file: 'deploy/base/pod-logs/pod-logs.yaml', line: 16 } }),
        ],
        context(),
      );
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ name: 'opentelemetry-collector', lane: 'worker' });
      expect(list[0]?.pins).toHaveLength(2);
    });
    it('worker: Playwright’s image, whose library the pin step moves with it; in the app, the line', () => {
      const image = (over: Partial<Judged> = {}) =>
        result({
          name: 'mcr.microsoft.com/playwright',
          pin: { file: 'apps/factory/Dockerfile.browser', line: 26 },
          ...over,
        });
      expect(laneOf(image())).toBe('worker');
      expect(laneOf(image({ severity: 'LOW', due: undefined }))).toBe('worker');
      expect(laneOf(image(), { repository: APP, app: true })).toBe('line');
    });
    it('cluster: k3s', () => {
      expect(
        laneOf(result({ kind: 'k3s-release', name: 'k3s', target: { kind: 'k3s', release: 'v1.37.2+k3s1' } })),
      ).toBe('cluster');
    });
    it('worker: a chart, a major or not, even in a directory Dependabot reads; no lane says a major waits', () => {
      const chart = (major: boolean) =>
        result({
          kind: 'chart',
          name: 'grafana',
          pin: { file: 'deploy/base/telemetry/grafana.yaml', line: 14 },
          target: { kind: 'chart', chart: 'grafana', version: major ? '14.3.1' : '13.7.0', major },
          severity: 'MEDIUM',
          due: NOW + 20 * DAY,
        });
      expect(laneOf(chart(true))).toBe('worker');
      expect(laneOf(chart(false))).toBe('worker');
      expect(moves([chart(true)], context())[0]?.major).toBe(true);
    });
    it('worker: what the Makefile pins, Argo CD’s chart, a major or not', () => {
      expect(laneOf(result({ kind: 'chart', name: 'argocd', pin: { file: 'Makefile', line: 7 } }))).toBe('worker');
      expect(
        laneOf(
          result({
            kind: 'chart',
            name: 'argocd',
            pin: { file: 'Makefile', line: 7 },
            target: { kind: 'chart', chart: 'argo-cd', version: '11.0.0', major: true },
          }),
        ),
      ).toBe('worker');
    });
    it('issue: a workflow’s pin', () => {
      expect(laneOf(result({ kind: 'workflow', pin: { file: '.github/workflows/check.yml', line: 30 } }))).toBe(
        'issue',
      );
    });
    it('worker: what mise pins, k3d’s images and a tool’s release, which the pin step makes in the scan’s run', () => {
      expect(laneOf(result({ kind: 'k3d', pin: { file: 'mise.lock', line: 40 } }))).toBe('worker');
      expect(
        laneOf(
          result({
            kind: 'ours',
            name: 'pnpm',
            pin: { file: 'mise.lock', line: 90 },
            target: { kind: 'tool', tool: 'pnpm', version: '12.17.0' },
          }),
        ),
      ).toBe('worker');
      // In the app, the line's, as every move there is.
      expect(
        laneOf(result({ kind: 'k3d', pin: { file: 'mise.lock', line: 40 } }), { repository: APP, app: true }),
      ).toBe('line');
    });
    it('a lockfile’s package: the worker’s, direct or not, and within a day of its fix', () => {
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
      expect(laneOf(recent)).toBe('worker');
      expect(laneOf(npm('example-a'))).toBe('worker');
      // An indirect package.
      const indirect = npm('example-b');
      if (indirect.finding.fix) indirect.finding.fix.day = NOW - DAY / 2;
      expect(laneOf(indirect)).toBe('worker');
      // An image of ours with the same package: the lockfile moves, and the image with the deploy after the merge.
      const both = [
        recent,
        {
          ...npm('example-a', { pin: { file: 'deploy/overlays/local/image/kustomization.yaml', line: 9 } }),
          finding: recent.finding,
        },
      ];
      expect(moves(both, context())[0]?.lane).toBe('worker');
    });
    it('worker: an image’s pin, whatever its severity or deadline; none waits for Dependabot', () => {
      const postgres = (severity: Severity, due?: number) =>
        result({ severity, due, name: 'postgres', pin: { file: 'deploy/base/postgres/statefulset.yaml', line: 20 } });
      expect(laneOf(postgres('MEDIUM', NOW + 20 * DAY))).toBe('worker');
      expect(laneOf(postgres('HIGH', undefined))).toBe('worker');
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

describe('one pin with several targets', () => {
  const chart = (version: string, major: boolean) =>
    result({
      kind: 'chart',
      name: 'grafana',
      from: '13.2.7',
      target: { kind: 'chart', chart: 'grafana', version, major },
    });
  const npm = (versions: string[], from = '1.4.0') =>
    result({
      kind: 'lockfile',
      name: 'example-a',
      from,
      pin: { file: 'pnpm-lock.yaml', line: 120 },
      target: { kind: 'version', versions },
    });

  it('is one move, to the furthest target within the pin’s major, and leaves what only a major clears', () => {
    const list = moves([chart('13.6.0', false), chart('13.7.0', false), chart('14.4.1', true)], context());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      to: { kind: 'chart', version: '13.7.0', major: false },
      major: false,
      lane: 'worker',
    });
    expect(list[0]?.clears.HIGH).toBe(2);
    expect(list[0]?.leaves.HIGH).toBe(1);
    expect(list[0]?.results).toHaveLength(2);
  });

  it('gives a move within the major the earliest deadline of what it clears and of what it leaves for the major', () => {
    const critical = { ...chart('14.4.1', true), severity: 'CRITICAL' as const, due: NOW + DAY };
    const list = moves([{ ...chart('13.7.0', false), due: NOW + 4 * DAY }, critical], context());
    expect(list).toHaveLength(1);
    // The Critical only the major clears is in no move until this one merges: its day is the move's, so it is alerted on.
    expect(list[0]).toMatchObject({ to: { version: '13.7.0' }, major: false, deadline: NOW + DAY });
    expect(list[0]?.clears.CRITICAL).toBe(0);
    expect(list[0]?.leaves.CRITICAL).toBe(1);
    expect(list[0]?.results).toHaveLength(1);
    // A result with no fix has no deadline, and gives the move none.
    const none = { ...chart('13.7.0', false), due: NOW + 4 * DAY };
    const unfixed = { ...result({ kind: 'chart', name: 'grafana', from: '13.2.7', target: undefined }) };
    expect(moves([none, unfixed], context())[0]?.deadline).toBe(NOW + 4 * DAY);
  });

  it('is the major at once where no result has a fix within the pin’s major', () => {
    const list = moves([chart('14.3.1', true), chart('14.4.1', true)], context());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ to: { kind: 'chart', version: '14.4.1', major: true }, major: true });
    expect(list[0]?.clears.HIGH).toBe(2);
    expect(list[0]?.leaves.HIGH).toBe(0);
  });

  it('moves a package at one version within its major, never to two versions for one copy', () => {
    const list = moves([npm(['1.5.3']), npm(['1.5.1']), npm(['2.0.1'])], context());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ to: { kind: 'version', versions: ['1.5.3'] }, major: false });
    expect(list[0]?.clears.HIGH).toBe(2);
    expect(list[0]?.leaves.HIGH).toBe(1);
    // The major alone, the day after: the one move, and a major.
    expect(moves([npm(['2.0.1'], '1.5.3')], context())[0]).toMatchObject({
      to: { kind: 'version', versions: ['2.0.1'] },
      major: true,
    });
  });

  it('keeps a fix for each copy of a package locked at two versions, one on each major', () => {
    const list = moves([npm(['1.5.3', '2.0.1'], '1.4.0, 2.0.0'), npm(['1.5.1', '2.0.4'], '1.4.0, 2.0.0')], context());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ to: { kind: 'version', versions: ['1.5.3', '2.0.4'] }, major: false });
    expect(list[0]?.clears.HIGH).toBe(2);
  });

  it('lets an image’s move clear Node’s own fix in it, whatever the image’s tag says of a major', () => {
    const image = { kind: 'dockerfile' as const, name: 'gcr.io/distroless/nodejs24-debian13', from: 'nonroot' };
    const list = moves(
      [
        result({ ...image, target: { kind: 'image', tag: 'nonroot', digest: DIGEST } }),
        result({ ...image, target: { kind: 'version', versions: ['24.23.0'] } }),
      ],
      context(),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ to: { kind: 'image', tag: 'nonroot' }, major: false });
    expect(list[0]?.clears.HIGH).toBe(2);
  });
});

describe('a package whose bump waits for a bench run', () => {
  const SDK = '@anthropic-ai/claude-agent-sdk';
  const benched = context({ benched: [SDK] });
  const sdk = (severity: Severity = 'HIGH') =>
    result({
      kind: 'lockfile',
      name: SDK,
      from: '0.2.10',
      severity,
      pin: { file: 'pnpm-lock.yaml', line: 40 },
      target: { kind: 'version', versions: ['0.2.11'] },
    });

  it('is an issue of its own, marked for the bench, where its fix clears no Critical', () => {
    const other = result({
      kind: 'lockfile',
      name: 'example-a',
      from: '1.0.0',
      pin: { file: 'pnpm-lock.yaml', line: 120 },
      target: { kind: 'version', versions: ['1.0.1'] },
    });
    const list = moves([sdk(), other], benched);
    const its = list.find((move) => move.name === SDK);
    expect(its).toMatchObject({ lane: 'issue', bench: true, lockfile: true, deadline: NOW + 4 * DAY });
    expect(list.find((move) => move.name === 'example-a')).toMatchObject({ lane: 'worker' });
    expect(list.find((move) => move.name === 'example-a')?.bench).toBeUndefined();
    const file = movesFile(list, benched);
    expect(file.totals.lanes).toMatchObject({ issue: 1, worker: 1 });
    expect(file.moves.find((move) => move.lane === 'issue')).toMatchObject({
      bench: true,
      deadline: '2026-11-14T04:30:00Z',
    });
    // Any other move is written as it always was, with no key for it.
    expect(Object.keys(file.moves.find((move) => move.lane === 'worker') ?? {})).not.toContain('bench');
  });

  it('is a move like any other where its fix clears a Critical, or the policy lists none', () => {
    expect(moves([sdk('CRITICAL'), sdk()], benched)[0]).toMatchObject({ lane: 'worker' });
    expect(moves([sdk('CRITICAL')], benched)[0]?.bench).toBeUndefined();
    expect(moves([sdk()], context())[0]).toMatchObject({ lane: 'worker' });
    expect(moves([sdk()], context())[0]?.bench).toBeUndefined();
  });

  it('is the line’s to hold too, in the app’s repository', () => {
    expect(moves([sdk()], context({ app: true, benched: [SDK] }))[0]).toMatchObject({ lane: 'issue', bench: true });
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
    // A lockfile's major is in a lockfile's lane, as its package's any other move is.
    expect(moves([npm], context())[0]).toMatchObject({ major: true, lane: 'worker' });
  });
});

describe('a pin that is merely behind', () => {
  const behind = (over: Partial<Behind> = {}): Behind => ({
    kind: 'third-party',
    name: 'example/other',
    pins: [{ file: 'deploy/y.yaml', line: 8 }],
    from: '3.1.0',
    to: { kind: 'image', tag: '3.2.0', digest: DIGEST },
    ...over,
  });

  it('is a routine move: no result, nothing cleared, no deadline, listed after the findings’ moves by name', () => {
    const findings = [result({ name: 'zebra/image', due: NOW + 9 * DAY }), result({ due: NOW + DAY })];
    const alone = moves(findings, context());
    const list = moves(findings, context(), [behind({ name: 'b/later' }), behind({ name: 'a/sooner' })]);
    // A finding's move keeps the place it has with no routine move listed, which the state's `move` names.
    expect(list.slice(0, 2)).toEqual(alone);
    expect(list.map((move) => move.name)).toEqual(['example/image', 'zebra/image', 'a/sooner', 'b/later']);
    expect(list[2]).toEqual({
      repository: REPOSITORY,
      name: 'a/sooner',
      pins: [{ file: 'deploy/y.yaml', line: 8 }],
      from: '3.1.0',
      to: { kind: 'image', tag: '3.2.0', digest: DIGEST },
      major: false,
      clears: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
      leaves: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
      deadline: undefined,
      newToday: 0,
      lane: 'worker',
      lockfile: false,
      results: [],
    });
    expect(list.map(isRoutine)).toEqual([false, false, true, true]);
    expect(list.map((move) => isRoutine(publicMove(move)))).toEqual([false, false, true, true]);
  });

  it('gets no routine move where a finding’s move has the pin, a line no longer built among them', () => {
    const pin = { name: 'example/image', from: '2.17.0' };
    expect(moves([result()], context(), [behind(pin)])).toHaveLength(1);
    const unbuilt = result({ target: { kind: 'unbuilt', built: NOW - 400 * DAY }, due: undefined });
    expect(moves([unbuilt], context(), [behind(pin)]).map((move) => move.lane)).toEqual(['none']);
    // A package of that name is another pin, and so is the same image at another tag.
    const others = [behind({ ...pin, kind: 'lockfile' }), behind({ ...pin, from: '2.16.0' })];
    expect(moves([result()], context(), others)).toHaveLength(3);
    // Two of one pin are one move.
    expect(moves([], context(), [behind(), behind()])).toHaveLength(1);
  });

  it('says what the pin has that no fix clears, which the move is not known to clear', () => {
    const open = result({ target: undefined, severity: 'MEDIUM' });
    const [move] = moves([open, result({ target: undefined, excepted: true })], context(), [
      behind({ name: 'example/image', from: '2.17.0' }),
    ]);
    expect(move?.leaves).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 1, LOW: 0, UNKNOWN: 0 });
    expect(move && isRoutine(move)).toBe(true);
  });

  it('takes the lane a finding’s move of the pin would: the worker’s, the cluster’s, an issue’s, the app’s line', () => {
    const laneOf = (each: Behind, over: Partial<Context> = {}) => moves([], context(over), [each])[0]?.lane;
    expect(laneOf(behind())).toBe('worker');
    expect(
      laneOf(
        behind({
          kind: 'chart',
          name: 'argo-cd',
          pins: [{ file: 'Makefile', line: 7 }],
          to: { kind: 'chart', chart: 'argo-cd', version: '10.9.6', major: false },
        }),
      ),
    ).toBe('worker');
    expect(laneOf(behind({ kind: 'workflow', pins: [{ file: '.github/workflows/check.yml', line: 30 }] }))).toBe(
      'issue',
    );
    expect(laneOf(behind({ kind: 'k3s', name: 'k3s', to: { kind: 'k3s', release: 'v1.37.2+k3s1' } }))).toBe('cluster');
    expect(laneOf(behind(), { repository: APP, app: true })).toBe('line');
    expect(
      laneOf(behind({ kind: 'workflow', pins: [{ file: '.github/workflows/check.yml', line: 30 }] }), {
        repository: APP,
        app: true,
      }),
    ).toBe('line');
  });

  it('is a major by the one rule, and whenever its manifest’s range does not admit it', () => {
    const npm = (from: string, to: string, outside = false) =>
      moves([], context(), [
        behind({ kind: 'lockfile', name: 'example-a', from, to: { kind: 'version', versions: [to] }, outside }),
      ])[0]?.major;
    expect(npm('3.2.0', '3.4.0')).toBe(false);
    expect(npm('3.2.0', '4.0.0', true)).toBe(true);
    // Below 1.0 a new minor is outside a caret range: its numbers say no major, and the range says one.
    expect(npm('0.5.3', '0.6.0', true)).toBe(true);
    const chart = behind({ kind: 'chart', to: { kind: 'chart', chart: 'grafana', version: '14.3.1', major: true } });
    expect(moves([], context(), [chart])[0]?.major).toBe(true);
  });

  it('is counted in the totals and said in the table, and a day with none is written with no word of them', () => {
    const findings = [result()];
    const plain = movesFile(moves(findings, context()), context(), '19234567890');
    expect(JSON.stringify(movesFile(moves(findings, context(), []), context(), '19234567890'))).toBe(
      JSON.stringify(plain),
    );
    expect('routine' in plain.totals).toBe(false);
    const file = movesFile(moves(findings, context(), [behind()]), context(), '19234567890');
    expect(file.totals).toMatchObject({ fixed: 1, moves: 2, routine: 1, lanes: { worker: 2 } });
    expect('routineUnread' in file.totals).toBe(false);
    expect(table(file)).toEqual([
      'Moves: 1 results with a fix, in 2 moves, 1 of them routine (worker 2).',
      '',
      '| Move | From | To | Clears | Leaves | New today | Deadline | Lane |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      `| example/image | 2.17.0 | image 2.17.0@${DIGEST} | 1 high | nothing | 0 | 2026-11-14T04:30:00Z | worker |`,
      `| example/other | 3.1.0 | image 3.2.0@${DIGEST} | nothing | nothing | 0 | – | worker |`,
    ]);
  });

  it('says a routine listing was made, and how many pins it could not read, zero included', () => {
    const file = (behinds: Behind[], listing?: { unread: number }) =>
      movesFile(moves([result()], context(), behinds), context(), '19234567890', [], undefined, undefined, listing);
    // No listing made (no policy for one): no word of it, so a reader takes nothing as moved.
    expect(Object.keys(file([]).totals)).not.toContain('routineUnread');
    expect(file([], { unread: 0 }).totals).toMatchObject({ routine: 0, routineUnread: 0 });
    expect(file([behind()], { unread: 2 }).totals).toMatchObject({ routine: 1, routineUnread: 2 });
  });

  it('lists a lockfile’s routine moves after every other, in an order that says nothing of their names', () => {
    const npm = (name: string) =>
      behind({
        kind: 'lockfile',
        name,
        pins: [{ file: 'pnpm-lock.yaml', line: 9 }],
        from: '1.0.0',
        to: { kind: 'version', versions: ['1.0.1'] },
      });
    const names = ['aaa-first', 'mmm-middle', 'zzz-last', 'example-b', 'example-c'];
    const list = moves([], context(), [...names.map(npm), behind({ name: 'b/image' }), behind({ name: 'zz/image' })]);
    expect(list.slice(0, 2).map((move) => move.name)).toEqual(['b/image', 'zz/image']);
    const hidden = list.slice(2).map((move) => move.name);
    expect([...hidden].sort()).toEqual([...names].sort());
    // Not by name, and the same whatever order they were found in.
    expect(hidden).not.toEqual([...names].sort());
    const again = moves([], context(), [
      behind({ name: 'zz/image' }),
      ...names.map(npm).reverse(),
      behind({ name: 'b/image' }),
    ]);
    expect(again.map((move) => move.name)).toEqual(list.map((move) => move.name));
  });

  it('names nothing of a lockfile’s package: its file alone, as a finding’s move of one', () => {
    const secret = behind({
      kind: 'lockfile',
      name: 'example-secret',
      pins: [{ file: 'pnpm-lock.yaml', line: 4242 }],
      from: '1.0.0',
      to: { kind: 'version', versions: ['1.3.7'] },
    });
    const file = movesFile(moves([], context(), [secret]), context());
    const text = JSON.stringify(file) + table(file).join('\n');
    for (const word of ['example-secret', '4242', '1.0.0', '1.3.7']) expect(text).not.toContain(word);
    expect(file.moves).toEqual([
      expect.objectContaining({
        name: 'a package in `pnpm-lock.yaml`',
        pins: [{ file: 'pnpm-lock.yaml', line: 0 }],
        from: '',
        to: '',
        lockfile: true,
        lane: 'worker',
      }),
    ]);
    expect(file.moves.map(isRoutine)).toEqual([true]);
  });
});
