import { describe, expect, it } from 'vitest';
import {
  CORRELATOR,
  compare,
  fromPurl,
  packageId,
  relationships,
  type Snapshot,
  snapshot,
  syftPin,
} from '../../src/vulnerabilities/graph.ts';

const digest = `sha256:${'0'.repeat(64)}`;

/** A pnpm 11+ lockfile's two documents: pnpm itself, then the project. */
const env = {
  lockfileVersion: '9.0',
  importers: { '.': { packageManagerDependencies: { pnpm: { specifier: '12.0.0', version: '12.0.0' } } } },
  snapshots: { 'pnpm@12.0.0': { optionalDependencies: { '@pnpm/exe.linux-x64': '12.0.0' } } },
};
const project = {
  lockfileVersion: '9.0',
  importers: {
    '.': {
      dependencies: { '@scope/app-lib': { specifier: '^1', version: '1.0.0(peer@2.0.0)' } },
      devDependencies: { tester: { specifier: '^3', version: '3.0.0' } },
    },
    'packages/tool': {
      dependencies: {
        own: { specifier: 'workspace:*', version: 'link:../own' },
        'width-cjs': { specifier: 'npm:width@^4', version: 'width@4.2.3' },
      },
    },
  },
  snapshots: {
    '@scope/app-lib@1.0.0(peer@2.0.0)': { dependencies: { deep: '5.0.0', peer: '2.0.0' } },
    'deep@5.0.0': { optionalDependencies: { 'deep-native': '5.0.0' } },
    'deep-native@5.0.0': {},
    'peer@2.0.0': {},
    'tester@3.0.0': { dependencies: { 'test-only': '1.1.0', deep: '5.0.0' } },
    'test-only@1.1.0': null,
    'width@4.2.3': {},
  },
};

const resolved = (...ids: string[]) =>
  Object.fromEntries(
    ids.map((id) => {
      const at = id.lastIndexOf('@');
      const purl = `pkg:npm/${encodeURIComponent(id.slice(0, at)).replace('%2F', '/')}@${id.slice(at + 1)}`;
      return [purl, { package_url: purl, relationship: 'direct', scope: 'runtime' }];
    }),
  );

const syft = (files: Record<string, string[]>): Snapshot => ({
  version: 0,
  job: {},
  sha: null,
  ref: null,
  detector: { name: 'syft', url: 'https://github.com/anchore/syft', version: '1.54.0' },
  scanned: '2026-11-09T00:00:00Z',
  manifests: Object.fromEntries(
    Object.entries(files).map(([file, ids]) => [
      `/src/${file}`,
      { name: `/src/${file}`, file: { source_location: `/src/${file}` }, resolved: resolved(...ids) },
    ]),
  ),
});

const ALL = [
  'pnpm@12.0.0',
  '@pnpm/exe.linux-x64@12.0.0',
  '@scope/app-lib@1.0.0',
  'deep@5.0.0',
  'deep-native@5.0.0',
  'peer@2.0.0',
  'tester@3.0.0',
  'test-only@1.1.0',
  'width@4.2.3',
];

describe("Syft's pin", () => {
  it('is an exact version and a digest', () => {
    expect(syftPin(`FROM ghcr.io/anchore/syft:v1.54.0@${digest}\n`)?.[2]).toBe('1.54.0');
    expect(syftPin(`FROM ghcr.io/anchore/syft:v1.54.0\n`)).toBeNull();
    expect(syftPin(`FROM ghcr.io/anchore/syft@${digest}\n`)).toBeNull();
    expect(syftPin(`FROM docker.io/anchore/syft:v1.54.0@${digest}\n`)).toBeNull();
  });
});

describe('a package in the lockfile', () => {
  it('is known by name and version, without peers, through an alias, and never a workspace link', () => {
    expect(packageId('a', '1.0.0(b@2.0.0)')).toBe('a@1.0.0');
    expect(packageId('width-cjs', 'width@4.2.3')).toBe('width@4.2.3');
    expect(packageId('@s/a', '1.0.0')).toBe('@s/a@1.0.0');
    expect(packageId('own', 'link:../own')).toBeUndefined();
    expect(fromPurl('pkg:npm/%40scope/app-lib@1.0.0')).toBe('@scope/app-lib@1.0.0');
  });

  it('is direct when an importer names it, and at runtime when a runtime dependency reaches it', () => {
    const known = relationships([env, project]);
    expect([...(known?.direct ?? [])].sort()).toEqual(
      ['@scope/app-lib@1.0.0', 'pnpm@12.0.0', 'tester@3.0.0', 'width@4.2.3'].sort(),
    );
    expect([...(known?.runtime ?? [])].sort()).toEqual(
      ['@scope/app-lib@1.0.0', 'deep@5.0.0', 'deep-native@5.0.0', 'peer@2.0.0', 'width@4.2.3'].sort(),
    );
  });

  it('is not read from a lockfile of another version', () => {
    expect(relationships([{ ...project, lockfileVersion: '6.0' }])).toBeUndefined();
    expect(relationships([])).toBeUndefined();
  });
});

