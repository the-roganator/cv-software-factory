import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * check.yml's `lockfile scan` runs the gate from the base. A base without it, and a change that brings it in, is the
 * gate's own first landing: that run judges nothing and says so. A base without it otherwise fails, and every other run
 * is the base's script, whatever it answers, given the base's pin of Trivy, at its old path for a base from before #977.
 */
const workflow = parse(readFileSync('.github/workflows/check.yml', 'utf-8')) as {
  jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
};
const step = workflow.jobs['lockfile-scan']?.steps?.find((s) => s.name === 'Compare the lockfiles')?.run ?? 'exit 99';

/** The step's script, run as the runner would, in a workspace with or without the base's gate. */
function compare(gate?: string, { changeBringsIt = true, pins = ['deploy/images/trivy/Dockerfile'] } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'lockfile-scan-job-'));
  try {
    const place = (side: string, text: string) => {
      mkdirSync(join(workspace, side, 'apps/factory/src/gates'), { recursive: true });
      writeFileSync(join(workspace, side, 'apps/factory/src/gates/lockfile-scan.ts'), text);
    };
    if (gate !== undefined) place('base', gate);
    for (const pin of pins) {
      mkdirSync(join(workspace, 'base', pin, '..'), { recursive: true });
      writeFileSync(join(workspace, 'base', pin), 'FROM trivy\n');
    }
    if (changeBringsIt) place('change', 'process.exitCode = 1;');
    return spawnSync('bash', ['-e', '-c', step], { cwd: workspace, encoding: 'utf-8' });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe("the lockfile scan's checkouts", () => {
  it("fetch every lockfile the gate reads, a branch's too, at any depth, on both sides, in both workflows", () => {
    for (const file of ['.github/workflows/check.yml', '.github/workflows/app-gates.yml']) {
      const job = parse(readFileSync(file, 'utf-8')).jobs['lockfile-scan'] as {
        steps: { uses?: string; with?: Record<string, string> }[];
      };
      for (const path of ['base', 'change']) {
        const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@') && s.with?.path === path);
        expect(String(checkout?.with?.['sparse-checkout']).split('\n'), `${file} ${path}`).toContain('pnpm-lock*.yaml');
      }
    }
  });
});

describe("check.yml's lockfile scan", () => {
  it('judges nothing, and says so, when the base has no gate and the change brings it in', () => {
    const run = compare();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('::notice::The base has no lockfile gate yet');
  });

  it('fails when the base has no gate and the change does not bring one in', () => {
    const run = compare(undefined, { changeBringsIt: false });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('::error::The base has no lockfile gate');
  });

  it("runs the base's gate when it has one, with the base, the change, the base's pin, and fails as it fails", () => {
    const argv = 'console.log(JSON.stringify(process.argv.slice(2)));';
    const passed = compare(argv);
    expect(passed.status).toBe(0);
    expect(JSON.parse(passed.stdout)).toEqual(['base', 'change', '--trivy-pin', 'base/deploy/images/trivy/Dockerfile']);
    expect(passed.stdout).not.toContain('::notice::');
    expect(compare('process.exitCode = 1;').status).toBe(1);
  });

  it("reads the base's pin at its old path only when the base has none at the new one", () => {
    const argv = 'console.log(JSON.stringify(process.argv.slice(2)));';
    const pinOf = (pins: string[]) => {
      const args = JSON.parse(compare(argv, { pins }).stdout) as string[];
      return args[args.indexOf('--trivy-pin') + 1];
    };
    expect(pinOf(['.github/images/trivy/Dockerfile'])).toBe('base/.github/images/trivy/Dockerfile');
    expect(pinOf(['deploy/images/trivy/Dockerfile', '.github/images/trivy/Dockerfile'])).toBe(
      'base/deploy/images/trivy/Dockerfile',
    );
    // With neither, the base's gate is given the new path, and fails on it.
    expect(pinOf([])).toBe('base/deploy/images/trivy/Dockerfile');
  });
});

describe("the exceptions, from main's policy alone", () => {
  type Step = { id?: string; name?: string; uses?: string; run?: string; with?: Record<string, string> };
  const jobs = [
    ['.github/workflows/check.yml', 'lockfile-scan', 'base'],
    ['.github/workflows/app-gates.yml', 'lockfile-scan', 'factory'],
    ['.github/workflows/app-gates.yml', 'image-scan', 'factory'],
    ['.github/workflows/app-gates.yml', 'dependency-review', 'factory'],
    ['.github/workflows/vulnerabilities.yml', 'scan', 'factory'],
    ['.github/workflows/vulnerabilities.yml', 'prove', 'factory'],
  ] as const;

  it("put main's policy/vulnerabilities.ts where the script imports it, before it runs, in every job that reads it", () => {
    for (const [file, name, into] of jobs) {
      const steps = (parse(readFileSync(file, 'utf-8')).jobs[name] as { steps: Step[] }).steps;
      const main = steps.findIndex((s) => s.uses?.startsWith('actions/checkout@') && s.with?.path === 'policy-main');
      const checkout = steps[main]?.with ?? {};
      expect(checkout.ref, `${file} ${name}`).toBe('main');
      expect(checkout['sparse-checkout'], `${file} ${name}`).toBe('policy/vulnerabilities.ts');
      // This repository's main, whoever calls the workflow.
      if (file !== '.github/workflows/check.yml')
        expect(checkout.repository).toBe(['${{', 'job.workflow_repository', '}}'].join(' '));
      const take = steps.findIndex((s) => s.name === 'Take the exceptions from main');
      expect(take, `${file} ${name}`).toBeGreaterThan(main);
      expect(steps[take]?.run).toContain(`cp policy-main/policy/vulnerabilities.ts ${into}/policy/vulnerabilities.ts`);
      const runs = steps.findIndex((s) => /lockfile-scan\.ts|scan\.ts|dependency-allow\.ts/.test(s.run ?? ''));
      expect(runs, `${file} ${name}`).toBeGreaterThan(take);
    }
  });

  it("gives dependency review the advisories main's policy allows, read after main's copy is in place", () => {
    const steps = (
      parse(readFileSync('.github/workflows/app-gates.yml', 'utf-8')).jobs['dependency-review'] as {
        steps: Step[];
      }
    ).steps;
    const allow = steps.findIndex((s) => s.run === 'node factory/apps/factory/src/gates/dependency-allow.ts');
    const review = steps.findIndex((s) => s.uses?.startsWith('actions/dependency-review-action@'));
    expect(allow).toBeGreaterThan(steps.findIndex((s) => s.name === 'Take the exceptions from main'));
    expect(review).toBeGreaterThan(allow);
    expect(steps[allow]?.id).toBe('allow');
    expect(steps[review]?.with?.['allow-ghsas']).toBe(['${{', 'steps.allow.outputs.ghsas', '}}'].join(' '));
  });

  it("replaces the checkout's copy with main's, and keeps the checkout's only while main has none", () => {
    const step =
      (
        parse(readFileSync('.github/workflows/check.yml', 'utf-8')).jobs['lockfile-scan'] as { steps: Step[] }
      ).steps.find((s) => s.name === 'Take the exceptions from main')?.run ?? 'exit 99';
    const workspace = mkdtempSync(join(tmpdir(), 'exceptions-take-'));
    try {
      mkdirSync(join(workspace, 'base/policy'), { recursive: true });
      writeFileSync(join(workspace, 'base/policy/vulnerabilities.ts'), "// the base's\n");
      const none = spawnSync('bash', ['-e', '-c', step], { cwd: workspace, encoding: 'utf-8' });
      expect(none.status).toBe(0);
      expect(none.stdout).toContain('::warning::main holds no policy/vulnerabilities.ts yet');
      expect(readFileSync(join(workspace, 'base/policy/vulnerabilities.ts'), 'utf-8')).toBe("// the base's\n");
      mkdirSync(join(workspace, 'policy-main/policy'), { recursive: true });
      writeFileSync(join(workspace, 'policy-main/policy/vulnerabilities.ts'), "// main's\n");
      expect(spawnSync('bash', ['-e', '-c', step], { cwd: workspace }).status).toBe(0);
      expect(readFileSync(join(workspace, 'base/policy/vulnerabilities.ts'), 'utf-8')).toBe("// main's\n");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
