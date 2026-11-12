import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attempt } from '../src/agent.ts';
import { namedPnpm, prepare, SEED_MESSAGE, samePnpmMajor } from '../src/prepare.ts';

/** A repository the prepare step can fetch from by path, with a package that needs nothing installed. */
function origin(packageManager?: string): { url: string; commit: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'origin-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
      cwd: dir,
      encoding: 'utf-8',
    });
  git('init', '--quiet');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', private: true, packageManager }));
  writeFileSync(
    join(dir, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
  );
  writeFileSync(join(dir, 'count.ts'), 'export const count = 1;\n');
  // A link to nothing, which a checkout may hold.
  symlinkSync('nowhere.ts', join(dir, 'gone.ts'));
  git('add', '.');
  git('commit', '--quiet', '--message', 'base');
  // Fetching a commit by its sha, as GitHub allows.
  git('config', 'uploadpack.allowReachableSHA1InWant', 'true');
  return { url: `file://${dir}`, commit: git('rev-parse', 'HEAD').trim(), dir };
}

/** pnpm 12.8.1, by the pin a checkout gives it. */
const OTHER_PNPM =
  'pnpm@12.8.1+sha512.f64ba907507f5ceafe06c8d38e6052d0179444580ec1279ddd5bfc11cb48aa8a2644b66598e07e761da84872a9fc57d5f902b87fa49d024198d558612aabbe45';
/** The pnpm that runs here: this repository's. */
const OWN = /"packageManager": "pnpm@([^+"]+)/.exec(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf-8'),
)?.[1];

