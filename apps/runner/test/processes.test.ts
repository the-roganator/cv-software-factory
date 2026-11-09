import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { descendants, endAll, processTable, settled } from '../src/processes.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !check(); ) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The group kill is for a Claude Code killed before it could end its tools' commands (the SDK's SIGKILL, five seconds
// after asking): given its time, it ends them itself, so `runAgent`'s own tests cannot reach this path.
describe('what the agent’s tools left running', () => {
  it('is every process under the runner, children and theirs', () => {
    const table = [
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 10, ppid: 1, pgid: 1 },
      { pid: 11, ppid: 10, pgid: 11 },
      { pid: 12, ppid: 11, pgid: 11 },
      { pid: 20, ppid: 2, pgid: 20 },
    ];
    expect(descendants(table, 1).map((p) => p.pid)).toEqual([10, 11, 12]);
    expect(descendants(table, 12)).toEqual([]);
  });

  it('is ended with its group, a child its shell left behind too', async () => {
    // A process in a group of its own, as Claude Code runs a command's shell, with a long child. No shell: Node
    // starts the child itself.
    const shell = spawn(
      process.execPath,
      [
        '-e',
        "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); setTimeout(() => {}, 60000)",
      ],
      { detached: true, stdio: 'ignore' },
    );
    const pid = shell.pid as number;
    let snapshot: ReturnType<typeof descendants> = [];
    let child = 0;
    try {
      await until(() => {
        snapshot = descendants(processTable());
        return snapshot.some((p) => p.ppid === pid);
      });
      child = snapshot.find((p) => p.ppid === pid)?.pid as number;
      expect(snapshot.find((p) => p.pid === pid)).toMatchObject({ pgid: pid });
      // The shell goes first, so its child is no longer under the runner, only in the shell's group.
      process.kill(pid, 'SIGKILL');
      await until(() => !descendants(processTable()).some((p) => p.pid === child));
      expect(alive(child)).toBe(true);

      expect(endAll(snapshot)).toBeGreaterThan(0);
      await until(() => !alive(child));
    } finally {
      // Nothing of the test outlives it, whatever failed.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
  });

  it('waits for the runner’s own children to end, and no longer than it is given', async () => {
    const quick = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
    const slow = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await until(
        () => descendants(processTable()).filter((p) => p.pid === quick.pid || p.pid === slow.pid).length === 2,
      );
      const quickOnly = descendants(processTable()).filter((p) => p.pid === quick.pid);
      let started = Date.now();
      await settled(quickOnly);
      expect(Date.now() - started).toBeLessThan(3000);
      const slowOnly = descendants(processTable()).filter((p) => p.pid === slow.pid);
      started = Date.now();
      await settled(slowOnly, 500);
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    } finally {
      slow.kill('SIGKILL');
    }
  });

  it('is nothing to end when nothing is left', () => {
    expect(endAll([])).toBe(0);
  });
});
