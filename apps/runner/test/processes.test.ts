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

// The step's end is tested through `runAgent` (agent.test.ts): a command moved to the background, and one whose
// process ignores SIGTERM, each gone, and the handback's note, turns and patch the agent's, within seconds of the
// result; and, in "says what it does", the exact lines of a step with nothing left, with no ending of anything. What is tested here directly is what `runAgent`
// cannot show:
// - what the snapshot leaves out, and the kill spares: a process outside it, even in the runner's own group;
// - the group kill, for a Claude Code killed (the SDK's SIGKILL, five seconds after asking) before it could end its
//   tools' commands: given its time, Claude Code ends them itself, so no test through the SDK reaches it;
// - the wait for Claude Code: that it returns as soon as Claude Code has ended, not after its bound, and keeps to the
//   bound when it has not.
// Not tested: that the session Claude Code leaves is whole, and the process's exit after the handback (cli.ts), seen
// by hand in the runner's container (#963): on the host `runner agent` waits for a fence it has not got.
describe('what the agent’s tools left running', () => {
  it('is every process under the runner, children and theirs, and nothing else', () => {
    const table = [
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 10, ppid: 1, pgid: 1 },
      { pid: 11, ppid: 10, pgid: 11 },
      { pid: 12, ppid: 11, pgid: 11 },
      // Another tree, in the runner's own group: never part of the snapshot.
      { pid: 20, ppid: 2, pgid: 1 },
    ];
    expect(descendants(table, 1).map((p) => p.pid)).toEqual([10, 11, 12]);
    expect(descendants(table, 12)).toEqual([]);
  });

  it('is ended with its group, a child its shell left behind too, and nothing outside it', async () => {
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
    // Started after the snapshot, in the runner's own group: not part of it, so never killed.
    let sentinel: ReturnType<typeof spawn> | undefined;
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
      sentinel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      const spared = sentinel.pid as number;
      await until(() => processTable().some((p) => p.pid === spared));

      expect(endAll(snapshot)).toBeGreaterThan(0);
      await until(() => !alive(child));
      expect(alive(spared)).toBe(true);
    } finally {
      sentinel?.kill('SIGKILL');
      // Nothing of the test outlives it, whatever failed.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
  });

  it('waits for Claude Code until it ends, and no longer than it is given', async () => {
    const quick = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
    const slow = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await until(
        () => descendants(processTable()).filter((p) => p.pid === quick.pid || p.pid === slow.pid).length === 2,
      );
      // Ended after 300 ms: the wait returns then, well inside a bound of ten seconds.
      let started = Date.now();
      await settled(
        descendants(processTable()).filter((p) => p.pid === quick.pid),
        10_000,
      );
      expect(Date.now() - started).toBeLessThan(5000);
      // Never ending: the wait keeps to its bound.
      started = Date.now();
      await settled(
        descendants(processTable()).filter((p) => p.pid === slow.pid),
        500,
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    } finally {
      slow.kill('SIGKILL');
    }
  });
});