describe('the prepare step', () => {
  it('starts from a fresh checkout each time, whatever the agent left behind, with the seed as the same base', async () => {
    // A checkout that names another pnpm than the one that runs, as the app does: it is named, and not fetched.
    const { url, commit } = origin(OTHER_PNPM);
    const work = mkdtempSync(join(tmpdir(), 'work-'));
    const own = mkdtempSync(join(tmpdir(), 'prepare-'));
    mkdirSync(join(own, 'home'));
    const env = {
      ...process.env,
      WORK: work,
      PREPARE: own,
      HOME: join(own, 'home'),
      npm_config_store_dir: join(own, 'store'),
      RUNNER_STEP: JSON.stringify({
        agent: 'coder',
        repository: url,
        commit,
        prompt: 'Fix it.',
        maxTurns: 5,
        seed: 'diff --git a/seeded.ts b/seeded.ts\nnew file mode 100644\n--- /dev/null\n+++ b/seeded.ts\n@@ -0,0 +1 @@\n+export const seeded = true;\n',
      }),
    };
    const lines: string[] = [];
    await prepare({ ...env, RUNNER_JOB: 'coder-1001-1-1', RUNNER_WORK_ITEM: '1001' }, (line) => lines.push(line));
    // A JSON line for each part done, each naming the job and its work item.
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        job: 'coder-1001-1-1',
        workItem: '1001',
        pod: 'prepare',
        msg: 'checked out the commit',
        commit,
      }),
      expect.objectContaining({ job: 'coder-1001-1-1', msg: 'applied the seed, and committed it as the base' }),
      // The pnpm that runs, this repository's, beside the one the checkout names.
      expect.objectContaining({ job: 'coder-1001-1-1', msg: 'runs its own pnpm', pnpm: OWN, packageManager: '12.8.1' }),
      expect.objectContaining({ job: 'coder-1001-1-1', msg: 'installed the dependencies' }),
    ]);
    const repo = join(work, 'repo');
    expect(readFileSync(join(repo, 'seeded.ts'), 'utf-8')).toBe('export const seeded = true;\n');
    const base = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    const first = base();
    // Committed at a fixed time, so a later run makes the same sha.
    const dates = execFileSync('git', ['log', '-1', '--format=%aI %cI'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(dates).toBe('2026-01-01T00:00:00Z 2026-01-01T00:00:00Z');
    // Its message, which the agent sees, says nothing of what the seed is.
    const message = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(message).toBe(SEED_MESSAGE);
    // Every file has that time too, so the agent's searches, which list files by when they changed, list them alike.
    for (const file of ['count.ts', 'seeded.ts']) {
      expect(statSync(join(repo, file)).mtime.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    }
    expect(lstatSync(join(repo, 'gone.ts')).mtime.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    // What an agent might plant for the next prepare: a hook, a pnpmfile, a stray file.
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch /tmp/planted\n', { mode: 0o755 });
    writeFileSync(join(repo, '.pnpmfile.cjs'), 'throw new Error("planted")');
    writeFileSync(join(repo, 'stray.ts'), 'x');
    await prepare(env, () => {});
    expect(existsSync(join(repo, '.pnpmfile.cjs'))).toBe(false);
    expect(existsSync(join(repo, 'stray.ts'))).toBe(false);
    expect(existsSync(join(repo, '.git', 'hooks', 'post-checkout'))).toBe(false);
    expect(base()).toBe(first);
  }, 60_000);

  it('fetches a step’s base, names it, and the commits since it, so a log from it lists every round and a merge', async () => {
    const { url, dir } = origin();
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
        cwd: dir,
        encoding: 'utf-8',
      }).trim();
    const commit = (file: string, text: string, message: string) => {
      writeFileSync(join(dir, file), text);
      git('add', file);
      git('commit', '--quiet', '--message', message);
    };
    git('branch', '--move', 'main');
    commit('older.ts', 'export const older = true;\n', 'chore: main before the fix');
    // The fix's branch: two rounds of the coder's, then main merged in, as a later round finds it.
    git('switch', '--quiet', '--create', 'fix');
    commit('count.ts', 'export const count = 2;\n', 'fix(count): round 1, which makes the claims');
    commit('count.test.ts', 'count is 2\n', 'test(count): round 2');
    git('switch', '--quiet', 'main');
    commit('newer.ts', 'export const newer = true;\n', 'chore: main after the fix began');
    git('switch', '--quiet', 'fix');
    git('merge', '--quiet', '--no-edit', 'main');
    const head = git('rev-parse', 'HEAD');
    const base = git('merge-base', 'main', 'HEAD');
    const work = mkdtempSync(join(tmpdir(), 'work-'));
    const own = mkdtempSync(join(tmpdir(), 'prepare-'));
    const step = { agent: 'reviewer', repository: url, commit: head, base, prompt: 'Review it.', maxTurns: 5 };
    const env = {
      ...process.env,
      WORK: work,
      PREPARE: own,
      npm_config_store_dir: join(own, 'store'),
      RUNNER_STEP: JSON.stringify(step),
    };
    await prepare(env, () => {});
    const repo = join(work, 'repo');
    const inRepo = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
    expect(inRepo('rev-parse', 'HEAD')).toBe(head);
    expect(inRepo('rev-parse', 'base')).toBe(base);
    expect(inRepo('diff', '--name-only', 'base')).toBe('count.test.ts\ncount.ts');
    expect(inRepo('show', 'base:count.ts')).toBe('export const count = 1;');
    // Every commit of the change, the first round's among them, and none of main's.
    expect(inRepo('log', '--format=%s', 'base..HEAD').split('\n')).toEqual([
      "Merge branch 'main' into fix",
      'test(count): round 2',
      'fix(count): round 1, which makes the claims',
    ]);
    // Still without the whole history.
    expect(existsSync(join(repo, '.git', 'shallow'))).toBe(true);
    // A dry run's commits, which the origin never had, made on the head as the pull request's own.
    const dry = {
      ...step,
      commits: [
        {
          message: 'fix(count): round 3, in a dry run',
          patch:
            'diff --git a/count.ts b/count.ts\n--- a/count.ts\n+++ b/count.ts\n@@ -1 +1 @@\n-export const count = 2;\n+export const count = 3;\n',
        },
      ],
    };
    await prepare({ ...env, RUNNER_STEP: JSON.stringify(dry) }, () => {});
    expect(readFileSync(join(repo, 'count.ts'), 'utf-8')).toBe('export const count = 3;\n');
    expect(inRepo('rev-parse', 'HEAD~1')).toBe(head);
    expect(inRepo('log', '--format=%s', 'base..HEAD').split('\n')[0]).toBe('fix(count): round 3, in a dry run');
    expect(inRepo('diff', '--name-only', 'HEAD')).toBe('');
    // A seed would be part of the change: a step that reads one takes none.
    await expect(prepare({ ...env, RUNNER_STEP: JSON.stringify({ ...step, seed: 'x' }) }, () => {})).rejects.toThrow(
      'takes no seed',
    );
  }, 60_000);
});

describe('the pnpm the prepare step runs', () => {
  it('reads the pnpm a checkout names, and nothing from one that names none or another manager', async () => {
    const named = async (packageManager?: string, devEngines?: unknown) => {
      const dir = mkdtempSync(join(tmpdir(), 'checkout-'));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', packageManager, devEngines }));
      return namedPnpm(dir);
    };
    expect(await named(`pnpm@12.8.1+sha512.${'0'.repeat(128)}`)).toBe('12.8.1');
    expect(await named('pnpm@13.0.0-rc.1')).toBe('13.0.0-rc.1');
    expect(await named()).toBeUndefined();
    expect(await named('yarn@4.9.0')).toBeUndefined();
    expect(await named(undefined, { packageManager: { name: 'pnpm', version: '^13.0.0' } })).toBe('^13.0.0');
    expect(await named(undefined, { packageManager: [{ name: 'yarn' }, { name: 'pnpm', version: '12.8.1' }] })).toBe(
      '12.8.1',
    );
    expect(await namedPnpm(mkdtempSync(join(tmpdir(), 'empty-')))).toBeUndefined();
  });

  it('goes on within a major, and stops at another with a sentence that names both', () => {
    expect(() => samePnpmMajor('12.8.1', '12.15.0')).not.toThrow();
    expect(() => samePnpmMajor(undefined, '12.15.0')).not.toThrow();
    expect(() => samePnpmMajor('^12.8.0', '12.15.0')).not.toThrow();
    expect(() => samePnpmMajor('>=13', '12.15.0')).toThrow('asks for pnpm >=13');
    expect(() => samePnpmMajor('13.0.0', '12.15.0')).toThrow(
      'The checkout asks for pnpm 13.0.0, and the runner runs pnpm 12.15.0: pnpm moves to a new major in both ' +
        "repositories, and the runner image's pnpm is this repository's (mise.lock).",
    );
  });
});

