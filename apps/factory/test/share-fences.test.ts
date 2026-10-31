import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { HEADERS } from '../src/traffic/share.ts';
import { DEPLOY, manifests as deployManifests, type LabelSelector, selects } from './deploy.ts';

/**
 * The fences around a share's signed ids as deploy/ declares them (milestone 7): the generator's private key in a
 * Secret that only it mounts; its requests kept inside the cluster, from its pod to Traefik's; the public key in
 * `share-key`, which admission lets only `make share-key`'s user write; and Traefik keeping no record of the headers a
 * signature travels in.
 */
interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
  ipBlock?: { cidr: string };
}
interface NetworkRule {
  to?: Peer[];
  from?: Peer[];
  ports?: { protocol: string; port: number }[];
}
interface Container {
  name: string;
  env?: { name: string; value?: string; valueFrom?: unknown }[];
  envFrom?: unknown[];
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: {
    // A Deployment's
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec: {
        automountServiceAccountToken?: boolean;
        securityContext?: { runAsUser?: number; runAsGroup?: number; fsGroup?: number };
        containers: Container[];
        initContainers?: Container[];
        volumes?: { name: string; secret?: unknown }[];
      };
    };
    // A NetworkPolicy's
    podSelector?: LabelSelector;
    policyTypes?: string[];
    ingress?: NetworkRule[];
    egress?: NetworkRule[];
    // An admission policy's, and its binding's
    failurePolicy?: string;
    matchConstraints?: unknown;
    matchConditions?: { name: string; expression: string }[];
    variables?: { name: string; expression: string }[];
    validations?: { expression: string }[];
    policyName?: string;
    validationActions?: string[];
  };
}

const manifests = () => deployManifests<Manifest>();
const SECRET = 'share-signing-key';

const traffic = async () => {
  const found = (await manifests()).find(
    ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === 'traffic',
  );
  if (!found?.manifest.spec?.template) throw new Error('No traffic Deployment');
  return { ...found, pod: found.manifest.spec.template };
};

describe('the generator’s signing key', () => {
  it('is mounted by the generator, read-only and optional, readable by its user’s group alone', async () => {
    const { file, namespace, pod } = await traffic();
    expect([file, namespace]).toEqual(['base/factory/traffic.yaml', 'factory']);
    expect(pod.spec.volumes).toEqual([
      {
        name: 'share-key',
        secret: {
          secretName: SECRET,
          optional: true,
          defaultMode: 0o440,
          items: [{ key: 'private-key', path: 'private-key' }],
        },
      },
    ]);
    expect(pod.spec.securityContext).toMatchObject({ runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532 });
    const [container, ...others] = pod.spec.containers;
    expect(others).toEqual([]);
    expect(pod.spec.initContainers).toBeUndefined();
    expect(container?.volumeMounts).toEqual([{ name: 'share-key', mountPath: '/var/run/share-key', readOnly: true }]);
    expect(container?.env?.find((e) => e.name === 'SHARE_KEY_FILE')?.value).toBe('/var/run/share-key/private-key');
    // It talks to nothing but Traefik and the collector: no token for the Kubernetes API, where a Secret could be read.
    expect(pod.spec.automountServiceAccountToken).toBe(false);
  });

  it('is named by nothing else in deploy/: no other pod mounts it, or takes it into its environment', async () => {
    const naming = (await manifests()).filter(({ manifest }) => JSON.stringify(manifest).includes(SECRET));
    expect(naming.map(({ file, manifest }) => `${file} ${manifest.kind}/${manifest.metadata?.name}`)).toEqual([
      'base/factory/traffic.yaml Deployment/traffic',
    ]);
  });
});

