import { describe, expect, it } from 'vitest';
import { compare, type Listed, parseReference } from '../../src/patching/compare.ts';
import { type RunningContainer, runningContainers } from '../../src/patching/running.ts';
import type { Kube } from '../../src/runners/kube.ts';
import { APP, APP_SCANNED, agreeing, digest, FACTORY, FACTORY_SCANNED, pod } from './fixtures.ts';

const LISTS: Listed[] = [
  { repository: FACTORY, scanned: FACTORY_SCANNED },
  { repository: APP, scanned: APP_SCANNED },
];

/** A cluster that answers the pod list with these pods, a page at a time. */
function cluster(pages: unknown[][]): Kube & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async get(path, schema) {
      asked.push(path);
      const page = Number(/continue=page-(\d+)/.exec(path)?.[1] ?? 0);
      const more = page + 1 < pages.length ? { continue: `page-${page + 1}` } : {};
      return schema.parse({ metadata: more, items: pages[page] ?? [] });
    },
    text: async () => undefined,
    create: async () => {},
    remove: async () => {},
  };
}

const running = (pods: unknown[]) => runningContainers(cluster([pods]));

describe('a reference', () => {
  it('is read as Docker reads one', () => {
    expect(parseReference(`postgres:17.6@${digest(4)}`)).toEqual({
      repository: 'docker.io/library/postgres',
      tag: '17.6',
      digest: digest(4),
    });
    expect(parseReference('rancher/coredns:1.13')).toEqual({ repository: 'docker.io/rancher/coredns', tag: '1.13' });
    expect(parseReference('localhost:5000/x/y')).toEqual({ repository: 'localhost:5000/x/y' });
    expect(parseReference('ghcr.io/a/b:v1')).toEqual({ repository: 'ghcr.io/a/b', tag: 'v1' });
  });
});

describe("the cluster's pods", () => {
  it('are every container started, by its spec’s image and the digest it runs, across pages', async () => {
    const kube = cluster([
      agreeing().slice(0, 2),
      [...agreeing().slice(2), pod('factory', 'migrate-done', [{ name: 'm', image: 'x', imageID: 'x' }], 'Succeeded')],
    ]);
    const found = await runningContainers(kube);
    expect(kube.asked).toEqual(['/api/v1/pods?limit=500', '/api/v1/pods?limit=500&continue=page-1']);
    expect(found.map((c) => `${c.namespace}/${c.pod}/${c.container}`)).toEqual([
      'factory/line-7d9f-abcde/line',
      'factory/postgres-0/postgres',
      'kube-system/coredns-5f-qq1/coredns',
      'telemetry/grafana-6c-xyz12/sidecar',
      'website/website-abc-1/website',
    ]);
    expect(found[1]).toEqual({
      namespace: 'factory',
      pod: 'postgres-0',
      container: 'postgres',
      image: `postgres:17.6@${digest(4)}`,
      digest: digest(5),
    });
  });

  it('leave out a container not started yet, which has no digest', async () => {
    expect(await running([pod('default', 'pending', [{ name: 'c', image: 'nginx:1' }], 'Pending')])).toEqual([]);
  });
});

