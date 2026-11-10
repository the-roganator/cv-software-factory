import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { DEPLOY, manifests as deployManifests } from './deploy.ts';

/**
 * The mark's fences as deploy/ declares them (milestone 7): `x-unmeasured`, which the factory's checks send and a
 * flag's first stage is on for, is removed from everything that comes through Traefik by the app's Middleware
 * `visitors`. The app's repository writes that Middleware and the route, so admission holds every route in `website`
 * to it and every Middleware there to the strip, and Traefik reads no reference across namespaces.
 */
interface Manifest {
  kind?: string;
  metadata?: { name?: string };
  spec?: {
    namespaceResourceWhitelist?: { group: string; kind: string }[];
    validationActions?: string[];
    failurePolicy?: string;
    matchConstraints?: unknown;
    matchConditions?: unknown[];
    variables?: { name: string; expression: string }[];
  };
}
interface Kept {
  k3s: string;
  helmChartConfigs: string[];
  traefik: { image: string; providers: string[]; args: string[]; env: string[]; envFrom: unknown[] };
  cases: { case: string; outcome: string; message: string }[];
  live: { case: string; outcome: string; message: string }[];
}

const manifests = () => deployManifests<Manifest>();
const record = async () => JSON.parse(await readFile(join(DEPLOY, 'test', 'mark-refusals.json'), 'utf-8')) as Kept;

/** The kinds the app's project may make that Traefik reads, each as the policy names its resource. */
const TRAEFIK_KINDS: { [kind: string]: string } = {
  IngressRoute: 'ingressroutes',
  TraefikService: 'traefikservices',
  Middleware: 'middlewares',
};

describe('the mark', () => {
  it('is held, in every Traefik kind the app’s repository may make, by a policy that holds everyone', async () => {
    const all = await manifests();
    const project = all.find(({ manifest }) => manifest.kind === 'AppProject' && manifest.metadata?.name === 'website');
    const kinds = project?.manifest.spec?.namespaceResourceWhitelist ?? [];
    // Nothing else Traefik routes by: no Ingress, no IngressRouteTCP or UDP, no Gateway API route.
    const routing = kinds.filter(({ group }) =>
      ['traefik.io', 'traefik.containo.us', 'networking.k8s.io', 'gateway.networking.k8s.io'].includes(group),
    );
    expect(routing.every(({ group }) => group === 'traefik.io')).toBe(true);
    expect(routing.map(({ kind }) => kind).sort()).toEqual(Object.keys(TRAEFIK_KINDS).sort());

    const policy = all.find(
      ({ manifest }) => manifest.kind === 'ValidatingPolicy' && manifest.metadata?.name === 'mark',
    );
    expect(policy?.file).toBe('base/admission/website/mark.yaml');
    const spec = policy?.manifest.spec;
    expect(spec?.validationActions).toEqual(['Deny']);
    expect(spec?.failurePolicy).toBe('Fail');
    expect(spec?.matchConstraints).toEqual({
      namespaceSelector: {
        matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'In', values: ['website'] }],
      },
      resourceRules: [
        {
          apiGroups: ['traefik.io'],
          apiVersions: ['*'],
          operations: ['CREATE', 'UPDATE'],
          resources: Object.values(TRAEFIK_KINDS),
        },
      ],
    });
    // Every request, Argo CD's and an administrator's too.
    expect(spec?.matchConditions).toBeUndefined();
    const variables = Object.fromEntries((spec?.variables ?? []).map((v) => [v.name, v.expression]));
    expect(variables).toEqual({
      strip: "'visitors'",
      stripSpec: "{'headers': {'customRequestHeaders': {'x-unmeasured': ''}}}",
    });

    const rendered = parseAllDocuments(
      execFileSync('kustomize', ['build', join(DEPLOY, 'base/admission/website')], { encoding: 'utf-8' }),
    ).map((doc) => doc.toJS() as Manifest);
    expect(rendered.filter((r) => r.kind === 'ValidatingPolicy').map((r) => r.metadata?.name)).toContain(
      'website-mark',
    );
  });

  it('was answered by the cluster as the policy says (scripts/mark-refusals.sh)', async () => {
    const { cases } = await record();
    expect(Object.fromEntries(cases.map((c) => [c.case, c.outcome]))).toEqual({
      'route-app': 'admitted',
      'route-namespaced': 'admitted',
      'route-bare': 'refused',
      'route-second': 'refused',
      'route-other': 'refused',
      'route-elsewhere': 'refused',
      'route-provider': 'refused',
      'route-service-mw': 'refused',
      'route-internal': 'refused',
      'route-service-ns': 'refused',
      'route-dropped': 'refused',
      'split-app': 'admitted',
      'split-mw': 'refused',
      'split-internal': 'refused',
      'split-mirror': 'refused',
      strip: 'admitted',
      set: 'refused',
      'set-cased': 'refused',
      'strip-and-set': 'refused',
      'other-header': 'refused',
      'strip-and-response': 'refused',
      chain: 'refused',
      plugin: 'refused',
      'forward-auth': 'refused',
      'forward-auth-regex': 'refused',
      'basic-auth': 'refused',
      'strip-changed': 'refused',
    });
    for (const refusal of cases.filter((c) => c.outcome === 'refused')) {
      expect(refusal.message, refusal.case).toContain('Policy website-mark failed');
    }
  });

  it('admits what was in website before it, sent back unchanged (scripts/mark-refusals.sh)', async () => {
    // The policy holds what is made and changed, not what is there; these show the app's are as it requires.
    const { live } = await record();
    expect(live.map((l) => l.case)).toEqual(
      expect.arrayContaining([
        'ingressroute.traefik.io/website',
        'traefikservice.traefik.io/website',
        'middleware.traefik.io/visitors',
      ]),
    );
    for (const object of live) expect(object.outcome, object.case).toBe('admitted');
  });
});

