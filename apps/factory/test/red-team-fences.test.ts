import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_ARGS,
  IMAGE_COMMAND,
  RED_TEAM_HOST_ALIAS,
  RED_TEAM_LABEL,
  RED_TEAM_RUNNER_REPOSITORY,
  RED_TEAM_UNSIGNED_IMAGE,
} from '../../../policy/attacks.ts';
import { EGRESS_ARGS, EGRESS_COMMAND, EGRESS_PROBE, RUNNER_AGENT_MODULE } from '../../../policy/egress-probe.ts';
import { type LabelSelector, type Manifest, rendered, selects } from './deploy.ts';

/**
 * The red-team harness's fences (milestone 7 task 22). RBAC lets it create the egress and image attacks' pods in
 * `red-team`, a namespace of their own apart from the line's runners, but cannot say what those pods hold, so an
 * admission rule holds them; its own NetworkPolicy and Role grant exactly what the attacks need and nothing else, and
 * the pods meet an agent's fence. These check the manifests each profile renders; the egress attack shows the pods'
 * fence on the cluster.
 */
type Labels = Record<string, string>;
interface Peer {
  namespaceSelector?: LabelSelector;
  podSelector?: LabelSelector;
  ipBlock?: { cidr: string; except?: string[] };
}
interface Port {
  protocol?: string;
  port?: number | string;
}
type Policy = Manifest & {
  spec: {
    podSelector: LabelSelector;
    policyTypes: string[];
    ingress?: { from?: Peer[]; ports?: Port[] }[];
    egress?: { to?: Peer[]; ports?: Port[] }[];
  };
};
type Deployment = Manifest & {
  spec: { template: { metadata: { labels: Labels }; spec: Record<string, unknown> } };
};
type Role = Manifest & { rules: { apiGroups: string[]; resources: string[]; verbs: string[] }[] };
type ValidatingPolicy = Manifest & {
  spec: {
    matchConstraints: { namespaceSelector: LabelSelector };
    matchConditions: { name: string; expression: string }[];
    validations: { expression: string; message: string }[];
    variables?: { name: string; expression: string }[];
    validationActions?: string[];
    failurePolicy?: string;
  };
};

const all = rendered();
const byKind = <M extends Manifest>(kind: string, name: string): M[] =>
  all.filter((m) => m.manifest.kind === kind && m.manifest.metadata?.name === name).map((m) => m.manifest as M);
const one = <M extends Manifest>(kind: string, name: string): M => {
  const found = byKind<M>(kind, name)[0];
  if (!found) throw new Error(`no ${kind} named ${name} is rendered`);
  return found;
};

/** A peer naming a pod in a namespace, by the labels each selector would pick. */
const reaches = (rule: { to?: Peer[]; ports?: Port[] } | undefined, pod: Labels, ns: Labels, port: number): boolean =>
  (rule?.to ?? []).some(
    (peer) =>
      (!peer.namespaceSelector || selects(peer.namespaceSelector, ns)) &&
      (!peer.podSelector || selects(peer.podSelector, pod)) &&
      (rule?.ports ?? []).some((p) => p.port === port),
  );

const AGENT_POD = {
  'factory.mrogan.dev/runner': 'agent',
  'app.kubernetes.io/part-of': 'software-factory',
  [RED_TEAM_LABEL]: 'egress',
};

describe('the red-team harness’s Deployment', () => {
  const deployment = one<Deployment>('Deployment', 'red-team');
  it('runs as factory_redteam with the password from postgres-redteam, and reads no other worker’s Secret', () => {
    expect(deployment, 'a red-team Deployment is rendered').toBeTruthy();
    const container = (
      deployment.spec.template.spec.containers as {
        name: string;
        env?: { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string; key: string } } }[];
      }[]
    ).find((c) => c.name === 'red-team');
    const env = container?.env ?? [];
    expect(env.find((e) => e.name === 'PGUSER')?.value).toBe('factory_redteam');
    expect(env.find((e) => e.name === 'PGPASSWORD')?.valueFrom?.secretKeyRef).toEqual({
      name: 'postgres-redteam',
      key: 'password',
    });
    // It holds a token to create pods; nothing gives it another worker's store Secret.
    expect(deployment.spec.template.spec.automountServiceAccountToken).toBe(true);
    for (const e of env) {
      const secret = e.valueFrom?.secretKeyRef?.name;
      if (secret?.startsWith('postgres-')) expect(secret).toBe('postgres-redteam');
    }
  });
  it('mounts the artifact store read-only: its events cite no artifact, and the store holds every worker’s', () => {
    const container = (
      deployment.spec.template.spec.containers as {
        name: string;
        volumeMounts?: { name: string; readOnly?: boolean }[];
      }[]
    ).find((c) => c.name === 'red-team');
    for (const mount of container?.volumeMounts ?? []) expect(mount.readOnly, mount.name).toBe(true);
  });
  it('is no worker: its component is its own, so the workers’ policy does not fence it', () => {
    expect(deployment.spec.template.metadata.labels['app.kubernetes.io/component']).toBe('red-team');
  });
});

