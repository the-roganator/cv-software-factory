import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * rulesets.sh, sourced as copies.sh sources it, beside a `gh` that stands for GitHub: three rulesets, as
 * scripts/github-settings.ts makes them, and a log of every change asked of one.
 */
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const COPY = 'the-roganator/cv-software-factory-scratch';

function run(script: string, failAt?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'rulesets-'));
  dirs.push(dir);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  // `gh api repos/<copy>/rulesets --jq …` lists the branch rulesets' ids, as the filter would; a PUT is logged, and
  // the one numbered `failAt` fails, as GitHub's API can.
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env bash
if [ "$2" = -X ]; then
  echo "$4 $6" >>"${log}"
  [ "$(wc -l <"${log}" | tr -d ' ')" != "${failAt ?? 0}" ] || exit 1
  exit 0
fi
case "$*" in *'.target == "branch"'*) printf '1\\n2\\n' ;; *) echo unexpected >&2; exit 1 ;; esac
`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  const ran = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nsource "${join(import.meta.dirname, 'rulesets.sh')}"\n${script}`],
    { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
  );
  return { status: ran.status, err: ran.stderr, log: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}
const put = (enforcement: string) => [1, 2].map((id) => `repos/${COPY}/rulesets/${id} enforcement=${enforcement}`);

describe('a copy’s branch rulesets, off for a push', () => {
  it('turns the branch rulesets off and on again, and never the tag’s', () => {
    const ran = run(`ruleset ${COPY} disabled; true; ruleset ${COPY} active`);
    expect(ran).toMatchObject({ status: 0, log: [...put('disabled'), ...put('active')], err: '' });
  });

  it('puts them back when the push between fails and the script dies', () => {
    const ran = run(`ruleset ${COPY} disabled; false; ruleset ${COPY} active`);
    expect(ran.status).toBe(1);
    expect(ran.log).toEqual([...put('disabled'), ...put('active')]);
    expect(ran.err).toContain('branch rulesets are on again');
  });

  it('puts them back on a signal, and when turning them on again failed part way', () => {
    const killed = run(`ruleset ${COPY} disabled; kill -TERM $$; sleep 5`);
    expect(killed.status).toBe(143);
    expect(killed.log).toEqual([...put('disabled'), ...put('active')]);
    // The third change asked, the first of turning them on, fails: the exit asks for both again.
    const partly = run(`ruleset ${COPY} disabled; ruleset ${COPY} active`, 3);
    expect(partly.status).toBe(1);
    expect(partly.log).toEqual([...put('disabled'), put('active')[0], ...put('active')]);
  });

  it('says so, with what to run, when they cannot be put back', () => {
    // Turning them off fails at the second: the exit's own try fails too.
    const ran = run(`ruleset ${COPY} disabled`, 2);
    expect(ran.status).toBe(1);
    expect(ran.err).not.toContain('BRANCH RULESETS MAY BE OFF');
    expect(ran.log.slice(2)).toEqual(put('active'));
    const lost = run(
      `gh() { case "$*" in *active*) return 1 ;; *) command gh "$@" ;; esac; }; ruleset ${COPY} disabled; false`,
    );
    expect(lost.status).toBe(1);
    expect(lost.err).toContain('BRANCH RULESETS MAY BE OFF: ./copies.sh settings puts them back');
  });
});
