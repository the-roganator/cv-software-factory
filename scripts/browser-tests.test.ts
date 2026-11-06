import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, matchesGlob, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A pull request that changes only files under deploy/ skips the browser tests (check.yml's `manifests` kind), since
 * nothing they run reads from there. This keeps that true, for code added later too.
 *
 * What they run is found from where check.yml's browser jobs start: the console's build (Vite's config and the page it
 * builds), its Playwright tests (the config, the spec files and the server it starts) and the vitest `browser`
 * project's files. From there every file they import, a page's scripts and a stylesheet's imports, is followed through
 * the workspace's packages, so a new file, helper or package is covered the day it is used; third-party packages are
 * not followed. A file reads from deploy/ if its code, outside comments, names a path there, or `deploy` and one of
 * its folders as `join(…, 'deploy', 'base')` would.
 *
 * But for one file: CI runs the console's browser tests beside the Postgres its StatefulSet pins, and the live test's
 * own Postgres reads the same pin. The `manifests` kind leaves a change to it as `code`, so that is allowed, and
 * nothing else.
 */
const POSTGRES = 'deploy/base/postgres/statefulset.yaml';

const CHECK = '.github/workflows/check.yml';
const CONSOLE = 'apps/console';

const tracked = new Set(execFileSync('git', ['ls-files'], { encoding: 'utf-8' }).split('\n').filter(Boolean));
/** A file's text, its CRLF line endings read as LF. */
const read = (file: string) => readFileSync(file, 'utf-8').replace(/\r\n?/g, '\n');

/** The workspace's packages, each export of each by its specifier, as a file. */
function workspace() {
  const specifiers = new Map<string, string>();
  for (const manifest of [...tracked].filter((file) => /^(apps|packages)\/[^/]+\/package\.json$/.test(file))) {
    const { name, exports } = JSON.parse(read(manifest)) as { name: string; exports?: unknown };
    const entries = typeof exports === 'string' ? { '.': exports } : ((exports ?? {}) as Record<string, unknown>);
    for (const [path, target] of Object.entries(entries)) {
      // A conditional export's targets, each condition's: any of them may be the one that runs.
      for (const file of targets(target)) specifiers.set(posix.join(name, path), posix.join(dirname(manifest), file));
    }
  }
  return specifiers;
}

/** The files an export names, a condition at a time. */
const targets = (target: unknown): string[] =>
  typeof target === 'string'
    ? [target]
    : target && typeof target === 'object'
      ? Object.values(target).flatMap(targets)
      : [];

const packages = workspace();

const CODE = /\.(ts|tsx|mts|js|jsx|mjs)$/;

/** The tracked file a specifier names from a file, if it is in the repository. */
function resolve(from: string, specifier: string): string | undefined {
  const bare = specifier.replace(/[?#].*$/, '');
  if (!bare.startsWith('.')) return packages.get(bare);
  const path = posix.normalize(posix.join(posix.dirname(from), bare));
  const candidates = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx'];
  return candidates.map((suffix) => path + suffix).find((candidate) => tracked.has(candidate));
}

/** What a file imports, loads or includes. */
function references(file: string, text: string) {
  const patterns = file.endsWith('.html')
    ? [/\b(?:src|href)="([^"]+)"/g]
    : file.endsWith('.css')
      ? [/@import\s+(?:url\()?['"]([^'"]+)['"]/g]
      : [/\b(?:from|import)\s*\(?\s*['"`]([^'"`]+)['"`]/g];
  const found = patterns.flatMap((pattern) => [...text.matchAll(pattern)].map(([, specifier = '']) => specifier));
  if (!CODE.test(file)) return found;
  // A script it starts (a server, a worker), named as a file: from where it is, or from its package's folder, which is
  // where a test starts one.
  const scripts = [...text.matchAll(/['"`]((?:\.{0,2}\/)?[\w./-]+\.(?:ts|tsx|mts|js|mjs))['"`]/g)].map(
    ([, script = '']) => script,
  );
  return [...found, ...scripts.flatMap((script) => [`./${script}`, `${'../'.repeat(depth(file))}${script}`])];
}

/** How many folders a file is below its package's. */
function depth(file: string) {
  const folders = file.split('/').slice(0, -1);
  for (let up = 0; up <= folders.length; up++) {
    if (tracked.has([...folders.slice(0, folders.length - up), 'package.json'].join('/').replace(/^\//, ''))) return up;
  }
  return folders.length;
}

/** Every file reached from the entry points. */
function closure(entries: string[]) {
  const reached = new Set<string>();
  const stack = [...entries];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    if (!CODE.test(file) && !/\.(html|css)$/.test(file)) continue;
    for (const specifier of references(file, read(file))) {
      const target = resolve(file, specifier);
      if (target) stack.push(target);
    }
  }
  return [...reached].sort();
}

/** deploy/'s own folders, as `join(…, 'deploy', 'base')` would name one. */
const folders = [...new Set([...tracked].flatMap((file) => file.match(/^deploy\/([^/]+)\//)?.[1] ?? []))];

/**
 * The places under deploy/ a file names, outside its comments: as a path there or to it (`../../deploy`), or as
 * `deploy` and one of its folders side by side, as `join(…, 'deploy', 'base')` would, or a variable after it. A comment opens a line, so a
 * glob's `/*` inside a string is not taken for one; `#` opens one only in YAML, where it is not a private field.
 * An HTML comment is read as code, which errs towards failing.
 */
function deployPaths(text: string, yaml = false) {
  const code = text.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(yaml ? /^\s*#.*$/gm : /^\s*\/\/.*$/gm, '');
  const parts = new RegExp(`['"\`]deploy['"\`]\\s*,\\s*['"\`](${folders.join('|')})\\b`, 'g');
  return [
    ...[...code.matchAll(/(?<![\w-])deploy\/[\w./*-]*/g)].map(([path]) => path),
    ...[...code.matchAll(/(?<![\w-])deploy(?=['"`$])/g)]
      .filter(({ index }) => code[index - 1] === '/')
      .map(() => 'deploy'),
    ...[...code.matchAll(parts)].map(([, folder]) => `deploy/${folder}`),
    // `deploy` with a variable after it, joined or added: the variable could name any folder.
    ...[...code.matchAll(/['"`]deploy['"`]\s*(?:\+|,\s*(?![\s'"`])[\w$.]+\s*[),])/g)].map(() => 'deploy'),
  ];
}

/** Where check.yml's browser tests start. */
function entries() {
  const config = read('vitest.config.ts');
  const browser = config.match(/name: 'browser',[\s\S]*?include: \[([^\]]*)\]/)?.[1] ?? '';
  const globs = [...browser.matchAll(/'([^']+)'/g)].map(([, glob = '']) => glob);
  const playwright = read(`${CONSOLE}/playwright.config.ts`);
  const testDir = playwright.match(/testDir: '([^']+)'/)?.[1] ?? '';
  const servers = [...playwright.matchAll(/command: 'node ([^']+)'/g)].map(([, script = '']) => `${CONSOLE}/${script}`);
  // Setup and teardown files, in the browser project and in Playwright's config.
  const setup = (text: string, base: string) =>
    [...text.matchAll(/(?:globalSetup|globalTeardown|setupFiles): \[?([^\]\n]*)/g)].flatMap(([, list = '']) =>
      [...list.matchAll(/'([^']+)'/g)].map(([, file = '']) => posix.normalize(posix.join(base, file))),
    );
  const root = read(`${CONSOLE}/vite.config.ts`).match(/root: '([^']+)'/)?.[1] ?? '';
  return {
    vitest: [
      'vitest.config.ts',
      ...[...tracked].filter((file) => globs.some((glob) => matchesGlob(file, glob))),
      ...setup(config.match(/name: 'browser',[\s\S]*?\n {6}\},/)?.[0] ?? '', '.'),
    ],
    playwright: [
      `${CONSOLE}/playwright.config.ts`,
      ...setup(playwright, CONSOLE),
      ...[...tracked].filter((file) => file.startsWith(`${CONSOLE}/${testDir}/`) && file.endsWith('.ts')),
      ...servers,
    ],
    vite: [`${CONSOLE}/vite.config.ts`, `${CONSOLE}/${root}/index.html`],
    jobs: scripts(),
  };
}

/** check.yml's jobs, each by its id, as written. */
function jobs() {
  const workflow = read(CHECK);
  const body = workflow.slice(workflow.indexOf('\njobs:\n'));
  return new Map(
    [...body.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\s*\n|\s*#.*\n)*)/gm)].map(([, id = '', job = '']) => [id, job]),
  );
}

const BROWSER_JOBS = ['console-browser', 'senses-browser', 'zap', 'browser'];

/** The scripts the browser jobs run with `node`, ZAP's scan among them. */
const scripts = () =>
  BROWSER_JOBS.flatMap((id) =>
    [...(jobs().get(id) ?? '').matchAll(/run: node (\S+\.ts)$/gm)].map(([, file = '']) => file),
  );

describe('what the browser tests run', () => {
  const start = entries();
  const files = closure(Object.values(start).flat());

  it('is found from where they start', () => {
    expect(start.vitest).toEqual(expect.arrayContaining(['apps/factory/test/browser/probes.test.ts']));
    expect(start.playwright).toEqual(
      expect.arrayContaining(['apps/console/e2e/live.spec.ts', 'apps/console/src/server.ts']),
    );
    expect(start.jobs).toEqual(['apps/console/zap/scan.ts']);
    expect(files).toEqual(
      expect.arrayContaining([
        'apps/console/web/src/main.tsx',
        'apps/factory/src/probes/index.ts',
        'packages/events/src/index.ts',
        'packages/store/test/postgres.ts',
      ]),
    );
  });

  it('reads nothing under deploy/ but the Postgres pin', () => {
    const reads = files.flatMap((file) =>
      deployPaths(read(file))
        .filter((path) => path !== POSTGRES)
        .map((path) => `${file}: ${path}`),
    );
    expect(reads).toEqual([]);
  });

  it('would be read as reading deploy/ for a path there, or deploy and a folder side by side, but not in a comment', () => {
    const text = [
      "const a = new URL('../../deploy/base/x.yaml', import.meta.url);",
      "const b = join(ROOT, 'deploy', 'overlays', 'local');",
      '/** The steps are in `deploy/base/analysis`. */',
      '  // deploy/overlays/local',
      "const c = ['release', 'deploy', 'verify'];",
      "const d = 'deployment/x';",
    ].join('\n');
    expect(deployPaths(text)).toEqual(['deploy/base/x.yaml', 'deploy/overlays']);
    const more = [
      "const e = join(ROOT, '../../deploy');",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a template's text, as a file holds it
      'const f = `${ROOT}/deploy`;',
      "const g = join(ROOT, 'deploy', 'overlays/local');",
      "  #root = '../../deploy/base/x.yaml';",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a template's text, as a file holds it
      'const h = `${ROOT}/deploy${rest}`;',
      "const i = join(ROOT, 'deploy', folder);",
      "const j = ROOT + 'deploy' + rest;",
    ].join('\n');
    expect(deployPaths(more)).toEqual([
      'deploy/base/x.yaml',
      'deploy',
      'deploy',
      'deploy',
      'deploy/overlays',
      'deploy',
      'deploy',
    ]);
    expect(deployPaths("const k = { kind: 'deploy', at };\nwait('deploy', 'release');")).toEqual([]);
    expect(deployPaths("const l = '../../deploy/base/x.yaml';\r\n")).toEqual(['deploy/base/x.yaml']);
    expect(deployPaths('  # deploy/base, in a YAML comment', true)).toEqual([]);
  });

  it('follows a script a test starts, from its package', () => {
    expect(closure(['apps/console/e2e/live.spec.ts'])).toContain('apps/console/src/server.ts');
  });

  it('starts from servers, builds and setup it can read', () => {
    const playwright = read(`${CONSOLE}/playwright.config.ts`);
    expect(playwright.match(/command: '[^']*'/g)?.every((command) => command.startsWith("command: 'node "))).toBe(true);
    expect(JSON.parse(read(`${CONSOLE}/package.json`)).scripts.build).toBe('vite build');
  });

  it('is what check.yml runs: no other step, and no other image from the kind job', () => {
    const all = jobs();
    const browser = BROWSER_JOBS.map((id) => all.get(id) ?? '');
    expect(browser.every(Boolean)).toBe(true);
    const runs = browser.flatMap((job) => [...job.matchAll(/^\s+(?:- )?run: (.+)$/gm)].map(([, run = '']) => run));
    // A step of many lines only reports what the jobs before it found.
    const blocks = browser.flatMap((job) =>
      [...job.matchAll(/run: \|\n((?:\s{10,}.*\n)+)/g)].flatMap(([, block = '']) => block.trim().split('\n')),
    );
    expect(
      blocks.filter(
        (line) => !/^(echo "[^"]*"|\[ "\$\w+" = success \]( && \[ "\$\w+" = success \])*)$/.test(line.trim()),
      ),
    ).toEqual([]);
    const uses = browser.flatMap((job) => [...job.matchAll(/uses: ([\w/-]+)@/g)].map(([, action = '']) => action));
    // Every job takes Node and pnpm from mise.lock: ZAP's scan on the runner, the others in Playwright's image.
    expect(new Set(uses)).toEqual(new Set(['actions/checkout', 'actions/upload-artifact', 'jdx/mise-action']));
    expect(new Set(runs)).toEqual(
      new Set([
        'pnpm install --frozen-lockfile --ignore-scripts',
        'pnpm --filter @software-factory/console build',
        'pnpm exec playwright test $TESTS',
        'pnpm exec vitest run --project browser',
        'pnpm --filter @software-factory/console exec playwright install --only-shell chromium',
        'node apps/console/zap/scan.ts',
        '|',
      ]),
    );
    expect(browser.flatMap((job) => deployPaths(job, true))).toEqual([]);
    const outputs = new Set(
      browser.flatMap((job) => [...job.matchAll(/needs\.kind\.outputs\.(\w+)/g)].map(([, o]) => o)),
    );
    expect(outputs).toEqual(new Set(['kind', 'postgres', 'playwright']));
    // Those two images: the Postgres from its pin, by ci-images.sh, and Playwright's from Dockerfile.browser.
    const kind = all.get('kind') ?? '';
    expect(kind).toContain('echo "image=$(scripts/ci-images.sh postgres)"');
    expect(kind.match(/- id: playwright\n\s+run: (.+)/)?.[1]).toContain('apps/factory/Dockerfile.browser');
  });
});

describe("the manifests kind's exception", () => {
  it('is the file the Postgres beside the browser tests is pinned in', () => {
    const file = read('scripts/ci-images.sh').match(/grep -oE "\$PIN" (\S+)/)?.[1];
    expect(file).toBe(POSTGRES);
    expect(read('scripts/check-kind.sh')).toContain(`grep -qxF '${POSTGRES}'`);
  });

  it('names a file that is there', () => {
    expect(tracked.has(POSTGRES)).toBe(true);
  });
});