describe('the red-team harness’s NetworkPolicy', () => {
  const policy = one<Policy>('NetworkPolicy', 'red-team');
  const telemetry = { 'kubernetes.io/metadata.name': 'telemetry' };
  const kubeSystem = { 'kubernetes.io/metadata.name': 'kube-system' };
  const egressTo = (pod: Labels, ns: Labels, port: number) =>
    (policy.spec.egress ?? []).some((rule) => reaches(rule, pod, ns, port));

  it('reaches the store, the collector, the app’s front door, the API and the attack door, and nothing else', () => {
    expect(policy, 'a red-team NetworkPolicy is rendered').toBeTruthy();
    expect(policy.spec.policyTypes).toEqual(['Egress']);
    expect(egressTo({ 'app.kubernetes.io/name': 'postgres' }, {}, 5432)).toBe(true);
    expect(egressTo({ 'app.kubernetes.io/name': 'opentelemetry-collector' }, telemetry, 4318)).toBe(true);
    expect(egressTo({ 'app.kubernetes.io/name': 'traefik' }, kubeSystem, 8000)).toBe(true);
    expect(egressTo({ 'app.kubernetes.io/name': 'github' }, {}, 8082)).toBe(true);
  });
  it('reaches the API server on 6443 on a private address alone', () => {
    const toApi = (policy.spec.egress ?? []).filter((rule) => (rule.ports ?? []).some((p) => p.port === 6443));
    expect(toApi.length).toBeGreaterThan(0);
    for (const rule of toApi) for (const peer of rule.to ?? []) expect(peer.ipBlock?.cidr).toMatch(/^(10|172|192)\./);
  });
  it('never reaches the GitHub worker’s main port (8080), which the line uses', () => {
    expect(egressTo({ 'app.kubernetes.io/name': 'github' }, {}, 8080)).toBe(false);
  });
  it('never reaches the internet', () => {
    const open = (policy.spec.egress ?? []).some((rule) =>
      (rule.to ?? []).some((peer) => peer.ipBlock?.cidr === '0.0.0.0/0'),
    );
    expect(open).toBe(false);
  });
});

describe('the store’s NetworkPolicy', () => {
  const postgres = one<Policy>('NetworkPolicy', 'postgres');
  const factory = { 'kubernetes.io/metadata.name': 'factory' };
  const runners = { 'kubernetes.io/metadata.name': 'runners' };
  const redTeam = { 'kubernetes.io/metadata.name': 'red-team' };
  // A peer with no namespace selector picks pods in the policy's own namespace, `factory`, alone.
  const admits = (pod: Labels, ns: Labels) =>
    (postgres.spec.ingress ?? []).some(
      (rule) =>
        (rule.from ?? []).some(
          (peer) =>
            (peer.namespaceSelector ? selects(peer.namespaceSelector, ns) : ns === factory) &&
            (!peer.podSelector || selects(peer.podSelector, pod)),
        ) && (rule.ports ?? []).some((p) => p.port === 5432),
    );
  it('admits the harness, which its own egress lets reach the store', () => {
    expect(admits({ 'app.kubernetes.io/name': 'red-team', 'app.kubernetes.io/component': 'red-team' }, factory)).toBe(
      true,
    );
  });
  it('admits no attack pod in red-team, nor a pod labelled as one in runners', () => {
    for (const ns of [redTeam, runners]) {
      expect(admits(AGENT_POD, ns)).toBe(false);
      expect(admits({ ...AGENT_POD, 'app.kubernetes.io/name': 'red-team' }, ns)).toBe(false);
    }
  });
});

