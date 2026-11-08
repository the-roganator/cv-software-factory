/**
 * The test integrity gate (spec 4.1): fails a change that deletes, skips or weakens an existing test, except the
 * tests its spec contradicts, which the pull request's description names (`contradicts.ts`).
 *
 *     node apps/factory/src/gates/test-integrity.ts <base checkout> <change checkout> [--description <file>]
 *
 * Run by the shared workflow `app-gates.yml`, from this repository at the commit the app's repository pins, so a
 * pull request cannot change the rule it is judged by. Node alone: no dependencies.
 *
 * In Actions it reads the description through the API when it runs, never from the event's payload, which holds the
 * description as it was when the run was triggered: on `pull_request` by the pull request's number, and on
 * `merge_group` by the number in the queue's branch, each of which the workflow passes it in the environment. It
 * needs `pull-requests: read` for that. It asks only when
 * the change would fail without the description; then a description it cannot read, or a section it cannot parse,
 * fails the gate. Outside Actions, `--description` names a file to read
 * it from instead, for trying the gate by hand; with none, no test is excused.
 */

import { readFile } from 'node:fs/promises';
import { type Contradicted, parse } from './contradicts.ts';
import { filesIn, TEST_FILE } from './files.ts';
import { compare, type Finding } from './integrity.ts';
import { annotate, cell, summarise } from './report.ts';

type Env = Record<string, string | undefined>;

/**
 * The docs' account of the description's section, which the summary links to when a change fails for weakening a test,
 * so a person who wrote the change finds how to name the tests its spec contradicts. A link only, never the section's
 * text or markers: the summary hands no one a section to paste. On `main`, as the docs say how the gate works now.
 */
export const CONTRADICTS_DOC =
  'https://github.com/the-roganator/cv-software-factory/blob/main/docs/COMPONENTS/TEST-INTEGRITY.md#tests-the-spec-contradicts';

/**
 * The warning on each test excused as one the spec contradicts. The review gate reads these from the run's annotations
 * as the pull request's `test-loosening` (`scripts/review-routing.ts`, `EXCUSED`, which a test holds to this).
 */
export const excusedNote = (c: { test: string; change: string }) =>
  `"${c.test}" was ${c.change}, as the spec it was changed for contradicts it`;

/**
 * The notice on which pull request, into which base, a run on `pull_request` judged. Test integrity reads that pull
 * request's description, so its excuses are that pull request's alone: the review gate reads a run only when its
 * notice names the pull request it judges, into the base it has now (`scripts/review-routing.ts`, `JUDGED`).
 */
export const judgedNote = (number: number, base: string) => `Test integrity judged #${number} into ${base}`;

/** The pull request a run on `pull_request` judged, and its base (`PR_BASE_REF`), when both are known. */
export function judgedOf(env: Env): { number: number; base: string } | undefined {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || !env.PR_BASE_REF) return undefined;
  const number = pullRequestNumber(env);
  return typeof number === 'number' ? { number, base: env.PR_BASE_REF } : undefined;
}

/** The queue's branch for a pull request: `gh-readonly-queue/<base>/pr-<number>-<head sha>`. */
const QUEUE_BRANCH = /^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]{40}$/;

/**
 * The number of the pull request a run judges, from what the workflow passes it, or why it cannot be known: on
 * `pull_request` its number (`PR_NUMBER`), and on `merge_group` the queue's branch (`MERGE_GROUP_HEAD_REF`).
 */
export function pullRequestNumber(env: Env): number | { error: string } {
  const { GITHUB_EVENT_NAME: event, PR_NUMBER: number, MERGE_GROUP_HEAD_REF: branch } = env;
  if (event === 'pull_request') {
    return number && /^[1-9]\d{0,9}$/.test(number)
      ? Number(number)
      : { error: `The pull request's number, ${JSON.stringify(number ?? '')}, is not a number` };
  }
  if (event === 'merge_group') {
    const match = branch ? QUEUE_BRANCH.exec(branch) : null;
    return match && /^[1-9]\d{0,9}$/.test(match[1] as string)
      ? Number(match[1])
      : { error: `The merge queue's branch, ${JSON.stringify(branch ?? '')}, does not name a pull request` };
  }
  return { error: `Test integrity reads a pull request's description on pull_request or merge_group, not ${event}` };
}