describe('the generator’s requests', () => {
  const describePeer = (peer: Peer) =>
    peer.ipBlock
      ? peer.ipBlock.cidr
      : [peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'], peer.podSelector?.matchLabels];

  it('go to Traefik’s Service inside the cluster, with the app’s host', async () => {
    const env = Object.fromEntries(
      ((await traffic()).pod.spec.containers[0]?.env ?? []).map(({ name, value }) => [name, value]),
    );
    expect(env.INGRESS_URL).toBe('http://traefik.kube-system');
    expect(env.APP_URL).toBe('http://website.localhost');
  });

  it('reach Traefik’s pods on their web port, the collector and DNS, and nothing else, and nothing reaches it', async () => {
    const { pod } = await traffic();
    const labels = pod.metadata?.labels ?? {};
    const policies = (await manifests()).filter(
      ({ manifest, namespace }) =>
        manifest.kind === 'NetworkPolicy' && namespace === 'factory' && selects(manifest.spec?.podSelector, labels),
    );
    expect(policies.map(({ manifest }) => manifest.metadata?.name).sort()).toEqual([
      'allow-dns',
      'default-deny',
      'traffic',
    ]);
    const egress = policies.flatMap(({ manifest }) =>
      (manifest.spec?.egress ?? []).map((rule) => ({
        to: (rule.to ?? []).map(describePeer),
        ports: (rule.ports ?? []).map((p) => `${p.protocol}/${p.port}`),
      })),
    );
    expect(egress).toEqual([
      { to: [['kube-system', { 'k8s-app': 'kube-dns' }]], ports: ['UDP/53', 'TCP/53'] },
      { to: [['kube-system', { 'app.kubernetes.io/name': 'traefik' }]], ports: ['TCP/8000'] },
      { to: [['telemetry', { 'app.kubernetes.io/name': 'opentelemetry-collector' }]], ports: ['TCP/4318'] },
    ]);
    expect(policies.flatMap(({ manifest }) => manifest.spec?.ingress ?? [])).toEqual([]);
  });
});

describe('share-key', () => {
  it('may be made, changed or deleted by make share-key’s user alone, by a policy that holds everyone else', async () => {
    const all = await manifests();
    const policy = all.find(
      ({ manifest }) => manifest.kind === 'ValidatingAdmissionPolicy' && manifest.metadata?.name === 'share-key',
    );
    expect(policy?.file).toBe('base/admission/website/share-key.yaml');
    const spec = policy?.manifest.spec;
    expect(spec?.failurePolicy).toBe('Fail');
    expect(spec?.matchConstraints).toEqual({
      namespaceSelector: {
        matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'In', values: ['website'] }],
      },
      resourceRules: [
        { apiGroups: [''], apiVersions: ['*'], operations: ['CREATE', 'UPDATE', 'DELETE'], resources: ['configmaps'] },
      ],
    });
    // It names the ConfigMap, and no requester: Argo CD's and an administrator's requests are held too.
    expect(spec?.matchConditions).toEqual([
      {
        name: 'share-key',
        expression: "(request.operation == 'DELETE' ? oldObject : object).metadata.name == 'share-key'",
      },
    ]);
    // The user the local kubeconfig names, whose client certificate k3s issues as `CN=system:admin`.
    expect(spec?.variables).toEqual([{ name: 'writer', expression: "'system:admin'" }]);
    expect(spec?.validations?.map((v) => v.expression)).toEqual([
      "request.userInfo.username == variables.writer || (request.operation == 'DELETE' && has(namespaceObject.metadata.deletionTimestamp))",
    ]);
    const rendered = parseAllDocuments(
      execFileSync('kustomize', ['build', join(DEPLOY, 'base/admission/website')], { encoding: 'utf-8' }),
    ).map((doc) => doc.toJS() as Manifest);
    const binding = rendered.find(
      (r) => r.kind === 'ValidatingAdmissionPolicyBinding' && r.metadata?.name === 'website-share-key',
    );
    expect(binding?.spec).toEqual({ policyName: 'website-share-key', validationActions: ['Deny'] });
  });

  it('is in no manifest: make share-key makes it, from the generator’s Secret', async () => {
    const made = (await manifests()).filter(
      ({ manifest }) => manifest.kind === 'ConfigMap' && manifest.metadata?.name === 'share-key',
    );
    expect(made).toEqual([]);
    const makefile = await readFile(join(DEPLOY, '..', 'Makefile'), 'utf-8');
    expect(makefile).toContain('create configmap share-key --from-file=public-key=/dev/stdin');
    expect(makefile).toMatch(/^\t@\$\(MAKE\) --no-print-directory share-key$/m);
  });

  it('was answered by the cluster as the policy says, and holds the Secret’s public half (scripts/share-key-refusals.sh)', async () => {
    const kept = JSON.parse(await readFile(join(DEPLOY, 'test', 'share-key-refusals.json'), 'utf-8')) as {
      cases: { case: string; outcome: string; message: string }[];
      live: { keys: string[]; matchesSecret: boolean };
    };
    expect(Object.fromEntries(kept.cases.map((k) => [k.case, k.outcome]))).toEqual({
      'admin-change': 'admitted',
      'admin-delete': 'admitted',
      'argocd-create': 'refused',
      'argocd-change': 'refused',
      'argocd-delete': 'refused',
      'argocd-other': 'admitted',
      'master-change': 'refused',
      'master-delete': 'refused',
    });
    for (const refusal of kept.cases.filter((k) => k.outcome === 'refused')) {
      expect(refusal.message, refusal.case).toContain("ValidatingAdmissionPolicy 'website-share-key'");
    }
    expect(kept.live).toEqual({ keys: ['public-key'], matchesSecret: true });
  });
});

