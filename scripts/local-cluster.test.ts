import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments, stringify } from 'yaml';

/*
 * The local cluster publishes on the Mac alone. Each port k3d maps and the Kubernetes API bind to 127.0.0.1: a port
 * with no address, or the API left to k3d's defaults, would be published on every interface, reachable from any
 * network the Mac is on.
 */

const cluster = parse(readFileSync('deploy/k3d/cluster.yaml', 'utf-8')) as {
  apiVersion: string;
  metadata: { name: string };
  ports: { port: string }[];
  kubeAPI?: unknown;
  volumes?: { volume: string; nodeFilters: string[] }[];
  token?: unknown;
};
const makefile = readFileSync('Makefile', 'utf-8');

describe('the local cluster', () => {
  it('is written in the schema whose field names this test checks', () => {
    expect(cluster.apiVersion).toBe('k3d.io/v1alpha5');
  });

  it('maps every port on 127.0.0.1', () => {
    expect(cluster.ports.length).toBeGreaterThan(0);
    // k3d's `[HOST:][HOSTPORT:]CONTAINERPORT`: with all three parts, the first is the address.
    for (const { port } of cluster.ports) {
      const parts = port.split(':');
      expect(parts, port).toHaveLength(3);
      expect(parts[0], port).toBe('127.0.0.1');
    }
  });

  it('publishes the Kubernetes API on 127.0.0.1, at a fixed port', () => {
    expect(cluster.kubeAPI).toEqual({ hostIP: '127.0.0.1', hostPort: '6550' });
  });

  // k3d cannot change a node's image, so the cluster moves to a new k3s on the state it keeps off the node: k3s's data
  // directory on a volume `make up` makes first, which k3d leaves when it deletes the cluster (make upgrade-cluster).
  it("keeps k3s's data directory on a volume of its own, the one the Makefile makes and the move carries", () => {
    const state = `k3d-${cluster.metadata.name}-state`;
    expect(cluster.volumes).toEqual([{ volume: `${state}:/var/lib/rancher/k3s`, nodeFilters: ['server:0'] }]);
    expect(makefile).toMatch(/^CLUSTER := (\S+)$/m);
    expect(makefile.match(/^CLUSTER := (\S+)$/m)?.[1]).toBe(cluster.metadata.name);
    expect(makefile).toMatch(/^STATE := k3d-\$\(CLUSTER\)-state$/m);
    // Made before the cluster, which is made on it, and labelled so `make down` deletes it with any copy a move kept.
    expect(makefile).toContain('docker volume create --label software-factory.cluster=$(CLUSTER) $(STATE)');
    expect(makefile).toContain('docker volume ls -q --filter label=software-factory.cluster=$(CLUSTER)');
  });

  it('names no token: the move gives the one the state was made with, from a file of its own', () => {
    expect(cluster.token).toBeUndefined();
  });
});

/*
 * `make up REVISION=` deploys deploy/ and every chart's values from one revision, a branch or the commit platform.yml
 * makes a cluster from: the Makefile writes it into root, and root's patch points each Application's values there.
 */
