import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LOGIN } from '../apps/factory/src/github/actions.ts';
import { DEPLOYS } from '../apps/factory/src/github/deploys.ts';
import { QUEUE_BRANCH } from './review-gate.ts';

/*
 * check.yml's `kind` job tells which checks can see what a change makes (scripts/check-kind.sh), and every check it
 * skips is one the ruleset counts as passed. So each kind is tried here on a commit made on a copy of the files it
 * reads, and anything it cannot tell must be `code`.
 */

const SCRIPT = resolve('scripts/check-kind.sh');
const APP = 'mrogan-software-factory[bot]';
const CONSOLE = 'deploy/overlays/local/console-image/kustomization.yaml';
const FACTORY = 'deploy/overlays/local/factory-image/kustomization.yaml';
const QUEUE = `refs/heads/gh-readonly-queue/main/pr-699-${'a'.repeat(40)}`;

/** The files the base commit holds: the pin files as they are, and a few that other kinds change. */
const BASE: Record<string, string> = {
  [CONSOLE]: readFileSync(CONSOLE, 'utf-8'),
  [FACTORY]: readFileSync(FACTORY, 'utf-8'),
  'deploy/base/postgres/statefulset.yaml': 'kind: StatefulSet\n',
  'deploy/base/console/deployment.yaml': 'kind: Deployment\n',
  'apps/console/src/main.ts': 'export {};\n',
  'CHANGELOG.md': '# Changelog\n',
  '.release-please-manifest.json': '{ ".": "1.0.0" }\n',
  'package.json': '{\n  "name": "software-factory",\n  "version": "1.0.0",\n  "private": true\n}\n',
};

/** Each image's digest in a pin file, in order. */
const digests = (source: string) => [...source.matchAll(/^- digest: (sha256:[0-9a-f]{64})$/gm)].map(([, d]) => d);
/** A pin file with its digests moved to new ones, as the App's deploy writes it. */
const moved = (file: string, digit = '1') =>
  (BASE[file] ?? '').replace(/^- digest: sha256:[0-9a-f]{64}$/gm, () => `- digest: sha256:${digit.repeat(64)}`);

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/**
 * A repository whose HEAD makes `change` on the base files, with any more the base holds: a file's new text, or null to
 * delete it, and a mode for any to change.
 */
function repository(
  change: Record<string, string | null>,
  modes: Record<string, string> = {},
  base: Record<string, string> = {},
) {
  const repo = mkdtempSync(join(tmpdir(), 'check-kind-'));
  repos.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf-8' });
  const write = (files: Record<string, string | null>) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) {
        rmSync(join(repo, file));
        continue;
      }
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), text);
    }
  };
  git('init', '--quiet', '--initial-branch=main');
  write({ ...BASE, ...base });
  git('add', '--all');
  git('commit', '--quiet', '--no-gpg-sign', '--message', 'base');
  write(change);
  git('add', '--all');
  for (const [file, mode] of Object.entries(modes)) git('update-index', `--chmod=${mode}`, file);
  git('commit', '--quiet', '--no-gpg-sign', '--allow-empty', '--message', 'change');
  return repo;
}

interface Run {
  event: 'pull_request' | 'merge_group' | 'push';
  author?: string;
  base?: string;
  branch?: string;
  /** What the API answers for the queue's pull request, or `fail`. */
  pull?: { login: string; base: string } | 'fail';
}

/** The kind the script prints for HEAD, and what it asked GitHub. */
function kind(repo: string, run: Run, args: string[] = []) {
  const bin = mkdtempSync(join(tmpdir(), 'check-kind-bin-'));
  repos.push(bin);
  const answer = run.pull === 'fail' || !run.pull ? '' : `${run.pull.login} ${run.pull.base}`;
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$*" >> "$0.asked"\n[ -n "$GH_ANSWER" ] || exit 1\necho "$GH_ANSWER"\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const result = spawnSync(SCRIPT, args, {
    cwd: repo,
    encoding: 'utf-8',
    env: {
      ...GIT_ENV,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: run.event,
      GITHUB_REPOSITORY: 'the-roganator/cv-software-factory',
      AUTHOR: run.author ?? '',
      GITHUB_BASE_REF: run.base ?? '',
      QUEUE_BRANCH: run.branch ?? '',
      GH_ANSWER: answer,
    },
  });
  expect(result.status).toBe(0);
  let asked: string[] = [];
  try {
    asked = readFileSync(join(bin, 'gh.asked'), 'utf-8').split('\n').filter(Boolean);
  } catch {}
  return { kind: result.stdout.trim(), asked };
}

const app = { event: 'pull_request', author: APP, base: 'main' } as const;
const queued = { event: 'merge_group', branch: QUEUE, pull: { login: APP, base: 'main' } } as const;
const both = [
  ['pull request', app],
  ['merge queue', queued],
] as const;

