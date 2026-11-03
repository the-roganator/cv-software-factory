/**
 * Reads the tests in a test file: each test's name (with the `describe` blocks around it), whether it is skipped, and
 * how many assertions it makes. Test integrity compares what a pull request's base has with what its change has.
 *
 * It scans the source rather than parsing it: no TypeScript compiler, so the gate runs on Node alone from a sparse
 * checkout, where a pull request cannot change it. The scanner knows strings, template literals, comments and regular
 * expressions well enough to find each call's closing parenthesis, which is all it needs.
 *
 * It understands Vitest's and Jest's shapes: `describe`, `it` and `test`, with their modifiers (`.skip`, `.only`,
 * `.todo`, `.each(...)`, `.skipIf(...)`, `.runIf(...)`), and `xit`, `xtest`, `xdescribe`.
 */

export interface TestCase {
  /** The `describe` names and the test's own, joined with " > ". */
  name: string;
  /** Skipped, left to do, or narrowed with `.only` (which skips every other test in the file). */
  disabled: false | 'skip' | 'todo' | 'only' | 'conditional';
  /** Calls to `expect` and `assert` inside the test's body, including in helpers it defines there. */
  assertions: number;
  /**
   * Each of those calls as text, in order: the whole chain, such as `expect(res.status).not.toBe(500)`, with the
   * spacing, line breaks and comments outside strings taken out (one space kept between two words), a trailing comma
   * dropped and every plain string in single quotes, so a test reformatted asserts what it did.
   */
  calls: string[];
  /** The test's call as written, for telling whether a test changed. */
  source: string;
}

const BLOCKS = new Set(['describe', 'it', 'test', 'xit', 'xtest', 'xdescribe', 'suite', 'bench']);

const KEYWORDS_BEFORE_REGEX = ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await'];

/** Which characters are code, rather than inside a string, comment or regular expression. */
function codeMask(source: string): boolean[] {
  const code = new Array<boolean>(source.length).fill(false);
  // One entry for each template expression (`${…}`) the scanner is in: the braces opened inside it.
  const expressions: number[] = [];
  let inTemplate = false;

  // Whether a `/` at this index starts a regular expression rather than dividing.
  const regexAllowed = (at: number) => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(source[j] ?? '')) j--;
    if (j < 0) return true;
    if ('([{,;:=!&|?+-*%<>~^'.includes(source[j] ?? '')) return true;
    const word = /[A-Za-z_$]+$/.exec(source.slice(Math.max(0, j - 10), j + 1))?.[0];
    return word !== undefined && KEYWORDS_BEFORE_REGEX.includes(word);
  };
  // The index just past what starts at `i` and ends at the first `end` not escaped, or at the line's end.
  const past = (i: number, end: string, oneLine: boolean) => {
    let j = i + 1;
    while (j < source.length && source[j] !== end && !(oneLine && source[j] === '\n')) j += source[j] === '\\' ? 2 : 1;
    return j + 1;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (inTemplate) {
      if (c === '\\') i += 2;
      else if (c === '`') {
        inTemplate = false;
        i++;
      } else if (c === '$' && next === '{') {
        expressions.push(0);
        inTemplate = false;
        i += 2;
      } else i++;
    } else if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'") {
      i = past(i, c, true);
    } else if (c === '`') {
      inTemplate = true;
      i++;
    } else if (c === '/' && regexAllowed(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (inClass || source[j] !== '/')) {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j++;
      }
      i = j + 1;
    } else {
      const depth = expressions.at(-1);
      if (depth !== undefined && c === '{') expressions[expressions.length - 1] = depth + 1;
      if (depth !== undefined && c === '}') {
        if (depth === 0) {
          // The template expression ends, and the template it is in goes on.
          expressions.pop();
          inTemplate = true;
          i++;
          continue;
        }
        expressions[expressions.length - 1] = depth - 1;
      }
      code[i] = true;
      i++;
    }
  }
  return code;
}

