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
  ports: { port: string }[];
  kubeAPI?: unknown;
};

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
});
