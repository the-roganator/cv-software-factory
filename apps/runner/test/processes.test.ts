import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { descendants, endAll, processTable } from '../src/processes.ts';

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
    // A shell in a group of its own, as Claude Code runs a command, with a long child.
    const shell = spawn('sh', ['-c', `${process.execPath} -e "setTimeout(() => {}, 60000)" & wait`], {
      detached: true,
      stdio: 'ignore',
    });
    const pid = shell.pid as number;
    let snapshot = descendants(processTable());
    await until(() => {
      snapshot = descendants(processTable());
      return snapshot.some((p) => p.ppid === pid);
    });
    const child = snapshot.find((p) => p.ppid === pid)?.pid as number;
    expect(snapshot.find((p) => p.pid === pid)).toMatchObject({ pgid: pid });
    // The shell goes first, so its child is no longer under the runner, only in the shell's group.
    process.kill(pid, 'SIGKILL');
    await until(() => !descendants(processTable()).some((p) => p.pid === child));
    expect(alive(child)).toBe(true);

    expect(endAll(snapshot)).toBeGreaterThan(0);
    await until(() => !alive(child));
  });

  it('is nothing to end when nothing is left', () => {
    expect(endAll([])).toBe(0);
  });
});
