import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { irregularLockfiles, judge, type Scanned, trivyPin } from '../../src/gates/lockfile-scan.ts';

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

describe('a lockfile git tracks as something other than a regular file', () => {
  it('is named, so the gate fails it, while the list leaves it out', () => {
    const root = mkdtempSync(join(tmpdir(), 'lockfile-gate-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
      git('init', '-q');
      mkdirSync(join(root, 'deps'));
      mkdirSync(join(root, 'tools'));
      mkdirSync(join(root, 'test'));
      writeFileSync(join(root, 'deps/lock'), 'lockfileVersion: 9.0\n');
      writeFileSync(join(root, 'tools/pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
      symlinkSync('deps/lock', join(root, 'pnpm-lock.yaml'));
      symlinkSync('../deps/lock', join(root, 'test/pnpm-lock.yaml'));
      git('add', '.');
      expect(irregularLockfiles(root)).toEqual(['pnpm-lock.yaml']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
