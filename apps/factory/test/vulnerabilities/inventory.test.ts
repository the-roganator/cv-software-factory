import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ciCopy,
  type Item,
  identity,
  inventory,
  isFixture,
  signerOf,
  stages,
  unlisted,
} from '../../src/vulnerabilities/inventory.ts';

/**
 * The list of what is scanned, worked out from a fixture repository that has one of each kind of source, and from this
 * repository: everything either runs or pins is on it, and a pin it does not read is named.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/repo/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const digest = (c: string) => `sha256:${c.repeat(64)}`;

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A git checkout of the fixture, with files changed (a string) or removed (null), every file tracked. */
function checkout(changes: Record<string, string | null> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inventory-'));
  made.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [file, text] of Object.entries(changes)) {
    if (text === null) rmSync(join(dir, file));
    else {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

const where = (item: Item) => `${item.file}:${item.line}`;
const read = (file: string) => readFileSync(join(FIXTURE, file), 'utf-8');

describe('the list of a fixture repository', () => {
  const { items } = inventory(checkout());
  const find = (name: string) => items.find((item) => item.name === name);

  it('has each tracked lockfile', () => {
    expect(items.filter((item) => item.kind === 'lockfile').map(where)).toEqual([
      'packages/tool/pnpm-lock.yaml:1',
      'pnpm-lock.yaml:1',
    ]);
  });

  it('has each image of ours the local overlay pins, at its digest, with the identity that signed it', () => {
    const shop = find(`ghcr.io/example/shop@${digest('1')}`);
    expect(shop).toMatchObject({
      kind: 'ours',
      file: 'deploy/overlays/local/image/kustomization.yaml',
      line: 6,
      signer: 'https://github.com/example/shop/.github/workflows/build.yml@refs/heads/main',
    });
  });

  it('has each third-party image the rendered overlay runs, at the line in deploy/ that pins it', () => {
    expect(find(`quay.io/example/sidecar:1.2.3@${digest('2')}`)).toMatchObject({
      kind: 'third-party',
      file: 'deploy/base/deployment.yaml',
      line: 16,
    });
  });

  it("has each chart an Application installs, at its targetRevision, with its values, and Argo CD's own", () => {
    expect(find('telemetry')).toEqual({
      kind: 'chart',
      name: 'telemetry',
      file: 'deploy/base/chart.yaml',
      line: 14,
      chart: {
        repo: 'https://charts.example.com',
        chart: 'example-chart',
        version: '1.2.3',
        release: 'telemetry',
        values: ['deploy/base/values/chart.yaml'],
      },
    });
    expect(find('argocd')).toEqual({
      kind: 'chart',
      name: 'argocd',
      file: 'Makefile',
      line: 1,
      chart: {
        repo: 'https://argoproj.github.io/argo-helm',
        chart: 'argo-cd',
        version: '9.0.0',
        release: 'argocd',
        values: ['deploy/argocd/values.yaml'],
      },
    });
  });

  it("has k3s's node image, the release whose list of images the scan fetches, and k3d's images at mise.lock's", () => {
    expect(find('rancher/k3s:v1.30.0-k3s1')).toMatchObject({ kind: 'k3s', file: 'deploy/k3d/cluster.yaml', line: 6 });
    expect(find('k3s v1.30.0+k3s1')).toMatchObject({
      kind: 'k3s-release',
      list: 'https://github.com/k3s-io/k3s/releases/download/v1.30.0%2Bk3s1/k3s-images.txt',
    });
    expect(items.filter((item) => item.kind === 'k3d').map((item) => `${item.name} ${where(item)}`)).toEqual([
      'ghcr.io/k3d-io/k3d-proxy:5.8.3 mise.lock:6',
      'ghcr.io/k3d-io/k3d-tools:5.8.3 mise.lock:6',
    ]);
  });

  it('has each Dockerfile stage that names an image, not an earlier stage, the dev container among them', () => {
    expect(items.filter((item) => item.kind === 'dockerfile').map(where)).toEqual([
      '.devcontainer/Dockerfile:1',
      'Dockerfile:1',
      'Dockerfile:4',
    ]);
  });

  it('has each image the workflows start: named in a workflow, pinned under .github/images/, or in a script they run', () => {
    expect(items.filter((item) => item.kind === 'workflow').map(where)).toEqual([
      '.github/images/scanner/Dockerfile:1',
      '.github/workflows/ci.yml:4',
      'apps/console/zap/scan.ts:1',
    ]);
  });

  it('lists an image once, at its first source', () => {
    const sidecar = items.filter((item) => item.image?.startsWith('quay.io/example/sidecar'));
    expect(sidecar.map(where)).toEqual(['deploy/base/deployment.yaml:16']);
    expect(read('.github/workflows/ci.yml')).toContain(`quay.io/example/sidecar:1.2.3@${digest('2')}`);
  });

  it('reads nothing from prose or test fixtures', () => {
    expect(items.some((item) => item.file === 'README.md' || item.file.startsWith('test/'))).toBe(false);
  });

  it('prints it as JSON with --json', () => {
    const json = execFileSync(
      'node',
      [join(ROOT, 'apps/factory/src/vulnerabilities/inventory.ts'), checkout(), '--json'],
      {
        encoding: 'utf-8',
      },
    );
    expect((JSON.parse(json) as Item[]).map((item) => item.name)).toEqual(items.map((item) => item.name));
  });
});

describe('--unlisted', () => {
  it('names nothing in the fixture, whose every pin is on the list', () => {
    expect(unlisted(checkout())).toEqual([]);
  });

  it('names a reference by digest in a file the list does not read', () => {
    const found = unlisted(checkout({ 'scripts/pull.sh': `docker pull ghcr.io/example/other:1@${digest('c')}\n` }));
    expect(found).toEqual([
      {
        file: 'scripts/pull.sh',
        line: 1,
        reference: `ghcr.io/example/other:1@${digest('c')}`,
        why: 'a reference by digest the list does not read',
      },
    ]);
  });

  it('names a FROM the list cannot read', () => {
    const found = unlisted(checkout({ 'tools/Dockerfile': 'ARG BASE\nFROM $BASE\n' }));
    expect(found.map((entry) => `${entry.file}:${entry.line} ${entry.reference}`)).toEqual([
      'tools/Dockerfile:2 $BASE',
    ]);
  });

  it('names an image the overlay runs that no file pins as it is rendered', () => {
    const base = read('deploy/base/kustomization.yaml');
    const found = unlisted(
      checkout({
        'deploy/base/kustomization.yaml': `${base}images:\n  - name: quay.io/example/sidecar\n    newTag: 9.9.9\n    digest: ${digest('d')}\n`,
      }),
    );
    expect(found.map((entry) => entry.reference)).toContain(`quay.io/example/sidecar:9.9.9@${digest('d')}`);
  });

  it('names an Application whose chart is pinned in no file', () => {
    const overlay = read('deploy/overlays/local/kustomization.yaml');
    const patch = `patches:\n  - target: { kind: Application, name: telemetry }\n    patch: |\n      - op: replace\n        path: /spec/sources/0/targetRevision\n        value: 2.0.0\n`;
    const found = unlisted(checkout({ 'deploy/overlays/local/kustomization.yaml': `${overlay}${patch}` }));
    expect(found.map((entry) => `${entry.reference}: ${entry.why}`)).toContain(
      'Application telemetry: its chart is pinned in no file',
    );
  });

  it("leaves out a chart's values, prose and test fixtures, which pin nothing the list does not render or read", () => {
    expect(read('deploy/base/values/chart.yaml')).toContain(digest('3'));
    expect(read('README.md')).toContain(digest('a'));
    expect(read('test/recorded.json')).toContain(digest('b'));
    expect(unlisted(checkout())).toEqual([]);
  });

  it('exits 1 from the command line when it names something, and 0 when not', () => {
    const run = (dir: string) => {
      try {
        execFileSync('node', [join(ROOT, 'apps/factory/src/vulnerabilities/inventory.ts'), '--unlisted', dir], {
          encoding: 'utf-8',
        });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    expect(run(checkout())).toBe(0);
    expect(run(checkout({ 'scripts/pull.sh': `docker pull ghcr.io/example/other:1@${digest('c')}\n` }))).toBe(1);
  });
});

describe('the list of this repository', () => {
  const { items } = inventory(ROOT);
  const kinds = new Set(items.map((item) => item.kind));

  it('has every kind of source', () => {
    expect([...kinds].sort()).toEqual(
      ['chart', 'dockerfile', 'k3d', 'k3s', 'k3s-release', 'lockfile', 'ours', 'third-party', 'workflow'].sort(),
    );
  });

  it("has flagd's image, Trivy's, ZAP's and each image of ours", () => {
    const names = items.map((item) => item.name);
    expect(names).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ghcr\.io\/open-feature\/flagd:/),
        expect.stringMatching(/^ghcr\.io\/aquasecurity\/trivy:/),
        expect.stringMatching(/^ghcr\.io\/zaproxy\/zaproxy:/),
      ]),
    );
    expect(items.filter((item) => item.kind === 'ours').map((item) => item.name.split('@')[0])).toEqual([
      'ghcr.io/the-roganator/cv-software-factory/console',
      'ghcr.io/the-roganator/cv-software-factory/factory',
      'ghcr.io/the-roganator/cv-software-factory/factory-browser',
      'ghcr.io/the-roganator/cv-software-factory/factory-runner',
    ]);
  });

  it("has CI's copy of each image ci-images.sh keeps one of", () => {
    const postgres = items.find((item) => item.name.startsWith('postgres:'));
    expect(postgres?.ci).toMatch(
      /^ghcr\.io\/the-roganator\/cv-software-factory\/mirror\/docker\/library\/postgres@sha256:/,
    );
  });

  it('names no pin it does not read', () => {
    expect(unlisted(ROOT)).toEqual([]);
  });
});

