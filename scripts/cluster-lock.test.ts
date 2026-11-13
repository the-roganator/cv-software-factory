import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holderProcess, processAlive, writeLock } from './cluster-lock.ts';

const CLI = join(import.meta.dirname, 'cluster-lock.ts');
let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cluster-lock-'));
  lock = join(dir, 'cluster.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `check` as make up runs it, with the lock here. */
const check = (env: Record<string, string> = {}, ...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, 'check', ...args], {
    env: { ...process.env, CLUSTER_LOCK: lock, TRY_HOLDER: '', ...env },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout + r.stderr };
};
/** A lock held by this test's own process, which runs. */
const heldLive = (holder: string) =>
  writeLock(lock, { holder, pid: process.pid, started: started(process.pid), since: 'now', host: hostname() }, true);
const started = (pid: number) =>
  spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  }).stdout.trim();

describe('check', () => {
  it('passes, saying nothing, when the cluster is free', () => {
    expect(check()).toEqual({ status: 0, out: '' });
  });

  it('refuses while another holds it, naming them and FORCE=1', () => {
    heldLive('m7d-try');
    const r = check();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/held by m7d-try \(pid \d+ on .*\)/);
    expect(r.out).toMatch(/FORCE=1/);
  });

  it('goes ahead with --force, saying who held it', () => {
    heldLive('m7d-try');
    const r = check({}, '--force');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/held by m7d-try/);
  });

  it('passes for the holder itself', () => {
    heldLive('m7d-try');
    expect(check({ TRY_HOLDER: 'm7d-try' }).status).toBe(0);
  });

  it('passes over a stale lock, saying so', () => {
    writeLock(lock, { holder: 'gone', pid: process.pid, started: 'never', since: 'then', host: hostname() }, true);
    const r = check();
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/gone .* whose process has ended: stale/);
  });

  it('refuses when the lock cannot be read', () => {
    writeFileSync(lock, 'not a lock');
    const r = check();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/cannot be read/);
  });
});

describe('the holding process', () => {
  it('is read in the C locale, whatever the caller runs under', () => {
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `import('${join(import.meta.dirname, 'cluster-lock.ts')}').then((m) => console.log(m.processAlive({ pid: ${process.pid}, started: ${JSON.stringify(started(process.pid))} })))`,
      ],
      { env: { ...process.env, LC_ALL: 'en_GB.UTF-8', LANG: 'en_GB.UTF-8' }, encoding: 'utf8' },
    );
    expect(r.stdout.trim()).toBe('true');
  });

  it('is a process that runs, and is known by its start time as well as its pid', () => {
    const me = holderProcess();
    expect(processAlive(me)).toBe(true);
    expect(processAlive({ ...me, started: 'Thu 1 Jan 00:00:00 1970' })).toBe(false);
  });
});
