import { describe, expect, it } from 'vitest';
import { APPS } from '../../../scripts/github-settings.ts';
import { type Manifest, rendered } from './deploy.ts';

/**
 * Who holds a key, over every profile's rendered manifests (spec 6, guardrails 2 and 10): only the gateway holds a
 * model provider's key, and only the GitHub worker a GitHub credential, its App's. A pod holds a Secret by naming it
 * in a container's env (`secretKeyRef`), its `envFrom`, or a volume, a projected one's sources included; a key may also
 * come under its provider's variable name, from any Secret or written in. Both are recognised by name, so a key under a
 * name of no provider's is not seen here. No role deploy/ makes may read Secrets (scoreboard-fences.test.ts), so a pod
 * cannot read a key it does not name. The runners' pods, which the line makes as it runs, are tested in
 * proofs/one-gateway.runners.test.ts.
 */
interface Container {
  name: string;
  env?: { name: string; value?: string; valueFrom?: { secretKeyRef?: { name: string } } }[];
  envFrom?: { secretRef?: { name: string } }[];
}
interface PodSpec {
  containers: Container[];
  initContainers?: Container[];
  volumes?: { secret?: { secretName: string }; projected?: { sources: { secret?: { name: string } }[] } }[];
}

/** The model providers' keys, as the gateway names their Secrets (deploy/base/factory/gateway.yaml). */
const MODEL_KEYS = ['anthropic', 'typesafe'];
/** The factory's App's key, as the GitHub worker names its Secret (deploy/base/factory/github.yaml). */
const GITHUB_KEY = 'github-app';
/** An environment variable that would carry a model provider's key: its own name, or any API key. */
const MODEL_CREDENTIAL = /^(?:(?:ANTHROPIC|OPENAI|TYPESAFE|GEMINI|GOOGLE|MISTRAL|COHERE)_\w*|\w*API_KEY)$/;
/**
 * An environment variable that may carry a GitHub credential: any GitHub's tools read, but for an address, a Client ID
 * (which GitHub does not keep secret) or a dry run's settings.
 */
const GITHUB_CREDENTIAL = /^(?!.*(_URL|_CLIENT_ID|_DRY_RUN\w*)$)(GH|GITHUB)_/;

const envOf = (pod: PodSpec) => [...pod.containers, ...(pod.initContainers ?? [])].flatMap((c) => c.env ?? []);

/** Every pod spec in a manifest, however deep its kind keeps it: a Deployment's, a CronJob's, a Rollout's. */
function podSpecs(value: unknown): PodSpec[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray((value as PodSpec).containers)) return [value as PodSpec];
  return Object.values(value).flatMap(podSpecs);
}

/** Each Secret a pod names, with the container that names it, or `(volume)` for the pod's own volumes. */
function secretsOf(pod: PodSpec): { container: string; secret: string }[] {
  const containers = [...pod.containers, ...(pod.initContainers ?? [])];
  return [
    ...containers.flatMap((c) =>
      [
        ...(c.env ?? []).flatMap((e) => (e.valueFrom?.secretKeyRef ? [e.valueFrom.secretKeyRef.name] : [])),
        ...(c.envFrom ?? []).flatMap((e) => (e.secretRef ? [e.secretRef.name] : [])),
      ].map((secret) => ({ container: c.name, secret })),
    ),
    ...(pod.volumes ?? [])
      .flatMap((v) => [
        ...(v.secret ? [v.secret.secretName] : []),
        ...(v.projected?.sources ?? []).flatMap((s) => (s.secret ? [s.secret.name] : [])),
      ])
      .map((secret) => ({ container: '(volume)', secret })),
  ];
}

type Workload = Manifest & { kind: string; metadata: { name: string; namespace?: string } };
const pods = () =>
  rendered<Workload>().flatMap(({ overlay, manifest }) =>
    podSpecs(manifest).map((pod) => ({
      overlay,
      workload: `${manifest.metadata.namespace ?? ''}/${manifest.kind}/${manifest.metadata.name}`,
      pod,
    })),
  );

