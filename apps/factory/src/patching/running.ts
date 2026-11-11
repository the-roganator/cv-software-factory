/**
 * What the cluster runs, as the dependency sense reads it: every container of every pod in the namespaces it is given,
 * or in every namespace when it is given none (on a host, through `kubectl proxy`), by the image its spec names and the
 * digest its runtime resolved. In the cluster its account may list pods in each namespace but three, and do nothing
 * else (deploy/base/patching-reads-pods).
 *
 * A pod that has finished (`Succeeded`, `Failed`) runs nothing, and a container not started yet has no digest: neither
 * is read. An init container that ran is read: it ran that image.
 */
import { z } from 'zod';
import type { Kube } from '../runners/kube.ts';

/** One container the cluster runs. */
export interface RunningContainer {
  namespace: string;
  pod: string;
  container: string;
  /** The image as the pod's spec names it. */
  image: string;
  /** The digest the runtime resolved it to: `sha256:…`, an index's or a platform's manifest's. */
  digest: string;
}

const STATUS = z.object({
  name: z.string(),
  image: z.string(),
  imageID: z.string().optional(),
});

const PODS = z.object({
  metadata: z.object({ continue: z.string().optional() }).optional(),
  items: z.array(
    z.object({
      metadata: z.object({ name: z.string(), namespace: z.string() }),
      spec: z.object({
        containers: z.array(z.object({ name: z.string(), image: z.string() })),
        initContainers: z.array(z.object({ name: z.string(), image: z.string() })).optional(),
      }),
      status: z
        .object({
          phase: z.string().optional(),
          containerStatuses: z.array(STATUS).optional(),
          initContainerStatuses: z.array(STATUS).optional(),
        })
        .optional(),
    }),
  ),
});

/** The pods asked for a page at a time, and the most pages read: far beyond a laptop's cluster. */
const PAGE = 500;
const MAX_PAGES = 40;

const DIGEST = /sha256:[0-9a-f]{64}$/;

/** The digest an `imageID` carries: `docker.io/library/postgres@sha256:…`, or a bare `sha256:…`. */
export function digestOf(imageID: string | undefined): string | undefined {
  return imageID ? DIGEST.exec(imageID)?.[0] : undefined;
}

/** Every container running in the namespaces given, or in every one, in order of namespace, pod and container. */
export async function runningContainers(kube: Kube, namespaces?: readonly string[]): Promise<RunningContainer[]> {
  const found: RunningContainer[] = [];
  for (const namespace of namespaces ?? [undefined]) await listPods(kube, namespace, found);
  return found.sort(
    (a, b) =>
      a.namespace.localeCompare(b.namespace) || a.pod.localeCompare(b.pod) || a.container.localeCompare(b.container),
  );
}

async function listPods(kube: Kube, namespace: string | undefined, found: RunningContainer[]): Promise<void> {
  const base = namespace ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods` : '/api/v1/pods';
  let next: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = `limit=${PAGE}${next ? `&continue=${encodeURIComponent(next)}` : ''}`;
    const list = await kube.get(`${base}?${query}`, PODS);
    if (!list) throw new Error(`The Kubernetes API has no pods to list${namespace ? ` in ${namespace}` : ''}`);
    for (const pod of list.items) {
      if (pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed') continue;
      const specs = [...pod.spec.containers, ...(pod.spec.initContainers ?? [])];
      for (const status of [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])]) {
        const digest = digestOf(status.imageID);
        if (!digest) continue;
        found.push({
          namespace: pod.metadata.namespace,
          pod: pod.metadata.name,
          container: status.name,
          // The spec's reference, not the status's, which the runtime may have rewritten to what it pulled.
          image: specs.find((spec) => spec.name === status.name)?.image ?? status.image,
          digest,
        });
      }
    }
    next = list.metadata?.continue || undefined;
    if (!next) return;
  }
  throw new Error(`More than ${PAGE * MAX_PAGES} pods${namespace ? ` in ${namespace}` : ''}: the sense reads no more`);
}
