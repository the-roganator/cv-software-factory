import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ENVIRONMENTS, KEY_BRANCH } from './github-settings.ts';

/**
 * Every workflow, as GitHub reads it (spec 6, guardrails 1 and 2): none runs a pull request's code where a secret is,
 * none runs on a machine of its own, and only two hold a secret, each from an environment only main may use, and each
 * checking out nothing but main's own files.
 */
const DIR = '.github/workflows';

/** The GitHub-hosted runners the jobs run on. Anything else, a self-hosted runner above all, is refused. */
const HOSTED = ['ubuntu-24.04', 'ubuntu-24.04-arm'];

/** The workflows that hold a secret, and what starts each: nothing a pull request can start. */
const WITH_A_SECRET: Record<string, string[]> = {
  'drift-check.yml': ['schedule', 'workflow_dispatch'],
  'review.yml': ['workflow_run', 'workflow_call'],
};

/**
 * The files each of those checks out, and copilot-held-runs.yml, whose token may delete runs: the toolchain's pins and
 * its one script.
 */
const CHECKED_OUT: Record<string, string[]> = {
  'drift-check.yml': ['mise.toml', 'mise.lock', 'scripts/github-settings.ts'],
  'review.yml': [
    'mise.toml',
    'mise.lock',
    'scripts/review-gate.ts',
    'scripts/review-routing.ts',
    'policy/review-verdict.ts',
  ],
  'copilot-held-runs.yml': ['mise.toml', 'mise.lock', 'scripts/copilot-held-runs.ts'],
};

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  'runs-on'?: unknown;
  if?: string;
  permissions?: unknown;
  env?: Record<string, unknown>;
  name?: string;
  uses?: string;
  environment?: string | { name: string };
  secrets?: unknown;
  steps?: Step[];
}
interface Workflow {
  on: string | string[] | Record<string, unknown>;
  permissions?: unknown;
  env?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const read = (file: string) => parse(readFileSync(`${DIR}/${file}`, 'utf-8')) as Workflow;
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const workflows = files.map((file) => ({ file, workflow: read(file) }));

/** What starts a workflow, by event name, however `on:` is written. */
const triggers = ({ on }: Workflow) => (typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on));

/**
 * The runner labels a job's `runs-on` may name: a label, or an expression that chooses between quoted labels by a
 * matrix's value (`matrix.arch == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-24.04'`), every one of which must be
 * hosted. Any other expression could name a runner from an input or a variable, and a list or a group is a self-hosted
 * runner's way: neither names a label here.
 */
