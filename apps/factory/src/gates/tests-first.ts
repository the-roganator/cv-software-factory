/**
 * The tests-first gate: did the change's tests fail before its fix? Its new and changed tests are run against the
 * base's source. A fix whose tests all pass there proves nothing it claims to fix, and the line holds it for Martin.
 * This check is not required: it is a signal the line reads, not a rule for merging.
 *
 *     node apps/factory/src/gates/tests-first.ts prepare <base> <change> <manifest.json>
 *     node apps/factory/src/gates/tests-first.ts report <manifest.json> <vitest results.json>
 *
 * `prepare` copies the change's new and changed test files, and what changed beside them in test folders, into the
 * base's checkout, writes which tests to look for to the manifest, and prints the test files to run. The workflow
 * then runs Vitest there with its JSON reporter, and `report` says which of those tests failed on the base. It exits
 * 0 when at least one did, and 1 when none did or there were none.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { filesIn, TEST_FILE, TEST_SUPPORT } from './files.ts';
import { annotate, cell, summarise } from './report.ts';
import { testsIn } from './tests.ts';

interface Manifest {
  /** The base's checkout, which Vitest names its files under. */
  root: string;
  /** Test files to run on the base. */
  files: string[];
  /** The new and changed tests, by file and name. */
  tests: { file: string; name: string }[];
}

/** The new and changed tests, and every file in a test folder the change added or changed. */
export function changedTests(base: Map<string, string>, change: Map<string, string>, root = '') {
  const copy = [...change].filter(([path, source]) => base.get(path) !== source).map(([path]) => path);
  const tests: Manifest['tests'] = [];
  for (const file of copy.filter((path) => TEST_FILE.test(path))) {
    const before = testsIn(base.get(file) ?? '');
    for (const test of testsIn(change.get(file) ?? '')) {
      if (test.disabled) continue;
      const was = before.find((t) => t.name === test.name);
      if (!was || was.source !== test.source) tests.push({ file, name: test.name });
    }
  }
  const files = [...new Set(tests.map((t) => t.file))];
  return { copy, manifest: { root, files, tests } satisfies Manifest };
}

interface VitestResults {
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { ancestorTitles: string[]; title: string; status: string }[];
  }[];
}

/** A test's name as a pattern: `it.each` names hold placeholders (`%s`, `$value`) that the run fills in. */
const namePattern = (name: string) =>
  new RegExp(
    `^${name
      .split(/(%[sdifjoO#%]|\$[\w.]+)/)
      .map((part, i) => (i % 2 ? '.*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
  );

export type Outcome = 'failed' | 'passed' | 'did not run';

/** How each test in the manifest went on the base. A file that would not load failed every test in it. */
export function outcomes(manifest: Manifest, results: VitestResults) {
  return manifest.tests.map((test) => {
    // By its path from the checkout, exactly: `test/a.test.ts` is not `src/test/a.test.ts`.
    const file = results.testResults.find((r) => relative(manifest.root, r.name).split('\\').join('/') === test.file);
    if (!file) return { ...test, outcome: 'did not run' as Outcome };
    if (!file.assertionResults.length && file.status === 'failed') return { ...test, outcome: 'failed' as Outcome };
    const pattern = namePattern(test.name);
    const runs = file.assertionResults.filter((a) => pattern.test([...a.ancestorTitles, a.title].join(' > ')));
    if (!runs.length) return { ...test, outcome: 'did not run' as Outcome };
    return { ...test, outcome: (runs.some((a) => a.status === 'failed') ? 'failed' : 'passed') as Outcome };
  });
}

async function prepare(base: string, change: string, manifestPath: string): Promise<number> {
  const pattern = new RegExp(`${TEST_FILE.source}|${TEST_SUPPORT.source}`);
  const { copy, manifest } = changedTests(await filesIn(base, pattern), await filesIn(change, pattern), resolve(base));
  for (const path of copy) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), await readFile(join(change, path)));
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  // One file a line, for the workflow to read into a list: a name with a space stays one name.
  console.log(manifest.files.join('\n'));
  return 0;
}

async function report(manifestPath: string, resultsPath: string | undefined): Promise<number> {
  // Written by `prepare` in the same job, so it is the shape it was written in; Node alone runs this, with no Zod.
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Manifest;
  if (!manifest.tests.length) {
    annotate('warning', 'This change adds or changes no test, so nothing shows it fixes anything.');
    await summarise('## Tests first\n\nThis change adds or changes no test.');
    return 1;
  }
  const results = resultsPath
    ? (JSON.parse(await readFile(resultsPath, 'utf-8')) as VitestResults) // Vitest's own JSON reporter
    : { testResults: [] };
  const rows = outcomes(manifest, results);
  const failed = rows.filter((r) => r.outcome === 'failed');
  if (!failed.length) {
    annotate('warning', 'None of the new or changed tests fails without the change: they do not show what it fixes.');
  }
  await summarise(
    `## Tests first\n\n${failed.length} of ${rows.length} new or changed test${rows.length === 1 ? '' : 's'} fail${failed.length === 1 ? 's' : ''} on the base, before the change's fix.\n\n| Test | On the base |\n|---|---|\n${rows
      .map((r) => `| \`${cell(r.file)}\` ${cell(r.name)} | ${r.outcome} |`)
      .join('\n')}`,
  );
  return failed.length ? 0 : 1;
}

export async function main([command, ...args]: string[]): Promise<number> {
  if (command === 'prepare' && args.length === 3) return prepare(args[0] ?? '', args[1] ?? '', args[2] ?? '');
  if (command === 'report' && (args.length === 1 || args.length === 2)) return report(args[0] ?? '', args[1]);
  console.error(
    'Usage: tests-first.ts prepare <base> <change> <manifest.json> | report <manifest.json> [results.json]',
  );
  return 2;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