describe('Traefik', () => {
  // A route in `website` naming a Middleware or a Service in another namespace, or a route elsewhere naming the app's,
  // is refused by Traefik while `providers.kubernetescrd.allowCrossNamespace` is off, which also refuses a
  // `namespace-name@kubernetescrd` reference. An ExternalName Service, which could name another namespace's Service by
  // its DNS name, is refused while `allowExternalNameServices` is off, in both Kubernetes providers. Both are off by
  // default at Traefik 3.7, and k3s's bundled chart (traefik 41.6.101 in k3s v1.37.2) sets neither, so what holds them
  // is that nothing changes the chart's values and that the providers' arguments are these. These are references to
  // objects; an address is not one (a forwardAuth's URL could name the app's Service), and only this repository makes
  // Middlewares outside `website`.
  it('reads no reference across namespaces: its providers are the bundled chart’s, as the cluster has them', async () => {
    const { k3s, helmChartConfigs, traefik } = await record();
    const cluster = parse(await readFile(join(DEPLOY, 'k3d', 'cluster.yaml'), 'utf-8')) as {
      image: string;
      files?: unknown;
      options?: { k3s?: unknown };
    };
    // The record was made on the k3s this repository pins; a new one is checked again.
    expect(cluster.image).toBe(`rancher/k3s:${k3s.replace('+', '-')}`);
    expect(traefik.image).toBe('rancher/mirrored-library-traefik:3.7.15');
    expect(traefik.providers).toEqual([
      '--providers.kubernetescrd',
      '--providers.kubernetescrd.allowEmptyServices=true',
      '--providers.kubernetesingress',
      '--providers.kubernetesingress.allowEmptyServices=true',
      '--providers.kubernetesingress.ingressendpoint.publishedservice=kube-system/traefik',
    ]);
    // Nor does a configuration file or an environment variable, Traefik's other two sources of static settings.
    expect(traefik.args.filter((arg) => /^--configfile/i.test(arg))).toEqual([]);
    expect(traefik.env.filter((name) => name.startsWith('TRAEFIK_'))).toEqual([]);
    expect(traefik.envFrom).toEqual([]);
    // Nothing on the cluster, and nothing in this repository, changes the chart's values: no HelmChartConfig, no
    // manifest k3d copies onto the node, and no argument to k3s.
    expect(helmChartConfigs).toEqual([]);
    expect((await manifests()).filter(({ manifest }) => manifest.kind === 'HelmChartConfig')).toEqual([]);
    expect(cluster.files).toBeUndefined();
    expect(cluster.options?.k3s).toBeUndefined();
  });
});
