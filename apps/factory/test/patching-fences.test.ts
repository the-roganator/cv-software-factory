import { listenLocal } from '@software-factory/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actions } from '../src/github/actions.ts';
import { configFromEnv } from '../src/github/config.ts';
import type { Reads } from '../src/github/reads.ts';
import { createWorkerServer, PATCHING_READS } from '../src/github/server.ts';
import { type LabelSelector, type Manifest, rendered, selects } from './deploy.ts';

/**
 * The dependency sense's fences (milestone 7, task 31): it reaches the GitHub worker's reads, the Kubernetes API (to list
 * pods, and nothing else) and Postgres as its own role, and nothing else. Its door on the GitHub worker serves its two
 * reads and no action, so the port its NetworkPolicy opens cannot act in GitHub.
 */
interface Peer {
  namespaceSelector?: LabelSelector;
  podSelector?: LabelSelector;
  ipBlock?: { cidr: string; except?: string[] };
}
interface Rule {
  to?: Peer[];
  from?: Peer[];
  ports?: { protocol?: string; port?: number }[];
}
type Policy = Manifest & {
  spec: { podSelector: LabelSelector; policyTypes: string[]; ingress?: Rule[]; egress?: Rule[] };
};
type Pod = {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  containers: { args: string[]; env: { name: string; value?: string; valueFrom?: unknown }[] }[];
};
type Deployment = Manifest & { spec: { template: { metadata: { labels: Record<string, string> }; spec: Pod } } };

/** A role or a binding, as RBAC writes them. */
type Rbac = Manifest & {
  rules?: unknown[];
  subjects?: { kind: string; name: string; namespace?: string }[];
  roleRef?: { kind: string; name: string };
  spec?: unknown;
};

const all = rendered() as { manifest: Rbac }[];

/** The namespaces the sense lists no pod in, each with why (deploy/base/patching-reads-pods, PATCHING.md). */
const LEFT_OUT: Record<string, string> = {
  runners: 'an agent step’s Job carries its job token in its spec, as a value',
  'red-team': 'only the harness’s two attack pods run there, held to two images by an admission rule',
  scoreboard: 'the answer key’s namespace, where no role of ours but the line’s list of Events is bound',
};
const one = <M extends Manifest>(kind: string, name: string): M => {
  const found = all.find((m) => m.manifest.kind === kind && m.manifest.metadata?.name === name)?.manifest;
  if (!found) throw new Error(`no ${kind} named ${name} is rendered`);
  return found as M;
};

describe('the dependency sense’s Deployment', () => {
  const deployment = one<Deployment>('Deployment', 'patching');
  const pod = deployment.spec.template.spec;
  const env = Object.fromEntries(pod.containers[0]?.env.map((e) => [e.name, e.value ?? e.valueFrom]) ?? []);

  it('runs `factory patching` as factory_patching, asking the GitHub worker’s door and nothing else of it', () => {
    expect(pod.containers[0]?.args.slice(-1)).toEqual(['patching']);
    expect(env.PGUSER).toBe('factory_patching');
    expect(env.GITHUB_URL).toBe('http://github:8083');
    expect(deployment.spec.template.metadata.labels['app.kubernetes.io/component']).toBe('patching');
  });

  it('lists pods with an account that may do nothing else, and nowhere cluster-wide', () => {
    expect(pod.serviceAccountName).toBe('patching');
    expect(pod.automountServiceAccountToken).toBe(true);
    const bindings = all.filter(({ manifest }) =>
      (manifest.subjects ?? []).some((s) => s.kind === 'ServiceAccount' && s.name === 'patching'),
    );
    expect(
      new Set(bindings.map(({ manifest }) => `${manifest.kind} ${manifest.roleRef?.kind} ${manifest.roleRef?.name}`)),
    ).toEqual(new Set(['RoleBinding ClusterRole patching-lists-pods']));
    expect(one<Rbac>('ClusterRole', 'patching-lists-pods').rules).toEqual([
      { apiGroups: [''], resources: ['pods'], verbs: ['list'] },
    ]);
  });

  it('lists pods in exactly the namespaces it is bound in, and every namespace is bound or left out by name', () => {
    const bound = new Set(
      all
        .filter(
          ({ manifest }) =>
            manifest.kind === 'RoleBinding' &&
            manifest.roleRef?.name === 'patching-lists-pods' &&
            (manifest.subjects ?? []).some((s) => s.name === 'patching' && s.namespace === 'factory'),
        )
        .map(({ manifest }) => manifest.metadata?.namespace),
    );
    const listed = String(env.PATCHING_NAMESPACES).split(',');
    expect(new Set(listed)).toEqual(bound);
    // Every namespace the overlay makes or deploys a chart into, and the cluster's own (Traefik's is kube-system).
    const made = all.flatMap(({ manifest }) => {
      const spec = manifest.spec as { destination?: { namespace?: string } } | undefined;
      return [
        ...(manifest.kind === 'Namespace' ? [manifest.metadata?.name] : []),
        ...(manifest.kind === 'Application' ? [spec?.destination?.namespace] : []),
        ...(manifest.metadata?.namespace ? [manifest.metadata.namespace] : []),
      ];
    });
    const CLUSTER_OWN = ['default', 'kube-system', 'kube-public', 'kube-node-lease', 'argocd', 'kyverno'];
    for (const ns of new Set([...made, ...CLUSTER_OWN].filter((n): n is string => !!n))) {
      expect(bound.has(ns) || Object.hasOwn(LEFT_OUT, ns), `${ns} is neither read nor left out`).toBe(true);
    }
    for (const ns of Object.keys(LEFT_OUT)) expect(bound.has(ns), ns).toBe(false);
    // The owed try starts its pod in default.
    expect(bound.has('default')).toBe(true);
  });
});

