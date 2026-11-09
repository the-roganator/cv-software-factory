import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  documents,
  forTrivy,
  isEmptyLockfile,
  judge,
  packageKeys,
  type Scanned,
  trackedLockfiles,
  trivyPin,
} from '../../src/gates/lockfile-scan.ts';

// Trivy's JSON for a pnpm lockfile, as `trivy fs --include-dev-deps --list-all-pkgs` writes it: `Dev` on a package
// only development dependencies reach, and each vulnerability naming its package's UID.
interface Pkg {
  name: string;
  version: string;
  dev?: boolean;
}
interface Vuln {
  id: string;
  pkg: string;
  version: string;
  severity?: string;
}

const uid = (name: string, version: string) => `uid-${name}-${version}`;

function report(packages: Pkg[], vulnerabilities: Vuln[] = []): Scanned {
  return {
    report: JSON.stringify({
      SchemaVersion: 2,
      Results: [
        {
          Target: 'pnpm-lock.yaml',
          Type: 'pnpm',
          Packages: packages.map((p) => ({
            ID: `${p.name}@${p.version}`,
            Name: p.name,
            Version: p.version,
            Identifier: { UID: uid(p.name, p.version) },
            ...(p.dev ? { Dev: true } : {}),
          })),
          Vulnerabilities: vulnerabilities.map((v) => ({
            VulnerabilityID: v.id,
            PkgID: `${v.pkg}@${v.version}`,
            PkgName: v.pkg,
            InstalledVersion: v.version,
            PkgIdentifier: { UID: uid(v.pkg, v.version) },
            Severity: v.severity ?? 'HIGH',
          })),
        },
      ],
    }),
  };
}

const lockfiles = (entries: Record<string, Scanned>) => new Map(Object.entries(entries));
const ROOT = 'pnpm-lock.yaml';
const LODASH = { name: 'lodash', version: '4.17.20' };
const LODASH_CVE = { id: 'CVE-2021-23337', pkg: 'lodash', version: '4.17.20' };

describe('the lockfile gate', () => {
  it('passes a vulnerability only the base has', () => {
    const base = lockfiles({ [ROOT]: report([LODASH], [LODASH_CVE]) });
    const change = lockfiles({ [ROOT]: report([{ name: 'lodash', version: '4.17.21' }]) });
    expect(judge(base, change)).toEqual({ added: [], unread: [], total: 0 });
  });

  it('passes a vulnerability both have', () => {
    const both = lockfiles({ [ROOT]: report([LODASH], [LODASH_CVE]) });
    expect(judge(both, both)).toMatchObject({ added: [], unread: [], total: 1 });
  });

  it('fails a new vulnerability, at Low too', () => {
    const base = lockfiles({ [ROOT]: report([LODASH]) });
    const change = lockfiles({ [ROOT]: report([LODASH], [{ ...LODASH_CVE, severity: 'LOW' }]) });
    expect(judge(base, change).added).toEqual([
      {
        lockfile: ROOT,
        advisory: 'CVE-2021-23337',
        pkg: 'lodash',
        version: '4.17.20',
        dev: false,
        severity: 'LOW',
        fixed: '',
        title: '',
      },
    ]);
  });

  it('brings nothing new when a package moves to another version with the same vulnerability', () => {
    const base = lockfiles({ [ROOT]: report([LODASH], [LODASH_CVE]) });
    const moved = { name: 'lodash', version: '4.17.19' };
    const change = lockfiles({ [ROOT]: report([moved], [{ ...LODASH_CVE, version: '4.17.19' }]) });
    expect(judge(base, change).added).toEqual([]);
  });

  it('fails a development dependency’s vulnerability once production reaches it', () => {
    const base = lockfiles({ [ROOT]: report([{ ...LODASH, dev: true }], [LODASH_CVE]) });
    const change = lockfiles({ [ROOT]: report([LODASH], [LODASH_CVE]) });
    expect(judge(base, change).added).toMatchObject([{ advisory: 'CVE-2021-23337', dev: false }]);
    // Not the other way: one production reached on the base and only development on the change is less reached.
    expect(judge(change, base).added).toEqual([]);
  });

  it('reads a package Trivy cannot match to its entry as production’s', () => {
    const base = lockfiles({ [ROOT]: report([{ ...LODASH, dev: true }], [LODASH_CVE]) });
    const unmatched: Scanned = {
      report: JSON.stringify({
        Results: [
          {
            Packages: [{ ID: 'other@1.0.0', Dev: true }],
            Vulnerabilities: [{ VulnerabilityID: 'CVE-2021-23337', PkgName: 'lodash', PkgID: 'lodash@4.17.20' }],
          },
        ],
      }),
    };
    expect(judge(base, lockfiles({ [ROOT]: unmatched })).added).toMatchObject([{ dev: false }]);
  });

  it('names every version of a new package and advisory, once', () => {
    const base = lockfiles({ [ROOT]: report([LODASH]) });
    const older = { name: 'lodash', version: '4.17.19' };
    const change = lockfiles({ [ROOT]: report([LODASH, older], [LODASH_CVE, { ...LODASH_CVE, version: '4.17.19' }]) });
    const { added, total } = judge(base, change);
    expect(total).toBe(1);
    expect(added).toMatchObject([{ advisory: 'CVE-2021-23337', version: '4.17.19, 4.17.20' }]);
  });

  it('compares a lockfile only the change has with none', () => {
    const base = lockfiles({ [ROOT]: report([LODASH], [LODASH_CVE]) });
    const change = lockfiles({
      [ROOT]: report([LODASH], [LODASH_CVE]),
      'tools/pnpm-lock.yaml': report([LODASH], [LODASH_CVE]),
    });
    expect(judge(base, change).added).toMatchObject([{ lockfile: 'tools/pnpm-lock.yaml', advisory: 'CVE-2021-23337' }]);
  });

  it('fails an empty or unparsable report, a lockfile Trivy read no packages from, or one it could not scan, on either side', () => {
    const good = report([LODASH]);
    for (const bad of [
      { report: '' },
      { report: 'not json' },
      { report: '{}' },
      { report: 'null' },
      { report: JSON.stringify({ Results: [{ Packages: [] }] }) },
      { report: JSON.stringify({ Results: [{ Packages: null, Vulnerabilities: null }] }) },
      { error: 'docker: exit 1' },
      { unscannable: 'git tracks it as something other than a regular file' },
    ] satisfies Scanned[]) {
      expect(judge(lockfiles({ [ROOT]: good }), lockfiles({ [ROOT]: bad })).unread).toMatchObject([
        { side: 'change', lockfile: ROOT },
      ]);
      expect(judge(lockfiles({ [ROOT]: bad }), lockfiles({ [ROOT]: good })).unread).toMatchObject([
        { side: 'base', lockfile: ROOT },
      ]);
    }
  });
});

