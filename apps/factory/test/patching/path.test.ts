/**
 * How far each kind of move the scan can make of the app gets on its way to a pull request, on the code as it is: the
 * whole path in one piece (path.ts), where each step's own tests give it a move written by hand. A case that ends
 * short of a pull request with `gap` is a move the scan sends the line that the line cannot make; the gap says what
 * stops it. Fixing one changes its case here, to a pull request.
 */
import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/vulnerabilities/sarif.ts';
import type { ReadTarget } from '../../src/vulnerabilities/scan.ts';
import { type Carried, carry, fileOf, type World } from './path.ts';

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const NODE = 'node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85';
const DISTROLESS =
  'gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba';
const SYFT = 'ghcr.io/anchore/syft:v1.54.0@sha256:0356562f495d432056237fbea5cbc2d4839c9c75cd500784a66de2e7cc95ca7c';
const DEVCONTAINER =
  'mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae';
const OURS =
  'ghcr.io/the-roganator/cv-worlds-worst-website@sha256:0a04e1fd9bf6c935daf23027064c493bb8a59a5a2a913b3b7ed82aae2d4168d1';

const image = (kind: ReadTarget['kind'], file: string, line: number, reference: string): ReadTarget => ({
  key: `${file} ${reference.split('@')[0]?.replace(/:[^:/]+$/, '')}`,
  kind,
  file,
  label: reference,
  image: reference,
  name: reference,
  line,
});
const LOCK: ReadTarget = {
  key: 'lockfile pnpm-lock.yaml',
  kind: 'lockfile',
  file: 'pnpm-lock.yaml',
  label: 'pnpm-lock.yaml',
  name: 'pnpm-lock.yaml',
  line: 1,
};
const T = {
  lock: LOCK,
  ours: image('ours', 'deploy/overlays/local/image/kustomization.yaml', 6, OURS),
  dev: image('dockerfile', '.devcontainer/Dockerfile', 2, DEVCONTAINER),
  node: image('dockerfile', 'Dockerfile', 5, NODE),
  distroless: image('dockerfile', 'Dockerfile', 20, DISTROLESS),
  syft: image('workflow', 'deploy/images/syft/Dockerfile', 5, SYFT),
};
const TARGETS = Object.values(T);

let n = 0;
const found = (target: ReadTarget, over: Partial<Finding>): Finding => ({
  item: target.key,
  listed: target.name,
  label: target.label,
  file: target.file,
  line: target.line ?? 1,
  type: 'debian',
  package: 'libexample',
  installed: '1.0-1',
  fixed: '1.0-2',
  advisory: `CVE-2099-${1000 + ++n}`,
  severity: 'HIGH',
  ...over,
});
const npm = (pkg: string, installed: string, fixed: string, line: number, over: Partial<Finding> = {}) =>
  found(T.lock, { type: 'pnpm', package: pkg, installed, fixed, line, ...over });

const WORLD: World = {
  tags: {
    node: ['24.22.2-alpine3.24', '24.22.3-alpine3.24'],
    'gcr.io/distroless/nodejs24-debian13': ['nonroot'],
    'ghcr.io/anchore/syft': ['v1.54.0', 'v1.57.1'],
    'mcr.microsoft.com/devcontainers/base': ['ubuntu-24.04'],
  },
  digests: {
    'node:24.22.3-alpine3.24': digest('1'),
    'gcr.io/distroless/nodejs24-debian13:nonroot': digest('2'),
    'ghcr.io/anchore/syft:v1.57.1': digest('3'),
    'mcr.microsoft.com/devcontainers/base:ubuntu-24.04': digest('4'),
  },
  node: [
    { version: 'v24.22.3', date: '2026-11-01' },
    { version: 'v24.22.2', date: '2026-10-01' },
  ],
  published: {
    'example-direct@1.0.1': '2026-11-01T00:00:00Z',
    'example-indirect@3.2.1': '2026-11-01T00:00:00Z',
    'example-twice@6.11.5': '2026-11-01T00:00:00Z',
    'example-twice@7.6.6': '2026-11-01T00:00:00Z',
  },
  pnpm: {
    'example-direct@1.0.0': '1.0.1',
    'example-indirect@3.2.0': '3.2.1',
    'example-twice@6.11.0': '6.11.5',
    'example-twice@7.6.4': '7.6.6',
  },
};