describe('the dependency sense’s NetworkPolicy', () => {
  const policy = one<Policy>('NetworkPolicy', 'patching');

  it('reaches the store, the collector, the API server and the GitHub worker’s door, and takes nothing in', () => {
    expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy.spec.ingress ?? []).toEqual([]);
    const reach = (policy.spec.egress ?? []).map((rule) => ({
      to: (rule.to ?? []).map(
        (peer) => peer.ipBlock?.cidr ?? peer.podSelector?.matchLabels?.['app.kubernetes.io/name'] ?? 'any',
      ),
      ports: (rule.ports ?? []).map((p) => p.port),
    }));
    expect(reach).toEqual([
      { to: ['postgres'], ports: [5432] },
      { to: ['opentelemetry-collector'], ports: [4318] },
      { to: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], ports: [6443] },
      { to: ['github'], ports: [8083] },
    ]);
  });

  it('is the only way into the door, which no other pod may reach, and the sense reaches no other port of the worker', () => {
    const github = one<Policy>('NetworkPolicy', 'github');
    const into = (github.spec.ingress ?? []).filter((rule) => (rule.ports ?? []).some((p) => p.port === 8083));
    expect(into).toHaveLength(1);
    const sense = { 'app.kubernetes.io/name': 'patching', 'app.kubernetes.io/component': 'patching' };
    expect((into[0]?.from ?? []).every((peer) => peer.podSelector && selects(peer.podSelector, sense))).toBe(true);
    expect(
      (into[0]?.from ?? []).every((peer) => peer.podSelector?.matchLabels?.['app.kubernetes.io/name'] === 'patching'),
    ).toBe(true);
    const others = (github.spec.ingress ?? []).filter((rule) => !into.includes(rule));
    expect(
      others.some((rule) => (rule.from ?? []).some((peer) => peer.podSelector && selects(peer.podSelector, sense))),
    ).toBe(false);
  });
});

describe('the GitHub worker’s door for the sense', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());
  const REPO = 'the-roganator/cv-software-factory';

  async function door() {
    const asked: string[] = [];
    const reads = new Proxy({} as Reads, {
      get: (_, name: string) => async () => {
        asked.push(name);
        return name === 'dependencyPulls' ? [] : { read: name };
      },
    });
    const actions = new Proxy({} as Actions, {
      get: (_, name: string) => (name === 'dryRun' ? false : async () => asked.push(`action ${name}`)),
    });
    const server = createWorkerServer({
      actions,
      reads,
      repositories: [REPO],
      health: () => ({ door: 'patching' }),
      only: PATCHING_READS,
      log: pino({ level: 'silent' }),
    });
    const { url } = await listenLocal(server);
    close = () => server.close();
    const call = async (path: string, args: object = {}, headers: Record<string, string> = {}) => {
      const r = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ repo: REPO, ...args }),
      });
      return r.status;
    };
    return { call, asked };
  }

  it('serves the moves and Dependabot’s pull requests', async () => {
    const { call, asked } = await door();
    expect(PATCHING_READS).toEqual(['moves', 'dependencyPulls']);
    expect(await call('/v1/reads/moves')).toBe(200);
    expect(await call('/v1/reads/dependencyPulls')).toBe(200);
    expect(asked).toEqual(['moves', 'dependencyPulls']);
  });

  it('serves no other read and no action, dry run or not', async () => {
    const { call, asked } = await door();
    expect(await call('/v1/reads/pullRequest', { number: 1 })).toBe(404);
    expect(await call('/v1/reads/file', { ref: 'main', path: 'a' })).toBe(404);
    expect(await call('/v1/actions/openIssue', { title: 'x', body: 'y' })).toBe(404);
    expect(await call('/v1/actions/comment', { number: 1, body: 'x' }, { 'x-factory-dry-run': 'true' })).toBe(404);
    expect(asked).toEqual([]);
  });

  it('is on a port of its own', () => {
    expect(configFromEnv({ PATCHING_PORT: '8083' }).patchingPort).toBe(8083);
    expect(configFromEnv({}).patchingPort).toBeUndefined();
    expect(() => configFromEnv({ PATCHING_PORT: '8080' })).toThrow('a port of its own');
    expect(() => configFromEnv({ PATCHING_PORT: '8082', ATTACK_PORT: '8082' })).toThrow('a port of its own');
    expect(() => configFromEnv({ PATCHING_PORT: 'x' })).toThrow('a port number');
  });
});
