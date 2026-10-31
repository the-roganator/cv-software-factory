import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEPLOY, manifests as deployManifests, type LabelSelector, selects } from './deploy.ts';

/**
 * The admin service's fences as deploy/ declares them (milestone 7): the browser reaches it under /admin/ on the
 * console's host, the console's server never receives the session cookie, and only the ingress controller reaches the
 * admin service, which is why it may believe the forwarded headers that come from the pod network.
 */
interface Backend {
  service?: { name?: string; port?: { name?: string } };
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; annotations?: Record<string, string> };
  spec?: {
    rules?: { host?: string; http?: { paths?: { path?: string; backend?: Backend }[] } }[];
    headers?: { customRequestHeaders?: Record<string, string> };
    podSelector?: LabelSelector;
    ingress?: { from?: unknown[]; ports?: unknown[] }[];
    egress?: { to?: unknown[]; ports?: unknown[] }[];
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: {
        serviceAccountName?: string;
        automountServiceAccountToken?: boolean;
        containers?: { env?: { name: string; value?: string }[] }[];
      };
    };
    jobTemplate?: { spec?: { template?: { spec?: { automountServiceAccountToken?: boolean } } } };
    namespaceResourceWhitelist?: { group: string; kind: string }[];
    matchConstraints?: { resourceRules?: { apiGroups?: string[]; resources?: string[] }[] };
    variables?: { name: string; expression: string }[];
    validationActions?: string[];
  };
}

const manifests = () => deployManifests<Manifest>();

const MIDDLEWARES = 'traefik.ingress.kubernetes.io/router.middlewares';
const TRAEFIK = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
  podSelector: { matchLabels: { 'app.kubernetes.io/name': 'traefik' } },
};

const ingresses = async () => (await manifests()).filter(({ manifest }) => manifest.kind === 'Ingress');
const routesTo = (manifest: Manifest, service: string) =>
  (manifest.spec?.rules ?? []).flatMap((rule) =>
    (rule.http?.paths ?? []).filter((path) => path.backend?.service?.name === service).map((path) => path.path),
  );

describe('the console’s server', () => {
  it('is sent no cookie: every route to it removes the header', async () => {
    const toConsole = (await ingresses()).filter(({ manifest }) => routesTo(manifest, 'console').length > 0);
    expect(toConsole.length).toBeGreaterThan(0);
    for (const { manifest, file } of toConsole) {
      expect(manifest.metadata?.annotations?.[MIDDLEWARES]?.split(','), file).toContain(
        'factory-console-no-cookies@kubernetescrd',
      );
    }
    const middleware = (await manifests()).find(
      ({ manifest }) => manifest.kind === 'Middleware' && manifest.metadata?.name === 'console-no-cookies',
    );
    // Traefik removes a request header set to the empty string.
    expect(middleware?.manifest.spec?.headers?.customRequestHeaders).toEqual({ Cookie: '' });
  });
});