describe('the keys each profile’s pods hold', () => {
  const all = pods();

  it('are read from every overlay, and every workload in it', () => {
    expect(new Set(all.map((p) => p.overlay)).size).toBeGreaterThan(0);
    expect(all.map((p) => p.workload)).toContain('factory/Deployment/gateway');
  });

  it('give a model provider’s key to the gateway alone', () => {
    const overlays = [...new Set(all.map((p) => p.overlay))];
    const byName = all.filter(({ pod }) => envOf(pod).some((e) => MODEL_CREDENTIAL.test(e.name)));
    expect(byName.map((p) => `${p.overlay}: ${p.workload}`)).toEqual(
      overlays.map((overlay) => `${overlay}: factory/Deployment/gateway`),
    );
    for (const key of MODEL_KEYS) {
      const holders = all.filter(({ pod }) => secretsOf(pod).some((s) => s.secret === key));
      expect(
        holders.map((p) => `${p.overlay}: ${p.workload}`),
        key,
      ).toEqual([...new Set(all.map((p) => p.overlay))].map((overlay) => `${overlay}: factory/Deployment/gateway`));
    }
  });

  it('give a GitHub credential to the GitHub worker alone, and only its App’s', () => {
    const holders = all.filter(
      ({ pod }) =>
        secretsOf(pod).some((s) => s.secret === GITHUB_KEY) || envOf(pod).some((e) => GITHUB_CREDENTIAL.test(e.name)),
    );
    expect([...new Set(holders.map((p) => p.workload))]).toEqual(['factory/Deployment/github']);
    for (const { pod } of holders) {
      const env = envOf(pod);
      expect(env.filter((e) => GITHUB_CREDENTIAL.test(e.name)).map((e) => e.name)).toEqual(['GITHUB_APP_PRIVATE_KEY']);
      expect(env.find((e) => e.name === 'GITHUB_APP_PRIVATE_KEY')?.valueFrom?.secretKeyRef?.name).toBe(GITHUB_KEY);
      // The factory's App, as github-settings.ts declares it: no other App's key.
      expect(env.find((e) => e.name === 'GITHUB_APP_CLIENT_ID')?.value).toBe(APPS.factory.clientId);
    }
  });
});

describe('finding the Secrets a pod holds', () => {
  it('reads a container’s env and envFrom, and the pod’s volumes, projected ones too', () => {
    const pod: PodSpec = {
      containers: [{ name: 'a', env: [{ name: 'K', valueFrom: { secretKeyRef: { name: 'anthropic' } } }] }],
      initContainers: [{ name: 'b', envFrom: [{ secretRef: { name: 'typesafe' } }] }],
      volumes: [{ secret: { secretName: 'github-app' } }, { projected: { sources: [{ secret: { name: 'x' } }] } }],
    };
    expect(secretsOf(pod)).toEqual([
      { container: 'a', secret: 'anthropic' },
      { container: 'b', secret: 'typesafe' },
      { container: '(volume)', secret: 'github-app' },
      { container: '(volume)', secret: 'x' },
    ]);
    expect(podSpecs({ spec: { jobTemplate: { spec: { template: { spec: pod } } } } })).toEqual([pod]);
    for (const name of ['GH_TOKEN', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_TOKEN_FILE', 'GH_APP_KEY_PATH', 'GITHUB_PAT']) {
      expect(GITHUB_CREDENTIAL.test(name), name).toBe(true);
    }
    for (const name of [
      'GITHUB_APP_CLIENT_ID',
      'GITHUB_DRY_RUN',
      'GITHUB_DRY_RUN_MERGE_SECONDS',
      'GITHUB_WORKER_URL',
    ]) {
      expect(GITHUB_CREDENTIAL.test(name), name).toBe(false);
    }
    for (const name of ['ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY', 'OPENAI_KEY', 'SOME_API_KEY']) {
      expect(MODEL_CREDENTIAL.test(name), name).toBe(true);
    }
  });
});