/** The index just after the parenthesis that closes the one at `open`, counting only code. */
function closing(source: string, code: boolean[], open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (!code[i]) continue;
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/** A string literal's value, from its opening quote. Template literals keep their `${…}` as written. */
function literal(source: string, at: number): string | undefined {
  const quote = source[at];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  let value = '';
  for (let i = at + 1; i < source.length && source[i] !== quote; i++) {
    if (source[i] === '\\') {
      value += source[i + 1] ?? '';
      i++;
    } else value += source[i];
  }
  return value;
}

const CALL = /\b(describe|it|test|xit|xtest|xdescribe|suite|bench)((?:\s*\.\s*[A-Za-z]+)*)\s*\(/g;
const ASSERTION = /\b(?:expect|assert)(?:\s*\.\s*[A-Za-z]+)*\s*\(/g;

interface Block {
  kind: 'describe' | 'test';
  name: string;
  disabled: TestCase['disabled'];
  /** Where the call's arguments start and end. */
  from: number;
  to: number;
}

/** The index of the first code character at or after `at` that is not a space: past spacing and comments. */
function skipGap(source: string, code: boolean[], at: number): number {
  let i = at;
  while (i < source.length) {
    if (code[i] && /\s/.test(source[i] ?? '')) i++;
    else if (!code[i] && source.startsWith('//', i))
      i = source.indexOf('\n', i) === -1 ? source.length : source.indexOf('\n', i);
    else if (!code[i] && source.startsWith('/*', i))
      i = source.indexOf('*/', i) === -1 ? source.length : source.indexOf('*/', i) + 2;
    else return i;
  }
  return i;
}

/** Where the chain of calls and properties that starts with the call opening at `open` ends: `(…).not.toBe(…)`. */
function chainEnd(source: string, code: boolean[], open: number): number {
  let end = closing(source, code, open);
  for (;;) {
    const at = skipGap(source, code, end);
    const link = /^\??\.\s*[A-Za-z_$][\w$]*/.exec(source.slice(at, at + 200));
    if (!link || !code[at]) return end;
    end = at + link[0].length;
    const call = skipGap(source, code, end);
    if (source[call] === '(' && code[call]) end = closing(source, code, call);
  }
}

/**
 * A string literal's text, from its opening quote, always in single quotes, so that a change of quote style is no
 * change: `'a'`, `"a"` and `` `a` `` are all `'a'`. Other escapes are kept as written. Undefined for a template literal with
 * an expression in it, which is kept as written.
 */
function quoted(source: string, at: number): { text: string; end: number } | undefined {
  const quote = source[at] as string;
  let text = '';
  for (let i = at + 1; i < source.length; i++) {
    const c = source[i] as string;
    if (c === '\\') {
      const next = source[i + 1] ?? '';
      text += next === '"' || next === '`' ? next : `\\${next}`;
      i++;
    } else if (c === quote) return { text: `'${text}'`, end: i + 1 };
    else if (quote === '`' && c === '$' && source[i + 1] === '{') return undefined;
    else text += c === "'" ? "\\'" : c;
  }
  return undefined;
}

/**
 * A call's text as `TestCase.calls` keeps it. Strings are in single quotes, comments are left out, and regular
 * expressions and templates with expressions are as written. In the code between them there is no spacing (but one
 * space between two words, as in `typeof x`) and no trailing comma.
 */
function callText(source: string, code: boolean[], from: number, to: number): string {
  const isSpace = (i: number) => code[i] === true && /\s/.test(source[i] ?? '');
  let text = '';
  for (let i = from; i < to; i++) {
    const c = source[i] as string;
    if (!code[i]) {
      const literal = c === "'" || c === '"' || c === '`' ? quoted(source, i) : undefined;
      const comment = source.startsWith('//', i) || source.startsWith('/*', i);
      if (literal && literal.end <= to) {
        text += literal.text;
        i = literal.end - 1;
      } else if (comment) {
        const end = skipGap(source, code, i);
        if (/[\w$]$/.test(text) && /^[\w$]/.test(source[end] ?? '')) text += ' ';
        i = end - 1;
      } else {
        // A regular expression, or a template's text around its expressions: as written, up to the code after it.
        let end = i + 1;
        while (end < to && !code[end]) end++;
        text += source.slice(i, end);
        i = end - 1;
      }
      continue;
    }
    let next = i;
    while (next < to && isSpace(next)) next++;
    if (next > i) {
      if (/[\w$]$/.test(text) && /^[\w$]/.test(source[next] ?? '')) text += ' ';
      i = next - 1;
      continue;
    }
    if (c === ',') {
      const after = skipGap(source, code, i + 1);
      if (code[after] && ')]}'.includes(source[after] ?? '')) continue;
    }
    text += c;
  }
  return text;
}

export function testsIn(source: string): TestCase[] {
  const code = codeMask(source);
  const blocks: Block[] = [];
  for (const match of source.matchAll(CALL)) {
    const at = match.index;
    if (!code[at]) continue;
    // A method of something else, such as `foo.test(`, is not a test.
    let before = at - 1;
    while (before >= 0 && (!code[before] || /\s/.test(source[before] ?? ''))) before--;
    if (source[before] === '.') continue;
    const head = match[1] as string;
    const modifiers = (match[2] ?? '')
      .split('.')
      .map((m) => m.trim())
      .filter(Boolean);
    let open = at + match[0].length - 1;
    // `.each(table)(name, fn)` and `.skipIf(cond)(name, fn)`: the name is in the second call.
    if (modifiers.some((m) => ['each', 'skipIf', 'runIf', 'for'].includes(m))) {
      const after = closing(source, code, open);
      const second = source.slice(after).match(/^\s*\(/);
      if (!second) continue;
      open = after + second[0].length - 1;
    }
    let nameAt = open + 1;
    while (/\s/.test(source[nameAt] ?? '')) nameAt++;
    const name = literal(source, nameAt);
    if (name === undefined || !BLOCKS.has(head)) continue;
    const disabled: TestCase['disabled'] =
      head.startsWith('x') || modifiers.includes('skip')
        ? 'skip'
        : modifiers.includes('todo')
          ? 'todo'
          : modifiers.includes('only')
            ? 'only'
            : modifiers.some((m) => m === 'skipIf' || m === 'runIf')
              ? 'conditional'
              : false;
    blocks.push({
      kind: head.endsWith('describe') || head === 'suite' ? 'describe' : 'test',
      name,
      disabled,
      from: open,
      to: closing(source, code, open),
    });
  }

  const assertions = [...source.matchAll(ASSERTION)]
    .filter((m) => code[m.index])
    .map((m) => ({
      at: m.index,
      text: callText(source, code, m.index, chainEnd(source, code, m.index + m[0].length - 1)),
    }));
  return blocks
    .filter((b) => b.kind === 'test')
    .map((test) => {
      const around = blocks.filter((b) => b.kind === 'describe' && b.from < test.from && b.to >= test.to);
      const describedDisabled = around.find((b) => b.disabled)?.disabled ?? false;
      const calls = assertions.filter((a) => a.at > test.from && a.at < test.to).map((a) => a.text);
      return {
        name: [...around.map((b) => b.name), test.name].join(' > '),
        disabled: test.disabled || describedDisabled,
        assertions: calls.length,
        calls,
        source: source.slice(test.from, test.to),
      };
    });
}
