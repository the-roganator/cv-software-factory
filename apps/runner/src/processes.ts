/**
 * What the agent's tools left running, and ending it. Claude Code moves a shell command past its timeout into the
 * background and holds its session open until the command ends, so a step whose agent has its result could otherwise
 * wait on a tool's child (a `pnpm install` waiting on a network the pod does not have) until the pod's deadline.
 *
 * The agent step takes a snapshot of its own descendants when the agent's result arrives, while Claude Code still
 * holds them, closes the SDK's query, and then ends every one of them that is left, with the process group each of
 * Claude Code's shells leads, so a child that outlived its shell goes too. Never the runner's own group: on the host
 * that is the terminal's or the test runner's, and in the pod the runner is the container's first process, whose
 * exit takes everything in it.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
}

/** Every process this one can see: from `/proc` on Linux (the image has no `ps`), from `ps` elsewhere. */
export function processTable(): Proc[] {
  if (process.platform === 'linux') {
    const table: Proc[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        // The command's name is in brackets and may hold spaces or brackets of its own: the fields after its last `)`.
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf-8');
        const [state, ppid, pgid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        // A zombie has ended: in the pod the runner, as its first process, is the parent of every orphan, and
        // does not reap them.
        if (state === 'Z') continue;
        table.push({ pid: Number(entry), ppid: Number(ppid), pgid: Number(pgid) });
      } catch {
        // It ended while the table was read.
      }
    }
    return table;
  }
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, , , stat]) => !stat?.startsWith('Z'))
    .map(([pid = '0', ppid = '0', pgid = '0']) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) }));
}

/** The processes under `root`, children and theirs, as `table` has them. */
export function descendants(table: Proc[], root = process.pid): Proc[] {
  const found: Proc[] = [];
  const parents = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const proc of table) {
      if (parents.has(proc.ppid) && !parents.has(proc.pid)) {
        parents.add(proc.pid);
        found.push(proc);
        grew = true;
      }
    }
  }
  return found;
}

/** How long the SDK gives Claude Code to end on its own when the query closes, before it kills it, and a second. */
export const SETTLE_MS = 6000;

/**
 * Waits until the runner's own children in `snapshot` (Claude Code, which the SDK started) have ended, or `ms` has
 * passed: closing the query asks Claude Code to end, and it ends its tools' commands as it goes.
 */
export async function settled(snapshot: Proc[], ms = SETTLE_MS): Promise<void> {
  const children = new Set(snapshot.filter((proc) => proc.ppid === process.pid).map((proc) => proc.pid));
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (!processTable().some((proc) => children.has(proc.pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Kills what `snapshot` holds that is still running: each process group one of them leads, but never this process's
 * own, and then each process. A pid freed since the snapshot and taken by another process could be signalled, so the
 * snapshot is taken as late as it can be, and acted on at once. Returns how many were still running.
 */
export function endAll(snapshot: Proc[], table = processTable()): number {
  const own = table.find((proc) => proc.pid === process.pid)?.pgid;
  const leaders = new Set(snapshot.filter((proc) => proc.pid === proc.pgid && proc.pgid !== own).map((p) => p.pgid));
  const pids = new Set(snapshot.map((proc) => proc.pid));
  const left = table.filter((proc) => proc.pid !== process.pid && (pids.has(proc.pid) || leaders.has(proc.pgid)));
  const signal = (target: number) => {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Gone already.
    }
  };
  for (const group of leaders) signal(-group);
  for (const proc of left) signal(proc.pid);
  return left.length;
}
