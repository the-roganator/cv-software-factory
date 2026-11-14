import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { admits, movedRange } from '../apps/runner/src/pins.ts';
import { APP_GATES, type CriticalFixIO, criticalFix, type Finding, type Scan } from './critical-fix.ts';
import type { Run } from './pin-move-ran.ts';

/**
 * A third independent read of the Critical fix's proof (ADR 0020), at 8721ddb7, where the gate writes the lockfile
 * itself. Each case in the first block is a change that should wait for Martin and passes the rule today, so it fails
 * here.
 *
 * Only two words cross from the head, the package's name and the version it moves to, and the second is the head's to
 * choose: it decides which range the pin step writes into `package.json`, and pnpm then resolves that range. So the
 * derivation proves the lockfile is pnpm's for the move, and not that the move is the one the fix needs.
 *
 * The first fixture is real: `is-number` at `5.0.0`, exact, locked by pnpm 12.16.1, and the files below are what the
 * pin step's own `writePins` wrote for `{ name: 'is-number', from: '5.0.0', to: '7.0.0' }`, run in a scratch checkout
 * with the pinned pnpm and the pin step's flags (each entry's `engines` line left out here). The same was seen on a
 * scratch clone of the app at 04900f5: for `@opentelemetry/sdk-node` from 0.300.0 with `to` 0.301.0, `writePins`
 * refuses nothing and writes `^0.301.2` over `^0.300.0` in package.json (192 lines added and 155 removed across the
 * two files): pnpm's `update` writes the newest version the moved range admits back as the range.
 */

const HEAD = 'a'.repeat(40);

const manifestAt = (range: string, name = 'is-number') =>
  `${JSON.stringify({ name: 'scratch', version: '0.0.0', private: true, dependencies: { [name]: range } }, null, 2)}\n`;

const INTEGRITY: Record<string, string> = {
  '5.0.0': 'sha512-LmVHHP5dTJwrwZg2Jjqp7K5jpvcnYvYD1LMpvGadMsMv5+WXoDSLBQ0+zmuBJmuZGh2J2K845ygj/YukxUnr4A==',
  '6.0.0': 'sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==',
  '7.0.0': 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
};

/** The lockfile pnpm 12.16.1 writes for one direct dependency with no dependencies of its own. */
const lockAt = (range: string, version: string, name = 'is-number', integrity = INTEGRITY[version] ?? 'sha512-x') =>
  `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      ${name}:
        specifier: ${range}
        version: ${version}

packages:

  ${name}@${version}:
    resolution: {integrity: ${integrity}}

snapshots:

  ${name}@${version}: {}
`;

