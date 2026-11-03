import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CI runs `make check` in parts on runners of their own (check.yml), and the one check the ruleset requires of it
 * passes only when they all did. If `make check` gained a part that CI did not run, that part would be checked on the
 * laptop only.
 */
const workflow = readFileSync('.github/workflows/check.yml', 'utf-8');
const makefile = readFileSync('Makefile', 'utf-8');

/** check.yml's jobs, each by its id, as written. */
const jobs = new Map(
  [...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\s*\n|\s*#.*\n)*)/gm)].map(
    ([, id = '', job = '']) => [id, job],
  ),
);

describe('make check in CI', () => {
  it('runs every part of make check, and nothing else of make', () => {
    const parts = makefile.match(/^check: ([\w -]+?) ##/m)?.[1]?.split(' ') ?? [];
    expect(parts).toEqual(['check-static', 'check-tests']);
    const made = [...workflow.matchAll(/run: make (\S+)/g)].map(([, target]) => target);
    expect(made.sort()).toEqual(parts);
  });

  it('runs every shard of the tests', () => {
    const shards =
      jobs
        .get('tests')
        ?.match(/shard: \[([^\]]*)\]/)?.[1]
        ?.split(', ') ?? [];
    expect(shards.length).toBeGreaterThan(1);
    expect(shards).toEqual(shards.map((_, i) => `${i + 1}/${shards.length}`));
    expect(jobs.get('tests')).toMatch(
      /run: make check-tests SHARD="\$SHARD"\n\s+env:\n\s+SHARD: \$\{\{ matrix\.shard \}\}/,
    );
    // `make check` runs every shard, even with SHARD in the environment.
    expect(makefile).toMatch(/^check: override SHARD :=$/m);
    expect(makefile).toMatch(
      /^\tpnpm exec vitest run --project unit --project database \$\(if \$\(SHARD\),--shard \$\(SHARD\)\)$/m,
    );
  });

  it('runs every shard of the console’s browser tests, and the speed test alone', () => {
    const job = jobs.get('console-browser') ?? '';
    const parts = job.match(/part: \[([^\]]*)\]/)?.[1]?.split(', ') ?? [];
    const shards = parts.filter((part) => part !== 'speed');
    expect(shards.length).toBeGreaterThan(1);
    expect(parts).toEqual([...shards.map((_, i) => `${i + 1}/${shards.length}`), 'speed']);
    // Each part runs the tests its name says: a shard that ran another's would leave a share of the tests unrun.
    const tests = [...job.matchAll(/- part: (\S+)\n\s+tests: (.*)/g)].map(([, part, flags]) => [part, flags]);
    expect(tests).toEqual([
      ...shards.map((shard) => [shard, `--project console --project live --shard ${shard}`]),
      ['speed', '--project speed --no-deps'],
    ]);
  });

  it('runs the required check whatever its parts did, a cancelled run included', () => {
    const check = jobs.get('check') ?? '';
    expect(check).toMatch(/^ {4}name: lint, types, tests$/m);
    expect(check).toMatch(/^ {4}needs: \[kind, static, tests\]$/m);
    // Otherwise a part that failed, or a run cancelled, would skip the check, and a skipped job counts as passed.
    expect(check).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m);
    // The tests are skipped for a release or a deploy and nothing else.
    expect(jobs.get('tests')).toMatch(
      /^ {4}if: \$\{\{ !cancelled\(\) && !contains\(fromJSON\('\["release", "deploy"\]'\), needs\.kind\.outputs\.kind\) \}\}$/m,
    );
  });
});

