import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * stop.sh, run as it is beside a `kubectl` and a `copies.sh` that stand for the scratch store and the copy's `make`:
 * the store is one line in a file (`<line> new-work=<on|off>`, as stop.sh's read prints it), which `copies.sh line …`
 * changes as Martin's commands would, or leaves when it is told to fail.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function stop(want: string, stands: string, fails = false) {
  const dir = mkdtempSync(join(tmpdir(), 'stop-'));
  dirs.push(dir);
  copyFileSync(join(import.meta.dirname, 'stop.sh'), join(dir, 'stop.sh'));
  const [store, calls] = [join(dir, 'store'), join(dir, 'calls')];
  writeFileSync(store, `${stands}\n`);
  writeFileSync(calls, '');
  // The store's read: whatever SQL is asked, how the line stands.
  writeFileSync(join(dir, 'kubectl'), `#!/usr/bin/env bash\ncat >/dev/null\ncat "${store}"\n`);
  writeFileSync(
    join(dir, 'copies.sh'),
    `#!/usr/bin/env bash
echo "$*" >>"${calls}"
echo "make says something"
${fails ? 'exit 1' : ''}
read -r line work <"${store}"
case "$2" in
  stop) [ "$line" = never ] || line=stopped ;;
  start) line=running ;;
  new-work-off) work=new-work=off ;;
esac
echo "$line $work" >"${store}"
`,
  );
  for (const name of ['stop.sh', 'kubectl', 'copies.sh']) chmodSync(join(dir, name), 0o755);
  const ran = spawnSync(join(dir, 'stop.sh'), [want], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  return {
    status: ran.status,
    out: ran.stdout.trim(),
    err: ran.stderr,
    calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
    store: readFileSync(store, 'utf8').trim(),
  };
}

describe('the scratch line, stopped and started', () => {
  it('stops a running line and starts a stopped one by the copy’s own commands, whatever the store holds', () => {
    expect(stop('stopped', 'running new-work=off')).toMatchObject({ status: 0, out: 'stopped', calls: ['line stop'] });
    expect(stop('running', 'stopped new-work=off')).toMatchObject({ status: 0, out: 'running', calls: ['line start'] });
  });

  it('starts a line never started, new work off first, and takes one never started as stopped', () => {
    expect(stop('running', 'never new-work=on')).toMatchObject({
      status: 0,
      out: 'running',
      calls: ['line new-work-off', 'line start'],
      store: 'running new-work=off',
    });
    // No line.stopped to shape one on, and none needed: every worker takes a line not yet started as stopped.
    expect(stop('stopped', 'never new-work=on')).toMatchObject({ status: 0, out: 'stopped', calls: [] });
  });

  it('runs nothing the store already says, and sets new work off under a line that runs with it on', () => {
    expect(stop('running', 'running new-work=off')).toMatchObject({ status: 0, out: 'running', calls: [] });
    expect(stop('stopped', 'stopped new-work=on')).toMatchObject({ status: 0, out: 'stopped', calls: [] });
    expect(stop('running', 'running new-work=on')).toMatchObject({
      status: 0,
      out: 'running',
      calls: ['line new-work-off'],
    });
  });

  it('prints the one word alone, and fails, naming a command that exists, when the line does not stand as asked', () => {
    const stopped = stop('stopped', 'running new-work=off', true);
    expect(stopped).toMatchObject({ status: 1, out: '' });
    expect(stopped.err).toContain('the scratch line is not stopped (it stands: running new-work=off)');
    expect(stopped.err).toContain('make stop-the-line in work/factory');
    const running = stop('running', 'stopped new-work=on', true);
    expect(running).toMatchObject({ status: 1, out: '' });
    expect(running.err).toContain('make new-work OFF=1 and make start-the-line in work/factory');
    expect(running.err).not.toContain('running-the-line');
    expect(stop('sideways', 'running new-work=off').status).toBe(2);
  });

  it('names only targets the Makefile has', () => {
    const makefile = readFileSync(join(import.meta.dirname, '../../../../Makefile'), 'utf8');
    const copies = readFileSync(join(import.meta.dirname, 'copies.sh'), 'utf8');
    const named = [...copies.matchAll(/in_copy make ([a-z-]+-the-line|new-work)\b/g)].map((m) => m[1]);
    expect(named.sort()).toEqual(['new-work', 'start-the-line', 'stop-the-line']);
    for (const target of named) expect(makefile).toMatch(new RegExp(`^${target}:`, 'm'));
  });
});
