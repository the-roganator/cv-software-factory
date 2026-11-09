import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * check.yml's `lockfile scan` runs the gate from the base. A base without it, and a change that brings it in, is the
 * gate's own first landing: that run judges nothing and says so. A base without it otherwise fails, and every other run
 * is the base's script, whatever it answers.
 */
const workflow = parse(readFileSync('.github/workflows/check.yml', 'utf-8')) as {
  jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
};
const step = workflow.jobs['lockfile-scan']?.steps?.find((s) => s.name === 'Compare the lockfiles')?.run ?? 'exit 99';

/** The step's script, run as the runner would, in a workspace with or without the base's gate. */
function compare(gate?: string, { changeBringsIt = true } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'lockfile-scan-job-'));
  try {
    const place = (side: string, text: string) => {
      mkdirSync(join(workspace, side, 'apps/factory/src/gates'), { recursive: true });
      writeFileSync(join(workspace, side, 'apps/factory/src/gates/lockfile-scan.ts'), text);
    };
    if (gate !== undefined) place('base', gate);
    if (changeBringsIt) place('change', 'process.exitCode = 1;');
    return spawnSync('bash', ['-e', '-c', step], { cwd: workspace, encoding: 'utf-8' });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

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

  it("runs the base's gate when it has one, with the base, the change and the base's pin, and fails as it fails", () => {
    const argv = 'console.log(JSON.stringify(process.argv.slice(2)));';
    const passed = compare(argv);
    expect(passed.status).toBe(0);
    expect(JSON.parse(passed.stdout)).toEqual([
      'base',
      'change',
      '--trivy-pin',
      'base/.github/images/trivy/Dockerfile',
    ]);
    expect(passed.stdout).not.toContain('::notice::');
    expect(compare('process.exitCode = 1;').status).toBe(1);
  });
});