/**
 * Whether Traefik, run with these arguments, writes any of the share's headers to its access log or its spans. Its
 * access log is off unless an `--accesslog` option is given, and then keeps a request header only as
 * `fields.headers.defaultmode` or the header's own `fields.headers.names.<name>` says, `drop` by default. Not relying
 * on that default: with the access log on, each of the share's headers must be dropped by name. Its tracing records a
 * request header only when `tracing.capturedrequestheaders` names it. Options are case-insensitive.
 */
function recordsShareHeaders(args: readonly string[]): string[] {
  const options = new Map(
    args.map((arg) => {
      const [name = '', value = 'true'] = arg.replace(/^--/, '').split(/=(.*)/s);
      return [name.toLowerCase(), value];
    }),
  );
  const headers = Object.values(HEADERS);
  const logging = [...options].some(([name, value]) => name.startsWith('accesslog') && value.toLowerCase() !== 'false');
  const logged = logging
    ? headers.filter((h) => options.get(`accesslog.fields.headers.names.${h}`)?.toLowerCase() !== 'drop')
    : [];
  const captured = (options.get('tracing.capturedrequestheaders') ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => (headers as string[]).includes(h));
  return [...new Set([...logged, ...captured])];
}

describe('Traefik', () => {
  const traefik = async () =>
    (
      JSON.parse(await readFile(join(DEPLOY, 'test', 'mark-refusals.json'), 'utf-8')) as {
        traefik: { args: string[] };
      }
    ).traefik;

  it('keeps no record of the share’s headers, as the cluster runs it (scripts/mark-refusals.sh)', async () => {
    const { args } = await traefik();
    // No access log at all today, and no tracing; its other sources of settings are held empty in mark-fences.test.ts.
    expect(args.filter((arg) => /^--(accesslog|tracing)/i.test(arg))).toEqual([]);
    expect(recordsShareHeaders(args)).toEqual([]);
  });

  it('would fail this test if its access log were turned on, or its tracing captured them, without dropping them', () => {
    const [id, time, signature] = Object.values(HEADERS);
    const drop = Object.values(HEADERS).map((h) => `--accesslog.fields.headers.names.${h}=drop`);
    expect(recordsShareHeaders(['--accesslog=true'])).toEqual([id, time, signature]);
    expect(recordsShareHeaders(['--accessLog.filePath=/var/log/access.log'])).toEqual([id, time, signature]);
    expect(recordsShareHeaders(['--accesslog=false'])).toEqual([]);
    expect(recordsShareHeaders(['--accesslog', '--accesslog.fields.headers.defaultmode=keep', ...drop])).toEqual([]);
    expect(recordsShareHeaders(['--accesslog', `--accesslog.fields.headers.names.${signature}=keep`])).toContain(
      signature,
    );
    expect(recordsShareHeaders([`--tracing.capturedRequestHeaders=User-Agent,X-Share-Signature`])).toEqual([signature]);
  });
});
