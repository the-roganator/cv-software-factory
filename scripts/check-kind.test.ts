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
    'scripts/api-versions.ts',
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
