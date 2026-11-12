import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * Whether the merge queue still holds a run's entry (scripts/queue-branch-gone.sh), asked of a bare repository standing
 * in for GitHub, and its watcher, run from a stand-in for the runner's Runner.Worker whose second step runs on until the
 * watcher stops it, or does not.
 */

const SCRIPT = resolve('scripts/queue-branch-gone.sh');
const QUEUE = 'refs/heads/gh-readonly-queue/main/pr-7-0123456789abcdef0123456789abcdef01234567';

const dirs: string[] = [];
const workers: ChildProcess[] = [];
const watchers: number[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) if (worker.pid) kill(-worker.pid);
  for (const pid of watchers.splice(0)) kill(pid);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function kill(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

/** A remote holding main at one commit and the queue's branch at the next, as the queue makes it. */
function remote() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-branch-'));
  dirs.push(dir);
  const bare = join(dir, 'remote.git');
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: dir,
        encoding: 'utf-8',
      },
    ).trim();
  git('init', '-q', '--bare', bare);
  git('init', '-q', 'work');
  const work = (...args: string[]) => git('-C', 'work', ...args);
  work('commit', '-q', '--allow-empty', '-m', 'main');
  const main = work('rev-parse', 'HEAD');
  work('commit', '-q', '--allow-empty', '-m', 'the entry');
  const sha = work('rev-parse', 'HEAD');
  work('push', '-q', bare, `${main}:refs/heads/main`, `${sha}:${QUEUE}`);
  const ref = (...args: string[]) => git('-C', bare, 'update-ref', ...args);
  return {
    dir,
    sha,
    env: { REMOTE: `file://${bare}`, QUEUE_BRANCH: QUEUE, QUEUE_SHA: sha, BASE_REF: 'refs/heads/main' },
    /** The queue lets the entry go. */
    eject: () => ref('-d', QUEUE),
    /** The entry merges: main moves to it, then its branch goes. */
    merge: () => {
      ref('refs/heads/main', sha);
      ref('-d', QUEUE);
    },
    /** Main moves on past it, as when the entries behind it merge with it. */
    pastIt: () => {
      work('commit', '-q', '--allow-empty', '-m', 'the entry behind');
      work('push', '-q', bare, `${work('rev-parse', 'HEAD')}:refs/heads/main`);
    },
  };
}

const ask = (env: Record<string, string>) => {
  const result = spawnSync(SCRIPT, [], { env: { ...process.env, ...env }, encoding: 'utf-8', timeout: 60_000 });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr };
};

describe('asked once', () => {
  it('says there while the queue holds the branch', () => {
    const { env } = remote();
    expect(ask(env)).toMatchObject({ status: 0, out: 'there' });
  });

  it('says merged when the branch is gone and main holds its commit, or has moved on past it', () => {
    const at = remote();
    at.merge();
    expect(ask(at.env)).toMatchObject({ status: 0, out: 'merged' });
    const past = remote();
    past.merge();
    past.pastIt();
    expect(ask(past.env)).toMatchObject({ status: 0, out: 'merged' });
  });

  it('says gone, and exits 3, when the branch is gone and main does not hold its commit', () => {
    const { env, eject } = remote();
    eject();
    expect(ask(env)).toMatchObject({ status: 3, out: 'gone' });
  });

  it('says unreachable when the remote does not answer, or answers without main, and never gone', () => {
    const { env, dir } = remote();
    expect(ask({ ...env, REMOTE: `file://${join(dir, 'nowhere.git')}` })).toMatchObject({
      status: 0,
      out: 'unreachable',
    });
    expect(ask({ ...env, BASE_REF: 'refs/heads/trunk' })).toMatchObject({ status: 0, out: 'unreachable' });
  });

  it('refuses what does not name a queue entry', () => {
    const { env } = remote();
    for (const wrong of [
      { QUEUE_BRANCH: 'refs/heads/main' },
      { QUEUE_BRANCH: `${QUEUE} --upload-pack=x` },
      { QUEUE_SHA: 'HEAD' },
      { BASE_REF: '--all' },
    ]) {
      expect(ask({ ...env, ...wrong }).status, JSON.stringify(wrong)).toBe(2);
    }
  });
});

/**
 * A stand-in for the runner: a process named Runner.Worker that runs the watch as one step and then a long step, which
 * prints `step: <pid>` and runs until it is stopped, and then says how it ended. Its output is collected.
 */
