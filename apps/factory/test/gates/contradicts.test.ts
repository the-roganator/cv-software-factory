import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Contradicted,
  END,
  entryProblem,
  MOST_CONTRADICTED,
  parse,
  render,
  START,
  strip,
  withContradicted,
} from '../../src/gates/contradicts.ts';
import { compare } from '../../src/gates/integrity.ts';
import { CONTRADICTS_FORMAT, description, main, pullRequestNumber } from '../../src/gates/test-integrity.ts';
import { testsIn } from '../../src/gates/tests.ts';

const NAMED: Contradicted = { file: 'test/app.test.ts', test: 'files > keeps nothing of the other files' };

const SECTION = `## Tests the spec contradicts

The spec's criteria contradict these existing tests, so this change may delete, rename or rewrite them, and no other.
Test integrity names each one in its summary.

<!-- factory:contradicts -->
- \`test/app.test.ts\`: files > keeps nothing of the other files
<!-- /factory:contradicts -->`;

describe('the section of tests the spec contradicts', () => {
  it('is rendered as the line writes it, and read back as it was written', () => {
    expect(render([NAMED])).toBe(SECTION);
    const two = [NAMED, { file: 'test/cart.test.ts', test: 'cart > counts items, as a > b does' }];
    expect(parse(render(two))).toEqual({ tests: two });
    expect(render([])).toBe('');
  });

  it('reads nothing from a description with no markers, or none at all', () => {
    expect(parse('## Tests the spec contradicts\n\n- `test/app.test.ts`: files > anything')).toEqual({ tests: [] });
    expect(parse(null)).toEqual({ tests: [] });
    expect(parse('')).toEqual({ tests: [] });
  });

  it('reads only between the markers, as a person might type them, and with Windows line ends', () => {
    const typed = `Some text naming \`test/other.test.ts\`: other.\r\n\r\n<!--factory:contradicts-->\r\n\r\n  - \`test/app.test.ts\`: files > keeps nothing of the other files  \r\n- \`test/app.test.ts\`: files > keeps nothing of the other files\r\n<!-- /factory:contradicts -->\r\n- \`test/after.test.ts\`: after`;
    expect(parse(typed)).toEqual({ tests: [NAMED] });
  });

  it('cannot be read with a malformed line, other than one pair of markers, or too many tests', () => {
    const body = (lines: string[]) => `${START}\n${lines.join('\n')}\n${END}`;
    const errors = [
      body(['- test/app.test.ts: files > no backticks']),
      body(['* `test/app.test.ts`: files > another bullet']),
      body(['- `test/app.test.ts`:']),
      body(['- `../outside.test.ts`: up and out']),
      body(['- `/etc/passwd.test.ts`: from the root']),
      body([`- \`test/a.test.ts\`: ${'x'.repeat(301)}`]),
      `${body(['- `test/a.test.ts`: a'])}\n${body(['- `test/b.test.ts`: b'])}`,
      `${START}\n- \`test/a.test.ts\`: a`,
      `${END}\n- \`test/a.test.ts\`: a\n${START}`,
      body(Array.from({ length: MOST_CONTRADICTED + 1 }, (_, i) => `- \`test/a.test.ts\`: test ${i}`)),
    ].map((text) => parse(text));
    for (const result of errors) expect(result).toHaveProperty('error');
    expect(errors[0]).toEqual({
      error:
        'Line 1 of the section, "- test/app.test.ts: files > no backticks", cannot be read: it is not "- `<file>`: <test>"',
    });
    // At most ten, by the same count the line writes.
    const ten = Array.from({ length: MOST_CONTRADICTED }, (_, i) => ({ file: 'test/a.test.ts', test: `test ${i}` }));
    expect(parse(render(ten))).toEqual({ tests: ten });
    expect(() => render([...ten, NAMED])).toThrow();
  });

  it('is never rendered for an entry the gate would not read', () => {
    for (const entry of [
      { file: 'test/a b.test.ts', test: 'x' },
      { file: 'test/`a`.test.ts', test: 'x' },
      { file: 'test/a.test.ts', test: 'two\nlines' },
      { file: 'test/a.test.ts', test: ' padded' },
      { file: 'test//a.test.ts', test: 'x' },
    ]) {
      expect(entryProblem(entry)).toBeDefined();
      expect(() => render([entry])).toThrow();
    }
    expect(entryProblem(NAMED)).toBeUndefined();
  });

  it('never names a test with comment marks in it, or what GitHub would make a mention or a link', () => {
    for (const test of [
      'a <!-- /factory:contradicts --> b',
      'a <!--FACTORY:CONTRADICTS--> b',
      'ends a comment -->',
      'ends a comment too --!>',
      'tells @martin',
      'closes #12',
    ]) {
      expect(entryProblem({ file: 'test/a.test.ts', test })).toBeDefined();
      expect(() => render([{ file: 'test/a.test.ts', test }])).toThrow();
    }
    expect(entryProblem({ file: 'test/<!--a.test.ts', test: 'x' })).toBeDefined();
    // An @ or # alone is a name like any other.
    expect(entryProblem({ file: 'test/a.test.ts', test: 'sends mail to a @ sign and # signs' })).toBeUndefined();
  });

  it('takes a marker ended as HTML may end a comment, with --!>, as any other', () => {
    const bang = `Text\n\n<!-- factory:contradicts --!>\n- \`test/a.test.ts\`: a\n<!-- /factory:contradicts --!>\n\nMore`;
    expect(parse(bang)).toEqual({ tests: [{ file: 'test/a.test.ts', test: 'a' }] });
    expect(strip(bang)).toBe('Text\n\nMore');
    expect(strip('Text <!-- factory:contradicts --!> more')).toBe('Text  more');
  });

  it('takes out a marker that taking out another one would make', () => {
    const spliced = 'Text <!-- factory:con<!-- /factory:contradicts -->tradicts --> more';
    expect(strip(spliced)).toBe('Text  more');
    expect(parse(strip(spliced))).toEqual({ tests: [] });
    const nested = `${START.slice(0, 10)}${START}\n- \`test/a.test.ts\`: a\n${END}${START.slice(10)}`;
    expect(parse(strip(nested))).toEqual({ tests: [] });
  });

  it('is taken out of the describer’s text, whole or as stray markers, and replaced by the line’s', () => {
    const describer = `The change makes every asset cacheable.\n\n${SECTION}\n\n## Risk\n\nNone.\n\n<!-- FACTORY:contradicts -->\n- \`test/b.test.ts\`: b\n<!-- /factory:contradicts -->\n\n<!-- factory:contradicts -->`;
    const stripped = strip(describer);
    expect(stripped).toBe('The change makes every asset cacheable.\n\n## Risk\n\nNone.');
    expect(parse(stripped)).toEqual({ tests: [] });
    const written = withContradicted(describer, [NAMED]);
    expect(written).toBe(`${stripped}\n\n${SECTION}`);
    expect(parse(written)).toEqual({ tests: [NAMED] });
    // A spec that names none leaves no section at all.
    expect(withContradicted(describer, [])).toBe(stripped);
  });
});