describe('the comparison with the list', () => {
  it('makes no row when the cluster runs what the list says, by index digest or a platform’s', async () => {
    expect(compare(await running(agreeing()), LISTS)).toEqual([]);
  });

  it('makes a row of a digest no result names, under a reference the list has', async () => {
    const rebuilt = pod('telemetry', 'loki-sidecar-1', [
      {
        name: 'sidecar',
        image: 'quay.io/example/k8s-sidecar:2.0.0',
        imageID: `quay.io/example/k8s-sidecar@${digest(12)}`,
      },
    ]);
    expect(compare(await running([...agreeing(), rebuilt]), LISTS)).toEqual([
      {
        row: 'unscanned-digest',
        namespace: 'telemetry',
        pod: 'loki-sidecar-1',
        container: 'sidecar',
        image: 'quay.io/example/k8s-sidecar:2.0.0',
        digest: digest(12),
        repository: FACTORY,
        item: 'grafana',
        pin: { file: 'deploy/base/telemetry/values/grafana.yaml', line: 12 },
      },
    ]);
  });

  it('makes a row of an image the list does not have, in any namespace', async () => {
    const stray = pod('default', 'try', [
      { name: 'c', image: 'nginx:1.29', imageID: `docker.io/library/nginx@${digest(13)}` },
    ]);
    expect(compare(await running([...agreeing(), stray]), LISTS)).toEqual([
      {
        row: 'unlisted-image',
        namespace: 'default',
        pod: 'try',
        container: 'c',
        image: 'nginx:1.29',
        digest: digest(13),
      },
    ]);
  });

  it('makes a row of a pin main holds that the cluster does not run yet, and not of what it runs instead', async () => {
    // Argo CD has not deployed the merge: Postgres runs at the old digest, which the list no longer names.
    const pods = agreeing().map((p) =>
      p.metadata.name === 'postgres-0'
        ? pod('factory', 'postgres-0', [
            {
              name: 'postgres',
              image: `postgres:17.5@${digest(14)}`,
              imageID: `docker.io/library/postgres@${digest(14)}`,
            },
          ])
        : p,
    );
    expect(compare(await running(pods), LISTS)).toEqual([
      {
        row: 'not-running',
        repository: FACTORY,
        item: `postgres:17.6@${digest(4)}`,
        image: `postgres:17.6@${digest(4)}`,
        pin: { file: 'deploy/base/postgres/statefulset.yaml', line: 40 },
        running: [
          { namespace: 'factory', pod: 'postgres-0', container: 'postgres', image: `postgres:17.5@${digest(14)}` },
        ],
      },
    ]);
  });

  it('makes no row of a pin whose image runs only now and then, as a runner’s does', async () => {
    const lists: Listed[] = [
      {
        repository: FACTORY,
        scanned: [
          ...FACTORY_SCANNED,
          {
            kind: 'ours',
            item: `ghcr.io/the-roganator/cv-software-factory/factory-runner@${digest(15)}`,
            image: `ghcr.io/the-roganator/cv-software-factory/factory-runner@${digest(15)}`,
            digests: [digest(15)],
            pin: { file: 'deploy/example/images.yaml', line: 23 },
          },
        ],
      },
      { repository: APP, scanned: APP_SCANNED },
    ];
    expect(compare(await running(agreeing()), lists)).toEqual([]);
  });

  it('makes no row of an image no pod of the cluster runs, such as a workflow’s or a build stage’s', async () => {
    const lists: Listed[] = [
      {
        repository: FACTORY,
        scanned: [
          ...FACTORY_SCANNED,
          {
            kind: 'workflow',
            item: 'zap',
            image: `postgres:16@${digest(16)}`,
            digests: [digest(16)],
            pin: { file: 'a', line: 1 },
          },
        ],
      },
      { repository: APP, scanned: APP_SCANNED },
    ];
    expect(compare(await running(agreeing()), lists)).toEqual([]);
  });

  it('gives the same rows, in the same order, whatever order the pods come in', async () => {
    const containers: RunningContainer[] = [
      ...(await running(agreeing())),
      { namespace: 'b', pod: 'p', container: 'c', image: 'nginx:1', digest: digest(13) },
      { namespace: 'a', pod: 'p', container: 'c', image: 'nginx:1', digest: digest(13) },
    ];
    expect(compare([...containers].reverse(), LISTS)).toEqual(compare(containers, LISTS));
    expect(compare(containers, LISTS).map((row) => row.row === 'unlisted-image' && row.namespace)).toEqual(['a', 'b']);
  });

  it('makes a row of a digest no result names when a pod runs the tag alone of a tag-and-digest pin, rebuilt', async () => {
    const lists: Listed[] = [
      {
        repository: FACTORY,
        scanned: [
          ...FACTORY_SCANNED,
          {
            kind: 'third-party',
            item: `nginx:1.29@${digest(20)}`,
            image: `nginx:1.29@${digest(20)}`,
            digests: [digest(20)],
            pin: { file: 'deploy/example/nginx.yaml', line: 3 },
          },
        ],
      },
      { repository: APP, scanned: APP_SCANNED },
    ];
    const rebuilt = pod('default', 'web-1', [
      { name: 'web', image: 'nginx:1.29', imageID: `docker.io/library/nginx@${digest(21)}` },
    ]);
    expect(compare(await running([...agreeing(), rebuilt]), lists)).toEqual([
      {
        row: 'unscanned-digest',
        namespace: 'default',
        pod: 'web-1',
        container: 'web',
        image: 'nginx:1.29',
        digest: digest(21),
        repository: FACTORY,
        item: `nginx:1.29@${digest(20)}`,
        pin: { file: 'deploy/example/nginx.yaml', line: 3 },
      },
    ]);
  });

  it('names the same containers in a not-running row whatever the pods are called', async () => {
    // Twenty-five old references of Postgres in one namespace, more than a row names: which twenty it keeps must not
    // hang on the pods' names, which a rollout makes anew.
    const old = (name: (i: number) => string) =>
      agreeing()
        .filter((p) => p.metadata.name !== 'postgres-0')
        .concat(
          Array.from({ length: 25 }, (_, i) =>
            pod('factory', name(i), [
              {
                name: 'postgres',
                image: `postgres:16.${i}`,
                imageID: `docker.io/library/postgres@${digest(30 + (i % 9))}`,
              },
            ]),
          ),
        );
    const images = (rows: ReturnType<typeof compare>) =>
      rows.flatMap((r) => (r.row === 'not-running' ? r.running.map((c) => c.image) : []));
    const before = images(compare(await running(old((i) => `a-${String(i).padStart(2, '0')}`)), LISTS));
    const after = images(compare(await running(old((i) => `b-${String(24 - i).padStart(2, '0')}`)), LISTS));
    expect(after).toEqual(before);
    expect(before).toHaveLength(20);
  });

  it('fails the whole read when one namespace cannot be listed, and lists the others at once', async () => {
    const asked: string[] = [];
    const kube: Kube = {
      async get(path, schema) {
        asked.push(path);
        if (path.includes('/namespaces/runners/')) throw new Error('GET pods answered 403: forbidden');
        return schema.parse({ items: [] });
      },
      text: async () => undefined,
      create: async () => {},
      remove: async () => {},
    };
    await expect(runningContainers(kube, ['default', 'runners', 'website'])).rejects.toThrow('403');
    expect(asked.sort()).toEqual([
      '/api/v1/namespaces/default/pods?limit=500',
      '/api/v1/namespaces/runners/pods?limit=500',
      '/api/v1/namespaces/website/pods?limit=500',
    ]);
  });
});