describe('the fence check', () => {
  it('takes a refused connection for a block, and a name that does not resolve for nothing', async () => {
    // Nothing listens on this port (fetch refuses some low ports outright, so it is not one of those).
    expect(await attempt('http://127.0.0.1:49151')).toBe('blocked');
    expect(await attempt('http://no-such-host.invalid')).toBe('unclear');
  });
});

describe('the prepare step, on a dependency’s work item', () => {
  /** The origin, with more files committed on it. */
  function originWith(files: Record<string, string>) {
    const { dir } = origin();
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
        cwd: dir,
        encoding: 'utf-8',
      });
    git('add', '.');
    git('commit', '--quiet', '--message', 'more');
    return { url: `file://${dir}`, commit: git('rev-parse', 'HEAD').trim() };
  }
  const envFor = (url: string, commit: string, move: unknown) => {
    const work = mkdtempSync(join(tmpdir(), 'work-'));
    const own = mkdtempSync(join(tmpdir(), 'prepare-'));
    mkdirSync(join(own, 'home'));
    return {
      work,
      env: {
        ...process.env,
        WORK: work,
        PREPARE: own,
        HOME: join(own, 'home'),
        npm_config_store_dir: join(own, 'store'),
        RUNNER_STEP: JSON.stringify({ agent: 'coder', repository: url, commit, prompt: 'Fix it.', maxTurns: 5, move }),
      },
    };
  };
  const OLD = `sha256:${'1'.repeat(64)}`;
  const NEW = `sha256:${'2'.repeat(64)}`;

  it('writes the move’s pins, commits them as the agent’s base, and prints them for the line', async () => {
    const { url, commit } = originWith({ Dockerfile: `FROM gcr.io/distroless/static:nonroot@${OLD}\n` });
    const move = {
      ecosystem: 'docker',
      name: 'gcr.io/distroless/static',
      from: `nonroot@${OLD}`,
      to: `nonroot@${NEW}`,
    };
    const { work, env } = envFor(url, commit, move);
    const lines: string[] = [];
    const get = async () => new Response(null, { headers: { 'docker-content-digest': NEW } });
    await prepare(env, (line) => lines.push(line), { get });
    const said = lines.map((line) => JSON.parse(line));
    const pins = said.find((line) => line.msg === 'the pins');
    expect(pins).toMatchObject({ move });
    expect(pins.pins).toContain(`+FROM gcr.io/distroless/static:nonroot@${NEW}`);
    expect(said.at(-1)).toMatchObject({ msg: 'installed the dependencies' });
    const repo = join(work, 'repo');
    // Committed, so the agent's patch, measured from where it starts, never holds them.
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
    expect(git('log', '-1', '--format=%s %an')).toBe(
      `chore(deps): move gcr.io/distroless/static from nonroot@${OLD} to nonroot@${NEW} pins`,
    );
    expect(git('status', '--porcelain', '--', 'Dockerfile')).toBe('');
  });

  it('prints that the pins wait for Martin, and installs nothing, when the move needs his file', async () => {
    const lock =
      "lockfileVersion: '9.0'\n\npackages:\n\n  pino@10.4.0:\n    resolution: {integrity: sha512-p}\n\n  sonic-boom@4.2.1:\n    resolution: {integrity: sha512-s}\n\nsnapshots:\n\n  pino@10.4.0:\n    dependencies:\n      sonic-boom: 4.2.1\n";
    const { url, commit } = originWith({ 'pnpm-lock.yaml': lock });
    const move = { ecosystem: 'npm', name: 'sonic-boom', from: '4.2.1', to: '5.0.2' };
    const { env } = envFor(url, commit, move);
    const lines: string[] = [];
    await prepare(env, (line) => lines.push(line), { pnpm: async () => {} });
    const said = lines.map((line) => JSON.parse(line));
    expect(said.at(-1)).toMatchObject({
      msg: 'the pins wait for Martin',
      held: { path: 'pnpm-workspace.yaml', reason: expect.stringContaining('pino@10.4.0 admit no 5.0.2') },
    });
    expect(said.some((line) => line.msg === 'installed the dependencies')).toBe(false);
  });
});