describe('assertions as text', () => {
  it('keeps each assertion’s whole chain, with code’s spacing and a trailing comma taken out, and strings as written', () => {
    const [test] = testsIn(`it('caches', async () => {
      expect(res.headers.get('cache-control'))
        .toBe('no-store');
      await expect(load( 'a  b' ))?.resolves.not.toEqual({
        typeof: typeof x,
      });
      assert.equal(1, 1);
      expect.soft(n).toBeGreaterThan(0)
    });`);
    expect(test?.calls).toEqual([
      "expect(res.headers.get('cache-control')).toBe('no-store')",
      "expect(load('a  b'))?.resolves.not.toEqual({typeof:typeof x})",
      'assert.equal(1,1)',
      'expect.soft(n).toBeGreaterThan(0)',
    ]);
  });
});

describe('assertions as text, reformatted', () => {
  const calls = (body: string) => testsIn(`it('x', () => { ${body} });`)[0]?.calls;

  it('follows a computed matcher, and keeps a hole in an array apart from a trailing comma', () => {
    expect(calls("expect(v)[matcher](x); expect(v)?.['not'].toBe(1);")).toEqual([
      'expect(v)[matcher](x)',
      "expect(v)?.['not'].toBe(1)",
    ]);
    expect(
      calls('expect(a).toEqual([,]); expect(a).toEqual([]); expect(a).toEqual([1,,]); expect(a).toEqual([1,]);'),
    ).toEqual([
      'expect(a).toEqual([,])',
      'expect(a).toEqual([])',
      'expect(a).toEqual([1,,])',
      'expect(a).toEqual([1])',
    ]);
  });

  it('is the same with other quotes, comments or line breaks, and different with another matcher', () => {
    const plain = calls("expect(res.status).toBe(200); expect(a).toBe('it\\'s');");
    expect(calls('expect(res.status) // the status\n  .toBe(200);\nexpect(a).toBe("it\'s");')).toEqual(plain);
    expect(calls("expect(res.status) /* a */ .toBe(200); expect(a).toBe(`it's`);")).toEqual(plain);
    expect(calls('expect(res.status) // the status\n  .toBeDefined();')?.[0]).toBe('expect(res.status).toBeDefined()');
    // A template's text around its expressions stays as written, slashes and all.
    const template = 'expect(url).toBe(`$' + '{proto}//host`)';
    expect(calls(`${template};`)).toEqual([template]);
  });
});