interface Case {
  name: string;
  findings: () => Finding[];
  world?: World;
  /** Where each of the scan's moves ends, and the step's own words where it ends short. */
  ends: { ends: Carried['ends']; why?: string | RegExp; tags?: string[]; nodeApart?: true }[];
  /** What is wrong, for a move sent to the line that it cannot make, or makes wrongly. */
  gap?: string;
}

const NODE_ADVISORY = { type: 'node', package: 'node', installed: '24.22.2', fixed: '>=24.22.3' };

const CASES: Case[] = [
  {
    name: 'the lockfile: a direct package',
    findings: () => [npm('example-direct', '1.0.0', '1.0.1', 16)],
    ends: [{ ends: 'pull request', tags: ['dependency-change'] }],
  },
  {
    name: 'the lockfile: an indirect package',
    findings: () => [npm('example-indirect', '3.2.0', '3.2.1', 19)],
    ends: [{ ends: 'pull request', tags: ['dependency-change'] }],
  },
  {
    name: 'the lockfile: an indirect package its parents hold below the fix',
    findings: () => [npm('example-indirect', '3.2.0', '3.2.1', 19)],
    world: { ...WORLD, pnpm: {} },
    // By design: an override is pnpm-workspace.yaml's, which is Martin's.
    ends: [{ ends: 'pin step', why: /needs an override in pnpm-workspace\.yaml/ }],
  },
  {
    name: 'the lockfile: a package at two versions, one advisory of both',
    findings: () => [npm('example-twice', '6.11.0, 7.6.4', '6.11.5, 7.6.6', 28)],
    ends: [{ ends: 'never sent', why: /does not fit a signal \(move\.from/ }],
    gap: 'the scan names both versions in one finding, and a signal’s move is from one version',
  },
  {
    name: 'the lockfile: a package at two versions, an advisory of each',
    findings: () => [npm('example-twice', '6.11.0', '6.11.5', 28), npm('example-twice', '7.6.4', '7.6.6', 31)],
    ends: [
      { ends: 'pin step', why: '6.11.5,7.6.6 is not a version, so example-twice cannot move to it.' },
      { ends: 'pin step', why: '6.11.5,7.6.6 is not a version, so example-twice cannot move to it.' },
    ],
    gap: 'the sense joins the two moves’ versions with a comma, and the pin step reads one version',
  },
  {
    name: 'the lockfile: a package at two versions, an advisory of the newer alone',
    findings: () => [npm('example-twice', '7.6.4', '7.6.6', 31)],
    ends: [{ ends: 'pin step', why: /example-twice stays at 6\.11\.5: example-old@2\.0\.0 admit no 7\.6\.6/ }],
    gap: 'the pin step wants every copy at the target, so a copy on another major, with no advisory, holds the move for an override',
  },
  {
    name: 'the Dockerfile’s build stage: an operating system’s package in Node’s image',
    findings: () => [found(T.node, { type: 'alpine' })],
    ends: [{ ends: 'pull request', tags: ['code-owned'], nodeApart: true }],
    gap: 'the newest tag is a newer Node’s, and the image’s move leaves mise.toml and mise.lock behind',
  },
  {
    name: 'the Dockerfile’s build stage: Node’s own advisory',
    findings: () => [found(T.node, NODE_ADVISORY)],
    ends: [{ ends: 'pin step', why: 'mise.toml does not pin node at 24.22.2-alpine3.24.' }],
    gap: 'the scan names what the FROM pins, a tag, and the pin step reads a Node move’s `from` as mise.toml’s version',
  },
  {
    name: 'the Dockerfile’s runtime stage: an operating system’s package in its image',
    findings: () => [found(T.distroless, {})],
    ends: [{ ends: 'pull request', tags: ['code-owned'] }],
  },
  {
    name: 'the Dockerfile’s runtime stage: the same, in distroless as it is published',
    findings: () => [found(T.distroless, {})],
    world: { ...WORLD, undated: ['gcr.io/distroless/nodejs24-debian13:nonroot'] },
    ends: [],
    gap: 'distroless gives no time it was made, so its fix has no day, and the scan makes no move of it',
  },
  {
    name: 'the app’s image: a package its runtime stage brings',
    findings: () => {
      const base = found(T.distroless, {});
      return [base, found(T.ours, { advisory: base.advisory })];
    },
    ends: [{ ends: 'pull request', tags: ['code-owned'] }],
  },
  {
    name: 'the app’s image: Node’s own advisory',
    findings: () => [found(T.ours, NODE_ADVISORY)],
    ends: [{ ends: 'never sent', why: /a target of no ecosystem a signal names/ }],
    gap: 'the move is the runtime stage’s image to a version of Node, which the sense has no ecosystem for',
  },
  {
    name: 'deploy/images/syft/Dockerfile: Syft',
    findings: () => [
      found(T.syft, { type: 'gobinary', package: 'github.com/example/jose', installed: 'v4.1.5', fixed: '4.1.6' }),
    ],
    ends: [{ ends: 'guard', why: 'deploy/images/syft/Dockerfile: the pin step never writes it' }],
    gap: 'every move of the app’s is the line’s, and the line writes nothing under deploy/',
  },
  {
    name: '.devcontainer/Dockerfile: its base, built again',
    findings: () => [found(T.dev, { type: 'ubuntu' })],
    ends: [{ ends: 'pull request', tags: [] }],
  },
];

const whyOf = (each: Carried) => each.notSent ?? each.refused ?? each.heldForMartin ?? each.guard?.join('; ');

describe('a move of the app’s, from the scan’s finding to a pull request', () => {
  it('runs on the app’s pins as its repository has them', () => {
    for (const target of [T.node, T.distroless]) expect(fileOf('Dockerfile')).toContain(`FROM ${target.image}`);
    expect(fileOf('deploy/images/syft/Dockerfile')).toContain(`FROM ${SYFT}`);
    expect(fileOf('.devcontainer/Dockerfile')).toContain(`FROM ${DEVCONTAINER}`);
    expect(fileOf('mise.toml')).toMatch(/^node = "24\.22\.2"$/m);
  });

  for (const each of CASES)
    it(`${each.name}${each.gap ? ` (gap: ${each.gap})` : ''}`, async () => {
      const carried = await carry(each.findings(), TARGETS, each.world ?? WORLD);
      expect(carried.map((one) => one.move.lane)).toEqual(each.ends.map(() => 'line'));
      for (const [i, wanted] of each.ends.entries()) {
        const got = carried[i] as Carried;
        expect(got.ends, whyOf(got)).toBe(wanted.ends);
        if (typeof wanted.why === 'string') expect(whyOf(got)).toBe(wanted.why);
        else if (wanted.why) expect(whyOf(got)).toMatch(wanted.why);
        else expect(whyOf(got) ?? '').toBe('');
        if (wanted.tags) expect(got.tags).toEqual(wanted.tags);
        expect(got.nodeApart !== undefined, got.nodeApart).toBe(wanted.nodeApart ?? false);
      }
    });

  it('names every gap there is', () => {
    expect(CASES.filter((each) => each.gap).map((each) => each.name)).toMatchInlineSnapshot(`
      [
        "the lockfile: a package at two versions, one advisory of both",
        "the lockfile: a package at two versions, an advisory of each",
        "the lockfile: a package at two versions, an advisory of the newer alone",
        "the Dockerfile’s build stage: an operating system’s package in Node’s image",
        "the Dockerfile’s build stage: Node’s own advisory",
        "the Dockerfile’s runtime stage: the same, in distroless as it is published",
        "the app’s image: Node’s own advisory",
        "deploy/images/syft/Dockerfile: Syft",
      ]
    `);
  });
});