describe('the GitHub worker’s attack door', () => {
  const github = one<Policy>('NetworkPolicy', 'github');
  const admits = (pod: Labels, port: number) =>
    (github.spec.ingress ?? []).some(
      (rule) =>
        (rule.from ?? []).some((peer) => !peer.podSelector || selects(peer.podSelector, pod)) &&
        (rule.ports ?? []).some((p) => p.port === port),
    );
  it('admits the harness on its own port (8082), and the harness never on the line’s port (8080)', () => {
    expect(admits({ 'app.kubernetes.io/name': 'red-team' }, 8082)).toBe(true);
    expect(admits({ 'app.kubernetes.io/name': 'red-team' }, 8080)).toBe(false);
  });
  it('does not admit the line on the attack port', () => {
    expect(admits({ 'app.kubernetes.io/name': 'line' }, 8082)).toBe(false);
    expect(admits({ 'app.kubernetes.io/name': 'line' }, 8080)).toBe(true);
  });
});

describe('the red-team harness’s Roles', () => {
  const roles = byKind<Role>('Role', 'red-team');
  const bindings = byKind<Manifest & { subjects: { kind: string; name: string; namespace?: string }[] }>(
    'RoleBinding',
    'red-team',
  );
  it('may create, read, delete a pod and read its log, and nothing else, wherever they are', () => {
    expect(roles.length, 'a red-team Role is rendered').toBeGreaterThan(0);
    for (const role of roles) {
      const pods = role.rules.find((r) => r.resources.includes('pods') && !r.resources.includes('pods/log'));
      expect(pods?.verbs.sort()).toEqual(['create', 'delete', 'get']);
      const log = role.rules.find((r) => r.resources.includes('pods/log'));
      expect(log?.verbs).toEqual(['get']);
      for (const rule of role.rules)
        for (const resource of rule.resources) expect(['pods', 'pods/log']).toContain(resource);
    }
  });
  it('are in red-team alone, where the harness makes its pods: none beside the line’s runners', () => {
    expect(new Set(roles.map((r) => r.metadata?.namespace))).toEqual(new Set(['red-team']));
    for (const binding of bindings)
      expect(binding.subjects).toEqual([{ kind: 'ServiceAccount', name: 'red-team', namespace: 'factory' }]);
    expect(new Set(bindings.map((b) => b.metadata?.namespace))).toEqual(new Set(['red-team']));
  });
  it('are the only rights the harness’s account has to anything in the cluster', () => {
    const bound = all
      .map((m) => m.manifest as Manifest & { subjects?: { kind: string; name: string; namespace?: string }[] })
      .filter(
        (m) =>
          (m.kind === 'RoleBinding' || m.kind === 'ClusterRoleBinding') &&
          (m.subjects ?? []).some(
            (s) =>
              (s.kind === 'ServiceAccount' && s.name === 'red-team' && s.namespace === 'factory') ||
              // A group the account is in: every service account's, the factory's, every signed-in user's.
              (s.kind === 'Group' &&
                ['system:serviceaccounts', 'system:serviceaccounts:factory', 'system:authenticated'].includes(s.name)),
          ),
      );
    expect(bound.map((b) => `${b.kind} ${b.metadata?.namespace}/${b.metadata?.name}`)).toEqual([
      'RoleBinding red-team/red-team',
    ]);
  });
  it('are the only rights any account of the factory’s has to pods in red-team: nothing of the line’s is there', () => {
    const inRedTeam = all
      .map((m) => m.manifest)
      .filter((m) => m.kind === 'Role' && m.metadata?.namespace === 'red-team') as Role[];
    expect(inRedTeam.map((r) => r.metadata?.name).sort()).toEqual(['line-reads-admission', 'red-team']);
    const line = inRedTeam.find((r) => r.metadata?.name === 'line-reads-admission');
    expect(line?.rules).toEqual([{ apiGroups: [''], resources: ['events'], verbs: ['list'] }]);
  });
});

