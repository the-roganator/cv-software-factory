import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/*
 * Whether the merge queue still holds a run's entry (scripts/queue-branch-gone.sh), asked of a bare repository standing
 * in for GitHub's git, and of a server standing in for its API's timeline of the pull request, and its watcher, run from
 * a stand-in for the runner's Runner.Worker whose second step runs on until the watcher stops it, or does not.
 */

const SCRIPT = resolve('scripts/queue-branch-gone.sh');
const QUEUE = 'refs/heads/gh-readonly-queue/main/pr-7-0123456789abcdef0123456789abcdef01234567';
/** The same pull request's branch on another base, as the queue names a group it made again. */
const AGAIN = 'refs/heads/gh-readonly-queue/main/pr-7-fedcba9876543210fedcba9876543210fedcba98';

/*
 * The API: GET /repos/<name>/issues/7/timeline, paged as GitHub pages it (`per_page`, `page`, and a Link to the last
 * page), from <name>.json in a directory of its own; anything else, or a name with no file, is a 404. In a process of
 * its own, as the script is run synchronously.
 */
const records = mkdtempSync(join(tmpdir(), 'queue-records-'));
let server: ChildProcess | undefined;
let port = 0;
beforeAll(async () => {
  const code = `
    const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
    http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const [, repos, name, issues, number, timeline, ...rest] = url.pathname.split('/');
      const ours = repos === 'repos' && issues === 'issues' && number === '7' && timeline === 'timeline' && !rest.length;
      const file = ours && path.join(process.argv[1], path.basename(name) + '.json');
      if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('{}'); return; }
      const all = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const per = Number(url.searchParams.get('per_page') ?? 30), page = Number(url.searchParams.get('page') ?? 1);
      const last = Math.max(1, Math.ceil(all.length / per));
      const headers = { 'content-type': 'application/json' };
      if (last > 1) headers.link = '<http://127.0.0.1' + url.pathname + '?per_page=' + per + '&page=' + last + '>; rel="last"';
      res.writeHead(200, headers);
      res.end(JSON.stringify(all.slice((page - 1) * per, page * per)));
    }).listen(0, '127.0.0.1', function () { console.log('port ' + this.address().port); });`;
  server = spawn(process.execPath, ['-e', code, records], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise<number>((done) => {
    let out = '';
    server?.stdout?.on('data', (data) => {
      out += data;
      const found = /port (\d+)/.exec(out);
      if (found) done(Number(found[1]));
    });
  });
});
afterAll(() => {
  server?.kill('SIGKILL');
  rmSync(records, { recursive: true, force: true });
});

const event = (name: string) => ({ event: name, created_at: new Date().toISOString() });

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

/**
 * A remote holding main at `history` commits and the queue's branch at the next, as the queue makes it, and the pull
 * request's timeline, which says it was added to the queue.
 */
function remote(history = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'queue-branch-'));
  dirs.push(dir);
  const name = `repo-${dirs.length}-${Math.floor(Math.random() * 1e9)}`;
  let timeline = [event('committed'), event('added_to_merge_queue')];
  const record = (events = timeline) => {
    timeline = events;
    writeFileSync(join(records, `${name}.json`), JSON.stringify(timeline));
  };
  record();
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
  const TIP = 'refs/heads/history';
  let made = false;
  /** Adds an empty commit for each message, in one git process however many, and returns the last. */
  const commit = (...messages: string[]) => {
    const stream = messages.flatMap((message, i) => [
      `commit ${TIP}`,
      `committer t <t@example.com> ${Math.floor(Date.now() / 1000)} +0000`,
      `data ${Buffer.byteLength(message)}`,
      message,
      ...(i === 0 && made ? [`from ${TIP}^0`] : []),
      '',
    ]);
    execFileSync('git', ['-C', 'work', 'fast-import', '--quiet'], { cwd: dir, input: stream.join('\n') });
    made = true;
    return work('rev-parse', TIP);
  };
  const main = commit(...Array.from({ length: history }, (_, i) => `main ${i}`));
  const sha = commit('the entry');
  work('push', '-q', bare, `${main}:refs/heads/main`, `${sha}:${QUEUE}`);
  const ref = (...args: string[]) => git('-C', bare, 'update-ref', ...args);
  return {
    dir,
    sha,
    env: {
      REMOTE: `file://${bare}`,
      API: `http://127.0.0.1:${port}/repos/${name}`,
      QUEUE_BRANCH: QUEUE,
      QUEUE_SHA: sha,
      BASE_REF: 'refs/heads/main',
    },
    /** The queue lets the entry go: its branch goes, and its timeline says it was removed. */
    eject: () => {
      ref('-d', QUEUE);
      record([...timeline, event('removed_from_merge_queue')]);
    },
    /** The branch is not there, but the entry is still in the queue, as GitHub's git has once answered. */
    vanish: () => ref('-d', QUEUE),
    /** The pull request's timeline, written whole. */
    record,
    /** The queue makes the entry's group again: on a new base, under another name, or under its own name. */
    rebuild: (sameName = false) => {
      const again = commit('the entry again');
      if (sameName) work('push', '-q', '-f', bare, `${again}:${QUEUE}`);
      else {
        work('push', '-q', bare, `${again}:${AGAIN}`);
        ref('-d', QUEUE);
      }
    },
    /** Another pull request's group, whose number begins with this one's. */
    another: () => work('push', '-q', bare, `${main}:${QUEUE.replace('/pr-7-', '/pr-77-')}`),
    /** The entry merges: main moves to it, then its branch goes. */
    merge: () => {
      ref('refs/heads/main', sha);
      ref('-d', QUEUE);
    },
    /** Main moves on past it, as when the entries behind it merge with it. */
    pastIt: (commits = 1) => {
      const tip = commit(...Array.from({ length: commits }, (_, i) => `after it ${i}`));
      work('push', '-q', bare, `${tip}:refs/heads/main`);
    },
  };
}

