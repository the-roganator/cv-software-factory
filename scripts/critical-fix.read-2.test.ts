import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { APP_GATES, type CriticalFixIO, criticalFix, type Finding, type Scan, scansShow } from './critical-fix.ts';
import { scanOf } from './critical-fix-readers.ts';
import type { Run } from './pin-move-ran.ts';

/**
 * A second independent read of the Critical fix's proof (ADR 0020), at 28b8717. Each case in the first block is a change
 * that should wait for Martin and passes the rule today, so it fails here. What real pnpm 12.16.1 and the pinned Trivy
 * 0.76.2 do with each lockfile was checked for real, and each case says what was seen.
 *
 * The base is the shape of the app's own lockfile: `@grpc/grpc-js` locked twice, 1.14.4 for the app and 1.14.6 for an
 * exporter, and protobufjs under `@grpc/proto-loader`, which asks for `^7.5.5`.
 */

const HEAD = 'a'.repeat(40);

/** A lockfile's `name@version` key, split as Trivy reads it: the name may start with `@`. */
function splitKey(key: string): { name: string; version: string } | undefined {
  const at = key.lastIndexOf('@');
  return at > 0 ? { name: key.slice(0, at), version: key.slice(at + 1) } : undefined;
}

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      '@grpc/grpc-js':
        specifier: ~1.14.4
        version: 1.14.4
      otel-exporter:
        specifier: ^0.300.0
        version: 0.300.0

packages:

  '@grpc/grpc-js@1.14.4':
    resolution: {integrity: sha512-grpc4}

  '@grpc/grpc-js@1.14.6':
    resolution: {integrity: sha512-grpc6}

  '@grpc/proto-loader@0.8.1':
    resolution: {integrity: sha512-loader}

  long@5.3.2:
    resolution: {integrity: sha512-long}

  otel-exporter@0.300.0:
    resolution: {integrity: sha512-exporter}

  protobufjs@7.6.4:
    resolution: {integrity: sha512-p764}

snapshots:

  '@grpc/grpc-js@1.14.4':
    dependencies:
      '@grpc/proto-loader': 0.8.1

  '@grpc/grpc-js@1.14.6':
    dependencies:
      '@grpc/proto-loader': 0.8.1

  '@grpc/proto-loader@0.8.1':
    dependencies:
      long: 5.3.2
      protobufjs: 7.6.4

  long@5.3.2: {}

  otel-exporter@0.300.0:
    dependencies:
      '@grpc/grpc-js': 1.14.6

  protobufjs@7.6.4:
    dependencies:
      long: 5.3.2