describe('reading a pin', () => {
  it('knows an image by its name and digest, whatever its tag, and by its whole reference when it has no digest', () => {
    expect(identity(`ghcr.io/a/b:1.0@${digest('e')}`)).toBe(`ghcr.io/a/b@${digest('e')}`);
    expect(identity(`localhost:5000/b@${digest('e')}`)).toBe(`localhost:5000/b@${digest('e')}`);
    expect(identity('rancher/k3s:v1.30.0-k3s1')).toBe('rancher/k3s:v1.30.0-k3s1');
  });

  it("names CI's copy of Docker's official images and Playwright's, and of nothing else", () => {
    expect(ciCopy(`node:24-alpine@${digest('e')}`)).toBe(
      `ghcr.io/the-roganator/cv-software-factory/mirror/docker/library/node@${digest('e')}`,
    );
    expect(ciCopy(`mcr.microsoft.com/playwright:v1.0.0-noble@${digest('e')}`)).toBe(
      `ghcr.io/the-roganator/cv-software-factory/mirror/mcr/playwright@${digest('e')}`,
    );
    expect(ciCopy(`nginxinc/nginx-unprivileged:1@${digest('e')}`)).toBeUndefined();
    expect(ciCopy('node:24')).toBeUndefined();
  });

  it("signs an image of ours as build.yml on its repository's main", () => {
    expect(signerOf('ghcr.io/the-roganator/cv-software-factory/console')).toBe(
      'https://github.com/the-roganator/cv-software-factory/.github/workflows/build.yml@refs/heads/main',
    );
    expect(signerOf('quay.io/example/sidecar')).toBeUndefined();
  });

  it('takes a stage that names an earlier one, or scratch, as no image', () => {
    expect(
      stages(['FROM --platform=$BUILDPLATFORM a/b:1 AS Build', 'FROM build', 'FROM scratch', 'from c/d:2']),
    ).toEqual([
      { image: 'a/b:1', line: 1 },
      { image: 'c/d:2', line: 4 },
    ]);
  });

  it('takes prose, tests and their fixtures as pinning nothing', () => {
    expect(['docs/x.md', 'apps/a/test/f.json', 'scripts/x.test.ts', 'a/fixtures/b.yaml'].every(isFixture)).toBe(true);
    expect(['deploy/base/a.yaml', 'scripts/x.ts', 'Dockerfile'].some(isFixture)).toBe(false);
  });
});
