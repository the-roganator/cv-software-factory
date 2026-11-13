#!/usr/bin/env node
// One watcher for the machine: says when a background Claude Code session needs a person or has gone quiet, and costs
// no tokens doing it.
//
//   node .claude/skills/implement/bin/watch.ts                   run the detector, unless one already runs
//   node .claude/skills/implement/bin/watch.ts --follow <prefix> wait for a line about a session named <prefix>…
//   node .claude/skills/implement/bin/watch.ts --once            print every background session's state, and exit
//
// The detector holds a lock, a pid file under ~/.config/software-factory/watch/ (WATCH_DIR), so one runs however many
// sessions start it: a second start says who holds it and exits 0. Every 30 seconds it reads `claude agents --json
// --all` and, for each background session that has not ended:
//   - `blocked` for three minutes: it waits on a person (a permission, a question), which no peer session can answer;
//   - `working` with nothing added to its transcript for ten minutes: a wait that will not end, or a loop.
// For either it appends a line to watch.log beside the lock (time, session name, id, what), and raises a notification
// on the Mac; the same session is not reported again for the same thing for 15 minutes while it lasts (seen.json). It stops itself, giving the lock up,
// once no background session has been live for 30 minutes. A lock whose pid is not a detector is stale, and taken over.
//
// --follow is for a director run in the background: it starts the detector if none runs, then waits for a line about a
// session whose name starts with the prefix, appended after it started, prints it and exits 0, which wakes the
// director. It starts the detector again if it stops meanwhile. --once prints, a line each, every background session
// that has not ended: id, state, minutes since its transcript was written, name; and who holds the lock.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BLOCKED_MS = 3 * 60_000;
export const QUIET_MS = 10 * 60_000;
export const AGAIN_MS = 15 * 60_000;
export const IDLE_MS = 30 * 60_000;
const POLL_MS = 30_000;
const ENDED = new Set(['done', 'stopped', 'failed']);

/** A session as `claude agents --json --all` lists it: only the fields read here. */
export interface Agent {
  id?: string;
  name?: string;
  kind?: string;
  state?: string;
  sessionId: string;
}
/** What the detector remembers between reads: since when each session has been blocked, and when each was reported. */
export interface Memory {
  blockedSince: Record<string, number>;
  seen: Record<string, number>;
}
export interface Finding {
  id: string;
  name: string;
  what: string;
}

/** The background sessions that have not ended. */
export const live = (agents: Agent[]): Agent[] =>
  agents.filter((a) => a.kind === 'background' && a.id && !ENDED.has(a.state ?? ''));

/**
 * What needs saying now, and the memory to keep: a session blocked for BLOCKED_MS, or working with its transcript
 * unwritten for QUIET_MS, not already reported in the last AGAIN_MS. `lastWrite` is when a session's transcript was
 * last written, or undefined when none is found.
 */
export function assess(
  agents: Agent[],
  lastWrite: (sessionId: string) => number | undefined,
  memory: Memory,
  now: number,
): { findings: Finding[]; memory: Memory } {
  const blockedSince: Record<string, number> = {};
  const seen = { ...memory.seen };
  const findings: Finding[] = [];
  for (const a of live(agents)) {
    const id = a.id as string;
    const name = a.name ?? '';
    let what: string | undefined;
    let kind: 'blocked' | 'quiet' | undefined;
    if (a.state === 'blocked') {
      blockedSince[id] = memory.blockedSince[id] ?? now;
      if (now - blockedSince[id] >= BLOCKED_MS) {
        kind = 'blocked';
        what = `blocked for ${minutes(now - blockedSince[id])} minutes, waiting on a person: claude attach ${id}`;
      }
    } else if (a.state === 'working') {
      const wrote = lastWrite(a.sessionId);
      if (wrote !== undefined && now - wrote >= QUIET_MS) {
        kind = 'quiet';
        what = `has written nothing for ${minutes(now - wrote)} minutes: claude logs ${id}`;
      }
    }
    // A report stands for the spell it was made in: once the session is out of it, the next one is reported afresh.
    for (const k of ['blocked', 'quiet'] as const) if (k !== kind) delete seen[`${id}:${k}`];
    if (kind && what && now - (seen[`${id}:${kind}`] ?? 0) >= AGAIN_MS) {
      seen[`${id}:${kind}`] = now;
      findings.push({ id, name, what });
    }
  }
  return { findings, memory: { blockedSince, seen } };
}