describe('a deploy', () => {
  it('is pinned in the files a deploy moves, by digest', () => {
    expect(digests(BASE[CONSOLE] ?? '')).toHaveLength(1);
    expect(digests(BASE[FACTORY] ?? '')).toHaveLength(3);
  });

  it.each(both)('is the App’s change of digests alone, in either pin file or both, on a %s', (_, run) => {
    expect(kind(repository({ [CONSOLE]: moved(CONSOLE), [FACTORY]: moved(FACTORY) }), run).kind).toBe('deploy');
    expect(kind(repository({ [CONSOLE]: moved(CONSOLE) }), run).kind).toBe('deploy');
    expect(kind(repository({ [FACTORY]: moved(FACTORY) }), run).kind).toBe('deploy');
    // Some of a file's digests, as when only some of its builds are newer.
    const one = (BASE[FACTORY] ?? '').replace(digests(BASE[FACTORY] ?? '')[1] ?? '', `sha256:${'2'.repeat(64)}`);
    expect(kind(repository({ [FACTORY]: one }), run).kind).toBe('deploy');
  });

  it("reads the queue's pull request from its branch, through the API", () => {
    const { asked } = kind(repository({ [CONSOLE]: moved(CONSOLE) }), queued);
    expect(asked).toEqual([
      'api repos/the-roganator/cv-software-factory/pulls/699 --jq "\\(.user.login) \\(.base.ref)"',
    ]);
  });

  it('is told by the login the App acts as, and the pin files its deploys in this repository write', () => {
    expect(APP_LOGIN).toBe(APP);
    const script = readFileSync(SCRIPT, 'utf-8');
    expect(script).toContain(`APP='${APP}'`);
    const ours = DEPLOYS.filter((d) => d.repo.endsWith('/cv-software-factory')).flatMap((d) =>
      d.pins.map((p) => p.file),
    );
    expect(ours.sort()).toEqual([CONSOLE, FACTORY]);
    for (const file of ours) expect(script).toContain(`=${file}\n`);
  });

  it("matches the queue's branch as the review gate does", () => {
    const script = readFileSync(SCRIPT, 'utf-8');
    expect(script).toContain(`QUEUE='${QUEUE_BRANCH.source.replaceAll('\\/', '/')}'`);
  });

  /** Changes to the pin files that are not a deploy's: each changes a line that is not a digest of an image. */
  const notPins: [string, Record<string, string | null>, Record<string, string>?][] = [
    ['an image’s name', { [CONSOLE]: moved(CONSOLE).replace('newName: ghcr.io', 'newName: docker.io') }],
    ['a comment', { [FACTORY]: moved(FACTORY).replace('# The line starts', '# Now the line starts') }],
    ['a resource', { [FACTORY]: moved(FACTORY).replace('- ../../../base/runners\n', '') }],
    ['an image added', { [CONSOLE]: `${moved(CONSOLE)}- digest: sha256:${'3'.repeat(64)}\n  name: other\n` }],
    ['a digest removed', { [CONSOLE]: moved(CONSOLE).replace(/^- digest: .*\n/m, '- ') }],
    ['a digest too short', { [CONSOLE]: moved(CONSOLE).replace(/[0-9a-f]{64}$/m, '1'.repeat(63)) }],
    ['a digest not hex', { [CONSOLE]: moved(CONSOLE).replace(/[0-9a-f]{64}$/m, 'A'.repeat(64)) }],
    ['a digest indented', { [CONSOLE]: moved(CONSOLE).replace('- digest:', '-  digest:') }],
    ['a digest in a document of its own', { [CONSOLE]: `${moved(CONSOLE)}---\n- digest: sha256:${'5'.repeat(64)}\n` }],
    ['a newline at the end', { [CONSOLE]: `${moved(CONSOLE)}\n` }],
    ['the file deleted', { [CONSOLE]: null }],
    ['its mode', { [CONSOLE]: moved(CONSOLE) }, { [CONSOLE]: '+x' }],
    [
      'a digest outside images',
      { [FACTORY]: moved(FACTORY).replace('replacements:\n', `replacements:\n- digest: sha256:${'4'.repeat(64)}\n`) },
    ],
  ];

  it.each(notPins)('is not a change of %s, on a pull request: anyone’s change of deploy/ only', (_, change, modes) => {
    expect(kind(repository(change, modes), app).kind).toBe('manifests');
  });

  it.each(notPins)('is not a change of %s, in the merge queue', (_, change, modes) => {
    expect(kind(repository(change, modes), queued).kind).toBe('code');
  });

  it('is not a digest moved beside it in another file, a new pin file too', () => {
    const other = 'deploy/overlays/local/image/kustomization.yaml';
    for (const change of [
      { [CONSOLE]: moved(CONSOLE), 'apps/console/src/main.ts': 'export const x = 1;\n' },
      { [CONSOLE]: moved(CONSOLE), 'deploy/base/console/deployment.yaml': 'kind: Deployment\n# moved\n' },
      { [CONSOLE]: moved(CONSOLE), [other]: BASE[CONSOLE] ?? '' },
      { [CONSOLE]: null, 'deploy/overlays/local/console-image/kustomization.yml': moved(CONSOLE) },
    ]) {
      expect(kind(repository(change), queued).kind).toBe('code');
      expect(kind(repository(change), app).kind).not.toBe('deploy');
    }
  });

  it('is not a file whose name holds both pin files', () => {
    const both = `${CONSOLE} ${FACTORY}`;
    const repo = () => repository({ [both]: moved(CONSOLE) }, {}, { [both]: BASE[CONSOLE] ?? '' });
    expect(kind(repo(), queued).kind).toBe('code');
    expect(kind(repo(), app).kind).toBe('manifests');
  });

  it('is the App’s and into main: anyone else’s, or into another branch, is not', () => {
    const pins = () => repository({ [CONSOLE]: moved(CONSOLE) });
    expect(kind(pins(), { ...app, author: 'mrogan' }).kind).toBe('manifests');
    expect(kind(pins(), { ...app, author: 'dependabot[bot]' }).kind).toBe('manifests');
    expect(kind(pins(), { ...app, base: 'deploy/other' }).kind).toBe('manifests');
    expect(kind(pins(), { ...queued, pull: { login: 'mrogan', base: 'main' } }).kind).toBe('code');
    expect(kind(pins(), { ...queued, pull: { login: APP, base: 'feat/below' } }).kind).toBe('code');
  });

  it('is code in the queue when the pull request cannot be found', () => {
    const pins = () => repository({ [CONSOLE]: moved(CONSOLE) });
    const failed = kind(pins(), { ...queued, pull: 'fail' });
    expect(failed.kind).toBe('code');
    expect(failed.asked).toHaveLength(1);
    // A branch that is not the queue's for main names no pull request, so nothing is asked.
    for (const branch of ['', 'refs/heads/deploy/local', 'refs/heads/gh-readonly-queue/other/pr-699-abcdef0']) {
      const { kind: found, asked } = kind(pins(), { ...queued, branch });
      expect(found).toBe('code');
      expect(asked).toEqual([]);
    }
  });

  it('is nothing at all, on any other event, or with no change', () => {
    expect(kind(repository({ [CONSOLE]: moved(CONSOLE) }), { event: 'push' }).kind).toBe('code');
    expect(kind(repository({}), app).kind).toBe('code');
    expect(kind(repository({}), queued).kind).toBe('code');
  });
});

