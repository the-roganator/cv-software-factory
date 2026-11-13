import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { Found } from '../policy/review-verdict.ts';
import {
  APP_GATES,
  type CriticalFixIO,
  criticalFix,
  dockerfileMoves,
  type Finding,
  manifestRanges,
  type Scan,
  scansShow,
  splitKey,
} from './critical-fix.ts';
import { scanOf } from './critical-fix-readers.ts';
import type { Run } from './pin-move-ran.ts';
import { fixTagsHold } from './review-routing.ts';

/**
 * An independent read of the Critical fix's proof (ADR 0020): each case is a change that should wait for Martin. The
 * first block's cases pass the rule today, so they fail here; the second block's are held, and no other test has them.
 */

const HEAD = 'a'.repeat(40);

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      pino:
        specifier: ^10.4.0
        version: 10.4.0
      protobufjs:
        specifier: ^7.6.4
        version: 7.6.4

packages:

  long@5.3.2:
    resolution: {integrity: sha512-long}

  pino@10.4.0:
    resolution: {integrity: sha512-pino}

  protobufjs@7.6.4:
    resolution: {integrity: sha512-p764}

snapshots:

  long@5.3.2: {}

  pino@10.4.0: {}

  protobufjs@7.6.4:
    dependencies:
      long: 5.3.2