const ask = (env: Record<string, string>) => {
  const result = spawnSync(SCRIPT, [], { env: { ...process.env, ...env }, encoding: 'utf-8', timeout: 60_000 });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr };
};

describe('asked once', () => {
  it("knows the queue's branch by check-kind.sh's own expression", () => {
    const kind = /^QUEUE='\^\(refs\/heads\/\)\?(.+)'$/m.exec(readFileSync('scripts/check-kind.sh', 'utf-8'))?.[1];
    expect(kind).toBeTruthy();
    expect(readFileSync(SCRIPT, 'utf-8')).toContain(`=~ ^refs/heads/${kind} ]]`);
  });

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
    // Long after, as when a job of its run is run again: main far past it.
    const later = remote();
    later.merge();
    later.pastIt(60);
    expect(ask(later.env)).toMatchObject({ status: 0, out: 'merged' });
  });

  it('says merged for an entry at the head of a history longer than it reads at once', () => {
    // Its commit is the first of the fifty it reads: a search that stops there must not cut the read short and fail.
    const long = remote(60);
    long.merge();
    expect(ask(long.env)).toMatchObject({ status: 0, out: 'merged' });
  });

  it("says gone, and exits 3, when the branch is gone, main does not hold its commit, and the pull request's record says it left the queue", () => {
    const { env, eject } = remote();
    eject();
    expect(ask(env)).toMatchObject({ status: 3, out: 'gone' });
  });

  it("says held, and never gone, when the branch is not there but the pull request's record says it is still in the queue", () => {
    const queue = remote();
    queue.vanish();
    const held = ask(queue.env);
    expect(held).toMatchObject({ status: 0, out: 'held' });
    // What it read, for the watcher's log.
    expect(held.err).toContain('refs/heads/main');
    // Taken out and added again since, the last of its queue's events is what counts.
    queue.record([event('added_to_merge_queue'), event('removed_from_merge_queue'), event('added_to_merge_queue')]);
    expect(ask(queue.env)).toMatchObject({ status: 0, out: 'held' });
  });

  it("reads the last of the pull request's queue events from a timeline of many pages", () => {
    const queue = remote();
    queue.vanish();
    // A quote in a comment, as the API escapes it, is no event.
    const said = { ...event('commented'), body: 'it said "event":"removed_from_merge_queue" once' };
    const filler = (count: number) => Array.from({ length: count }, () => said);
    // The removal on the last page.
    queue.record([event('added_to_merge_queue'), ...filler(150), event('removed_from_merge_queue'), ...filler(60)]);
    expect(ask(queue.env)).toMatchObject({ status: 3, out: 'gone' });
    // The last page with none: the one before it.
    queue.record([event('added_to_merge_queue'), ...filler(150), event('removed_from_merge_queue'), ...filler(120)]);
    expect(ask(queue.env)).toMatchObject({ status: 3, out: 'gone' });
    // Only the comments' mention: no event.
    queue.record([event('added_to_merge_queue'), ...filler(20)]);
    expect(ask(queue.env)).toMatchObject({ status: 0, out: 'held' });
  });

  it("says unreachable, and never gone, when the pull request's record cannot be read or names no queue event", () => {
    const queue = remote();
    queue.eject();
    expect(ask({ ...queue.env, API: `http://127.0.0.1:${port}/repos/nowhere` })).toMatchObject({
      status: 0,
      out: 'unreachable',
    });
    expect(ask({ ...queue.env, API: 'http://127.0.0.1:1/repos/closed' })).toMatchObject({
      status: 0,
      out: 'unreachable',
    });
    queue.record([event('committed')]);
    expect(ask(queue.env)).toMatchObject({ status: 0, out: 'unreachable' });
  });

  it('says rebuilt, and exits 3, when the queue made the group again, under another name or its own', () => {
    const renamed = remote();
    renamed.rebuild();
    expect(ask(renamed.env)).toMatchObject({ status: 3, out: 'rebuilt' });
    const same = remote();
    same.rebuild(true);
    expect(ask(same.env)).toMatchObject({ status: 3, out: 'rebuilt' });
    // Another pull request's group, whose number begins with this one's, is not this one's.
    const other = remote();
    other.another();
    expect(ask(other.env)).toMatchObject({ status: 0, out: 'there' });
    other.vanish();
    expect(ask(other.env)).toMatchObject({ status: 0, out: 'held' });
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
      { QUEUE_BRANCH: QUEUE.replace('/main/', '/other/') },
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
function job(env: Record<string, string>, step = `echo "step: $$"; sleep 120`) {
  const temp = mkdtempSync(join(tmpdir(), 'queue-watch-'));
  dirs.push(temp);
  const steps = `"${SCRIPT}" watch; bash -c '${step}'; echo "the step ended: $?"; sleep 120`;
  // Its output goes through a pipe, as the runner's does: Node would give it a socket, which /proc cannot reopen.
  const worker = spawn('bash', ['-c', `(exec -a Runner.Worker bash -c '${steps.replaceAll("'", "'\\''")}') | cat`], {
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

  it('stops the running step, saying why, once the queue lets the entry go, and then ends, sending nothing more', async () => {
    const queue = remote();
    const run = job(queue.env);
    const watcher = await run.started();
    expect(run.output()).toContain(`Watching ${QUEUE.replace('refs/heads/', '')} once every 1s`);
    queue.eject();
    await run.until(() => run.output().includes('the step ended: '), 'the step to be stopped');
    // SIGTERM, as the runner's own cancel sends: the step fails.
    expect(run.output()).toContain('the step ended: 143');
    expect(run.log()).toMatch(/ gone\n(?: {2}.*\n)*\S+ gone, asked again\n/);
    const notice = `::notice::The merge queue let this entry go (${QUEUE.replace('refs/heads/', '')} is gone, ${queue.sha} is not on main, and #7 left the queue): this run stops here, as its result would count for nothing.`;
    // In the step's own output, where /proc lets the watcher reach it, and in the watcher's log as a plain line, so
    // that printing it makes no second notice.
    if (process.platform === 'linux') expect(run.output()).toContain(`${notice}\n`);
    expect(run.log()).toContain(`\n${notice.replace('::notice::', '')}\n`);
    expect(run.log()).not.toContain('::notice::');
    expect(run.gone()).toBe(true);
    // Once the step has ended the runner goes on to the next, so the watcher ends then, well before it would kill.
    await run.until(() => !alive(watcher), 'the watcher to end', 3);
    expect(run.log()).toContain('every one ended on SIGTERM');
    expect(run.log()).not.toContain('killing');
  });

  it('stops the running step when the queue made its group again', async () => {
    const queue = remote();
    const run = job(queue.env);
    await run.started();
    queue.rebuild();
    await run.until(() => run.output().includes('the step ended: '), 'the step to be stopped');
    expect(run.output()).toContain('the step ended: 143');
    expect(run.log()).toContain(
      `The merge queue made this entry's group again (${QUEUE.replace('refs/heads/', '')} no longer holds ${queue.sha}): this run stops here, as the new group's run stands for it.`,
    );
    expect(run.gone()).toBe(true);
  });

  it("stops nothing when the branch is not there but the pull request's record says it is still in the queue", async () => {
    const queue = remote();
    const run = job(queue.env);
    const watcher = await run.started();
    queue.vanish();
    await run.until(() => (run.log().match(/ held$/gm) ?? []).length >= 3, 'three looks');
    expect(alive(watcher)).toBe(true);
    expect(run.output()).not.toContain('the step ended');
    expect(run.gone()).toBe(false);
    // Said once in the running step's log, where /proc lets the watcher reach it.
    const warning = `::warning::The merge queue's branch ${QUEUE.replace('refs/heads/', '')} was not there, but #7 is still in the queue by its own record: this run goes on.`;
    if (process.platform === 'linux') expect(run.output().split(warning).length).toBe(2);
  });

  it('kills, ten seconds later, what does not end on SIGTERM, and what it started meanwhile', async () => {
    const queue = remote();
    // The step and its sleep ignore SIGTERM, and its trap would start another process if it ran.
    const run = job(queue.env, 'trap "" TERM; echo "step: $$"; sleep 120');
    await run.started();
    queue.eject();
    await run.until(() => run.output().includes('the step ended: '), 'the step to be killed', 40);
    expect(run.output()).toContain('the step ended: 137');
    expect(run.log()).toContain('killing what is left');
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