describe('a release', () => {
  const release = {
    'CHANGELOG.md': '# Changelog\n\n## 1.1.0\n',
    '.release-please-manifest.json': '{ ".": "1.1.0" }\n',
    'package.json': (BASE['package.json'] ?? '').replace('1.0.0', '1.1.0'),
  };

  it('is the App’s, into main, changing the changelog, the manifest and the version alone', () => {
    expect(kind(repository(release), app).kind).toBe('release');
    expect(kind(repository(release), { ...app, base: 'other' }).kind).toBe('code');
    expect(kind(repository(release), { ...app, author: 'mrogan' }).kind).toBe('code');
    const named = (BASE['package.json'] ?? '').replace('software-factory', 'other');
    expect(kind(repository({ ...release, 'package.json': named }), app).kind).toBe('code');
    expect(kind(repository({ ...release, [CONSOLE]: moved(CONSOLE) }), app).kind).toBe('code');
  });

  it('runs everything in the merge queue', () => {
    expect(kind(repository(release), queued).kind).toBe('code');
  });
});

describe('a change of manifests', () => {
  it('is anyone’s change of deploy/ alone, but for the Postgres the browser tests run beside', () => {
    const manifest = { 'deploy/base/console/deployment.yaml': 'kind: Deployment\n# moved\n' };
    expect(kind(repository(manifest), { ...app, author: 'mrogan' }).kind).toBe('manifests');
    const postgres = { ...manifest, 'deploy/base/postgres/statefulset.yaml': 'kind: StatefulSet\n# moved\n' };
    expect(kind(repository(postgres), { ...app, author: 'mrogan' }).kind).toBe('code');
    // Moving a file into deploy/ counts the place it left.
    const into = { 'apps/console/src/main.ts': null, 'deploy/base/console/main.ts': 'export {};\n' };
    expect(kind(repository(into), { ...app, author: 'mrogan' }).kind).toBe('code');
  });

  it('runs everything in the merge queue', () => {
    const manifest = { 'deploy/base/console/deployment.yaml': 'kind: Deployment\n# moved\n' };
    expect(kind(repository(manifest), queued).kind).toBe('code');
  });
});

describe('the platform check (scripts/check-kind.sh platform)', () => {
  const platform = (change: Record<string, string | null>, run: Run) =>
    kind(repository(change), run, ['platform']).kind;
  const anyone = { event: 'pull_request', author: 'someone', base: 'main' } as const;

  it.each([
    ['a manifest', { 'deploy/base/console/deployment.yaml': 'kind: Deployment\nspec: {}\n' }],
    ['a chart’s values', { 'deploy/base/telemetry/values/loki.yaml': 'loki: {}\n' }],
    ['the cluster’s k3s', { 'deploy/k3d/cluster.yaml': 'image: rancher/k3s:v2\n' }],
    ['the Makefile, whose line installs Argo CD', { Makefile: 'ARGOCD_CHART := 11.0.0\n' }],
    ['mise’s pins, k3d’s among them', { 'mise.lock': '[tools.k3d]\n' }],
    ['a mise config that overrides its pins', { 'mise.local.toml': '[tools]\nk3d = "5.0.0"\n' }],
    ['a mise config in .config', { '.config/mise.toml': '[env]\n' }],
    ['the versions file mise reads', { '.tool-versions': 'kubectl 1.20.0\n' }],
    ['how files are checked out', { 'deploy/.gitattributes': '*.yaml text eol=crlf\n' }],
    ['the submodules Argo CD inits', { '.gitmodules': '[submodule "x"]\n' }],
    ['the workflow', { '.github/workflows/platform.yml': 'name: platform\n' }],
    ['a script it runs', { 'scripts/mark-refusals.sh': '#!/bin/sh\n' }],
    ['a script that decides it', { 'scripts/check-kind.sh': '#!/bin/sh\n' }],
    ['a module a record’s script imports', { 'policy/flags.ts': 'export {};\n' }],
    ['how a signature is read', { 'apps/factory/src/github/signatures.ts': 'export {};\n' }],
    ['deploy/ alongside code', { 'deploy/base/console/deployment.yaml': 'x\n', 'apps/console/src/main.ts': 'x\n' }],
  ])('runs a cluster for a change of %s, anyone’s, in either place', (_, change) => {
    expect(platform(change, anyone)).toBe('cluster');
    expect(platform(change, { event: 'merge_group', branch: QUEUE, pull: { login: 'someone', base: 'main' } })).toBe(
      'cluster',
    );
  });

  it('runs none for a change a cluster cannot see, a module beside one the scripts import among them', () => {
    expect(platform({ 'apps/console/src/main.ts': 'export const x = 1;\n' }, anyone)).toBe('none');
    expect(platform({ 'policy/triage.ts': 'export {};\n' }, anyone)).toBe('none');
    expect(platform({ 'apps/factory/src/scoreboard/figures.ts': 'export {};\n' }, anyone)).toBe('none');
    // The answer key's script runs only with the private checkout, which the check's runner never has.
    expect(platform({ 'apps/factory/src/scoreboard/key.ts': 'export {};\n' }, anyone)).toBe('none');
    expect(platform({ 'scripts/review-gate.ts': 'x\n' }, anyone)).toBe('none');
    expect(platform({ 'CHANGELOG.md': '# Changelog\n\n## 1.0.1\n' }, anyone)).toBe('none');
  });

  it.each(both)('runs none for the App’s deploy pin of our own images, on a %s (ADR 0017)', (_, run) => {
    expect(platform({ [CONSOLE]: moved(CONSOLE), [FACTORY]: moved(FACTORY) }, run)).toBe('none');
  });

  it('runs a cluster for the same move by anyone else, or that the queue cannot tell is the App’s', () => {
    expect(platform({ [CONSOLE]: moved(CONSOLE) }, anyone)).toBe('cluster');
    expect(platform({ [CONSOLE]: moved(CONSOLE) }, { ...queued, pull: 'fail' })).toBe('cluster');
  });

  it('refuses a mode it does not know', () => {
    const repo = repository({});
    expect(spawnSync(SCRIPT, ['other'], { cwd: repo, encoding: 'utf-8', env: GIT_ENV }).status).toBe(2);
  });
});