describe('root, at a revision', () => {
  const REVISION = '0123456789abcdef0123456789abcdef01234567';
  const BRANCH = 'ci/platform-check';
  // The Makefile's lines that write root, up to the apply, as make hands them to the shell, the revision quoted as
  // make quotes it.
  const sed = /^\t(revision=.+?) \| \\\n\t\t\$\(KUBECTL\) apply -f -$/ms.exec(makefile)?.[1];
  const written = (revision = REVISION, check = '') =>
    execFileSync(
      'sh',
      [
        '-c',
        (sed ?? 'false')
          .replace("$(subst ','\\'',$(REVISION))", revision.replaceAll("'", "'\\''"))
          .replace('$(PLATFORM_CHECK)', check)
          .replaceAll('\\\n', '')
          .replaceAll('$$', '$'),
      ],
      { encoding: 'utf-8' },
    );

  it('is written by the Makefile with the revision in both places, and main nowhere', () => {
    expect(sed).toBeDefined();
    const root = parse(written()) as {
      spec: { source: { targetRevision: string; kustomize: { patches: { patch: string }[] } } };
    };
    expect(root.spec.source.targetRevision).toBe(REVISION);
    expect(root.spec.source.kustomize.patches).toHaveLength(1);
    expect(parse(root.spec.source.kustomize.patches[0]?.patch ?? '')).toEqual([
      { op: 'replace', path: '/spec/sources/1/targetRevision', value: REVISION },
    ]);
    expect(written()).not.toMatch(/: main$/m);
  });

  it.each([BRANCH, 'fix/a&b', 'fix/a|b', "fix/it's"])(
    'takes a branch named %s whole: a slash, as most here have, or what sed would read',
    (branch) => {
      const root = parse(written(branch)) as {
        spec: { source: { targetRevision: string; kustomize: { patches: { patch: string }[] } } };
      };
      expect(root.spec.source.targetRevision).toBe(branch);
      expect(parse(root.spec.source.kustomize.patches[0]?.patch ?? '')[0]?.value).toBe(branch);
    },
  );

  /** Everything root deploys, as Argo CD renders it with the patches the Makefile wrote into it. */
  function rendered(check = '') {
    const root = parse(written(REVISION, check)) as {
      spec: { source: { path: string; kustomize: { patches: { target: unknown; patch: string }[] } } };
    };
    const dir = mkdtempSync(join(tmpdir(), 'root-'));
    try {
      cpSync('deploy', join(dir, 'deploy'), { recursive: true });
      writeFileSync(
        join(dir, 'kustomization.yaml'),
        stringify({ resources: [root.spec.source.path], patches: root.spec.source.kustomize.patches }),
      );
      return parseAllDocuments(execFileSync('kustomize', ['build', dir], { encoding: 'utf-8' })).map(
        (d) => d.toJS() as Application & { spec: Record<string, unknown> },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("leaves out, for the platform check alone, the GitHub worker and the line's watch of releases, and nothing else", () => {
    const name = (d: { kind: string; metadata: { name: string; namespace?: string } }) =>
      `${d.kind}/${d.metadata.namespace ?? ''}/${d.metadata.name}`;
    const plain = new Map(rendered().map((d) => [name(d), d]));
    const check = new Map(rendered('1').map((d) => [name(d), d]));
    expect([...check.keys()].sort()).toEqual([...plain.keys()].sort());
    const changed = [...check].filter(([k, d]) => JSON.stringify(d) !== JSON.stringify(plain.get(k))).map(([k]) => k);
    expect(changed.sort()).toEqual(['Deployment/factory/github', 'Deployment/factory/line']);
    const github = check.get('Deployment/factory/github') as unknown as { spec: { replicas: number } };
    expect(github.spec.replicas).toBe(0);
    type Pod = { spec: { template: { spec: { containers: { name: string; env: { name: string }[] }[] } } } };
    const env = (d: unknown) => (d as Pod).spec.template.spec.containers[0]?.env.map((e) => e.name) ?? [];
    const line = check.get('Deployment/factory/line');
    expect(env(plain.get('Deployment/factory/line'))).toContain('RELEASE_ROLLOUT');
    expect(env(line)).not.toContain('RELEASE_ROLLOUT');
    expect(env(line)).toEqual(env(plain.get('Deployment/factory/line')).filter((e) => e !== 'RELEASE_ROLLOUT'));
  });

  it("points every Application's values from this repository at it, and leaves the app's own repository alone", () => {
    const applications = rendered().filter((d) => d?.kind === 'Application');
    expect(applications.length).toBeGreaterThan(1);
    for (const { metadata, spec } of applications) {
      if (metadata.name === 'website') {
        expect(metadata.labels?.['software-factory/repository']).toBe('app');
        expect(spec.source?.repoURL).toBe('https://github.com/the-roganator/cv-worlds-worst-website.git');
        continue;
      }
      const values = spec.sources?.[1];
      expect(values, metadata.name).toEqual({ repoURL: THIS_REPOSITORY, targetRevision: REVISION, ref: 'values' });
      expect(
        spec.sources?.filter((s) => s.repoURL === THIS_REPOSITORY),
        metadata.name,
      ).toHaveLength(1);
    }
  });
});

const THIS_REPOSITORY = 'https://github.com/the-roganator/cv-software-factory.git';
interface Application {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  spec: { source?: { repoURL: string }; sources?: { repoURL: string; targetRevision: string; ref?: string }[] };
}
