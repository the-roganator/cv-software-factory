/**
 * The adversarial reads of the pin move (#1057's platform rule and #1065's condition 6), each case the gate must hold,
 * as `main`'s code answers it. Most of what those reads found is held in pin-move.test.ts already; these are the cases
 * it did not have. A case a read wrote to show a bypass asserts the hold that closed it. Cases that need Argo CD's own
 * Go reader to say whether a pass is wrong are not here.
 */
import { describe, expect, it } from 'vitest';
import type { Chart, Item } from '../apps/factory/src/vulnerabilities/inventory.ts';
import {
  type ChartVersions,
  chartForward,
  chartImageForward,
  type ImagePair,
  imageForward,
  type Move,
  manifestsDiffer,
  type PinMoveIO,
  PLATFORM_CHECK,
  PLATFORM_WORKFLOW,
  patchedByTheCheck,
  pinMove,
  type Run,
  type Scan,
  started,
  type WorkflowRun,
  whatRunsIt,
  workflowsOf,
} from './pin-move.ts';
import { majorOf, sameMajor } from './pin-move-shared.ts';

const REPO = 'o/r';
const HEAD = 'c'.repeat(40);
const BRANCH = 'factory/pin/x';
const OPENED = '2026-11-12T09:00:00Z';
const hex = (c: string) => c.repeat(64);
const FIXED: Scan = { read: true, findings: [{ id: 'CVE-1', pkg: 'certifi', severity: 'CRITICAL', fixed: true }] };
const CLEAN: Scan = { read: true, findings: [] };

