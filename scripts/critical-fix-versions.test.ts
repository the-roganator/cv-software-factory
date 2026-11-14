import { describe, expect, it } from 'vitest';
import { atOrAbove, type Scan, scansShow } from './critical-fix.ts';
import { scanOf } from './critical-fix-readers.ts';
import { compareApk, compareDpkg, compareIn, formatOf } from './critical-fix-versions.ts';

/**
 * Each OS's versions in its own package manager's order (ADR 0020): dpkg's from deb-version(7) and dpkg's own tests,
 * apk's from apk-tools' version tests, and real fixed versions from the pinned Trivy 0.76.2's scans of images the two
 * repositories pin (`mcr.microsoft.com/devcontainers/base:3.0.12-noble`, the app's `node:24.22.2-alpine3.24` and
 * `gcr.io/distroless/nodejs24-debian13:nonroot`), on 14 November 2026.
 */

/** Each pair ordered `a < b`, so the reverse is `>` and each is equal to itself. */
const ordered = (compare: (a: string, b: string) => number | undefined, pairs: readonly [string, string][]) => {
  for (const [a, b] of pairs) {
    expect(compare(a, b), `${a} < ${b}`).toBe(-1);
    expect(compare(b, a), `${b} > ${a}`).toBe(1);
    expect(compare(a, a), `${a} = ${a}`).toBe(0);
  }
};

describe('dpkg', () => {
  it('orders as deb-version(7) says: the epoch first, `~` before everything, then letters, then the rest', () => {
    ordered(compareDpkg, [
      ['2.0', '1:1.0'],
      ['1:9.9', '2:0.1'],
      ['1.0~rc1', '1.0'],
      ['1.0~~', '1.0~'],
      ['1.0~~a', '1.0~'],
      ['1.0~', '1.0'],
      ['1.0', '1.0a'],
      ['1.0a', '1.0+'],
      ['1.0', '1.0.1'],
      ['1.0-1', '1.0-1.1'],
      ['1.0-1', '1.0-2'],
      ['1.0-9', '1.0-10'],
      ['1.0+deb12u1', '1.0+deb12u2'],
      ['2.36-9+deb12u9', '2.36-9+deb12u10'],
      ['3.0.11-1~deb12u2', '3.0.11-1'],
      ['1.2.3', '1.2.10'],
      ['1.002', '1.3'],
    ]);
    expect(compareDpkg('1.0', '1.00')).toBe(0);
    expect(compareDpkg('0:1.0', '1.0')).toBe(0);
    expect(compareDpkg('1.0-0', '1.0')).toBe(0);
  });

  it('orders the real fixes of the scans: Ubuntu’s kernel headers, glibc and apt; Debian’s OpenSSL and glibc', () => {
    ordered(compareDpkg, [
      ['6.8.0-147.147', '6.8.0-149.149'],
      ['2.39-0ubuntu8.9', '2.39-0ubuntu8.12'],
      ['2.8.3', '2.8.4ubuntu0.1'],
      ['10.42-4ubuntu2.1', '10.42-4ubuntu2.2'],
      ['5.38.2-3.2ubuntu0.6', '5.38.2-3.2ubuntu0.7'],
      ['3.5.7-1~deb13u3', '3.5.7-1'],
      ['2.41-12+deb13u4', '2.41-12+deb13u5'],
    ]);
  });

  it('reads no version that is not one: no digit first, a colon with no epoch, a stray character', () => {
    for (const bad of ['', 'a1.0', '1.0:2', '1.0 ', '1.0_2', ':1.0', '1:', '1.0-', '1.0-a:b'])
      expect(compareDpkg(bad, '1.0'), bad).toBeUndefined();
  });
});

describe('apk', () => {
  it('orders as apk-tools does: suffixes around the release, a letter, `-r<n>` by number', () => {
    ordered(compareApk, [
      ['1.2-r9', '1.2-r10'],
      ['1.2', '1.2-r1'],
      ['1.2_alpha', '1.2_beta'],
      ['1.2_beta2', '1.2_pre'],
      ['1.2_pre', '1.2_rc'],
      ['1.2_rc', '1.2_rc1'],
      ['1.2_rc1', '1.2'],
      ['1.2', '1.2_p1'],
      ['1.2_cvs', '1.2_svn'],
      ['1.2_git', '1.2_hg'],
      ['1.2_hg', '1.2_p'],
      ['1.2-r1', '1.2a'],
      ['1.2a', '1.2b'],
      ['1.2a', '1.2.1'],
      ['1.2', '1.2.1'],
      ['1.9', '1.10'],
      ['1.3.2-r1', '1.4-r0'],
      ['3.5.4-r0', '3.5.4-r1'],
    ]);
  });

  it('reads no version that is not one, nor a fraction or a commit it does not order', () => {
    for (const bad of ['', 'a1', '1.2-r', '1.2_foo', '1.2-r1-r2', '1.02', '1.2~abc', '1.2A'])
      expect(compareApk(bad, '1.2'), bad).toBeUndefined();
  });
});

