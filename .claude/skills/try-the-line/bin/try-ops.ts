// The local cluster, Docker, k3d, git and the store as `try` (try.ts) reads and changes them. The store is only read,
// with selects, as its owner, the way bin/q reads it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deployment, Line, Ops, Root, Workload } from './try.ts';
import { NAMESPACES, POLICY } from './try.ts';

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

function deployment(d: Item): Deployment {
  const spec = d.spec.template.spec;
  const all = [
    ...(spec.initContainers ?? []).map((c) => ({ ...c, init: true })),
    ...spec.containers.map((c) => ({ ...c, init: false })),
  ];
  const s = d.status ?? {};
  const want = d.spec.replicas ?? 1;
  return {
    name: d.metadata.name,
    containers: all.map((c) => ({ name: c.name, init: c.init, image: c.image })),
    env: all.flatMap((c) =>
      (c.env ?? []).map((e) => ({
        container: c.name,
        name: e.name,
        ...(e.value === undefined ? {} : { value: e.value }),
        fromRef: e.valueFrom !== undefined,
      })),
    ),
    rolledOut:
      (s.observedGeneration ?? 0) >= d.metadata.generation &&
      (s.updatedReplicas ?? 0) === want &&
      (s.availableReplicas ?? 0) === want &&
      (s.replicas ?? 0) === want,
  };
}

export const ops: Ops = {
  holder() {
    const board = join(checkout(), 'scratch', 'workflow', 'board.yaml');
    if (!existsSync(board)) return undefined;
    const m = /^cluster:\n(?:[ \t]+.*\n)*?[ \t]+holder:[ \t]*"?([^"\s#]+)/m.exec(readFileSync(board, 'utf8'));
    return m ? m[1] : 'none';
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
          ownedByDeployment: (item.metadata.ownerReferences ?? []).some((o) => o.kind === 'ReplicaSet'),
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
    for (const ref of [`origin/${branch}`, branch]) {
      const r = spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        encoding: 'utf8',
      });
      if (r.status === 0) return r.stdout.trim();
    }
    return undefined;
  },
  changed(commit) {
    return run('git', ['-C', checkout(), 'diff', '--name-only', `origin/main...${commit}`])
      .split('\n')
      .filter(Boolean);
  },
  hasLocal(ref) {
    return ok('docker', ['image', 'inspect', ref]);
  },
  build(commit, dockerfile, ref) {
    // From a detached worktree of the commit, never anyone's checkout, removed after.
    const dir = mkdtempSync(join(tmpdir(), 'try-build-'));
    const tree = join(dir, 'tree');
    run('git', ['-C', checkout(), 'worktree', 'add', '-q', '--detach', tree, commit]);
    try {
      run('docker', ['build', '-f', dockerfile, '--build-arg', `GIT_COMMIT=${commit}`, '-t', ref, '.'], {
        cwd: tree,
        timeoutMs: 20 * 60_000,
        show: true,
      });
    } finally {
      run('git', ['-C', checkout(), 'worktree', 'remove', '--force', tree]);
      rmSync(dir, { recursive: true, force: true });
    }
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
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
  now: () => new Date(),
  say: (line) => console.log(line),
};
