import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Deployment, K8sObject, Line, ObjectRef, Ops, State, Workload } from './try.ts';
import {
  asDeployment,
  main,
  migrationWarnings,
  parse,
  plan,
  REGISTRY,
  Refused,
  readState,
  unappliable,
  writeState,
} from './try.ts';

const MAIN = `${REGISTRY}/factory@sha256:${'a'.repeat(64)}`;
const RUNNER = `${REGISTRY}/factory-runner@sha256:${'b'.repeat(64)}`;
const CONSOLE = `${REGISTRY}/console@sha256:${'c'.repeat(64)}`;
const COMMIT = '1234567890abcdef1234567890abcdef12345678';
const POLICY_NAMES = ['factory-images', 'flagd-images', 'scoreboard-images', 'website-images'];
const AUTOMATED = { automated: { prune: true, selfHeal: true }, syncOptions: ['RespectIgnoreDifferences=true'] };

function deployment(name: string, containers: [string, string, boolean?][], env: Deployment['env'] = []): Deployment {
  return {
    name,
    containers: containers.map(([n, image, init]) => ({ name: n, image, init: init ?? false })),
    env,
    rolledOut: true,
  };
}

const key = (r: { name: string; namespace?: string; kind?: string }, kind = r.kind): string =>
  `${kind}/${r.namespace ?? ''}/${r.name}`;

/** A rendered object, as kustomize gives it. */
function object(
  kind: string,
  name: string,
  namespace: string | undefined,
  rest: Record<string, unknown> = {},
): K8sObject {
  const apiVersion =
    { Deployment: 'apps/v1', RoleBinding: 'rbac.authorization.k8s.io/v1', NetworkPolicy: 'networking.k8s.io/v1' }[
      kind
    ] ?? 'v1';
  return { apiVersion, kind, metadata: { name, ...(namespace ? { namespace } : {}) }, ...rest };
}
const rendered = (name: string, image: string) =>
  object('Deployment', name, 'factory', { spec: { template: { spec: { containers: [{ name, image }] } } } });

/** A cluster, a store, a node and a Mac, in memory, with every call written down. */
class Cluster implements Ops {
  board: string | undefined = 'try-script';
  syncPolicy: Record<string, unknown> | undefined = structuredClone(AUTOMATED);
  sync = 'Synced';
  health = 'Healthy';
  actions: Record<string, string[]> = Object.fromEntries(POLICY_NAMES.map((n) => [n, ['Deny']]));
  deps: Deployment[] = [
    deployment(
      'line',
      [
        ['runner-image', RUNNER, true],
        ['line', MAIN],
      ],
      [
        { container: 'line', name: 'RUNNER_IMAGE', value: RUNNER, fromRef: false },
        { container: 'line', name: 'LINE_MODE', value: 'live', fromRef: false },
        { container: 'line', name: 'PGPASSWORD', fromRef: true },
      ],
    ),
    deployment(
      'github',
      [['github', MAIN]],
      [{ container: 'github', name: 'GITHUB_DRY_RUN', value: 'false', fromRef: false }],
    ),
    deployment('gateway', [['gateway', MAIN]]),
    deployment('console', [['console', CONSOLE]]),
    deployment('postgres-exporter', [['postgres-exporter', 'quay.io/prometheuscommunity/postgres-exporter:v0.20.1']]),
  ];
  extra: Workload[] = [];
  lineState: Line = { state: 'stopped', take: { kind: 'just-one', workItem: '1019' }, seq: 788 };
  moved: string[] = [];
  branches: Record<string, string> = { 'feat/x': COMMIT };
  changes: string[] = ['apps/factory/src/line/machine.ts'];
  mac = new Set<string>();
  node = new Map<string, string>();
  /** Whether `load` puts the images on the node; false is the mistyped tag of 10 Nov. */
  loads = true;
  /** Whether Argo CD would put back what root owns once root is automated again. */
  selfHeals = true;
  /** The live objects the try may apply over, by kind, namespace and name; and each commit's render. */
  objects = new Map<string, K8sObject>();
  renders: Record<string, K8sObject[]> = {};
  storeMigrations = new Map<number, string>([[49, 'admin-step-up-ended']]);
  calls: string[] = [];
  said: string[] = [];
  clock = 0;
  pidAlive = false;
  failAt: string | undefined;

  private call(what: string): void {
    this.calls.push(what);
    if (this.failAt && what.startsWith(this.failAt)) throw new Error(`killed at ${what}`);
  }
  private dep(name: string): Deployment {
    return this.deps.find((d) => d.name === name) as Deployment;
  }

