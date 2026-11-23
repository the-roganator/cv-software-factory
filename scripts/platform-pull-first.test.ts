import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * Argo CD's images pulled into the platform check's node before the install (scripts/platform-pull-first.sh), from a
 * stand-in for docker: a pull that hangs is ended at its limit and tried again, and one that never pulls fails the step
 * by name, in seconds, not at the step's limit.
 */

const SCRIPT = resolve('scripts/platform-pull-first.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A docker whose `exec … crictl pull` follows `plan`, one word a call: `ok` pulls, `hang` waits out its limit, and
 * `fail` says why and fails. Each call it is given goes to `calls`.
 */
function pull(plan: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pull-first-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'plan'), `${plan.join('\n')}\n`);
  writeFileSync(
    join(dir, 'bin', 'docker'),
    `#!/bin/bash
echo "$*" >> "${dir}/calls"
step=$(head -1 "${dir}/plan"); sed -i.bak 1d "${dir}/plan"
case "$step" in
  ok) echo "Image is up to date for sha256:1" ;;
  # As the node's own timeout ends a pull that hangs: at the limit it is given.
  hang) sleep "$4"; exit 124 ;;
  *) echo 'E1123 failed to pull image: rpc error: code = Unknown desc = failed to resolve reference'; exit 1 ;;
esac
`,
  );
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  const result = spawnSync(SCRIPT, [], {
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      IMAGES: 'quay.io/argoproj/argocd:v3.6.1\necr-public.aws.com/docker/library/redis:8.6.4-alpine',
      LIMIT: '1',
      ...env,
    },
    encoding: 'utf-8',
    timeout: 60_000,
  });
  const calls = readFileSync(join(dir, 'calls'), 'utf-8').trim().split('\n');
  return { status: result.status, out: result.stdout, calls };
}

describe("Argo CD's images, pulled first", () => {
  it('pulls each image in the node, ended inside it at the limit, and says how long each took', () => {
    const { status, out, calls } = pull(['ok', 'ok']);
    expect(status).toBe(0);
    expect(calls).toEqual([
      'exec k3d-software-factory-server-0 timeout 1 crictl pull quay.io/argoproj/argocd:v3.6.1',
      'exec k3d-software-factory-server-0 timeout 1 crictl pull ecr-public.aws.com/docker/library/redis:8.6.4-alpine',
    ]);
    expect(out).toMatch(/^Pulled quay\.io\/argoproj\/argocd:v3\.6\.1 in \d+s \(try 1 of 3\)\.$/m);
  });

  it('ends a pull that hangs and tries it again', () => {
    const { status, out, calls } = pull(['hang', 'fail', 'ok', 'ok']);
    expect(status).toBe(0);
    expect(calls).toHaveLength(4);
    expect(out).toMatch(/^quay\.io\/argoproj\/argocd:v3\.6\.1 did not pull in \d+s \(try 1 of 3\): /m);
    expect(out).toMatch(/\(try 2 of 3\): E1123 failed to pull image: rpc error/);
    expect(out).toMatch(/^Pulled quay\.io\/argoproj\/argocd:v3\.6\.1 in \d+s \(try 3 of 3\)\.$/m);
  });

  it('fails by name, after its tries, when an image never pulls', () => {
    const { status, out, calls } = pull(['ok', 'hang', 'hang'], { TRIES: '2' });
    expect(status).toBe(1);
    expect(calls).toHaveLength(3);
    expect(out).toContain(
      '::error::ecr-public.aws.com/docker/library/redis:8.6.4-alpine did not pull into the node in 2 tries of 1s',
    );
  });
});