describe('the lockfiles a checkout tracks', () => {
  it('are every pnpm-lock.yaml at any depth, fixtures included, the regular apart from a link', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockfile-gate-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
      git('init', '-q');
      for (const dir of ['deps', 'tools', 'test/alt']) mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, 'deps/lock'), "lockfileVersion: '9.0'\n");
      writeFileSync(join(root, 'tools/pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      // Where `lockfileDir: test/alt` would point pnpm, however the setting is spelled.
      writeFileSync(join(root, 'test/alt/pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      // A branch's lockfile, which pnpm reads with gitBranchLockfile or merges by mergeGitBranchLockfilesBranchPattern.
      writeFileSync(join(root, 'pnpm-lock.main.yaml'), "lockfileVersion: '9.0'\n");
      writeFileSync(join(root, 'pnpm-lock.yml'), "lockfileVersion: '9.0'\n");
      symlinkSync('deps/lock', join(root, 'pnpm-lock.yaml'));
      git('add', '.');
      expect(trackedLockfiles(root)).toEqual({
        regular: ['pnpm-lock.main.yaml', 'test/alt/pnpm-lock.yaml', 'tools/pnpm-lock.yaml'],
        irregular: ['pnpm-lock.yaml'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a lockfile's YAML documents", () => {
  it('are each scanned alone: pnpm reads the second of two, where Trivy reads only the first', () => {
    const clean = "lockfileVersion: '9.0'\npackages:\n  is-number@7.0.0: {}";
    const old = "lockfileVersion: '9.0'\npackages:\n  is-number@6.0.0: {}";
    expect(documents(`---\n${clean}\n---\n${old}\n`)).toEqual([clean, old]);
    expect(documents(`${clean}\r\n--- # a comment\r\n${old}\r\n...\r\n`)).toEqual([clean, old]);
  });

  it('are one for a lockfile with one, whatever starts it, and none beside it that holds only comments', () => {
    expect(documents("---\nlockfileVersion: '9.0'\n")).toEqual(["lockfileVersion: '9.0'"]);
    expect(documents("lockfileVersion: '9.0'\n---\n# nothing\n\n")).toEqual(["lockfileVersion: '9.0'"]);
    // A line that only begins with three dashes inside a document starts nothing.
    expect(documents('a: |\n  ---x\nb: 1\n')).toHaveLength(1);
  });
});

describe("pnpm's env lockfile", () => {
  const env = [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    configDependencies: {}',
    '    packageManagerDependencies:',
    '      pnpm:',
    '        specifier: 12.16.1',
    '        version: 12.16.1',
  ].join('\n');

  it('is given the names Trivy reads, so pnpm itself and its config dependencies are judged as production’s', () => {
    expect(forTrivy(env)).toBe(
      env
        .replace('    configDependencies:', '    dependencies:')
        .replace('    packageManagerDependencies:', '    optionalDependencies:'),
    );
  });

  it('is left alone in a document that has dependencies of its own', () => {
    const main = `${env}\n    dependencies:\n      lodash:\n        specifier: 4.17.21\n        version: 4.17.21`;
    expect(forTrivy(main)).toBe(main);
  });

  it("renames only in the importers, never a snapshot's optional dependencies", () => {
    const withSnapshots = `${env}\n\nsnapshots:\n\n  pnpm@12.16.1:\n    optionalDependencies:\n      x: 1.0.0`;
    expect(forTrivy(withSnapshots)).toContain('    dependencies: {}');
    expect(forTrivy(withSnapshots).endsWith('    optionalDependencies:\n      x: 1.0.0')).toBe(true);
  });
});

describe('the packages a document lists, which Trivy must have read', () => {
  it('are every key under packages, quoted or not', () => {
    const doc = [
      "lockfileVersion: '9.0'",
      'packages:',
      '',
      "  '@pnpm/exe.darwin-arm64@12.16.1':",
      '    resolution: {integrity: sha512-x}',
      '  lodash@4.17.20:',
      '    resolution: {integrity: sha512-y}',
      '',
      'snapshots:',
      '',
      '  is-number@7.0.0: {}',
    ].join('\n');
    expect(packageKeys(doc)).toEqual(['@pnpm/exe.darwin-arm64@12.16.1', 'lodash@4.17.20']);
    expect(packageKeys("lockfileVersion: '9.0'")).toEqual([]);
  });

  it('cannot be read from a document written in any other shape, which fails', () => {
    for (const doc of [
      "lockfileVersion: '9.0'\npackages: {lodash@4.17.20: {}}",
      "'packages':\n  lodash@4.17.20: {}",
      "<<: *env\nlockfileVersion: '9.0'",
      "{lockfileVersion: '9.0'}",
      'packages:\n ? lodash@4.17.20\n : {}',
      'packages:\n   lodash@4.17.20: {}',
    ])
      expect(typeof packageKeys(doc), doc).toBe('string');
  });
});

describe('an empty lockfile', () => {
  it('passes with no packages read, when it holds nothing but its version', () => {
    const none = { report: JSON.stringify({ Results: [{ Packages: [] }] }) };
    expect(
      judge(lockfiles({ [ROOT]: { ...none, empty: true } }), lockfiles({ [ROOT]: { ...none, empty: true } })),
    ).toEqual({ added: [], unread: [], total: 0 });
    expect(judge(lockfiles({}), lockfiles({ [ROOT]: none })).unread).toMatchObject([{ side: 'change' }]);
  });

  it('is one with only its version, a document start and comments, in any line ending', () => {
    expect(isEmptyLockfile("lockfileVersion: '9.0'\n")).toBe(true);
    expect(isEmptyLockfile("---\r\n# a comment\r\nlockfileVersion: '9.0'\r\n\r\n")).toBe(true);
    expect(isEmptyLockfile("lockfileVersion: '9.0'\rpackages:\r  lodash@4.17.20: {}\r")).toBe(false);
    expect(isEmptyLockfile("{lockfileVersion: '9.0', packages: {lodash@4.17.20: {}}}\n")).toBe(false);
    expect(isEmptyLockfile("lockfileVersion: '9.0'\nimporters:\n  .: {}\n")).toBe(false);
  });
});

describe("the lockfile gate's Trivy", () => {
  it('is the one pin, by version and digest', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(trivyPin(`FROM ghcr.io/aquasecurity/trivy:0.74.0@${digest}\n`)).toBe(
      `ghcr.io/aquasecurity/trivy:0.74.0@${digest}`,
    );
    expect(trivyPin('FROM ghcr.io/aquasecurity/trivy:0.74.0\n')).toBeUndefined();
    expect(trivyPin(`FROM docker.io/aquasec/trivy:0.74.0@${digest}\n`)).toBeUndefined();
  });
});
