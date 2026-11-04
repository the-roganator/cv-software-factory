import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCANNING_SH = join(import.meta.dirname, 'scanning.sh');
const REPO = 'owner/name';
const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const ALERTS = `repos/${REPO}/code-scanning/alerts?pr=7&state=open&per_page=100`;
const ANALYSES = `repos/${REPO}/code-scanning/analyses?ref=refs/pull/7/merge&per_page=100`;

let dir: string;

/** A gh on PATH that answers `gh api <path>` with what GitHub would print for it, and fails on any other path. */
function github(responses: Record<string, string>): void {
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(responses));
  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
[[ $1 == api ]] && jq -e --arg p "$2" 'has($p)' "${join(dir, 'responses.json')}" >/dev/null || { echo "gh: not found: $2" >&2; exit 1; }
jq -j --arg p "$2" '.[$p]' "${join(dir, 'responses.json')}"
`,
  );
  chmodSync(gh, 0o755);
}

/** code_scanning as verify.sh calls it, with verify.sh's say and bad: its output, and whether it found a mismatch. */
function scan(state: 'OPEN' | 'MERGED'): { out: string; ok: boolean } {
  const run = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail; . "${SCANNING_SH}"; fail=0
       say() { printf '%-9s %s\\n' "$1" "$2"; }
       bad() { say "$1" "MISMATCH: $2"; fail=1; }
       code_scanning "$@"; exit $fail`,
      'test',
      REPO,
      '7',
      state,
      HEAD,
    ],
    { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' },
  );
  if (run.status !== 0 && run.status !== 1) throw new Error(run.stderr);
  return { out: run.stdout, ok: run.status === 0 };
}

const page = (items: unknown[]): string => JSON.stringify(items);

function alert(number: number): object {
  return {
    number,
    html_url: `https://github.com/${REPO}/security/code-scanning/${number}`,
    rule: { id: 'js/stack-trace-exposure', severity: 'warning', security_severity_level: 'medium' },
    most_recent_instance: { location: { path: 'src/door.ts', start_line: 110 } },
  };
}

/** An analysis of a merge of `head` into main, made at `at`, and the commit GitHub would show for it. */
function analysis(category: string, head: string, at: string): [object, Record<string, string>] {
  const sha = `${category.replace(/\W/g, '')}${head}${at}`;
  return [
    { category, commit_sha: sha, created_at: at },
    { [`repos/${REPO}/commits/${sha}`]: JSON.stringify({ parents: [{ sha: 'c'.repeat(40) }, { sha: head }] }) },
  ];
}

/** Each category's analyses, newest first as GitHub lists them, and the commits they were of. */
function analysed(...analyses: [object, Record<string, string>][]): Record<string, string> {
  return Object.assign({ [ANALYSES]: page(analyses.map(([a]) => a)) }, ...analyses.map(([, commits]) => commits));
}

