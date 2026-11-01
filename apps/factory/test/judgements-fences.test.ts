import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEPLOY, manifests as deployManifests } from './deploy.ts';

/**
 * The fence around the gateway's judgements as deploy/ declares it: triage's caller token, in a Secret that only triage
 * and the gateway name. The network policy lets runners' agent pods reach the gateway on the same port, so this token,
 * and not the network, is what keeps an agent from asking Jev in triage's name, outside its work item's cap.
 */
interface Container {
  name: string;
  env?: { name: string; value?: string; valueFrom?: Record<string, unknown> }[];
  envFrom?: unknown[];
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    template?: {
      spec: {
        automountServiceAccountToken?: boolean;
        containers: Container[];
        initContainers?: Container[];
        volumes?: unknown[];
      };
    };
  };
}

const manifests = () => deployManifests<Manifest>();
const SECRET = 'judgements-token';

const deployment = async (name: string) => {
  const found = (await manifests()).find(
    ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === name,
  );
  if (!found?.manifest.spec?.template) throw new Error(`No ${name} Deployment`);
  return { ...found, pod: found.manifest.spec.template };
};

describe('triage’s token for judgements', () => {
  it.each([
    ['triage', 'base/factory/triage.yaml'],
    ['gateway', 'base/factory/gateway.yaml'],
  ])('is taken by %s, required, into its one container’s environment', async (name, file) => {
    const found = await deployment(name);
    expect([found.file, found.namespace]).toEqual([file, 'factory']);
    const [container, ...others] = found.pod.spec.containers;
    expect(others).toEqual([]);
    expect(found.pod.spec.initContainers).toBeUndefined();
    // Not optional: a pod with no token does not start, rather than one that judges nothing or takes any caller.
    expect(container?.env?.find((e) => e.name === 'JUDGEMENTS_TOKEN')).toEqual({
      name: 'JUDGEMENTS_TOKEN',
      valueFrom: { secretKeyRef: { name: SECRET, key: 'token' } },
    });
    expect(container?.envFrom).toBeUndefined();
    // No token for the Kubernetes API, where a Secret could be read.
    expect(found.pod.spec.automountServiceAccountToken).toBe(false);
  });

  it('is named by nothing else in deploy/: no other pod mounts it, or takes it into its environment', async () => {
    const naming = (await manifests()).filter(({ manifest }) => JSON.stringify(manifest).includes(SECRET));
    expect(naming.map(({ file, manifest }) => `${file} ${manifest.kind}/${manifest.metadata?.name}`).sort()).toEqual([
      'base/factory/gateway.yaml Deployment/gateway',
      'base/factory/triage.yaml Deployment/triage',
    ]);
  });

  it('is in no manifest: make judgements-token makes it, through stdin, and make up runs it', async () => {
    const made = (await manifests()).filter(
      ({ manifest }) => manifest.kind === 'Secret' && manifest.metadata?.name === SECRET,
    );
    expect(made).toEqual([]);
    const makefile = await readFile(join(DEPLOY, '..', 'Makefile'), 'utf-8');
    expect(makefile).toContain(`create secret generic ${SECRET} --from-file=token=/dev/stdin`);
    expect(makefile).toMatch(/^\t@\$\(MAKE\) --no-print-directory judgements-token$/m);
    expect(makefile).toMatch(/^\.PHONY: .*\bjudgements-token\b/m);
  });
});