describe('test integrity, with tests the spec contradicts', () => {
  const app = (body: string) => `describe('files', () => {
  it('keeps the page', () => {
    expect(headers('/').get('cache-control')).toBe('no-store');
  });
${body}
});
`;
  const before = app(`  it('keeps nothing of the other files', () => {
    expect(headers('/site.css').get('cache-control')).toBe('no-store');
  });`);
  // The change the coder made: the test renamed and rewritten for the spec's new behaviour.
  const renamed = app(`  it('lets the other files be kept', () => {
    expect(headers('/site.css').get('cache-control')).toMatch(/max-age/);
  });`);
  // The same behaviour change, under the old name.
  const flipped = app(`  it('keeps nothing of the other files', () => {
    expect(headers('/site.css').get('cache-control')).toMatch(/max-age/);
  });`);
  const base = new Map([['test/app.test.ts', before]]);

  it('passes a named test renamed and rewritten, as excused, and fails the same change unnamed', () => {
    const change = new Map([['test/app.test.ts', renamed]]);
    const excused = compare(base, change, [NAMED]);
    expect(excused.problems).toEqual([]);
    expect(excused.contradicted).toEqual([
      { file: 'test/app.test.ts', test: NAMED.test, change: 'deleted', message: `"${NAMED.test}" was deleted` },
    ]);
    expect(excused.added.map((a) => a.test)).toEqual(['files > lets the other files be kept']);
    expect(compare(base, change).problems.map((p) => p.message)).toEqual([`"${NAMED.test}" was deleted`]);
  });

  it('fails an assertion turned around under the same name, unless the spec names the test', () => {
    const change = new Map([['test/app.test.ts', flipped]]);
    expect(compare(base, change).problems.map((p) => p.message)).toEqual([
      `"${NAMED.test}" no longer asserts expect(headers('/site.css').get('cache-control')).toBe('no-store')`,
    ]);
    const excused = compare(base, change, [NAMED]);
    expect(excused.problems).toEqual([]);
    expect(excused.contradicted.map((c) => c.change)).toEqual(['rewritten']);
  });

  it('passes assertions added or reformatted, and counts a repeated assertion each time', () => {
    const more = app(`  it('keeps nothing of the other files', () => {
    expect(headers('/site.css').get('cache-control'))
      .toBe('no-store');
    expect(headers('/app.js').get('cache-control')).toBe('no-store');
  });`);
    expect(compare(base, new Map([['test/app.test.ts', more]])).problems).toEqual([]);
    const twice = new Map([
      ['test/a.test.ts', "it('x', () => { expect(1).toBe(1); expect(1).toBe(1); expect(2).toBe(2); });"],
    ]);
    const once = new Map([
      ['test/a.test.ts', "it('x', () => { expect(1).toBe(1); expect(3).toBe(3); expect(4).toBe(4); });"],
    ]);
    expect(compare(twice, once).problems.map((p) => p.message)).toEqual([
      '"x" no longer asserts expect(1).toBe(1), and 1 more of its assertions',
    ]);
  });

  it('excuses only the tests named: not another in the same file, nor a test the change left alone', () => {
    const gone = new Map([['test/app.test.ts', flipped.replace(/ {2}it\('keeps the page'[\s\S]*?\}\);\n/, '')]]);
    expect(compare(base, gone, [NAMED]).problems.map((p) => p.message)).toEqual([
      '"files > keeps the page" was deleted',
    ]);
    const same = compare(base, new Map(base), [NAMED]);
    expect(same).toMatchObject({ problems: [], contradicted: [], unchanged: [NAMED], unknown: [] });
  });

  it('excuses only the named tests of a file deleted whole', () => {
    expect(compare(base, new Map(), [NAMED]).problems.map((p) => p.message)).toEqual([
      '"files > keeps the page" was deleted',
    ]);
    const both = [NAMED, { file: NAMED.file, test: 'files > keeps the page' }];
    expect(compare(base, new Map(), both)).toMatchObject({ problems: [], unknown: [] });
    expect(compare(base, new Map(), both).contradicted).toHaveLength(2);
  });

  it('fails a named test rewritten to assert nothing', () => {
    const empty = new Map([['test/app.test.ts', app("  it('keeps nothing of the other files', () => {});")]]);
    expect(compare(base, empty, [NAMED]).problems.map((p) => p.message)).toEqual([
      `"${NAMED.test}" was rewritten to assert nothing`,
    ]);
  });

  it('matches two tests of one name in a file to their own, in any order', () => {
    const two =
      "describe('a', () => { it('x', () => { expect(1).toBe(1); }); });\nit('a > x', () => { expect(2).toBe(2); });";
    const same = new Map([['test/a.test.ts', two]]);
    expect(compare(same, new Map(same)).problems).toEqual([]);
    const second = new Map([['test/a.test.ts', two.replace('expect(2).toBe(2)', 'expect(2).toBeDefined()')]]);
    expect(compare(same, second).problems.map((p) => p.message)).toEqual([
      '"a > x" no longer asserts expect(2).toBe(2)',
    ]);
    // Reordered, they assert what they did; one of them deleted, it has gone.
    const [first, last] = two.split('\n');
    expect(compare(same, new Map([['test/a.test.ts', `${last}\n${first}`]])).problems).toEqual([]);
    expect(compare(same, new Map([['test/a.test.ts', first as string]])).problems.map((p) => p.message)).toEqual([
      '"a > x" was deleted',
    ]);
  });

  it('still fails a named test skipped, or narrowed with .only', () => {
    for (const modifier of ['skip', 'only']) {
      const change = new Map([
        ['test/app.test.ts', before.replace("it('keeps nothing", `it.${modifier}('keeps nothing`)],
      ]);
      expect(compare(base, change, [NAMED]).problems.map((p) => p.test)).toEqual([NAMED.test]);
    }
  });

  it('reports an entry that names no test in the base, and fails nothing for it', () => {
    const elsewhere = { file: 'test/other.test.ts', test: NAMED.test };
    const added = { file: NAMED.file, test: 'files > lets the other files be kept' };
    const result = compare(base, new Map([['test/app.test.ts', renamed]]), [elsewhere, added]);
    expect(result.unknown).toEqual([elsewhere, added]);
    expect(result.problems.map((p) => p.message)).toEqual([`"${NAMED.test}" was deleted`]);
  });
});