const minutes = (ms: number): number => Math.round(ms / 60_000);

/** A line of the log: tab-separated, so a name with spaces stays one field. */
export const logLine = (at: Date, f: Finding): string => `${at.toISOString()}\t${f.name}\t${f.id}\t${f.what}`;

/** The first line of the log text whose session name starts with the prefix, or undefined. */
export function followed(text: string, prefix: string): string | undefined {
  return text.split('\n').find((line) => (line.split('\t')[1] ?? '').startsWith(prefix));
}

/** The lock's holder as its file says, or undefined when the file is not a lock this script wrote. */
export function readLock(text: string): { pid: number; since: string } | undefined {
  try {
    const v = JSON.parse(text) as { pid?: unknown; since?: unknown };
    return typeof v.pid === 'number' && typeof v.since === 'string' ? { pid: v.pid, since: v.since } : undefined;
  } catch {
    return undefined;
  }
}

const dir = (): string => process.env.WATCH_DIR ?? join(homedir(), '.config', 'software-factory', 'watch');
const lockFile = (): string => join(dir(), 'watch.pid');
const logFile = (): string => join(dir(), 'watch.log');
const seenFile = (): string => join(dir(), 'seen.json');

/** Whether the pid is a detector of this script, not whatever has the pid since. */
function isDetector(pid: number): boolean {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes('watch.ts') && !r.stdout.includes('--');
}

/** The live detector's lock, or undefined when none runs. */
function holder(): { pid: number; since: string } | undefined {
  if (!existsSync(lockFile())) return undefined;
  const lock = readLock(readFileSync(lockFile(), 'utf8'));
  return lock && isDetector(lock.pid) ? lock : undefined;
}

/**
 * Takes the lock file for `me`, or returns who holds it. The lock is written whole to a file of its own and linked into
 * place, which fails if one is there, so two starts never both take it and no reader sees half a lock. A lock whose pid
 * is no detector is stale: moved aside by a rename, which one start alone can make, and put back if what was moved is
 * not the stale lock that was read. Last, the lock is read again to confirm it is `me`'s.
 */
