import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * The line platform.yml's next step carries in its name when the cluster does not come up (scripts/platform-fault.sh),
 * from stand-ins for the runner's tools: one line, the figures first, no longer than 200 characters, and said however
 * little of the runner still answers.
 */

const SCRIPT = resolve('scripts/platform-fault.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A runner: each tool a script printing what it is given, or failing when given nothing. */
function runner(tools: Record<string, string>, measure: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-fault-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'measure'));
  for (const tool of ['free', 'df', 'sudo', 'curl', 'getent', 'docker', 'kubectl']) {
    const body = tools[tool];
    writeFileSync(
      join(dir, 'bin', tool),
      body === undefined ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\n`,
    );
    chmodSync(join(dir, 'bin', tool), 0o755);
  }
  for (const [file, text] of Object.entries(measure)) writeFileSync(join(dir, 'measure', file), text);
  return (why: string) => {
    const result = spawnSync(SCRIPT, [why, join(dir, 'measure')], {
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, KUBECTL: 'kubectl' },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return { status: result.status, out: result.stdout };
  };
}

const FREE = `               total        used        free      shared  buff/cache   available
Mem:           15701        6120        8000          44        1005       9000
Swap:           3071          12        3059`;
const DF = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/root        151000000  62000000  89000000      41% /`;
const PODS = `kube-system   coredns-577d995dff-gdgkr   1/1   Running             0   5m12s
argocd        argocd-redis-secret-init-6fsb4   0/1   ContainerCreating   0   5m6s
kube-system   traefik-77b898c5c8-khhcn   1/1   Running             0   5m`;

describe('why the cluster did not come up', () => {
  it("says make's status and last words, the runner's figures, and the first pod not running", () => {
    const fault = runner(
      {
        free: FREE,
        df: DF,
        sudo: 'kernel: nothing\nkernel: Out of memory: Killed process 1',
        curl: '401',
        getent: '140.82.112.33 ghcr.io',
        docker: 'ok',
        kubectl: PODS,
      },
      {
        memory: '900\n7738\n6120\n',
        'make.log':
          'helm upgrade --install argocd\nError: failed pre-install: resource Job/argocd/argocd-redis-secret-init not ready\nmake: *** [Makefile:116: up] Error 1\n\n',
      },
    );
    expect(fault('make 2')).toEqual({
      status: 0,
      out: 'make 2 | mem 6120/7738M swap 12M | disk 41% | oom 1 | net ghcr 401 gh 401 dns ok | docker ok | pod argocd/argocd-redis-secret-init-6fsb4 ContainerCreating 5m6s | make: *** [Makefile:116: up] Error 1\n',
    });
  });

  it("says the watch's first line when the watch stopped it", () => {
    const fault = runner(
      { free: FREE, df: DF, curl: '200', getent: 'x', docker: 'ok', kubectl: '' },
      { memory: '1\n', 'watch.log': "degraded: factory has been Degraded for 300 seconds\n  root's sync: Running\n" },
    );
    expect(fault('watch').out).toMatch(
      /^watch \| .* \| pod none \| degraded: factory has been Degraded for 300 seconds\n$/,
    );
  });

  it('says what it can, on one line of at most 200 characters, when nothing on the runner answers', () => {
    const fault = runner({}, { 'make.log': `${'x'.repeat(300)}\n` });
    const { status, out } = fault('make 2');
    expect(status).toBe(0);
    expect(out).toMatch(
      /^make 2 \| mem \?\/\?M swap \?M \| disk \? \| oom 0 \| net ghcr 000 gh 000 dns no \| docker no \| pod none \| x+\n$/,
    );
    expect(out.trimEnd()).toHaveLength(200);
  });

  it('ends a call that catches SIGTERM and goes on waiting, at its limit and two seconds more', () => {
    const fault = runner({ free: FREE, df: DF, curl: '401', getent: 'x', kubectl: '' }, { 'make.log': 'up\n' });
    // Docker that waits on past SIGTERM, as a CLI that catches it to cancel its request may.
    const dir = dirs[dirs.length - 1] as string;
    writeFileSync(join(dir, 'bin', 'docker'), '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n');
    const started = Date.now();
    const { status, out } = fault('timed out');
    expect(status).toBe(0);
    expect(out).toMatch(/^timed out \| .* \| docker no \| pod none \| up\n$/);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
