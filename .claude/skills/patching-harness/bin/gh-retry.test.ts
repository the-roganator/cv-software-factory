import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * gh-retry.sh, sourced through rulesets.sh as copies.sh sources it, beside a `gh` that stands for GitHub: each call
 * is logged and answered by the next line of a plan (`ok`, an HTTP status, or `net` for a connection that drops), and
 * `ok` once the plan is spent. A listing of rulesets is answered with two ids, whatever the plan says of it.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const COPY = 'the-roganator/cv-software-factory-scratch';

function run(script: string, plan: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-retry-'));
  dirs.push(dir);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'plan'), plan.map((line) => `${line}\n`).join(''));
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env bash
case "$*" in *'.target == "branch"'*) printf '1\\n2\\n'; exit 0 ;; esac
echo "$*" >>"${log}"
answer=$(sed -n "$(wc -l <"${log}" | tr -d ' ')p" "${join(dir, 'plan')}")
case "\${answer:-ok}" in
  ok) echo done; exit 0 ;;
  net) echo 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host' >&2; exit 1 ;;
  5*) echo "failed to set variable \\"SEEN\\": HTTP $answer: $answer Internal Server Error (https://api.github.com/x)" >&2; exit 1 ;;
  *) echo "gh: Not Found (HTTP $answer)" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const ran = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nsource "${join(import.meta.dirname, 'rulesets.sh')}"\n${script}`],
    { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_RETRY_PAUSE: '0' } },
  );
  return {
    status: ran.status,
    out: ran.stdout,
    err: ran.stderr,
    log: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
  };
}
const SET = 'variable set SEEN -R copy -b 2';

describe('a write of gh’s that sets a run up', () => {
  it('is made once when GitHub takes it, its output the caller’s', () => {
    const ran = run(`gh_retry ${SET}`, []);
    expect(ran).toMatchObject({ status: 0, out: 'done\n', err: '', log: [SET] });
  });
  it('is made again after one 500, and says so with what gh said', () => {
    const ran = run(`gh_retry ${SET}`, ['500']);
    expect(ran).toMatchObject({ status: 0, out: 'done\n', log: [SET, SET] });
    expect(ran.err).toContain('HTTP 500: 500 Internal Server Error');
    expect(ran.err).toContain("gh variable set: try 1 of 3 failed on GitHub's side or the network's (HTTP 500)");
  });
  it('is made again when the connection drops', () => {
    const ran = run(`gh_retry ${SET}`, ['net', '502']);
    expect(ran).toMatchObject({ status: 0, log: [SET, SET, SET] });
    expect(ran.err).toContain('try 1 of 3 failed');
    expect(ran.err).toContain('try 2 of 3 failed');
  });
  it('fails after three tries, and the script with it', () => {
    const ran = run(`gh_retry ${SET}\necho went on`, ['500', '503', '500', 'ok']);
    expect(ran).toMatchObject({ status: 1, out: '', log: [SET, SET, SET] });
    expect(ran.err).toContain('gh variable set: failed 3 times, and is not tried again');
  });
  it('fails at once on a 4xx, as gh alone would', () => {
    const ran = run(`gh_retry ${SET} || echo "refused $?"`, ['404']);
    expect(ran).toMatchObject({ status: 0, out: 'refused 1\n', log: [SET] });
    expect(ran.err).toBe('gh: Not Found (HTTP 404)\n');
  });
  it('fails at once on a 4xx that follows a 500', () => {
    const ran = run(`gh_retry ${SET}`, ['500', '422']);
    expect(ran).toMatchObject({ status: 1, log: [SET, SET] });
  });
  it('keeps the caller’s standard input from gh, so a loop over a list goes on reading it', () => {
    const ran = run(
      `printf 'a\\nb\\n' | while read -r each; do gh_retry api -X DELETE "refs/$each" >/dev/null; done`,
      [],
    );
    expect(ran).toMatchObject({ status: 0, log: ['api -X DELETE refs/a', 'api -X DELETE refs/b'] });
  });
});

describe('a copy’s branch rulesets, when GitHub fails', () => {
  const put = (id: number, enforcement: string) =>
    `api -X PUT repos/${COPY}/rulesets/${id} -f enforcement=${enforcement}`;
  it('turns them off and on through one 500 each way', () => {
    const ran = run(`ruleset ${COPY} disabled; true; ruleset ${COPY} active`, ['500', 'ok', 'ok', '502']);
    expect(ran.status).toBe(0);
    expect(ran.log).toEqual([
      put(1, 'disabled'),
      put(1, 'disabled'),
      put(2, 'disabled'),
      put(1, 'active'),
      put(1, 'active'),
      put(2, 'active'),
    ]);
    expect(ran.err).not.toContain('after an exit with them off');
  });
  it('puts them back on the exit when turning them off failed on every try', () => {
    const ran = run(`ruleset ${COPY} disabled; echo pushed`, ['ok', '500', '500', '500']);
    expect(ran).toMatchObject({ status: 1, out: '' });
    expect(ran.log).toEqual([
      put(1, 'disabled'),
      ...[1, 2, 3].map(() => put(2, 'disabled')),
      put(1, 'active'),
      put(2, 'active'),
    ]);
    expect(ran.err).toContain('branch rulesets are on again, after an exit with them off');
  });
  it('puts them back on the exit, by calls tried as often, when turning them on failed on every try', () => {
    const ran = run(`ruleset ${COPY} disabled; true; ruleset ${COPY} active; echo went on`, [
      ...['ok', 'ok'],
      ...['500', '500', '500'],
      ...['500', 'ok', 'ok'],
    ]);
    expect(ran).toMatchObject({ status: 1, out: '' });
    expect(ran.log.slice(-3)).toEqual([put(1, 'active'), put(1, 'active'), put(2, 'active')]);
    expect(ran.err).toContain('branch rulesets are on again, after an exit with them off');
  });
  it('says a copy may be off when it cannot be put back at all', () => {
    const ran = run(`ruleset ${COPY} disabled; true; ruleset ${COPY} active`, ['ok', 'ok', ...Array(6).fill('500')]);
    expect(ran.status).toBe(1);
    expect(ran.err).toContain('BRANCH RULESETS MAY BE OFF');
  });
});