describe('what the platform check runs', () => {
  /** The scripts the cluster's job runs on the host, each a file the rule names. */
  const RUNS = [
    'scripts/admission-ready.sh',
    'scripts/wait-deployed.sh',
    'scripts/platform-watch.sh',
    'scripts/platform-pods.sh',
    'scripts/local-ca.ts',
    'scripts/share-key.ts',
    ...readdirSync('scripts')
      .filter((f) => /-refusals\.(sh|ts)$/.test(f))
      .map((f) => `scripts/${f}`),
  ];
  const rule = new RegExp(/^PLATFORM='(.+)'$/m.exec(readFileSync(SCRIPT, 'utf-8'))?.[1] ?? '^$');

  /**
   * Every file of this repository each script reaches: the scripts a shell script runs, and a module's imports. With
   * them, each workspace package (`@software-factory/…`) a module imports, which the walk does not follow into.
   */
  function reached(files: string[]) {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const queue = [...files];
    for (let file = queue.shift(); file; file = queue.shift()) {
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, 'utf-8');
      if (file.endsWith('.sh')) {
        // A script beside it, however it is named: `$here/x.ts`, `$(dirname "$0")/x.ts` or `scripts/x.ts`.
        for (const m of text.matchAll(/(?:\$here|\$\(dirname "\$0"\)|\bscripts)\/([\w-]+\.(?:ts|sh))\b/g))
          queue.push(`scripts/${m[1]}`);
        continue;
      }
      // Each module it imports or re-exports, or imports for its effect alone.
      for (const m of text.matchAll(/^(?:import|export) (?:[^;]*? from )?'([^']+)';$/gms)) {
        const from = m[1] ?? '';
        if (from.startsWith('.')) queue.push(join(dirname(file), from));
        else if (from.startsWith('@software-factory/')) packages.add(`${file} imports ${from}`);
      }
    }
    return { files: [...seen], packages: [...packages] };
  }

  it('names every file the scripts it runs reach, file by file', () => {
    const { files, packages } = reached(RUNS);
    // A workspace package's sources are not named: none is reached today, and one that is fails here, to be named.
    expect(packages).toEqual([]);
    expect(files).toEqual(
      expect.arrayContaining(['scripts/signed-by.ts', 'scripts/policy-hash.ts', 'policy/flags.ts']),
    );
    for (const file of files) expect(file, file).toMatch(rule);
  });
});

// A pin move of the App's (scripts/pin-move.ts) passes only once the job that runs its pin succeeded at its head, never
// skipped: so each pin it can pass is `code`, which runs them all.
describe('a pin move', () => {
  const ZAP = 'apps/console/zap/scan.ts';
  const pins: [string, string, string, string][] = [
    ["ZAP's image, which ZAP scan runs", ZAP, `const ZAP = 'zap:2.17.0@sha256:${'a'.repeat(64)}';\n`, 'b'],
    [
      "a Dockerfile's stage, which image builds builds",
      'apps/factory/Dockerfile',
      `FROM node:24@sha256:${'a'.repeat(64)}\n`,
      'b',
    ],
    [
      "Postgres, whose pin the tests' database is",
      'deploy/base/postgres/statefulset.yaml',
      `image: postgres:18@sha256:${'a'.repeat(64)}\n`,
      'b',
    ],
  ];
  for (const [what, file, text, digit] of pins)
    for (const [where, run] of both)
      it(`is code for ${what}, ${where}`, () => {
        const repo = repository({ [file]: text.replace(/a{64}/, digit.repeat(64)) }, {}, { [file]: text });
        expect(kind(repo, run).kind).toBe('code');
      });
});

