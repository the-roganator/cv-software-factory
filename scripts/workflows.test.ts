import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { syftPin } from '../apps/factory/src/vulnerabilities/graph.ts';
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

/** review.yml's job that works out the gate's pin moves (scripts/pin-moves.ts), with no secret. */
const PIN_MOVE_JOB = 'pin-move';
/** review.yml's job that works out the gate's Critical fixes in the app (scripts/critical-fixes.ts), with no secret. */
const CRITICAL_FIX_JOB = 'critical-fix';
/** The jobs that read main whole and hold no secret, which the tests below hold to that. */
const ANSWER_JOBS = [PIN_MOVE_JOB, CRITICAL_FIX_JOB];

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  env?: Record<string, unknown>;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  outputs?: Record<string, string>;
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
      // review.yml's pin move and critical fix jobs hold no secret and read main whole: the tests below hold them to that.
      const steps = Object.entries(read(file).jobs)
        .filter(([id]) => !(file === 'review.yml' && ANSWER_JOBS.includes(id)))
        .flatMap(([, job]) => job.steps ?? []);
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

  it("works out the gate's pin moves in a job of review.yml's own, with no secret, nothing to write and main's code", () => {
    const workflow = read('review.yml');
    const job = workflow.jobs[PIN_MOVE_JOB] as Job;
    expect(secretsOf(workflow, job)).toEqual({ names: [], passed: false });
    expect(job.environment).toBeUndefined();
    // actions: read, to learn which workflow made each check run at the head: a read, as the others are.
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', checks: 'read', actions: 'read' });
    const checkouts = (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.with).toEqual({
      repository: expression('job.workflow_repository'),
      ref: expression('job.workflow_sha'),
      'persist-credentials': false,
    });
    // The gate, which holds the key, takes its answers and reads no head itself; it runs whatever the job did.
    const review = workflow.jobs.review as Job & { needs?: unknown };
    expect(review.needs).toEqual(ANSWER_JOBS);
    // A platform run asks for a verdict only when the App's: its pin moves alone wait for it.
    const onlyApp =
      "(github.event.workflow_run.name != 'platform' || github.event.workflow_run.actor.login == 'mrogan-software-factory[bot]')";
    expect(review.if).toBe(expression(`!cancelled() && ${onlyApp}`));
    expect(job.if).toBe(expression(`github.repository != 'the-roganator/cv-worlds-worst-website' && ${onlyApp}`));
    const judge = (review.steps ?? []).find((s) => s.run === 'node scripts/review-gate.ts') as Step & {
      env?: Record<string, unknown>;
    };
    expect(judge.env?.PIN_MOVES).toBe(expression(`needs.${PIN_MOVE_JOB}.outputs.answers`));
    for (const step of job.steps ?? []) expect(step.run ?? '').not.toMatch(/\bgit\b|CHECKS_TOKEN/);
  });

  it("works out the gate's Critical fixes in a job of review.yml's own, in the app alone, as the pin moves are", () => {
    const workflow = read('review.yml');
    const job = workflow.jobs[CRITICAL_FIX_JOB] as Job;
    expect(secretsOf(workflow, job)).toEqual({ names: [], passed: false });
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', checks: 'read', actions: 'read' });
    expect(job.if).toBe(expression("github.repository == 'the-roganator/cv-worlds-worst-website'"));
    const checkouts = (job.steps ?? []).filter((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.with).toEqual({
      repository: expression('job.workflow_repository'),
      ref: expression('job.workflow_sha'),
      'persist-credentials': false,
    });
    expect((job.steps ?? []).map((s) => s.run).filter(Boolean)).toEqual([
      'pnpm install --frozen-lockfile --ignore-scripts',
      'node scripts/critical-fixes.ts --critical-fixes',
    ]);
    const judge = ((workflow.jobs.review as Job).steps ?? []).find((s) => s.run === 'node scripts/review-gate.ts');
    expect(judge?.env?.CRITICAL_FIXES).toBe(expression(`needs.${CRITICAL_FIX_JOB}.outputs.answers`));
    for (const step of job.steps ?? []) expect(step.run ?? '').not.toMatch(/\bgit\b|CHECKS_TOKEN/);
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
 * so no pull request chooses its own scanner, and the gates and the daily scan cannot drift apart. A job in a workflow
 * that runs on this repository's pull requests and merge queue alone reads it from the base instead (the lockfile gate
 * in check.yml, whose own commit is the change's).
 */
const TRIVY_PIN = 'deploy/images/trivy/Dockerfile';
const BASE = expression('github.event.pull_request.base.sha || github.event.merge_group.base_sha');
/** check.yml's step that checks a scanner's pin is signed by its publisher (scripts/scanner-signatures.test.ts). */
const SIGNATURES = "Check the scanners it moves to were signed by their publishers' release workflows";

/** A workflow as written, without the step of that name: its lines from `- name:` to the next no deeper than it. */
function withoutStep(text: string, name: string) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start < 0) return text;
  const depth = (line: string) => line.length - line.trimStart().length;
  const after = lines.findIndex(
    (line, i) => i > start && line.trim() !== '' && depth(line) <= depth(lines[start] ?? ''),
  );
  return [...lines.slice(0, start), ...lines.slice(after < 0 ? lines.length : after)].join('\n');
}

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

  it('is in a directory Dependabot moves, and none it moves is under .github/, where a docker update may not write', () => {
    const config = parse(readFileSync('.github/dependabot.yml', 'utf-8')) as {
      updates: { 'package-ecosystem': string; directory?: string; directories?: string[] }[];
    };
    const docker = config.updates
      .filter((update) => update['package-ecosystem'] === 'docker')
      .flatMap((update) => update.directories ?? (update.directory ? [update.directory] : []));
    expect(docker).toContain(`/${TRIVY_PIN.replace(/\/Dockerfile$/, '')}`);
    expect(docker.filter((directory) => `${directory}/`.startsWith('/.github/'))).toEqual([]);
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

  it("names Trivy, outside its pin, only in check.yml's check of its signature, and only its image and signer", () => {
    const named = workflows.flatMap(({ file, workflow }) =>
      Object.values(workflow.jobs).flatMap((job) =>
        (job.steps ?? []).filter((step) => step.name === SIGNATURES).map((step) => ({ file, step })),
      ),
    );
    expect(named.map(({ file }) => file)).toEqual(['check.yml']);
    // Every line that names Trivy, its comments' and its messages' aside: the image it matches, and the signer.
    const lines = (named[0]?.step.run ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('#') && !line.startsWith('echo') && /trivy/i.test(line));
    expect(lines).toEqual([
      'ghcr.io/aquasecurity/trivy)',
      'identity="https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v$version" ;;',
    ]);
  });

  it('is the only Trivy any workflow names, and each job that runs it reads it from its own commit', () => {
    let readers = 0;
    for (const { file, workflow } of workflows) {
      // check.yml's check of the scanners' signatures names Trivy's image and signer, and runs no Trivy: the one step
      // that may, left out of the file as written, from its name to the next line no deeper than it.
      const text = withoutStep(readFileSync(`${DIR}/${file}`, 'utf-8'), SIGNATURES);
      expect(text, file).not.toMatch(/aquasecurity\/trivy|aquasec\/trivy/);
      // Every Trivy pin a workflow names is the one file.
      for (const [path] of text.matchAll(/[\w./-]*trivy[\w./-]*Dockerfile/gi)) {
        const named = path.replace(/^(?:[\w.-]*\/)*?(?:base|factory)\//, '');
        expect(named, file).toBe(TRIVY_PIN);
      }
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const steps = job.steps ?? [];
        const runs = steps
          .filter((step) => step.name !== SIGNATURES)
          .map((step) => step.run ?? '')
          .join('\n');
        if (!/trivy/i.test(runs) && !JSON.stringify(job.env ?? {}).match(/trivy/i)) continue;
        readers++;
        // The pin, read from a checkout of this repository at the workflow's own commit, by its path there, or at the
        // base's, in a workflow that runs on pull requests and the merge queue alone, which no other repository can call.
        const onChangesAlone = triggers(workflow).every((t) => t === 'pull_request' || t === 'merge_group');
        const own = steps.find(
          (step) =>
            step.uses?.startsWith('actions/checkout@') &&
            ((step.with?.repository === expression('job.workflow_repository') &&
              step.with?.ref === expression('job.workflow_sha')) ||
              (onChangesAlone && step.with?.repository === undefined && step.with?.ref === BASE)) &&
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

/**
 * The daily scan (vulnerabilities.yml): every job that writes refuses any event but a push to the default branch, the
 * schedule or a run by hand there, and the proving run, which runs on a pull request, can write nothing at all.
 */
describe('vulnerabilities.yml', () => {
  const workflow = read('vulnerabilities.yml');
  const jobs = workflow.jobs;

  /** A job's first step, its refusal, run as the runner would, with the event and ref given. */
  function refuses(
    job: string,
    event: string,
    ref: string,
    defaultBranch = 'main',
    head = 'the-roganator/cv-software-factory',
  ) {
    const step = jobs[job]?.steps?.[0];
    expect(step?.name, job).toBe('Refuse a privileged context');
    try {
      execFileSync('bash', ['-e', '-c', step?.run ?? 'exit 1'], {
        env: {
          PATH: process.env.PATH,
          GITHUB_EVENT_NAME: event,
          GITHUB_REF: ref,
          DEFAULT_BRANCH: defaultBranch,
          HEAD_REPOSITORY: head,
          REPOSITORY: 'the-roganator/cv-software-factory',
        },
        stdio: 'pipe',
      });
      return false;
    } catch {
      return true;
    }
  }

  it('gives no job more than it needs, and the proving run no write of any kind', () => {
    expect(workflow.permissions).toEqual({});
    expect(jobs.coverage?.permissions).toEqual({ contents: 'read' });
    expect(jobs.scan?.permissions).toEqual({ contents: 'read', packages: 'read', 'security-events': 'write' });
    // The proving run reads the alerts, for the deadlines' counts, and writes nothing.
    expect(jobs.prove?.permissions).toEqual({ contents: 'read', packages: 'read', 'security-events': 'read' });
    expect(jobs.scan?.if).toBe(expression("github.event_name != 'pull_request'"));
    expect(jobs.prove?.if).toBe(expression("github.event_name == 'pull_request'"));
    // Only the scan uploads, and only from the default branch's push, the schedule or a run by hand.
    const uploads = Object.entries(jobs).flatMap(([id, job]) =>
      (job.steps ?? []).filter((step) => step.uses?.includes('upload-sarif')).map(() => id),
    );
    expect(uploads).toEqual(['scan']);
    const steps = jobs.scan?.steps ?? [];
    const upload = steps.findIndex((step) => step.uses?.includes('upload-sarif'));
    expect(steps[upload - 1]?.name).toMatch(/^Refuse to upload/);
  });

  it('refuses, in each job that writes, any event but a push to the default branch, the schedule or a run by hand', () => {
    expect(refuses('scan', 'schedule', 'refs/heads/main')).toBe(false);
    expect(refuses('scan', 'push', 'refs/heads/main')).toBe(false);
    expect(refuses('scan', 'workflow_dispatch', 'refs/heads/main')).toBe(false);
    expect(refuses('scan', 'push', 'refs/heads/feat/x')).toBe(true);
    expect(refuses('scan', 'workflow_dispatch', 'refs/heads/feat/x')).toBe(true);
    expect(refuses('scan', 'push', 'refs/heads/main', '')).toBe(true);
    for (const event of ['pull_request', 'pull_request_target', 'merge_group', 'workflow_run', 'issue_comment'])
      expect(refuses('scan', event, 'refs/heads/main'), event).toBe(true);
  });

  it('refuses a fork’s pull request in the proving run, whose token would read the alerts', () => {
    expect(refuses('prove', 'pull_request', 'refs/pull/1/merge', 'main', 'someone/cv-software-factory')).toBe(true);
    expect(refuses('prove', 'pull_request', 'refs/pull/1/merge', 'main', '')).toBe(true);
    expect(refuses('prove', 'pull_request', 'refs/pull/1/merge')).toBe(false);
    expect((jobs.prove?.steps?.[0] as { env?: unknown } | undefined)?.env).toEqual({
      HEAD_REPOSITORY: expression('github.event.pull_request.head.repo.full_name'),
      REPOSITORY: expression('github.repository'),
    });
  });

  it('runs the proving run on a pull request alone, and coverage, which writes nothing, on either', () => {
    expect(refuses('prove', 'pull_request', 'refs/pull/1/merge')).toBe(false);
    for (const event of ['push', 'schedule', 'workflow_dispatch', 'merge_group'])
      expect(refuses('prove', event, 'refs/heads/main'), event).toBe(true);
    for (const event of ['schedule', 'push', 'workflow_dispatch', 'pull_request'])
      expect(refuses('coverage', event, 'refs/heads/main'), event).toBe(false);
    for (const event of ['pull_request_target', 'merge_group', 'workflow_run'])
      expect(refuses('coverage', event, 'refs/heads/main'), event).toBe(true);
  });

  it('judges what fixes each finding before the upload, fails on its verdict after, and fails a proving run on none', () => {
    const steps = jobs.scan?.steps ?? [];
    const at = (name: string) => steps.findIndex((step) => step.name === name);
    const upload = steps.findIndex((step) => step.uses?.includes('upload-sarif'));
    const moves = steps.findIndex((step) => step.uses?.includes('upload-artifact'));
    // Each message ends with its fix before the upload, so no alert loses its day; a source not read uploads nothing.
    expect(at('Deadlines and moves')).toBeGreaterThan(at('Scan'));
    expect(at('Deadlines and moves')).toBeLessThan(upload);
    expect(steps[at('Deadlines and moves')]?.run).toContain('--write');
    expect(moves).toBeGreaterThan(at('Deadlines and moves'));
    expect(steps[moves]?.with?.name).toBe('moves');
    // The verdict fails the run after the upload and the exceptions, so each new finding's alert exists.
    expect(at('Deadlines')).toBeGreaterThan(at('Hold the alerts to the policy'));
    expect(at('Hold the alerts to the policy')).toBeGreaterThan(upload);
    expect(steps[at('Deadlines')]?.run).toContain('deadlines.ts --verdict');
    const proving = jobs.prove?.steps ?? [];
    const judged = proving.find((step) => step.name === 'Deadlines and moves, failing on none');
    expect(judged?.run).toContain('--prove');
    expect(proving.at(-1)?.with?.name).toBe('moves');
  });

  it('proves itself only on a change to the scan, against the base, as data', () => {
    const on = workflow.on as Record<string, { paths?: string[] } | null>;
    expect(on.pull_request?.paths).toEqual([
      '.github/workflows/vulnerabilities.yml',
      'apps/factory/src/vulnerabilities/**',
      'apps/factory/src/gates/**',
      'deploy/images/trivy/**',
    ]);
    const scanned = jobs.prove?.steps?.find((step) => step.with?.path === 'scanned');
    // The base branch as it is now, not as it was at the pull request's last push, read once by coverage and the same
    // commit for both.
    const covered = jobs.coverage?.steps?.find((step) => step.with?.path === 'scanned');
    expect(covered?.with?.ref).toBe(expression('github.event.pull_request.base.ref || github.sha'));
    expect(scanned?.with?.ref).toBe(expression('needs.coverage.outputs.base'));
    expect((jobs.prove as { needs?: unknown } | undefined)?.needs).toBe('coverage');
  });

  it('proves itself on a change to anything its scan reads: every module scan.ts imports', () => {
    const paths = (workflow.on as Record<string, { paths?: string[] } | null>).pull_request?.paths ?? [];
    const watched = (file: string) =>
      paths.some((p) => (p.endsWith('/**') ? file.startsWith(p.slice(0, -2)) : file === p));
    for (const file of importClosure('apps/factory/src/vulnerabilities/scan.ts'))
      if (!file.startsWith('policy/')) expect(watched(file), file).toBe(true);
  });
});

/**
 * The dependency graph (dependency-graph.yml): the job that submits holds `contents: write` and nothing else, and refuses
 * any event but a push to the default branch; the proving run, on a pull request, can write nothing. It runs Syft's
 * image by digest from its one pin, whose version build.yml's sign job reads to attest SBOMs with.
 */
describe('dependency-graph.yml', () => {
  const workflow = read('dependency-graph.yml');
  const jobs = workflow.jobs;
  const SYFT_PIN = 'deploy/images/syft/Dockerfile';

  function refuses(job: string, event: string, ref: string, defaultBranch = 'main') {
    const step = jobs[job]?.steps?.[0];
    expect(step?.name, job).toBe('Refuse a privileged context');
    try {
      execFileSync('bash', ['-e', '-c', step?.run ?? 'exit 1'], {
        env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, DEFAULT_BRANCH: defaultBranch },
        stdio: 'pipe',
      });
      return false;
    } catch {
      return true;
    }
  }

  it('gives the submission contents: write alone, and the proving run read alone', () => {
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(jobs).sort()).toEqual(['prove', 'submit']);
    expect(jobs.submit?.permissions).toEqual({ contents: 'write' });
    expect(jobs.prove?.permissions).toEqual({ contents: 'read' });
    expect(jobs.submit?.if).toBe(expression("github.event_name != 'pull_request'"));
    expect(jobs.prove?.if).toBe(expression("github.event_name == 'pull_request'"));
    expect(triggers(workflow).sort()).toEqual(['pull_request', 'push', 'workflow_call']);
    // Only the submission submits, and every checkout keeps no credentials.
    for (const [id, job] of Object.entries(jobs)) {
      const runs = (job.steps ?? []).map((step) => step.run ?? '').join('\n');
      expect(runs.includes('dependency-graph/snapshots'), id).toBe(id === 'submit');
      for (const step of (job.steps ?? []).filter((step) => step.uses?.startsWith('actions/checkout@')))
        expect(step.with?.['persist-credentials'], id).toBe(false);
    }
  });

  it('submits on a push to the default branch alone, and proves on a pull request alone', () => {
    expect(refuses('submit', 'push', 'refs/heads/main')).toBe(false);
    expect(refuses('submit', 'push', 'refs/heads/feat/x')).toBe(true);
    expect(refuses('submit', 'push', 'refs/heads/main', '')).toBe(true);
    for (const event of ['schedule', 'workflow_dispatch', 'pull_request', 'pull_request_target', 'merge_group'])
      expect(refuses('submit', event, 'refs/heads/main'), event).toBe(true);
    expect(refuses('prove', 'pull_request', 'refs/pull/1/merge')).toBe(false);
    for (const event of ['push', 'schedule', 'workflow_dispatch', 'merge_group'])
      expect(refuses('prove', event, 'refs/heads/main'), event).toBe(true);
  });

  it('proves itself only on a change to the graph, against the base, as data', () => {
    const on = workflow.on as Record<string, { paths?: string[] } | null>;
    expect(on.pull_request?.paths).toEqual([
      '.github/workflows/dependency-graph.yml',
      'apps/factory/src/vulnerabilities/**',
      'deploy/images/syft/**',
      'mise.toml',
      'mise.lock',
    ]);
    const scanned = jobs.prove?.steps?.find((step) => step.with?.path === 'scanned');
    expect(scanned?.with?.ref).toBe(expression('github.event.pull_request.base.sha'));
    expect(jobs.prove?.steps?.some((step) => (step.run ?? '').includes('--prove'))).toBe(true);
  });

  it('runs Syft by digest from its one pin, at the version build.yml attests with, and reads it from its own commit', () => {
    expect(syftPin(readFileSync(SYFT_PIN, 'utf-8'))).toBeTruthy();
    // build.yml attests with the version the pin names, read from its own commit by a job that holds no OIDC token,
    // and writes none of its own: no workflow names a Syft version, so Dependabot's bump of the pin is the whole change.
    const build = read('build.yml').jobs;
    const reader = build['syft-version'];
    const sign = build.sign;
    expect(reader?.permissions).toEqual({ contents: 'read' });
    expect(reader?.outputs?.version).toBe(expression('steps.pin.outputs.version'));
    const [own, reads, ...rest] = reader?.steps ?? [];
    expect(rest).toEqual([]);
    expect(own?.uses).toMatch(/^actions\/checkout@/);
    expect(own?.with).toEqual({
      repository: expression('job.workflow_repository'),
      ref: expression('job.workflow_sha'),
      path: 'factory',
      'sparse-checkout': SYFT_PIN,
      'sparse-checkout-cone-mode': false,
      'persist-credentials': false,
    });
    expect(reads?.id).toBe('pin');
    expect(reads?.env?.PIN).toBe(`factory/${SYFT_PIN}`);
    // The sign job checks nothing out, and never runs without the version: download-syft given none installs the newest.
    expect(sign?.needs).toContain('syft-version');
    expect(sign?.if).toContain("needs.syft-version.result == 'success'");
    expect((sign?.steps ?? []).filter((step) => step.uses?.startsWith('actions/checkout@'))).toEqual([]);
    const downloads = Object.values(build)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.uses?.startsWith('anchore/sbom-action/download-syft@'));
    expect(downloads).toEqual([
      expect.objectContaining({ with: { 'syft-version': expression('needs.syft-version.outputs.version') } }),
    ]);
    expect(sign?.steps).toContain(downloads[0]);
    for (const { file } of workflows) {
      const lines = readFileSync(`${DIR}/${file}`, 'utf-8').split('\n');
      expect(
        lines.filter((line) => /syft/i.test(line) && /v?\d+\.\d+\.\d+/.test(line.replace(/#\s*v\d+\.\d+\.\d+$/, ''))),
        file,
      ).toEqual([]);
    }
    // check.yml's check of the scanners' signatures names Syft's image, and runs no Syft: it is left out, as for Trivy.
    for (const { file } of workflows)
      if (file !== 'build.yml')
        expect(withoutStep(readFileSync(`${DIR}/${file}`, 'utf-8'), SIGNATURES), file).not.toMatch(
          /anchore\/syft|download-syft/,
        );
    for (const [id, job] of Object.entries(jobs)) {
      const own = (job.steps ?? []).find((step) => step.with?.ref === expression('job.workflow_sha'));
      expect(String(own?.with?.['sparse-checkout']), id).toContain(SYFT_PIN);
      const runs = (job.steps ?? []).map((step) => step.run ?? '').join('\n');
      expect(runs, id).toContain(`factory/${SYFT_PIN}`);
    }
  });

  it("gives build.yml's Syft the version its pin names, and fails on any pin but one of Syft's image by version and digest", () => {
    const step = read('build.yml').jobs['syft-version']?.steps?.find((s) => s.id === 'pin');
    const dir = mkdtempSync(join(tmpdir(), 'syft-pin-'));
    const version = (dockerfile: string) => {
      const pin = join(dir, 'Dockerfile');
      const output = join(dir, 'output');
      writeFileSync(pin, dockerfile);
      writeFileSync(output, '');
      try {
        execFileSync('bash', ['-e', '-c', step?.run ?? 'exit 1'], {
          env: { PATH: process.env.PATH, PIN: pin, GITHUB_OUTPUT: output },
          stdio: 'pipe',
        });
      } catch {
        return undefined;
      }
      const read = /^version=(.*)$/m.exec(readFileSync(output, 'utf-8'))?.[1];
      // The dependency graph's reader (graph.ts) takes the same version from any pin this one takes.
      if (read) expect(`v${syftPin(dockerfile)?.[2]}`, dockerfile).toBe(read);
      return read;
    };
    try {
      const pinned = `v${syftPin(readFileSync(SYFT_PIN, 'utf-8'))?.[2]}`;
      expect(version(readFileSync(SYFT_PIN, 'utf-8'))).toBe(pinned);
      const digest = `sha256:${'a'.repeat(64)}`;
      expect(version(`# a comment\nFROM ghcr.io/anchore/syft:v1.57.1@${digest}\n`)).toBe('v1.57.1');
      for (const bad of [
        `FROM ghcr.io/anchore/syft:v1.57.1\n`,
        `FROM ghcr.io/anchore/syft@${digest}\n`,
        `FROM ghcr.io/anchore/syft:latest@${digest}\n`,
        `FROM ghcr.io/anchore/syft:1.57.1@${digest}\n`,
        `FROM ghcr.io/evil/syft:v1.57.1@${digest}\n`,
        `FROM ghcr.io/anchore/syft:v1.57.1@${digest} AS x\n`,
        `FROM ghcr.io/anchore/syft:v1.57.1@${digest}\nFROM ghcr.io/anchore/syft:v1.54.0@${digest}\n`,
        `FROM ghcr.io/anchore/syft:v1.57.1-rc1@${digest}\n`,
        '',
      ])
        expect(version(bad), bad).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('platform.yml', () => {
  const workflow = read('platform.yml');
  const jobs = workflow.jobs;

  function refuses(job: string, event: string) {
    const step = jobs[job]?.steps?.[0];
    expect(step?.name, job).toBe('Refuse a privileged context');
    try {
      execFileSync('bash', ['-e', '-c', step?.run ?? 'exit 1'], {
        env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: event },
        stdio: 'pipe',
      });
      return false;
    } catch {
      return true;
    }
  }

  it('runs on a pull request and the merge queue’s commit alone, and refuses any other event in each job', () => {
    expect(triggers(workflow).sort()).toEqual(['merge_group', 'pull_request']);
    for (const job of Object.keys(jobs)) {
      for (const event of ['pull_request', 'merge_group']) expect(refuses(job, event), `${job} ${event}`).toBe(false);
      for (const event of [
        'push',
        'pull_request_target',
        'workflow_run',
        'workflow_dispatch',
        'schedule',
        'issue_comment',
      ])
        expect(refuses(job, event), `${job} ${event}`).toBe(true);
    }
  });

  it('gives the cluster a read of the contents alone, and the job that decides a read of the queue’s pull request', () => {
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(jobs).sort()).toEqual(['platform', 'which']);
    expect(jobs.platform?.permissions).toEqual({ contents: 'read' });
    expect(jobs.which?.permissions).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    for (const [id, job] of Object.entries(jobs)) {
      for (const step of (job.steps ?? []).filter((step) => step.uses?.startsWith('actions/checkout@')))
        expect(step.with?.['persist-credentials'], id).toBe(false);
      // No cache but mise's, which saves on main alone (scripts/toolchain.test.ts), where this never runs.
      expect(JSON.stringify(job).includes('actions/cache'), id).toBe(false);
    }
  });

  it('runs the cluster as check-kind.sh says, and makes it with make up at the commit it checks', () => {
    const decide = (jobs.which?.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(decide).toContain('scripts/check-kind.sh platform');
    expect(jobs.platform?.name).toBe('platform');
    // Skipped on `none` and `matched` alone: the job deciding failing, or saying anything else, makes the cluster.
    expect(jobs.platform?.if).toBe(
      expression(
        "!cancelled() && (needs.which.result != 'success' || (needs.which.outputs.platform != 'none' && needs.which.outputs.platform != 'matched'))",
      ),
    );
    const steps = jobs.platform?.steps ?? [];
    const make = steps.find((step) => /\bmake up REVISION=/.test(step.run ?? ''));
    expect(make?.run).toContain('make up REVISION="$REVISION" PLATFORM_CHECK=1');
    expect((make as { env?: Record<string, string> } | undefined)?.env?.REVISION).toBe(expression('github.sha'));
    const runs = steps.map((step) => step.run ?? '').join('\n');
    // Watched, and stopped at the ceiling or on what waiting will not mend (scripts/platform-watch.test.ts).
    expect(make?.run).toContain('WATCHED=$make scripts/platform-watch.sh');
    expect(runs).toContain('make admission-ready');
    // The end: every pod running and ready, after the records, its findings kept beside the cluster's state.
    const names = steps.map((step) => step.name);
    const pods = steps.find((step) => step.run === 'scripts/platform-pods.sh') as
      | (Step & { env?: Record<string, string> })
      | undefined;
    expect(pods?.name).toBe('Every pod running and ready');
    expect((pods as { if?: string } | undefined)?.if).toBeUndefined();
    expect(pods?.env?.OUT).toBe(`${expression('runner.temp')}/measure/pods`);
    expect(names.indexOf('Every pod running and ready')).toBeGreaterThan(names.indexOf('Take the refusal records'));
    // What the cluster showed, kept on every outcome but success, cancellation included.
    const kept = steps.find((step) => step.with?.name === 'cluster');
    expect(kept?.uses).toMatch(/^actions\/upload-artifact@/);
    expect((kept as { if?: string } | undefined)?.if).toBe(expression('failure() || cancelled()'));
    expect(runs).not.toMatch(/get secrets?\b/);
    // Each record the scripts take, with its own script, uploaded beside what the change checks in.
    for (const file of readdirSync('deploy/test').filter((f) => f.endsWith('-refusals.json'))) {
      const name = file.replace(/-refusals\.json$/, '');
      expect(runs, file).toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(steps.some((step) => step.uses?.startsWith('actions/upload-artifact@'))).toBe(true);
  });

  it('gives make up none of the keys it reads from the Keychain, so the cluster opens and attempts nothing', () => {
    const keychain = [
      ...readFileSync('Makefile', 'utf-8').matchAll(/security find-generic-password -s ([a-z-]+)/g),
    ].map((m) => m[1]);
    expect(new Set(keychain)).toEqual(
      new Set([
        'typesafe-api-key',
        'anthropic-api-key',
        'factory-github-app-key',
        'pushover-app-token',
        'pushover-user-key',
      ]),
    );
    const make = (jobs.platform?.steps ?? []).find((step) => /\bmake up\b/.test(step.run ?? ''))?.run ?? '';
    // The variables make up would read in the Keychain's place, each unset, and none given anywhere in the job.
    const variables = [
      'TYPESAFE_API_KEY',
      'ANTHROPIC_API_KEY',
      'GITHUB_APP_PRIVATE_KEY',
      'PUSHOVER_APP_TOKEN',
      'PUSHOVER_USER_KEY',
    ];
    expect(make).toContain(`unset ${variables.join(' ')}`);
    const job = JSON.stringify(jobs.platform);
    for (const variable of variables) expect(job, variable).not.toMatch(new RegExp(`\\b${variable}=`));
    expect(job).not.toContain('secrets.');
  });
});

/**
 * Every module a file reaches through its relative imports, itself included, as paths from the repository's root: what
 * a sparse checkout that runs it must hold.
 */
function importClosure(start: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf-8');
    for (const [, path] of source.matchAll(/^\s*(?:import|export)\b[^;]*?(?:from\s+)?'(\.[^']+)';?$/gm))
      walk(new URL(path ?? '', new URL(file, 'file:///r/')).pathname.slice(3));
  };
  walk(start);
  return seen;
}

/**
 * A script a workflow runs from a sparse checkout runs only if every module it imports was checked out beside it: a new
 * import fails here, not on a run of main's (as gates/counts.ts once did in the daily scan, imported through the
 * lockfile gate it reads a lockfile with).
 */
describe('every workflow’s sparse checkouts', () => {
  it('checks out, beside each script it runs with Node from a sparse checkout, every module that script imports', () => {
    const NODE = /\bnode\s+(?:--\S+\s+)*"?(?:\$GITHUB_WORKSPACE\/)?([\w./-]+\.ts)\b/g;
    let scripts = 0;
    for (const { file, workflow } of workflows) {
      for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
        // Each checkout of the job by where it puts the files: '' for the workspace itself.
        const sparse = new Map<string, string[] | undefined>();
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith('actions/checkout@')) continue;
          const list = step.with?.['sparse-checkout'];
          sparse.set(
            String(step.with?.path ?? ''),
            list === undefined
              ? undefined
              : String(list)
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean),
          );
        }
        for (const step of job.steps ?? []) {
          for (const [, ran] of (step.run ?? '').matchAll(NODE)) {
            const at = [...sparse.keys()].find((path) => path && ran?.startsWith(`${path}/`)) ?? '';
            const list = sparse.get(at);
            // A whole checkout holds everything; a script of a checkout this job does not make is another's to hold.
            if (!sparse.has(at) || list === undefined) continue;
            scripts += 1;
            const script = at ? (ran ?? '').slice(at.length + 1) : (ran ?? '');
            const has = (path: string) =>
              list.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
            for (const module of importClosure(script))
              expect(has(module), `${file} ${id}: ${script} imports ${module}, which is not checked out`).toBe(true);
          }
        }
      }
    }
    // The gates', the daily scan's and the dependency graph's scripts, at least, are read here.
    expect(scripts).toBeGreaterThanOrEqual(10);
  });
});
