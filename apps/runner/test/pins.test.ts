import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  admits,
  changesManifest,
  compareVersions,
  digestOf,
  type Get,
  lockedVersions,
  type Mise,
  movedRange,
  nodeInImage,
  nodeInTar,
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

  it('leaves a copy on another major the move does not name where it is', async () => {
    // sonic-boom twice: 4.2.1 under pino, and 5.0.1 beside it, which alone has the advisory.
    const twice = (newer: string) =>
      LOCK('5.0.5', '4.2.1').replace(
        '\nsnapshots:',
        `\n  sonic-boom@${newer}:\n    resolution: {integrity: sha512-newer}\n\nsnapshots:`,
      );
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': twice('5.0.1') });
    const { pnpm } = fakePnpm((d) => writeFileSync(join(d, 'pnpm-lock.yaml'), twice('5.0.2')));
    await writePins(dir, { ecosystem: 'npm', name: 'sonic-boom', from: '5.0.1', to: '5.0.2' }, tools(pnpm));
    expect(lockedVersions(read(dir, 'pnpm-lock.yaml'), 'sonic-boom')).toEqual(['4.2.1', '5.0.2']);
  });

  it('takes a 0.x package’s minor as its line: a copy on another minor stays where it is', async () => {
    const twice = (newer: string) =>
      LOCK('5.0.5', '0.5.1').replace(
        '\nsnapshots:',
        `\n  sonic-boom@${newer}:\n    resolution: {integrity: sha512-newer}\n\nsnapshots:`,
      );
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': twice('0.6.2') });
    const { pnpm } = fakePnpm((d) => writeFileSync(join(d, 'pnpm-lock.yaml'), twice('0.6.3')));
    await writePins(dir, { ecosystem: 'npm', name: 'sonic-boom', from: '0.6.2', to: '0.6.3' }, tools(pnpm));
    expect(lockedVersions(read(dir, 'pnpm-lock.yaml'), 'sonic-boom')).toEqual(['0.5.1', '0.6.3']);
  });

  it('refuses a move whose copy the lockfile does not have, though another major’s is there', async () => {
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': LOCK('5.0.5', '4.2.1') });
    const stale = writePins(
      dir,
      { ecosystem: 'npm', name: 'sonic-boom', from: '5.0.1', to: '5.0.2' },
      tools(fakePnpm(() => {}).pnpm),
    );
    await expect(stale).rejects.toThrow('The lockfile has sonic-boom at 4.2.1, not at 5.0.1.');
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

describe('a package at two versions, and a workspace’s own projects (the factory’s moves)', () => {
  const tools = (pnpm: Pnpm, workspace = false) => ({
    pnpm,
    get: noRegistry,
    aside: mkdtempSync(join(tmpdir(), 'aside-')),
    workspace,
  });
  // semver twice: 5.7.1 under one parent, 7.5.1 under another, each with its own fix on its own line.
  const TWICE = (old: string, newer: string) => `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      vitest:
        specifier: ^5.0.5
        version: 5.0.5

packages:

  semver@${old}:
    resolution: {integrity: sha512-old}

  semver@${newer}:
    resolution: {integrity: sha512-new}

  vitest@5.0.5:
    resolution: {integrity: sha512-vitest}

snapshots:

  semver@${old}: {}

  semver@${newer}: {}

  vitest@5.0.5:
    dependencies:
      semver: ${newer}
`;

  it('moves each copy to the target on its line, with one update for both', async () => {
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': TWICE('5.7.1', '7.5.1') });
    const { pnpm, runs } = fakePnpm((d) => writeFileSync(join(d, 'pnpm-lock.yaml'), TWICE('5.7.2', '7.8.6')));
    await writePins(dir, { ecosystem: 'npm', name: 'semver', from: '5.7.1, 7.5.1', to: '5.7.2,7.5.2' }, tools(pnpm));
    // pnpm moved both on the first; the second line's copy is already past its target.
    expect(runs).toEqual([['update', 'semver', '--depth', 'Infinity']]);
    expect(lockedVersions(read(dir, 'pnpm-lock.yaml'), 'semver')).toEqual(['5.7.2', '7.8.6']);
  });

  it('refuses a target with no copy on its line, and one that is not a version', async () => {
    const dir = checkout({ 'package.json': MANIFEST('^5.0.5'), 'pnpm-lock.yaml': TWICE('5.7.1', '7.5.1') });
    const { pnpm, runs } = fakePnpm(() => {});
    await expect(
      writePins(dir, { ecosystem: 'npm', name: 'semver', from: '5.7.1, 7.5.1', to: '6.0.1,7.5.2' }, tools(pnpm)),
    ).rejects.toThrow('semver is at no version on the line of 6.0.1: 5.7.1, 7.5.1.');
    await expect(
      writePins(dir, { ecosystem: 'npm', name: 'semver', from: '5.7.1, 7.5.1', to: '5.7.2,latest' }, tools(pnpm)),
    ).rejects.toThrow('latest is not a version');
    expect(runs).toEqual([]);
  });

  it('takes a workspace’s own projects only where it is told the checkout is its own', async () => {
    const manifest = `${JSON.stringify({ devDependencies: { vitest: '^5.0.5', '@own/testing': 'workspace:*' } }, null, 2)}\n`;
    const lock = LOCK('5.0.5', '4.2.1').replace(
      '        version: 5.0.5\n',
      "        version: 5.0.5\n      '@own/testing':\n        specifier: workspace:*\n        version: link:packages/testing\n",
    );
    const dir = checkout({ 'package.json': manifest, 'pnpm-lock.yaml': lock });
    const { pnpm, runs } = fakePnpm((d) =>
      writeFileSync(
        join(d, 'pnpm-lock.yaml'),
        lock.replaceAll('vitest@5.0.5', 'vitest@5.1.0').replace('version: 5.0.5', 'version: 5.1.0'),
      ),
    );
    const vitest = { ecosystem: 'npm' as const, name: 'vitest', from: '5.0.5', to: '5.1.0' };
    await expect(writePins(dir, vitest, tools(pnpm))).rejects.toThrow(/Only versions from the registry/);
    expect(runs).toEqual([]);
    await writePins(dir, vitest, tools(pnpm, true));
    expect(runs).toHaveLength(1);
    // Never a link out of the tree's own folders, nor an override's workspace.
    expect(registryOnly('        version: link:/etc\n', true)).toEqual(['version: link:/etc']);
    expect(registryRange('workspace:*', true)).toBe(true);
    expect(
      notFromRegistry([{ path: 'package.json', json: { pnpm: { overrides: { a: 'workspace:*' } } } }], true),
    ).toEqual(['package.json: the override of a "workspace:*"']);
  });
});

describe('a tool mise pins (the factory’s moves)', () => {
  const MISE_TOML = '[tools]\nk3d = "5"\nkubectl = "1.37"\n';
  const lockAt = (version: string) =>
    `[[tools.k3d]]\nversion = "${version}"\nbackend = "aqua:k3d-io/k3d"\nspecifiers = ["5"]\n\n[tools.k3d."platforms.linux-x64"]\nchecksum = "sha256:${'a'.repeat(64)}"\nurl = "https://github.com/k3d-io/k3d/releases/download/v${version}/k3d-linux-amd64"\n\n[[tools.kubectl]]\nversion = "1.37.2"\n`;
  const tools = (mise?: Mise) => ({
    pnpm: fakePnpm(() => {}).pnpm,
    get: noRegistry,
    aside: mkdtempSync(join(tmpdir(), 'aside-')),
    ...(mise ? { mise } : {}),
  });

  it('moves its entry’s version, then has mise lock it, for each platform the lockfile keeps', async () => {
    const dir = checkout({ 'mise.toml': MISE_TOML, 'mise.lock': lockAt('5.8.3') });
    const asked: string[][] = [];
    let seen = '';
    const mise: Mise = async (d, args) => {
      asked.push(args);
      seen = read(d, 'mise.lock');
      writeFileSync(join(d, 'mise.lock'), lockAt('5.9.0'));
    };
    await writePins(dir, { ecosystem: 'tool', name: 'k3d', from: '5.8.3', to: '5.9.0' }, tools(mise));
    expect(asked).toEqual([['lock', 'k3d']]);
    // mise was asked with the version moved and its downloads still the old one's, which it writes again.
    expect(seen).toContain('version = "5.9.0"');
    expect(seen).toContain('/v5.8.3/');
    expect(read(dir, 'mise.lock')).toBe(lockAt('5.9.0'));
    expect(read(dir, 'mise.toml')).toBe(MISE_TOML);
  });

  it('writes nothing where the entry pins the target, and refuses outside the range, another from, or with no mise', async () => {
    const dir = checkout({ 'mise.toml': MISE_TOML, 'mise.lock': lockAt('5.9.0') });
    const asked: string[][] = [];
    const mise: Mise = async (_, args) => {
      asked.push(args);
    };
    await writePins(dir, { ecosystem: 'tool', name: 'k3d', from: '5.8.3', to: '5.9.0' }, tools(mise));
    expect(asked).toEqual([]);
    await expect(
      writePins(dir, { ecosystem: 'tool', name: 'k3d', from: '5.9.0', to: '6.0.0' }, tools(mise)),
    ).rejects.toThrow('k3d 6.0.0 is outside the range mise.toml gives it, 5.');
    await expect(
      writePins(dir, { ecosystem: 'tool', name: 'k3d', from: '5.8.0', to: '5.9.1' }, tools(mise)),
    ).rejects.toThrow("mise.lock's k3d is 5.9.0, not 5.8.0.");
    await expect(
      writePins(dir, { ecosystem: 'tool', name: 'k3d', from: '5.9.0', to: '5.9.1' }, tools()),
    ).rejects.toThrow('The pin step runs no mise here');
    await expect(
      writePins(dir, { ecosystem: 'tool', name: 'helm', from: '4.3.1', to: '4.3.2' }, tools(mise)),
    ).rejects.toThrow('mise.lock has no entry for helm.');
    expect(asked).toEqual([]);
  });

  it('waits for mise.toml’s minimum_release_age from the day the tool’s repository published the release', async () => {
    const NOW = Date.parse('2026-11-10T04:30:00Z');
    const urls: string[] = [];
    const get: Get = async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify([
          { tag_name: 'v5.9.1', published_at: '2026-11-09T00:00:00Z' },
          { tag_name: 'v5.9.0', published_at: '2026-11-06T00:00:00Z' },
          { tag_name: '5.9.2', published_at: '2026-11-01T00:00:00Z', draft: true },
        ]),
      );
    };
    const asked: string[][] = [];
    const mise: Mise = async (_, args) => {
      asked.push(args);
    };
    const aged = `[settings]\nminimum_release_age = "3d"\n\n${MISE_TOML}`;
    const move = (to: string, now: number) =>
      writePins(
        checkout({ 'mise.toml': aged, 'mise.lock': lockAt('5.8.3') }),
        { ecosystem: 'tool', name: 'k3d', from: '5.8.3', to },
        { ...tools(mise), get, now },
      );
    // A day old: within the three days, so no move and no mise.
    await expect(move('5.9.1', NOW)).rejects.toThrow(
      "k3d 5.9.1 came out on 2026-11-09T00:00:00Z, within mise.toml's minimum_release_age.",
    );
    // A draft is no release to count from.
    await expect(move('5.9.2', NOW)).rejects.toThrow("k3d 5.9.2 is not a published release of k3d-io/k3d's.");
    expect(asked).toEqual([]);
    expect(urls[0]).toBe('https://api.github.com/repos/k3d-io/k3d/releases?per_page=100');
    // Four days old, and the young one once its three days are up.
    await move('5.9.0', NOW);
    await move('5.9.1', Date.parse('2026-11-12T00:00:00Z'));
    expect(asked).toEqual([
      ['lock', 'k3d'],
      ['lock', 'k3d'],
    ]);
  });

  it('counts a release’s age from the newest upload of its downloads (S2-L3)', async () => {
    // A release published weeks ago whose download was uploaded again a day ago: as young as the upload.
    const get: Get = async () =>
      Response.json([
        {
          tag_name: 'v5.9.0',
          published_at: '2026-10-01T00:00:00Z',
          assets: [
            { name: 'k3d-linux-amd64', updated_at: '2026-10-01T00:05:00Z' },
            { name: 'k3d-darwin-arm64', updated_at: '2026-11-09T00:00:00Z' },
          ],
        },
      ]);
    const asked: string[][] = [];
    const mise: Mise = async (_, args) => {
      asked.push(args);
    };
    const aged = `[settings]\nminimum_release_age = "3d"\n\n${MISE_TOML}`;
    const move = (now: string) =>
      writePins(
        checkout({ 'mise.toml': aged, 'mise.lock': lockAt('5.8.3') }),
        { ecosystem: 'tool', name: 'k3d', from: '5.8.3', to: '5.9.0' },
        { ...tools(mise), get, now: Date.parse(now) },
      );
    await expect(move('2026-11-10T04:30:00Z')).rejects.toThrow(
      "k3d 5.9.0 came out on 2026-11-09T00:00:00Z, within mise.toml's minimum_release_age.",
    );
    expect(asked).toEqual([]);
    await move('2026-11-12T00:00:00Z');
    expect(asked).toEqual([['lock', 'k3d']]);
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

  const RUNTIME = 'gcr.io/distroless/nodejs24-debian13';
  /**
   * The runtime at the digest it gives, running a release: an index, linux on amd64's manifest, a configuration with
   * no NODE_VERSION, two layers, each the bytes its digest names.
   */
  const image = (release: string) => {
    // The last layer holds Node, as distroless's does; the first is never read.
    const layers = [
      gzipSync(tar([['etc/os-release', 'debian']])),
      gzipSync(
        tar([
          ['nodejs/LICENSE', 'MIT'],
          [
            'nodejs/bin/node',
            `\x7fELF…https://nodejs.org/download/release/v${release}/node-v${release}-headers.tar.gz…`,
          ],
        ]),
      ),
    ];
    const config = Buffer.from(JSON.stringify({ config: { Env: ['PATH=/usr/bin'] } }));
    const platform = Buffer.from(
      JSON.stringify({
        config: { digest: sha256(config) },
        layers: layers.map((layer) => ({
          digest: sha256(layer),
          mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        })),
      }),
    );
    const index = Buffer.from(
      JSON.stringify({
        manifests: [
          { digest: `sha256:${'0'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
          { digest: sha256(platform), platform: { os: 'linux', architecture: 'amd64' } },
        ],
      }),
    );
    const base = 'https://gcr.io/v2/distroless/nodejs24-debian13';
    const blobs = new Map<string, Buffer>([
      [`${base}/manifests/${sha256(index)}`, index],
      [`${base}/manifests/${sha256(platform)}`, platform],
      [`${base}/blobs/${sha256(config)}`, config],
      [`${base}/blobs/${sha256(layers[1] as Buffer)}`, layers[1] as Buffer],
    ]);
    const get: Get = async (url, init) => {
      if (url === `${base}/manifests/nonroot`)
        return new Response(null, { headers: { 'docker-content-digest': sha256(index) } });
      const blob = blobs.get(url);
      if (blob) return new Response(new Uint8Array(blob));
      return registries(url, init);
    };
    return { digest: sha256(index), get };
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

  describe('a checkout whose mise.toml pins the target already (S2-L4)', () => {
    const NODE = { ecosystem: 'node' as const, name: 'node', from: '24.22.1', to: '24.22.2' };
    const runtime = image('24.22.2');
    const made = {
      'mise.toml': MISE_TOML.replace('24.22.1', '24.22.2'),
      // As the move from 24.22.1 writes it: each platform's checksum from Node's SHASUMS256.txt.
      'mise.lock': MISE_LOCK('24.22.2', 'a'.repeat(64)).replace(
        `checksum = "sha256:${'a'.repeat(64)}"\nurl = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin`,
        `checksum = "sha256:${'b'.repeat(64)}"\nurl = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin`,
      ),
      Dockerfile: DOCKERFILE.replace('24.22.1', '24.22.2').replace(`sha256:${'2'.repeat(64)}`, runtime.digest),
    };
    const old = image('24.22.1');
    /** The registries, with the runtime at both its digests and Node's image at a third release's tag. */
    const both: Get = async (url, init) => {
      if (url === 'https://registry-1.docker.io/v2/library/node/manifests/24.20.0-alpine3.24')
        return new Response(null, { headers: { 'docker-content-digest': `sha256:${'5'.repeat(64)}` } });
      const answer = await runtime.get(url, init);
      return answer.status === 404 ? old.get(url, init) : answer;
    };
    const pin = (files: Record<string, string>) => {
      const dir = checkout(files);
      const tools = { pnpm: fakePnpm(() => {}).pnpm, get: both, aside: dir, now: Date.parse('2026-11-11') };
      return { dir, written: writePins(dir, NODE, tools) };
    };

    it('writes nothing where every pin is at the target: the move is made', async () => {
      const { dir, written } = pin(made);
      await written;
      for (const [path, text] of Object.entries(made)) expect(read(dir, path)).toBe(text);
    });

    it('writes the pins a lockfile or a Dockerfile still has at the old Node, as the move from it does', async () => {
      // The whole move from 24.22.1, as the first test of Node's move writes it: each Node image at its tag's digest.
      const moved = {
        ...made,
        Dockerfile: `FROM node:24.22.2-alpine3.24@sha256:${'3'.repeat(64)} AS build\nRUN true\nFROM ${RUNTIME}:nonroot@${runtime.digest}\n`,
      };
      for (const files of [
        { ...made, 'mise.lock': MISE_LOCK('24.22.1', 'f'.repeat(64)) },
        { ...made, Dockerfile: made.Dockerfile.replace('node:24.22.2', 'node:24.22.1') },
        { ...made, Dockerfile: made.Dockerfile.replace(runtime.digest, old.digest) },
      ]) {
        const { dir, written } = pin(files);
        await written;
        for (const [path, text] of Object.entries(moved)) expect(read(dir, path)).toBe(text);
      }
    });

    it('refuses, never takes for made, a pin the move leaves behind', async () => {
      const { written } = pin({ ...made, Dockerfile: made.Dockerfile.replace('node:24.22.2', 'node:24.20.0') });
      await expect(written).rejects.toThrow(
        "Node's move to 24.22.2 leaves a pin behind: Dockerfile's node:24.20.0-alpine3.24 runs Node 24.20.0, not 24.22.2.",
      );
    });
  });

  describe('brought by the runtime image’s move (test 10)', () => {
    /** The runtime's move to the image that runs a release. */
    const moveTo = (release: string) => ({
      ecosystem: 'docker' as const,
      name: RUNTIME,
      from: 'nonroot',
      to: `nonroot@${image(release).digest}`,
    });
    const MOVED = image('24.22.2').digest;
    const move = moveTo('24.22.2');
    const files = () => ({
      'mise.toml': MISE_TOML,
      'mise.lock': MISE_LOCK('24.22.1', 'f'.repeat(64)),
      Dockerfile: DOCKERFILE,
    });

    it('moves Node to the release the image at the move’s digest runs, and pins the image at that digest', async () => {
      const dir = checkout(files());
      const tools = {
        pnpm: fakePnpm(() => {}).pnpm,
        get: image('24.22.2').get,
        aside: dir,
        now: Date.parse('2026-11-11'),
      };
      await writePins(dir, move, tools);
      expect(read(dir, 'mise.toml')).toBe(MISE_TOML.replace('24.22.1', '24.22.2'));
      expect(read(dir, 'mise.lock')).toContain('version = "24.22.2"');
      expect(read(dir, 'Dockerfile')).toBe(
        `FROM node:24.22.2-alpine3.24@sha256:${'3'.repeat(64)} AS build\nRUN true\nFROM ${RUNTIME}:nonroot@${MOVED}\n`,
      );
    });

    it('moves the image alone where it runs the Node mise.toml pins', async () => {
      const dir = checkout(files());
      const same = image('24.22.1');
      await writePins(dir, moveTo('24.22.1'), { pnpm: fakePnpm(() => {}).pnpm, get: same.get, aside: dir });
      expect(read(dir, 'mise.toml')).toBe(MISE_TOML);
      expect(read(dir, 'Dockerfile')).toBe(DOCKERFILE.replace(`sha256:${'2'.repeat(64)}`, same.digest));
    });

    it('writes nothing once Node’s move has pinned the image at the move’s digest (test W3)', async () => {
      const done = {
        'mise.toml': MISE_TOML.replace('24.22.1', '24.22.2'),
        'mise.lock': MISE_LOCK('24.22.2', 'a'.repeat(64)),
        Dockerfile: `FROM node:24.22.2-alpine3.24@sha256:${'3'.repeat(64)} AS build\nRUN true\nFROM ${RUNTIME}:nonroot@${MOVED}\n`,
      };
      const dir = checkout(done);
      await writePins(dir, move, { pnpm: fakePnpm(() => {}).pnpm, get: image('24.22.2').get, aside: dir });
      for (const [path, text] of Object.entries(done)) expect(read(dir, path)).toBe(text);
    });

    it('refuses a Node behind mise.toml’s, and one younger than its minimum_release_age, writing nothing', async () => {
      for (const [release, now, why] of [
        ['24.21.0', '2026-11-11', 'runs Node 24.21.0, behind the 24.22.1 mise.toml pins'],
        ['24.22.2', '2026-11-02', 'within mise.toml'],
      ] as const) {
        const dir = checkout(files());
        const tools = { pnpm: fakePnpm(() => {}).pnpm, get: image(release).get, aside: dir, now: Date.parse(now) };
        await expect(writePins(dir, moveTo(release), tools)).rejects.toThrow(why);
        for (const [path, text] of Object.entries(files())) expect(read(dir, path)).toBe(text);
      }
    });
  });
});

describe('the Node an image runs', () => {
  /** Node's own image, as its registry answers: a manifest and a configuration that sets NODE_VERSION. */
  const config = Buffer.from(
    JSON.stringify({ config: { Env: ['PATH=/usr/bin', 'NODE_VERSION=24.22.3', 'YARN_VERSION=1.22.22'] } }),
  );
  const manifest = Buffer.from(JSON.stringify({ config: { digest: sha256(config) }, layers: [] }));
  const nodeImage =
    (asked: string[], answer = config): Get =>
    async (url) => {
      asked.push(url);
      if (url.endsWith(`/manifests/${sha256(manifest)}`)) return new Response(new Uint8Array(manifest));
      if (url.endsWith(`/blobs/${sha256(config)}`)) return new Response(new Uint8Array(answer));
      return new Response(null, { status: 404 });
    };

  it('reads Node’s own images’ NODE_VERSION, with no layer fetched', async () => {
    const asked: string[] = [];
    expect(await nodeInImage('node', sha256(manifest), nodeImage(asked))).toBe('24.22.3');
    expect(asked).toHaveLength(2);
  });

  it('refuses an answer that is not the bytes its digest names (S-L4)', async () => {
    // A registry, or a mirror, that answers the configuration's digest with another release's.
    const other = Buffer.from(JSON.stringify({ config: { Env: ['NODE_VERSION=25.0.0'] } }));
    await expect(nodeInImage('node', sha256(manifest), nodeImage([], other))).rejects.toThrow(
      /answers blobs\/sha256:[0-9a-f]{64} with bytes that are not its digest's/,
    );
    // And a manifest asked for by a digest it is not.
    await expect(
      nodeInImage('node', `sha256:${'1'.repeat(64)}`, async () => new Response(new Uint8Array(manifest))),
    ).rejects.toThrow(/answers manifests\/sha256:1{64} with bytes that are not its digest's/);
  });

  it('reads a tar’s bin/node by its ustar prefix or a GNU long name, plain or gzipped, and nothing else', async () => {
    const binary = 'one\0two https://nodejs.org/download/release/v24.22.3/node-v24.22.3.tar.gz three';
    const long = `${'very/'.repeat(30)}nodejs/bin/node`;
    expect(await nodeInTar(Readable.from([tar([['opt/bin/node', binary]], 'opt')]), false)).toBe('24.22.3');
    expect(await nodeInTar(Readable.from([gzipSync(tar([[long, binary]]))]), true)).toBe('24.22.3');
    // Split across chunks, the URL still reads.
    const whole = tar([['nodejs/bin/node', binary]]);
    const at = whole.indexOf('download/release');
    expect(await nodeInTar(Readable.from([whole.subarray(0, at), whole.subarray(at)]), false)).toBe('24.22.3');
    expect(await nodeInTar(Readable.from([tar([['nodejs/bin/nodejs-helper', binary]])]), false)).toBeUndefined();
  });
});

/** The digest of some bytes, as a registry names them. */
const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** A tar of these files, a GNU long-name entry before any name past 100 bytes, or under a ustar prefix. */
function tar(files: [string, string][], prefix = ''): Buffer {
  const header = (name: string, size: number, type: string) => {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 100), 0, 'utf8');
    block.write(size.toString(8).padStart(11, '0'), 124, 'latin1');
    block.write(type, 156, 'latin1');
    block.write('ustar\0', 257, 'latin1');
    return block;
  };
  const pad = (size: number) => Buffer.alloc((512 - (size % 512)) % 512);
  const blocks: Buffer[] = [];
  for (const [path, text] of files) {
    const body = Buffer.from(text, 'latin1');
    let name = prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
    if (name.length > 100) {
      const long = Buffer.from(`${name}\0`);
      blocks.push(header('././@LongLink', long.length, 'L'), long, pad(long.length));
      name = name.slice(0, 100);
    }
    const head = header(name, body.length, '0');
    if (prefix && path.startsWith(`${prefix}/`)) head.write(prefix, 345, 'utf8');
    blocks.push(head, body, pad(body.length));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

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

  it('moves a pin the scan names by its tag alone, whatever its digest, and no other tag of the image', async () => {
    const to = `sha256:${'5'.repeat(64)}`;
    const get: Get = async () => new Response(null, { headers: { 'docker-content-digest': to } });
    const dir = checkout({
      Dockerfile: `FROM ghcr.io/anchore/syft:v1.54.0@sha256:${'2'.repeat(64)}\n`,
      'older.Dockerfile': `FROM ghcr.io/anchore/syft:v1.53.0@sha256:${'3'.repeat(64)} AS older\n`,
    });
    const move = { ecosystem: 'docker' as const, name: 'ghcr.io/anchore/syft', from: 'v1.54.0', to: `v1.57.1@${to}` };
    await writePins(dir, move, { pnpm: fakePnpm(() => {}).pnpm, get, aside: dir });
    expect(read(dir, 'Dockerfile')).toBe(`FROM ghcr.io/anchore/syft:v1.57.1@${to}\n`);
    expect(read(dir, 'older.Dockerfile')).toBe(`FROM ghcr.io/anchore/syft:v1.53.0@sha256:${'3'.repeat(64)} AS older\n`);
    // A tag no FROM has is refused, as a tag and digest no FROM has is.
    await expect(
      writePins(dir, { ...move, from: 'v1.50.0' }, { pnpm: fakePnpm(() => {}).pnpm, get, aside: dir }),
    ).rejects.toThrow('No FROM pins ghcr.io/anchore/syft at v1.50.0.');
  });

  it('refuses a registry digest that is not a SHA-256’s', async () => {
    const get: Get = async () => new Response(null, { headers: { 'docker-content-digest': 'md5:abc' } });
    await expect(digestOf('node', '24', get)).rejects.toThrow(/gives no SHA-256 digest/);
  });
});

describe('an image one release with a library: Playwright’s (test 6)', () => {
  const IMAGE = 'mcr.microsoft.com/playwright';
  const was = `sha256:${'2'.repeat(64)}`;
  const now = `sha256:${'5'.repeat(64)}`;
  const get: Get = async () => new Response(null, { headers: { 'docker-content-digest': now } });
  const playwrightLock = (version: string) => `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      playwright:
        specifier: ^1.65.0
        version: ${version}

packages:

  playwright-core@${version}:
    resolution: {integrity: sha512-core}

  playwright@${version}:
    resolution: {integrity: sha512-playwright}

snapshots:

  playwright-core@${version}: {}

  playwright@${version}:
    dependencies:
      playwright-core: ${version}
`;
  const files = (version: string) => ({
    'Dockerfile.browser': `FROM node:24.22.2-trixie-slim@sha256:${'1'.repeat(64)} AS node\nFROM ${IMAGE}:v${version}-noble@${was} AS browsers\n`,
    'Dockerfile.dockerignore': '*\n!package.json\n',
    'package.json': `${JSON.stringify({ name: 'factory', devDependencies: { playwright: '^1.65.0' } }, null, 2)}\n`,
    'pnpm-lock.yaml': playwrightLock(version),
  });
  /** pnpm's update to the release named: every copy of the library moves, and the range with it. */
  const updates = (leave?: string) =>
    fakePnpm((dir, args) => {
      const release = args.at(-1)?.split('@').at(-1) ?? '';
      let lock = read(dir, 'pnpm-lock.yaml').replaceAll('1.65.0', release);
      if (leave) lock = lock.replace(`playwright-core@${release}:`, `playwright-core@${leave}:`);
      writeFileSync(join(dir, 'pnpm-lock.yaml'), lock.replace('^1.65.0', `^${release}`));
      writeFileSync(join(dir, 'package.json'), read(dir, 'package.json').replace('^1.65.0', `^${release}`));
    });
  const move = (to: string) => ({
    ecosystem: 'docker' as const,
    name: IMAGE,
    from: 'v1.65.0-noble',
    to: `${to}@${now}`,
  });

  it('moves the image’s FROM, in a Dockerfile.<name>, and its library to the release its tag names', async () => {
    const dir = checkout(files('1.65.0'));
    const { pnpm, runs } = updates();
    await writePins(dir, move('v1.65.1-noble'), { pnpm, get, aside: dir });
    expect(read(dir, 'Dockerfile.browser')).toContain(`FROM ${IMAGE}:v1.65.1-noble@${now} AS browsers`);
    // Node's image beside it is no part of the move.
    expect(read(dir, 'Dockerfile.browser')).toContain(`FROM node:24.22.2-trixie-slim@sha256:${'1'.repeat(64)} AS node`);
    expect(runs).toEqual([
      [
        'update',
        // Only what a manifest names: the rest of the library follows it.
        'playwright@1.65.1',
      ],
    ]);
    expect(lockedVersions(read(dir, 'pnpm-lock.yaml'), 'playwright')).toEqual(['1.65.1']);
    expect(lockedVersions(read(dir, 'pnpm-lock.yaml'), 'playwright-core')).toEqual(['1.65.1']);
    expect(JSON.parse(read(dir, 'package.json')).devDependencies.playwright).toBe('^1.65.1');
  });

  it('runs no pnpm for a move of the digest alone: the library is at the release already', async () => {
    const dir = checkout(files('1.65.0'));
    const { pnpm, runs } = updates();
    await writePins(dir, move('v1.65.0-noble'), { pnpm, get, aside: dir });
    expect(read(dir, 'Dockerfile.browser')).toContain(`FROM ${IMAGE}:v1.65.0-noble@${now} AS browsers`);
    expect(runs).toEqual([]);
    expect(read(dir, 'pnpm-lock.yaml')).toBe(playwrightLock('1.65.0'));
  });

  it('refuses a move whose lockfile keeps a copy of the library at another release, and a tag that names none', async () => {
    const dir = checkout(files('1.65.0'));
    await expect(
      writePins(dir, move('v1.65.1-noble'), { pnpm: updates('1.65.0').pnpm, get, aside: dir }),
    ).rejects.toThrow(
      'mcr.microsoft.com/playwright:v1.65.1-noble is 1.65.1, and the lockfile keeps playwright-core@1.65.0.',
    );
    const other = checkout(files('1.65.0'));
    await expect(writePins(other, move('noble'), { pnpm: updates().pnpm, get, aside: other })).rejects.toThrow(
      /names no release of its library/,
    );
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
