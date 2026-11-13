import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Memory } from './watch.ts';
import { AGAIN_MS, assess, BLOCKED_MS, followed, logLine, QUIET_MS, readLock } from './watch.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 13, 12);
const agent = (id: string, state: string, rest: Partial<Agent> = {}): Agent => ({
  id,
  name: `run-${id}`,
  kind: 'background',
  state,
  sessionId: `session-${id}`,
  ...rest,
});
const fresh = (): Memory => ({ blockedSince: {}, seen: {} });

/** Runs the detector's reads one after another, the agents and the transcripts' times given for each. */
function reads(steps: { at: number; agents: Agent[]; wrote?: Record<string, number> }[]): string[][] {
  let memory = fresh();
  return steps.map(({ at, agents, wrote = {} }) => {
    const result = assess(agents, (s) => wrote[s], memory, at);
    memory = result.memory;
    return result.findings.map((f) => `${f.id} ${f.what}`);
  });
}

describe('assess', () => {
  it('reports a session blocked for three minutes, not before', () => {
    const blocked = [agent('a', 'blocked')];
    const said = reads([
      { at: T0, agents: blocked },
      { at: T0 + BLOCKED_MS - 1, agents: blocked },
      { at: T0 + BLOCKED_MS, agents: blocked },
    ]);
    expect(said[0]).toEqual([]);
    expect(said[1]).toEqual([]);
    expect(said[2]).toEqual(['a blocked for 3 minutes, waiting on a person: claude attach a']);
  });

  it('counts a block again from the start once the session has moved on', () => {
    const said = reads([
      { at: T0, agents: [agent('a', 'blocked')] },
      { at: T0 + 2 * MIN, agents: [agent('a', 'working')], wrote: { 'session-a': T0 + 2 * MIN } },
      { at: T0 + 4 * MIN, agents: [agent('a', 'blocked')] },
    ]);
    expect(said.flat()).toEqual([]);
  });

  it('reports a working session whose transcript has been quiet for ten minutes', () => {
    const working = [agent('a', 'working')];
    const said = reads([
      { at: T0 + QUIET_MS - 1, agents: working, wrote: { 'session-a': T0 } },
      { at: T0 + QUIET_MS, agents: working, wrote: { 'session-a': T0 } },
    ]);
    expect(said).toEqual([[], ['a has written nothing for 10 minutes: claude logs a']]);
  });

  it('says nothing of a session with no transcript found, an idle one, or one not in the background', () => {
    const said = reads([
      {
        at: T0 + QUIET_MS,
        agents: [agent('a', 'working'), agent('b', 'idle'), agent('c', 'working', { kind: 'interactive' })],
        wrote: { 'session-b': T0, 'session-c': T0 },
      },
    ]);
    expect(said).toEqual([[]]);
  });

  it('leaves ended sessions alone, however long blocked or quiet', () => {
    const said = reads(
      ['done', 'stopped', 'failed'].map((state) => ({
        at: T0 + QUIET_MS,
        agents: [agent('a', state)],
        wrote: { 'session-a': T0 },
      })),
    );
    expect(said.flat()).toEqual([]);
  });

  it('reports a session once in fifteen minutes', () => {
    const working = [agent('a', 'working')];
    const wrote = { 'session-a': T0 };
    const said = reads([
      { at: T0 + QUIET_MS, agents: working, wrote },
      { at: T0 + QUIET_MS + AGAIN_MS - 1, agents: working, wrote },
      { at: T0 + QUIET_MS + AGAIN_MS, agents: working, wrote },
    ]);
    expect(said.map((s) => s.length)).toEqual([1, 0, 1]);
  });
});

describe('the log', () => {
  const line = logLine(new Date(T0), { id: 'abc', name: 'run 13 lint', what: 'blocked for 3 minutes' });

  it('writes a line a follower finds by the start of the session name, spaces and all', () => {
    expect(line).toBe('2026-11-13T12:00:00.000Z\trun 13 lint\tabc\tblocked for 3 minutes');
    expect(followed(`other\tx-y\t1\tquiet\n${line}\n`, 'run 13')).toBe(line);
  });

  it('finds no line for another prefix, nor by a match outside the name', () => {
    expect(followed(`${line}\n`, 'run 14')).toBeUndefined();
    expect(followed(`${line}\n`, 'abc')).toBeUndefined();
  });
});

describe('readLock', () => {
  it('reads a lock this script wrote, and nothing else', () => {
    expect(readLock('{"pid":12,"since":"2026-11-13T12:00:00.000Z"}')).toEqual({
      pid: 12,
      since: '2026-11-13T12:00:00.000Z',
    });
    expect(readLock('12')).toBeUndefined();
    expect(readLock('{"pid":"12"}')).toBeUndefined();
  });
});

describe('the command line', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'watch-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const watch = (...args: string[]) =>
    spawnSync(process.execPath, [join(import.meta.dirname, 'watch.ts'), ...args], {
      env: { ...process.env, WATCH_DIR: dir },
      encoding: 'utf8',
      timeout: 10_000,
    });

  it('says who holds the lock and exits 0 when a detector runs already', async () => {
    // A process whose command line is a detector's stands for it.
    const sleeper = spawn('bash', ['-c', 'exec -a watch.ts sleep 30'], { stdio: 'ignore' });
    const pid = sleeper.pid as number;
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(dir, 'watch.pid'), JSON.stringify({ pid, since: '2026-11-13T12:00:00.000Z' }));
    const r = watch();
    sleeper.kill();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`the watch runs already: pid ${pid}, since 2026-11-13T12:00:00.000Z`));
    expect(JSON.parse(readFileSync(join(dir, 'watch.pid'), 'utf8')).pid).toBe(pid);
  });

  it('refuses arguments it does not know', () => {
    expect(watch('--follow').status).toBe(2);
    expect(watch('--nope').status).toBe(2);
  });
});