describe('the gate, reading the description', () => {
  const dirs = async (files: Record<string, string>) => {
    const dir = await mkdtemp(join(tmpdir(), 'gate-'));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    return dir;
  };
  const SHA = 'a'.repeat(40);
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  /** Runs the gate as Actions would, with what it printed. */
  const run = async (args: string[], env: Record<string, string>, fetcher: typeof fetch) => {
    const output: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void output.push(line));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The summary goes to the job's page in Actions; here, to the output.
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    try {
      const code = await main(args, env, fetcher, async () => {});
      return { code, output: output.join('\n') };
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  };

  afterEach(() => vi.restoreAllMocks());

  it('takes the number the workflow passes, or the merge queue’s branch, and fails closed on anything else', () => {
    const QUEUED = `refs/heads/gh-readonly-queue/main/pr-155-${SHA}`;
    expect(pullRequestNumber({ GITHUB_EVENT_NAME: 'pull_request', PR_NUMBER: '155' })).toBe(155);
    expect(pullRequestNumber({ GITHUB_EVENT_NAME: 'merge_group', MERGE_GROUP_HEAD_REF: QUEUED })).toBe(155);
    expect(pullRequestNumber({ GITHUB_EVENT_NAME: 'merge_group', MERGE_GROUP_HEAD_REF: QUEUED.slice(11) })).toBe(155);
    for (const branch of ['refs/heads/main', 'gh-readonly-queue/main/pr-x-abc', `${QUEUED}\n`, '', undefined]) {
      expect(pullRequestNumber({ GITHUB_EVENT_NAME: 'merge_group', MERGE_GROUP_HEAD_REF: branch })).toHaveProperty(
        'error',
      );
    }
    for (const number of ['', '0', '-1', '1.5', '155 ', '0155', '12345678901', undefined]) {
      expect(pullRequestNumber({ GITHUB_EVENT_NAME: 'pull_request', PR_NUMBER: number })).toHaveProperty('error');
    }
    // A merge group is judged by its branch, never by a number it does not carry.
    expect(pullRequestNumber({ GITHUB_EVENT_NAME: 'merge_group', PR_NUMBER: '155' })).toHaveProperty('error');
    expect(pullRequestNumber({ GITHUB_EVENT_NAME: 'push', PR_NUMBER: '155' })).toHaveProperty('error');
  });

  it('reads the description through the API with the run’s token, asking again only when GitHub errs', async () => {
    const env = {
      GITHUB_EVENT_NAME: 'merge_group',
      MERGE_GROUP_HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-155-${SHA}`,
      GITHUB_TOKEN: 'token',
      GITHUB_REPOSITORY: 'the-roganator/cv-worlds-worst-website',
      GITHUB_API_URL: 'https://api.example',
    };
    const asked: [string, RequestInit | undefined][] = [];
    const replies = [answer(502, {}), answer(200, { number: 155, body: SECTION })];
    const fetcher = (async (url: string, init?: RequestInit) => {
      asked.push([url, init]);
      return replies.shift() as Response;
    }) as typeof fetch;
    expect(await description(env, fetcher, async () => {})).toBe(SECTION);
    expect(asked.map(([url]) => url)).toEqual([
      'https://api.example/repos/the-roganator/cv-worlds-worst-website/pulls/155',
      'https://api.example/repos/the-roganator/cv-worlds-worst-website/pulls/155',
    ]);
    expect(new Headers(asked[0]?.[1]?.headers).get('authorization')).toBe('Bearer token');
    // A refusal is not asked again; a description of another pull request, or with no token, is not read.
    const refused = vi.fn(async () => answer(403, { message: 'Resource not accessible by integration' }));
    expect(await description(env, refused as typeof fetch)).toEqual({
      error: "Pull request #155's description could not be read: GitHub answered 403",
    });
    expect(refused).toHaveBeenCalledTimes(1);
    expect(
      await description(env, (async () => answer(200, { number: 7, body: SECTION })) as typeof fetch),
    ).toHaveProperty('error');
    expect(await description({ ...env, GITHUB_TOKEN: '' }, refused as typeof fetch)).toHaveProperty('error');
    expect(await description(env, (async () => answer(200, { number: 155, body: null })) as typeof fetch)).toBe('');
    // An answer that is not a pull request is not asked for again.
    const garbled = vi.fn(async () => new Response('<html>', { status: 200 }));
    expect(await description(env, garbled as typeof fetch, async () => {})).toEqual({
      error: "GitHub's answer is not a pull request",
    });
    expect(garbled).toHaveBeenCalledTimes(1);
  });

  it('passes the #1015 change with the section, warning on the test, and fails it without, on either event', async () => {
    const base = await dirs({
      'test/app.test.ts':
        "describe('files', () => { it('keeps nothing of the other files', () => { expect(cc('/site.css')).toBe('no-store'); }); });",
    });
    const change = await dirs({
      'test/app.test.ts':
        "describe('files', () => { it('lets the other files be kept', () => { expect(cc('/site.css')).toMatch(/max-age/); }); });",
    });
    const events = {
      pull_request: { PR_NUMBER: '155' },
      merge_group: { MERGE_GROUP_HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-155-${SHA}` },
    };
    for (const [name, passed] of Object.entries(events)) {
      const env = {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: name,
        ...passed,
        GITHUB_TOKEN: 'token',
        GITHUB_REPOSITORY: 'the-roganator/cv-worlds-worst-website',
        GITHUB_STEP_SUMMARY: '',
      };
      const named = await run([base, change], env, (async () =>
        answer(200, { number: 155, body: `Text.\n\n${SECTION}` })) as typeof fetch);
      expect(named.code).toBe(0);
      expect(named.output).toContain(
        '::warning file=test/app.test.ts::"files > keeps nothing of the other files" was deleted, as the spec it was changed for contradicts it',
      );
      expect(named.output).toContain('### Tests the spec contradicts');
      expect(named.output).toContain('files > lets the other files be kept');
      const unnamed = await run([base, change], env, (async () =>
        answer(200, { number: 155, body: 'Text.' })) as typeof fetch);
      expect(unnamed.code).toBe(1);
      expect(unnamed.output).toContain(
        '::error file=test/app.test.ts::"files > keeps nothing of the other files" was deleted',
      );
      // The summary links to how the description names a test, and never shows the section itself.
      expect(unnamed.output).toContain(`names them as [tests the spec contradicts](${CONTRADICTS_FORMAT}).`);
      expect(unnamed.output).not.toContain('factory:contradicts');
      // Unreadable or malformed, it fails closed, saying why.
      const down = await run([base, change], env, (async () => answer(503, {})) as typeof fetch);
      expect(down.code).toBe(1);
      expect(down.output).toContain('::error::Pull request #155');
      const malformed = await run([base, change], env, (async () =>
        answer(200, { number: 155, body: `${SECTION}\n${SECTION}` })) as typeof fetch);
      expect(malformed.code).toBe(1);
      expect(malformed.output).toContain('not one pair');
      // In Actions, a description from a file is refused.
      const file = join(await dirs({ 'd.md': SECTION }), 'd.md');
      expect((await run([base, change, '--description', file], env, fetch)).code).toBe(1);
    }
  });

  it('links the summary to the heading in the docs that describes the section', async () => {
    const link = new URL(CONTRADICTS_FORMAT);
    const prefix = '/the-roganator/cv-software-factory/blob/main/';
    expect(link.pathname.startsWith(prefix)).toBe(true);
    const doc = await readFile(new URL(`../../../../${link.pathname.slice(prefix.length)}`, import.meta.url), 'utf8');
    // GitHub's anchor for a heading: lower case, spaces as hyphens.
    const headings = doc.match(/^#+ .+$/gm) ?? [];
    expect(headings.map((h) => `#${h.replace(/^#+ /, '').toLowerCase().replaceAll(' ', '-')}`)).toContain(link.hash);
  });

  it('asks GitHub nothing for a change that weakens no test', async () => {
    const base = await dirs({ 'test/a.test.ts': "it('x', () => { expect(1).toBe(1); });" });
    const never = vi.fn(async () => answer(503, {}));
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', PR_NUMBER: '155' };
    expect((await run([base, base], env, never as typeof fetch)).code).toBe(0);
    expect(never).not.toHaveBeenCalled();
  });

  it('outside Actions, reads a description from a file, or excuses nothing', async () => {
    const base = await dirs({
      'test/app.test.ts':
        "describe('files', () => { it('keeps nothing of the other files', () => { expect(1).toBe(1); }); });",
    });
    const change = await dirs({ 'test/app.test.ts': '' });
    const file = join(await dirs({ 'd.md': SECTION }), 'd.md');
    const never = (async () => {
      throw new Error('not asked');
    }) as typeof fetch;
    expect((await run([base, change, '--description', file], { GITHUB_STEP_SUMMARY: '' }, never)).code).toBe(0);
    expect((await run([base, change], { GITHUB_STEP_SUMMARY: '' }, never)).code).toBe(1);
    expect((await run([base, change, '--description'], {}, never)).code).toBe(2);
    // A file that cannot be read fails, saying so, rather than throwing.
    const missing = await run([base, change, '--description', `${file}.gone`], {}, never);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain('The description could not be read from');
  });
});