describe('the red-team namespace', () => {
  type Namespace = Manifest & { metadata: { labels?: Labels } };
  const ns = one<Namespace>('Namespace', 'red-team');
  const redTeam = { 'kubernetes.io/metadata.name': 'red-team' };
  const policies = all.map((m) => m.manifest).filter((m): m is Policy => m.kind === 'NetworkPolicy');
  const here = policies.filter((p) => p.metadata?.namespace === 'red-team');
  const inRunners = policies.filter((p) => p.metadata?.namespace === 'runners');
  const egressOf = (from: Policy[], pod: Labels) =>
    from.filter((p) => selects(p.spec.podSelector, pod)).flatMap((p) => p.spec.egress ?? []);

  it('enforces the restricted Pod Security Standard', () => {
    expect(ns.metadata.labels?.['pod-security.kubernetes.io/enforce']).toBe('restricted');
  });
  it('holds the attack pods to a few, with small requests, so a harness making pods in a loop stops there', () => {
    type Quota = Manifest & { spec: { hard: Record<string, string> } };
    const quotas = all.map((m) => m.manifest).filter((m): m is Quota => m.kind === 'ResourceQuota');
    expect(quotas.filter((q) => q.metadata?.namespace === 'red-team').map((q) => q.spec.hard)).toEqual([
      { pods: '4', 'requests.cpu': '500m', 'requests.memory': '1Gi', 'limits.memory': '2Gi' },
    ]);
    // The pod the harness makes sets each (apps/factory/src/red-team/pods.ts), so the quota admits it.
    const source = readFileSync(new URL('../src/red-team/pods.ts', import.meta.url), 'utf8');
    expect(source).toContain("resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '256Mi' } }");
  });
  it('denies everything, in and out, and lets nothing in', () => {
    const denyAll = here.filter(
      (p) => Object.keys(p.spec.podSelector).length === 0 && !p.spec.ingress?.length && !p.spec.egress?.length,
    );
    expect(denyAll.map((p) => p.spec.policyTypes.sort())).toEqual([['Egress', 'Ingress']]);
    expect(here.filter((p) => p.spec.ingress?.length)).toEqual([]);
  });
  it('fences an attack pod exactly as the line’s agent pods are fenced in runners', () => {
    expect(egressOf(here, AGENT_POD).length).toBeGreaterThan(0);
    expect(egressOf(here, AGENT_POD)).toEqual(egressOf(inRunners, { 'factory.mrogan.dev/runner': 'agent' }));
  });
  it('is let into the gateway by the egress attack’s pod alone, and into nothing else of the factory’s', () => {
    const admitted = policies.flatMap((p) =>
      (p.spec.ingress ?? []).flatMap((rule) =>
        (rule.from ?? [])
          .filter((peer) => peer.namespaceSelector && selects(peer.namespaceSelector, redTeam))
          .map((peer) => ({ to: `${p.metadata?.namespace}/${p.metadata?.name}`, peer, ports: rule.ports })),
      ),
    );
    expect(admitted).toEqual([
      {
        to: 'factory/gateway',
        peer: {
          namespaceSelector: { matchLabels: redTeam },
          podSelector: { matchLabels: { 'factory.mrogan.dev/runner': 'agent', [RED_TEAM_LABEL]: 'egress' } },
        },
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ]);
    // An agent-labelled pod there without the egress attack's marker is not let in.
    expect(selects(admitted[0]?.peer.podSelector, { 'factory.mrogan.dev/runner': 'agent' })).toBe(false);
    expect(selects(admitted[0]?.peer.podSelector, { ...AGENT_POD, [RED_TEAM_LABEL]: 'image' })).toBe(false);
  });
  it('is guarded by the factory’s image policy', () => {
    const images = one<Manifest & { spec: { matchConstraints: { namespaceSelector: LabelSelector } } }>(
      'ImageValidatingPolicy',
      'factory-images',
    );
    expect(selects(images.spec.matchConstraints.namespaceSelector, redTeam)).toBe(true);
  });
});

describe('the red-team pods’ admission rule', () => {
  const policy = one<ValidatingPolicy>('ValidatingPolicy', 'factory-red-team-pods');
  const text = () => policy.spec.validations.map((v) => v.expression).join('\n');
  it('guards pods in red-team: every pod the harness’s account creates, and any carrying the marker', () => {
    expect(policy, 'the admission policy is rendered').toBeTruthy();
    expect(selects(policy.spec.matchConstraints.namespaceSelector, { 'kubernetes.io/metadata.name': 'red-team' })).toBe(
      true,
    );
    for (const ns of ['runners', 'factory'])
      expect(selects(policy.spec.matchConstraints.namespaceSelector, { 'kubernetes.io/metadata.name': ns }), ns).toBe(
        false,
      );
    const match = policy.spec.matchConditions.map((c) => c.expression).join('\n');
    expect(match).toContain(RED_TEAM_LABEL);
    // RBAC lets the account create any pod there: one without the marker must meet this rule too, and fail it.
    expect(match).toContain("request.userInfo.username == 'system:serviceaccount:factory:red-team'");
    expect(text()).toContain(`'${RED_TEAM_LABEL}' in object.metadata.labels`);
  });
  it('pins the command, args and images exactly as policy/attacks.ts holds them', () => {
    const expr = text();
    // The egress probe, verbatim, so a change to it in policy fails this unless the rule is generated again.
    expect(expr).toContain(EGRESS_PROBE);
    expect(expr).toContain(`'${EGRESS_COMMAND[0]}'`);
    expect(expr).toContain(`'${EGRESS_ARGS[0]}'`);
    expect(expr).toContain(`'${IMAGE_COMMAND[0]}'`);
    expect(expr).toContain(`'${IMAGE_ARGS[0]}'`);
    expect(JSON.stringify(policy.spec.variables ?? (policy.spec as { variables?: unknown[] }).variables)).toContain(
      RED_TEAM_UNSIGNED_IMAGE,
    );
    expect(JSON.stringify(policy.spec)).toContain(RED_TEAM_RUNNER_REPOSITORY);
  });
  it('holds the pod to an agent’s DNS: no resolver, and one host alias, the control’s name', () => {
    const expr = text();
    expect(expr).toContain("object.spec.dnsPolicy == 'None'");
    expect(expr).toContain("object.spec.dnsConfig.nameservers == ['127.0.0.1']");
    expect(expr).toContain(`object.spec.hostAliases[0].hostnames == ['${RED_TEAM_HOST_ALIAS}']`);
    expect(expr).toContain('size(object.spec.hostAliases) == 1');
  });
  it('forbids a token, volumes, environment and extra labels', () => {
    const expr = text();
    expect(expr).toContain('automountServiceAccountToken');
    expect(expr).toContain('volumes');
    expect(expr).toContain('env');
    expect(expr).toContain("'agent'");
  });
  it('fails closed (Deny, failurePolicy Fail)', () => {
    expect(policy.spec.validationActions).toEqual(['Deny']);
    expect(policy.spec.failurePolicy).toBe('Fail');
  });
  it('admits only the agent label (never prepare) besides the marker', () => {
    expect(selects({ matchLabels: AGENT_POD }, AGENT_POD)).toBe(true);
    expect(text()).not.toContain("'prepare'");
  });
});

describe('the rule that keeps red-team pods out of runners', () => {
  const policy = one<ValidatingPolicy>('ValidatingPolicy', 'factory-no-red-team-in-runners');
  const shape = one<ValidatingPolicy>('ValidatingPolicy', 'factory-red-team-pods');
  it('guards pods, Jobs and volume claims, in runners alone', () => {
    const rules = (
      policy.spec.matchConstraints as unknown as {
        resourceRules: { apiGroups: string[]; resources: string[]; operations: string[] }[];
      }
    ).resourceRules;
    expect(rules.flatMap((r) => r.apiGroups.flatMap((g) => r.resources.map((x) => `${g}/${x}`))).sort()).toEqual([
      '/persistentvolumeclaims',
      '/pods',
      'batch/jobs',
    ]);
    for (const rule of rules) expect(rule.operations).toEqual(['CREATE', 'UPDATE']);
    const ns = (name: string) =>
      selects(policy.spec.matchConstraints.namespaceSelector, { 'kubernetes.io/metadata.name': name });
    expect(ns('runners')).toBe(true);
    for (const other of ['red-team', 'factory']) expect(ns(other), other).toBe(false);
  });
  it('matches as the red-team pods’ rule does: all the harness’s account creates, and anything carrying the marker', () => {
    expect(policy.spec.matchConditions).toEqual(shape.spec.matchConditions);
    expect(policy.spec.matchConditions.map((c) => c.expression).join('\n')).toContain(RED_TEAM_LABEL);
  });
  it('refuses each one, and fails closed', () => {
    expect(policy.spec.validations.map((v) => v.expression)).toEqual(['false']);
    expect(policy.spec.validationActions).toEqual(['Deny']);
    expect(policy.spec.failurePolicy).toBe('Fail');
  });
});

describe('the egress probe’s fence wait', () => {
  it('imports the agent step’s own wait, from where the runner image puts the runner', async () => {
    expect(EGRESS_PROBE).toContain(`await import(${JSON.stringify(RUNNER_AGENT_MODULE)})`);
    // The image copies the repository's apps/runner/src under /repo (apps/runner/Dockerfile).
    expect(RUNNER_AGENT_MODULE.startsWith('/repo/')).toBe(true);
    const local = new URL(`../../../${RUNNER_AGENT_MODULE.slice('/repo/'.length)}`, import.meta.url);
    const dockerfile = readFileSync(new URL('../../../apps/runner/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/^WORKDIR \/repo$/m);
    expect(dockerfile).toMatch(/^COPY .*apps\/runner\/src apps\/runner\/src$/m);
    const agent = (await import(local.href)) as { awaitFence?: unknown };
    expect(typeof agent.awaitFence).toBe('function');
  });
});
