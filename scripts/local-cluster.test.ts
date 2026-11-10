import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