describe('the snapshot', () => {
  const job = { sha: 'abc', ref: 'refs/heads/main', run: '7-1' };

  it("names each lockfile by its path, the commit, the ref and the workflow's correlator", () => {
    const made = snapshot(syft({ 'pnpm-lock.yaml': ALL }), { 'pnpm-lock.yaml': [env, project] }, job);
    expect(made).toMatchObject({
      version: 0,
      sha: 'abc',
      ref: 'refs/heads/main',
      job: { correlator: CORRELATOR, id: '7-1' },
      detector: { name: 'syft' },
    });
    expect(Object.keys(made.manifests ?? {})).toEqual(['pnpm-lock.yaml']);
    expect(made.manifests?.['pnpm-lock.yaml']?.file).toEqual({ source_location: 'pnpm-lock.yaml' });
  });

  it("gives each package the lockfile's relationship and scope, not Syft's", () => {
    const made = snapshot(syft({ 'pnpm-lock.yaml': ALL }), { 'pnpm-lock.yaml': [env, project] }, job);
    const of = (id: string) => {
      const entry = Object.values(made.manifests?.['pnpm-lock.yaml']?.resolved ?? {}).find(
        (entry) => fromPurl(entry.package_url ?? '') === id,
      );
      return `${entry?.relationship} ${entry?.scope}`;
    };
    expect(of('@scope/app-lib@1.0.0')).toBe('direct runtime');
    expect(of('deep@5.0.0')).toBe('indirect runtime');
    expect(of('deep-native@5.0.0')).toBe('indirect runtime');
    expect(of('tester@3.0.0')).toBe('direct development');
    expect(of('test-only@1.1.0')).toBe('indirect development');
    expect(of('width@4.2.3')).toBe('direct runtime');
    expect(of('pnpm@12.0.0')).toBe('direct development');
    expect(of('@pnpm/exe.linux-x64@12.0.0')).toBe('indirect development');
  });

  it("gives each package the packages it depends on, from the lockfile, not Syft's list of its dependents", () => {
    const syftMade = syft({ 'pnpm-lock.yaml': ALL });
    const deep = syftMade.manifests?.['/src/pnpm-lock.yaml']?.resolved?.['pkg:npm/deep@5.0.0'];
    if (deep) deep.dependencies = ['pkg:npm/%40scope/app-lib@1.0.0', 'pkg:npm/tester@3.0.0'];
    const made = snapshot(syftMade, { 'pnpm-lock.yaml': [env, project] }, job);
    const resolvedMade = made.manifests?.['pnpm-lock.yaml']?.resolved ?? {};
    expect(resolvedMade['pkg:npm/deep@5.0.0']?.dependencies).toEqual(['pkg:npm/deep-native@5.0.0']);
    expect(resolvedMade['pkg:npm/%40scope/app-lib@1.0.0']?.dependencies).toEqual([
      'pkg:npm/deep@5.0.0',
      'pkg:npm/peer@2.0.0',
    ]);
    expect(resolvedMade['pkg:npm/pnpm@12.0.0']?.dependencies).toEqual(['pkg:npm/%40pnpm/exe.linux-x64@12.0.0']);
    expect(resolvedMade['pkg:npm/peer@2.0.0']?.dependencies).toBeUndefined();
  });

  it('keeps each lockfile apart, at its own path', () => {
    const made = snapshot(
      syft({ 'pnpm-lock.yaml': ['@scope/app-lib@1.0.0'], 'tools/pnpm-lock.yaml': ['tester@3.0.0'] }),
      { 'pnpm-lock.yaml': [project], 'tools/pnpm-lock.yaml': [project] },
      job,
    );
    expect(Object.keys(made.manifests ?? {}).sort()).toEqual(['pnpm-lock.yaml', 'tools/pnpm-lock.yaml']);
  });

  it('is not made when a lockfile has no packages in it, or is not one pnpm 9 reads', () => {
    expect(() => snapshot(syft({}), { 'pnpm-lock.yaml': [project] }, job)).toThrow(/names no package/);
    expect(() => snapshot(syft({ 'pnpm-lock.yaml': [] }), { 'pnpm-lock.yaml': [project] }, job)).toThrow(
      /names no package/,
    );
    expect(() =>
      snapshot(syft({ 'pnpm-lock.yaml': ALL }), { 'pnpm-lock.yaml': [{ ...project, lockfileVersion: '6.0' }] }, job),
    ).toThrow(/not a pnpm lockfile of version 9/);
  });
});

describe('the proof', () => {
  const job = { sha: 'abc', ref: 'refs/heads/main', run: '7-1' };
  const projects = [
    {
      name: 'root',
      dependencies: {
        '@scope/app-lib': {
          version: '1.0.0(peer@2.0.0)',
          dependencies: { deep: { version: '5.0.0' }, peer: { version: '2.0.0' } },
        },
      },
      devDependencies: { tester: { version: '3.0.0', dependencies: { 'test-only': { version: '1.1.0' } } } },
    },
  ];
  const manifest = (ids: string[]) =>
    snapshot(syft({ 'pnpm-lock.yaml': ids }), { 'pnpm-lock.yaml': [env, project] }, job).manifests?.[
      'pnpm-lock.yaml'
    ] ?? {};

  it('holds when the snapshot names every package pnpm lists, each as pnpm lists it, other platforms besides', () => {
    const found = compare(manifest(ALL), projects);
    expect(found.absent).toEqual([]);
    expect(found.misplaced).toEqual([]);
    expect(found.indirect.sort()).toEqual(['deep@5.0.0', 'peer@2.0.0', 'test-only@1.1.0']);
    expect(found.named.size).toBeGreaterThan(found.all.size);
  });

  it('finds a package the snapshot lacks', () => {
    expect(compare(manifest(ALL.filter((id) => id !== 'test-only@1.1.0')), projects).absent).toEqual([
      'test-only@1.1.0',
    ]);
  });

  it('finds a package called direct that pnpm lists as indirect', () => {
    const made = manifest(ALL);
    const deep = Object.values(made.resolved ?? {}).find((entry) => entry.package_url === 'pkg:npm/deep@5.0.0');
    if (deep) deep.relationship = 'direct';
    expect(compare(made, projects).misplaced).toEqual(['deep@5.0.0']);
  });
});