const BOTH_ON_HEAD = analysed(
  analysis('/language:javascript-typescript', HEAD, '2026-11-04T08:20:42Z'),
  analysis('/language:actions', HEAD, '2026-11-04T08:19:43Z'),
  analysis('/language:javascript-typescript', OLD_HEAD, '2026-11-04T00:50:44Z'),
);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'code-scanning-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('code_scanning on an open pull request', () => {
  it('passes with no alert open and every category analysed on the head', () => {
    github({ [ALERTS]: page([]), ...BOTH_ON_HEAD });
    const { out, ok } = scan('OPEN');
    expect(ok).toBe(true);
    expect(out).toContain('0 alert(s) open on the pull request');
    expect(out).toContain(`analysed ${HEAD.slice(0, 8)} in 2 categories`);
  });

  it('fails while an alert is open, and shows it', () => {
    github({ [ALERTS]: page([alert(57)]), ...BOTH_ON_HEAD });
    const { out, ok } = scan('OPEN');
    expect(ok).toBe(false);
    expect(out).toMatch(/alert {5}MISMATCH: #57 medium js\/stack-trace-exposure at src\/door\.ts:110, open/);
    expect(out).toContain(`https://github.com/${REPO}/security/code-scanning/57`);
  });

  it('reads every page of alerts', () => {
    github({ [ALERTS]: page([alert(1)]) + page([alert(2)]), ...BOTH_ON_HEAD });
    const { out, ok } = scan('OPEN');
    expect(ok).toBe(false);
    expect(out).toContain('2 alert(s) open');
    expect(out).toContain('#1 medium');
    expect(out).toContain('#2 medium');
  });

  it('is not ready while a category has been analysed only on an earlier head', () => {
    github({
      [ALERTS]: page([]),
      ...analysed(
        analysis('/language:actions', HEAD, '2026-11-04T08:19:43Z'),
        analysis('/language:javascript-typescript', OLD_HEAD, '2026-11-04T00:50:44Z'),
      ),
    });
    const { out, ok } = scan('OPEN');
    expect(ok).toBe(false);
    expect(out).toContain(`has not analysed ${HEAD.slice(0, 8)} yet (/language:javascript-typescript)`);
  });

  it('is not ready before any analysis', () => {
    github({ [ALERTS]: page([]), [ANALYSES]: page([]) });
    const { out, ok } = scan('OPEN');
    expect(ok).toBe(false);
    expect(out).toContain('has not analysed the pull request yet');
  });

  it('is not ready when the commit an analysis was of cannot be read', () => {
    const [only] = analysis('/language:actions', HEAD, '2026-11-04T08:19:43Z');
    github({ [ALERTS]: page([]), [ANALYSES]: page([only]) });
    expect(scan('OPEN').ok).toBe(false);
  });

  it('reads the alerts only once the head is analysed, so none can land between the two reads', () => {
    // No answer for the alerts: reading them before the analysis would show as a failure to read them.
    github(analysed(analysis('/language:actions', OLD_HEAD, '2026-11-04T00:48:59Z')));
    const { out, ok } = scan('OPEN');
    expect(ok).toBe(false);
    expect(out).toContain('has not analysed');
    expect(out).not.toContain('alert');
  });

  it('fails, saying so, when code scanning cannot be read', () => {
    github(BOTH_ON_HEAD);
    const { out, ok } = scan('OPEN');
    expect(ok).toBe(false);
    expect(out).toContain("MISMATCH: could not read code scanning's alerts on the pull request");
  });

  it('keeps an alert with no severity whole', () => {
    const unrated = { ...alert(5), rule: { id: 'js/unrated' } };
    github({ [ALERTS]: page([unrated]), ...BOTH_ON_HEAD });
    const { out } = scan('OPEN');
    expect(out).toContain('#5 unrated js/unrated at src/door.ts:110, open');
    expect(out).toContain(`https://github.com/${REPO}/security/code-scanning/5`);
  });
});

describe('code_scanning on a merged pull request', () => {
  it('passes on an alert fixed on main since, and does not ask for the analysis', () => {
    github({
      [ALERTS]: page([alert(9)]),
      [`repos/${REPO}/code-scanning/alerts/9`]: JSON.stringify({ state: 'fixed' }),
    });
    const { out, ok } = scan('MERGED');
    expect(ok).toBe(true);
    expect(out).toContain('#9 medium js/stack-trace-exposure at src/door.ts:110, fixed on main since the merge');
    expect(out).toContain('not checked: merged');
  });

  it('fails on an alert still open on main', () => {
    github({
      [ALERTS]: page([alert(57)]),
      [`repos/${REPO}/code-scanning/alerts/57`]: JSON.stringify({ state: 'open' }),
    });
    const { out, ok } = scan('MERGED');
    expect(ok).toBe(false);
    expect(out).toContain('MISMATCH: #57');
  });

  it('fails on an alert whose state on main cannot be read', () => {
    github({ [ALERTS]: page([alert(57)]) });
    const { out, ok } = scan('MERGED');
    expect(ok).toBe(false);
    expect(out).toContain('could not read its state on main');
  });
});
