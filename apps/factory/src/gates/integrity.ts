/**
 * Test integrity: whether a change weakens the tests it was given. An agent that cannot make a test pass could make
 * it pass by changing the test, so a change fails this gate when an existing test is deleted, skipped, narrowed with
 * `.only`, or loses any assertion it made: an assertion changed, such as `toBe('no-store')` turned into
 * `toMatch(/max-age/)`, is one lost. Adding tests, and adding assertions, pass.
 *
 * The tests the change's spec contradicts (`contradicts.ts`) are the exception: each may be deleted, renamed or
 * rewritten, and is named in the summary instead of failing. Skipping one, `.only`, or rewriting it to assert nothing
 * still fails: a test the spec contradicts is put right or removed, not left dead.
 *
 * A test is known by its file and its name. A test that moved to a new file under the same name has moved, not gone.
 */
import type { Contradicted } from './contradicts.ts';
import { type TestCase, testsIn } from './tests.ts';

export interface Finding {
  file: string;
  test?: string;
  message: string;
}

/** A test the spec contradicts that the change deleted (or renamed) or rewrote. */
interface Excused extends Finding {
  test: string;
  change: 'deleted' | 'rewritten';
}

interface Integrity {
  /** What weakens the tests: any one fails the gate. */
  problems: Finding[];
  /** Tests added, for the summary. */
  added: Finding[];
  /** Tests the spec contradicts that the change deleted or rewrote: each passes, and is named in the summary. */
  contradicted: Excused[];
  /** Tests the spec contradicts that the change left as they were. */
  unchanged: Contradicted[];
  /** Tests the spec names that the base does not have: they excuse nothing. */
  unknown: Contradicted[];
}

const DISABLED: Record<Exclude<TestCase['disabled'], false>, string> = {
  skip: 'is skipped',
  todo: 'is left to do',
  only: 'is narrowed with .only, which skips every other test in its file',
  conditional: 'now runs only on a condition',
};

/** An assertion's text for a message: quoted by the message, and cut to fit. */
const cut = (text: string) => ([...text].length > 120 ? `${[...text].slice(0, 119).join('')}…` : text);

/** The base's assertions the change no longer makes, counted as a multiset: a second copy needs a second. */
function lost(was: TestCase, is: TestCase): string[] {
  const left = new Map<string, number>();
  for (const call of is.calls) left.set(call, (left.get(call) ?? 0) + 1);
  return was.calls.filter((call) => {
    const n = left.get(call) ?? 0;
    left.set(call, n - 1);
    return n <= 0;
  });
}

/**
 * Each of a file's tests in the base with its test in the change, by name. Tests of one name in a file are paired
 * first with one left exactly as it was, wherever it now is, then in order, so reordering them changes nothing. One
 * with no test left to pair has gone.
 */
function pair(was: TestCase[], is: TestCase[]): (TestCase | undefined)[] {
  const paired: (TestCase | undefined)[] = was.map(() => undefined);
  const taken = new Set<TestCase>();
  for (const [i, w] of was.entries()) {
    const same = is.find((t) => !taken.has(t) && t.name === w.name && t.source === w.source);
    if (same) {
      paired[i] = same;
      taken.add(same);
    }
  }
  for (const [i, w] of was.entries()) {
    if (paired[i]) continue;
    const next = is.find((t) => !taken.has(t) && t.name === w.name);
    if (next) {
      paired[i] = next;
      taken.add(next);
    }
  }
  return paired;
}

/**
 * Compares the test files of a pull request's base with its change's, each by path, excusing only the tests the
 * change's spec contradicts.
 */
export function compare(
  base: Map<string, string>,
  change: Map<string, string>,
  contradicts: readonly Contradicted[] = [],
): Integrity {
  const problems: Finding[] = [];
  const added: Finding[] = [];
  const contradicted: Excused[] = [];
  const unchanged: Contradicted[] = [];
  const tests = (files: Map<string, string>) =>
    new Map([...files].map(([file, source]) => [file, testsIn(source)] as const));
  const before = tests(base);
  const after = tests(change);
  const named = (file: string, test: string) => contradicts.some((c) => c.file === file && c.test === test);
  // Tests in files the base did not have, by name: where a moved test went.
  const moved = new Map<string, { file: string; test: TestCase }>();
  for (const [file, cases] of after) if (!before.has(file)) for (const t of cases) moved.set(t.name, { file, test: t });

  for (const [file, cases] of before) {
    const now = after.get(file);
    if (!now && !cases.some((t) => moved.has(t.name) || named(file, t.name))) {
      problems.push({
        file,
        message: `${file} was deleted, with its ${cases.length} test${cases.length === 1 ? '' : 's'}`,
      });
      continue;
    }
    const counterparts = pair(cases, now ?? []);
    for (const [index, was] of cases.entries()) {
      const excused = named(file, was.name);
      const same = counterparts[index];
      const found = same ? { file, test: same } : moved.get(was.name);
      if (!found) {
        if (excused)
          contradicted.push({ file, test: was.name, change: 'deleted', message: `"${was.name}" was deleted` });
        else problems.push({ file, test: was.name, message: `"${was.name}" was deleted` });
        continue;
      }
      const { test: is, file: where } = found;
      if (is.disabled && !was.disabled) {
        problems.push({ file: where, test: was.name, message: `"${was.name}" ${DISABLED[is.disabled]}` });
      }
      if (excused) {
        if (is.calls.length === 0 && was.calls.length > 0) {
          // Rewritten to assert nothing, it would pass whatever the code does: left dead, not put right.
          problems.push({ file: where, test: was.name, message: `"${was.name}" was rewritten to assert nothing` });
        } else if (is.source !== was.source) {
          contradicted.push({
            file: where,
            test: was.name,
            change: 'rewritten',
            message: `"${was.name}" was rewritten`,
          });
        } else unchanged.push({ file, test: was.name });
        continue;
      }
      const gone = lost(was, is);
      if (gone.length) {
        const more = gone.length > 1 ? `, and ${gone.length - 1} more of its assertions` : '';
        problems.push({
          file: where,
          test: was.name,
          message: `"${was.name}" no longer asserts ${cut(gone[0] as string)}${more}`,
        });
      }
    }
  }
  for (const [file, cases] of after) {
    const had = before.get(file) ?? [];
    for (const t of cases) {
      const isMove = !before.has(file) && [...before.values()].some((c) => c.some((w) => w.name === t.name));
      const isNew = !had.some((w) => w.name === t.name) && !isMove;
      // A test that arrives already disabled weakens nothing that was there, but is worth seeing in the summary.
      if (isNew) {
        const disabled = t.disabled && t.disabled !== 'only' ? `, but ${DISABLED[t.disabled]}` : '';
        added.push({ file, test: t.name, message: `"${t.name}" was added${disabled}` });
      }
      // `.only` skips every other test in its file, so it is a problem however it arrives.
      if (t.disabled === 'only' && !had.some((w) => w.name === t.name)) {
        problems.push({ file, test: t.name, message: `"${t.name}" ${DISABLED.only}` });
      }
    }
  }
  const unknown = contradicts.filter((c) => !before.get(c.file)?.some((t) => t.name === c.test));
  return { problems, added, contradicted, unchanged, unknown };
}
