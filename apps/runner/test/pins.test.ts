import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  admits,
  changesManifest,
  compareVersions,
  digestOf,
  type Get,
  lockedVersions,
  movedRange,
  nodeLockMoved,
  notFromRegistry,
  PinsHeld,
  PinsRefused,
  type Pnpm,
  parentsAt,
  registryOf,
  registryOnly,
  registryRange,
  releaseAge,
  writeLockfile,
  writePins,
} from '../src/pins.ts';

/** A checkout git tracks, with these files committed. */
function checkout(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pins-'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd: dir });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '--message', 'base');
  return dir;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');

const LOCK = (vitest: string, sonic: string) => `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      vitest:
        specifier: ^5.0.5
        version: ${vitest}

packages:

  pino@10.4.0:
    resolution: {integrity: sha512-pino}

  sonic-boom@${sonic}:
    resolution: {integrity: sha512-sonic}

  vitest@${vitest}:
    resolution: {integrity: sha512-vitest}

snapshots:

  pino@10.4.0:
    dependencies:
      sonic-boom: ${sonic}

  sonic-boom@${sonic}: {}

  vitest@${vitest}: {}
`;

const MANIFEST = (vitest: string) =>
  `${JSON.stringify({ name: 'shop', dependencies: { pino: '^10.4.0' }, devDependencies: { vitest } }, null, 2)}\n`;

/** pnpm as a test has it: what each run does to the checkout, and the arguments it was given. */
function fakePnpm(run: (dir: string, args: string[]) => void): { pnpm: Pnpm; runs: string[][] } {
  const runs: string[][] = [];
  return {
    runs,
    pnpm: async (dir, args) => {
      runs.push(args);
      run(dir, args);
    },
  };
}

const noRegistry: Get = async () => {
  throw new Error('no registry in a test that needs none');
};

describe('what the pin step takes as a version from the registry', () => {
  it('takes ranges of versions, and nothing else', () => {
    for (const spec of ['1.2.3', '^1.2.3', '~1.2', '>=1.0.0 <2', '1.x || ^2.0.0', '*', '^5.0.0-beta.1']) {
      expect(registryRange(spec), spec).toBe(true);
    }
    for (const spec of [
      'npm:other@1.0.0',
      'file:../shop',
      'link:../shop',
      'git+https://github.com/a/b.git',
      'github:a/b',
      'https://example.com/a.tgz',
      'workspace:*',
      'latest',
      '1.2.3 - 2.0.0',
      '',
    ]) {
      expect(registryRange(spec), spec).toBe(false);
    }
  });

  it('names each dependency and override of a manifest that is not', () => {
    const json = {
      dependencies: { pino: '^10.4.0', evil: 'https://example.com/evil.tgz' },
      devDependencies: { alias: 'npm:vitest@5.0.5' },
      pnpm: { overrides: { 'sonic-boom': 'file:../sonic' } },
    };
    expect(notFromRegistry([{ path: 'package.json', json }])).toEqual([
      'package.json: evil "https://example.com/evil.tgz"',
      'package.json: alias "npm:vitest@5.0.5"',
      'package.json: the override of sonic-boom "file:../sonic"',
    ]);
  });

  it('names each lockfile line that resolves something but a registry package', () => {
    const lock = `${LOCK('5.0.5', '4.2.1')}
  evil@1.0.0:
    resolution: {tarball: https://example.com/evil.tgz}

  git-thing@1.0.0:
    resolution: {commit: abc, repo: https://github.com/a/b.git, type: git}
`;
    expect(registryOnly(LOCK('5.0.5', '4.2.1'))).toEqual([]);
    expect(registryOnly(lock)).toEqual([
      'resolution: {tarball: https://example.com/evil.tgz}',
      'resolution: {commit: abc, repo: https://github.com/a/b.git, type: git}',
    ]);
    expect(
      registryOnly('importers:\n  .:\n    dependencies:\n      shop:\n        specifier: file:../shop\n'),
    ).toHaveLength(1);
  });
});

describe('a package’s range', () => {
  it('admits a version as ^, ~ and an exact version do', () => {
    expect(admits('^5.0.5', '5.1.0')).toBe(true);
    expect(admits('^5.0.5', '6.0.0')).toBe(false);
    expect(admits('^0.18.0', '0.18.4')).toBe(true);
    expect(admits('^0.18.0', '0.19.0')).toBe(false);
    expect(admits('~1.14.4', '1.14.9')).toBe(true);
    expect(admits('~1.14.4', '1.15.0')).toBe(false);
    expect(admits('5.0.5', '5.0.5')).toBe(true);
    expect(admits('5.0.5', '5.0.6')).toBe(false);
    expect(() => admits('>=5', '5.1.0')).toThrow(PinsRefused);
  });

  it('moves to the target with its operator kept, so it never admits a major the target does not need', () => {
    expect(movedRange('^24.19.2', '25.0.1')).toBe('^25.0.1');
    expect(movedRange('~1.14.4', '1.15.2')).toBe('~1.15.2');
    expect(movedRange('5.0.5', '5.1.0')).toBe('5.1.0');
  });
});

describe('a package’s move', () => {
  const tools = (pnpm: Pnpm) => ({ pnpm, get: noRegistry, aside: mkdtempSync(join(tmpdir(), 'aside-')) });

  it('runs pnpm update at every depth, with no scripts, when the range admits the target', async () => {
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
    const { pnpm, runs } = fakePnpm((d) => writeFileSync(join(d, 'pnpm-lock.yaml'), LOCK('5.1.0', '4.2.1')));
    await writePins(dir, { ecosystem: 'npm', name: 'vitest', from: '5.0.5', to: '5.1.0' }, tools(pnpm));
    expect(runs).toEqual([['update', 'vitest', '--depth', 'Infinity']]);
    // The range admitted it, so it is as it was: pnpm's own update moves it, as the app's own would.
    expect(JSON.parse(read(dir, 'package.json')).devDependencies.vitest).toBe('^5.0.5');
  });

  it('moves the range first when it does not admit the target', async () => {
    const dir = checkout({ 'package.json': MANIFEST('~5.0.5'), 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
    let range = '';
    const { pnpm } = fakePnpm((d) => {
      range = JSON.parse(read(d, 'package.json')).devDependencies.vitest;
      writeFileSync(join(d, 'pnpm-lock.yaml'), LOCK('5.1.0', '4.2.1'));
    });
    await writePins(dir, { ecosystem: 'npm', name: 'vitest', from: '5.0.5', to: '5.1.0' }, tools(pnpm));
    expect(range).toBe('~5.1.0');
  });

  it('holds for Martin when a parent’s range admits no fix: an override is his, in pnpm-workspace.yaml', async () => {
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
    // pnpm finds nothing pino admits: the lockfile is as it was.
    const { pnpm } = fakePnpm(() => {});
    const held = writePins(dir, { ecosystem: 'npm', name: 'sonic-boom', from: '4.2.1', to: '5.0.2' }, tools(pnpm));
    await expect(held).rejects.toBeInstanceOf(PinsHeld);
    await expect(held).rejects.toMatchObject({
      path: 'pnpm-workspace.yaml',
      message: 'sonic-boom stays at 4.2.1: pino@10.4.0 admit no 5.0.2, so it needs an override in pnpm-workspace.yaml',
    });
  });

  it('writes nothing for a move already made, and refuses one the lockfile does not have', async () => {
    const dir = checkout({ 'package.json': MANIFEST('^5.1.0'), 'pnpm-lock.yaml': LOCK('5.1.0', '4.2.1') });
    const { pnpm, runs } = fakePnpm(() => {});
    await writePins(dir, { ecosystem: 'npm', name: 'vitest', from: '5.0.5', to: '5.1.0' }, tools(pnpm));
    expect(runs).toEqual([]);
    await expect(
      writePins(dir, { ecosystem: 'npm', name: 'vitest', from: '4.0.0', to: '5.2.0' }, tools(pnpm)),
    ).rejects.toThrow('The lockfile has vitest at 5.1.0, not at 4.0.0.');
    await expect(
      writePins(dir, { ecosystem: 'npm', name: 'left-pad', from: '1.0.0', to: '1.1.0' }, tools(pnpm)),
    ).rejects.toThrow('The lockfile resolves no left-pad.');
  });

  it('refuses a checkout that names a tarball, before pnpm runs', async () => {
    const manifest = JSON.stringify({
      dependencies: { evil: 'https://example.com/evil.tgz' },
      devDependencies: { vitest: '^5.0.5' },
    });
    const dir = checkout({ 'package.json': manifest, 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
    const { pnpm, runs } = fakePnpm(() => {});
    await expect(
      writePins(dir, { ecosystem: 'npm', name: 'vitest', from: '5.0.5', to: '5.1.0' }, tools(pnpm)),
    ).rejects.toThrow(/Only versions from the registry are pinned/);
    expect(runs).toEqual([]);
  });

  it('runs pnpm with the checkout’s own .npmrc moved aside, and puts it back', async () => {
    const dir = checkout({
      'package.json': MANIFEST('^5.0.5'),
      'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1'),
      '.npmrc': 'registry=https://example.com/\n',
    });
    let seen: boolean | undefined;
    const { pnpm } = fakePnpm((d) => {
      seen = (() => {
        try {
          return Boolean(read(d, '.npmrc'));
        } catch {
          return false;
        }
      })();
      writeFileSync(join(d, 'pnpm-lock.yaml'), LOCK('5.1.0', '4.2.1'));
    });
    await writePins(dir, { ecosystem: 'npm', name: 'vitest', from: '5.0.5', to: '5.1.0' }, tools(pnpm));
    expect(seen).toBe(false);
    expect(read(dir, '.npmrc')).toBe('registry=https://example.com/\n');
  });

  it('reads the versions and parents a lockfile gives a package', () => {
    expect(lockedVersions(LOCK('5.0.5', '4.2.1'), 'sonic-boom')).toEqual(['4.2.1']);
    expect(parentsAt(LOCK('5.0.5', '4.2.1'), 'sonic-boom', '4.2.1')).toEqual(['pino@10.4.0']);
  });
});

describe('Node’s move', () => {
  const MISE_TOML = '[settings]\nminimum_release_age = "3d"\n\n[tools]\nnode = "24.22.1"\npnpm = "12"\n';
  const MISE_LOCK = (version: string, sum: string) =>
    `[[tools.node]]\nversion = "${version}"\nbackend = "core:node"\nspecifiers = ["${version}"]\n\n[tools.node."platforms.linux-x64"]\nchecksum = "sha256:${sum}"\nurl = "https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.gz"\n\n[tools.node."platforms.macos-arm64"]\nchecksum = "sha256:${sum}"\nurl = "https://nodejs.org/dist/v${version}/node-v${version}-darwin-arm64.tar.gz"\n\n[[tools.pnpm]]\nversion = "12.16.1"\n`;
  const DOCKERFILE = `FROM node:24.22.1-alpine3.24@sha256:${'1'.repeat(64)} AS build\nRUN true\nFROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:${'2'.repeat(64)}\n`;
  const SUMS = `${'a'.repeat(64)}  node-v24.22.2-linux-x64.tar.gz\n${'b'.repeat(64)}  node-v24.22.2-darwin-arm64.tar.gz\n`;

  /** nodejs.org, Docker Hub and gcr.io, as far as the step reads them. */
  const registries: Get = async (url, init) => {
    if (url === 'https://nodejs.org/dist/index.json')
      return Response.json([
        { version: 'v24.22.2', date: '2026-11-01' },
        { version: 'v24.22.1', date: '2026-10-01' },
      ]);
    if (url === 'https://nodejs.org/dist/v24.22.2/SHASUMS256.txt') return new Response(SUMS);
    if (url.startsWith('https://auth.docker.io/token')) return Response.json({ token: 'anonymous' });
    if (url === 'https://registry-1.docker.io/v2/library/node/manifests/24.22.2-alpine3.24') {
      const auth = new Headers(init?.headers).get('authorization');
      if (!auth)
        return new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' },
        });
      return new Response(null, { headers: { 'docker-content-digest': `sha256:${'3'.repeat(64)}` } });
    }
    if (url === 'https://gcr.io/v2/distroless/nodejs24-debian13/manifests/nonroot')
      return new Response(null, { headers: { 'docker-content-digest': `sha256:${'4'.repeat(64)}` } });
    return new Response(null, { status: 404 });
  };

  it('moves mise.toml, mise.lock with each platform’s checksum, and each FROM of a Node image to its digest', async () => {
    const dir = checkout({
      'mise.toml': MISE_TOML,
      'mise.lock': MISE_LOCK('24.22.1', 'f'.repeat(64)),
      Dockerfile: DOCKERFILE,
    });
    const tools = { pnpm: fakePnpm(() => {}).pnpm, get: registries, aside: dir, now: Date.parse('2026-11-11') };
    await writePins(dir, { ecosystem: 'node', name: 'node', from: '24.22.1', to: '24.22.2' }, tools);
    expect(read(dir, 'mise.toml')).toBe(MISE_TOML.replace('24.22.1', '24.22.2'));
    expect(read(dir, 'mise.lock')).toBe(
      MISE_LOCK('24.22.2', 'a'.repeat(64)).replace(
        `checksum = "sha256:${'a'.repeat(64)}"\nurl = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin`,
        `checksum = "sha256:${'b'.repeat(64)}"\nurl = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin`,
      ),
    );
    expect(read(dir, 'Dockerfile')).toBe(
      `FROM node:24.22.2-alpine3.24@sha256:${'3'.repeat(64)} AS build\nRUN true\nFROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:${'4'.repeat(64)}\n`,
    );
  });

  it('refuses a release younger than mise.toml’s minimum_release_age, and one nodejs.org does not have', async () => {
    const dir = checkout({
      'mise.toml': MISE_TOML,
      'mise.lock': MISE_LOCK('24.22.1', 'f'.repeat(64)),
      Dockerfile: DOCKERFILE,
    });
    const tools = { pnpm: fakePnpm(() => {}).pnpm, get: registries, aside: dir, now: Date.parse('2026-11-02') };
    await expect(
      writePins(dir, { ecosystem: 'node', name: 'node', from: '24.22.1', to: '24.22.2' }, tools),
    ).rejects.toThrow('within mise.toml’s minimum_release_age'.replace('’', "'"));
    await expect(
      writePins(dir, { ecosystem: 'node', name: 'node', from: '24.22.1', to: '24.99.0' }, tools),
    ).rejects.toThrow('Node 24.99.0 is not a release of nodejs.org');
    expect(read(dir, 'mise.toml')).toBe(MISE_TOML);
  });

  it('refuses a move whose from is not what mise.toml pins', async () => {
    const dir = checkout({
      'mise.toml': MISE_TOML,
      'mise.lock': MISE_LOCK('24.22.1', 'f'.repeat(64)),
      Dockerfile: DOCKERFILE,
    });
    const tools = { pnpm: fakePnpm(() => {}).pnpm, get: registries, aside: dir };
    await expect(
      writePins(dir, { ecosystem: 'node', name: 'node', from: '24.21.0', to: '24.22.2' }, tools),
    ).rejects.toThrow('mise.toml does not pin node at 24.21.0.');
  });

  it('refuses mise.lock’s entry when the release has no checksum for one of its platforms', () => {
    expect(() =>
      nodeLockMoved(MISE_LOCK('24.22.1', 'f'.repeat(64)), '24.22.1', '24.22.2', new Map([['x', 'y']])),
    ).toThrow(/has no checksum for node-v24.22.2-linux-x64.tar.gz/);
  });

  it('reads mise’s release age', () => {
    expect(releaseAge(MISE_TOML)).toBe(3 * 86_400_000);
    expect(releaseAge('[settings]\n')).toBe(0);
  });
});

describe('a base image’s move', () => {
  it('takes the digest only from the registry, and refuses a target the registry does not have at that tag', async () => {
    const get: Get = async () =>
      new Response(null, { headers: { 'docker-content-digest': `sha256:${'5'.repeat(64)}` } });
    expect(await digestOf('gcr.io/distroless/nodejs24-debian13', 'nonroot', get)).toBe(`sha256:${'5'.repeat(64)}`);
    const dir = checkout({ Dockerfile: `FROM gcr.io/distroless/static:nonroot@sha256:${'2'.repeat(64)}\n` });
    const move = {
      ecosystem: 'docker' as const,
      name: 'gcr.io/distroless/static',
      from: `nonroot@sha256:${'2'.repeat(64)}`,
      to: `nonroot@sha256:${'6'.repeat(64)}`,
    };
    await expect(writePins(dir, move, { pnpm: fakePnpm(() => {}).pnpm, get, aside: dir })).rejects.toThrow(
      /is sha256:5{64} in its registry/,
    );
    await writePins(
      dir,
      { ...move, to: `nonroot@sha256:${'5'.repeat(64)}` },
      { pnpm: fakePnpm(() => {}).pnpm, get, aside: dir },
    );
    expect(read(dir, 'Dockerfile')).toBe(`FROM gcr.io/distroless/static:nonroot@sha256:${'5'.repeat(64)}\n`);
  });

  it('refuses a registry digest that is not a SHA-256’s', async () => {
    const get: Get = async () => new Response(null, { headers: { 'docker-content-digest': 'md5:abc' } });
    await expect(digestOf('node', '24', get)).rejects.toThrow(/gives no SHA-256 digest/);
  });
});

describe('the lockfile after a coder’s step', () => {
  const tools = (pnpm: Pnpm) => ({ pnpm, get: noRegistry, aside: mkdtempSync(join(tmpdir(), 'aside-')) });
  /** The coder's change of vitest's range, as `git diff` writes it. */
  const change = (before: string, after: string) => {
    const dir = checkout({ 'package.json': MANIFEST(before) });
    writeFileSync(join(dir, 'package.json'), MANIFEST(after));
    return execFileSync('git', ['diff'], { cwd: dir, encoding: 'utf8' });
  };

  it('runs pnpm install for the lockfile alone on the coder’s manifests', async () => {
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
    const { pnpm, runs } = fakePnpm((d) => writeFileSync(join(d, 'pnpm-lock.yaml'), LOCK('5.1.0', '4.2.1')));
    expect(changesManifest(change('^5.0.5', '^5.1.0'))).toBe(true);
    // As the prepare step leaves a checkout: every file given the seed's time, which the index has not seen.
    const at = new Date('2026-01-01T00:00:00Z');
    for (const file of ['package.json', 'pnpm-lock.yaml']) utimesSync(join(dir, file), at, at);
    await writeLockfile(dir, change('^5.0.5', '^5.1.0'), tools(pnpm));
    expect(runs).toEqual([['install']]);
    expect(read(dir, 'pnpm-lock.yaml')).toBe(LOCK('5.1.0', '4.2.1'));
  });

  it('refuses a change that names a tarball, an alias or a git source, before pnpm runs', async () => {
    for (const spec of ['https://example.com/vitest.tgz', 'npm:evil@1.0.0', 'github:evil/vitest']) {
      const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
      const { pnpm, runs } = fakePnpm(() => {});
      await expect(writeLockfile(dir, change('^5.0.5', spec), tools(pnpm))).rejects.toThrow(
        /Only versions from the registry are pinned/,
      );
      expect(runs).toEqual([]);
    }
  });

  it('refuses a change to a lockfile or pnpm’s settings, and one that moves an override', async () => {
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
    const lock =
      'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-x\n+y\n';
    await expect(writeLockfile(dir, lock, tools(fakePnpm(() => {}).pnpm))).rejects.toThrow(
      /pnpm-lock\.yaml, which only/,
    );
    const npmrc =
      'diff --git a/.npmrc b/.npmrc\nnew file mode 100644\n--- /dev/null\n+++ b/.npmrc\n@@ -0,0 +1 @@\n+x=1\n';
    await expect(writeLockfile(dir, npmrc, tools(fakePnpm(() => {}).pnpm))).rejects.toThrow(/\.npmrc/);
    const overrides = `diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1,2 +1,3 @@\n {\n+  "pnpm": { "overrides": { "pino": "10.4.0" } },\n   "name": "shop",\n`;
    await expect(writeLockfile(dir, overrides, tools(fakePnpm(() => {}).pnpm))).rejects.toThrow(
      /moves pnpm in package\.json, which overrides how pnpm resolves/,
    );
  });

  it('refuses the lockfile pnpm wrote when it resolves anything but the registry’s packages', async () => {
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
    const { pnpm } = fakePnpm((d) =>
      writeFileSync(
        join(d, 'pnpm-lock.yaml'),
        `${LOCK('5.1.0', '4.2.1')}\n  x@1.0.0:\n    resolution: {tarball: https://example.com/x.tgz}\n`,
      ),
    );
    await expect(writeLockfile(dir, change('^5.0.5', '^5.1.0'), tools(pnpm))).rejects.toThrow(
      /resolves something not from the registry/,
    );
  });
});

describe('what the review sent back', () => {
  const tools = (pnpm: Pnpm, get: Get = noRegistry) => ({ pnpm, get, aside: mkdtempSync(join(tmpdir(), 'aside-')) });

  it('orders pre-releases as semver does, identifier by identifier', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc-1', '1.0.0-rc-2')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });

  it('leaves a peer’s range alone, whatever shape it has: it pins nothing', async () => {
    const manifest = `${JSON.stringify({ devDependencies: { vitest: '^5.0.5' }, peerDependencies: { vitest: '>=4 || ^5' } }, null, 2)}\n`;
    const dir = checkout({ 'package.json': manifest, 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
    const { pnpm } = fakePnpm((d) => writeFileSync(join(d, 'pnpm-lock.yaml'), LOCK('5.1.0', '4.2.1')));
    await writePins(dir, { ecosystem: 'npm', name: 'vitest', from: '5.0.5', to: '5.1.0' }, tools(pnpm));
    expect(read(dir, 'package.json')).toBe(manifest);
  });

  it('updates every project of a workspace', async () => {
    const dir = checkout({
      'package.json': MANIFEST('^5.0.5'),
      'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1'),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
    });
    const { pnpm, runs } = fakePnpm((d) => writeFileSync(join(d, 'pnpm-lock.yaml'), LOCK('5.1.0', '4.2.1')));
    await writePins(dir, { ecosystem: 'npm', name: 'vitest', from: '5.0.5', to: '5.1.0' }, tools(pnpm));
    expect(runs).toEqual([['update', '--recursive', 'vitest', '--depth', 'Infinity']]);
  });

  it('refuses a manifest the coder’s change adds that names a tarball, before pnpm runs', async () => {
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
    const added = `diff --git a/apps/x/package.json b/apps/x/package.json\nnew file mode 100644\n--- /dev/null\n+++ b/apps/x/package.json\n@@ -0,0 +1 @@\n+{"dependencies":{"evil":"https://example.com/evil.tgz"}}\n`;
    const { pnpm, runs } = fakePnpm(() => {});
    await expect(writeLockfile(dir, added, tools(pnpm))).rejects.toThrow(/apps\/x\/package\.json: evil/);
    expect(runs).toEqual([]);
  });

  it('asks Docker Hub’s API for an image named by docker.io', () => {
    expect(registryOf('docker.io/library/node')).toEqual({ host: 'registry-1.docker.io', repository: 'library/node' });
    expect(registryOf('docker.io/node')).toEqual({ host: 'registry-1.docker.io', repository: 'library/node' });
    expect(registryOf('index.docker.io/bitnami/redis')).toEqual({
      host: 'registry-1.docker.io',
      repository: 'bitnami/redis',
    });
    expect(registryOf('node')).toEqual({ host: 'registry-1.docker.io', repository: 'library/node' });
    expect(registryOf('gcr.io/distroless/static')).toEqual({ host: 'gcr.io', repository: 'distroless/static' });
  });

  it('pins a base image to the digest it checked, asking its registry once for every line', async () => {
    const OLD = `sha256:${'1'.repeat(64)}`;
    const NEW = `sha256:${'2'.repeat(64)}`;
    const dir = checkout({
      Dockerfile: `FROM gcr.io/distroless/static:nonroot@${OLD}\nFROM gcr.io/distroless/static:nonroot@${OLD} AS two\n`,
    });
    let asked = 0;
    // A tag that moves on after the first answer.
    const get: Get = async () => {
      asked++;
      return new Response(null, {
        headers: { 'docker-content-digest': asked === 1 ? NEW : `sha256:${'9'.repeat(64)}` },
      });
    };
    const move = {
      ecosystem: 'docker' as const,
      name: 'gcr.io/distroless/static',
      from: `nonroot@${OLD}`,
      to: `nonroot@${NEW}`,
    };
    await writePins(dir, move, tools(fakePnpm(() => {}).pnpm, get));
    expect(asked).toBe(1);
    expect(read(dir, 'Dockerfile')).toBe(
      `FROM gcr.io/distroless/static:nonroot@${NEW}\nFROM gcr.io/distroless/static:nonroot@${NEW} AS two\n`,
    );
  });

  it('refuses a change to pnpm’s settings that git applies under a header the paths are not read from', async () => {
    const dir = checkout({
      'package.json': MANIFEST('^5.0.5'),
      'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1'),
      'pnpm-workspace.yaml': 'trustPolicy: no-downgrade\n',
    });
    const range = checkout({ 'package.json': MANIFEST('^5.0.5') });
    writeFileSync(join(range, 'package.json'), MANIFEST('^5.1.0'));
    const moved = execFileSync('git', ['diff'], { cwd: range, encoding: 'utf8' });
    // A plain block, with no `diff --git` header to name its file.
    const hidden = `${moved}--- a/pnpm-workspace.yaml\n+++ b/pnpm-workspace.yaml\n@@ -1 +1,2 @@\n trustPolicy: no-downgrade\n+overrides: { vitest: 'https://example.com/v.tgz' }\n`;
    const { pnpm, runs } = fakePnpm(() => {});
    await expect(writeLockfile(dir, hidden, tools(pnpm))).rejects.toThrow(/pnpm-workspace\.yaml, which only/);
    expect(runs).toEqual([]);
  });
});