`;

/** The honest fix: protobufjs to 7.6.6 in the lockfile alone, requiring what it did. */
const FIXED_LOCK = LOCK.replace('version: 7.6.4', 'version: 7.6.6')
  .replace(
    'protobufjs@7.6.4:\n    resolution: {integrity: sha512-p764}',
    'protobufjs@7.6.6:\n    resolution: {integrity: sha512-p766}',
  )
  .replace('protobufjs@7.6.4:\n    dependencies:', 'protobufjs@7.6.6:\n    dependencies:');

const ADVISORIES: Record<string, Finding[]> = {
  'protobufjs@7.6.4': [{ id: 'CVE-2026-1', pkg: 'protobufjs', version: '7.6.4', fixed: '7.6.5', severity: 'CRITICAL' }],
};

/** A fake Trivy: the lockfile's packages, and each one's advisories. */
function scanLockfile(text: string): Scan {
  const packages = Object.keys((parse(text) as { packages?: Record<string, unknown> }).packages ?? {}).flatMap(
    (key) => {
      const split = splitKey(key);
      return split ? [split] : [];
    },
  );
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

function io(lock: string, over: Partial<CriticalFixIO> = {}): CriticalFixIO {
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
    // The registry's manifest of the fixed version, and the app's ruleset: what the head cannot write.
    manifest: async (name, version) =>
      // A package the registry publishes with nothing it requires, but the fixed version, which requires long.
      `${name}@${version}` === 'protobufjs@7.6.6' ? { long: '^5.0.0' } : {},
    required: async () => [...Object.keys(APP_GATES), 'review'],
    ...over,
  };
}

const said = async (lock: string) => {
  const result = await criticalFix(io(lock), HEAD);
  return 'reason' in result ? result.reason : `PASSED: ${result.title}`;
};

describe('a Critical fix, read adversarially: these pass today and should be held', () => {
  it('sanity: the honest lockfile-only fix passes', async () => {
    expect(await said(FIXED_LOCK)).toMatch(/^PASSED/);
  });

  // Condition 3 ("only what the fix needs moves") and the plan's named case, "a Critical fix bundled with an unrelated
  // bump". What the fixed version "requires" is read from the head's own snapshots, which the change writes: naming
  // pino under protobufjs@7.6.6 makes the app's own direct dependency's bump "required". pnpm installs a frozen
  // lockfile as written, so nothing else contradicts it.
  it('holds an unrelated bump the head’s snapshot merely claims the fixed version requires', async () => {
    const bundled = FIXED_LOCK.replace('version: 10.4.0', 'version: 10.5.0')
      .replace(
        'pino@10.4.0:\n    resolution: {integrity: sha512-pino}',
        'pino@10.5.0:\n    resolution: {integrity: sha512-pino105}',
      )
      .replace('pino@10.4.0: {}', 'pino@10.5.0: {}')
      .replace('    dependencies:\n      long: 5.3.2', '    dependencies:\n      long: 5.3.2\n      pino: 10.5.0');
    expect(bundled).toContain('pino@10.5.0: {}');
    expect(await said(bundled)).not.toMatch(/^PASSED/);
  });

  // The same root, the threat model's publisher/coder row: "every package added is the finding's package or one its
  // new version requires". Any registry package is added by claiming it in the fixed version's snapshot.
  it('holds a package added that only the head’s snapshot says the fixed version requires', async () => {
    const added = FIXED_LOCK.replace(
      '  long@5.3.2:\n    resolution: {integrity: sha512-long}',
      '  left-pad-evil@1.0.0:\n    resolution: {integrity: sha512-evil}\n\n  long@5.3.2:\n    resolution: {integrity: sha512-long}',
    )
      .replace('  long@5.3.2: {}', '  left-pad-evil@1.0.0: {}\n\n  long@5.3.2: {}')
      .replace(
        '    dependencies:\n      long: 5.3.2',
        '    dependencies:\n      left-pad-evil: 1.0.0\n      long: 5.3.2',
      );
    expect(added).toContain('left-pad-evil@1.0.0: {}');
    expect(await said(added)).not.toMatch(/^PASSED/);
  });

  // Condition 1: "an alias ... holds the change". Aliases are refused in importers alone. A snapshot's dependency may
  // be an alias, so the fixed package (or any other) loads another package under a name it already requires: here
  // protobufjs's `long` becomes left-pad-evil, while long@5.3.2 stays listed, orphaned, so no scan misses it.
  it('holds an alias written in a snapshot: a required name resolved to another package', async () => {
    const aliased = FIXED_LOCK.replace(
      '  long@5.3.2:\n    resolution: {integrity: sha512-long}',
      '  left-pad-evil@1.0.0:\n    resolution: {integrity: sha512-evil}\n\n  long@5.3.2:\n    resolution: {integrity: sha512-long}',
    )
      .replace('  long@5.3.2: {}', '  left-pad-evil@1.0.0: {}\n\n  long@5.3.2: {}')
      .replace(
        '    dependencies:\n      long: 5.3.2',
        '    dependencies:\n      left-pad-evil: 1.0.0\n      long: left-pad-evil@1.0.0',
      );
    expect(aliased).toContain('long: left-pad-evil@1.0.0');
    expect(await said(aliased)).not.toMatch(/^PASSED/);
  });

  // Condition 1: "one that stays at a version [is] the same". That is checked of `packages` entries, never of
  // snapshots: a package that does not move has its snapshot rewritten, here pino given a dependency it never had,
  // resolved to protobufjs under another name. No package is added, moved or removed, so nothing else reads it.
  it('holds a snapshot rewritten for a package that does not move', async () => {
    const rewired = FIXED_LOCK.replace(
      'pino@10.4.0: {}',
      'pino@10.4.0:\n    dependencies:\n      sonic-boom: protobufjs@7.6.6',
    );
    expect(rewired).toContain('sonic-boom: protobufjs@7.6.6');
    expect(await said(rewired)).not.toMatch(/^PASSED/);
  });

  // "A report that does not parse ... holds", and nothing new at High or above: a finding the report gives no
  // severity for is read as UNKNOWN, which is below High, so a head that brings one brings "nothing new".
  it('holds a head whose scan has a finding with no severity it can read', () => {
    const base = scanOf([
      {
        Results: [
          {
            Packages: [{ Name: 'protobufjs', Version: '7.6.4' }],
            Vulnerabilities: [
              {
                VulnerabilityID: 'CVE-2026-1',
                PkgName: 'protobufjs',
                InstalledVersion: '7.6.4',
                FixedVersion: '7.6.5',
                Severity: 'CRITICAL',
              },
            ],
          },
        ],
      } as never,
    ]);
    const read = () =>
      scansShow([
        {
          label: 'pnpm-lock.yaml',
          was: base,
          now: scanOf([
            {
              Results: [
                {
                  Packages: [{ Name: 'protobufjs', Version: '7.6.6' }],
                  Vulnerabilities: [
                    { VulnerabilityID: 'CVE-2026-2', PkgName: 'protobufjs', InstalledVersion: '7.6.6' },
                  ],
                },
              ],
            } as never,
          ]),
        },
      ]);
    // Held either way: a reason, or a reader that throws.
    let result: unknown;
    try {
      result = read();
    } catch {
      result = { reason: 'unread' };
    }
    expect(result).toHaveProperty('reason');
  });
});

describe('a Critical fix, read adversarially: these are held', () => {
  it('a dependency added to an importer, moved to devDependencies, or given a peer-less alias', async () => {
    const extra = FIXED_LOCK.replace(
      '      pino:\n',
      '      long:\n        specifier: ^5.3.2\n        version: 5.3.2\n      pino:\n',
    );
    expect(await said(extra)).toMatch(/importer \. changes more/);
    const dev = FIXED_LOCK.replace('    dependencies:\n      pino:', '    devDependencies:\n      pino:');
    expect(await said(dev)).toMatch(/importer|sections/);
    const importer = FIXED_LOCK.replace(
      'packages:',
      '  tools:\n    dependencies:\n      long:\n        specifier: ^5.3.2\n        version: 5.3.2\n\npackages:',
    );
    expect(await said(importer)).toMatch(/other importers/);
    const range = FIXED_LOCK.replace('specifier: ^7.6.4', 'specifier: npm:left-pad-evil@^7.6.4');
    expect(await said(range)).toMatch(/do not move protobufjs's range alike/);
    const patched = FIXED_LOCK.replace(
      'settings:',
      'patchedDependencies:\n  long@5.3.2:\n    hash: abc\n    path: patches/long.patch\n\nsettings:',
    );
    expect(await said(patched)).toMatch(/other sections/);
  });

  it('an older second version of the fixed package kept beside the new one', async () => {
    const both = FIXED_LOCK.replace(
      '  protobufjs@7.6.6:\n    resolution: {integrity: sha512-p766}',
      '  protobufjs@7.6.4:\n    resolution: {integrity: sha512-p764}\n\n  protobufjs@7.6.6:\n    resolution: {integrity: sha512-p766}',
    );
    // Held either way: the old version's snapshot gone, or its finding still there.
    expect(await said(both)).toMatch(/no Critical fixed|drops protobufjs@7\.6\.4's snapshot/);
  });

  it('package.json: an override, a peer, a version, a registry in publishConfig, written as a range line', () => {
    const before =
      '{\n  "version": "1.0.0",\n  "dependencies": {\n    "a": "1.0.0"\n  },\n  "pnpm": {\n    "overrides": {\n      "a": "1.0.0"\n    }\n  },\n  "peerDependencies": {\n    "a": "1.0.0"\n  }\n}\n';
    for (const [line, now] of [
      ['  "version": "1.0.0"', '  "version": "1.0.1"'],
      ['      "a": "1.0.0"\n    }\n  },', '      "a": "1.0.1"\n    }\n  },'],
      ['"peerDependencies": {\n    "a": "1.0.0"', '"peerDependencies": {\n    "a": "1.0.1"'],
    ] as const)
      expect(manifestRanges(before, before.replace(line, now))).toHaveProperty('reason');
  });

  it('a Dockerfile FROM with a flag, another registry’s copy of the image, or a stage renamed', () => {
    const d = (c: string) => `sha256:${c.repeat(64)}`;
    const before = `FROM node:24.22.1-alpine3.24@${d('1')} AS build\n`;
    for (const now of [
      `FROM evil.example/library/node:24.22.1-alpine3.24@${d('3')} AS build\n`,
      `FROM ghcr.io/library/node:24.22.1-alpine3.24@${d('3')} AS build\n`,
      `FROM --platform=linux/amd64 node:24.22.1-alpine3.24@${d('3')} AS build\n`,
      `FROM node:24.22.1-alpine3.24@${d('3')} AS other\n`,
      `FROM node:24.22.1-alpine3.24@${d('3')} AS build # x\n`,
    ])
      expect(dockerfileMoves(before, now)).toHaveProperty('reason');
  });

  it('tags: a pin’s file name used as a prefix of another path, and any tag but the two', () => {
    const owned = (because: string[]): Found[] => [{ tag: 'code-owned', because } as Found];
    expect(fixTagsHold(owned(['Dockerfile (/Dockerfile)']))).toBeUndefined();
    expect(fixTagsHold(owned(['Dockerfile.evil (*)']))).toBeDefined();
    expect(fixTagsHold(owned(['pnpm-workspace.yaml (/pnpm-workspace.yaml)']))).toBeDefined();
    expect(fixTagsHold(owned(['.github/workflows/check.yml (/.github/)']))).toBeDefined();
    for (const tag of ['security-headers', 'test-loosening', 'improvement', 'release'])
      expect(fixTagsHold([{ tag, because: ['x'] } as Found])).toBeDefined();
  });
});
