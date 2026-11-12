/**
 * The pin guard as its attacker would try it: `commitPins` asked straight, through the live actions against the fake
 * GitHub, with what a watch gone wrong, or anyone who could ask the worker, might send. Each refusal is before GitHub is
 * asked to write anything; and no other action writes a pin branch.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { BranchRefused, PIN_PREFIX } from '../../src/github/branches.ts';
import { GitHubError } from '../../src/github/client.ts';
import { PatchRefused } from '../../src/github/patches.ts';
import { forbiddenPin, guardPinBranch, type PinCommit, pinBranchFor, treeSource } from '../../src/github/pin-guard.ts';
import { client, quiet, type Sent } from './fake.ts';
import { digest, FakeRepo, FILES, writes } from './pins-harness.ts';

const REPO = 'the-roganator/cv-software-factory';
const SIDECAR = `2.11.2@${digest('sidecar/old')}`;
const NEWER = `2.14.3@${digest('sidecar/new')}`;

function live(repo: FakeRepo) {
  const sent: Sent[] = [];
  const { github } = client(repo.routes(), sent);
  return { actions: new LiveActions(github), sent, github };
}

const asked = (repo: FakeRepo, over: Partial<PinCommit> = {}): PinCommit => ({
  branch: 'factory/pin/example-sidecar',
  base: repo.main,
  scanned: repo.main,
  message: 'chore(pin): move example/sidecar to 2.14.3',
  pins: [{ file: 'deploy/base/telemetry/values/logs.yaml', line: 4, from: SIDECAR, to: NEWER }],
  ...over,
});

/** Refused, as what kind, before anything was written. */
async function refuses(
  repo: FakeRepo,
  over: Partial<PinCommit>,
  kind: typeof BranchRefused | typeof PatchRefused,
  words: RegExp,
) {
  const { actions, sent } = live(repo);
  const error = await actions.commitPins(REPO, asked(repo, over)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(kind);
  expect((error as Error).message).toMatch(words);
  expect(writes(sent)).toEqual([]);
}

describe('the pin guard', () => {
  it('lets a commit replace the version or digest at a pin, and nothing else', async () => {
    const repo = new FakeRepo(FILES);
    const base = repo.main;
    const sha = await live(repo).actions.commitPins(REPO, asked(repo));
    expect(repo.refs.get('factory/pin/example-sidecar')).toBe(sha);
    const was = FILES['deploy/base/telemetry/values/logs.yaml'] as string;
    expect(repo.file(sha, 'deploy/base/telemetry/values/logs.yaml')).toBe(was.replace(SIDECAR, NEWER));
    for (const [path, text] of Object.entries(FILES))
      if (path !== 'deploy/base/telemetry/values/logs.yaml') expect(repo.file(sha, path)).toBe(text);
    expect(repo.main).toBe(base);
  });

  it('refuses a pin whose line has changed since the scan read it', async () => {
    const repo = new FakeRepo(FILES);
    const scanned = repo.main;
    repo.push({
      'deploy/base/telemetry/values/logs.yaml': (FILES['deploy/base/telemetry/values/logs.yaml'] as string).replace(
        '    tag',
        '    tag ',
      ),
    });
    await refuses(repo, { scanned }, PatchRefused, /has changed since the scan read it/);
  });

  it.each([
    ['latest', /not a version or a tag with its digest/],
    ['2.14.3@sha256:abc', /not a version or a tag with its digest/],
    [`2.14.3@${digest('x')}\n    evil: true`, /not a version or a tag with its digest/],
    [`2.14.3 @${digest('x')}`, /not a version or a tag with its digest/],
    ['2.14.3', /version alone where it pinned a digest/],
    [`main@${digest('x')}`, /tag main where it pinned 2\.11\.2: a tag that is not a version moves its digest alone/],
    [`2.14.3@${digest('x')}@${digest('y')}`, /not a version or a tag with its digest/],
  ])('refuses a target that is not a version or digest by the grammar: %j', async (to, words) => {
    const repo = new FakeRepo(FILES);
    await refuses(
      repo,
      { pins: [{ file: 'deploy/base/telemetry/values/logs.yaml', line: 4, from: SIDECAR, to }] },
      PatchRefused,
      words,
    );
  });

  it('moves the digest of a tag that is not a version, and never its name', async () => {
    const file = 'deploy/base/telemetry/values/debian.yaml';
    const [old, now] = [`bookworm@${digest('debian/old')}`, `bookworm@${digest('debian/new')}`];
    const repo = new FakeRepo({ ...FILES, [file]: `image:\n  tag: ${old}\n` });
    const sha = await live(repo).actions.commitPins(
      REPO,
      asked(repo, { pins: [{ file, line: 2, from: old, to: now }] }),
    );
    expect(repo.file(sha, file)).toBe(`image:\n  tag: ${now}\n`);
    await refuses(
      repo,
      { pins: [{ file, line: 2, from: old, to: `trixie@${digest('debian/new')}` }] },
      PatchRefused,
      /tag trixie where it pinned bookworm/,
    );
  });

  it('refuses a pin whose file is a symbolic link, though the contents API reads through it', async () => {
    const repo = new FakeRepo({
      ...FILES,
      'deploy/base/telemetry/values/link.yaml': { mode: '120000', text: 'deploy/base/telemetry/values/logs.yaml' },
    });
    await refuses(
      repo,
      { pins: [{ file: 'deploy/base/telemetry/values/link.yaml', line: 4, from: SIDECAR, to: NEWER }] },
      PatchRefused,
      /not an ordinary file in main \(mode 120000\)/,
    );
  });

  it('refuses a pin in a submodule, or in a file that is not there', async () => {
    const repo = new FakeRepo({ ...FILES, vendor: { mode: '160000', text: '' } });
    await refuses(
      repo,
      { pins: [{ file: 'vendor', line: 1, from: '1.0.0', to: '1.0.1' }] },
      PatchRefused,
      /mode 160000/,
    );
    await refuses(
      repo,
      { pins: [{ file: 'nowhere.yaml', line: 1, from: '1.0.0', to: '1.0.1' }] },
      PatchRefused,
      /not a file in main/,
    );
  });

  it.each([
    'factory/pin/../main',
    'factory/pin/a/b',
    'factory/pin/',
    'factory/pin/x.lock',
    'factory/pin/-x',
    'factory/pin/x..y',
    'factory/pin-next/example',
    'factory/1234-fix',
    'main',
    'dependabot/docker/x-1.0.0',
  ])('refuses a branch that is not a pin move’s own: %s', async (branch) => {
    const repo = new FakeRepo(FILES);
    await refuses(repo, { branch }, BranchRefused, /not a pin move's branch/);
  });

  it('makes every name a branch under factory/pin/, of one segment the guard takes', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (name) => {
        const branch = pinBranchFor(name);
        expect(branch.startsWith(PIN_PREFIX)).toBe(true);
        if (branch !== PIN_PREFIX) expect(() => guardPinBranch(branch)).not.toThrow();
      }),
    );
    expect(pinBranchFor('../../main')).toBe('factory/pin/main');
    expect(pinBranchFor('docker.io/library/postgres')).toBe('factory/pin/docker.io-library-postgres');
  });

  it('refuses two pins at one line', async () => {
    const repo = new FakeRepo(FILES);
    const pin = { file: 'deploy/base/telemetry/values/logs.yaml', line: 4, from: SIDECAR, to: NEWER };
    await refuses(
      repo,
      { pins: [pin, { ...pin, to: `2.14.4@${digest('z')}` }] },
      PatchRefused,
      /named twice in one pin move/,
    );
  });

  it.each([
    ['.github/workflows/check.yml', /workflow/],
    ['policy/vulnerabilities.ts', /rules of the line/],
    ['pnpm-lock.yaml', /lockfile/],
    ['apps/console/pnpm-lock.yaml', /lockfile/],
    ['pnpm-lock.dev.yaml', /lockfile/],
    ['apps/console/npm-shrinkwrap.json', /lockfile/],
    ['mise.toml', /toolchain/],
    ['mise.lock', /toolchain/],
    ['../outside.yaml', /not a plain path/],
    ['/etc/passwd', /not a plain path/],
  ])('refuses a pin in %s by its name', async (file, words) => {
    const repo = new FakeRepo({ ...FILES, [file.replace(/^\/|^\.\.\//, '')]: `version: ${SIDECAR}\n` });
    await refuses(repo, { pins: [{ file, line: 1, from: SIDECAR, to: NEWER }] }, PatchRefused, words);
    if (!file.startsWith('/') && !file.startsWith('..')) expect(forbiddenPin(file)).toBeDefined();
  });

  it('refuses a pin its line does not hold once as a word of its own', async () => {
    const repo = new FakeRepo({ ...FILES, 'twice.yaml': `a: 1.0.0 # was 1.0.0\nb: 11.0.0\n` });
    await refuses(
      repo,
      { pins: [{ file: 'twice.yaml', line: 1, from: '1.0.0', to: '1.0.1' }] },
      PatchRefused,
      /2 times/,
    );
    await refuses(
      repo,
      { pins: [{ file: 'twice.yaml', line: 2, from: '1.0.0', to: '1.0.1' }] },
      PatchRefused,
      /nowhere/,
    );
  });

  it('refuses a move that pins what it pins already, or nothing', async () => {
    const repo = new FakeRepo(FILES);
    await refuses(
      repo,
      { pins: [{ file: 'deploy/base/telemetry/values/logs.yaml', line: 4, from: SIDECAR, to: SIDECAR }] },
      PatchRefused,
      /already/,
    );
    await refuses(repo, { pins: [] }, PatchRefused, /moves nothing/);
  });

  it('makes no commit when main has moved since the watch read it', async () => {
    const repo = new FakeRepo(FILES);
    const base = repo.main;
    repo.push({ 'README.md': 'later\n' });
    const { actions, sent } = live(repo);
    const error = await actions.commitPins(REPO, asked(repo, { base, scanned: base })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).kind).toBe('conflict');
    expect(writes(sent)).toEqual([]);
  });

  it('refuses a tree GitHub cut short', async () => {
    const repo = new FakeRepo(FILES);
    const routes = repo
      .routes()
      .map((route) =>
        String(route.path).includes('trees')
          ? { ...route, answer: (s: Sent) => ({ body: { ...(route.answer(s).body as object), truncated: true } }) }
          : route,
      );
    const sent: Sent[] = [];
    const actions = new LiveActions(client(routes, sent).github);
    const error = await actions.commitPins(REPO, asked(repo)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PatchRefused);
    expect((error as Error).message).toMatch(/cut the tree .* short/);
    expect(writes(sent)).toEqual([]);
  });

  it.each(['factory/pin/example-sidecar', 'factory/pin-next/example-sidecar'])(
    'leaves no other action to write a pin branch: %s',
    async (branch) => {
      const repo = new FakeRepo(FILES);
      const { actions, sent } = live(repo);
      const commit = { branch, expectedHead: repo.main, message: 'x', changes: { additions: [], deletions: [] } };
      await expect(actions.setBranch(REPO, branch, repo.main, { force: true })).rejects.toBeInstanceOf(BranchRefused);
      await expect(actions.deleteBranch(REPO, branch)).rejects.toBeInstanceOf(BranchRefused);
      await expect(actions.commit(REPO, commit)).rejects.toBeInstanceOf(BranchRefused);
      await expect(
        actions.applyPatch(REPO, { branch, expectedHead: repo.main, patch: '', message: 'x' }),
      ).rejects.toBeInstanceOf(BranchRefused);
      const dry = new DryRunActions(new DiskArtifacts(mkdtempSync(join(tmpdir(), 'pin-guard-'))), quiet);
      await expect(dry.setBranch(REPO, branch, repo.main)).rejects.toBeInstanceOf(BranchRefused);
      await expect(dry.commit(REPO, commit)).rejects.toBeInstanceOf(BranchRefused);
      expect(writes(sent)).toEqual([]);
    },
  );

  it('refuses in a dry run what it refuses live, against the repository as GitHub has it', async () => {
    const repo = new FakeRepo(FILES);
    const sent: Sent[] = [];
    const { github } = client(repo.routes(), sent);
    const dry = new DryRunActions(
      new DiskArtifacts(mkdtempSync(join(tmpdir(), 'pin-guard-'))),
      quiet,
      undefined,
      undefined,
      undefined,
      undefined,
      treeSource(github),
    );
    await expect(dry.commitPins(REPO, asked(repo, { branch: 'main' }))).rejects.toBeInstanceOf(BranchRefused);
    await expect(
      dry.commitPins(REPO, asked(repo, { pins: [{ file: 'mise.toml', line: 2, from: '10.9.5', to: '10.9.6' }] })),
    ).rejects.toBeInstanceOf(PatchRefused);
    const sha = await dry.commitPins(REPO, asked(repo));
    expect(dry.commitMade(sha)?.files.get('deploy/base/telemetry/values/logs.yaml')).toContain(NEWER);
    expect(writes(sent)).toEqual([]);
  });
});

describe('the pin guard, as review found it', () => {
  it('refuses a number in a rule of the line CODEOWNERS gives Martin, and takes a pin under deploy/ or in a Dockerfile', async () => {
    const owners =
      '/.github/ @mrogan\n/deploy/ @mrogan\n/apps/factory/src/github/ @mrogan\n/apps/console/Dockerfile @mrogan\n';
    const repo = new FakeRepo({
      ...FILES,
      '.github/CODEOWNERS': owners,
      'apps/factory/src/github/pin-guard.ts': 'export const MAX_PINS = 20;\n',
      'apps/console/Dockerfile': `FROM node:24.1.0@${digest('node/old')}\n`,
    });
    await refuses(
      repo,
      { pins: [{ file: 'apps/factory/src/github/pin-guard.ts', line: 1, from: '20', to: '99' }] },
      PatchRefused,
      /a rule of the line CODEOWNERS gives a person/,
    );
    await live(repo).actions.commitPins(REPO, asked(repo));
    await live(repo).actions.commitPins(
      REPO,
      asked(repo, {
        branch: 'factory/pin/node',
        pins: [
          {
            file: 'apps/console/Dockerfile',
            line: 1,
            from: `24.1.0@${digest('node/old')}`,
            to: `24.1.1@${digest('node/new')}`,
          },
        ],
      }),
    );
  });

  it('refuses the Makefile by its name', async () => {
    const repo = new FakeRepo(FILES);
    await refuses(
      repo,
      { pins: [{ file: 'Makefile', line: 1, from: '10.9.5', to: '10.9.6' }] },
      PatchRefused,
      /Makefile/,
    );
  });

  it('keeps a byte-order mark, and every byte but the pin', async () => {
    const repo = new FakeRepo({ ...FILES, 'deploy/bom.yaml': '﻿tag: 1.0.0\n' });
    const sha = await live(repo).actions.commitPins(
      REPO,
      asked(repo, { pins: [{ file: 'deploy/bom.yaml', line: 1, from: '1.0.0', to: '1.0.1' }] }),
    );
    expect(repo.file(sha, 'deploy/bom.yaml')).toBe('﻿tag: 1.0.1\n');
  });

  it('refuses a version that is part of a path, not a word of its own', async () => {
    const repo = new FakeRepo({ ...FILES, 'deploy/url.yaml': 'url: https://example.test/v1.2.3/install.sh\n' });
    await refuses(
      repo,
      { pins: [{ file: 'deploy/url.yaml', line: 1, from: 'v1.2.3', to: 'v1.2.4' }] },
      PatchRefused,
      /nowhere/,
    );
  });

  it('gives a name ending .lock a branch the guard takes, within its length', () => {
    for (const name of ['example/foo.lock', `${'a'.repeat(75)}.lock`, 'x.lock'])
      expect(() => guardPinBranch(pinBranchFor(name))).not.toThrow();
  });
});
