import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { DEPLOY, manifests as deployManifests } from './deploy.ts';

/**
 * The release's fences as deploy/ declares them: who may change a Rollout (the admin service alone, held by admission to
 * the fields Martin's controls set), what the line may read of a release, what the analysis Job may reach, and what
 * the app's own pods may reach and be reached by.
 */
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  rules?: { apiGroups?: string[]; resources?: string[]; resourceNames?: string[]; verbs?: string[] }[];
  roleRef?: { kind: string; name: string };
  subjects?: { kind: string; name: string; namespace?: string }[];
  spec?: Record<string, unknown>;
}

const manifests = () => deployManifests<Manifest>();

const READ = ['get', 'list', 'watch'];

describe('changing a release is Martin’s: the admin service’s, for his controls, or make stop-the-line', () => {
  /** Each rule of a Role or ClusterRole that may change a Rollout, or its status. */
  const changes = async () =>
    (await manifests())
      .filter(({ manifest }) => ['Role', 'ClusterRole'].includes(manifest.kind ?? ''))
      .flatMap(({ file, manifest }) =>
        (manifest.rules ?? [])
          .filter(
            (rule) =>
              rule.apiGroups?.some((g) => g === 'argoproj.io' || g === '*') &&
              rule.resources?.some((r) => r === '*' || r.startsWith('rollouts')) &&
              rule.verbs?.some((v) => !READ.includes(v)),
          )
          .map((rule) => ({ file, kind: manifest.kind, name: manifest.metadata?.name, rule })),
      );

  it('gives one Role alone the right to change a Rollout: the admin service’s, on the app’s, by name', async () => {
    expect(await changes()).toEqual([
      {
        file: 'base/analysis/admin-controls-release.yaml',
        kind: 'Role',
        name: 'admin-controls-release',
        rule: {
          apiGroups: ['argoproj.io'],
          resources: ['rollouts'],
          resourceNames: ['website'],
          verbs: ['get', 'patch'],
        },
      },
      {
        file: 'base/analysis/admin-controls-release.yaml',
        kind: 'Role',
        name: 'admin-controls-release',
        rule: {
          apiGroups: ['argoproj.io'],
          resources: ['rollouts/status'],
          resourceNames: ['website'],
          verbs: ['patch'],
        },
      },
    ]);
    const all = await manifests();
    const role = all.find(
      ({ manifest }) => manifest.kind === 'Role' && manifest.metadata?.name === 'admin-controls-release',
    );
    expect(role?.manifest.metadata?.namespace).toBe('website');
    // Those two rules, and nothing else: no other kind, and nothing in any other namespace.
    expect(role?.manifest.rules).toHaveLength(2);
    // Bound to the admin service's own service account, and to nobody else.
    const bound = all.filter(({ manifest }) => manifest.roleRef?.name === 'admin-controls-release');
    expect(bound.map(({ manifest }) => [manifest.kind, manifest.metadata?.namespace, manifest.subjects])).toEqual([
      ['RoleBinding', 'website', [{ kind: 'ServiceAccount', name: 'admin', namespace: 'factory' }]],
    ]);
    // And the admin service's account holds no other right, anywhere, but its Role on `flags` (flag-fences.test.ts) and
    // its list of the app's EndpointSlices, to find its pods (admin-fences.test.ts).
    const admins = all.filter(({ manifest }) =>
      manifest.subjects?.some((s) => s.kind === 'ServiceAccount' && s.name === 'admin' && s.namespace === 'factory'),
    );
    expect(admins.map(({ manifest }) => manifest.roleRef?.name).sort()).toEqual([
      'admin-controls-release',
      'admin-finds-app-pods',
      'admin-stages-flags',
    ]);
  });

  it('holds the admin service’s every change to the Rollout to the fields the controls set', async () => {
    type Policy = Omit<Manifest, 'spec'> & {
      spec: {
        failurePolicy: string;
        policyName?: string;
        validationActions?: string[];
        matchConstraints: { resourceRules: { apiGroups: string[]; operations: string[]; resources: string[] }[] };
        matchConditions: { expression: string }[];
        variables: { name: string; expression: string }[];
        validations: { expression: string }[];
      };
    };
    const all = await deployManifests<Policy>();
    const policy = all.find(
      ({ manifest }) => manifest.kind === 'ValidatingAdmissionPolicy' && manifest.metadata?.name === 'rollout-controls',
    );
    expect(policy?.file).toBe('base/admission/website/rollout-controls.yaml');
    const spec = policy?.manifest.spec;
    expect(spec?.failurePolicy).toBe('Fail');
    expect(spec?.matchConstraints.resourceRules).toEqual([
      { apiGroups: ['argoproj.io'], apiVersions: ['*'], operations: ['*'], resources: ['rollouts', 'rollouts/status'] },
    ]);
    // The admin service's account alone, by the name Kubernetes gives its requests.
    expect(spec?.matchConditions.map((c) => c.expression)).toEqual([
      "request.userInfo.username == 'system:serviceaccount:factory:admin'",
    ]);
    // The fields it may change, and no more: a field added here is a field the admin service may change.
    const listed = (name: string) =>
      [...(spec?.variables.find((v) => v.name === name)?.expression ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(listed('spec')).toEqual(['paused']);
    expect(listed('status')).toEqual([
      'abort',
      'currentStepIndex',
      'pauseConditions',
      'controllerPause',
      'promoteFull',
    ]);
    expect(spec?.validations[0]?.expression).toBe("request.operation == 'UPDATE'");
    const binding = all.find(
      ({ manifest }) =>
        manifest.kind === 'ValidatingAdmissionPolicyBinding' && manifest.metadata?.name === 'rollout-controls',
    );
    expect(binding?.manifest.spec).toEqual({ policyName: 'rollout-controls', validationActions: ['Deny'] });
    // As Argo CD renders it, the binding names the policy by the name the directory's prefix gives both.
    const rendered = parseAllDocuments(
      execFileSync('kustomize', ['build', join(DEPLOY, 'base/admission/website')], { encoding: 'utf-8' }),
    ).map((doc) => doc.toJS() as Policy);
    const named = (kind: string) =>
      rendered.find((r) => r.kind === kind && r.metadata?.name === 'website-rollout-controls');
    expect(named('ValidatingAdmissionPolicy')).toBeDefined();
    expect(named('ValidatingAdmissionPolicyBinding')?.spec.policyName).toBe('website-rollout-controls');
  });

  it('was answered by the cluster as the Role and the policy say (scripts/rollout-refusals.sh)', async () => {
    const kept = (
      JSON.parse(await readFile(join(DEPLOY, 'test', 'rollout-refusals.json'), 'utf-8')) as {
        cases: {
          case: string;
          outcome: string;
          message: string;
        }[];
      }
    ).cases;
    expect(Object.fromEntries(kept.map((k) => [k.case, k.outcome]))).toEqual({
      pause: 'admitted',
      resume: 'admitted',
      abort: 'admitted',
      retry: 'admitted',
      promote: 'admitted',
      'promote-fully': 'admitted',
      image: 'refused',
      steps: 'refused',
      replicas: 'refused',
      label: 'refused',
      'step-back': 'refused',
      'step-dropped': 'refused',
      stable: 'refused',
      weights: 'refused',
      'pause-condition': 'refused',
      delete: 'refused',
      traffic: 'refused',
    });
    // Each refused by what should refuse it: the Role for what it does not name, the policy for the rest.
    const byRole = ['delete', 'traffic'];
    for (const refusal of kept.filter((k) => k.outcome === 'refused')) {
      expect(refusal.message, refusal.case).toContain(
        byRole.includes(refusal.case)
          ? 'User "system:serviceaccount:factory:admin" cannot'
          : "ValidatingAdmissionPolicy 'website-rollout-controls'",
      );
    }
  });

  it('binds nobody to the built-in roles that could change one, and adds Rollouts to none of them', async () => {
    const bindings = (await manifests()).filter(({ manifest }) => manifest.kind?.endsWith('RoleBinding'));
    const builtIn = bindings.filter(({ manifest }) =>
      ['cluster-admin', 'admin', 'edit'].includes(manifest.roleRef?.name ?? ''),
    );
    expect(builtIn).toEqual([]);
    // The chart would otherwise aggregate the right to change Rollouts into `admin` and `edit`.
    const values = parse(await readFile(join(DEPLOY, 'base/rollouts/values.yaml'), 'utf-8'));
    expect(values.createClusterAggregateRoles).toBe(false);
  });
});

describe('the line’s watch of a release', () => {
  it('may read the app’s Rollout, its AnalysisRuns and the journeys’ pods, and nothing else in the app’s namespace', async () => {
    const all = await manifests();
    const line = all.filter(({ manifest }) =>
      manifest.subjects?.some((s) => s.kind === 'ServiceAccount' && s.name === 'line' && s.namespace === 'factory'),
    );
    // Nothing cluster-wide: each right is a Role's, in one namespace.
    expect(line.filter(({ manifest }) => manifest.kind !== 'RoleBinding')).toEqual([]);
    const inWebsite = line.filter(({ manifest }) => manifest.metadata?.namespace === 'website');
    // And its list of the namespace's Events, for admission's denials (refusal-fences.test.ts).
    expect(inWebsite.map(({ manifest }) => manifest.roleRef)).toEqual([
      { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'line-reads-admission' },
      { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'line-reads-release' },
    ]);
    const role = all.find(
      ({ manifest }) =>
        manifest.kind === 'Role' &&
        manifest.metadata?.namespace === 'website' &&
        manifest.metadata?.name === 'line-reads-release',
    );
    // Pods to list, for a journeys Job's termination message: not their logs, nor any Job, Secret or other kind.
    expect(role?.manifest.rules).toEqual([
      { apiGroups: ['argoproj.io'], resources: ['rollouts', 'analysisruns'], verbs: READ },
      { apiGroups: [''], resources: ['pods'], verbs: ['list'] },
    ]);
  });
});

describe('the line’s Verify', () => {
  type Peer = { namespaceSelector?: { matchLabels: Record<string, string> }; podSelector?: Record<string, unknown> };
  type Rule = { to?: Peer[]; from?: Peer[]; ports: { protocol: string; port: number }[] };
  type Policy = Manifest & { spec: { ingress?: Rule[]; egress?: Rule[] } };
  const policy = async (name: string) =>
    (await manifests()).find(
      ({ manifest }) =>
        manifest.kind === 'NetworkPolicy' &&
        manifest.metadata?.name === name &&
        (manifest.metadata?.namespace ?? 'factory') === 'factory',
    )?.manifest as Policy;
  const peers = (rules: Rule[] = [], side: 'to' | 'from') =>
    rules.map((rule) => ({
      peers: (rule[side] ?? []).map((peer) => [
        peer.namespaceSelector?.matchLabels['kubernetes.io/metadata.name'] ?? 'factory',
        peer.podSelector,
      ]),
      ports: rule.ports.map((p) => `${p.protocol}/${p.port}`),
    }));

  it('reaches the probes’ verification, and Prometheus, Loki and Tempo through the read-only proxy alone', async () => {
    const egress = peers((await policy('line')).spec.egress, 'to');
    expect(egress).toContainEqual({
      peers: [['factory', { matchLabels: { 'app.kubernetes.io/name': 'probes' } }]],
      ports: ['TCP/8081'],
    });
    // Every rule of the line's that leaves its own namespace, by any namespace selector: the proxy's pods, on the ports
    // of the three backends (Tempo's query port, for the log watcher's agreement check), and never a backend itself
    // (telemetry-fences.test.ts).
    const raw = (await policy('line')).spec.egress ?? [];
    const elsewhere = raw.filter((rule) => rule.to?.some((peer) => peer.namespaceSelector !== undefined));
    expect(peers(elsewhere, 'to')).toEqual([
      {
        peers: [['telemetry', { matchLabels: { 'app.kubernetes.io/name': 'query' } }]],
        ports: ['TCP/9090', 'TCP/3100', 'TCP/3200'],
      },
    ]);
  });

  it('is let in by the probes on the verification’s port alone, and the page reader’s is triage’s', async () => {
    expect(peers((await policy('probes')).spec.ingress, 'from')).toEqual([
      { peers: [['factory', { matchLabels: { 'app.kubernetes.io/name': 'triage' } }]], ports: ['TCP/8080'] },
      { peers: [['factory', { matchLabels: { 'app.kubernetes.io/name': 'line' } }]], ports: ['TCP/8081'] },
    ]);
  });
});

describe("the analysis Job's fence", () => {
  it('selects the pods the journeys Job makes, in the namespace it runs in', async () => {
    const all = await manifests();
    const policy = all.find(
      ({ manifest }) => manifest.kind === 'NetworkPolicy' && manifest.metadata?.name === 'journeys',
    )?.manifest as Manifest & { spec: { podSelector: { matchLabels: Record<string, string> } } };
    expect(policy.metadata?.namespace).toBe('website');
    const templates = all.filter(({ manifest }) => manifest.kind === 'ClusterAnalysisTemplate');
    type Metric = { provider: { job?: { spec: { template: { metadata: { labels: object } } } } } };
    const jobs = templates.flatMap(({ manifest }) =>
      ((manifest.spec?.metrics ?? []) as Metric[]).map((m) => m.provider.job).filter((job) => job !== undefined),
    );
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs)
      expect(job.spec.template.metadata.labels).toMatchObject(policy.spec.podSelector.matchLabels);
  });
});

describe("the app's fence", () => {
  type Peer = {
    namespaceSelector?: { matchLabels: Record<string, string> };
    podSelector?: {
      matchLabels?: Record<string, string>;
      matchExpressions?: { key: string; operator: string; values: string[] }[];
    };
  };
  type Rule = { to?: Peer[]; from?: Peer[]; ports: { protocol: string; port: number }[] };
  type Policy = Manifest & {
    spec: { podSelector: { matchLabels: Record<string, string> }; ingress: Rule[]; egress: Rule[] };
  };
  const fence = async () =>
    (await manifests()).find(
      ({ manifest }) =>
        manifest.kind === 'NetworkPolicy' &&
        manifest.metadata?.namespace === 'website' &&
        manifest.metadata?.name === 'website',
    )?.manifest as Policy;

  /** Whether a peer selects pods in a namespace with these labels. */
  const admits = (peer: Peer, namespace: string, labels: Record<string, string>) =>
    (peer.namespaceSelector?.matchLabels['kubernetes.io/metadata.name'] ?? 'website') === namespace &&
    Object.entries(peer.podSelector?.matchLabels ?? {}).every(([k, v]) => labels[k] === v) &&
    (peer.podSelector?.matchExpressions ?? []).every(
      (e) => e.operator === 'In' && e.values.includes(labels[e.key] ?? ''),
    );

  it('denies everything in website to a pod no other policy there selects, such as one the app relabels', async () => {
    const inWebsite = (await manifests()).filter(
      ({ manifest }) => manifest.kind === 'NetworkPolicy' && manifest.metadata?.namespace === 'website',
    );
    expect(inWebsite.map(({ manifest }) => manifest.metadata?.name).sort()).toEqual([
      'default-deny',
      'journeys',
      'website',
    ]);
    const deny = inWebsite.find(({ manifest }) => manifest.metadata?.name === 'default-deny');
    expect(deny?.file).toBe('base/website/network-policy.yaml');
    expect((deny?.manifest as Policy | undefined)?.spec).toEqual({
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
    });
  });

  it("selects the app's pods, and lets them reach DNS, the collector's OTLP port and flagd's sync port, nothing else", async () => {
    const policy = await fence();
    expect(policy.spec.podSelector.matchLabels).toEqual({ 'app.kubernetes.io/name': 'website' });
    expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(
      policy.spec.egress.map((rule) => ({
        to: rule.to?.map((peer) => [
          peer.namespaceSelector?.matchLabels['kubernetes.io/metadata.name'],
          peer.podSelector?.matchLabels,
        ]),
        ports: rule.ports.map((p) => `${p.protocol}/${p.port}`),
      })),
    ).toEqual([
      { to: [['kube-system', { 'k8s-app': 'kube-dns' }]], ports: ['UDP/53', 'TCP/53'] },
      { to: [['telemetry', { 'app.kubernetes.io/name': 'opentelemetry-collector' }]], ports: ['TCP/4318'] },
      // Its in-process provider streams the flag set from flagd's sync port (flag-fences.test.ts).
      { to: [['flagd', { 'app.kubernetes.io/name': 'flagd' }]], ports: ['TCP/8015'] },
    ]);
  });

  it('lets in, on 8080 only, the pods of the probes, the crawler, the admin service and the journeys Job, by their labels', async () => {
    const all = await manifests();
    const policy = await fence();
    const podLabels = (name: string) => {
      const found = all.find(({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === name);
      if (!found) throw new Error(`No Deployment ${name} in deploy/`);
      return (found.manifest.spec as { template: { metadata: { labels: Record<string, string> } } }).template.metadata
        .labels;
    };
    type Metric = { provider: { job?: { spec: { template: { metadata: { labels: Record<string, string> } } } } } };
    const journeys = all
      .filter(({ manifest }) => manifest.kind === 'ClusterAnalysisTemplate')
      .flatMap(({ manifest }) => (manifest.spec?.metrics ?? []) as Metric[])
      .flatMap((m) => (m.provider.job ? [m.provider.job.spec.template.metadata.labels] : []));
    expect(journeys.length).toBeGreaterThan(0);
    const callers: [string, Record<string, string>][] = [
      ['factory', podLabels('probes')],
      ['factory', podLabels('crawler')],
      // To ask each pod which flags it holds.
      ['factory', podLabels('admin')],
      ...journeys.map((labels): [string, Record<string, string>] => ['website', labels]),
      ['kube-system', { 'app.kubernetes.io/name': 'traefik' }],
    ];
    expect(policy.spec.ingress.flatMap((rule) => rule.ports.map((p) => `${p.protocol}/${p.port}`))).toEqual([
      'TCP/8080',
    ]);
    const from = policy.spec.ingress.flatMap((rule) => rule.from ?? []);
    for (const [namespace, labels] of callers) expect(from.some((peer) => admits(peer, namespace, labels))).toBe(true);
    // A worker, or another pod in the app's namespace, is not let in.
    const others: [string, Record<string, string>][] = [
      ['factory', podLabels('triage')],
      ['factory', podLabels('gateway')],
      ['website', { 'app.kubernetes.io/name': 'website' }],
    ];
    for (const [namespace, labels] of others) expect(from.some((peer) => admits(peer, namespace, labels))).toBe(false);
  });
});