/** The required check's script, run with its parts' results, and `gh` answering as the queue's run of it would. */
function required(
  env: { KIND: string; STATIC: string; TESTS: string; BASE?: string },
  queue: { run?: string; state?: string; fails?: number } = {},
) {
  const script = jobs.get('check')?.match(/run: \|\n((?: {10}.*\n|\s*\n)+)/)?.[1] ?? '';
  expect(script).not.toBe('');
  const bin = mkdtempSync(join(tmpdir(), 'check-'));
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // GH_FAILS: how many calls fail before it answers, as one would when GitHub's API does.
  stub(
    'gh',
    [
      'calls=$(($(cat "$0.calls" 2>/dev/null || echo 0) + 1)); echo "$calls" > "$0.calls"',
      '[ "$calls" -gt "$GH_FAILS" ] || exit 1',
      'echo "$*" >> "$0.asked"',
      'case "$*" in *"/jobs"*) printf %s "$QUEUE_STATE" ;; *) printf %s "$QUEUE_RUN" ;; esac',
    ].join('\n'),
  );
  stub('sleep', 'exit 0');
  // At most eight tries at the queue's run, not the script's 72: enough to outlast GH_FAILS and the script's asks for a
  // run that is not there, and then give up, without the hundreds of processes 72 tries start, which made a test take
  // seconds on a busy machine. Fewer, if the script asks for fewer.
  stub('seq', 'n=$(($1 < 8 ? $1 : 8)); i=1; while [ "$i" -le "$n" ]; do echo "$i"; i=$((i + 1)); done');
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'the-roganator/cv-software-factory',
      BASE: 'abc123',
      QUEUE_RUN: queue.run ?? '',
      QUEUE_STATE: queue.state ?? '',
      GH_FAILS: String(queue.fails ?? 0),
      ...env,
    },
    encoding: 'utf-8',
  });
  const log = join(bin, 'gh.asked');
  const asked = existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : [];
  rmSync(bin, { recursive: true });
  return { status: result.status, asked };
}

const status = (...args: Parameters<typeof required>) => required(...args).status;

describe('the required check', () => {
  it.each(['failure', 'cancelled', 'skipped'])('fails a pull request when a part of its tests was %s', (tests) => {
    expect(status({ KIND: 'code', STATIC: 'success', TESTS: tests })).toBe(1);
    expect(status({ KIND: 'manifests', STATIC: 'success', TESTS: tests })).toBe(1);
  });

  it.each(['release', 'deploy'])('fails any pull request whose static half did not pass, a %s too', (kind) => {
    expect(status({ KIND: 'code', STATIC: 'failure', TESTS: 'success' })).toBe(1);
    const passed = { run: '42', state: 'completed success' };
    expect(status({ KIND: kind, STATIC: 'cancelled', TESTS: 'skipped' }, passed)).toBe(1);
  });

  it('passes a pull request whose parts all passed', () => {
    expect(status({ KIND: 'code', STATIC: 'success', TESTS: 'success' })).toBe(0);
  });

  it.each(['release', 'deploy'])(
    'passes a %s only once the merge queue passed it on the commit it is made on',
    (kind) => {
      const release = { KIND: kind, STATIC: 'success', TESTS: 'skipped' };
      expect(status(release, { run: '42', state: 'completed success' })).toBe(0);
      expect(status(release, { run: '42', state: 'completed failure' })).toBe(1);
      expect(status(release, { run: '42', state: 'completed cancelled' })).toBe(1);
      // Never finished, or never ran: it gives up, failed.
      expect(status(release, { run: '42', state: 'in_progress null' })).toBe(1);
      expect(status({ ...release, BASE: '' }, { run: '42', state: 'completed success' })).toBe(1);
    },
  );

  it.each(['release', 'deploy'])("does not take a %s's own passing tests for its base's", (kind) => {
    const failed = required(
      { KIND: kind, STATIC: 'success', TESTS: 'success' },
      { run: '42', state: 'completed failure' },
    );
    expect(failed.status).toBe(1);
    expect(failed.asked).toHaveLength(2);
  });

  it("reads the queue's latest run on the base, and that run's latest attempt", () => {
    const release = { KIND: 'release', STATIC: 'success', TESTS: 'skipped' };
    const { status, asked } = required(release, { run: '42', state: 'completed success' });
    expect(status).toBe(0);
    expect(asked).toEqual([
      'api repos/the-roganator/cv-software-factory/actions/workflows/check.yml/runs?event=merge_group&head_sha=abc123 --jq .workflow_runs[0].id // empty',
      'api repos/the-roganator/cv-software-factory/actions/runs/42/jobs?per_page=100 --jq .jobs[] | select(.name == "lint, types, tests") | "\\(.status) \\(.conclusion)"',
    ]);
  });

  it('fails a release at once when the queue never ran on its base', () => {
    const { status, asked } = required({ KIND: 'release', STATIC: 'success', TESTS: 'skipped' });
    expect(status).toBe(1);
    // Five asks, a minute, for GitHub's list to catch up, and no more: the stub's loop would ask eight times.
    expect(asked).toHaveLength(5);
  });

  it("asks again when GitHub's API fails, and does not count a failure as no run", () => {
    const release = { KIND: 'release', STATIC: 'success', TESTS: 'skipped' };
    expect(status(release, { run: '42', state: 'completed success', fails: 3 })).toBe(0);
    // More failures than the asks it allows for a missing run.
    expect(status(release, { run: '42', state: 'completed success', fails: 6 })).toBe(0);
  });
});