describe('the admin service', () => {
  it('is reached under /admin/ on the console’s host, and only there', async () => {
    const toAdmin = (await ingresses()).flatMap(({ manifest }) =>
      (manifest.spec?.rules ?? []).flatMap((rule) =>
        (rule.http?.paths ?? [])
          .filter((path) => path.backend?.service?.name === 'admin')
          .map((path) => `${rule.host}${path.path}`),
      ),
    );
    expect(toAdmin).toEqual(['console.localhost/admin/']);
  });

  it('lets in the ingress controller alone, so the forwarded headers it trusts come from Traefik', async () => {
    const all = await manifests();
    const deployment = all.find(
      ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === 'admin',
    );
    const labels = deployment?.manifest.spec?.template?.metadata?.labels;
    expect(labels?.['app.kubernetes.io/name']).toBe('admin');
    const policies = all.filter(
      ({ manifest, namespace }) =>
        manifest.kind === 'NetworkPolicy' &&
        namespace === 'factory' &&
        selects(manifest.spec?.podSelector ?? {}, labels ?? {}),
    );
    const from = policies.flatMap(({ manifest }) => (manifest.spec?.ingress ?? []).flatMap((rule) => rule.from ?? []));
    expect(from).toEqual([TRAEFIK]);
  });

  it('reaches the store, the collector, the API server’s port and the app’s pods on 8080, and nothing else', async () => {
    const policy = (await manifests()).find(
      ({ manifest, namespace }) =>
        manifest.kind === 'NetworkPolicy' && namespace === 'factory' && manifest.metadata?.name === 'admin',
    );
    expect(policy?.manifest.spec?.egress).toEqual([
      {
        to: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'postgres' } } }],
        ports: [{ protocol: 'TCP', port: 5432 }],
      },
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'telemetry' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'opentelemetry-collector' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 4318 }],
      },
      // The API server, on the node's private address once the `kubernetes` Service has translated it, as the line's.
      {
        to: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map((cidr) => ({ ipBlock: { cidr } })),
        ports: [{ protocol: 'TCP', port: 6443 }],
      },
      // The app's pods, by the label its own fence selects them by, to ask each which flags it holds.
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'website' } },
            podSelector: { matchLabels: { 'app.kubernetes.io/name': 'website' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8080 }],
      },
    ]);
  });

  it('finds the app’s pods by one Role in website: list its EndpointSlices, and nothing more, for its account alone', async () => {
    type Rbac = Manifest & {
      rules?: unknown[];
      roleRef?: { kind: string; name: string };
      subjects?: { kind: string; name: string; namespace?: string }[];
    };
    const all = await deployManifests<Rbac>();
    const roles = all.filter(
      ({ manifest }) => manifest.kind === 'Role' && manifest.metadata?.name === 'admin-finds-app-pods',
    );
    expect(roles.map(({ file, namespace }) => [file, namespace])).toEqual([
      ['base/website/admin-finds-app-pods.yaml', 'website'],
    ]);
    // A slice's name is generated, so none is named; never get, watch or a change, nor the pods themselves.
    expect(roles[0]?.manifest.rules).toEqual([
      { apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['list'] },
    ]);
    const bound = all.filter(({ manifest }) => manifest.roleRef?.name === 'admin-finds-app-pods');
    expect(bound.map(({ manifest, namespace }) => [manifest.kind, namespace, manifest.subjects])).toEqual([
      ['RoleBinding', 'website', [{ kind: 'ServiceAccount', name: 'admin', namespace: 'factory' }]],
    ]);
  });

  it('runs as its own service account, with its token, for the app’s Rollout alone', async () => {
    const all = await manifests();
    const deployment = all.find(
      ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === 'admin',
    );
    const spec = deployment?.manifest.spec?.template?.spec;
    expect(spec?.serviceAccountName).toBe('admin');
    expect(spec?.automountServiceAccountToken).toBe(true);
    const env = Object.fromEntries((spec?.containers?.[0]?.env ?? []).map((e) => [e.name, e.value]));
    expect(env.RELEASE_ROLLOUT).toBe('website/website');
    // The FeatureFlag its Role in `flagd` names (deploy/base/flagd/admin-stages-flags.yaml): any other is refused.
    expect(env.FEATURE_FLAGS).toBe('flagd/flags');
    // In `factory`, only the line and the admin service hold a token for the API: every other pod, of any workload,
    // says it holds none, and a pod that does not say counts as holding one.
    const pods = all
      .filter(({ namespace }) => namespace === 'factory')
      .map(({ manifest }) => ({
        name: manifest.metadata?.name,
        pod: manifest.spec?.template?.spec ?? manifest.spec?.jobTemplate?.spec?.template?.spec,
      }))
      .filter(({ pod }) => pod !== undefined);
    expect(pods.length).toBeGreaterThan(10);
    const withToken = pods.filter(({ pod }) => pod?.automountServiceAccountToken !== false).map(({ name }) => name);
    expect(withToken.sort()).toEqual(['admin', 'line']);
  });

  it('previews a flag on the app where a browser on the Mac reaches it', async () => {
    // The console's APP_URL, which a flag's "Preview it" opens: the app's host, as the traffic generator names it to
    // Traefik, on the port k3d publishes Traefik's plain HTTP on.
    const all = await manifests();
    const envOf = (name: string) =>
      Object.fromEntries(
        (
          all.find(({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === name)?.manifest.spec
            ?.template?.spec?.containers?.[0]?.env ?? []
        ).map((e) => [e.name, e.value]),
      );
    const cluster = parse(await readFile(join(DEPLOY, 'k3d', 'cluster.yaml'), 'utf-8')) as {
      ports: { port: string }[];
    };
    const http = cluster.ports.map(({ port }) => port.split(':')).find((parts) => parts.at(-1) === '80');
    const app = new URL(envOf('console').APP_URL ?? '');
    expect(app.protocol).toBe('http:');
    expect(app.hostname).toBe(new URL(envOf('traffic').APP_URL ?? '').hostname);
    expect(app.port).toBe(http?.at(-2));
  });

  it('holds Martin’s settings to the profile the gateway enforces, and says so on the console', async () => {
    // FACTORY_PROFILE and ALL_LOCAL as each Deployment that reads them sets them: the gateway enforces them, the line
    // bounds a step by them, the admin service holds a save to them, and the console shows them.
    const settings = (await manifests())
      .filter(
        ({ manifest, namespace }) =>
          manifest.kind === 'Deployment' &&
          namespace === 'factory' &&
          ['gateway', 'line', 'admin', 'console'].includes(manifest.metadata?.name ?? ''),
      )
      .map(({ manifest }) => {
        const env = (manifest.spec?.template?.spec?.containers ?? []).flatMap((c) => c.env ?? []);
        const value = (name: string) => env.find((e) => e.name === name)?.value;
        return [manifest.metadata?.name, value('FACTORY_PROFILE'), value('ALL_LOCAL')];
      });
    expect(settings).toHaveLength(4);
    // The local cluster's: the local profile, with every agent on the model Martin chose.
    for (const each of settings) expect(each.slice(1), each[0]).toEqual(['local', undefined]);
  });

  it('serves the console’s origin, and trusts forwarded headers from the pod network only', async () => {
    const deployment = (await manifests()).find(
      ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === 'admin',
    );
    const env = Object.fromEntries(
      (deployment?.manifest.spec?.template?.spec?.containers?.[0]?.env ?? []).map((e) => [e.name, e.value]),
    );
    expect(env.ADMIN_ORIGIN).toBe('https://console.localhost:8443');
    expect(env.ADMIN_TRUSTED_PROXIES).toBe('10.42.0.0/16');
  });
});

