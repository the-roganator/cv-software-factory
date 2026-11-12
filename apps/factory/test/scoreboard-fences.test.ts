import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEPLOY, manifests as deployManifests } from './deploy.ts';

/**
 * The scoreboard's fences as deploy/ declares them (milestone 6): it is the only reader of the answer key, so no
 * service account of ours may read its namespace's Secrets or start a pod there, nothing reaches it, and it reaches
 * Postgres and DNS alone. `make egress` shows the same on the cluster, and asks the API server who may read them.
 */
interface Rule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
}
interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: { matchLabels?: Record<string, string> };
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  rules?: Rule[];
  subjects?: { kind: string; name: string; namespace?: string }[];
  spec?: Record<string, unknown>;
}

const manifests = () => deployManifests<Manifest>();

const inScoreboard = async () => (await manifests()).filter(({ namespace }) => namespace === 'scoreboard');

/**
 * The AppProjects whose charts may make cluster-wide roles, each with its reason. None deploys into `scoreboard`, and
 * of their controllers only Argo Rollouts' may read Secrets everywhere, which `make egress` allows by name; Grafana's
 * and Loki's sidecars would too, by their charts' defaults, and are kept to their own namespace (below). Argo CD's own
 * controllers, installed by `make up`, may read every Secret, as they must to deploy anything; so may the cluster's.
 */
const MAY_MAKE_CLUSTER_ROLES: Record<string, string> = {
  'software-factory': 'Argo Rollouts, which runs the app’s canaries, and the telemetry charts’ controllers',
  admission: 'Kyverno, which must see every pod it admits',
};

describe('the scoreboard’s Secrets', () => {
  it('are in a namespace of its own, at the restricted standard', async () => {
    const namespace = (await manifests()).find(
      ({ manifest }) => manifest.kind === 'Namespace' && manifest.metadata?.name === 'scoreboard',
    );
    expect(namespace?.manifest.metadata?.labels).toEqual({ 'pod-security.kubernetes.io/enforce': 'restricted' });
  });

  it('can be read by no role deploy/ makes: none names Secrets, and none is cluster-wide', async () => {
    const roles = (await manifests()).filter(({ manifest }) => ['Role', 'ClusterRole'].includes(manifest.kind ?? ''));
    expect(roles.filter(({ manifest }) => manifest.kind === 'ClusterRole')).toEqual([]);
    const secrets = roles.filter(({ manifest }) =>
      (manifest.rules ?? []).some(
        (rule) =>
          rule.apiGroups?.some((g) => g === '' || g === '*') &&
          rule.resources?.some((r) => r === '*' || r === 'secrets'),
      ),
    );
    expect(secrets.map(({ file }) => file)).toEqual([]);
  });

  it('are bound to no one: no role is granted in the scoreboard’s namespace but the line’s list of its Events', async () => {
    const bindings = (await manifests()).filter(({ manifest }) => manifest.kind?.endsWith('RoleBinding'));
    expect(bindings.filter(({ manifest }) => manifest.kind === 'ClusterRoleBinding')).toEqual([]);
    // The line lists the namespace's Events, for admission's denials (refusal-fences.test.ts): nothing else here.
    expect(
      bindings.filter(({ namespace }) => namespace === 'scoreboard').map(({ manifest }) => manifest.metadata?.name),
    ).toEqual(['line-reads-admission']);
    const subjects = bindings.flatMap(({ manifest }) => manifest.subjects ?? []);
    expect(subjects.filter((s) => s.namespace === 'scoreboard')).toEqual([]);
    // Nor any other role there: a right to start a pod in the namespace would be a right to mount its Secrets.
    const roles = (await inScoreboard()).filter(({ manifest }) => manifest.kind === 'Role');
    expect(roles.map(({ manifest }) => [manifest.metadata?.name, manifest.rules])).toEqual([
      ['line-reads-admission', [{ apiGroups: [''], resources: ['events'], verbs: ['list'] }]],
    ]);
  });

  it('are out of reach of every chart: only the factory’s own root deploys into the namespace', async () => {
    const projects = (await manifests()).filter(({ manifest }) => manifest.kind === 'AppProject');
    type Spec = {
      destinations: { namespace: string }[];
      clusterResourceWhitelist?: { group: string; kind: string }[];
    };
    for (const { manifest } of projects) {
      const spec = manifest.spec as Spec;
      expect(
        spec.destinations.map((d) => d.namespace),
        manifest.metadata?.name,
      ).not.toContain('scoreboard');
      expect(
        spec.destinations.map((d) => d.namespace),
        manifest.metadata?.name,
      ).not.toContain('*');
    }
    const clusterRoles = projects.filter(({ manifest }) =>
      (manifest.spec as Spec).clusterResourceWhitelist?.some((r) => r.kind === 'ClusterRole' || r.kind === '*'),
    );
    expect(clusterRoles.map(({ manifest }) => manifest.metadata?.name).sort()).toEqual(
      Object.keys(MAY_MAKE_CLUSTER_ROLES).sort(),
    );
  });

  it('are out of reach of the telemetry charts’ sidecars, which read Secrets in their own namespace alone', async () => {
    for (const chart of ['grafana', 'loki']) {
      const values = parse(await readFile(join(DEPLOY, `base/telemetry/values/${chart}.yaml`), 'utf-8'));
      expect(values.rbac, chart).toEqual({ namespaced: true });
    }
  });
});