/** The pull request's description as it is now, through the API, or why it could not be read. */
export async function description(
  env: Env,
  fetcher: typeof fetch = fetch,
  pause: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string | { error: string }> {
  const number = pullRequestNumber(env);
  if (typeof number !== 'number') return number;
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = env;
  if (!token || !repo)
    return { error: 'Test integrity needs GITHUB_TOKEN and GITHUB_REPOSITORY to read the description' };
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const url = `${api}/repos/${repo}/pulls/${number}`;
  let problem = '';
  // Three tries, a second and then three apart, so a moment's trouble at GitHub does not fail the gate.
  for (const wait of [0, 1_000, 3_000]) {
    if (wait) await pause(wait);
    try {
      const response = await fetcher(url, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        // An answer that is not a pull request will not become one if asked again.
        const pull = (await response.json().catch(() => null)) as { number?: unknown; body?: unknown } | null;
        if (typeof pull !== 'object' || pull === null) return { error: "GitHub's answer is not a pull request" };
        if (pull.number !== number) return { error: `GitHub answered for another pull request than #${number}` };
        return typeof pull.body === 'string' ? pull.body : '';
      }
      problem = `GitHub answered ${response.status}`;
      // Only a server's error is worth asking again: a refusal or a missing pull request will not change.
      if (response.status < 500) break;
    } catch (error) {
      problem = (error as Error).message;
    }
  }
  return { error: `Pull request #${number}'s description could not be read: ${problem}` };
}

/** The tests the description names, or the problem that fails the gate instead. */
async function named(
  env: Env,
  fetcher: typeof fetch,
  file: string | undefined,
  pause?: (ms: number) => Promise<unknown>,
): Promise<{ tests: Contradicted[] } | { error: string }> {
  let text: string | { error: string };
  if (env.GITHUB_ACTIONS === 'true') {
    text = file
      ? { error: 'Test integrity reads the description from GitHub in Actions, not from a file' }
      : await description(env, fetcher, pause);
  } else if (file) {
    text = await readFile(file, 'utf-8').catch((error: Error) => ({
      error: `The description could not be read from ${file}: ${error.message}`,
    }));
  } else text = '';
  if (typeof text !== 'string') return text;
  return parse(text);
}

export async function main(
  args: string[],
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
  pause?: (ms: number) => Promise<unknown>,
): Promise<number> {
  const at = args.indexOf('--description');
  const file = at === -1 ? undefined : args[at + 1];
  const [base, change] = at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  if (!base || !change || (at !== -1 && !file)) {
    console.error('Usage: test-integrity.ts <base checkout> <change checkout> [--description <file>]');
    return 2;
  }
  const judged = judgedOf(env);
  if (judged) annotate('notice', judgedNote(judged.number, judged.base));
  const before = await filesIn(base, TEST_FILE);
  const after = await filesIn(change, TEST_FILE);
  // The description matters only to a change that would fail without it: one that weakens no test passes without
  // asking GitHub, so a gate that has nothing to excuse never fails on reading it.
  const strict = compare(before, after);
  const list = strict.problems.length ? await named(env, fetcher, file, pause) : { tests: [] };
  const unread = 'error' in list ? list.error : undefined;
  const contradicts: Contradicted[] = 'tests' in list ? list.tests : [];
  const { problems, added, contradicted, unchanged, unknown } = contradicts.length
    ? compare(before, after, contradicts)
    : strict;
  if (unread) annotate('error', unread);
  for (const p of problems) annotate('error', p.message, p.file);
  for (const c of contradicted) {
    annotate('warning', excusedNote(c), c.file);
  }

  const table = (head: string, cells: [string, string][]) =>
    `| File | ${head} |\n|---|---|\n${cells.map(([f, text]) => `| \`${cell(f)}\` | ${cell(text)} |`).join('\n')}`;
  const findings = (list: Finding[]) => list.map((f): [string, string] => [f.file, f.message]);
  const tests = (list: Contradicted[]) => list.map((t): [string, string] => [t.file, t.test]);
  const excused = [
    contradicted.length
      ? `Deleted or rewritten, as the spec allows:\n\n${table('What changed', findings(contradicted))}`
      : '',
    unchanged.length ? `Left as they were:\n\n${table('Test', tests(unchanged))}` : '',
    unknown.length ? `Naming no test the base has, so excusing nothing:\n\n${table('Test', tests(unknown))}` : '',
  ].filter(Boolean);
  await summarise(
    [
      '## Test integrity',
      unread ? `The tests the spec contradicts could not be read, so none is excused: ${cell(unread)}.` : '',
      problems.length
        ? `This change weakens ${problems.length === 1 ? 'a test' : `${problems.length} tests`}. Existing tests may not be deleted, skipped or lose an assertion, unless the description names them as [tests the spec contradicts](${CONTRADICTS_DOC}).\n\n${table('What changed', findings(problems))}`
        : contradicted.length
          ? 'No other existing test was deleted, skipped or lost an assertion.'
          : 'No existing test was deleted, skipped or lost an assertion.',
      contradicts.length
        ? `### Tests the spec contradicts\n\nThe description names ${contradicts.length === 1 ? 'one test' : `${contradicts.length} tests`} that the change's spec contradicts, which the change may delete, rename or rewrite.\n\n${excused.join('\n\n')}`
        : '',
      added.length
        ? `${added.length} test${added.length === 1 ? '' : 's'} added.\n\n${table('Test', findings(added))}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  return unread || problems.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
