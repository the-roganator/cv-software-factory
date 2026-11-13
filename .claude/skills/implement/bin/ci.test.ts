import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BIN = import.meta.dirname;
const HEAD = 'a'.repeat(40);

let dir: string;

/** One answer of gh: what it prints, and its exit status (gh pr checks exits 8 while a check is pending). */
type Answer = string | { out: string; status: number };

/**
 * A gh on PATH that answers each command (`pr view`, `pr checks`, `api graphql`, `run view`, and `api rules` for any
 * branch's rules) with its answers in turn,
 * the last again once they run out, running a -q filter as gh does; anything else fails. Each call is logged.
 */
function github(answers: Record<string, Answer[]>): void {
  writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers));
  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
key="$1 $2"; [[ $1 == api && $2 == */rules/branches/* ]] && key="api rules"; echo "$*" >> "${join(dir, 'calls')}"
answers="${join(dir, 'answers.json')}"; count="${dir}/count-\${key// /-}"
jq -e --arg k "$key" 'has($k)' "$answers" >/dev/null || { echo "gh: not answered: $*" >&2; exit 1; }
n=$(cat "$count" 2>/dev/null || echo 0); echo $((n + 1)) > "$count"
answer=$(jq -c --arg k "$key" --argjson n "$n" '.[$k] | .[[$n, length - 1] | min]' "$answers")
out=$(jq -r 'if type == "string" then . else .out end' <<<"$answer")
status=$(jq -r 'if type == "string" then 0 else .status end' <<<"$answer")
filter=''; prev=''
for a in "$@"; do [[ $prev == -q ]] && filter=$a; prev=$a; done
if [[ -n $filter ]]; then jq -r "$filter" <<<"$out"; else printf '%s\\n' "$out"; fi
exit "$status"
`,
  );
  chmodSync(gh, 0o755);
}

function run(script: string, ...args: string[]): { out: string; status: number | null } {
  const r = spawnSync(join(BIN, script), args, {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      WAIT_CI_INTERVAL: '0',
      WAIT_CI_SETTLE: '0',
      WAIT_CI_MINUTES: '25',
      WAIT_CI_LOG_LINES: '2',
    },
    encoding: 'utf8',
  });
  return { out: r.stdout + r.stderr, status: r.status };
}

const view = (mergeable = 'MERGEABLE', state = 'OPEN') =>
  JSON.stringify({ state, mergeable, headRefOid: HEAD, baseRefName: 'main' });
const check = (name: string, bucket: string, link = `https://github.com/o/r/actions/runs/1/job/${name.length}`) => ({
  name,
  bucket,
  state: { pass: 'SUCCESS', fail: 'FAILURE', pending: 'IN_PROGRESS', skipping: 'SKIPPED', cancel: 'CANCELLED' }[bucket],
  link,
  workflow: 'check',
});
const checks = (...list: object[]): Answer => ({
  out: JSON.stringify(list),
  status: list.some((c) => (c as { bucket: string }).bucket === 'pending') ? 8 : 0,
});
const threads = (...nodes: object[]) =>
  JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('wait-ci.sh', () => {
  it('exits 3 at once when the pull request conflicts with its base, reading no check', () => {
    github({ 'pr view': [view('CONFLICTING')] });
    const r = run('wait-ci.sh', '7');
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/conflicts with its base/);
  });

  it('waits through pending checks and exits 0 once all are green, skipped ones too', () => {
    github({
      'pr view': [view()],
      'pr checks': [
        { out: 'no checks reported on the branch', status: 1 },
        checks(check('lint', 'pending'), check('tests', 'pending')),
        checks(check('lint', 'pass'), check('tests', 'skipping')),
      ],
    });
    const r = run('wait-ci.sh', '7');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/at 0m: no checks yet/);
    expect(r.out).toMatch(/every check on aaaaaaaa is green \(2\)/);
  });

  it('exits 1 at the first failed check, naming it with the last lines of its log', () => {
    github({
      'pr view': [view()],
      'pr checks': [
        checks(
          check('lint', 'pass'),
          check('tests', 'fail', 'https://github.com/o/r/actions/runs/42/job/9'),
          check('e2e', 'pending'),
        ),
      ],
      'run view': ['line 1\nline 2\nline 3'],
    });
    const r = run('wait-ci.sh', '7');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/tests FAILURE on aaaaaaaa: https:\/\/github.com\/o\/r\/actions\/runs\/42\/job\/9/);
    expect(r.out).toContain('line 2\nline 3');
    expect(r.out).not.toContain('line 1');
  });

  it('takes a cancelled check as failed, and gives a check that is not an Actions job by its link', () => {
    github({ 'pr view': [view()], 'pr checks': [checks(check('CodeQL', 'cancel', 'https://github.com/o/r/runs/5'))] });
    const r = run('wait-ci.sh', '7');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/CodeQL CANCELLED/);
    expect(r.out).toMatch(/not a GitHub Actions job/);
  });

  it("never ends on the review gate's check, which waits on Martin", () => {
    github({
      'pr view': [view()],
      'pr checks': [checks(check('review', 'fail'), check('lint', 'pass'))],
    });
    const r = run('wait-ci.sh', '7');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/not CI: review FAILURE/);
  });

  const rules = (...contexts: string[]) =>
    JSON.stringify([
      { type: 'pull_request' },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: contexts.map((context) => ({ context })) },
      },
    ]);
  const polls = () =>
    readFileSync(join(dir, 'calls'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('pr checks')).length;

  it('does not call one fast check green while the checks the rules require are not registered yet', () => {
    github({
      'pr view': [view()],
      'api rules': [rules('lint', 'tests', 'review')],
      'pr checks': [
        checks(check('lint', 'pass')),
        checks(check('lint', 'pass')),
        checks(check('lint', 'pass'), check('tests', 'pending')),
        checks(check('lint', 'pass'), check('tests', 'pass')),
      ],
    });
    const r = run('wait-ci.sh', '7');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/green \(2\), the 2 required among them/);
    expect(polls()).toBe(4);
  });

  it('exits 4 at its limit naming a required check never registered', () => {
    github({
      'pr view': [view()],
      'api rules': [rules('lint', 'tests')],
      'pr checks': [checks(check('lint', 'pass'))],
    });
    const r = spawnSync(join(BIN, 'wait-ci.sh'), ['7'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WAIT_CI_INTERVAL: '0', WAIT_CI_MINUTES: '0' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/required but not registered: tests/);
  });

  it('without rules to read, takes two green readings of the same checks', () => {
    github({
      'pr view': [view()],
      'pr checks': [
        checks(check('lint', 'pass')),
        checks(check('lint', 'pass'), check('tests', 'pending')),
        checks(check('lint', 'pass'), check('tests', 'pass')),
      ],
    });
    const r = run('wait-ci.sh', '7');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/green \(2\), twice \d+s apart/);
    expect(polls()).toBe(4);
  });

  it('exits 4 at its limit, naming what was still running', () => {
    github({ 'pr view': [view()], 'pr checks': [checks(check('lint', 'pass'), check('e2e', 'pending'))] });
    const r = spawnSync(join(BIN, 'wait-ci.sh'), ['7'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WAIT_CI_INTERVAL: '0', WAIT_CI_MINUTES: '0' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(4);
    expect(r.stdout).toMatch(/still running after 0 minutes: e2e/);
  });

  it('exits 2 when GitHub cannot be read', () => {
    github({ 'pr view': [view()], 'pr checks': [{ out: 'HTTP 502', status: 1 }] });
    expect(run('wait-ci.sh', '7').status).toBe(2);
    expect(run('wait-ci.sh', 'seven').status).toBe(2);
  });
});

describe('pre-push.sh', () => {
  it('says there is nothing when the pull request merges cleanly, has no open thread and no failed check', () => {
    github({
      'pr view': [view()],
      'api graphql': [threads({ isResolved: true, path: 'a.ts', line: 1, comments: { nodes: [] } })],
      'pr checks': [checks(check('lint', 'pass'), check('review', 'fail'))],
    });
    const r = run('pre-push.sh', '7');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/nothing else would need another round/);
  });

  it('names the conflict, each unresolved thread and each failed check, and still exits 0', () => {
    github({
      'pr view': [view('CONFLICTING')],
      'api graphql': [
        threads(
          {
            isResolved: false,
            path: 'src/a.ts',
            line: 12,
            comments: { nodes: [{ author: { login: 'copilot-pull-request-reviewer' }, body: 'First line\nmore' }] },
          },
          { isResolved: true, path: 'src/b.ts', line: 3, comments: { nodes: [] } },
        ),
      ],
      'pr checks': [checks(check('tests', 'fail', 'https://x/1'), check('lint', 'pending'))],
    });
    const r = run('pre-push.sh', '7');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/conflict: #7 conflicts with main/);
    expect(r.out).toMatch(/threads: 1 unresolved/);
    expect(r.out).toContain('src/a.ts:12 (copilot-pull-request-reviewer) First line');
    expect(r.out).not.toContain('more');
    expect(r.out).toMatch(/checks: 1 failed on aaaaaaaa/);
    expect(r.out).toContain('tests FAILURE https://x/1');
    expect(r.out).toMatch(/3 thing\(s\) to put in the same push/);
  });

  it('exits 2 when GitHub cannot be read', () => {
    github({ 'pr view': [view()], 'api graphql': [{ out: 'HTTP 502', status: 1 }] });
    expect(run('pre-push.sh', '7').status).toBe(2);
  });
});
