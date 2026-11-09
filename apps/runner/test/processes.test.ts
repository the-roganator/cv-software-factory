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
// process ignores SIGTERM, each ended within seconds of the result and the step handed back whole. What is tested here
// directly is only what `runAgent` cannot show:
// - the group kill, for a Claude Code killed (the SDK's SIGKILL, five seconds after asking) before it could end its
//   tools' commands: given its time, Claude Code ends them itself, so no test through the SDK reaches this path;
// - the bound on the wait for Claude Code to end, which, ending in time, it never reaches.
// The process's exit after the handback (cli.ts) is shown in the runner's container: on the host `runner agent` waits
// for a fence it has not got.
describe('what the agent’s tools left running', () => {
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

  it('waits for Claude Code to end no longer than it is given', async () => {
    const slow = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await until(() => descendants(processTable()).some((p) => p.pid === slow.pid));
      const snapshot = descendants(processTable()).filter((p) => p.pid === slow.pid);
      const started = Date.now();
      await settled(snapshot, 500);
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      slow.kill('SIGKILL');
    }
  });
});