// #1057's harness: Grafana's sidecar value moved in one line, every condition true but what the case gives it.
const GRAFANA: Chart = {
  repo: 'https://grafana.github.io/helm-charts',
  chart: 'grafana',
  version: '13.5.0',
  release: 'grafana',
  values: ['deploy/base/telemetry/values/grafana.yaml'],
};
const VALUES = 'deploy/base/telemetry/values/grafana.yaml';
const OLD = `kiwigrid/k8s-sidecar:2.11.2@sha256:${hex('4')}`;
const NEW = `kiwigrid/k8s-sidecar:2.14.3@sha256:${hex('5')}`;
const valueItem = (digest: string): Item => ({
  kind: 'chart',
  name: 'grafana',
  file: 'deploy/base/telemetry/grafana.yaml',
  line: 12,
  chart: GRAFANA,
  pins: [{ file: VALUES, line: 3, digest: `sha256:${hex(digest)}` }],
});
const workload = (image: string, kind = 'Deployment', annotations = '') =>
  [
    'apiVersion: apps/v1',
    `kind: ${kind}`,
    'metadata:',
    '  name: grafana',
    ...(annotations ? ['  annotations:', `    ${annotations}`] : []),
    '  labels:',
    '    helm.sh/chart: grafana-13.5.0',
    'spec:',
    '  replicas: 1',
    '  template:',
    '    spec:',
    '      containers:',
    '        - image: grafana/grafana:12.0.0',
    `        - image: ${image}`,
  ].join('\n');
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
    render: async (side) => workload(side === 'base' ? OLD : NEW),
    overlay: async () => 'kind: ConfigMap\nmetadata:\n  name: x\n',
    hashes: async () => ({ 'admission-refusals': 'x', 'mark-refusals': 'y' }),
    scan: async (reference) => (reference.includes(hex('4')) ? FIXED : CLEAN),
    runs: async () => [],
    patched: async () => [],
    ...more,
  };
};
const check = (id: number, conclusion: string | null, suite: number, more: Partial<Run> = {}): Run => ({
  id,
  name: PLATFORM_CHECK,
  head_sha: HEAD,
  status: 'completed',
  conclusion,
  app: { slug: 'github-actions' },
  check_suite: { id: suite },
  ...more,
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
const tied = (checks: Run[], workflows: WorkflowRun[]) => workflowsOf(checks, workflows, REPO, FOR);
const GOOD = () => tied([check(1, 'success', 1)], [workflowRun(1)]);
const reasonOf = async (io: PinMoveIO) => {
  const result = await pinMove(io, HEAD);
  return 'reason' in result ? result.reason : 'passed';
};

describe('the platform rule, where the reads of #1057 aimed', () => {
  it('passes the honest move the cases below each change one thing of', async () => {
    expect(await pinMove(sidecarIO({ runs: async () => GOOD() }), HEAD)).toMatchObject({ ran: [PLATFORM_CHECK] });
  });

  it('holds every conclusion but success, and a run not finished', async () => {
    for (const conclusion of [
      'skipped',
      'cancelled',
      'neutral',
      'timed_out',
      'failure',
      'action_required',
      'stale',
      null,
    ])
      expect(
        await reasonOf(sidecarIO({ runs: async () => tied([check(1, conclusion, 1)], [workflowRun(1)]) })),
      ).toMatch(/^platform at ccccccc is .*, not a success/);
    expect(
      await reasonOf(
        sidecarIO({ runs: async () => tied([check(1, null, 1, { status: 'in_progress' })], [workflowRun(1)]) }),
      ),
    ).toBe('platform has not finished at ccccccc');
    expect(await reasonOf(sidecarIO({ runs: async () => tied([check(1, 'skipped', 1)], [workflowRun(1)]) }))).toBe(
      'platform at ccccccc is skipped, not a success: it made no cluster from the change',
    );
  });

  it("holds another app's check run of the name, the factory's App's among them", async () => {
    for (const app of [{ slug: 'mrogan-software-factory' }, { slug: 'dependabot' }, null])
      expect(
        await reasonOf(sidecarIO({ runs: async () => tied([check(1, 'success', 1, { app })], [workflowRun(1)]) })),
      ).toBe('platform has not run at ccccccc');
  });

  it('holds a run of another workflow, a fork, another event, head, repository, suite or pull request', async () => {
    for (const other of [
      { path: '.github/workflows/check.yml' },
      { path: '.github/workflows/platform.yaml' },
      { path: 'platform.yml' },
      { head_repository: { full_name: 'fork/r' } },
      { head_repository: null },
      { repository: { full_name: 'other/r' } },
      { event: 'merge_group' },
      { event: 'workflow_dispatch' },
      { event: 'pull_request_target' },
      { event: 'push' },
      { head_sha: 'd'.repeat(40) },
      { check_suite_id: 2 },
      { pull_requests: [] },
      { pull_requests: null },
      { pull_requests: [{ number: 9, base: { ref: 'gutted' } }] },
      { pull_requests: [{ number: 10, base: { ref: 'main' } }] },
    ] as Partial<WorkflowRun>[])
      expect(
        await reasonOf(sidecarIO({ runs: async () => tied([check(1, 'success', 1)], [workflowRun(1, other)]) })),
      ).toBe(
        'platform at ccccccc ran in no run of .github/workflows/platform.yml for this pull request that the gate could read',
      );
    expect(
      await reasonOf(
        sidecarIO({ runs: async () => tied([check(1, 'success', 1, { head_sha: 'd'.repeat(40) })], [workflowRun(1)]) }),
      ),
    ).toBe('platform has not run at ccccccc');
    // An earlier success of the same suite does not outlive its later failure.
    expect(
      await reasonOf(
        sidecarIO({ runs: async () => tied([check(1, 'success', 1), check(2, 'failure', 1)], [workflowRun(1)]) }),
      ),
    ).toBe('platform at ccccccc is failure, not a success: something must run it');
  });

  it('holds a pin only a hook or a Job runs, though platform succeeded', async () => {
    const hooked = async (side: 'base' | 'head') =>
      workload(side === 'base' ? OLD : NEW, 'Deployment', 'helm.sh/hook: test');
    const job = async (side: 'base' | 'head') => workload(side === 'base' ? OLD : NEW, 'Job');
    for (const render of [hooked, job])
      expect(await reasonOf(sidecarIO({ render, runs: async () => GOOD() }))).toBe(
        `no workload the platform check runs starts ${NEW}: a hook, a Job or nothing at all runs it, so its cluster never pulled it`,
      );
  });

  it('holds an image a List wraps, a CronJob runs, or only an ephemeral container names', () => {
    const list = `kind: List\nitems:\n  - kind: Deployment\n    metadata:\n      name: x\n    spec:\n      replicas: 1\n      template:\n        spec:\n          containers:\n            - image: ${NEW}\n`;
    const cron = `kind: CronJob\nmetadata:\n  name: x\nspec:\n  jobTemplate:\n    spec:\n      template:\n        spec:\n          containers:\n            - image: ${NEW}\n`;
    const ephemeral = `kind: Deployment\nmetadata:\n  name: x\nspec:\n  replicas: 1\n  template:\n    spec:\n      containers:\n        - image: other/x:1.0.0\n      ephemeralContainers:\n        - image: ${NEW}\n`;
    for (const rendering of [list, cron, ephemeral]) expect(started(rendering, [NEW])).toMatch(/^no workload/);
  });

  it('reads replicas as YAML does: `1.0` is one replica, `"1"` none', () => {
    const scaled = (replicas: string) =>
      `kind: Deployment\nmetadata:\n  name: x\nspec:\n  replicas: ${replicas}\n  template:\n    spec:\n      containers:\n        - image: ${NEW}\n`;
    // The head's replicas are the base's line (condition 6's text rule), so a move cannot write either.
    expect(started(scaled('1.0'), [NEW])).toBeUndefined();
    expect(started(scaled('"1"'), [NEW])).toMatch(/^no workload/);
  });

  it("holds the line worker, which main's platform check scales to nothing, as it does github", () => {
    const patched = patchedByTheCheck();
    if (typeof patched === 'string') throw new Error(patched);
    expect(patched).toContainEqual({ kind: 'Deployment', name: 'line', namespace: 'factory' });
    const line = `kind: Deployment\nmetadata:\n  name: line\n  namespace: factory\nspec:\n  replicas: 1\n  template:\n    spec:\n      containers:\n        - image: ${NEW}\n`;
    expect(started(line, [NEW], patched)).toMatch(/^no workload/);
  });

  it('holds k3d, a chart the Makefile pins, and a Dockerfile stage in deploy/, whatever platform says', () => {
    const move = (kind: Move['kind'], file: string, what: Move['what'] = 'image'): Move => ({
      what,
      name: 'x',
      kind,
      from: 'a',
      to: 'b',
      pins: [{ what, kind, item: 'x', place: { file, line: 9 }, from: 'a', to: 'b' }],
    });
    expect(whatRunsIt(move('k3d', 'mise.lock'))).toEqual({
      reason:
        "x is the cluster's own: a k3s move waits for Martin, whose cluster moves with it, whatever the platform check says",
    });
    expect(whatRunsIt(move('chart', 'Makefile', 'chart'))).toEqual({
      reason: 'x is installed by make up: a merge does not apply it',
    });
    expect(whatRunsIt(move('dockerfile', 'deploy/images/tool/Dockerfile'))).toEqual({
      reason: 'no check at the head runs x: nothing shows it ran',
    });
  });

  it('throws when any reader throws, which the pin move job makes a hold', async () => {
    for (const name of ['diff', 'list', 'unlisted', 'digest', 'render', 'hashes', 'scan', 'runs', 'patched'] as const) {
      const thrower = { [name]: async () => Promise.reject(new Error(`EACCES: ${name}`)) } as Partial<PinMoveIO>;
      const outcome = await pinMove(sidecarIO({ runs: async () => GOOD(), ...thrower }), HEAD).then(
        (result) => ('move' in result ? 'passed' : 'held'),
        () => 'threw',
      );
      expect(`${name}: ${outcome}`).toBe(`${name}: threw`);
    }
  });

  it.each([
    ['diff', { diff: async () => ({ raw: '', files: [] }) }, 'it changes no file'],
    ['list', { list: async () => [] }, `${VALUES}:3 is a line that is not a pin: tag: 2.14.3@sha256:${hex('5')}`],
    [
      'render',
      { render: async () => '' },
      `grafana's value at ${VALUES}:3's rendering runs no one image at its digest`,
    ],
    ['hashes', { hashes: async () => ({}) }, 'the gate read no refusal record to hold the change to'],
    [
      'scan, read nothing',
      { scan: async () => ({ read: false, findings: [] }) },
      `the scan of ${OLD} (linux/amd64) read nothing`,
    ],
    [
      'scan, found nothing',
      { scan: async () => ({ read: true, findings: [] }) },
      'the scans show no finding with a fix gone: the move fixes nothing',
    ],
    ['runs', { runs: async () => [] }, 'platform has not run at ccccccc'],
    [
      'digest',
      { digest: async () => '' },
      `a digest that is not the tag's: kiwigrid/k8s-sidecar:2.14.3 is  now, not sha256:555555555555`,
    ],
  ] as [string, Partial<PinMoveIO>, string][])(
    'holds when %s answers with nothing, saying so',
    async (_, empty, reason) => {
      expect(await pinMove(sidecarIO({ runs: async () => GOOD(), ...empty }), HEAD)).toEqual({ reason });
    },
  );
});

// A chart's move and an image's reach the readers a value's move never asks: the chart's versions, the overlay, the tags.
describe("the readers only a chart's or an image's move asks, where #1057's read aimed", () => {
  const chartItem = (version: string): Item => ({
    kind: 'chart',
    name: 'grafana',
    file: 'deploy/base/telemetry/grafana.yaml',
    line: 12,
    chart: { ...GRAFANA, version },
  });
  const chartWorkload = (version: string, image: string) =>
    workload(OLD).replace('grafana-13.5.0', `grafana-${version}`).replace('grafana/grafana:12.0.0', image);
  const chartIO = (more: Partial<PinMoveIO> = {}): PinMoveIO =>
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
        side === 'base'
          ? chartWorkload('13.5.0', 'grafana/grafana:12.0.0')
          : chartWorkload('13.7.0', 'grafana/grafana:12.0.1'),
      scan: async (reference) => (reference.endsWith('12.0.0') ? FIXED : CLEAN),
      runs: async () => GOOD(),
      ...more,
    });
  const IMAGE = 'deploy/base/thing/deployment.yaml';
  const thing = (tag: string, d: string) => `docker.io/acme/thing:${tag}@sha256:${hex(d)}`;
  const imageIO = (more: Partial<PinMoveIO> = {}): PinMoveIO =>
    sidecarIO({
      diff: async () => ({
        raw: `:100644 100644 ${'1'.repeat(40)} ${'2'.repeat(40)} M\t${IMAGE}`,
        files: [
          {
            path: IMAGE,
            before: `\n\n          image: ${thing('1.0.0', 'a')}\n`,
            after: `\n\n          image: ${thing('1.0.1', 'b')}\n`,
          },
        ],
      }),
      list: async (side) => [
        {
          kind: 'third-party',
          name: 'thing',
          file: IMAGE,
          line: 3,
          image: side === 'base' ? thing('1.0.0', 'a') : thing('1.0.1', 'b'),
        },
      ],
      tags: async () => ['1.0.0', '1.0.1'],
      digest: async () => `sha256:${hex('b')}`,
      overlay: async (side) => workload(side === 'base' ? thing('1.0.0', 'a') : thing('1.0.1', 'b')),
      scan: async (reference) => (reference.includes(hex('a')) ? FIXED : CLEAN),
      runs: async () => GOOD(),
      ...more,
    });

  it('passes the honest chart move and image move each case changes one reader of', async () => {
    expect(await pinMove(chartIO(), HEAD)).toMatchObject({
      move: { what: 'chart', to: '13.7.0' },
      ran: [PLATFORM_CHECK],
    });
    expect(await pinMove(imageIO(), HEAD)).toMatchObject({ move: { what: 'image' }, ran: [PLATFORM_CHECK] });
  });

  it.each([
    ['chartVersions', chartIO],
    ['overlay', chartIO],
    ['tags', imageIO],
    ['overlay', imageIO],
  ] as const)('throws when %s throws, which the pin move job makes a hold', async (name, io) => {
    const thrower = { [name]: async () => Promise.reject(new Error(`EACCES: ${name}`)) } as Partial<PinMoveIO>;
    await expect(pinMove(io(thrower), HEAD)).rejects.toThrow(`EACCES: ${name}`);
  });
});

