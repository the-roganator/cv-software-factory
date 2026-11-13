import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, 'bench-down.sh');
let dir: string;
let children: ChildProcess[] = [];

/** A docker on PATH: running or not, with these containers, each removal logged. */
function docker(running: boolean, containers: string[]): void {
  writeFileSync(join(dir, 'containers'), containers.map((c) => `${c}\n`).join(''));
  const fake = join(dir, 'docker');
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
case $1 in
  info) exit ${running ? 0 : 1} ;;
  ps) cat "${join(dir, 'containers')}" ;;
  exec) echo '3 model calls, $0.42' ;;
  rm) echo "$*" >> "${join(dir, 'removed')}" ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(fake, 0o755);
}

/** A process listening on a free port of 127.0.0.1, its command line ending with these words; and the port. */
async function listener(...words: string[]): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => console.log(s.address().port))",
      ...words,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.push(child);
  const port = await new Promise<number>((r) => child.stdout?.once('data', (d) => r(Number(String(d).trim()))));
  return { child, port };
}

const down = (port: number) => {
  const r = spawnSync('bash', [SCRIPT], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BENCH_PORT: String(port) },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout + r.stderr };
};
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bench-down-'));
});
afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children = [];
  rmSync(dir, { recursive: true, force: true });
});

describe('bench-down', () => {
  it("stops the bench's gateway, and removes only the bench's containers, saying what each cost", async () => {
    const { child: gateway, port } = await listener('apps/factory/src/cli.ts', 'gateway');
    docker(true, ['sf-bench-pg', 'k3d-software-factory-server-0', 'other-sf-bench-pg']);
    const r = down(port);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(r.status).toBe(0);
    expect(r.out).toMatch(new RegExp(`Stopped the bench's gateway: pid ${gateway.pid} on port ${port}\\.`));
    expect(alive(gateway)).toBe(false);
    expect(r.out).toContain('Removed the container sf-bench-pg (it recorded 3 model calls, $0.42).');
    expect(readFileSync(join(dir, 'removed'), 'utf8')).toBe('rm -f sf-bench-pg\n');
  });

  it("leaves whatever else listens on the bench's port", async () => {
    const { child: other, port } = await listener('something-else');
    docker(true, []);
    const r = down(port);
    expect(r.out).toMatch(/Left pid \d+ on port \d+: it is not the factory's gateway/);
    expect(alive(other)).toBe(true);
    expect(r.out).toMatch(/Nothing of the bench was running/);
  });

  it('says when Docker is not running, and removes nothing', async () => {
    docker(false, ['sf-bench-pg']);
    const r = down(1);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Docker is not running/);
    expect(existsSync(join(dir, 'removed'))).toBe(false);
  });
});