function job(env: Record<string, string>) {
  const temp = mkdtempSync(join(tmpdir(), 'queue-watch-'));
  dirs.push(temp);
  const steps = `"${SCRIPT}" watch; bash -c 'echo "step: $$"; sleep 120'; echo "the step ended: $?"; sleep 120`;
  const worker = spawn('bash', ['-c', `exec -a Runner.Worker bash -c '${steps.replaceAll("'", "'\\''")}'`], {
    env: { ...process.env, ...env, RUNNER_TEMP: temp, INTERVAL: '1', CONFIRM: '1' },
    detached: true,
  });
  workers.push(worker);
  let out = '';
  worker.stdout?.on('data', (data) => {
    out += data;
  });
  const log = join(temp, 'queue-watch.log');
  const until = async (seen: () => boolean, what: string, seconds = 30) => {
    for (let i = 0; i < seconds * 10; i++) {
      if (seen()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`waited ${seconds}s for ${what}; output: ${out}; log: ${existsSync(log) ? readLog() : 'none'}`);
  };
  const readLog = () => readFileSync(log, 'utf-8');
  return {
    output: () => out,
    log: readLog,
    gone: () => existsSync(join(temp, 'queue-gone')),
    until,
    /** The watcher's own process, once its log names it. */
    started: async () => {
      await until(() => existsSync(log) && /^watcher \d+$/m.test(readLog()) && out.includes('step: '), 'the watcher');
      const pid = Number(/^watcher (\d+)$/m.exec(readLog())?.[1]);
      watchers.push(pid);
      return pid;
    },
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('watched', { timeout: 40_000 }, () => {
  it('says so, and does nothing, outside the merge queue', () => {
    const result = spawnSync(SCRIPT, ['watch'], {
      env: { ...process.env, QUEUE_BRANCH: '', QUEUE_SHA: '', BASE_REF: '' },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Not a run on the merge queue's commit: nothing to watch.");
  });

  // Only where no runner or container is around the tests themselves: there, the watch would find theirs.
  it.skipIf(process.env.GITHUB_ACTIONS === 'true' || existsSync('/.dockerenv'))(
    'starts no watcher when it cannot find the steps of a job, rather than guess',
    () => {
      const { env } = remote();
      const result = spawnSync(SCRIPT, ['watch'], { env: { ...process.env, ...env }, encoding: 'utf-8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "::warning::Not watching the merge queue's branch: the job's steps were not found",
      );
    },
  );

  it('stops the running step, saying why, once the queue lets the entry go', async () => {
    const queue = remote();
    const run = job(queue.env);
    const watcher = await run.started();
    expect(run.output()).toContain(`Watching ${QUEUE.replace('refs/heads/', '')} once every 1s`);
    queue.eject();
    await run.until(() => run.output().includes('the step ended: '), 'the step to be stopped');
    // SIGTERM, as the runner's own cancel sends: the step fails.
    expect(run.output()).toContain('the step ended: 143');
    expect(run.log()).toMatch(/gone\n.*gone, asked again\n/);
    const notice = `::notice::The merge queue let this entry go (${QUEUE.replace('refs/heads/', '')} is gone, and ${queue.sha} is not on main): this run stops here, as its result would count for nothing.`;
    expect(run.log()).toContain(notice);
    // In the step's own log, where /proc lets the watcher reach it.
    if (process.platform === 'linux') expect(run.output()).toContain(notice);
    expect(run.gone()).toBe(true);
    await run.until(() => !alive(watcher), 'the watcher to end');
  });

  it('leaves the step alone when the entry merged, and stops watching', async () => {
    const queue = remote();
    const run = job(queue.env);
    const watcher = await run.started();
    queue.merge();
    await run.until(() => !alive(watcher), 'the watcher to end');
    expect(run.log()).toMatch(/merged\n$/);
    expect(run.output()).not.toContain('the step ended');
    expect(run.gone()).toBe(false);
  });

  it('watches on while the branch is there, or the remote does not answer', async () => {
    const queue = remote();
    const run = job(queue.env);
    const watcher = await run.started();
    await run.until(() => (run.log().match(/ there$/gm) ?? []).length >= 2, 'two looks');
    rmSync(join(queue.dir, 'remote.git'), { recursive: true });
    await run.until(() => (run.log().match(/ unreachable$/gm) ?? []).length >= 2, 'two looks at no remote');
    expect(alive(watcher)).toBe(true);
    expect(run.output()).not.toContain('the step ended');
  });
});
