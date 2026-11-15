import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { Tools } from '../apps/factory/src/vulnerabilities/scan.ts';
import { clusterImages } from './cluster-images.ts';

/*
 * The platform check's cluster pulls each third-party image it runs from CI's copy in GHCR (deploy/k3d/ci-registries.yaml):
 * scripts/cluster-images.ts lists them, and `scripts/ci-images.sh sync` copies each to the path its registry's rewrite
 * gives, which `ci-images.sh cluster` checks without copying. Here the list is made with stand-ins for Helm and k3s's
 * release, and the check run with stand-ins for the list and skopeo, against this checkout's registries file.
 */

const REGISTRIES = 'deploy/k3d/ci-registries.yaml';
const MIRROR = 'the-roganator/cv-software-factory/mirror/';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tools = (render: (chart: string) => string, list: string) =>
  ({
    render: async (chart: { release: string }) => render(chart.release),
    fetch: async () => list,
  }) as unknown as Tools;

describe('cluster-images.ts', () => {
  it('lists each image a chart renders, k3s lists and a manifest runs, once each, and none in GHCR', async () => {
    const { images, failed } = await clusterImages(
      '.',
      tools(
        (release) =>
          release === 'argocd'
            ? 'image: quay.io/argoproj/argocd:v3.6.1\n  - image: "ecr-public.aws.com/docker/library/redis:8.6.4-alpine"\n'
            : `image: docker.io/grafana/${release}:1.0.0\nimage: ghcr.io/open-feature/flagd:v1\n`,
        '# k3s\ndocker.io/rancher/mirrored-pause:3.10.2\n\ndocker.io/rancher/klipper-lb:v0.4.17\n',
      ),
    );
    expect(failed).toEqual([]);
    expect(images).toContain('quay.io/argoproj/argocd:v3.6.1');
    expect(images).toContain('ecr-public.aws.com/docker/library/redis:8.6.4-alpine');
    expect(images).toContain('docker.io/rancher/mirrored-pause:3.10.2');
    // The manifests' own: Postgres, by its pin.
    expect(images.some((image) => /^postgres:[^@]+@sha256:[0-9a-f]{64}$/.test(image))).toBe(true);
    expect(images.filter((image) => image.startsWith('ghcr.io/'))).toEqual([]);
    expect(new Set(images).size).toBe(images.length);
  });

  it('names a chart that does not render, rather than leave its images out unsaid', async () => {
    const { failed } = await clusterImages(
      '.',
      tools(() => {
        throw new Error('helm: no such chart\nmore');
      }, ''),
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]).toMatch(/: Error: helm: no such chart$/);
  });
});

describe(REGISTRIES, () => {
  const file = parse(readFileSync(REGISTRIES, 'utf-8')) as {
    mirrors: Record<string, { endpoint: string[]; rewrite: Record<string, string> }>;
  };

  it('sends every registry to its own prefix of this repository’s GHCR, and nothing else to anywhere', () => {
    expect(Object.keys(file)).toEqual(['mirrors']);
    const prefixes = Object.entries(file.mirrors).map(([registry, mirror]) => {
      expect(mirror.endpoint, registry).toEqual(['https://ghcr.io']);
      expect(Object.keys(mirror.rewrite), registry).toEqual(['^(.*)$']);
      const to = mirror.rewrite['^(.*)$'] ?? '';
      expect(to, registry).toMatch(new RegExp(`^${MIRROR}[a-z0-9-]+/\\$1$`));
      return to;
    });
    expect(new Set(prefixes).size).toBe(prefixes.length);
    // Docker Hub's official images at the copies check.yml and build.yml pull (scripts/ci-images.sh mirror_of).
    expect(file.mirrors['docker.io']?.rewrite['^(.*)$']).toBe(`${MIRROR}docker/$1`);
  });

  it('is what the platform check makes its cluster with, and the local cluster is not', () => {
    expect(readFileSync('.github/workflows/platform.yml', 'utf-8')).toContain(`REGISTRIES=${REGISTRIES}`);
    expect(readFileSync('Makefile', 'utf-8')).toMatch(/^REGISTRIES \?=$/m);
    expect(readFileSync('deploy/k3d/cluster.yaml', 'utf-8')).not.toMatch(/registries/);
  });
});