// #1065's condition 6, read by its first adversarial read. Its bypasses are closed; the image a ConfigMap's data names
// is the publisher's by ADR 0019, and pin-move.test.ts asserts that pass.
describe('condition 6, where the first read of #1065 aimed', () => {
  const FROM = `docker.io/acme/app:1.0.0@sha256:${hex('a')}`;
  const TO = `docker.io/acme/app:1.1.0@sha256:${hex('b')}`;
  const PAIRS: ImagePair[] = [{ from: FROM, to: TO }];
  const CHART: ChartVersions = { chart: 'app', from: '1.0.0', to: '1.1.0' };
  const deploy = (image: string, version: string) => `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  namespace: ns
  labels:
    app.kubernetes.io/version: "${version}"
spec:
  selector:
    matchLabels: {app: app}
  template:
    metadata:
      labels:
        app: app
        app.kubernetes.io/version: "${version}"
    spec:
      containers:
        - name: app
          image: ${image}
`;
  const cm = (data: string) =>
    `---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: launcher, namespace: ns}\ndata:\n${data}`;
  const b0 = deploy(FROM, '1.0.0');
  const h0 = deploy(TO, '1.1.0');
  const judge = (base: string, head: string) => manifestsDiffer(base, head, PAIRS, CHART);

  it('passes the honest move each case changes one thing of', () => {
    expect(judge(b0, h0)).toBeUndefined();
    expect(judge(b0 + cm('  a: x\n'), h0 + cm('  a: y\n'))).toBeUndefined();
  });

  it("holds the pods' version label moving out from under a policy that selects by it, or to no version", () => {
    const netpol = `---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: lockdown, namespace: ns}\nspec:\n  podSelector:\n    matchLabels: {app.kubernetes.io/version: "1.0.0"}\n  policyTypes: [Egress]\n  egress: []\n`;
    expect(judge(b0 + netpol, h0 + netpol)).toBe(
      'NetworkPolicy ns/lockdown names a version label at spec.podSelector.matchLabels["app.kubernetes.io/version"], and the chart\'s version labels change',
    );
    expect(judge(b0, deploy(TO, 'role=admin'))).toBe(
      'the manifests change beyond the image: Deployment ns/app at metadata.labels["app.kubernetes.io/version"]: role=admin is no version',
    );
  });

  it.each([
    ['a second document of the same object', b0, h0 + h0],
    ['a duplicate key', b0, h0.replace('  name: app\n  namespace', '  name: app\n  name: app\n  namespace')],
    ['the namespace dropped', b0, h0.replace('  namespace: ns\n', '')],
    ['the namespace empty', b0, h0.replace('namespace: ns', 'namespace: ""')],
    ['the apiVersion changed', b0, h0.replace('apps/v1', 'apps/v1beta2')],
    ['a List', b0, `${h0}---\napiVersion: v1\nkind: List\nmetadata: {name: x}\nitems: []\n`],
    [
      'an object named by generateName',
      b0,
      `${h0}---\napiVersion: batch/v1\nkind: Job\nmetadata: {generateName: x-}\n`,
    ],
    ['a scalar document', b0, `${h0}---\nhello\n`],
    ['a sequence document', b0, `${h0}---\n- a\n`],
    ['an anchor and an alias', b0, h0.replace('matchLabels: {app: app}', 'matchLabels: &m {app: app}\n  x: *m')],
    ['a merge key', b0, h0.replace('matchLabels: {app: app}', 'matchLabels: {<<: {app: app}}')],
    ['a `!!binary` tag', b0 + cm('  a: x\n'), h0 + cm('  a: !!binary eA==\n')],
    [
      'a document `...` ends, then another',
      b0,
      `${h0}...\napiVersion: v1\nkind: Secret\nmetadata: {name: s, namespace: ns}\n`,
    ],
    ['binaryData added', b0 + cm('  a: x\n'), `${h0}${cm('  a: x\n')}binaryData: {b: eA==}\n`],
    ['immutable added', b0 + cm('  a: x\n'), `${h0}${cm('  a: x\n')}immutable: true\n`],
    [
      'a ConfigMap of another group',
      b0 + cm('  a: x\n').replace('apiVersion: v1', 'apiVersion: evil/v1'),
      h0 + cm('  a: y\n').replace('apiVersion: v1', 'apiVersion: evil/v1'),
    ],
    [
      "a Secret's data",
      `${b0}---\napiVersion: v1\nkind: Secret\nmetadata: {name: s, namespace: ns}\ndata: {a: eA==}\n`,
      `${h0}---\napiVersion: v1\nkind: Secret\nmetadata: {name: s, namespace: ns}\ndata: {a: eQ==}\n`,
    ],
    [
      "two ConfigMaps' labels swapped",
      `${b0}---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: one, namespace: ns, labels: {l: "1"}}\ndata: {}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: two, namespace: ns, labels: {l: "2"}}\ndata: {}\n`,
      `${h0}---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: one, namespace: ns, labels: {l: "2"}}\ndata: {}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: two, namespace: ns, labels: {l: "1"}}\ndata: {}\n`,
    ],
    [
      "a checksum on the object's own metadata",
      b0,
      h0.replace(
        '  labels:\n    app.kubernetes.io/version: "1.1.0"\nspec',
        '  annotations: {checksum/x: y}\n  labels:\n    app.kubernetes.io/version: "1.1.0"\nspec',
      ),
    ],
    [
      "a checksum on a custom resource's template",
      `${b0}---\napiVersion: argoproj.io/v1alpha1\nkind: Rollout\nmetadata: {name: r, namespace: ns}\nspec:\n  template:\n    metadata:\n      annotations: {checksum/c: "1"}\n`,
      `${h0}---\napiVersion: argoproj.io/v1alpha1\nkind: Rollout\nmetadata: {name: r, namespace: ns}\nspec:\n  template:\n    metadata:\n      annotations: {checksum/c: "2"}\n`,
    ],
    [
      'a Service selecting by the version label',
      `${b0}---\napiVersion: v1\nkind: Service\nmetadata: {name: s, namespace: ns}\nspec:\n  selector: {app.kubernetes.io/version: "1.0.0"}\n`,
      `${h0}---\napiVersion: v1\nkind: Service\nmetadata: {name: s, namespace: ns}\nspec:\n  selector: {app.kubernetes.io/version: "1.1.0"}\n`,
    ],
    [
      'the moved reference added as an argument',
      b0,
      h0.replace(`image: ${TO}`, `image: ${TO}\n          args: ["${TO}"]`),
    ],
    [
      'a second image sharing the moved one’s prefix, changed',
      b0.replace(
        `          image: ${FROM}\n`,
        `          image: ${FROM}\n        - name: s\n          image: docker.io/acme/app-sidecar:1\n`,
      ),
      h0.replace(
        `          image: ${TO}\n`,
        `          image: ${TO}\n        - name: s\n          image: docker.io/acme/app-sidecar:2\n`,
      ),
    ],
    [
      'init containers reordered',
      b0.replace(
        '      containers:',
        '      initContainers:\n        - {name: a, image: x:1}\n        - {name: b, image: x:1}\n      containers:',
      ),
      h0.replace(
        '      containers:',
        '      initContainers:\n        - {name: b, image: x:1}\n        - {name: a, image: x:1}\n      containers:',
      ),
    ],
    [
      'a hook annotation added',
      b0,
      h0.replace('  namespace: ns\n', '  namespace: ns\n  annotations: {helm.sh/hook: pre-install}\n'),
    ],
    [
      'a label added beside a version label written `<version>`',
      b0,
      deploy(TO, '<version>').replace(
        'app: app\n        app.kubernetes.io',
        'app: app\n        x: y\n        app.kubernetes.io',
      ),
    ],
    [
      'a YAML 1.1 octal for its decimal',
      b0.replace('      containers:', '      securityContext: {fsGroup: 511}\n      containers:'),
      h0.replace('      containers:', '      securityContext: {fsGroup: 0777}\n      containers:'),
    ],
    [
      '`yes` for `true`',
      b0.replace('      containers:', '      hostNetwork: true\n      containers:'),
      h0.replace('      containers:', '      hostNetwork: yes\n      containers:'),
    ],
    ['a `__proto__` key', b0, h0.replace('  name: app\n', '  name: app\n  __proto__: {x: 1}\n')],
    ['an empty head', b0, '---\n# nothing\n'],
  ])('holds %s', (_, base, head) => {
    expect(judge(base, head)).toEqual(expect.any(String));
  });

  it('holds, or throws for the job to hold, a value nested past what the reader takes', () => {
    const deep = `${'['.repeat(20000)}${']'.repeat(20000)}`;
    const head = `${h0}---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: d, namespace: ns}\ndata: {a: x}\nx: ${deep}\n`;
    let verdict: string | undefined;
    try {
      verdict = judge(b0, head);
    } catch (error) {
      verdict = `threw ${(error as Error).name}`;
    }
    expect(verdict).toEqual(expect.any(String));
  });
});

