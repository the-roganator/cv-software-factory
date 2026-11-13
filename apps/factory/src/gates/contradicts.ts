/**
 * The tests a change's spec contradicts, as a section of its pull request's description: the one way test integrity
 * learns which existing tests a change may delete, rename or rewrite. The line writes the section with `render`, and
 * the gate reads it with `parse`, so what one writes is what the other reads. A person can type it too:
 *
 *     ## Tests the spec contradicts
 *
 *     The spec's criteria contradict these existing tests, so this change may delete, rename or rewrite them, and no other.
 *     Test integrity names each one in its summary.
 *
 *     <!-- factory:contradicts -->
 *     - `test/app.test.ts`: files > keeps nothing of the other files
 *     <!-- /factory:contradicts -->
 *
 * Only what lies between the markers is read. Each line there is a test file's path in backticks, `: `, then the
 * test's full name, its `describe` names and its own joined with " > ", as `tests.ts` names it. A line in any other
 * form, more than one pair of markers, or more than `MOST_CONTRADICTED` tests is malformed, and the gate fails on it
 * rather than guess. Node alone: the gates run from a sparse checkout, and the line imports this.
 */

/** A test the spec contradicts, by its file and its full name. */
export interface Contradicted {
  file: string;
  test: string;
}

/** The most tests one section may name. */
export const MOST_CONTRADICTED = 10;
/** The longest path and test name an entry may have, as `spec.written` allows them. */
export const PATH_CHARS = 200;
export const TEST_CHARS = 300;

const HEADING = '## Tests the spec contradicts';
export const START = '<!-- factory:contradicts -->';
export const END = '<!-- /factory:contradicts -->';
const INTRO = [
  "The spec's criteria contradict these existing tests, so this change may delete, rename or rewrite them, and no other.",
  'Test integrity names each one in its summary.',
];

// Markers as a person might type them, in any case and spacing, so that none is missed by the reader or the remover.
// `--!>` ends a comment in HTML as `-->` does, so it ends a marker too.
const START_MARK = /<!--\s*factory:contradicts\s*--!?>/gi;
const END_MARK = /<!--\s*\/\s*factory:contradicts\s*--!?>/gi;
/** What starts or ends a comment in HTML. */
const COMMENT_MARK = /<!--|--!?>/;
const ENTRY = /^- `([^`]+)`: (.+)$/;

/** Why an entry cannot be written or read, or undefined when it can. */
export function entryProblem({ file, test }: Contradicted): string | undefined {
  if (!file || file.length > PATH_CHARS) return `its path is empty or longer than ${PATH_CHARS} characters`;
  if (
    /[`\s\\]/.test(file) ||
    file.startsWith('/') ||
    file.split('/').some((part) => part === '..' || part === '.' || !part)
  ) {
    return 'its path is not a plain path from the root of the repository';
  }
  if (test !== test.trim() || !test || test.length > TEST_CHARS) {
    return `its test's name is empty, longer than ${TEST_CHARS} characters, or starts or ends with a space`;
  }
  if (/[\r\n]/.test(test)) return "its test's name is on more than one line";
  // Nothing that reads as a comment's start or end, so an entry can never make or break a marker.
  if (COMMENT_MARK.test(file) || COMMENT_MARK.test(test)) return 'it has "<!--", "-->" or "--!>" in it';
  // A name is written as plain Markdown, where GitHub would turn these into a mention or a link.
  if (/@\w/.test(test) || /#\d/.test(test)) {
    return "its test's name has an @ before a word or a # before a digit, which GitHub would make a mention or a link";
  }
  return undefined;
}

/**
 * The section for these tests, or nothing when there are none. Throws on an entry the gate would not read, or too
 * many: the line checks a spec's list with `entryProblem` before it gets here.
 */
export function render(tests: readonly Contradicted[]): string {
  if (tests.length === 0) return '';
  if (tests.length > MOST_CONTRADICTED) throw new Error(`At most ${MOST_CONTRADICTED} tests may be named`);
  const lines = tests.map((t) => {
    const problem = entryProblem(t);
    if (problem) throw new Error(`Cannot name ${JSON.stringify(t)}: ${problem}`);
    return `- \`${t.file}\`: ${t.test}`;
  });
  return [HEADING, '', ...INTRO, '', START, ...lines, END].join('\n');
}

/**
 * A description with any section of these removed: the whole of one as `render` writes it, and any markers and what
 * lies between them however they came. What is left has nothing the gate reads.
 */
export function strip(description: string): string {
  const intro = INTRO.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  const heading = HEADING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pair = new RegExp(`${START_MARK.source}[\\s\\S]*?${END_MARK.source}`, 'gi');
  // Again until none is left: taking one marker out can join the text either side of it into another.
  let text = description;
  for (;;) {
    const next = text
      .replace(new RegExp(`^${heading}\\s*(?:${intro}\\s*)?(?=<!--)`, 'gim'), '')
      .replace(pair, '')
      .replace(START_MARK, '')
      .replace(END_MARK, '');
    if (next === text) break;
    text = next;
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** A description with its section replaced by one for these tests, or with none when there are none. */
export function withContradicted(description: string, tests: readonly Contradicted[]): string {
  const rest = strip(description);
  const section = render(tests);
  return [rest, section].filter(Boolean).join('\n\n');
}

/** The tests a description's section names: none with no section, or why the section cannot be read. */
export function parse(description: string | null | undefined): { tests: Contradicted[] } | { error: string } {
  const text = (description ?? '').replace(/\r\n?/g, '\n');
  const starts = [...text.matchAll(START_MARK)];
  const ends = [...text.matchAll(END_MARK)];
  if (starts.length === 0 && ends.length === 0) return { tests: [] };
  const [start] = starts;
  const [end] = ends;
  if (starts.length !== 1 || ends.length !== 1 || !start || !end) {
    return { error: `The description has ${starts.length} start and ${ends.length} end markers, not one pair` };
  }
  if (end.index < start.index) return { error: 'The description’s end marker comes before its start marker' };
  const tests: Contradicted[] = [];
  const lines = text
    .slice(start.index + start[0].length, end.index)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const match = ENTRY.exec(line);
    const entry = match && { file: match[1] as string, test: (match[2] as string).trim() };
    const problem = entry ? entryProblem(entry) : 'it is not "- `<file>`: <test>"';
    if (!entry || problem) {
      const quoted = [...line].length > 80 ? `${[...line].slice(0, 79).join('')}…` : line;
      return { error: `Line ${i + 1} of the section, "${quoted}", cannot be read: ${problem}` };
    }
    if (!tests.some((t) => t.file === entry.file && t.test === entry.test)) tests.push(entry);
  }
  if (tests.length > MOST_CONTRADICTED) {
    return { error: `The section names ${tests.length} tests, more than the ${MOST_CONTRADICTED} allowed` };
  }
  return { tests };
}