function labels(runsOn: unknown): string[] | undefined {
  if (typeof runsOn !== 'string') return undefined;
  const inside = runsOn.match(/^\$\{\{(.*)\}\}$/s)?.[1];
  if (inside === undefined) return [runsOn];
  const choices = inside.replace(/matrix\.\w+\s*==\s*'[^']*'/g, '');
  if (choices.replace(/'[^']*'|&&|\|\||[()\s]/g, '') !== '') return undefined;
  const quoted = [...choices.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
  return quoted.length ? quoted : undefined;
}

/**
 * The secrets a job names in its expressions, the workflow's env included, and whether it hands them on to a workflow
 * it calls. One read other than by name (`secrets['X']`, `toJSON(secrets)`) is `(not by name)`.
 */
function secretsOf(workflow: Workflow, job: Job): { names: string[]; passed: boolean } {
  const text = JSON.stringify([workflow.env ?? {}, { ...job, secrets: undefined }]);
  const expressions = [...text.matchAll(/\$\{\{(.*?)\}\}/gs)].map((m) => m[1] ?? '');
  const names = expressions.flatMap((e) =>
    [...e.matchAll(/\bsecrets\b(\.(\w+))?/g)].map((m) => m[2] ?? '(not by name)'),
  );
  return { names: [...new Set(names)], passed: job.secrets !== undefined };
}

/** An Actions expression, as a workflow writes one. */
const expression = (inside: string) => `\${{ ${inside} }}`;

const environmentOf = (job: Job) => (typeof job.environment === 'string' ? job.environment : job.environment?.name);

describe('codeql.yml', () => {
  const { file, workflow } = workflows.find((w) => w.file === 'codeql.yml') ?? {};
  it("analyses each pull request, not the merge queue's commit, which the queue does not wait for", () => {
    expect(file).toBe('codeql.yml');
    expect(triggers(workflow as Workflow)).toEqual(expect.arrayContaining(['pull_request', 'push', 'workflow_call']));
    expect(triggers(workflow as Workflow)).not.toContain('merge_group');
  });
  it("keeps one category per language, whatever started the run, so each analysis is compared with its language's", () => {
    const steps = (workflow as Workflow).jobs.analyze?.steps ?? [];
    const analyze = steps.find((step) => step.uses?.startsWith('github/codeql-action/analyze@'));
    expect(analyze?.with).toEqual({ category: `/language:${expression('matrix.language')}` });
  });
});

describe('every workflow', () => {
  it('is read: each file parses, and has triggers and jobs', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const { file, workflow } of workflows) {
      expect(triggers(workflow).length, file).toBeGreaterThan(0);
      expect(Object.keys(workflow.jobs ?? {}).length, file).toBeGreaterThan(0);
    }
  });

  it('never runs on pull_request_target, which runs with secrets on a pull request’s behalf', () => {
    for (const { file, workflow } of workflows) expect(triggers(workflow), file).not.toContain('pull_request_target');
  });

  it('runs every job on a GitHub-hosted runner the test names, or calls a workflow that does', () => {
    for (const { file, workflow } of workflows) {
      for (const [id, job] of Object.entries(workflow.jobs)) {
        if (job['runs-on'] === undefined) {
          // A call to a workflow of this repository's, which is one of these, each read here in its turn.
          expect(job.uses ?? '', `${file}: ${id}`).toMatch(/^\.\/\.github\/workflows\/[\w-]+\.ya?ml$/);
          continue;
        }
        const named = labels(job['runs-on']);
        expect(named, `${file}: ${id}`).toBeDefined();
        for (const label of named ?? []) expect(HOSTED, `${file}: ${id}`).toContain(label);
      }
    }
  });

  it('holds a secret only in drift-check.yml and review.yml, started by nothing a pull request starts', () => {
    const holding = workflows.filter(({ workflow }) =>
      Object.values(workflow.jobs).some((job) => {
        const { names, passed } = secretsOf(workflow, job);
        return names.length > 0 || passed;
      }),
    );
    expect(holding.map(({ file }) => file).sort()).toEqual(Object.keys(WITH_A_SECRET).sort());
    for (const { file, workflow } of holding) {
      expect(triggers(workflow).sort(), file).toEqual([...(WITH_A_SECRET[file] ?? [])].sort());
      expect(workflow.env, file).toBeUndefined();
    }
  });

  it('holds each secret in a job that uses its environment, which only main may use, and only that one’s key', () => {
    const environments = ENVIRONMENTS['the-roganator/cv-software-factory'] ?? [];
    for (const file of Object.keys(WITH_A_SECRET)) {
      const workflow = read(file);
      for (const [id, job] of Object.entries(workflow.jobs)) {
        const { names, passed } = secretsOf(workflow, job);
        expect(passed, `${file}: ${id}`).toBe(false);
        if (!names.length) continue;
        const environment = environments.find((e) => e.name === environmentOf(job));
        // github-settings.ts limits each of these to main (KEY_BRANCH), and --check fails if one is not.
        expect(environment, `${file}: ${id}`).toBeDefined();
        expect(KEY_BRANCH).toBe('main');
        expect(names, `${file}: ${id}`).toEqual([environment?.key]);
      }
    }
  });

  it('checks out nothing but main’s own files where a secret or a write to Actions is: a sparse copy at its commit', () => {
    // Every workflow that holds a secret is here, so a new one with no list of its own fails.
    for (const file of Object.keys(WITH_A_SECRET)) expect(Object.keys(CHECKED_OUT), file).toContain(file);
    for (const file of Object.keys(CHECKED_OUT)) {
      const steps = Object.values(read(file).jobs).flatMap((job) => job.steps ?? []);
      const checkouts = steps.filter((s) => s.uses?.startsWith('actions/checkout@'));
      expect(checkouts, file).toHaveLength(1);
      const options = checkouts[0]?.with ?? {};
      expect(options.ref, file).toBe(expression('job.workflow_sha'));
      expect([undefined, expression('job.workflow_repository')], file).toContain(options.repository);
      expect(options['persist-credentials'], file).toBe(false);
      expect(
        String(options['sparse-checkout'] ?? '')
          .trim()
          .split('\n'),
        file,
      ).toEqual(CHECKED_OUT[file]);
      expect(options['sparse-checkout-cone-mode'], file).toBe(false);
      // Nor fetches anything else in a step of its own, or reads a pull request's head.
      for (const step of steps) {
        expect(step.run ?? '', file).not.toMatch(/\bgit\b|\bgh (pr|repo) (checkout|clone)\b/);
      }
      expect(readFileSync(`${DIR}/${file}`, 'utf-8'), file).not.toMatch(
        /head_sha|\.head\.(sha|ref)|pull_request\.head/,
      );
    }
  });

  it('gives the token no more than a read of the contents in the drift check, whose reads are the App’s', () => {
    const workflow = read('drift-check.yml');
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(['drift-check']);
    expect(Object.values(workflow.jobs).map((job) => job.permissions)).toEqual([{ contents: 'read' }]);
  });

  it('lets only copilot-held-runs.yml write Actions, which can delete any run', () => {
    const writes = (permissions: unknown) =>
      permissions === 'write-all' ||
      (typeof permissions === 'object' && permissions !== null && 'actions' in permissions
        ? (permissions as { actions: unknown }).actions === 'write'
        : false);
    const writing = workflows.filter(
      ({ workflow }) => writes(workflow.permissions) || Object.values(workflow.jobs).some((j) => writes(j.permissions)),
    );
    expect(writing.map(({ file }) => file)).toEqual(['copilot-held-runs.yml']);
  });

  it('runs copilot-held-runs.yml on main alone, from nothing a pull request starts, its token able to do no more', () => {
    const workflow = read('copilot-held-runs.yml');
    expect(triggers(workflow).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.permissions).toEqual({});
    expect(workflow.env).toBeUndefined();
    const jobs = Object.values(workflow.jobs);
    expect(jobs).toHaveLength(1);
    // Deleting a run needs Actions write; the checkout, a read of this public repository's contents.
    expect(jobs[0]?.permissions).toEqual({ actions: 'write', contents: 'read' });
    expect(jobs[0]?.if).toBe("github.ref == 'refs/heads/main'");
    const runs = (jobs[0]?.steps ?? []).filter((step) => step.run !== undefined).map((step) => step.run);
    expect(runs).toEqual(['node scripts/copilot-held-runs.ts']);
    // The token, which may delete any run, goes to the script and to GitHub's own checkout, which needs it to fetch:
    // no third-party action is handed it, mise's included.
    const steps = jobs[0]?.steps ?? [];
    const handed = steps.filter((step) => JSON.stringify(step).includes('github.token'));
    expect(handed.map((step) => step.run)).toEqual(['node scripts/copilot-held-runs.ts']);
    const mise = steps.find((step) => step.uses?.startsWith('jdx/mise-action@'));
    expect(mise?.with?.github_token).toBe('');
  });
});