`;

/** The honest fix: protobufjs to 7.6.6, its entry, its snapshot and the loader's edge to it. */
const FIXED_LOCK = LOCK.replace(
  'protobufjs@7.6.4:\n    resolution: {integrity: sha512-p764}',
  'protobufjs@7.6.6:\n    resolution: {integrity: sha512-p766}',
)
  .replace('protobufjs@7.6.4:\n    dependencies:', 'protobufjs@7.6.6:\n    dependencies:')
  .replace('protobufjs: 7.6.4', 'protobufjs: 7.6.6');

/** CVE-2026-1, Critical, in protobufjs below 7.6.6. */
const ADVISORIES: Record<string, Finding[]> = Object.fromEntries(
  ['7.6.4', '7.6.5'].map((version) => [
    `protobufjs@${version}`,
    [{ id: 'CVE-2026-1', pkg: 'protobufjs', version, fixed: '7.6.6', severity: 'CRITICAL' }],
  ]),
);

/**
 * A fake Trivy that reads a lockfile as the pinned Trivy 0.76.2 does: each package's name from its key, and its
 * version from its entry's `version` field where it has one, else from its key. Seen for real: `trivy fs --format
 * cyclonedx --include-dev-deps` on a lockfile whose `is-number@7.0.0` entry carries `name: left-pad` and
 * `version: 1.2.3` lists `pkg:npm/is-number@1.2.3`.
 */
function scanLockfile(text: string): Scan {
  const entries = (parse(text) as { packages?: Record<string, { version?: string } | null> }).packages ?? {};
  const packages = Object.entries(entries).flatMap(([key, entry]) => {
    const split = splitKey(key);
    return split ? [{ name: split.name, version: entry?.version ?? split.version }] : [];
  });
  return { packages, findings: packages.flatMap(({ name, version }) => ADVISORIES[`${name}@${version}`] ?? []) };
}

const passedGates = (): Run[] =>
  Object.entries(APP_GATES).map(([name, workflow], i) => ({
    id: 100 + i,
    name,
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    app: { slug: 'github-actions' },
    check_suite: { id: 10 + i },
    workflow,
  }));

function io(lock: string): CriticalFixIO {
  return {
    diff: async () => ({
      raw: ':100644 100644 1111111 2222222 M\tpnpm-lock.yaml',
      files: [{ path: 'pnpm-lock.yaml', before: LOCK, after: lock }],
    }),
    lockfile: async (text) => scanLockfile(text),
    image: async () => {
      throw new Error('no image moves');
    },
    node: async () => [],
    tags: async () => [],
    digest: async () => {
      throw new Error('no tag');
    },
    runs: async () => passedGates(),
    // Changed from the read: the registry's manifests are no longer read. The registry lists protobufjs's versions,
    // and the pin step's derivation of protobufjs 7.6.4 to 7.6.6 on the base writes the honest fix's lockfile.
    versions: async (name) => (name === 'protobufjs' ? ['7.6.4', '7.6.5', '7.6.6', '8.0.0'] : []),
    derive: async (move) => {
      if (`${move.name}@${move.from}>${move.to}` !== 'protobufjs@7.6.4>7.6.6') throw new Error('no such move');
      return { 'pnpm-lock.yaml': FIXED_LOCK };
    },
    required: async () => [...Object.keys(APP_GATES), 'review'],
  };
}

const said = async (lock: string) => {
  const result = await criticalFix(io(lock), HEAD);
  return 'reason' in result ? result.reason : `PASSED: ${result.title}`;
};

describe('a Critical fix, read a second time: these pass today and should be held', () => {
  it('sanity: the honest fix passes, and the base has the finding', async () => {
    expect(scanLockfile(LOCK).findings).toHaveLength(1);
    expect(await said(FIXED_LOCK)).toMatch(/^PASSED/);
  });

  // "The scans show the fix" and "nothing new", and ADR 0020's "every package a registry's integrity alone". A moved
  // package's entry is checked only in its `resolution`: any other field passes. The pinned Trivy takes a package's
  // version from its entry's `version` field; pnpm 12.16.1 ignores that field and installs the key's version (seen:
  // key `is-number@7.0.0` with `version: 6.0.0` and 6.0.0's integrity fails on integrity, so 7.0.0 was fetched; with
  // 7.0.0's integrity and `version: 1.2.3` it installs is-number 7.0.0). So the scanner is told one version and pnpm
  // installs another: here protobufjs moves to 7.6.5, still vulnerable, and the scan reads 7.6.6, the fix. The same
  // field hides any new High or Critical in a version the head moves to or adds.
  it('holds a moved package whose entry tells the scanner another version than pnpm installs', async () => {
    const lied = LOCK.replace(
      'protobufjs@7.6.4:\n    resolution: {integrity: sha512-p764}',
      'protobufjs@7.6.5:\n    resolution: {integrity: sha512-p765}\n    version: 7.6.6',
    )
      .replace('protobufjs@7.6.4:\n    dependencies:', 'protobufjs@7.6.5:\n    dependencies:')
      .replace('protobufjs: 7.6.4', 'protobufjs: 7.6.5');
    // What pnpm installs is still vulnerable: the key's version.
    expect(ADVISORIES['protobufjs@7.6.5']).toHaveLength(1);
    expect(parse(lied).packages['protobufjs@7.6.5'].version).toBe('7.6.6');
    expect(await said(lied)).not.toMatch(/^PASSED/);
  });

  // "An alias ... holds the change", and ADR 0020's "every edge the head installs is the base's or the registry's".
  // The gate reads YAML 1.2, where `<<` is a key like any other, and of a snapshot the head adds it reads only
  // `dependencies` and `optionalDependencies`; pnpm reads `<<` as a merge. Seen with pnpm 12.16.1, frozen: a snapshot
  // written `<<: {dependencies: {is-number: left-pad@1.3.0}}` installs left-pad 1.3.0 as is-odd's `is-number`. So the
  // fixed version's snapshot holds edges the gate never reads, held to no manifest: here protobufjs's `long` is
  // @grpc/grpc-js under another name.
  it('holds a new snapshot whose edges are written under a YAML merge key, an alias among them', async () => {
    const merged = FIXED_LOCK.replace(
      'protobufjs@7.6.6:\n    dependencies:\n      long: 5.3.2',
      "protobufjs@7.6.6:\n    <<: {dependencies: {long: '@grpc/grpc-js@1.14.6'}}",
    );
    expect(merged).toContain("<<: {dependencies: {long: '@grpc/grpc-js@1.14.6'}}");
    expect(await said(merged)).not.toMatch(/^PASSED/);
  });

  // The plan's named case, "a Critical fix bundled with an unrelated bump", and "every package whose resolved version
  // changes ... is the one the fixed finding names". An importer's resolved version is set aside and never compared:
  // only its range is. Where a package is locked twice, as the app's @grpc/grpc-js is today (1.14.4 for the app,
  // 1.14.6 for an exporter, the range ~1.14.4), the head moves the app's own dependency to the other version, in
  // range, so pnpm installs it frozen. No package is added, moved or removed, so nothing else reads it.
  it('holds a direct dependency moved to another version the lockfile already has', async () => {
    const flipped = FIXED_LOCK.replace(
      'specifier: ~1.14.4\n        version: 1.14.4',
      'specifier: ~1.14.4\n        version: 1.14.6',
    );
    expect(flipped).toContain('specifier: ~1.14.4\n        version: 1.14.6');
    expect(await said(flipped)).not.toMatch(/^PASSED/);
  });

  // ADR 0020: "a version that goes is replaced by one forward of it on its major", and the rule's own "never a major".
  // That is asked of some version the head adds, not of the one it installs: 7.6.6 is listed, with no snapshot, and
  // 8.0.0 beside it is what every dependent is rewired to. A snapshot that stays may name any version of a package
  // that moves, whatever range its own manifest asks for. Seen with pnpm 12.16.1, frozen: a `packages` entry with no
  // snapshot is ignored, and is-odd 3.0.1, which asks for is-number ^6.0.0, installs with is-number 7.0.0.
  it('holds the fixed package moved across a major, behind a version on its major that nothing installs', async () => {
    const major = LOCK.replace(
      'protobufjs@7.6.4:\n    resolution: {integrity: sha512-p764}',
      'protobufjs@7.6.6:\n    resolution: {integrity: sha512-p766}\n\n  protobufjs@8.0.0:\n    resolution: {integrity: sha512-p800}',
    )
      .replace('protobufjs@7.6.4:\n    dependencies:', 'protobufjs@8.0.0:\n    dependencies:')
      .replace('protobufjs: 7.6.4', 'protobufjs: 8.0.0');
    expect(Object.keys(parse(major).snapshots)).not.toContain('protobufjs@7.6.6');
    expect(await said(major)).not.toMatch(/^PASSED/);
  });

  // "Only what the fix needs moves", and the rule's own "a package already there moves only where a new version
  // requires a range its old version is outside". That is asked only of a version that goes. Here long 5.3.2 stays,
  // for the loader, and the fixed protobufjs is given a new long 5.9.9, though ^5.0.0 admits the 5.3.2 already there:
  // a second package's new release rides in with the fix.
  it('holds a dependency of the fixed version moved to a new release beside the one that already satisfied it', async () => {
    const beside = FIXED_LOCK.replace(
      '  long@5.3.2:\n    resolution: {integrity: sha512-long}',
      '  long@5.3.2:\n    resolution: {integrity: sha512-long}\n\n  long@5.9.9:\n    resolution: {integrity: sha512-long599}',
    )
      .replace('  long@5.3.2: {}', '  long@5.3.2: {}\n\n  long@5.9.9: {}')
      .replace(
        'protobufjs@7.6.6:\n    dependencies:\n      long: 5.3.2',
        'protobufjs@7.6.6:\n    dependencies:\n      long: 5.9.9',
      );
    expect(beside).toContain('protobufjs@7.6.6:\n    dependencies:\n      long: 5.9.9');
    expect(await said(beside)).not.toMatch(/^PASSED/);
  });

  // "A report that does not parse ... holds", and nothing new at High or above. A finding the report gives no
  // package name for (or no id) is dropped from the scan, so a head that brings a Critical written so brings nothing.
  it('holds a head whose scan has a finding with no package name', () => {
    const critical = {
      VulnerabilityID: 'CVE-2026-1',
      PkgName: 'protobufjs',
      InstalledVersion: '7.6.4',
      FixedVersion: '7.6.6',
      Severity: 'CRITICAL',
    };
    const report = (version: string, vulnerabilities: object[]) =>
      scanOf([
        {
          Results: [{ Packages: [{ Name: 'protobufjs', Version: version }], Vulnerabilities: vulnerabilities }],
        } as never,
      ]);
    let result: unknown;
    try {
      result = scansShow([
        {
          label: 'pnpm-lock.yaml',
          was: report('7.6.4', [critical]),
          now: report('7.6.6', [{ VulnerabilityID: 'CVE-2026-2', InstalledVersion: '7.6.6', Severity: 'CRITICAL' }]),
        },
      ]);
    } catch {
      result = { reason: 'unread' };
    }
    expect(result).toHaveProperty('reason');
  });
});

describe('a Critical fix, read a second time: these are held, and no other test has them', () => {
  it('a merge key anywhere but a new snapshot: an importer, its dependencies, a package, a snapshot that stays', async () => {
    const cases = [
      FIXED_LOCK.replace(
        '      otel-exporter:\n        specifier',
        '      <<: {long: {specifier: ^5.0.0, version: 5.3.2}}\n      otel-exporter:\n        specifier',
      ),
      FIXED_LOCK.replace(
        '  .:\n    dependencies:',
        '  .:\n    <<: {devDependencies: {long: {specifier: ^5.0.0, version: 5.3.2}}}\n    dependencies:',
      ),
      FIXED_LOCK.replace('packages:\n', "packages:\n\n  <<: {'evil@1.0.0': {resolution: {integrity: sha512-evil}}}\n"),
      FIXED_LOCK.replace('  long@5.3.2: {}', '  long@5.3.2:\n    <<: {dependencies: {protobufjs: 7.6.6}}'),
      FIXED_LOCK.replace(
        'resolution: {integrity: sha512-p766}',
        'resolution: {integrity: sha512-p766, <<: {tarball: https://example.com/x.tgz}}',
      ),
    ];
    for (const lock of cases) expect(await said(lock)).not.toMatch(/^PASSED/);
  });
});