export function acquire(
  file: string,
  me: { pid: number; since: string },
  isLive: (pid: number) => boolean,
): { taken: true } | { taken: false; holder: { pid: number; since: string } | undefined } {
  const temporary = `${file}.${me.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(me), { mode: 0o600 });
  const read = (path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(temporary, file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const text = read(file);
        if (text === undefined) continue;
        const held = readLock(text);
        if (held && isLive(held.pid)) return { taken: false, holder: held };
        const aside = `${file}.${me.pid}.stale`;
        try {
          renameSync(file, aside);
        } catch {
          continue;
        }
        const moved = read(aside);
        if (moved !== text) {
          // Another start's fresh lock, taken in the meantime: back it goes.
          try {
            linkSync(aside, file);
          } catch {}
          unlinkSync(aside);
          return { taken: false, holder: moved === undefined ? undefined : readLock(moved) };
        }
        unlinkSync(aside);
        continue;
      }
      const now = readLock(read(file) ?? '');
      return now?.pid === me.pid ? { taken: true } : { taken: false, holder: now };
    }
    return { taken: false, holder: readLock(read(file) ?? '') };
  } finally {
    unlinkSync(temporary);
  }
}

/** Takes the lock, or says who holds it, and gives it back when the detector exits. */
function takeLock(): boolean {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const result = acquire(lockFile(), { pid: process.pid, since: new Date().toISOString() }, isDetector);
  if (!result.taken) {
    const h = result.holder;
    console.log(`the watch runs already${h ? `: pid ${h.pid}, since ${h.since}` : ''}; its log is ${logFile()}`);
    return false;
  }
  const release = () => {
    try {
      if (readLock(readFileSync(lockFile(), 'utf8'))?.pid === process.pid) unlinkSync(lockFile());
    } catch {}
  };
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(0));
  return true;
}

const agents = (): Agent[] => JSON.parse(execFileSync('claude', ['agents', '--json', '--all'], { encoding: 'utf8' }));

/** When the session's transcript, or a sub-agent's of it, was last written, wherever its working directory put it. */
export function lastWrite(sessionId: string, projects = join(homedir(), '.claude', 'projects')): number | undefined {
  let newest: number | undefined;
  for (const project of existsSync(projects) ? readdirSync(projects) : []) {
    const file = join(projects, project, `${sessionId}.jsonl`);
    if (existsSync(file)) newest = Math.max(newest ?? 0, statSync(file).mtimeMs);
    // A session busy with sub-agents writes their transcripts instead.
    const subagents = join(projects, project, sessionId, 'subagents');
    for (const name of existsSync(subagents) ? readdirSync(subagents) : []) {
      if (name.endsWith('.jsonl')) newest = Math.max(newest ?? 0, statSync(join(subagents, name)).mtimeMs);
    }
  }
  return newest;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function detect(): Promise<void> {
  if (!takeLock()) return;
  console.log(`the watch runs: pid ${process.pid}; its log is ${logFile()}`);
  let memory: Memory = { blockedSince: {}, seen: {} };
  try {
    memory.seen = JSON.parse(readFileSync(seenFile(), 'utf8'));
  } catch {}
  let lastLive = Date.now();
  for (;;) {
    const now = Date.now();
    let listed: Agent[] = [];
    try {
      listed = agents();
    } catch (error) {
      console.error(`could not list the sessions: ${String(error).split('\n')[0]}`);
    }
    if (live(listed).length) lastLive = now;
    const result = assess(listed, (id) => lastWrite(id), memory, now);
    memory = result.memory;
    for (const f of result.findings) {
      const line = logLine(new Date(now), f);
      appendFileSync(logFile(), `${line}\n`);
      console.log(line);
      spawnSync('osascript', [
        '-e',
        `display notification ${JSON.stringify(`${f.name}: ${f.what}`)} with title "Software Factory: a session needs you" sound name "Glass"`,
      ]);
    }
    if (result.findings.length) writeFileSync(seenFile(), JSON.stringify(memory.seen));
    if (now - lastLive >= IDLE_MS) {
      console.log('no background session for 30 minutes: the watch stops');
      return;
    }
    await sleep(POLL_MS);
  }
}

function startDetector(): void {
  if (holder()) return;
  spawn(process.execPath, [import.meta.filename], { detached: true, stdio: 'ignore' }).unref();
}

async function follow(prefix: string): Promise<void> {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const from = existsSync(logFile()) ? statSync(logFile()).size : 0;
  startDetector();
  console.log(`following sessions named ${prefix}… in ${logFile()}`);
  for (;;) {
    await sleep(15_000);
    const text = existsSync(logFile()) ? readFileSync(logFile()).subarray(from).toString('utf8') : '';
    const line = followed(text, prefix);
    if (line) {
      console.log(line);
      return;
    }
    startDetector();
  }
}

function once(): void {
  const held = holder();
  console.log(held ? `the watch runs: pid ${held.pid}, since ${held.since}` : 'no watch runs');
  const now = Date.now();
  for (const a of live(agents())) {
    const wrote = lastWrite(a.sessionId);
    const quiet = wrote === undefined ? '?' : String(minutes(now - wrote));
    console.log(`${a.id} ${a.state} quiet ${quiet} min  ${a.name ?? ''}`);
  }
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  if (args[0] === '--once' && args.length === 1) once();
  else if (args[0] === '--follow' && args[1] && args.length === 2) await follow(args[1]);
  else if (!args.length) await detect();
  else {
    console.error('usage: watch.ts [--once | --follow <prefix>]');
    process.exitCode = 2;
  }
}