// #1065's fourth read, at the exempt places' edges: each a base and a head the gate holds on its own reading. Whether
// a pair it passes is right needs Argo CD's reader, which is not here.
describe("condition 6 at the exempt places' edges, where the fourth read of #1065 aimed", () => {
  const FROM = `docker.io/acme/app:1.0.0@sha256:${hex('a')}`;
  const TO = `docker.io/acme/app:1.1.0@sha256:${hex('b')}`;
  const cm = (data: string, rest = '') =>
    `---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\n  namespace: ns\n${data}\n${rest}`;
  const dep = (opts: { ann?: string; label?: string; container?: string; extra?: string } = {}) => `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: ns
  labels:
    helm.sh/chart: ${opts.label ?? 'app-1.0.0'}
spec:
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
      annotations:
${opts.ann ?? '        checksum/config: abc'}
        note: keep
    spec:
      containers:
${opts.container ?? `        - name: web\n          image: ${FROM}`}
          env:
            - name: MODE
              value: safe
${opts.extra ?? ''}`;
  const judge = (base: string, head: string, chart = false) =>
    manifestsDiffer(
      base,
      head.split(FROM).join(TO),
      [{ from: FROM, to: TO }],
      chart ? { chart: 'app', from: '1.0.0', to: '1.1.0' } : undefined,
    );

  it.each([
    ['flow data on one line, a key added', cm('data: {k: v}') + dep(), cm('data: {k: v, kind: Secret}') + dep()],
    [
      'flow data over lines, `kind:` at column 0 inside the braces',
      cm('data: {\n  k: v}') + dep(),
      cm('data: {\n  k: v,\nkind: Secret}') + dep(),
    ],
    [
      'block scalar with `---` and U+3000 at column 0',
      cm('data:\n  k: v') + dep(),
      cm('data:\n  k: |\n    a\n---　\n    b') + dep(),
    ],
    [
      'block scalar with `...` at column 0',
      cm('data:\n  k: v') + dep(),
      cm('data:\n  k: |\n    a\n...\n    b') + dep(),
    ],
    ['tab-indented data line', cm('data:\n  k: v') + dep(), cm('data:\n  k: v\n\tj: w') + dep()],
    ['a second `data:` after the first', cm('data:\n  k: v') + dep(), cm('data:\n  k: v\ndata: {}') + dep()],
    [
      "a Secret's `data`",
      cm('data:\n  k: v').replace('ConfigMap', 'Secret') + dep(),
      cm('data:\n  k: dw==').replace('ConfigMap', 'Secret') + dep(),
    ],
    [
      'binaryData',
      cm('data:\n  k: v', 'binaryData:\n  b: aGk=\n') + dep(),
      cm('data:\n  k: v', 'binaryData:\n  b: aGkh\n') + dep(),
    ],
    [
      'a ConfigMap that is not core',
      cm('data:\n  k: v').replace('apiVersion: v1', 'apiVersion: v2') + dep(),
      cm('data:\n  k: w').replace('apiVersion: v1', 'apiVersion: v2') + dep(),
    ],
    [
      'a JSON document, then data over lines and a key after a comment',
      `{"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "cfg", "namespace": "ns"}, "data": {\n "k": "v"}}\n${dep()}`,
      `{"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "cfg", "namespace": "ns"}, "data": {\n "k": "v"}} # c\nkind: Secret\n${dep()}`,
    ],
    ['a checksum in flow with a second key', dep(), dep({ ann: '        checksum/config: {x: 1}, evil: y' })],
    [
      'a checksum as a block scalar with a sibling annotation inside',
      dep(),
      dep({ ann: '        checksum/config: |\n          x\n        evil: y' }),
    ],
    [
      'two checksums on one line in flow',
      dep({ ann: '        checksum/a: x\n        checksum/b: y' }),
      dep({ ann: '        checksum/a: x, checksum/b: y' }),
    ],
    [
      'annotations as one flow mapping, a sibling changed',
      dep().replace(
        '      annotations:\n        checksum/config: abc\n        note: keep',
        '      annotations: {checksum/config: abc, note: keep}',
      ),
      dep().replace(
        '      annotations:\n        checksum/config: abc\n        note: keep',
        '      annotations: {checksum/config: abd, note: evil}',
      ),
    ],
    [
      'annotations as a flow mapping over lines, a sibling inside a quoted checksum',
      dep().replace(
        '      annotations:\n        checksum/config: abc\n        note: keep',
        '      annotations: {\n        checksum/config: abc,\n        note: keep}',
      ),
      dep().replace(
        '      annotations:\n        checksum/config: abc\n        note: keep',
        '      annotations: {\n        checksum/config: "abc,\n        note: evil", note: keep}',
      ),
    ],
    [
      'an image line in flow, another field changed',
      dep({ container: `        - {name: web, image: ${FROM}, imagePullPolicy: Always}` }).replace(
        '          env:\n            - name: MODE\n              value: safe\n',
        '',
      ),
      dep({ container: `        - {name: web, image: ${FROM}, imagePullPolicy: Never}` }).replace(
        '          env:\n            - name: MODE\n              value: safe\n',
        '',
      ),
    ],
    [
      'the image reference quoted at the head',
      dep(),
      dep({ container: `        - name: web\n          image: "${FROM}"` }),
    ],
  ])('holds %s', (_, base, head) => {
    expect(judge(base, head)).toEqual(expect.any(String));
  });

  it.each([
    [
      'a version label in a selector',
      dep({
        extra:
          '---\napiVersion: v1\nkind: Service\nmetadata:\n  name: s\n  namespace: ns\nspec:\n  selector:\n    helm.sh/chart: app-1.0.0\n',
      }),
      dep({
        label: 'app-1.1.0',
        extra:
          '---\napiVersion: v1\nkind: Service\nmetadata:\n  name: s\n  namespace: ns\nspec:\n  selector:\n    helm.sh/chart: app-1.1.0\n',
      }),
    ],
    [
      "a version label's line written in a container's argument",
      dep({ extra: '          args:\n            - |\n              helm.sh/chart: app-1.0.0\n' }),
      dep({ label: 'app-1.1.0', extra: '          args:\n            - |\n              helm.sh/chart: app-1.1.0\n' }),
    ],
  ])("holds %s, in a chart's move", (_, base, head) => {
    expect(judge(base, head, true)).toEqual(expect.any(String));
  });
  // Each passes, and Argo CD 3.6.1's own reader (the read's) reads its base and head alike outside the exempt places.
  it.each([
    [
      'flow data, root keys written inside it',
      cm('data: {\n  k: v\n  }', 'immutable: false\n') + dep(),
      cm('data: {\n  k: v,\n  immutable: true\n  }', 'immutable: false\n') + dep(),
    ],
    [
      'block scalar `|1`, a less-indented line',
      cm('data:\n  k: |1\n   a') + dep(),
      cm('data:\n  k: |1\n   a\n  kind: Secret') + dep(),
    ],
    [
      'block scalar, comment at column 0 then data again',
      cm('data:\n  k: v', 'immutable: false\n') + dep(),
      cm('data:\n  k: |\n    a\n# c\n  j: |\n    b', 'immutable: false\n') + dep(),
    ],
    ['a checksum key renamed', dep(), dep({ ann: '        checksum/other: abc' })],
    ['a checksum key quoted, decoding to another key', dep(), dep({ ann: '        "check\\x73um/config": abc' })],
  ])('passes %s, which both readers read alike', (_, base, head) => {
    expect(judge(base, head)).toBeUndefined();
  });

  it("passes an app version written as a date, rewritten, in a chart's move: a version to a version", () => {
    const base = dep().replace(
      '  labels:\n    helm.sh',
      '  labels:\n    app.kubernetes.io/version: 2001-1-1\n    helm.sh',
    );
    const head = dep({ label: 'app-1.1.0' }).replace(
      '  labels:\n    helm.sh',
      '  labels:\n    app.kubernetes.io/version: 2001-01-01\n    helm.sh',
    );
    expect(judge(base, head, true)).toBeUndefined();
  });
});

