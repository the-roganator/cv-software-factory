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
 * `runners` but cannot say what those pods hold, so an admission rule holds them; its own NetworkPolicy and Role grant
 * exactly what the attacks need and nothing else. These check the manifests each profile renders; `make egress` shows
 * the pods' own fences on the cluster.
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
  it('admits none of the attack pods the harness makes in runners', () => {
    expect(admits(AGENT_POD, runners)).toBe(false);
    expect(admits({ ...AGENT_POD, 'app.kubernetes.io/name': 'red-team' }, runners)).toBe(false);
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

describe('the red-team harness’s Role in runners', () => {
  const role = one<Role>('Role', 'red-team');
  it('may create, read, delete a pod and read its log, and nothing else', () => {
    expect(role, 'a red-team Role is rendered').toBeTruthy();
    const pods = role.rules.find((r) => r.resources.includes('pods') && !r.resources.includes('pods/log'));
    expect(pods?.verbs.sort()).toEqual(['create', 'delete', 'get']);
    const log = role.rules.find((r) => r.resources.includes('pods/log'));
    expect(log?.verbs).toEqual(['get']);
    for (const rule of role.rules)
      for (const resource of rule.resources) expect(['pods', 'pods/log']).toContain(resource);
  });
});

describe('the red-team pods’ admission rule', () => {
  const policy = one<ValidatingPolicy>('ValidatingPolicy', 'factory-red-team-pods');
  const text = () => policy.spec.validations.map((v) => v.expression).join('\n');
  it('guards pods in runners: every pod the harness’s account creates, and any pod carrying the marker', () => {
    expect(policy, 'the admission policy is rendered').toBeTruthy();
    expect(selects(policy.spec.matchConstraints.namespaceSelector, { 'kubernetes.io/metadata.name': 'runners' })).toBe(
      true,
    );
    expect(selects(policy.spec.matchConstraints.namespaceSelector, { 'kubernetes.io/metadata.name': 'factory' })).toBe(
      false,
    );
    const match = policy.spec.matchConditions.map((c) => c.expression).join('\n');
    expect(match).toContain(RED_TEAM_LABEL);
    // RBAC lets the account create any pod in runners: one without the marker must meet this rule too, and fail it.
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