describe('the scoreboard’s pod', () => {
  type Container = { args: string[]; env: { name: string; value?: string }[]; volumeMounts: Record<string, unknown>[] };
  type PodSpec = {
    automountServiceAccountToken?: boolean;
    containers: Container[];
    volumes: { name: string; secret?: Record<string, unknown> }[];
  };
  const deployment = async () => {
    const workloads = (await inScoreboard()).filter(({ manifest }) =>
      ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod'].includes(manifest.kind ?? ''),
    );
    expect(workloads.map(({ manifest }) => `${manifest.kind}/${manifest.metadata?.name}`)).toEqual([
      'Deployment/scoreboard',
    ]);
    return workloads[0]?.manifest as Manifest & {
      spec: { replicas: number; template: { metadata: { labels: Record<string, string> }; spec: PodSpec } };
    };
  };

  it('runs once, with no service account token, no Service and no telemetry', async () => {
    const { spec } = await deployment();
    expect(spec.replicas).toBe(1);
    expect(spec.template.spec.automountServiceAccountToken).toBe(false);
    const [container] = spec.template.spec.containers;
    expect(container?.args).toEqual(['src/cli.ts', 'scoreboard']);
    expect(container?.env.filter((e) => e.name.startsWith('OTEL_'))).toEqual([]);
    expect(container?.env.find((e) => e.name === 'PGUSER')?.value).toBe('scoreboard_writer');
    const exposed = (await inScoreboard()).filter(({ manifest }) =>
      ['Service', 'Ingress', 'IngressRoute'].includes(manifest.kind ?? ''),
    );
    expect(exposed).toEqual([]);
  });

  it('mounts the answer key read-only, and runs without one', async () => {
    const { spec } = await deployment();
    const volume = spec.template.spec.volumes.find((v) => v.secret?.secretName === 'answer-key');
    expect(volume?.secret).toMatchObject({ optional: true, items: [{ key: 'key.json', path: 'key.json' }] });
    const [container] = spec.template.spec.containers;
    expect(container?.volumeMounts).toEqual([{ name: volume?.name, mountPath: '/var/run/answer-key', readOnly: true }]);
    expect(container?.env.find((e) => e.name === 'ANSWER_KEY_FILE')?.value).toBe('/var/run/answer-key/key.json');
  });
});

describe('the scoreboard’s fence', () => {
  type NetworkPolicy = Manifest & {
    spec: {
      podSelector: Record<string, unknown>;
      policyTypes: string[];
      ingress?: { from?: Peer[] }[];
      egress?: { to?: Peer[]; ports: { protocol: string; port: number }[] }[];
    };
  };
  const describePeer = (peer: Peer) => [
    peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'],
    peer.podSelector?.matchLabels,
  ];

  it('lets nothing in, and out only to Postgres and DNS, for every pod in the namespace', async () => {
    const policies = (await inScoreboard()).filter(({ manifest }) => manifest.kind === 'NetworkPolicy');
    // Policies add, so a second one could only open the fence.
    expect(policies).toHaveLength(1);
    const policy = policies[0]?.manifest as NetworkPolicy;
    const { spec } = policy;
    expect(spec.podSelector).toEqual({});
    expect(spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(spec.ingress ?? []).toEqual([]);
    expect(
      (spec.egress ?? []).map((rule) => ({
        to: (rule.to ?? []).map(describePeer),
        ports: rule.ports.map((p) => `${p.protocol}/${p.port}`),
      })),
    ).toEqual([
      { to: [['kube-system', { 'k8s-app': 'kube-dns' }]], ports: ['UDP/53', 'TCP/53'] },
      { to: [['factory', { 'app.kubernetes.io/name': 'postgres' }]], ports: ['TCP/5432'] },
    ]);
  });

  it('is let into Postgres by its namespace and its pod’s label together', async () => {
    const all = await manifests();
    const postgres = all.find(
      ({ manifest, namespace }) =>
        manifest.kind === 'NetworkPolicy' && manifest.metadata?.name === 'postgres' && namespace === 'factory',
    )?.manifest as NetworkPolicy;
    const peers = (postgres.spec.ingress ?? []).flatMap((rule) => rule.from ?? []);
    const fromScoreboard = peers.filter((peer) => peer.namespaceSelector);
    expect(fromScoreboard.map(describePeer)).toEqual([['scoreboard', { 'app.kubernetes.io/name': 'scoreboard' }]]);
    const scoreboard = (await inScoreboard()).find(({ manifest }) => manifest.kind === 'Deployment')?.manifest as
      | { spec: { template: { metadata: { labels: Record<string, string> } } } }
      | undefined;
    expect(scoreboard?.spec.template.metadata.labels).toMatchObject({ 'app.kubernetes.io/name': 'scoreboard' });
  });
});