describe('reading a workflow', () => {
  it('finds the labels a runs-on names, and none in a list or a group', () => {
    expect(labels('ubuntu-24.04')).toEqual(['ubuntu-24.04']);
    expect(labels(expression("matrix.arch == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-24.04'"))).toEqual([
      'ubuntu-24.04-arm',
      'ubuntu-24.04',
    ]);
    expect(labels(expression("matrix.arch == 'arm64' && 'self-hosted' || 'ubuntu-24.04'"))).toContain('self-hosted');
    expect(labels(expression('matrix.runner'))).toBeUndefined();
    expect(labels(expression("matrix.runner || 'ubuntu-24.04'"))).toBeUndefined();
    expect(labels(expression("'ubuntu-24.04' || inputs.runner"))).toBeUndefined();
    expect(labels(['self-hosted', 'linux'])).toBeUndefined();
    expect(labels({ group: 'ours' })).toBeUndefined();
  });

  it('finds every way a job names a secret: in a step, its env, the workflow’s env, or handed to a call', () => {
    const job = (body: Partial<Job>): Job => ({ 'runs-on': 'ubuntu-24.04', ...body });
    const workflow: Workflow = { on: 'push', jobs: {} };
    expect(secretsOf(workflow, job({ steps: [{ run: `echo ${expression('secrets.A')}` }] })).names).toEqual(['A']);
    expect(secretsOf({ ...workflow, env: { B: expression('secrets.B') } }, job({})).names).toEqual(['B']);
    expect(secretsOf(workflow, job({ env: { C: expression("secrets['C']") } })).names).toEqual(['(not by name)']);
    expect(secretsOf(workflow, job({ env: { D: expression('toJSON(secrets)') } })).names).toEqual(['(not by name)']);
    expect(secretsOf(workflow, job({ steps: [{ name: 'Keep the secrets.txt', run: 'true' }] })).names).toEqual([]);
    expect(secretsOf(workflow, job({ uses: './x.yml', secrets: 'inherit' })).passed).toBe(true);
    expect(secretsOf(workflow, job({ steps: [{ run: `echo ${expression('github.token')}` }] }))).toEqual({
      names: [],
      passed: false,
    });
    expect(triggers({ on: ['push', 'pull_request_target'], jobs: {} })).toContain('pull_request_target');
  });
});