/** A fake Trivy: each package from its key, and the advisories given for it at that version. */
function scanner(advisories: Record<string, Finding[]>) {
  return (text: string): Scan => {
    const entries = (parse(text) as { packages?: Record<string, unknown> }).packages ?? {};
    const packages = Object.keys(entries).map((key) => {
      const at = key.lastIndexOf('@');
      return { name: key.slice(0, at), version: key.slice(at + 1) };
    });
    return { packages, findings: packages.flatMap(({ name, version }) => advisories[`${name}@${version}`] ?? []) };
  };
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

interface Case {
  base: { manifest: string; lock: string };
  head: { manifest: string; lock: string };
  advisories: Record<string, Finding[]>;
  published: string[];
  /** What the pin step writes on the base for a move, by `name@from>to`: each file it changes. */
  derived: Record<string, Record<string, string>>;
}

function io(c: Case): CriticalFixIO {
  const scan = scanner(c.advisories);
  const fake: CriticalFixIO = {
    diff: async () => ({
      raw: [':100644 100644 1111111 2222222 M\tpackage.json', ':100644 100644 3333333 4444444 M\tpnpm-lock.yaml'].join(
        '\n',
      ),
      files: [
        { path: 'package.json', before: c.base.manifest, after: c.head.manifest },
        { path: 'pnpm-lock.yaml', before: c.base.lock, after: c.head.lock },
      ],
    }),
    lockfile: async (text) => scan(text),
    image: async () => {
      throw new Error('no image moves');
    },
    node: async () => [],
    tags: async () => [],
    digest: async () => {
      throw new Error('no tag');
    },
    runs: async () => passedGates(),
    derive: async (move) => {
      const written = c.derived[`${move.name}@${move.from}>${move.to}`];
      if (!written) throw new Error(`no derivation recorded for ${move.name}@${move.from}>${move.to}`);
      return written;
    },
    // Changed from the read: the registry's versions are no longer read, and the head's lockfile and manifest are read by a reader of their own, from the same files.
    head: async () =>
      Object.fromEntries(
        (await fake.diff()).files
          .filter((f) => f.path === 'pnpm-lock.yaml' || f.path === 'package.json')
          .map((f) => [f.path, f.after as string]),
      ),
    required: async () => [...Object.keys(APP_GATES), 'review'],
  };
  return fake;
}

const said = async (c: Case) => {
  const result = await criticalFix(io(c), HEAD);
  return 'reason' in result ? result.reason : `PASSED: ${result.title}`;
};

/** is-number 5.0.0 has a Critical whose only fix is 6.0.0, on the next major: the fix needs major 6, and no more. */
const IS_NUMBER: Omit<Case, 'head'> = {
  base: { manifest: manifestAt('5.0.0'), lock: lockAt('5.0.0', '5.0.0') },
  advisories: {
    'is-number@5.0.0': [{ id: 'CVE-2026-1', pkg: 'is-number', version: '5.0.0', fixed: '6.0.0', severity: 'CRITICAL' }],
  },
  published: ['5.0.0', '6.0.0', '7.0.0'],
  // Seen for real for 7.0.0, pnpm 12.16.1, `writePins` on the base: the move rewrites the range and the lockfile so.
  derived: {
    'is-number@5.0.0>6.0.0': { 'package.json': manifestAt('6.0.0'), 'pnpm-lock.yaml': lockAt('6.0.0', '6.0.0') },
    'is-number@5.0.0>7.0.0': { 'package.json': manifestAt('7.0.0'), 'pnpm-lock.yaml': lockAt('7.0.0', '7.0.0') },
  },
};

describe('a Critical fix, read a third time: these pass today and should be held', () => {
  it('sanity: the fix on the major it needs passes', async () => {
    const head = { manifest: manifestAt('6.0.0'), lock: lockAt('6.0.0', '6.0.0') };
    expect(await said({ ...IS_NUMBER, head })).toMatch(/^PASSED/);
  });

  // "Only what the fix needs moves", the pin step's "never across a major the fix does not need", and `theMove`'s own
  // words for it. The major is held only when the advisory names a fix on the major the package is on
  // (`fixesOnMajor(...).length && !sameMajor(to, from)`). When the fix is on a later major alone, any major at or
  // above it passes: here the fix is 6.0.0, the head writes 7.0.0 into package.json, the pin step's derivation follows
  // the head's word (it moves the range to whatever `to` is, seen for real), and the two agree byte for byte. A second
  // major's breaking changes, read by nobody, merge as a Critical's fix.
  it('holds the fixed package moved a major past the one its fix is on', async () => {
    const head = { manifest: manifestAt('7.0.0'), lock: lockAt('7.0.0', '7.0.0') };
    expect(await said({ ...IS_NUMBER, head })).not.toMatch(/^PASSED/);
  });

  // The same, where the app really has it: five of its direct dependencies are 0.x, behind a caret
  // (`@opentelemetry/sdk-node ^0.300.0` among them), where a minor is semver's breaking line, as the pin step's own
  // `admits` reads it. The fix, 0.300.1, is inside the base's range, so the pin step writes it with no change to
  // package.json. The head asks for 0.301.0 instead: `majorOf` reads both as major 0, the range is moved off its
  // line, and pnpm writes what the range now says.
  it('holds a 0.x dependency moved off its caret line when its fix is on that line', async () => {
    const name = 'otel-sdk';
    expect(admits('^0.300.0', '0.300.1')).toBe(true);
    expect(admits('^0.300.0', '0.301.0')).toBe(false);
    expect(movedRange('^0.300.0', '0.301.0')).toBe('^0.301.0');
    const at = (range: string, version: string) => ({
      manifest: manifestAt(range, name),
      lock: lockAt(range, version, name, `sha512-${version}`),
    });
    const moved = at('^0.301.0', '0.301.0');
    const c: Case = {
      base: at('^0.300.0', '0.300.0'),
      head: moved,
      advisories: {
        [`${name}@0.300.0`]: [
          { id: 'CVE-2026-2', pkg: name, version: '0.300.0', fixed: '0.300.1', severity: 'CRITICAL' },
        ],
      },
      published: ['0.300.0', '0.300.1', '0.301.0'],
      // The range does not admit 0.301.0, so the pin step moves it there first (`movePackage`), then pnpm resolves it.
      derived: {
        [`${name}@0.300.0>0.301.0`]: { 'package.json': moved.manifest, 'pnpm-lock.yaml': moved.lock },
        // Changed from the read: the move's target is now the gate's own, the fix 0.300.1, for which `pnpm update`
        // keeps the caret line and writes the range at what it took.
        [`${name}@0.300.0>0.300.1`]: {
          'package.json': at('^0.300.1', '0.300.1').manifest,
          'pnpm-lock.yaml': at('^0.300.1', '0.300.1').lock,
        },
      },
    };
    expect(await said(c)).not.toMatch(/^PASSED/);
  });
});

describe('a Critical fix, read a third time: these are held, and no other test has them', () => {
  // Seen for real: with the range moved to a release an hour old (typescript's nightly, exact), pnpm 12.16.1 writes
  // the lockfile at it and adds `minimumReleaseAgeExclude` to pnpm-workspace.yaml, so the derivation changes a file
  // the head may not, and the release-age rule cannot be passed by the head's choice of version.
  // Changed from the read: the head's version no longer steers the move, so the release inside the age is the
  // gate's own target, 6.0.0, and the head is at it.
  it('a version inside the release age: the derivation writes pnpm-workspace.yaml, which no head may', async () => {
    const head = { manifest: manifestAt('6.0.0'), lock: lockAt('6.0.0', '6.0.0') };
    const derived = {
      'is-number@5.0.0>6.0.0': {
        ...IS_NUMBER.derived['is-number@5.0.0>6.0.0'],
        'pnpm-workspace.yaml': 'minimumReleaseAgeExclude:\n  - is-number@6.0.0\n',
      },
    };
    expect(await said({ ...IS_NUMBER, head, derived })).toMatch(/the move changes pnpm-workspace\.yaml/);
  });

  it('a derivation that writes nothing, or the manifest alone, is not the head', async () => {
    const head = { manifest: manifestAt('6.0.0'), lock: lockAt('6.0.0', '6.0.0') };
    for (const written of [{}, { 'package.json': head.manifest }, { 'pnpm-lock.yaml': head.lock }])
      expect(await said({ ...IS_NUMBER, head, derived: { 'is-number@5.0.0>6.0.0': written } })).toMatch(
        /not the one this move writes/,
      );
  });
});