describe('the app’s routes', () => {
  // The app's repository, which agents write to, may make Traefik routes in `website`. A route on the console's host
  // would take Martin's session cookie, so admission lets a route there name the app's hosts alone.
  it('are the only routes the app’s repository may make, and the admission policy holds them', async () => {
    const all = await manifests();
    const project = all.find(({ manifest }) => manifest.kind === 'AppProject' && manifest.metadata?.name === 'website');
    const routing = (project?.manifest.spec?.namespaceResourceWhitelist ?? []).filter(
      ({ group, kind }) =>
        ['traefik.io', 'traefik.containo.us', 'networking.k8s.io', 'gateway.networking.k8s.io'].includes(group) &&
        kind !== 'Middleware' &&
        kind !== 'TraefikService',
    );
    expect(routing).toEqual([{ group: 'traefik.io', kind: 'IngressRoute' }]);
    const policy = all.find(
      ({ manifest }) => manifest.kind === 'ValidatingPolicy' && manifest.metadata?.name === 'routes',
    );
    expect(policy?.file).toBe('base/admission/website/routes.yaml');
    expect(policy?.manifest.spec?.validationActions).toEqual(['Deny']);
    expect(policy?.manifest.spec?.matchConstraints?.resourceRules).toEqual([
      expect.objectContaining({ apiGroups: ['traefik.io'], resources: ['ingressroutes'] }),
    ]);
    const hosts = policy?.manifest.spec?.variables?.find((v) => v.name === 'hosts')?.expression ?? '';
    expect(hosts).not.toMatch(/console/);
  });

  it('were refused by the cluster on any host but the app’s (scripts/route-refusals.sh)', async () => {
    const kept = (
      JSON.parse(await readFile(join(DEPLOY, 'test', 'route-refusals.json'), 'utf-8')) as {
        cases: {
          case: string;
          outcome: string;
          message: string;
        }[];
      }
    ).cases;
    const outcomes = Object.fromEntries(kept.map((k) => [k.case, k.outcome]));
    expect(outcomes).toEqual({
      app: 'admitted',
      'app-path': 'admitted',
      console: 'refused',
      'no-host': 'refused',
      'or-console': 'refused',
      'host-regexp': 'refused',
      'console-and-app': 'refused',
    });
    for (const refusal of kept.filter((k) => k.outcome === 'refused')) {
      expect(refusal.message).toContain('Policy website-routes failed');
    }
  });
});