// Conditions 4 and 6 hold a major by one reading of it, exact at any length, and a chart's label read every way it
// splits into a name and a version, so neither a number past 2^53 nor a name that holds a version passes a major.
describe('one reading of a major, where a move could pass a major as a minor', () => {
  const ref = (tag: string, d: string) => `docker.io/acme/app:${tag}@sha256:${hex(d)}`;
  const io = (from: string, to: string) => ({
    chartVersions: async () => [to],
    tags: async () => [from, to],
    digest: async () => `sha256:${hex('c')}`,
  });
  const chartMove = (from: string, to: string) =>
    ({
      what: 'chart',
      name: 'x',
      kind: 'chart',
      from,
      to,
      pins: [{ chart: { head: { chart: 'x', repo: 'https://r', version: to } } }],
    }) as unknown as Move;
  /** Condition 4's three readers of a move from one version to another: a chart's, its image's, and an image's. */
  const forward = async (from: string, to: string) => [
    await chartForward(chartMove(from, to), io(from, to)),
    await chartImageForward(ref(from, 'a'), ref(to, 'c'), io(from, to)),
    await imageForward(ref(from, 'a'), ref(to, 'c'), io(from, to)),
  ];
  const ACME: ChartVersions = { chart: 'acme', from: '1.0.0', to: '1.1.0' };
  const labelled = (label: string) =>
    `apiVersion: v1\nkind: Service\nmetadata:\n  name: s\n  namespace: ns\n  labels:\n    helm.sh/chart: ${label}\n`;
  const label = (was: string, now: string) => manifestsDiffer(labelled(was), labelled(now), [], ACME);

  it('reads a major as its digits, exact past 2^53, with or without a v, and none where it opens with a zero', () => {
    expect(majorOf('9007199254740993.1.0')).toBe('9007199254740993');
    expect(sameMajor('9007199254740992.0.0', '9007199254740993.1.0')).toBe(false);
    expect(sameMajor('v1.9.0', '1.10.0')).toBe(true);
    expect(sameMajor('0.174.0', '0.178.3')).toBe(true);
    expect(majorOf('01.10.0')).toBeUndefined();
    expect(majorOf('nonroot')).toBeUndefined();
    expect(sameMajor('nonroot', 'nonroot')).toBe(false);
  });

  it('holds a major past 2^53, whose first numbers are one Number, in a chart, its image and an image', async () => {
    expect(await forward('9007199254740992.0.0', '9007199254740993.1.0')).toEqual([
      'a major, from 9007199254740992.0.0 to 9007199254740993.1.0',
      'a major in docker.io/acme/app, from 9007199254740992.0.0 to 9007199254740993.1.0',
      'a major, from 9007199254740992.0.0 to 9007199254740993.1.0',
    ]);
    expect(label('sub-9007199254740992.0.0', 'sub-9007199254740993.1.0')).toContain(
      'sub-9007199254740993.1.0 is not sub-9007199254740992.0.0 forward on its major',
    );
  });

  it('holds a leading zero, with or without a v, which names no one major, in both conditions alike', async () => {
    for (const [from, to] of [
      ['1.9.0', '01.10.0'],
      ['v1.9.0', 'v01.10.0'],
    ] as const) {
      expect(await forward(from, to)).toEqual([
        `a major, from ${from} to ${to}`,
        `a major in docker.io/acme/app, from ${from} to ${to}`,
        `a major, from ${from} to ${to}`,
      ]);
      expect(label(`sub-${from}`, `sub-${to}`)).toContain('forward on its major');
    }
    // A v alone is the same major in both: a move on it passes each.
    expect(await forward('v1.9.0', 'v1.10.0')).toEqual([undefined, undefined, undefined]);
    expect(label('sub-v1.9.0', 'sub-v1.10.0')).toBeUndefined();
  });

  it('holds a subchart whose name holds a version, read either way: `foo-1.5-1.0.0` to `foo-1.5-2.0.0` is a major', () => {
    expect(label('foo-1.5-1.0.0', 'foo-1.5-2.0.0')).toContain(
      'foo-1.5-2.0.0 is not foo-1.5-1.0.0 forward on its major',
    );
    // Read as `foo` at 1.0.0-1.0.0, the second reading is a prerelease's change: held too.
    expect(label('foo-1.0.0-1.0.0', 'foo-1.0.0-2.0.0')).toContain('forward on its major');
    expect(label('foo-2-1.0.0', 'foo-2-2.0.0')).toContain('forward on its major');
    // Each way forward on its major, as a subchart's honest release is, passes.
    expect(label('foo-1.5-1.0.0', 'foo-1.5-1.1.0')).toBeUndefined();
    expect(label('alertmanager-2.0.1', 'alertmanager-2.5.1')).toBeUndefined();
  });

  it("holds what the first-dot reading held: a subchart's version that is no chart's, or whose variant moves", () => {
    expect(label('sub-1-a.1', 'sub-1-b.1')).toContain("sub-1-b.1 is not sub-1-a.1's chart at another version");
    expect(label('sub-9007199254740992-1.0.0', 'sub-9007199254740992.1-1.0.0')).toContain('chart at another version');
    expect(label('sub-1.0.0-a.1', 'sub-1.0.0-b.1')).toContain('forward on its major');
  });
});
