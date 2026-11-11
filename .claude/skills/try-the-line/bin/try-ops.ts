// The local cluster, Docker, k3d, git and the store as `try` (try.ts) reads and changes them. The store is only read,
// with selects, as its owner, the way bin/q reads it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';
import type { Deployment, K8sObject, Line, ObjectRef, Ops, Root, Workload } from './try.ts';
import { asDeployment, groupOf, NAMESPACES, POLICY } from './try.ts';

/** Only the fields of Kubernetes' objects that are read here. */
interface K8sContainer {
  name: string;
  image: string;
  env?: { name: string; value?: string; valueFrom?: unknown }[];
}
interface PodSpec {
  initContainers?: K8sContainer[];
  containers: K8sContainer[];
}
interface Item {
  kind: string;
  metadata: { name: string; generation: number; ownerReferences?: { kind: string }[] };
  spec: PodSpec & {
    replicas?: number;
    template: { spec: PodSpec };
    syncPolicy?: Record<string, unknown>;
    validationActions?: string[];
  };
  status?: {
    observedGeneration?: number;
    replicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    sync?: { status?: string };
    health?: { status?: string };
    initContainerStatuses?: { image?: string; imageID?: string }[];
    containerStatuses?: { image?: string; imageID?: string }[];
  };
}

const CONTEXT = 'k3d-software-factory';
const CLUSTER = 'software-factory';
const NODE = 'k3d-software-factory-server-0';

function run(
  command: string,
  args: string[],
  options: { input?: string; cwd?: string; timeoutMs?: number; show?: boolean } = {},
): string {
  const r = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.show ? ['ignore', 'inherit', 'inherit'] : 'pipe',
  });
  if (r.error) throw new Error(`${command} ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${r.status}: ${(r.stderr ?? '').trim()}`);
  return r.stdout ?? '';
}
const ok = (command: string, args: string[]): boolean =>
  spawnSync(command, args, { stdio: 'ignore', timeout: 60_000 }).status === 0;
const kubectl = (...args: string[]): string => run('kubectl', ['--context', CONTEXT, ...args]);
const get = (...args: string[]): Item => JSON.parse(kubectl(...args, '-o', 'json'));
const list = (...args: string[]): Item[] => (JSON.parse(kubectl(...args, '-o', 'json')) as { items: Item[] }).items;
const sql = (query: string): string =>
  kubectl(
    '-n',
    'factory',
    'exec',
    '-i',
    'postgres-0',
    '--',
    'psql',
    '-U',
    'factory',
    '-d',
    'factory',
    '-X',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    query,
  ).trim();