describe('the format, from what Trivy says of the target', () => {
  it('takes it from the result’s class and type, never from the look of the version', () => {
    expect(formatOf('os-pkgs', 'debian')).toBe('dpkg');
    expect(formatOf('os-pkgs', 'ubuntu')).toBe('dpkg');
    expect(formatOf('os-pkgs', 'alpine')).toBe('apk');
    expect(formatOf('lang-pkgs', 'pnpm')).toBe('npm');
    expect(formatOf('lang-pkgs', 'node-pkg')).toBe('npm');
    expect(formatOf('os-pkgs', 'redhat')).toBe('unread:os-pkgs/redhat');
    expect(formatOf('lang-pkgs', 'gobinary')).toBe('unread:lang-pkgs/gobinary');
    expect(formatOf(undefined, undefined)).toBe('unread:no class/no type');
    // An Alpine version that looks like semver is still apk's: r10 after r9, which semver puts before it.
    expect(compareIn('apk', '3.1.4-r10', '3.1.4-r9')).toBe(1);
    expect(compareIn('npm', '3.1.4-r10', '3.1.4-r9')).toBe(-1);
    expect(compareIn('unread:os-pkgs/redhat', '1.0', '1.0')).toBeUndefined();
  });

  it('reads a fix at or above in its own format, and none in a format it does not order', () => {
    expect(atOrAbove('6.8.0-149.149', '6.8.0-149.149', 'dpkg')).toBe(true);
    expect(atOrAbove('6.8.0-147.147', '6.8.0-149.149', 'dpkg')).toBe(false);
    expect(atOrAbove('3.5.7-1~deb13u3', '3.5.7-1', 'dpkg')).toBe(false);
    expect(atOrAbove('1.4-r0', '1.4-r0', 'apk')).toBe(true);
    expect(atOrAbove('1.2-r10', '1.2-r9', 'apk')).toBe(true);
    expect(atOrAbove('1.0', '1.0', 'unread:os-pkgs/redhat')).toBeUndefined();
    expect(atOrAbove('not a version', '1.0', 'dpkg')).toBeUndefined();
  });

  it('reads a Debian package’s version whole, as Trivy lists its upstream version and revision apart', () => {
    // As the pinned Trivy lists distroless nodejs24-debian13's libssl3t64.
    const read = scanOf([
      {
        Results: [
          {
            Class: 'os-pkgs',
            Type: 'debian',
            Packages: [
              { Name: 'libssl3t64', Version: '3.5.7', Release: '1~deb13u3', Epoch: null },
              { Name: 'tzdata', Version: '2025b', Release: '4', Epoch: 1 },
            ] as never,
          },
        ],
      },
    ]);
    expect(read.packages).toEqual([
      { name: 'libssl3t64', version: '3.5.7-1~deb13u3' },
      { name: 'tzdata', version: '1:2025b-4' },
    ]);
    expect(atOrAbove('3.5.7-1~deb13u4', '3.5.7-1~deb13u4', 'dpkg')).toBe(true);
  });

  it('passes an image’s OS-package Critical gone at the head, in its own order, and holds one it cannot order', () => {
    const report = (type: string, version: string, findings: object[]) =>
      scanOf([
        {
          Metadata: { ImageID: 'sha256:x' },
          Results: [
            {
              Class: 'os-pkgs',
              Type: type,
              Packages: [{ Name: 'linux-libc-dev', Version: version }],
              Vulnerabilities: findings,
            },
          ],
        },
      ]);
    const critical = (type: string, installed: string, fixed: string): Scan =>
      report(type, installed, [
        {
          VulnerabilityID: 'CVE-2026-31431',
          PkgName: 'linux-libc-dev',
          InstalledVersion: installed,
          FixedVersion: fixed,
          Severity: 'CRITICAL',
        },
      ]);
    const label = 'mcr.microsoft.com/devcontainers/base (linux/arm64)';
    expect(
      scansShow([
        {
          label,
          was: critical('ubuntu', '6.8.0-147.147', '6.8.0-149.149'),
          now: report('ubuntu', '6.8.0-149.149', []),
        },
      ]),
    ).toEqual({ pkg: 'linux-libc-dev', ids: ['CVE-2026-31431'], where: [label] });
    expect(
      scansShow([{ label, was: critical('redhat', '6.8.0-147', '6.8.0-149'), now: report('redhat', '6.8.0-149', []) }]),
    ).toEqual({
      reason: `the scans show no fix the gate reads: linux-libc-dev's CVE-2026-31431 in ${label} is in os-pkgs/redhat's versions, an order the gate does not read`,
    });
    expect(
      scansShow([{ label, was: critical('ubuntu', '6.8.0-147.147', '6.8.0-149.149'), now: report('ubuntu', 'x', []) }]),
    ).toMatchObject({ reason: expect.stringMatching(/is not a version in dpkg's format/) });
  });
});
