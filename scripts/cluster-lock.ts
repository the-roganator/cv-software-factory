#!/usr/bin/env node
// The local cluster's one holder: a lock file, ~/.config/software-factory/cluster.lock, naming who holds the cluster
// (the key a session goes by), the process that holds it, since when, and on which machine. The try-the-line skill's
// `try begin --holder <key>` takes it and its `try end` gives it back; `try status` prints it; `make up`, `make down`,
// `make upgrade-cluster` and `make real-store` refuse while another holds it (`check`, below), unless FORCE=1. It is
// at this one path (CLUSTER_LOCK for the tests) wherever TRY_STATE puts a try's state: one cluster, one lock.
// Those targets look at the lock and do not hold it: the check is a look at the moment the target starts, meant to stop
// a session that did not know the cluster was held, not to serialise two that race.
//
// The process is the Claude Code session the command ran under (its nearest `claude` ancestor), or, from a terminal,
// the shell that ran it: a command's own process ends at once, a session's lasts as long as its hold should. It is
// named by its pid and its start time, so a pid taken by another process since is not mistaken for the holder. A lock
// whose process has ended is stale: said wherever it is read, and cleared only by `try end` or `try begin --take-stale`.
// A lock that cannot be read (not this file's shape, or not readable) is taken as held: nothing takes the cluster over
// it until someone looks.
//
//   node scripts/cluster-lock.ts check [--force]
// Exit 0 when the cluster is free, held by TRY_HOLDER, or held stale (said); 1 when another holds it or the lock cannot
// be read, saying who and how to go ahead; --force says the same and exits 0.
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

export interface Lock {
  holder: string;
  pid: number;
  /** The holding process's start time, as `ps -o lstart=` gives it. */
  started: string;
  since: string;
  host: string;
}
export interface Process {
  pid: number;
  started: string;
}
export type LockState =
  | { kind: 'free' }
  | { kind: 'held'; lock: Lock; live: boolean }
  | { kind: 'unreadable'; why: string };

export const defaultLockPath = (): string => join(homedir(), '.config', 'software-factory', 'cluster.lock');

/** What the lock file says. `alive` says whether the process still runs; one on another machine is taken as live. */
export function readLock(path: string, alive: (p: Process) => boolean): LockState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'free' };
    return { kind: 'unreadable', why: (e as Error).message };
  }
  let v: Partial<Record<keyof Lock, unknown>>;
  try {
    v = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', why: 'it is not JSON' };
  }
  const strings = ['holder', 'started', 'since', 'host'] as const;
  if (!v || typeof v !== 'object' || typeof v.pid !== 'number' || strings.some((k) => typeof v[k] !== 'string')) {
    return { kind: 'unreadable', why: 'it is not a lock this script wrote' };
  }
  const lock = v as Lock;
  return { kind: 'held', lock, live: lock.host !== hostname() || alive({ pid: lock.pid, started: lock.started }) };
}

/** Writes the lock whole: a new one only if there is none (`create`), else in place of the one there. */
export function writeLock(path: string, lock: Lock, create: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(lock, null, 2)}\n`;
  if (create) {
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Claims the lock for `lock`, atomically: a lock written whole to a file of its own is linked into place, which fails
 * if one is there. To replace `replacing` (a stale lock, or the holder's own), that lock is first moved aside by a
 * rename, which one taker alone can make; if what was moved is not it (another taker's claim, made in the meantime),
 * it goes back. Last, the lock is read again to confirm. The loser is told the winner.
 */
export function claimLock(
  path: string,
  lock: Lock,
  replacing: Lock | undefined,
): { claimed: true } | { claimed: false; holder: Lock | undefined } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parse = (file: string): Lock | undefined => {
    const state = readLock(file, () => true);
    return state.kind === 'held' ? state.lock : undefined;
  };
  const unique = `${path}.${process.pid}.${Date.now()}`;
  writeFileSync(`${unique}.tmp`, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  try {
    if (replacing) {
      try {
        renameSync(path, `${unique}.aside`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        return { claimed: false, holder: parse(path) };
      }
      const moved = parse(`${unique}.aside`);
      if (JSON.stringify(moved) !== JSON.stringify(replacing)) {
        try {
          linkSync(`${unique}.aside`, path);
        } catch {}
        removeLock(`${unique}.aside`);
        return { claimed: false, holder: moved };
      }
      removeLock(`${unique}.aside`);
    }
    try {
      linkSync(`${unique}.tmp`, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return { claimed: false, holder: parse(path) };
    }
    const now = parse(path);
    return JSON.stringify(now) === JSON.stringify(lock) ? { claimed: true } : { claimed: false, holder: now };
  } finally {
    removeLock(`${unique}.tmp`);
  }
}

export function removeLock(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export const describeLock = (lock: Lock): string =>
  `${lock.holder} (pid ${lock.pid} on ${lock.host}, since ${lock.since})`;

/** One line on the lock, for `try status` and `check`. */
export function sayLock(state: LockState, path: string): string {
  switch (state.kind) {
    case 'free':
      return 'The cluster is held by no one.';
    case 'unreadable':
      return `The cluster's lock, ${path}, cannot be read (${state.why}): taken as held until someone looks at it.`;
    case 'held':
      return state.live
        ? `The cluster is held by ${describeLock(state.lock)}.`
        : `The cluster's lock names ${describeLock(state.lock)}, whose process has ended: stale, cleared by \`try end\` or \`try begin --take-stale\`.`;
  }
}

// In the C locale, so a start time written under one locale reads the same under another.
const ps = (pid: number, field: string): string | undefined => {
  const r = spawnSync('ps', ['-p', String(pid), '-o', `${field}=`], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

/** The process a hold belongs to: the nearest `claude` ancestor, or the shell that ran this command. */
export function holderProcess(): Process {
  let pid = process.ppid;
  for (let i = 0; i < 20 && pid > 1; i++) {
    const command = ps(pid, 'comm');
    if (command === undefined) break;
    if ((command.split('/').pop() ?? '') === 'claude') return { pid, started: ps(pid, 'lstart') ?? '' };
    pid = Number(ps(pid, 'ppid') ?? 0);
  }
  return { pid: process.ppid, started: ps(process.ppid, 'lstart') ?? '' };
}

/** Whether the process runs still: the same pid, started at the same time. */
export const processAlive = (p: Process): boolean => ps(p.pid, 'lstart') === p.started;

if (process.argv[1] === import.meta.filename) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'check' || rest.some((a) => a !== '--force')) {
    console.error('usage: cluster-lock.ts check [--force]');
    process.exit(2);
  }
  const force = rest.includes('--force');
  const path = process.env.CLUSTER_LOCK ?? defaultLockPath();
  const state = readLock(path, processAlive);
  const mine = state.kind === 'held' && state.lock.holder === process.env.TRY_HOLDER;
  if (state.kind === 'free' || mine) process.exit(0);
  console.log(`  ${sayLock(state, path)}`);
  if (state.kind === 'held' && !state.live) process.exit(0);
  if (force) {
    console.log('  FORCE=1: going ahead regardless.');
    process.exit(0);
  }
  console.log(
    '  Nothing is changed. Wait for the holder to give the cluster back (`try end`), or, if it must be now and they know, FORCE=1.',
  );
  process.exit(1);
}