  holder = () => this.board;
  root = () => ({ syncPolicy: structuredClone(this.syncPolicy), sync: this.sync, health: this.health });
  pauseRoot() {
    this.call('pauseRoot');
    const { automated: _, ...rest } = this.syncPolicy ?? {};
    this.syncPolicy = rest;
  }
  setRootPolicy(policy: Record<string, unknown>) {
    this.call('setRootPolicy');
    this.syncPolicy = structuredClone(policy);
    if (this.selfHeals) this.actions['factory-images'] = ['Deny'];
  }
  policies = () => structuredClone(this.actions);
  setFactoryImages(actions: string[]) {
    this.call(`setFactoryImages ${actions}`);
    this.actions['factory-images'] = actions;
  }
  deployments = () => structuredClone(this.deps);
  setImages(name: string, images: Record<string, string>) {
    this.call(`setImages ${name} ${JSON.stringify(images)}`);
    for (const c of this.dep(name).containers) {
      const image = images[c.name];
      if (image) c.image = image;
    }
  }
  setEnv(name: string, container: string, env: Record<string, string | null>) {
    this.call(`setEnv ${name} ${container} ${JSON.stringify(env)}`);
    const d = this.dep(name);
    for (const [k, v] of Object.entries(env)) {
      d.env = d.env.filter((e) => !(e.container === container && e.name === k));
      if (v !== null) d.env.push({ container, name: k, value: v, fromRef: false });
    }
  }
  rollout = (name: string, _seconds?: number) => {
    this.call(`rollout ${name}`);
    return true;
  };
  workloads = (): Workload[] => [
    ...this.deps.map((d) => ({
      namespace: 'factory',
      kind: 'pod' as const,
      name: `${d.name}-abc`,
      owned: true,
      images: d.containers.map((c) => c.image),
    })),
    ...this.extra,
  ];
  remove(w: Workload) {
    this.call(`remove ${w.namespace}/${w.name}`);
    this.extra = this.extra.filter((x) => x !== w);
  }
  line = () => structuredClone(this.lineState);
  workItemsSince = () => this.moved;
  commit = (branch: string) => this.branches[branch];
  changed = () => this.changes;
  mergeBase = () => 'origin/main';
  added = () => this.changes;
  render = (commit: string) => structuredClone(this.renders[commit] ?? []);
  getObject = (ref: ObjectRef) => structuredClone(this.objects.get(key(ref)));
  applyObject(o: K8sObject) {
    this.call(`applyObject ${key(o.metadata as unknown as ObjectRef, o.kind)}`);
    this.put(o);
  }
  replaceObject(o: K8sObject) {
    this.call(`replaceObject ${key(o.metadata as unknown as ObjectRef, o.kind)}`);
    if (o.metadata.resourceVersion) throw new Error('replace with a resourceVersion');
    this.put(o);
  }
  deleteObject(ref: ObjectRef) {
    this.call(`deleteObject ${key(ref)}`);
    this.objects.delete(key(ref));
    if (ref.kind === 'Deployment') this.deps = this.deps.filter((d) => d.name !== ref.name);
  }
  private put(o: K8sObject) {
    this.objects.set(key(o.metadata as unknown as ObjectRef, o.kind), structuredClone(o));
    if (o.kind === 'Deployment' && o.metadata.namespace === 'factory') {
      this.deps = [...this.deps.filter((d) => d.name !== o.metadata.name), asDeployment(o, true)];
    }
  }
  migrations = () => new Map(this.storeMigrations);
  hasLocal = (ref: string) => this.mac.has(ref);
  build(_: string, dockerfile: string, ref: string) {
    this.call(`build ${dockerfile} ${ref}`);
    this.mac.add(ref);
  }
  load(refs: string[]) {
    this.call('load');
    if (!this.loads) return;
    for (const r of refs) {
      const digest = `sha256:${(r.includes('runner') ? 'e' : 'd').repeat(64)}`;
      this.node.set(r, digest);
      // k3d's import also names the image by its id, which no deployment points at.
      this.node.set(`sha256:${r.includes('runner') ? '1' : '2'}${'0'.repeat(63)}`, digest);
    }
  }
  onNode = (ref: string) => this.node.get(ref);
  namedOnNode = (digest: string) => [...this.node].filter(([, d]) => d === digest).map(([name]) => name);
  tagOnNode(ref: string, as: string) {
    this.call(`tagOnNode ${as}`);
    this.node.set(as, this.node.get(ref) as string);
  }
  removeFromNode(ref: string) {
    this.call(`removeFromNode ${ref}`);
    this.node.delete(ref);
  }
  removeLocal(ref: string) {
    this.call(`removeLocal ${ref}`);
    this.mac.delete(ref);
  }
  alive = () => this.pidAlive;
  sleep(ms: number) {
    this.clock += ms;
  }
  now = () => new Date(Date.UTC(2026, 10, 10, 23) + this.clock);
  say(line: string) {
    this.said.push(line);
  }
}

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'try-'));
  path = join(dir, 'try', 'state.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const begin = (c: Cluster, ...args: string[]) => main(['begin', 'feat/x', '--holder', 'try-script', ...args], c, path);
const end = (c: Cluster) => main(['end', '--timeout', '60'], c, path);
const said = (c: Cluster) => c.said.join('\n');
/** The state a begin on another cluster writes, read back and removed, to stand for someone else's try. */
async function openState(c: Cluster): Promise<State> {
  const other = Object.assign(new Cluster(), { branches: c.branches });
  expect(await begin(other)).toBe(0);
  const state = readState(path) as State;
  rmSync(path);
  return { ...state, phase: 'beginning' };
}
/** The cluster as a fresh shell sees it after a begin: a new Ops that shares nothing with the first but the cluster. */
function fresh(c: Cluster): Cluster {
  const d = new Cluster();
  const shared = [
    'board',
    'syncPolicy',
    'sync',
    'health',
    'actions',
    'deps',
    'extra',
    'lineState',
    'moved',
    'branches',
    'changes',
    'clock',
    'objects',
    'renders',
    'storeMigrations',
  ] as const;
  for (const k of shared) Object.assign(d, { [k]: structuredClone(c[k]) });
  d.mac = new Set(c.mac);
  d.node = new Map(c.node);
  return d;
}

describe('the state file', () => {
  const state: State = {
    version: 2,
    phase: 'open',
    holder: 'try-script',
    user: 'martin',
    host: 'mac',
    pid: 1,
    began: '2026-11-10T23:00:00.000Z',
    branch: 'feat/x',
    commit: COMMIT,
    tag: 'local-12345678',
    root: AUTOMATED,
    policies: { 'factory-images': ['Deny'] },
    line: { state: 'stopped', take: null, seq: 1 },
    deployments: [{ name: 'github', images: { github: MAIN }, env: [] }],
    images: [{ image: 'factory', ref: `${REGISTRY}/factory:local-12345678`, existed: false }],
    nodeRefs: [],
    applied: [
      { ref: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'patching', namespace: 'factory' }, before: null },
      {
        ref: { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', name: 'github', namespace: 'factory' },
        before: object('NetworkPolicy', 'github', 'factory', { spec: {} }),
      },
    ],
  };

  it('reads back what it wrote, in a directory it makes, readable by its owner alone', () => {
    writeState(path, state, true);
    expect(readState(path)).toEqual(state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reads no state as no try open', () => {
    expect(readState(path)).toBeUndefined();
  });

  it('refuses a second create, so two begins cannot both hold the cluster', () => {
    writeState(path, state, true);
    expect(() => writeState(path, state, true)).toThrow(/EEXIST/);
  });

  it('refuses a file it cannot read, rather than taking it for no try', () => {
    writeState(path, state, true);
    writeFileSync(path, '{"version":1');
    expect(() => readState(path)).toThrow(Refused);
    writeFileSync(path, JSON.stringify({ ...state, version: 1 }));
    expect(() => readState(path)).toThrow(/version 1, not 2/);
    const { root: _, ...noRoot } = state;
    writeFileSync(path, JSON.stringify(noRoot));
    expect(() => readState(path)).toThrow(/lacks root/);
    writeFileSync(path, JSON.stringify({ ...state, deployments: [{ name: 'github', images: null, env: [] }] }));
    expect(() => readState(path)).toThrow(/a deployment it cannot read/);
    writeFileSync(
      path,
      JSON.stringify({ ...state, applied: [{ ref: { kind: 'Deployment', name: 'x' }, before: null }] }),
    );
    expect(() => readState(path)).toThrow(/an applied object it cannot read/);
    writeFileSync(path, JSON.stringify({ ...state, applied: [{ ref: state.applied[1]?.ref }] }));
    expect(() => readState(path)).toThrow(/without what was there before/);
    const { applied: _a, ...noApplied } = state;
    writeFileSync(path, JSON.stringify(noApplied));
    expect(() => readState(path)).toThrow(/lacks applied/);
    // A try begun by the script before it applied objects is still read, with none, so it can be ended.
    writeFileSync(path, JSON.stringify({ ...noApplied, version: 1 }));
    expect(readState(path)?.applied).toEqual([]);
    writeFileSync(path, JSON.stringify({ ...state, nodeRefs: [1] }));
    expect(() => readState(path)).toThrow(/lacks nodeRefs/);
    writeFileSync(path, JSON.stringify({ ...state, images: [{ image: 'factory' }] }));
    expect(() => readState(path)).toThrow(/an image it cannot read/);
  });

  it('replaces the file whole on each later write, leaving nothing beside it', () => {
    writeState(path, state, true);
    writeState(path, { ...state, phase: 'beginning' });
    expect(readState(path)?.phase).toBe('beginning');
    expect(readdirSync(join(dir, 'try'))).toEqual(['state.json']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('try begin', () => {
  it("records what it changes before it changes it, then moves the factory's deployments onto the branch", async () => {
    const c = new Cluster();
    expect(await begin(c)).toBe(0);
    const state = readState(path) as State;
    expect(state.phase).toBe('open');
    expect(state.root).toEqual(AUTOMATED);
    expect(state.policies['factory-images']).toEqual(['Deny']);
    expect(state.line).toEqual({ state: 'stopped', take: { kind: 'just-one', workItem: '1019' }, seq: 788 });
    expect(state.deployments.map((d) => d.name)).toEqual(['line', 'github', 'gateway']);
    expect(state.deployments[0]).toEqual({
      name: 'line',
      images: { 'runner-image': RUNNER, line: MAIN },
      env: [{ container: 'line', name: 'RUNNER_IMAGE', was: RUNNER, to: '', image: 'factory-runner' }],
    });
    // The images are built and on the node before root is paused or anything points at them.
    const first = (p: string) => c.calls.findIndex((x) => x.startsWith(p));
    expect(first('build')).toBeLessThan(first('pauseRoot'));
    expect(first('tagOnNode')).toBeLessThan(first('setImages'));
    expect(c.actions).toEqual({
      ...Object.fromEntries(POLICY_NAMES.map((n) => [n, ['Deny']])),
      'factory-images': ['Audit'],
    });
    const line = c.deployments().find((d) => d.name === 'line') as Deployment;
    const runner = `${REGISTRY}/factory-runner@sha256:${'e'.repeat(64)}`;
    expect(line.containers.map((x) => x.image)).toEqual([runner, `${REGISTRY}/factory@sha256:${'d'.repeat(64)}`]);
    expect(line.env.find((e) => e.name === 'RUNNER_IMAGE')?.value).toBe(runner);
    expect(c.deployments().find((d) => d.name === 'console')?.containers[0]?.image).toBe(CONSOLE);
    expect(said(c)).toMatch(/try end/);
  });

  it('moves only the deployments named, and sets a variable recording what it was', async () => {
    const c = new Cluster();
    expect(
      await begin(
        c,
        '--only',
        'github',
        '--env',
        'github:GITHUB_DRY_RUN=true',
        '--env',
        'github:GITHUB_DRY_RUN_MERGE_SECONDS=30',
      ),
    ).toBe(0);
    const state = readState(path) as State;
    expect(state.images.map((i) => i.image)).toEqual(['factory']);
    expect(state.deployments).toEqual([
      {
        name: 'github',
        images: { github: MAIN },
        env: [
          { container: 'github', name: 'GITHUB_DRY_RUN', was: 'false', to: 'true' },
          { container: 'github', name: 'GITHUB_DRY_RUN_MERGE_SECONDS', was: null, to: '30' },
        ],
      },
    ]);
    expect(c.calls.filter((x) => x.startsWith('setImages')).length).toBe(1);
  });

  it('touches no image policy but factory-images', async () => {
    const c = new Cluster();
    expect(await begin(c)).toBe(0);
    await end(fresh(c));
    for (const name of ['flagd-images', 'scoreboard-images', 'website-images']) {
      expect(c.calls.join('\n')).not.toContain(name);
    }
  });

  describe('refuses, changing nothing', () => {
    const refusals: [string, (c: Cluster) => void, RegExp, string[]?][] = [
      ['when the board names another holder', (c) => (c.board = 'someone-else'), /holder is someone-else/],
      ['when the board names no holder', (c) => (c.board = 'none'), /write yourself on it/],
      ['when Argo CD root is paused', (c) => (c.syncPolicy = {}), /root is paused/],
      [
        'when an image policy is not on Deny',
        (c) => (c.actions['factory-images'] = ['Audit']),
        /factory-images is on \["Audit"\]/,
      ],
      [
        'when a pod runs a local image',
        (c) =>
          c.extra.push({
            namespace: 'runners',
            kind: 'pod',
            name: 'x',
            owned: false,
            images: [`${REGISTRY}/factory:local-abc123`],
          }),
        /pod runners\/x runs/,
      ],
      ['when root is not Synced', (c) => (c.sync = 'OutOfSync'), /OutOfSync/],
      ['when the branch is unknown', (c) => (c.branches = {}), /no branch feat\/x/],
      [
        "when the branch's render differs on what it does not apply",
        (c) => {
          c.changes.push('deploy/base/factory/line.yaml');
          c.renders[COMMIT] = [object('ConfigMap', 'line', 'factory', { data: { a: '1' } })];
        },
        /ConfigMap factory\/line \(--apply ConfigMap\/line\)/,
      ],
      ['when the branch adds a migration', (c) => c.changes.push('packages/store/migrations/0099.sql'), /--by-hand/],
      ["when a deployment is not the factory's", () => {}, /no deployment scoreboard/, ['--only', 'scoreboard']],
      [
        'when a deployment runs none of our images',
        () => {},
        /none of this repository's images/,
        ['--only', 'postgres-exporter'],
      ],
      ['when a variable comes from a Secret', () => {}, /Secret or ConfigMap/, ['--env', 'line:PGPASSWORD=x']],
      ['when a variable names no container', () => {}, /no deployment nope/, ['--env', 'nope:X=1']],
    ];
    for (const [what, set, message, args] of refusals) {
      it(what, async () => {
        const c = new Cluster();
        set(c);
        expect(await begin(c, ...(args ?? []))).toBe(2);
        expect(said(c)).toMatch(message);
        expect(c.calls).toEqual([]);
        expect(existsSync(path)).toBe(false);
      });
    }

    it('when a try is open', async () => {
      const c = new Cluster();
      expect(await begin(c)).toBe(0);
      const calls = c.calls.length;
      expect(await begin(c)).toBe(2);
      expect(said(c)).toMatch(/a try is open: feat\/x since .* by try-script/);
      expect(c.calls.length).toBe(calls);
    });

    it('without a holder, when there is a board', async () => {
      const c = new Cluster();
      expect(await main(['begin', 'feat/x'], c, path)).toBe(2);
      expect(said(c)).toMatch(/--holder/);
    });
  });

  it('points nothing at an image the node does not hold, and leaves the state for try end', async () => {
    const c = new Cluster();
    c.loads = false;
    expect(await begin(c)).toBe(2);
    expect(said(c)).toMatch(/not on the node after loading it/);
    expect(c.calls.some((x) => /setImages|pauseRoot|setFactoryImages/.test(x))).toBe(false);
    expect(readState(path)?.phase).toBe('beginning');
    expect(await end(fresh(c))).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a branch whose image is the one main runs, which removing it from the node would take away', async () => {
    const c = new Cluster();
    c.deps = c.deps.map((d) =>
      d.name === 'github' ? deployment('github', [['github', `${REGISTRY}/factory@sha256:${'d'.repeat(64)}`]]) : d,
    );
    expect(await begin(c, '--only', 'github')).toBe(2);
    expect(said(c)).toMatch(/is the image main runs/);
    expect(c.calls.some((x) => /tagOnNode|setImages|pauseRoot/.test(x))).toBe(false);
  });

  it("leaves main's image on the node when try end follows a begin refused for building it", async () => {
    const c = new Cluster();
    const mains = `${REGISTRY}/factory@sha256:${'d'.repeat(64)}`;
    c.deps = c.deps.map((d) => (d.name === 'github' ? deployment('github', [['github', mains]]) : d));
    c.node.set(mains, `sha256:${'d'.repeat(64)}`);
    expect(await begin(c, '--only', 'github')).toBe(2);
    const after = fresh(c);
    expect(await end(after)).toBe(0);
    expect(after.node.get(mains)).toBe(`sha256:${'d'.repeat(64)}`);
    expect(after.node.has(`${REGISTRY}/factory:local-12345678`)).toBe(false);
  });

  it('takes a value beginning with @ as the value it is', async () => {
    const c = new Cluster();
    expect(await begin(c, '--only', 'github', '--env', 'github:HANDLE=@me')).toBe(0);
    expect(c.deps.find((d) => d.name === 'github')?.env.find((e) => e.name === 'HANDLE')?.value).toBe('@me');
  });

  it("sends no one to end another's try when it loses the race to begin", async () => {
    const c = new Cluster();
    writeState(path, { ...(await openState(c)), pid: process.pid + 1 });
    expect(await begin(c)).toBe(2);
    expect(said(c)).not.toMatch(/stopped part way/);
  });

  it('reuses an image the Mac already had, and leaves it there after', async () => {
    const c = new Cluster();
    c.mac.add(`${REGISTRY}/factory:local-12345678`);
    expect(await begin(c, '--only', 'github')).toBe(0);
    expect(c.calls.some((x) => x.startsWith('build'))).toBe(false);
    const after = fresh(c);
    await end(after);
    expect(after.mac.has(`${REGISTRY}/factory:local-12345678`)).toBe(true);
  });
});

describe('try end', () => {
  it('puts everything back from the state file alone, from a shell that never saw the begin', async () => {
    const c = new Cluster();
    const before = structuredClone({ syncPolicy: c.syncPolicy, actions: c.actions, deps: c.deps });
    expect(
      await begin(c, '--only', 'github,line', '--env', 'line:LINE_MODE=dry-run', '--env', 'line:ALL_LOCAL=true'),
    ).toBe(0);
    c.extra.push(
      {
        namespace: 'runners',
        kind: 'job',
        name: 'coder-1-1-1',
        owned: false,
        images: [`${REGISTRY}/factory-runner@sha256:${'e'.repeat(64)}`],
      },
      { namespace: 'runners', kind: 'job', name: 'mains', owned: false, images: [RUNNER] },
    );
    const after = fresh(c);
    expect(await end(after)).toBe(0);
    const sorted = (deps: Deployment[]) =>
      deps.map((d) => ({
        ...d,
        env: [...d.env].sort((a, b) => `${a.container}/${a.name}`.localeCompare(`${b.container}/${b.name}`)),
      }));
    expect({ syncPolicy: after.syncPolicy, actions: after.actions, deps: sorted(after.deps) }).toEqual({
      ...before,
      deps: sorted(before.deps),
    });
    expect(after.extra.map((w) => w.name)).toEqual(['mains']);
    expect(after.node.size).toBe(0);
    expect(after.mac.size).toBe(0);
    expect(existsSync(path)).toBe(false);
    // The images go back before admission is on Deny again, and root gets its policy last of the three.
    const at = (p: string) => after.calls.findIndex((x) => x.startsWith(p));
    expect(at('setImages')).toBeLessThan(at('setFactoryImages'));
    expect(at('setFactoryImages')).toBeLessThan(at('setRootPolicy'));
    expect(said(after)).toMatch(/The line is stopped/);
  });

  it('puts back a begin killed part way, after root was paused', async () => {
    const c = new Cluster();
    c.failAt = 'setImages github';
    await expect(begin(c, '--only', 'github')).rejects.toThrow(/killed/);
    expect(c.syncPolicy?.automated).toBeUndefined();
    expect(readState(path)?.phase).toBe('beginning');
    const after = fresh(c);
    after.failAt = undefined;
    expect(await end(after)).toBe(0);
    expect(after.syncPolicy).toEqual(AUTOMATED);
    expect(after.actions['factory-images']).toEqual(['Deny']);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses while the begin that opened the try is still running', async () => {
    const c = new Cluster();
    c.failAt = 'pauseRoot';
    await expect(begin(c)).rejects.toThrow();
    const state = readState(path) as State;
    writeState(path, { ...state, pid: process.pid + 1 });
    const after = fresh(c);
    after.pidAlive = true;
    expect(await end(after)).toBe(2);
    expect(said(after)).toMatch(/still running/);
    expect(after.calls).toEqual([]);
  });

  it("refuses, changing nothing, while the line is started on the try's images", async () => {
    const c = new Cluster();
    expect(await begin(c)).toBe(0);
    const after = fresh(c);
    after.lineState.state = 'started';
    expect(await end(after)).toBe(2);
    expect(said(after)).toMatch(/make stop-the-line/);
    expect(after.calls).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('reads the line again before it changes a deployment, and stops if it was started meanwhile', async () => {
    const c = new Cluster();
    expect(await begin(c)).toBe(0);
    const after = fresh(c);
    after.extra.push({
      namespace: 'runners',
      kind: 'job',
      name: 'j',
      owned: false,
      images: [`${REGISTRY}/factory:local-12345678`],
    });
    let reads = 0;
    after.line = () => ({ ...after.lineState, state: reads++ === 0 ? 'stopped' : 'started' });
    expect(await end(after)).toBe(2);
    expect(said(after)).toMatch(/was started while/);
    expect(after.calls).toEqual(['remove runners/j']);
    expect(existsSync(path)).toBe(true);
  });

  it('says what is not back, keeps the state, and finishes when run again', async () => {
    const c = new Cluster();
    expect(await begin(c, '--only', 'github')).toBe(0);
    const stuck = fresh(c);
    stuck.health = 'Degraded';
    expect(await end(stuck)).toBe(1);
    expect(said(stuck)).toMatch(/Not back after 60s[\s\S]*root is Synced and Degraded/);
    expect(existsSync(path)).toBe(true);
    const again = fresh(stuck);
    again.health = 'Healthy';
    expect(await end(again)).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it('names the take and the work items the try moved, for Martin, and writes neither', async () => {
    const c = new Cluster();
    expect(await begin(c, '--only', 'github')).toBe(0);
    const after = fresh(c);
    after.lineState = { state: 'stopped', take: { kind: 'every' }, seq: 800 };
    after.moved = ['1040'];
    await end(after);
    expect(said(after)).toMatch(/The take is \{"kind":"every"\}.*Martin's to set back/);
    expect(said(after)).toMatch(/Work items with events since seq 788: 1040/);
  });

  it('waits for every rollout within the one --timeout, so factory-images is not left on Audit longer', async () => {
    const c = new Cluster();
    expect(await begin(c)).toBe(0);
    const after = fresh(c);
    const asked: number[] = [];
    after.rollout = (_: string, seconds?: number) => {
      if (seconds === undefined) throw new Error('no bound');
      asked.push(seconds);
      after.clock += seconds * 1000;
      return false;
    };
    await end(after);
    expect(asked[0]).toBe(60);
    expect(asked.slice(1).every((s) => s === 1)).toBe(true);
  });

  it('carries on past a workload already gone', async () => {
    const c = new Cluster();
    expect(await begin(c, '--only', 'github')).toBe(0);
    const after = fresh(c);
    after.extra.push({
      namespace: 'runners',
      kind: 'job',
      name: 'gone',
      owned: false,
      images: [`${REGISTRY}/factory:local-12345678`],
    });
    after.remove = (w: Workload) => {
      after.extra = after.extra.filter((x) => x !== w);
      throw new Error('NotFound');
    };
    expect(await end(after)).toBe(0);
    expect(said(after)).toMatch(/Could not delete job runners\/gone/);
  });

  it('puts back a variable that was set to the empty string as empty, not removed', async () => {
    const c = new Cluster();
    c.deps.find((d) => d.name === 'github')?.env.push({ container: 'github', name: 'FLAG', value: '', fromRef: false });
    expect(await begin(c, '--only', 'github', '--env', 'github:FLAG=1')).toBe(0);
    expect(readState(path)?.deployments[0]?.env.find((v) => v.name === 'FLAG')?.was).toBe('');
    const after = fresh(c);
    await end(after);
    expect(after.deps.find((d) => d.name === 'github')?.env.find((e) => e.name === 'FLAG')?.value).toBe('');
  });

  it('refuses, changing nothing, when the store cannot be read and the try moved the line', async () => {
    const c = new Cluster();
    expect(await begin(c)).toBe(0);
    const after = fresh(c);
    after.line = () => {
      throw new Error('postgres-0 not found');
    };
    expect(await end(after)).toBe(2);
    expect(said(after)).toMatch(/whether the line is started is not known/);
    expect(after.calls).toEqual([]);
  });

  it('puts back without the store when the try did not move the line', async () => {
    const c = new Cluster();
    expect(await begin(c, '--only', 'github')).toBe(0);
    const after = fresh(c);
    after.line = () => {
      throw new Error('postgres-0 not found');
    };
    expect(await end(after)).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it('with no try open, says so and succeeds', async () => {
    const c = new Cluster();
    expect(await end(c)).toBe(0);
    expect(said(c)).toBe('No try is open.');
  });
});

describe('try status', () => {
  it('says what is open, since when, by whom, and what is changed', async () => {
    const c = new Cluster();
    expect(await begin(c, '--only', 'github', '--env', 'github:GITHUB_DRY_RUN=true')).toBe(0);
    const other = fresh(c);
    expect(await main(['status'], other, path)).toBe(0);
    const out = said(other);
    expect(out).toMatch(/feat\/x \(12345678, local-12345678\) is open/);
    expect(out).toMatch(/Begun 2026-11-10T23:00:00.000Z by try-script/);
    expect(out).toMatch(/github: github moved; GITHUB_DRY_RUN \(was false\)/);
    expect(out).toMatch(/root's sync policy is/);
    expect(out).toMatch(/factory-images is on \["Audit"\]/);
    expect(other.calls).toEqual([]);
  });

  it('names a try by hand when none is open by the script', async () => {
    const c = new Cluster();
    c.syncPolicy = {};
    await main(['status'], c, path);
    expect(said(c)).toMatch(/root is paused/);
  });
});

describe("objects from the branch's render", () => {
  /** The branch adds a worker (its Deployment, ServiceAccount, a RoleBinding in two namespaces) and changes github's
   * NetworkPolicy; main's render has only the NetworkPolicy as it is live. */
  function branchWithWorker(): Cluster {
    const c = new Cluster();
    c.changes = ['deploy/base/factory/patching.yaml', 'apps/factory/src/patching/sense.ts'];
    const mainsPolicy = object('NetworkPolicy', 'github', 'factory', { spec: { podSelector: {}, ingress: [] } });
    const live = {
      ...structuredClone(mainsPolicy),
      metadata: { ...mainsPolicy.metadata, resourceVersion: '7', uid: 'u' },
      status: {},
    };
    c.objects.set('NetworkPolicy/factory/github', live as K8sObject);
    c.renders['origin/main'] = [mainsPolicy];
    c.renders[COMMIT] = [
      object('NetworkPolicy', 'github', 'factory', {
        spec: { podSelector: {}, ingress: [{ from: [{ podSelector: { matchLabels: { app: 'patching' } } }] }] },
      }),
      rendered('patching', MAIN),
      object('ServiceAccount', 'patching', 'factory'),
      object('RoleBinding', 'patching-lists-pods', 'factory'),
      object('RoleBinding', 'patching-lists-pods', 'telemetry'),
    ];
    return c;
  }
  const ALL = [
    '--apply',
    'Deployment/patching,ServiceAccount/patching',
    '--apply',
    'RoleBinding/patching-lists-pods,NetworkPolicy/github',
  ];

  it('applies the named objects after root is paused, records what was there, and moves a Deployment main lacks', async () => {
    const c = branchWithWorker();
    expect(await begin(c, '--only', 'patching', ...ALL)).toBe(0);
    const state = readState(path) as State;
    expect(state.applied.map((a) => [a.ref.kind, a.ref.namespace, a.ref.name, a.before === null])).toEqual([
      ['Deployment', 'factory', 'patching', true],
      ['ServiceAccount', 'factory', 'patching', true],
      ['RoleBinding', 'factory', 'patching-lists-pods', true],
      ['RoleBinding', 'telemetry', 'patching-lists-pods', true],
      ['NetworkPolicy', 'factory', 'github', false],
    ]);
    expect(state.applied[4]?.before?.metadata.resourceVersion).toBe('7');
    const at = (p: string) => c.calls.findIndex((x) => x.startsWith(p));
    expect(at('pauseRoot')).toBeLessThan(at('applyObject'));
    expect(at('applyObject')).toBeLessThan(at('setImages patching'));
    expect(c.objects.get('Deployment/factory/patching')?.metadata.annotations?.['argocd.argoproj.io/tracking-id']).toBe(
      'root:apps/Deployment:factory/patching',
    );
    expect(
      c.objects.get('ServiceAccount/factory/patching')?.metadata.annotations?.['argocd.argoproj.io/tracking-id'],
    ).toBe('root:/ServiceAccount:factory/patching');
    expect(c.deps.find((d) => d.name === 'patching')?.containers[0]?.image).toBe(
      `${REGISTRY}/factory@sha256:${'d'.repeat(64)}`,
    );
  });

  it('told only what to apply, moves no deployment and builds nothing', async () => {
    const c = branchWithWorker();
    expect(await begin(c, ...ALL)).toBe(0);
    expect(c.calls.some((x) => /build|load|setImages|setEnv/.test(x))).toBe(false);
    expect(readState(path)?.deployments).toEqual([]);
    const after = fresh(c);
    expect(await end(after)).toBe(0);
    expect(after.objects.has('Deployment/factory/patching')).toBe(false);
  });

  it('names every object it added or changed in try status', async () => {
    const c = branchWithWorker();
    expect(await begin(c, '--only', 'patching', ...ALL)).toBe(0);
    const other = fresh(c);
    await main(['status'], other, path);
    const out = said(other);
    for (const line of [
      'added: Deployment factory/patching',
      'added: ServiceAccount factory/patching',
      'added: RoleBinding factory/patching-lists-pods',
      'added: RoleBinding telemetry/patching-lists-pods',
      'changed: NetworkPolicy factory/github',
    ]) {
      expect(out).toContain(line);
    }
    expect(out).toMatch(/Deployment factory\/patching, which the try added, is still there/);
  });

  it('removes what it added and puts back what it changed, from a fresh shell, leaving nothing to prune', async () => {
    const c = branchWithWorker();
    const before = structuredClone([...c.objects]);
    expect(await begin(c, '--only', 'patching', ...ALL)).toBe(0);
    const after = fresh(c);
    expect(await end(after)).toBe(0);
    const stripped = (o: K8sObject) => {
      const { resourceVersion: _r, uid: _u, ...metadata } = o.metadata as Record<string, unknown>;
      const { status: _s, ...rest } = o;
      return { ...rest, metadata };
    };
    expect([...after.objects].map(([k, o]) => [k, stripped(o)])).toEqual(before.map(([k, o]) => [k, stripped(o)]));
    expect(after.deps.some((d) => d.name === 'patching')).toBe(false);
    expect(existsSync(path)).toBe(false);
    // The changed one goes back before the deployments, the last applied first.
    expect(after.calls.filter((x) => /Object/.test(x))).toEqual([
      'replaceObject NetworkPolicy/factory/github',
      'deleteObject RoleBinding/telemetry/patching-lists-pods',
      'deleteObject RoleBinding/factory/patching-lists-pods',
      'deleteObject ServiceAccount/factory/patching',
      'deleteObject Deployment/factory/patching',
    ]);
  });

  it('keeps the state while an object is not back, and says which', async () => {
    const c = branchWithWorker();
    expect(await begin(c, '--only', 'patching', ...ALL)).toBe(0);
    const stuck = fresh(c);
    stuck.deleteObject = () => {
      throw new Error('forbidden');
    };
    expect(await end(stuck)).toBe(1);
    expect(said(stuck)).toMatch(/Could not put back Deployment factory\/patching \(forbidden\)/);
    expect(said(stuck)).toMatch(/ServiceAccount factory\/patching, which the try added, is still there/);
    expect(existsSync(path)).toBe(true);
  });

  it("applies no admission, secret, namespace, Job or cluster-wide object but a worker's own RBAC", () => {
    const cases: [K8sObject, RegExp | undefined][] = [
      [object('Namespace', 'website', undefined), /Namespace, which a try never applies/],
      [object('ValidatingPolicy', 'website-mark', undefined), /ValidatingPolicy/],
      [object('ValidatingAdmissionPolicy', 'flagd-flags', undefined), /ValidatingAdmissionPolicy/],
      [object('ImageValidatingPolicy', 'factory-images', undefined), /ImageValidatingPolicy/],
      [object('Secret', 'postgres-patching', 'factory'), /Secret/],
      [object('Job', 'migrate', 'factory'), /Job/],
      [object('ClusterAnalysisTemplate', 'website-step', undefined), /cluster-wide/],
      [object('RoleBinding', 'patching-lists-pods', 'website'), /in website, where a try applies nothing/],
      [object('ConfigMap', 'x', 'argocd'), /in argocd/],
      [object('ClusterRole', 'patching-lists-pods', undefined), undefined],
      [object('RoleBinding', 'patching-lists-pods', 'telemetry'), undefined],
      [object('NetworkPolicy', 'github', 'factory'), undefined],
    ];
    for (const [o, why] of cases) {
      if (why) expect(unappliable(o)).toMatch(why);
      else expect(unappliable(o)).toBeUndefined();
    }
  });

  it('names an object it will not apply as by hand, never with an --apply that would be refused', async () => {
    const c = branchWithWorker();
    c.renders[COMMIT]?.push(object('ValidatingPolicy', 'factory-red-team-pods', undefined, { spec: {} }));
    expect(await begin(c, '--only', 'patching', ...ALL)).toBe(2);
    expect(said(c)).toMatch(/ValidatingPolicy factory-red-team-pods \(a ValidatingPolicy, which a try never applies/);
    expect(said(c)).not.toMatch(/--apply ValidatingPolicy/);
  });

  it('replaces a changed object whole, so a field the branch drops is gone for the try', async () => {
    const c = branchWithWorker();
    const live = c.objects.get('NetworkPolicy/factory/github') as K8sObject;
    (live.spec as Record<string, unknown>).egress = [{}];
    expect(await begin(c, '--only', 'patching', ...ALL)).toBe(0);
    expect(c.calls).toContain('replaceObject NetworkPolicy/factory/github');
    expect(
      (c.objects.get('NetworkPolicy/factory/github')?.spec as Record<string, unknown> | undefined)?.egress,
    ).toBeUndefined();
    const after = fresh(c);
    expect(await end(after)).toBe(0);
    expect(
      (after.objects.get('NetworkPolicy/factory/github')?.spec as Record<string, unknown> | undefined)?.egress,
    ).toEqual([{}]);
  });

  it('makes a changed object again if it was deleted during the try, and counts what the API writes as back', async () => {
    const c = branchWithWorker();
    expect(await begin(c, '--only', 'patching', ...ALL)).toBe(0);
    const after = fresh(c);
    after.objects.delete('NetworkPolicy/factory/github');
    const apply = after.applyObject.bind(after);
    after.applyObject = (o: K8sObject) => {
      apply(o);
      const put = after.objects.get('NetworkPolicy/factory/github');
      if (put) put.metadata.annotations = { ...put.metadata.annotations, 'deployment.kubernetes.io/revision': '9' };
    };
    expect(await end(after)).toBe(0);
    expect(after.calls).toContain('applyObject NetworkPolicy/factory/github');
    expect(after.calls.some((x) => x.startsWith('setImages patching') || x.startsWith('rollout patching'))).toBe(false);
  });

  describe('refuses, changing nothing', () => {
    const cases: [string, string[], RegExp][] = [
      [
        'what the render differs on and the try does not apply',
        ['--apply', 'Deployment/patching'],
        /ServiceAccount factory\/patching \(--apply ServiceAccount\/patching\)/,
      ],
      ['an object the render lacks', ['--apply', 'Deployment/nope'], /no Deployment nope/],
      [
        'an object in a namespace a try leaves alone',
        ['--apply', 'Service/website', '--by-hand'],
        /in website, where a try applies nothing/,
      ],
      [
        'an image policy',
        ['--apply', 'ImageValidatingPolicy/website-images', '--by-hand'],
        /ImageValidatingPolicy, which a try never applies/,
      ],
      ['a Deployment main lacks, without --apply', ['--only', 'patching', '--by-hand'], /no deployment patching/],
    ];
    for (const [what, args, message] of cases) {
      it(what, async () => {
        const c = branchWithWorker();
        c.renders[COMMIT]?.push(
          object('Service', 'website', 'website'),
          object('ImageValidatingPolicy', 'website-images', undefined),
        );
        expect(await begin(c, ...args)).toBe(2);
        expect(said(c)).toMatch(message);
        expect(c.calls).toEqual([]);
        expect(existsSync(path)).toBe(false);
      });
    }

    it('an object the branch removes, which only --by-hand takes', async () => {
      const c = branchWithWorker();
      c.renders['origin/main']?.push(object('ConfigMap', 'old', 'factory'));
      expect(await begin(c, '--only', 'patching', ...ALL)).toBe(2);
      expect(said(c)).toMatch(/ConfigMap factory\/old, which the branch removes/);
      expect(await begin(c, '--only', 'patching', ...ALL, '--by-hand')).toBe(0);
    });
  });
});

describe('a migration the branch adds', () => {
  it('is named, with the risk of its number, when the store lacks it or holds it as another', () => {
    const store = new Map([
      [49, 'admin-step-up-ended'],
      [50, 'something-else'],
    ]);
    expect(migrationWarnings(['packages/store/migrations/0049_admin-step-up-ended.sql', 'apps/x.ts'], store)).toEqual(
      [],
    );
    expect(migrationWarnings(['packages/store/migrations/0051_patching.sql'], store)).toEqual([
      "migration 0051_patching is not in the store: run there for the try, it records 51 as applied, and if a different 0051 merges first, main's 0051 never runs on this store until schema_migrations is put right by hand.",
    ]);
    expect(migrationWarnings(['packages/store/migrations/0050_patching.sql'], store)[0]).toMatch(
      /already holds 50 as something-else, so this one would never run there/,
    );
  });

  it('needs --by-hand, and begin and status warn of it, writing nothing to the store', async () => {
    const c = new Cluster();
    c.changes = ['packages/store/migrations/0050_patching.sql'];
    expect(await begin(c, '--only', 'github')).toBe(2);
    expect(said(c)).toMatch(/0050_patching.sql \(the skill's step 7: Martin's write\)/);
    expect(await begin(c, '--only', 'github', '--by-hand')).toBe(0);
    expect(said(c)).toMatch(/Warning: migration 0050_patching is not in the store/);
    const other = fresh(c);
    await main(['status'], other, path);
    expect(said(other)).toMatch(/Warning: migration 0050_patching is not in the store/);
    expect(other.storeMigrations).toEqual(new Map([[49, 'admin-step-up-ended']]));
  });
});

describe('the command line', () => {
  it('takes --only one value at a time, comma-separated, so a branch after it stays the branch', () => {
    expect(parse(['begin', '--only', 'line,github', '--only', 'red-team', 'b', '--holder', 'k'])).toEqual({
      command: 'begin',
      options: { branch: 'b', only: ['line', 'github', 'red-team'], env: [], holder: 'k', byHand: false, apply: [] },
    });
  });
  it("bounds end's wait at twenty minutes", () => {
    expect(() => parse(['end', '--timeout', '1201'])).toThrow(/1200 seconds/);
  });
  it('refuses what it does not know', () => {
    expect(() => parse(['begin'])).toThrow(/which branch/);
    expect(() => parse(['begin', 'b', '--force'])).toThrow(/unknown --force/);
    expect(() => parse(['stop'])).toThrow(/usage/);
  });
  it("plans the default from the images the line's code is built into", () => {
    expect(plan(new Cluster().deps, { only: [], env: [] }).moves.map((m) => m.name)).toEqual([
      'line',
      'github',
      'gateway',
    ]);
  });
});

it('keeps its state outside the repository', async () => {
  const { statePath } = await import('./try.ts');
  expect(statePath({ HOME: '/h' } as NodeJS.ProcessEnv)).toMatch(/\.config\/software-factory\/try\/state\.json$/);
});
