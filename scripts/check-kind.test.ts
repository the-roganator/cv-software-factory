import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
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
    // Fail closed: a path in no excluded class is an input, whatever it is.
    ['a file at the root that no rule names', { 'something.conf': 'x\n' }],
    ['a file in a directory that is new', { 'tools/new/thing.sh': '#!/bin/sh\n' }],
    ['lefthook.yml, which pnpm install’s prepare script reads', { 'lefthook.yml': 'pre-commit: {}\n' }],
  ])('runs a cluster for a change of %s, anyone’s, in either place', (_, change) => {
    expect(platform(change, anyone)).toBe('cluster');
    expect(platform(change, { event: 'merge_group', branch: QUEUE, pull: { login: 'someone', base: 'main' } })).toBe(
      'cluster',
    );
  });

  it.each([
    ['the image sources', { 'apps/console/src/main.ts': 'export const x = 1;\n', 'policy/triage.ts': 'export {};\n' }],
    ['a module beside one the scripts import', { 'apps/factory/src/scoreboard/figures.ts': 'export {};\n' }],
    ['the docs and the changelog', { 'docs/x.md': '# x\n', 'CHANGELOG.md': '# Changelog\n\n## 1.0.1\n' }],
    ['a test of the scripts', { 'scripts/review-gate.test.ts': 'x\n' }],
    ['another workflow', { '.github/workflows/check.yml': 'name: check\n', '.github/CODEOWNERS': '* @x\n' }],
    ['Claude Code’s files and the dev container’s', { '.claude/x.md': 'x\n', '.devcontainer/Dockerfile': 'FROM x\n' }],
    ['the lockfile and the manifests', { 'pnpm-lock.yaml': 'lockfileVersion: 9.1\n', 'package.json': '{}\n' }],
  ])('runs none for a change of %s alone', (_, change) => {
    expect(platform(change, anyone)).toBe('none');
  });

  it.each(both)('runs none for the App’s deploy pin of our own images, on a %s (ADR 0017)', (_, run) => {
    expect(platform({ [CONSOLE]: moved(CONSOLE), [FACTORY]: moved(FACTORY) }, run)).toBe('none');
  });

  it('runs a cluster for the App’s move that also takes a pin file’s last newline, which is no digest', () => {
    const run = { event: 'pull_request', author: APP, base: 'main' } as const;
    expect(platform({ [CONSOLE]: moved(CONSOLE).replace(/\n$/, '') }, run)).toBe('cluster');
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

/*
 * The rule fails closed: every path is an input but those in a class a cluster is not made from (scripts/check-kind.sh,
 * EXCLUDED_CLASSES), and each class stands only while its reason does. The reasons, each held here: nothing the
 * cluster's job runs reads a file in one (the job's steps, the Makefile's targets they run, the scripts those run and
 * the modules they import, followed file by file); the image sources reach the cluster only as images built on main and
 * pinned by digest, which `make up` builds none of; and the job runs no workflow but its own.
 */
describe('the classes a cluster is not made from', () => {
  const WORKFLOW = '.github/workflows/platform.yml';
  /** Of these paths, those the rule takes as inputs, as the script itself decides. */
  const inputsOf = (paths: string[]) =>
    new Set(
      execFileSync(SCRIPT, ['inputs'], { input: paths.map((p) => `${p}\n`).join(''), encoding: 'utf-8' })
        .split('\n')
        .filter(Boolean),
    );

  type Job = { steps?: { name?: string; run?: string; uses?: string }[] };
  const workflow = parse(readFileSync(WORKFLOW, 'utf-8')) as { jobs: Record<string, Job> };
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

  /** Text with its comments taken out: a shell's or make's `#` lines, and a module's `//` and block comments. */
  const code = (file: string, text: string) =>
    /\.(ts|js|mjs|cjs)$/.test(file)
      ? text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
      : text.replace(/^\s*@?#.*$/gm, '');

  /** The Makefile's variables (with `define` blocks) and its rules, each target's prerequisites and recipe. */
  function makefile() {
    const lines = readFileSync('Makefile', 'utf-8').split('\n');
    const variables = new Map<string, string>();
    const rules = new Map<string, { needs: string[]; recipe: string }>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const define = /^define (\S+)$/.exec(line);
      if (define) {
        const body: string[] = [];
        for (i++; i < lines.length && lines[i] !== 'endef'; i++) body.push(lines[i] ?? '');
        variables.set(define[1] ?? '', body.join('\n'));
        continue;
      }
      const variable = /^([A-Za-z_-]+) *(?::=|\?=|=)(.*)$/.exec(line);
      if (variable) {
        const body = [variable[2] ?? ''];
        while (body.at(-1)?.endsWith('\\') && i + 1 < lines.length) body.push(lines[++i] ?? '');
        variables.set(variable[1] ?? '', body.join('\n'));
        continue;
      }
      const rule = /^([a-z0-9_-]+):(?!=)([^#]*?)(?:##.*)?$/.exec(line);
      if (rule && !/\boverride\b|:=/.test(rule[2] ?? '')) {
        const recipe: string[] = [];
        while (i + 1 < lines.length && (lines[i + 1] ?? '').startsWith('\t')) recipe.push(lines[++i] ?? '');
        const held = rules.get(rule[1] ?? '');
        rules.set(rule[1] ?? '', {
          needs: [...(held?.needs ?? []), ...(rule[2] ?? '').trim().split(/\s+/).filter(Boolean)],
          recipe: [held?.recipe ?? '', ...recipe].join('\n'),
        });
      }
    }
    return { variables, rules };
  }

  /**
   * What the cluster's job runs: each step's command, and what `make` runs of the Makefile for the targets they name:
   * each target's recipe, the targets it needs and those its recipe makes (`$(MAKE) <target>`), and the variables and
   * functions it uses.
   */
  function runs() {
    const { variables, rules } = makefile();
    const texts: string[] = [];
    const seenRules = new Set<string>();
    const seenVariables = new Set<string>();
    const queue: { text: string; recipe: boolean }[] = steps
      .map((step) => ({ text: step.run ?? '', recipe: false }))
      .filter((each) => each.text);
    const make = (target: string) => {
      const rule = rules.get(target);
      if (!rule || seenRules.has(target)) return;
      seenRules.add(target);
      queue.push({ text: rule.recipe, recipe: true });
      for (const need of rule.needs) make(need);
    };
    for (let next = queue.shift(); next; next = queue.shift()) {
      let text = code('Makefile', next.text);
      // A loop's names spelled out: `for script in a b; do scripts/$script-refusals.sh` runs scripts/a-refusals.sh too.
      for (const [, name, words] of text.matchAll(/\bfor (\w+) in ([\w -]+); do\b/g))
        for (const m of text.matchAll(new RegExp(`scripts/\\$\\{?${name}\\}?([\\w.-]+)`, 'g')))
          text += `\n${(words ?? '')
            .trim()
            .split(/\s+/)
            .map((word) => `scripts/${word}${m[1]}`)
            .join('\n')}`;
      texts.push(text);
      const called = next.recipe
        ? [...text.matchAll(/\$\(MAKE\)(?:\s+--?[a-z-]+)*\s+([a-z][a-z0-9-]*)/g)].map((m) => m[1] ?? '')
        : [...text.matchAll(/^\s*(?:setsid\s+)?make((?:\s+[a-z][a-z0-9-]*)+)/gm)].flatMap((m) =>
            (m[1] ?? '').trim().split(/\s+/),
          );
      for (const target of called) make(target);
      for (const m of text.matchAll(/\$\((?:call )?([A-Za-z_-]+)[,)]/g)) {
        const name = m[1] ?? '';
        if (!variables.has(name) || seenVariables.has(name)) continue;
        seenVariables.add(name);
        queue.push({ text: variables.get(name) ?? '', recipe: true });
      }
    }
    return { texts, targets: [...seenRules] };
  }

  /**
   * What `make up` names but the job never runs: the answer key's script runs only with the private checkout
   * (PRIVATE_DIR), which the check's runner never has.
   */
  const NEVER_ON_THE_RUNNER = ['scripts/answer-key.ts'];

  /** The top-level entries of the repository, which a path the job names begins with. */
  const TOP = readdirSync('.').filter((entry) => !['.git', 'node_modules'].includes(entry));
  const PATH = new RegExp(
    `(?<![\\w.-])(?:\\.\\./)*((?:${TOP.map((t) => t.replace(/\./g, '\\.')).join('|')})(?:/[\\w.@-]*[\\w@-])+)`,
    'g',
  );

  /**
   * Every path of the repository the job's code names, comments aside, and every file it reaches: the scripts and
   * modules it runs, a shell script's neighbours however it names them, and each module's imports.
   */
  function reached() {
    const { texts } = runs();
    const named = new Set<string>();
    const files = new Set<string>();
    const packages: string[] = [];
    const queue: { file: string; text: string }[] = texts.map((text) => ({ file: 'Makefile', text }));
    const follow = (path: string) => {
      if (NEVER_ON_THE_RUNNER.includes(path)) return;
      if (/\.(sh|ts|js|mjs|cjs)$/.test(path) && !files.has(path) && existsSync(path)) {
        files.add(path);
        queue.push({ file: path, text: readFileSync(path, 'utf-8') });
      }
    };
    for (let next = queue.shift(); next; next = queue.shift()) {
      // The rule itself names the classes it reads past, and reads every file through git, never one by its name.
      if (next.file === 'scripts/check-kind.sh') continue;
      const text = code(next.file, next.text);
      for (const m of text.matchAll(PATH)) {
        // A name that is no file or directory here, a workflow's identity in a signature among them, reads nothing.
        if (!existsSync(m[1] ?? '')) continue;
        named.add(m[1] ?? '');
        follow(m[1] ?? '');
      }
      if (next.file.endsWith('.sh'))
        for (const m of text.matchAll(/(?:\$here|\$\(dirname "\$0"\))\/([\w-]+\.(?:ts|sh))\b/g))
          follow(join(dirname(next.file), m[1] ?? ''));
      if (/\.(ts|js|mjs|cjs)$/.test(next.file))
        for (const m of text.matchAll(/^(?:import|export) (?:[^;]*? from )?'([^']+)';$/gms)) {
          const from = m[1] ?? '';
          if (from.startsWith('.')) follow(join(dirname(next.file), from));
          else if (from.startsWith('@software-factory/')) packages.push(`${next.file} imports ${from}`);
        }
    }
    return { named: [...named], files: [...files], packages };
  }

  it('excludes each class, and keeps deploy/ whatever it holds', () => {
    const excluded = [
      'docs/COMPONENTS/CI-PIPELINE.md',
      'README.md',
      'apps/console/web/src/main.ts',
      'scripts/test/fixture.sh',
      'scripts/check-kind.test.ts',
      'apps/console/e2e/console.spec.ts',
      'apps/factory/src/line/serve.ts',
      'apps/runner/src/step.ts',
      'packages/store/src/migrate.ts',
      'packages/events/src/index.ts',
      'packages/triage/src/index.ts',
      'policy/triage.ts',
      '.github/workflows/check.yml',
      '.github/CODEOWNERS',
      '.claude/skills/implement/SKILL.md',
      '.devcontainer/devcontainer.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      'apps/factory/package.json',
    ];
    const kept = [
      'deploy/README.md',
      'deploy/test/admission-refusals.json',
      'deploy/base/e2e/x.yaml',
      'deploy/package.json',
      WORKFLOW,
      '.github/actions/x/action.yml',
      'policy/flags.ts',
      'apps/factory/src/github/registry.ts',
      'apps/factory/src/github/signatures.ts',
      'Makefile',
      'scripts/check-kind.sh',
      '.miserc.toml',
      'lefthook.yml',
      'packages/samples/src/index.ts',
      'anything/new',
    ];
    const inputs = inputsOf([...excluded, ...kept]);
    for (const path of excluded) expect(inputs.has(path), path).toBe(false);
    for (const path of kept) expect(inputs.has(path), path).toBe(true);
  });

  it('follows the job into the Makefile’s targets it runs', () => {
    const { targets } = runs();
    expect(targets).toEqual(
      expect.arrayContaining(['up', 'admission-ready', 'share-key', 'refusal-key', 'node_modules']),
    );
    expect(targets).not.toContain('check');
    expect(targets).not.toContain('upgrade-cluster');
    // The answer key's script, which `make up` names, runs only with the private checkout: the runner has none.
    const recipe = readFileSync('Makefile', 'utf-8');
    expect(recipe).toMatch(
      /if \[ -d "\$\(PRIVATE_DIR\)\/defects" \]; then \\\n\t+key="\$\$\(node scripts\/answer-key\.ts /,
    );
    expect(JSON.stringify(workflow)).not.toContain('PRIVATE_DIR');
  });

  it('has the job read no file in an excluded class: each file it reaches, and each path its code names, is an input', () => {
    const { named, files, packages } = reached();
    // A workspace package's sources would be read from the image sources' class: none is imported today.
    expect(packages).toEqual([]);
    // The walk reaches what the job runs, the modules the record scripts import among them.
    expect(files).toEqual(
      expect.arrayContaining([
        'scripts/platform-watch.sh',
        'scripts/admission-ready.sh',
        'scripts/flag-stages-refusals.ts',
        'scripts/signed-by.ts',
        'policy/flags.ts',
        'apps/factory/src/github/registry.ts',
        'apps/factory/src/github/signatures.ts',
      ]),
    );
    // `make` reads the Makefile, and the job runs `make`.
    const read = [...named, ...files, 'Makefile'];
    const inputs = inputsOf(read);
    for (const path of read) expect(inputs.has(path), path).toBe(true);
  });

  it('has no symlink from an input to a file in an excluded class, whose text the hash would not see', () => {
    const links = execFileSync('git', ['ls-files', '-s', '-z'], { encoding: 'utf-8' })
      .split('\0')
      .filter((entry) => entry.startsWith('120000 '))
      .map((entry) => entry.split('\t')[1] ?? '');
    const targets = links.map((link) => join(dirname(link), readlinkSync(link)));
    const inputs = inputsOf([...links, ...targets]);
    links.forEach((link, i) => {
      if (inputs.has(link)) expect(inputs.has(targets[i] ?? ''), `${link} -> ${targets[i]}`).toBe(true);
    });
  });

  it('has nothing the job runs name Claude Code’s files or the dev container’s', () => {
    const { named } = reached();
    expect(named.filter((path) => /^\.(claude|devcontainer)(\/|$)/.test(path))).toEqual([]);
  });

  it('runs no workflow or action of ours but its own: every local action it uses is an input', () => {
    const local = steps.map((step) => step.uses ?? '').filter((uses) => uses.startsWith('./'));
    const named = steps.flatMap((step) => [...(step.run ?? '').matchAll(/\.github\/[\w./-]+/g)].map((m) => m[0]));
    const inputs = inputsOf([...local.map((uses) => uses.slice(2)), ...named]);
    for (const path of [...local.map((uses) => uses.slice(2)), ...named]) expect(inputs.has(path), path).toBe(true);
    // Every action it uses is pinned from outside, or one of ours the rule keeps.
    for (const step of steps.filter((each) => each.uses))
      expect(step.uses, step.uses).toMatch(/^(\.\/\.github\/actions\/|[\w-]+\/[\w-]+@[0-9a-f]{40}$)/);
  });

  it('takes the images built from the image sources by digest, built on main, and makes none in `make up`', () => {
    // Each image built from those sources is pinned by digest in the local profile's pin files.
    const pinned = [CONSOLE, FACTORY].flatMap((file) =>
      [
        ...readFileSync(file, 'utf-8').matchAll(
          /^- digest: sha256:[0-9a-f]{64}\n {2}name: ([\w-]+)\n {2}newName: (\S+)$/gm,
        ),
      ].map((m) => ({ name: m[1], at: m[2] })),
    );
    expect(pinned.map((pin) => pin.name).sort()).toEqual(['console', 'factory', 'factory-browser', 'factory-runner']);
    for (const pin of pinned) expect(pin.at).toBe(`ghcr.io/the-roganator/cv-software-factory/${pin.name}`);
    // No manifest runs one of them any other way: every image of this repository's registry a manifest names is by digest.
    const manifests = execFileSync('git', ['ls-files', '-z', 'deploy/'], { encoding: 'utf-8' })
      .split('\0')
      .filter((file) => /\.ya?ml$/.test(file) && !file.startsWith('deploy/test/'));
    for (const file of manifests)
      for (const line of readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => /^\s*-?\s*image:/.test(l)))
        if (line.includes('ghcr.io/the-roganator/cv-software-factory/'))
          expect(line, file).toMatch(/@sha256:[0-9a-f]{64}/);
    // `make up` and what the job runs build no image and import none: the cluster pulls each by its digest.
    const { texts } = runs();
    for (const text of texts)
      expect(code('Makefile', text)).not.toMatch(/\b(docker (build|buildx|load|import)|k3d image)\b/);
  });

  it('installs the modules as the lockfile has them, so a lockfile the manifests do not match fails the job', () => {
    const platform = workflow.jobs.platform?.steps ?? [];
    const install = platform.findIndex((step) => step.run === 'pnpm install --frozen-lockfile');
    const make = platform.findIndex((step) => step.name === 'Make the cluster');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(make);
  });

  // read3: a workspace project's package.json (excluded) gains a postinstall. The lockfile records no scripts, so the
  // job's install runs it under --frozen-lockfile, before `make up`, with $GITHUB_PATH in reach of every later step.
  it('runs no lifecycle script an excluded package.json adds, which the lockfile does not record', () => {
    const platform = workflow.jobs.platform?.steps ?? [];
    const command = platform.find((step) => /^pnpm install\b/.test(step.run ?? ''))?.run ?? '';
    const dir = mkdtempSync(join(tmpdir(), 'read3-ws-'));
    try {
      mkdirSync(join(dir, 'apps/factory'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"name":"root","private":true}\n');
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
      writeFileSync(join(dir, 'apps/factory/package.json'), '{"name":"factory","version":"1.0.0"}\n');
      execFileSync('pnpm', ['install'], { cwd: dir, stdio: 'ignore' });
      writeFileSync(
        join(dir, 'apps/factory/package.json'),
        '{"name":"factory","version":"1.0.0","scripts":{"postinstall":"echo ran > ran"}}\n',
      );
      execFileSync('sh', ['-c', command], { cwd: dir, stdio: 'ignore' });
      expect(existsSync(join(dir, 'apps/factory/ran'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // read3: the symlink test reads a link's target as a path, but a target that is an excluded directory itself
  // (deploy/base/rules -> ../../policy) is no path under it, so it reads as an input, and kustomize follows it.
  it('takes a link to an excluded directory as a link out of the inputs', () => {
    const inputs = inputsOf(['policy', 'docs', 'apps/factory', 'packages/store', '.github', '.claude']);
    expect([...inputs]).toEqual([]);
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
  ])('makes one when the queue’s commit differs from the head in %s', (_, change) => {
    const { said, log } = answered(line(change));
    expect(said).toBe('cluster');
    expect(log).toMatch(/the inputs at the queue's commit \([0-9a-f]{40}\) are not those at #7's head/);
  });

  // Each class a cluster is not made from: a difference there alone, at the queue's commit or on main since the head's
  // base, leaves the head's cluster standing for the queue's.
  const EXCLUDED: [string, Files][] = [
    ['the docs', { 'docs/COMPONENTS/CI-PIPELINE.md': '# CI\n', 'README.md': '# x\n' }],
    ['the console’s browser code', { 'apps/console/web/src/main.ts': 'export {};\n' }],
    [
      'a test',
      { 'scripts/check-kind.test.ts': 'x\n', 'apps/factory/test/x.ts': 'x\n', 'apps/console/e2e/x.ts': 'x\n' },
    ],
    [
      'the image sources',
      { 'apps/factory/src/line/serve.ts': 'x\n', 'packages/store/src/x.ts': 'x\n', 'policy/triage.ts': 'x\n' },
    ],
    ['another workflow', { '.github/workflows/check.yml': 'name: check\n' }],
    ['Claude Code’s files', { '.claude/skills/x/SKILL.md': 'x\n', '.claude/settings.json': '{}\n' }],
    ['the dev container', { '.devcontainer/devcontainer.json': '{}\n' }],
    ['the lockfile (an accepted limit)', { 'pnpm-lock.yaml': 'lockfileVersion: 9.1\n' }],
    ['a package’s manifest (an accepted limit)', { 'package.json': '{}\n', 'apps/factory/package.json': '{}\n' }],
  ];

  it.each(EXCLUDED)('makes none when the queue’s commit differs from the head only in %s', (_, files) => {
    expect(answered(line({ queue: files })).said).toBe('matched');
  });

  it.each(EXCLUDED)('makes none when main moved only %s since the head’s base', (_, files) => {
    expect(answered(line({ main: [files] })).said).toBe('matched');
  });

  it.each<[string, Files]>([
    ['a file at the root no rule names', { 'something.conf': 'x\n' }],
    ['a file in a new directory', { 'tools/new/thing.sh': '#!/bin/sh\n' }],
    ['a script the job does not run', { 'scripts/review-gate.ts': 'x\n' }],
    ['a module the record scripts import from the image sources', { 'policy/flags.ts': 'export const x = 1;\n' }],
    ['a docs file under deploy/', { 'deploy/README.md': '# x\n' }],
  ])('makes one when the queue’s commit differs from the head in %s', (_, files) => {
    const { said, log } = answered(line({ queue: files }));
    expect(said).toBe('cluster');
    expect(log).toMatch(/are not those at #7's head/);
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

  // mise reads its rc files before any config (`.miserc.toml`, `.miserc.local.toml`, `.config/miserc.toml`, as mise
  // 2026.11.7 does): `env = ["x"]` there loads mise.x.toml, and `ignored_config_paths` drops mise.toml, so
  // mise-action installs other versions of every tool than mise.toml and mise.lock pin.
  it.each(['.miserc.toml', '.config/miserc.toml', '.miserc.local.toml'])(
    'makes one when main adds %s, which mise reads before its config',
    (rc) => {
      const built = line({ main: [{ [rc]: 'ignored_config_paths = ["mise.toml"]\n' }] });
      expect(answered(built).said).toBe('cluster');
    },
  );

  // Fail closed: a file nobody has listed, at the root or in a new directory, is an input.
  it.each(['something.conf', 'tools/new/thing.sh', 'lefthook.yml'])(
    'makes one when main adds %s, which no rule names',
    (file) => {
      const built = line({ main: [{ [file]: 'x\n' }] });
      expect(answered(built).said).toBe('cluster');
    },
  );

  it('makes one when main moved a pin file in more than its digests', () => {
    const built = line({ main: [{ [CONSOLE]: `${moved(CONSOLE)}# and more\n` }, { [CONSOLE]: moved(CONSOLE) }] });
    expect(answered(built).said).toBe('cluster');
  });

  it('makes one when main moved a pin file’s digests and took its last newline', () => {
    const built = line({ main: [{ [CONSOLE]: moved(CONSOLE).replace(/\n$/, '') }] });
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
    // An empty field, split on tabs, would shift every field after it, and the reason with them.
    [
      'a head whose repository is gone',
      (a) => Object.assign(pull(a).head as Row, { repo: null }),
      'head is in no repository',
    ],
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