/*
 * In the merge queue, `platform` makes no cluster when its own job made one from the same inputs at the pull request's
 * head and passed there (scripts/check-kind.sh, passed_at_head). Each case is a repository with main's line, the pull
 * request's head (refs/pull/7/head, fetched from itself as origin) and the queue's commit made on main, and a stand-in
 * for GitHub that answers each read the script makes from a table: one it does not hold fails, as GitHub failing would.
 */
describe('the queue’s cluster, made once already', () => {
  const REPO = 'the-roganator/cv-software-factory';
  const DEPLOYMENT = 'deploy/base/console/deployment.yaml';
  const WORKFLOW = '.github/workflows/platform.yml';
  const INPUTS: Record<string, string> = {
    [WORKFLOW]: 'name: platform\n',
    'scripts/admission-ready.sh': '#!/bin/sh\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  };
  /** An ISO time GitHub's way, `hours` ago. */
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');

  type Files = Record<string, string | null>;
  interface Line {
    /** What main changes after the head's base, a commit each, before the queue's commit is made on it. */
    main?: (Files | { modes: Record<string, string> } | { links: Record<string, string> })[];
    /** What the pull request changes. */
    head?: Files;
    /** What the queue's commit holds that the head did not: as if the head had moved since. */
    queue?: Files;
    /** Modes the queue's commit sets, or symlinks it makes, that the head did not. */
    queueModes?: Record<string, string>;
    queueLinks?: Record<string, string>;
  }

  /** The repository, at the queue's commit, with the head and the commit the queue's commit is made on. */
  function line({ main = [], head = { [DEPLOYMENT]: 'kind: Deployment\nspec: {}\n' }, ...queue }: Line) {
    const repo = mkdtempSync(join(tmpdir(), 'check-kind-queue-'));
    repos.push(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf-8' }).trim();
    const write = (files: Files) => {
      for (const [file, text] of Object.entries(files)) {
        if (text === null) rmSync(join(repo, file));
        else {
          mkdirSync(dirname(join(repo, file)), { recursive: true });
          writeFileSync(join(repo, file), text);
        }
      }
    };
    const link = (links: Record<string, string>) => {
      for (const [file, target] of Object.entries(links)) {
        rmSync(join(repo, file), { force: true });
        execFileSync('ln', ['-s', target, join(repo, file)]);
      }
    };
    const commit = (message: string) => {
      git('add', '--all');
      git('commit', '--quiet', '--no-gpg-sign', '--allow-empty', '--message', message);
      return git('rev-parse', 'HEAD');
    };
    git('init', '--quiet', '--initial-branch=main');
    write({ ...BASE, ...INPUTS });
    const base = commit('base');
    git('checkout', '--quiet', '-b', 'feature');
    write(head);
    const pr = commit('the change');
    git('checkout', '--quiet', 'main');
    for (const change of main) {
      if ('modes' in change) {
        for (const [file, mode] of Object.entries(change.modes as Record<string, string>))
          git('update-index', `--chmod=${mode}`, file);
        git('commit', '--quiet', '--no-gpg-sign', '--message', 'main moves a mode');
      } else if ('links' in change) {
        link(change.links as Record<string, string>);
        commit('main links');
      } else {
        write(change as Files);
        commit('main moves');
      }
    }
    const on = git('rev-parse', 'HEAD');
    git('checkout', '--quiet', '--detach');
    git('merge', '--quiet', '--squash', 'feature');
    write(queue.queue ?? {});
    link(queue.queueLinks ?? {});
    git('add', '--all');
    for (const [file, mode] of Object.entries(queue.queueModes ?? {})) git('update-index', `--chmod=${mode}`, file);
    git('commit', '--quiet', '--no-gpg-sign', '--allow-empty', '--message', 'the queue’s commit');
    git('update-ref', 'refs/pull/7/head', pr);
    git('remote', 'add', 'origin', repo);
    return { repo, base, head: pr, on };
  }

  /** What GitHub answers for the head: the pull request open into main, its job's run made a cluster and passed. */
  function github(head: string) {
    const created = ago(30);
    return {
      [`repos/${REPO}/pulls/7`]: {
        state: 'open',
        user: { login: 'someone' },
        created_at: created,
        base: { ref: 'main' },
        head: { sha: head, ref: 'feature', repo: { full_name: REPO } },
      } as Record<string, unknown>,
      [`repos/${REPO}/issues/7/events?per_page=100`]: [{ event: 'labeled' }] as unknown,
      [`repos/${REPO}/pulls?state=all&per_page=100&head=the-roganator%3Afeature`]: [
        { number: 7, state: 'open', closed_at: null },
      ] as unknown,
      [`repos/${REPO}/commits/${head}/pulls?per_page=100`]: [{ number: 7, head: { sha: head } }] as unknown,
      [`repos/${REPO}/commits/${head}/check-runs?check_name=platform&filter=all&per_page=100`]: {
        check_runs: [
          {
            id: 101,
            name: 'platform',
            head_sha: head,
            status: 'completed',
            conclusion: 'success',
            completed_at: ago(2),
            app: { slug: 'github-actions' },
            check_suite: { id: 11 },
          },
        ],
      } as { check_runs: Record<string, unknown>[] },
      [`repos/${REPO}/actions/runs?head_sha=${head}&event=pull_request&per_page=100`]: {
        workflow_runs: [
          {
            id: 501,
            check_suite_id: 11,
            path: WORKFLOW,
            event: 'pull_request',
            head_sha: head,
            head_branch: 'feature',
            created_at: ago(3),
            run_attempt: 1,
            repository: { full_name: REPO },
            head_repository: { full_name: REPO },
            pull_requests: [{ number: 7, base: { ref: 'main' } }],
          },
        ],
      } as { workflow_runs: Record<string, unknown>[] },
      [`repos/${REPO}/actions/runs/501/attempts/1/jobs?per_page=100`]: {
        jobs: [
          {
            id: 101,
            name: 'platform',
            conclusion: 'success',
            steps: [
              { name: 'Refuse a privileged context', conclusion: 'success' },
              { name: 'Make the cluster', conclusion: 'success' },
            ],
          },
        ],
      } as { jobs: Record<string, unknown>[] },
    };
  }
  type GitHub = ReturnType<typeof github>;

  /** What the script says in the queue (or `event`), and why, against GitHub's answers. */
  function decide(
    built: ReturnType<typeof line>,
    answers: Record<string, unknown>,
    { event = 'merge_group', skip = '' }: { event?: string; skip?: string } = {},
  ) {
    const bin = mkdtempSync(join(tmpdir(), 'check-kind-gh-'));
    repos.push(bin);
    writeFileSync(join(bin, 'answers.json'), JSON.stringify(answers));
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env bash',
        'shift; q=; path=',
        'while [ $# -gt 0 ]; do case $1 in --paginate) shift ;; --jq) q=$2; shift 2 ;; *) path=$1; shift ;; esac; done',
        'echo "$path" >> "$0.asked"',
        `body=$(jq -c --arg p "$path" 'if has($p) then .[$p] else error("none") end' '${join(bin, 'answers.json')}') || exit 1`,
        'if [ -n "$q" ]; then jq -r "$q" <<< "$body"; else printf "%s\\n" "$body"; fi',
      ].join('\n'),
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const result = spawnSync(SCRIPT, ['platform'], {
      cwd: built.repo,
      encoding: 'utf-8',
      env: {
        ...GIT_ENV,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: event,
        GITHUB_REPOSITORY: REPO,
        AUTHOR: 'someone',
        GITHUB_BASE_REF: 'main',
        QUEUE_BRANCH: `refs/heads/gh-readonly-queue/main/pr-7-${built.on}`,
        PLATFORM_SKIP: skip,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return { said: result.stdout.trim(), log: result.stderr };
  }
  const answered = (built: ReturnType<typeof line>, change: (answers: GitHub) => void = () => {}) => {
    const answers = github(built.head);
    change(answers);
    return decide(built, answers);
  };
  type Row = Record<string, unknown>;
  const headOf = (a: GitHub) => (a[`repos/${REPO}/pulls/7`] as { head: { sha: string } }).head.sha;
  const pull = (a: GitHub) => a[`repos/${REPO}/pulls/7`] as Row;
  const checksOf = (a: GitHub) =>
    a[`repos/${REPO}/commits/${headOf(a)}/check-runs?check_name=platform&filter=all&per_page=100`] as {
      check_runs: Row[];
    };
  const check = (a: GitHub) => checksOf(a).check_runs[0] as Row;
  const runsOf = (a: GitHub) =>
    (a[`repos/${REPO}/actions/runs?head_sha=${headOf(a)}&event=pull_request&per_page=100`] as { workflow_runs: Row[] })
      .workflow_runs;
  const run = (a: GitHub) => runsOf(a)[0] as Row;
  const job = (a: GitHub) =>
    (a[`repos/${REPO}/actions/runs/501/attempts/1/jobs?per_page=100`] as { jobs: Row[] }).jobs[0] as Row;
  const answer = (a: GitHub, path: string, body: unknown) => {
    Object.assign(a, { [`repos/${REPO}/${path}`]: body });
  };
  const unanswered = (a: GitHub, path: string) => {
    Reflect.deleteProperty(a, `repos/${REPO}/${path}`);
  };
  const fork = { full_name: 'someone/fork' };

  it('makes no cluster when the queue’s inputs are the head’s, where its own job made one and passed', () => {
    const built = line({});
    const { said, log } = answered(built);
    expect(said).toBe('matched');
    expect(log).toMatch(
      new RegExp(
        `No cluster in the queue: its inputs are those at #7's head ${built.head.slice(0, 7)}, where run 501 made a cluster`,
      ),
    );
    expect(log).toContain('set the repository variable PLATFORM_SKIP to off');
    // The hash, said for the queue's commit, is the one it matched.
    const hash = /^Inputs at [0-9a-f]{7}: ([0-9a-f]{40})$/m.exec(log)?.[1];
    expect(log).toContain(`(inputs ${hash})`);
  });

  it('makes one on a pull request, whatever GitHub says of its head', () => {
    const built = line({});
    expect(decide(built, github(built.head), { event: 'pull_request' }).said).toBe('cluster');
  });

  it.each(['off', 'OFF', 'false', '0'])('makes one when the repository variable says %s', (skip) => {
    const built = line({});
    const { said, log } = decide(built, github(built.head), { skip });
    expect(said).toBe('cluster');
    expect(log).toContain(`PLATFORM_SKIP is ${skip}`);
  });

  it('makes none when the repository variable says on', () => {
    const built = line({});
    expect(decide(built, github(built.head), { skip: 'on' }).said).toBe('matched');
  });

  it.each<[string, Line]>([
    ['an input’s text', { queue: { [DEPLOYMENT]: 'kind: Deployment\nspec: { replicas: 2 }\n' } }],
    ['an input’s mode', { queueModes: { 'scripts/admission-ready.sh': '+x' } }],
    ['an input deleted', { queue: { 'scripts/admission-ready.sh': null } }],
    ['an input made a symlink to the same text', { queueLinks: { 'scripts/admission-ready.sh': '../BASE' } }],
    ['the workflow itself, which the head’s run ran its own copy of', { queue: { [WORKFLOW]: 'name: other\n' } }],
    ['the lockfile, which installs what the scripts import', { queue: { 'pnpm-lock.yaml': 'lockfileVersion: 9.1\n' } }],
    ['a package’s manifest', { queue: { 'apps/factory/package.json': '{}\n' } }],
  ])('makes one when the queue’s commit differs from the head in %s', (_, change) => {
    const { said, log } = answered(line(change));
    expect(said).toBe('cluster');
    expect(log).toMatch(/the inputs at the queue's commit \([0-9a-f]{40}\) are not those at #7's head/);
  });

  it('makes one when main moved an input since the head’s base, and the head’s run saw main without it', () => {
    const { said } = answered(line({ main: [{ 'scripts/admission-ready.sh': '#!/bin/sh\nexit 0\n' }] }));
    expect(said).toBe('cluster');
  });

  it('makes one when main moved an input and back, so a run of the head in between merged it with the move', () => {
    const { said, log } = answered(
      line({
        main: [
          { 'scripts/admission-ready.sh': '#!/bin/sh\nexit 1\n' },
          { 'scripts/admission-ready.sh': '#!/bin/sh\n' },
        ],
      }),
    );
    expect(said).toBe('cluster');
    expect(log).toMatch(/[0-9a-f]{7}, on main since the head's base, changes scripts\/admission-ready\.sh/);
  });

  it('makes one when main moved an input’s mode and back', () => {
    const { said } = answered(
      line({
        main: [{ modes: { 'scripts/admission-ready.sh': '+x' } }, { modes: { 'scripts/admission-ready.sh': '-x' } }],
      }),
    );
    expect(said).toBe('cluster');
  });

  it('makes none when main moved only what a cluster is not made from, or the App’s pins of our own images', () => {
    const built = line({
      main: [
        { 'apps/console/src/main.ts': 'export const x = 2;\n' },
        { [CONSOLE]: moved(CONSOLE), [FACTORY]: moved(FACTORY) },
      ],
    });
    expect(answered(built).said).toBe('matched');
  });

  it('makes one when main moved a pin file in more than its digests', () => {
    const built = line({ main: [{ [CONSOLE]: `${moved(CONSOLE)}# and more\n` }, { [CONSOLE]: moved(CONSOLE) }] });
    expect(answered(built).said).toBe('cluster');
  });

  it.each<[string, (a: GitHub) => void, string]>([
    ['no earlier pass', (a) => Object.assign(checksOf(a), { check_runs: [] }), 'has a platform job at'],
    ['an earlier failure', (a) => Object.assign(check(a), { conclusion: 'failure' }), 'is completed, failure'],
    [
      'a run not finished',
      (a) => Object.assign(check(a), { status: 'in_progress', conclusion: null }),
      'is in_progress',
    ],
    [
      'a re-run of the pass that was cancelled',
      (a) => checksOf(a).check_runs.push({ ...check(a), id: 102, conclusion: 'cancelled' }),
      'is completed, cancelled',
    ],
    [
      'a pass beside another run of the workflow that failed',
      (a) => {
        checksOf(a).check_runs.push({ ...check(a), id: 99, conclusion: 'failure', check_suite: { id: 12 } });
        runsOf(a).push({ ...run(a), id: 502, check_suite_id: 12 });
      },
      'in run 502, is completed, failure',
    ],
    [
      'a `which` that said none, so the job was skipped',
      (a) => Object.assign(check(a), { conclusion: 'skipped' }),
      'is completed, skipped',
    ],
    [
      'a job that passed without making the cluster',
      (a) => Object.assign(job(a), { steps: [{ name: 'Make the cluster', conclusion: 'skipped' }] }),
      'did not make a cluster',
    ],
    [
      'a check run no job of the run is, as one made through the API would be',
      (a) => Object.assign(job(a), { id: 999 }),
      'did not make a cluster',
    ],
    [
      'a pass by another workflow',
      (a) => Object.assign(run(a), { path: '.github/workflows/check.yml' }),
      'platform job at',
    ],
    ['a pass by another app', (a) => Object.assign(check(a), { app: { slug: 'some-app' } }), 'platform job at'],
    ['a check run of another name', (a) => Object.assign(check(a), { name: 'platform-ish' }), 'platform job at'],
    ['a run of another event', (a) => Object.assign(run(a), { event: 'merge_group' }), 'platform job at'],
    ['a run in another repository', (a) => Object.assign(run(a), { repository: fork }), 'platform job at'],
    ['a run from a fork', (a) => Object.assign(run(a), { head_repository: fork }), 'platform job at'],
    ['a head in a fork', (a) => Object.assign(pull(a).head as Row, { repo: fork }), 'head is in someone/fork'],
    ['a run from another branch', (a) => Object.assign(run(a), { head_branch: 'other' }), 'platform job at'],
    ['a run made before the pull request', (a) => Object.assign(run(a), { created_at: ago(40) }), 'platform job at'],
    [
      'a run for another pull request',
      (a) => Object.assign(run(a), { pull_requests: [{ number: 8, base: { ref: 'main' } }] }),
      'platform job at',
    ],
    [
      'a run into another base',
      (a) => Object.assign(run(a), { pull_requests: [{ number: 7, base: { ref: 'next' } }] }),
      'platform job at',
    ],
    ['a pass older than a day', (a) => Object.assign(check(a), { completed_at: ago(25) }), 'more than 24 hours ago'],
    [
      'a pass at no time GitHub names',
      (a) => Object.assign(check(a), { completed_at: null }),
      'named no time platform',
    ],
    ['a pull request closed', (a) => Object.assign(pull(a), { state: 'closed' }), '#7 is closed'],
    ['a pull request into another base', (a) => Object.assign(pull(a), { base: { ref: 'next' } }), 'into next'],
    [
      'a head GitHub names that is not the one fetched',
      (a) => Object.assign(pull(a).head as Row, { sha: 'f'.repeat(40) }),
      "#7's head moved",
    ],
    [
      'a base changed',
      (a) => answer(a, 'issues/7/events?per_page=100', [{ event: 'base_ref_changed' }]),
      "#7's base was changed",
    ],
    [
      'a base GitHub changed itself',
      (a) => answer(a, 'issues/7/events?per_page=100', [{ event: 'automatic_base_change_succeeded' }]),
      "#7's base was changed",
    ],
    [
      'another pull request from the same branch, closed since this one opened',
      (a) =>
        answer(a, 'pulls?state=all&per_page=100&head=the-roganator%3Afeature', [
          { number: 7, state: 'open' },
          { number: 9, state: 'closed', closed_at: ago(1) },
        ]),
      '#9 comes from the same branch',
    ],
    [
      'another pull request with the same head',
      (a) =>
        answer(a, `commits/${headOf(a)}/pulls?per_page=100`, [
          { number: 7, head: { sha: headOf(a) } },
          { number: 9, head: { sha: headOf(a) } },
        ]),
      '#9 has the same head',
    ],
    [
      'GitHub failing to list the jobs',
      (a) => unanswered(a, 'actions/runs/501/attempts/1/jobs?per_page=100'),
      "GitHub did not list run 501's jobs",
    ],
    [
      'GitHub failing to list the events',
      (a) => unanswered(a, 'issues/7/events?per_page=100'),
      "GitHub did not list #7's events",
    ],
  ])('makes one on %s', (_, change, why) => {
    const { said, log } = answered(line({}), change);
    expect(said).toBe('cluster');
    expect(log).toContain(why);
  });

  it('reads lists longer than one argument may be on Linux (128 KiB), as every workflow’s runs at a head are', () => {
    const built = line({});
    const { said } = answered(built, (a) => {
      const others = Array.from({ length: 200 }, (_, i) => ({
        ...run(a),
        id: 1000 + i,
        check_suite_id: 2000 + i,
        path: '.github/workflows/check.yml',
        display_title: 'x'.repeat(1000),
      }));
      runsOf(a).push(...others);
    });
    expect(said).toBe('matched');
  });

  it('makes none beside another pull request from the same branch closed before this one opened', () => {
    const built = line({});
    const { said } = answered(built, (a) =>
      answer(a, 'pulls?state=all&per_page=100&head=the-roganator%3Afeature', [
        { number: 7, state: 'open' },
        { number: 5, state: 'closed', closed_at: ago(31) },
      ]),
    );
    expect(said).toBe('matched');
  });

  it('takes a pass of an earlier attempt that a later attempt of the same run passed again', () => {
    const built = line({});
    const { said } = answered(built, (a) => {
      checksOf(a).check_runs.push({ ...check(a), id: 103 });
      Object.assign(run(a), { run_attempt: 2 });
      answer(a, 'actions/runs/501/attempts/2/jobs?per_page=100', { jobs: [{ ...job(a), id: 103 }] });
    });
    expect(said).toBe('matched');
  });

  it('makes one when the queue’s branch names no pull request', () => {
    const built = line({});
    const answers = github(built.head);
    const bad = { ...built, on: 'not-a-sha' };
    expect(decide(bad, answers).said).toBe('cluster');
  });

  // Review (read1): files outside PLATFORM|INSTALLS that change what platform.yml's job runs. mise-action reads every
  // mise config file in the checkout, not only mise.toml and mise.lock; checkout applies .gitattributes.
  it.each<[string, Files]>([
    ['mise.local.toml, which overrides mise.toml’s tool pins', { 'mise.local.toml': '[tools]\nk3d = "5.0.0"\n' }],
    ['.config/mise.toml, whose [env] mise-action exports', { '.config/mise.toml': '[env]\n_.source = "x.sh"\n' }],
    ['.tool-versions, which mise reads as a config', { '.tool-versions': 'kubectl 1.20.0\n' }],
    ['.gitattributes, which changes the bytes checked out', { '.gitattributes': '*.sh text eol=crlf\n' }],
  ])('makes one when main, or an entry ahead in the queue, changed %s since the head’s run', (_, files) => {
    const { said } = answered(line({ main: [files] }));
    expect(said).toBe('cluster');
  });
});

describe('the platform check’s paths, however git would quote them', () => {
  it('runs a cluster for a change under deploy/ whose path git quotes', () => {
    const repo = repository({ 'deploy/base/"quoted".yaml': 'x\n' });
    expect(kind(repo, { event: 'pull_request', author: 'someone', base: 'main' }, ['platform']).kind).toBe('cluster');
  });
});