describe('ci-images.sh cluster', () => {
  /** The check, with the list and skopeo stood in for: `copied` holds the copies GHCR has, by tag or digest. */
  function check(images: string[], copied: Record<string, string>, upstream: Record<string, string> = {}) {
    const bin = mkdtempSync(join(tmpdir(), 'ci-images-'));
    dirs.push(bin);
    mkdirSync(join(bin, 'data'));
    writeFileSync(join(bin, 'data', 'images'), `${images.join('\n')}\n`);
    writeFileSync(join(bin, 'data', 'manifests'), JSON.stringify({ ...upstream, ...copied }));
    const node = process.execPath;
    // The list, as cluster-images.ts prints it; any other script runs.
    writeFileSync(
      join(bin, 'node'),
      `#!/usr/bin/env bash\nif [ "$1" = scripts/cluster-images.ts ]; then cat "${bin}/data/images"; else exec "${node}" "$@"; fi\n`,
    );
    // `skopeo inspect --raw --no-creds docker://<ref>`: the manifest the stand-in registry holds, or a failure.
    writeFileSync(
      join(bin, 'skopeo'),
      `#!/usr/bin/env bash\nref=\${@: -1}; ref=\${ref#docker://}\njq -er --arg ref "$ref" '.[$ref] // empty' "${bin}/data/manifests"\n`,
    );
    for (const tool of ['node', 'skopeo']) chmodSync(join(bin, tool), 0o755);
    return spawnSync(resolve('scripts/ci-images.sh'), ['cluster'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  }
  const copy = (path: string) => `ghcr.io/${MIRROR}${path}`;
  const digest = `sha256:${'a'.repeat(64)}`;

  it('gives each image the copy containerd asks GHCR for, and says which are there and current', () => {
    const run = check(
      [
        `postgres:18.7-alpine3.24@${digest}`,
        'quay.io/argoproj/argocd:v3.6.1',
        'docker.io/grafana/loki:3.7.10',
        'ecr-public.aws.com/docker/library/redis:8.6.4-alpine',
      ],
      {
        [copy(`docker/library/postgres@${digest}`)]: 'index',
        [copy('quay/argoproj/argocd:v3.6.1')]: 'argocd',
        [copy('docker/grafana/loki:3.7.10')]: 'loki, an older build',
      },
      {
        'quay.io/argoproj/argocd:v3.6.1': 'argocd',
        'docker.io/grafana/loki:3.7.10': 'loki',
        'ecr-public.aws.com/docker/library/redis:8.6.4-alpine': 'redis',
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines[0]).toBe(`${copy(`docker/library/postgres@${digest}`)}: copied already`);
    expect(lines[1]).toMatch(new RegExp(`^${copy('quay/argoproj/argocd:v3.6.1')}: copied already, at sha256:`));
    // A tag that names another digest upstream now is copied again.
    expect(lines[2]).toMatch(
      new RegExp(
        `^${copy('docker/grafana/loki:3.7.10')}: not copied \\(the copy is at sha256:[0-9a-f]+\\), from docker://docker.io/grafana/loki:3.7.10$`,
      ),
    );
    expect(lines[3]).toBe(
      `${copy('ecr-public/docker/library/redis:8.6.4-alpine')}: not copied, from docker://ecr-public.aws.com/docker/library/redis:8.6.4-alpine`,
    );
  });

  it('fails on an image from a registry the file has no copy for, which the cluster would pull from there', () => {
    const run = check(['gcr.io/distroless/static:nonroot'], {});
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      `::error::gcr.io/distroless/static:nonroot: ${REGISTRIES} names no copy for gcr.io, so the platform check pulls it from there`,
    );
  });
});