/** The checkout this script is in, so the board and the branches are found from any worktree. */
function checkout(): string {
  const common = run('git', [
    '-C',
    import.meta.dirname,
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).trim();
  return join(common, '..');
}

/** Runs `use` in a detached worktree of the commit, never anyone's checkout, removed after. */
function inTree<T>(commit: string, use: (tree: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'try-tree-'));
  const tree = join(dir, 'tree');
  run('git', ['-C', checkout(), 'worktree', 'add', '-q', '--detach', tree, commit]);
  try {
    return use(tree);
  } finally {
    run('git', ['-C', checkout(), 'worktree', 'remove', '--force', tree]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The resource kubectl names an object's kind by: `rolebinding.rbac.authorization.k8s.io`, `serviceaccount`. */
const resource = (ref: ObjectRef): string => {
  const group = groupOf(ref.apiVersion);
  return `${ref.kind.toLowerCase()}${group ? `.${group}` : ''}`;
};
const scope = (ref: ObjectRef): string[] => (ref.namespace ? ['-n', ref.namespace] : []);

function deployment(d: Item): Deployment {
  const s = d.status ?? {};
  const want = d.spec.replicas ?? 1;
  return asDeployment(
    d as unknown as K8sObject,
    (s.observedGeneration ?? 0) >= d.metadata.generation &&
      (s.updatedReplicas ?? 0) === want &&
      (s.availableReplicas ?? 0) === want &&
      (s.replicas ?? 0) === want,
  );
}

export const ops: Ops = {
  holder() {
    const board = join(checkout(), 'scratch', 'workflow', 'board.yaml');
    if (!existsSync(board)) return undefined;
    const holder = (parse(readFileSync(board, 'utf8')) as { cluster?: { holder?: unknown } } | null)?.cluster?.holder;
    return typeof holder === 'string' && holder ? holder : 'none';
  },
  root(): Root {
    const app = get('-n', 'argocd', 'get', 'application', 'root');
    return {
      syncPolicy: app.spec.syncPolicy,
      sync: app.status?.sync?.status ?? 'Unknown',
      health: app.status?.health?.status ?? 'Unknown',
    };
  },
  pauseRoot() {
    kubectl(
      '-n',
      'argocd',
      'patch',
      'application',
      'root',
      '--type',
      'json',
      '-p',
      '[{"op":"remove","path":"/spec/syncPolicy/automated"}]',
    );
  },
  setRootPolicy(policy) {
    kubectl(
      '-n',
      'argocd',
      'patch',
      'application',
      'root',
      '--type',
      'json',
      '-p',
      JSON.stringify([{ op: 'replace', path: '/spec/syncPolicy', value: policy }]),
    );
  },
  policies() {
    return Object.fromEntries(
      list('get', 'imagevalidatingpolicy').map((p) => [p.metadata.name, p.spec.validationActions ?? []]),
    );
  },
  setFactoryImages(actions) {
    kubectl(
      'patch',
      'imagevalidatingpolicy',
      POLICY,
      '--type',
      'merge',
      '-p',
      JSON.stringify({ spec: { validationActions: actions } }),
    );
  },
  deployments() {
    return list('-n', 'factory', 'get', 'deployments').map(deployment);
  },
  setImages(name, images) {
    kubectl(
      '-n',
      'factory',
      'set',
      'image',
      `deployment/${name}`,
      ...Object.entries(images).map(([c, i]) => `${c}=${i}`),
    );
  },
  setEnv(name, container, env) {
    const args = Object.entries(env).map(([k, v]) => (v === null ? `${k}-` : `${k}=${v}`));
    kubectl('-n', 'factory', 'set', 'env', `deployment/${name}`, '-c', container, ...args);
  },
  rollout(name, seconds) {
    return ok('kubectl', [
      '--context',
      CONTEXT,
      '-n',
      'factory',
      'rollout',
      'status',
      `deployment/${name}`,
      `--timeout=${seconds}s`,
    ]);
  },
  workloads() {
    const out: Workload[] = [];
    for (const ns of NAMESPACES) {
      for (const item of list('-n', ns, 'get', 'pods,jobs')) {
        const pod = item.kind === 'Pod';
        const spec = pod ? item.spec : item.spec.template.spec;
        const statuses = pod
          ? [...(item.status?.initContainerStatuses ?? []), ...(item.status?.containerStatuses ?? [])]
          : [];
        out.push({
          namespace: ns,
          kind: pod ? 'pod' : 'job',
          name: item.metadata.name,
          owned: (item.metadata.ownerReferences ?? []).some((o) => o.kind === 'ReplicaSet' || o.kind === 'Job'),
          images: [
            ...[...(spec.initContainers ?? []), ...spec.containers].map((c) => c.image),
            ...statuses.flatMap((s) => [s.image, s.imageID].filter((x): x is string => Boolean(x))),
          ],
        });
      }
    }
    return out;
  },
  remove(w) {
    kubectl(
      '-n',
      w.namespace,
      'delete',
      w.kind,
      w.name,
      '--wait=false',
      '--ignore-not-found',
      ...(w.kind === 'job' ? ['--cascade=foreground'] : []),
    );
  },
  line(): Line {
    const state = sql(
      "select type from events where type in ('line.started','line.stopped') order by seq desc limit 1",
    );
    const take = sql("select payload->'take' from events where type = 'controls.changed' order by seq desc limit 1");
    return {
      state: state === 'line.started' ? 'started' : state === 'line.stopped' ? 'stopped' : 'never',
      take: take ? JSON.parse(take) : null,
      seq: Number(sql('select coalesce(max(seq), 0) from events')),
    };
  },
  workItemsSince(seq) {
    return sql(
      `select distinct work_item from events where seq > ${Math.trunc(seq)} and work_item is not null order by 1`,
    )
      .split('\n')
      .filter(Boolean);
  },
  commit(branch) {
    const dir = checkout();
    for (const ref of [`refs/heads/${branch}`, `origin/${branch}`]) {
      const r = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        encoding: 'utf8',
      });
      if (r.status === 0) return r.stdout.trim();
    }
    return undefined;
  },
  mergeBase(commit) {
    return run('git', ['-C', checkout(), 'merge-base', 'origin/main', commit]).trim();
  },
  added(commit) {
    return run('git', ['-C', checkout(), 'diff', '--name-only', '--diff-filter=A', `origin/main...${commit}`])
      .split('\n')
      .filter(Boolean);
  },
  changed(commit) {
    return run('git', ['-C', checkout(), 'diff', '--name-only', `origin/main...${commit}`])
      .split('\n')
      .filter(Boolean);
  },
  render(commit) {
    return inTree(commit, (tree) =>
      parseAllDocuments(run('kubectl', ['kustomize', 'deploy/overlays/local'], { cwd: tree, timeoutMs: 5 * 60_000 }))
        .map((d) => d.toJS() as K8sObject | null)
        .filter((o): o is K8sObject => Boolean(o?.kind)),
    );
  },
  getObject(ref) {
    const out = kubectl('get', resource(ref), ref.name, ...scope(ref), '--ignore-not-found', '-o', 'json').trim();
    return out ? (JSON.parse(out) as K8sObject) : undefined;
  },
  applyObject(object) {
    run(
      'kubectl',
      ['--context', CONTEXT, 'apply', '--server-side', '--field-manager=try', '--force-conflicts', '-f', '-'],
      {
        input: JSON.stringify(object),
      },
    );
  },
  replaceObject(object) {
    const input = JSON.stringify(object);
    try {
      run('kubectl', ['--context', CONTEXT, 'replace', '-f', '-'], { input });
    } catch {
      // A field the API will not change in place (a Service's clusterIP, a selector): delete and make it again.
      run('kubectl', ['--context', CONTEXT, 'replace', '--force', '-f', '-'], { input });
    }
  },
  deleteObject(ref) {
    // In the foreground, so the object stays, and try end waits, until what it owns (a Deployment's pods) is gone too.
    kubectl(
      'delete',
      resource(ref),
      ref.name,
      ...scope(ref),
      '--ignore-not-found',
      '--cascade=foreground',
      '--wait=false',
    );
  },
  migrations() {
    return new Map(
      sql('select version, name from schema_migrations order by version')
        .split('\n')
        .filter(Boolean)
        .map((row) => {
          const [version = '', name = ''] = row.split('|');
          return [Number(version), name] as const;
        }),
    );
  },
  hasLocal(ref) {
    return ok('docker', ['image', 'inspect', ref]);
  },
  build(commit, dockerfile, ref) {
    inTree(commit, (tree) =>
      run('docker', ['build', '-f', dockerfile, '--build-arg', `GIT_COMMIT=${commit}`, '-t', ref, '.'], {
        cwd: tree,
        timeoutMs: 20 * 60_000,
        show: true,
      }),
    );
  },
  load(refs) {
    run('k3d', ['image', 'import', '-c', CLUSTER, ...refs], { timeoutMs: 10 * 60_000, show: true });
  },
  onNode(ref) {
    const out = run('docker', ['exec', NODE, 'ctr', '-n', 'k8s.io', 'images', 'ls', `name==${ref}`]);
    const row = out.split('\n').slice(1).find(Boolean);
    return row?.trim().split(/\s+/)[2];
  },
  namedOnNode(digest) {
    return run('docker', ['exec', NODE, 'ctr', '-n', 'k8s.io', 'images', 'ls'])
      .split('\n')
      .slice(1)
      .map((row) => row.trim().split(/\s+/))
      .filter((cols) => cols[2] === digest)
      .flatMap((cols) => (cols[0] ? [cols[0]] : []));
  },
  tagOnNode(ref, as) {
    run('docker', ['exec', NODE, 'ctr', '-n', 'k8s.io', 'images', 'tag', '--force', ref, as]);
  },
  removeFromNode(ref) {
    run('docker', ['exec', NODE, 'ctr', '-n', 'k8s.io', 'images', 'rm', ref]);
  },
  removeLocal(ref) {
    run('docker', ['rmi', ref]);
  },
  alive(pid) {
    // A begin, not whatever has the pid since (a reboot, or reuse).
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.includes('try-cli.ts') && r.stdout.includes(' begin');
  },
  sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
  now: () => new Date(),
  say: (line) => console.log(line),
};