/**
 * Trivy is one image everywhere, pinned by version and digest in one file, which Dependabot moves: every job that runs
 * it reads that file from this repository at the workflow's own commit, never from a change's checkout or the app's,
 * so no pull request chooses its own scanner, and the gates and the daily scan cannot drift apart.
 */
const TRIVY_PIN = '.github/images/trivy/Dockerfile';

/** The Trivy image a Dockerfile pins, if it pins exactly one, by version and digest, and nothing else. */
function trivyPin(dockerfile: string) {
  const froms = dockerfile.split('\n').filter((line) => /^\s*FROM\s/i.test(line));
  if (froms.length !== 1) return undefined;
  return /^FROM (ghcr\.io\/aquasecurity\/trivy:\d+\.\d+\.\d+@sha256:[0-9a-f]{64})$/.exec(froms[0] ?? '')?.[1];
}

describe("Trivy's pin", () => {
  it('is one image, by version and digest, in its own file', () => {
    expect(trivyPin(readFileSync(TRIVY_PIN, 'utf-8'))).toMatch(/^ghcr\.io\/aquasecurity\/trivy:/);
  });

  it('refuses a FROM without a version, without a digest, of another image, or beside another', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(trivyPin(`FROM ghcr.io/aquasecurity/trivy:0.74.0@${digest}\n`)).toBeDefined();
    expect(trivyPin(`FROM ghcr.io/aquasecurity/trivy@${digest}\n`)).toBeUndefined();
    expect(trivyPin('FROM ghcr.io/aquasecurity/trivy:0.74.0\n')).toBeUndefined();
    expect(trivyPin(`FROM docker.io/aquasec/trivy:0.74.0@${digest}\n`)).toBeUndefined();
    expect(trivyPin(`FROM ghcr.io/aquasecurity/trivy:0.74.0@${digest} AS scanner\n`)).toBeUndefined();
    expect(
      trivyPin(`FROM ghcr.io/aquasecurity/trivy:0.74.0@${digest}\nFROM ghcr.io/aquasecurity/trivy:0.73.0@${digest}\n`),
    ).toBeUndefined();
  });

  it('is the only Trivy any workflow names, and each job that runs it reads it from its own commit', () => {
    let readers = 0;
    for (const { file, workflow } of workflows) {
      const text = readFileSync(`${DIR}/${file}`, 'utf-8');
      expect(text, file).not.toMatch(/aquasecurity\/trivy|aquasec\/trivy/);
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const steps = job.steps ?? [];
        const runs = steps.map((step) => step.run ?? '').join('\n');
        if (!/trivy/i.test(runs) && !JSON.stringify(job.env ?? {}).match(/trivy/i)) continue;
        readers++;
        // The pin, read from a checkout of this repository at the workflow's own commit, by its path there.
        const own = steps.find(
          (step) =>
            step.uses?.startsWith('actions/checkout@') &&
            step.with?.repository === expression('job.workflow_repository') &&
            step.with?.ref === expression('job.workflow_sha') &&
            String(step.with?.['sparse-checkout'] ?? '')
              .split('\n')
              .includes(TRIVY_PIN),
        );
        expect(own, `${file} ${name}`).toBeDefined();
        expect(runs, `${file} ${name}`).toContain(`${String(own?.with?.path)}/${TRIVY_PIN}`);
      }
    }
    expect(readers).toBeGreaterThan(0);
  });
});
