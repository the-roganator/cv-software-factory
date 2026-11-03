import { describe, expect, it, vi } from 'vitest';
import { newIn } from '../../src/gates/image-scan.ts';
import { compare } from '../../src/gates/integrity.ts';
import {
  type Comparison,
  compareJourneys,
  comparisonIn,
  comparisonMessage,
  regressionsIn,
  type Seen,
  summary,
  toRunAgain,
} from '../../src/gates/journeys.ts';
import { testsIn } from '../../src/gates/tests.ts';
import { changedTests, outcomes } from '../../src/gates/tests-first.ts';

const FILE = `import { describe, expect, it } from 'vitest';

// A comment that ends with a full stop.
describe('cart', () => {
  const pattern = /\\(it\\(/; // a regular expression with parentheses in it
  it('counts items', () => {
    expect(count([1, 2])).toBe(2);
    expect(\`\${count([])} items\`).toBe('0 items');
  });
  it.each([[1, 'one']])('names %i as %s', (n, name) => {
    expect(name).toBe(words(n));
  });
  it.skip('rounds pence', () => {
    assert.equal(round(1.005), 1.01);
  });
  describe.skip('later', () => {
    test('discounts', () => {});
  });
  it.todo('refunds');
  thing.test('not a test', () => {});
});
`;

describe('reading tests', () => {
  it('finds each test with its describe blocks, what disables it, and its assertions', () => {
    expect(testsIn(FILE).map(({ source: _, calls: __, ...t }) => t)).toEqual([
      { name: 'cart > counts items', disabled: false, assertions: 2 },
      { name: 'cart > names %i as %s', disabled: false, assertions: 1 },
      { name: 'cart > rounds pence', disabled: 'skip', assertions: 1 },
      { name: 'cart > later > discounts', disabled: 'skip', assertions: 0 },
      { name: 'cart > refunds', disabled: 'todo', assertions: 0 },
    ]);
  });

  it('is not fooled by test-like text in strings, comments and templates', () => {
    const source = `it('real', () => {
      const s = "it('fake', () => { expect(1) })";
      // it('commented', () => {})
      const t = \`\${"it('in a template')"} expect(\`;
      expect(s).toBeTruthy();
    });`;
    expect(testsIn(source).map((t) => [t.name, t.assertions])).toEqual([['real', 1]]);
  });
});

describe('test integrity', () => {
  const base = new Map([
    ['test/cart.test.ts', FILE],
    [
      'test/money.test.ts',
      `it('adds', () => { expect(1).toBe(1); expect(2).toBe(2); });\nit('subtracts', () => { expect(0).toBe(0); });`,
    ],
    ['test/old.test.ts', `it('moves', () => { expect(1).toBe(1); });`],
  ]);

  it('passes added tests and assertions, and a test that moved file', () => {
    const change = new Map(base);
    change.delete('test/old.test.ts');
    change.set(
      'test/new.test.ts',
      `it('moves', () => { expect(1).toBe(1); });\nit('is new', () => { expect(1).toBe(1); });`,
    );
    change.set(
      'test/money.test.ts',
      `${base.get('test/money.test.ts')}\nit('multiplies', () => { expect(1).toBe(1); });`,
    );
    const { problems, added } = compare(base, change);
    expect(problems).toEqual([]);
    expect(added.map((a) => a.test).sort()).toEqual(['is new', 'multiplies']);
  });

  it('fails a deleted file, a deleted test, a skipped one, fewer assertions and .only', () => {
    const change = new Map(base);
    change.delete('test/old.test.ts');
    change.set('test/money.test.ts', `it('adds', () => { expect(1).toBe(1); });`);
    change.set(
      'test/cart.test.ts',
      FILE.replace("it('counts items'", "it.only('counts items'").replace('it.each(', 'it.skip.each('),
    );
    expect(compare(base, change).problems.map((p) => p.message)).toEqual([
      '"cart > counts items" is narrowed with .only, which skips every other test in its file',
      '"cart > names %i as %s" is skipped',
      '"adds" no longer asserts expect(2).toBe(2)',
      '"subtracts" was deleted',
      'test/old.test.ts was deleted, with its 1 test',
    ]);
  });
});

describe('tests first', () => {
  const base = new Map([['test/a.test.ts', `it('old', () => { expect(1).toBe(1); });`]]);
  const change = new Map([
    ['test/a.test.ts', `it('old', () => { expect(1).toBe(1); });\nit('new %s', () => { expect(2).toBe(2); });`],
    ['test/support/helper.ts', 'export const x = 1;'],
  ]);

  it('copies what changed in test folders, and looks for the new and changed tests only', () => {
    const { copy, manifest } = changedTests(base, change);
    expect(copy).toEqual(['test/a.test.ts', 'test/support/helper.ts']);
    expect(manifest).toEqual({
      root: '',
      files: ['test/a.test.ts'],
      tests: [{ file: 'test/a.test.ts', name: 'new %s' }],
    });
  });

  it('reads Vitest’s results, filling in placeholders, and a file that would not load as failed', () => {
    const manifest = {
      root: '/work/base',
      files: ['test/a.test.ts', 'test/b.test.ts'],
      tests: [
        { file: 'test/a.test.ts', name: 'new %s' },
        { file: 'test/a.test.ts', name: 'other' },
        { file: 'test/b.test.ts', name: 'needs a new helper' },
      ],
    };
    const results = {
      testResults: [
        {
          name: '/work/base/test/a.test.ts',
          status: 'failed',
          assertionResults: [
            { ancestorTitles: [], title: 'new thing', status: 'failed' },
            { ancestorTitles: [], title: 'other', status: 'passed' },
          ],
        },
        { name: '/work/base/test/b.test.ts', status: 'failed', message: 'Cannot find module', assertionResults: [] },
      ],
    };
    expect(outcomes(manifest, results).map((o) => o.outcome)).toEqual(['failed', 'passed', 'failed']);
  });
});

describe('journeys', () => {
  const seen = (check: string, failed: boolean, trouble?: string): Seen => ({
    sense: 'probe',
    check,
    route: '/',
    failed,
    ...(trouble ? { trouble } : {}),
  });

  it('fails only on what passes on the base and fails on the change twice', async () => {
    const runs: Record<string, Seen[][]> = {
      base: [
        [
          seen('broken', true),
          seen('fine', false),
          seen('regressed', false),
          seen('flaky', false),
          seen('unsure', false, 'timed out'),
          seen('fixed', true),
        ],
      ],
      change: [
        [
          seen('broken', true),
          seen('fine', false),
          seen('regressed', true),
          seen('flaky', true),
          seen('unsure', true),
          seen('fixed', false),
          seen('new page', true),
        ],
        [
          seen('broken', true),
          seen('fine', false),
          seen('regressed', true),
          seen('flaky', false),
          seen('unsure', true),
          seen('fixed', false),
          seen('new page', true),
        ],
      ],
    };
    const observed: string[] = [];
    const c = await compareJourneys(
      async (app, only) => {
        observed.push(only ? `${app}: ${only.map((s) => s.check).join(', ')}` : app);
        return runs[app]?.shift() ?? [];
      },
      'base',
      'change',
    );
    // Only what failed on the change, and passed on the base or is new, is observed again.
    expect(observed).toEqual(['base', 'change', 'change: regressed, flaky, new page']);
    expect(c.regressions.map((s) => s.check)).toEqual(['regressed', 'new page']);
    expect(c.flaky.map((s) => s.check)).toEqual(['flaky']);
    expect(c.unsure.map((s) => s.check)).toEqual(['unsure']);
    expect(c.unchanged.map((s) => s.check)).toEqual(['broken']);
    expect(c.fixed.map((s) => s.check)).toEqual(['fixed']);
    // What passed of what ran on each: on the change, the check that failed once and then passed counts as passing.
    expect(c.counts).toEqual({ base: { passed: 3, ran: 6 }, change: { passed: 3, ran: 7 } });
    expect(summary(c)).toMatch(/^## Journeys\n\n2 checks that pass on the base fail on this change, twice\./);
  });

  it('observes the base and the change at once', async () => {
    let looking = 0;
    let most = 0;
    await compareJourneys(
      async () => {
        most = Math.max(most, ++looking);
        await new Promise((resolve) => setTimeout(resolve, 10));
        looking--;
        return [seen('fine', false)];
      },
      'base',
      'change',
    );
    expect(most).toBe(2);
  });

  it('runs again the probes that made what failed, and the crawl only when a check of its failed', () => {
    const crawled: Seen = { sense: 'crawler', check: 'missing-alt@/sale', route: '/sale', failed: true };
    expect(toRunAgain([seen('search-ignores-case', true), seen('home-links-open/console', true)])).toEqual({
      probes: new Set(['search-ignores-case', 'home-links-open']),
      crawl: false,
    });
    expect(toRunAgain([crawled])).toEqual({ probes: new Set(), crawl: true });
  });

  it('runs the change once when nothing new fails', async () => {
    let calls = 0;
    const c = await compareJourneys(
      async () => {
        calls++;
        return [seen('broken', true)];
      },
      'base',
      'change',
    );
    expect(calls).toBe(2);
    expect(c.regressions).toEqual([]);
  });
});

describe('journeys, when a route led to no page on the base', () => {
  const crawled = (check: string, failed: boolean, trouble?: string): Seen => ({
    sense: 'crawler',
    check,
    route: check.split('@')[1] as string,
    failed,
    ...(trouble ? { trouble } : {}),
  });
  const noPage = 'No page was opened at /departments/home: it redirects round in a circle.';

  it('reports what a page shows there as could not compare, and fails on nothing the base already had', async () => {
    // The base loops, so no page was opened behind it; the change redirects to the products, which fail already.
    const base = [
      crawled('redirect-loop@/departments/:department', true),
      crawled('missing-alt@/departments/:department', false, noPage),
      crawled('missing-alt@/products', true),
    ];
    const change = [crawled('redirect-loop@/departments/:department', false), crawled('missing-alt@/products', true)];
    const runs = [base, change, change];
    const c = await compareJourneys(async () => runs.shift() ?? [], 'base', 'change');
    expect(c.regressions).toEqual([]);
    expect(c.unchanged.map((s) => s.check)).toEqual(['missing-alt@/products']);
    expect(c.fixed.map((s) => s.check)).toEqual(['redirect-loop@/departments/:department']);
  });

  it('is unsure, not failed, where the change opens a page there that fails', async () => {
    const runs = [
      [crawled('missing-alt@/departments/:department', false, noPage)],
      [crawled('missing-alt@/departments/:department', true)],
    ];
    const c = await compareJourneys(async () => runs.shift() ?? [], 'base', 'change');
    expect(c.regressions).toEqual([]);
    expect(c.unsure.map((s) => s.check)).toEqual(['missing-alt@/departments/:department']);
  });

  it('still fails on a check the base does not have, which fails on the change twice', async () => {
    const runs = [
      [crawled('missing-alt@/products', true)],
      [crawled('missing-alt@/products', true), crawled('missing-alt@/sale', true)],
      [crawled('missing-alt@/products', true), crawled('missing-alt@/sale', true)],
    ];
    const c = await compareJourneys(async () => runs.shift() ?? [], 'base', 'change');
    expect(c.regressions.map((s) => s.check)).toEqual(['missing-alt@/sale']);
  });
});

describe('journeys, as the canary’s analysis Job reports them', () => {
  const comparison = (regressions: Seen[]): Comparison => ({
    regressions,
    fixed: [],
    unchanged: [],
    flaky: [],
    unsure: [],
    counts: { base: { passed: 31, ran: 40 }, change: { passed: 30, ran: 40 } },
  });
  const regressed: Seen = {
    sense: 'probe',
    check: 'checkout/console',
    route: '/checkout',
    failed: true,
    symptom: 'browser-error',
    message: 'The browser’s console logged an error',
  };

  it('writes the counts and the checks that regressed for the line to read back, and nothing else they saw', () => {
    const message = comparisonMessage(comparison([{ ...regressed, evidence: [] }]));
    expect(JSON.parse(message)).toEqual({
      regressions: [
        {
          sense: 'probe',
          check: 'checkout/console',
          route: '/checkout',
          symptom: 'browser-error',
          message: 'The browser’s console logged an error',
        },
      ],
      counts: { base: { passed: 31, ran: 40 }, change: { passed: 30, ran: 40 } },
    });
    expect(comparisonIn(message)).toEqual(JSON.parse(message));
    expect(regressionsIn(message)).toEqual(JSON.parse(message).regressions);
    // Nothing regressed: the counts are still there to read.
    expect(comparisonIn(comparisonMessage(comparison([])))).toEqual({
      regressions: [],
      counts: { base: { passed: 31, ran: 40 }, change: { passed: 30, ran: 40 } },
    });
    // One that could not finish on the change has no class of its own: its trouble is its words.
    const { symptom: _, message: __, ...rest } = regressed;
    const stuck: Seen = { ...rest, failed: false, trouble: 'Timed out' };
    expect(regressionsIn(comparisonMessage(comparison([stuck])))).toEqual([
      { sense: 'probe', check: 'checkout/console', route: '/checkout', message: 'Timed out' },
    ]);
  });

  it('cuts a check’s name as before, with no mark, and its words with one, neither inside an emoji', () => {
    const named = { ...regressed, check: `${'c'.repeat(79)}😀 more`, message: `${'m'.repeat(298)}😀 more` };
    const [cut] = regressionsIn(comparisonMessage(comparison([named]))) ?? [];
    expect(cut?.check).toBe('c'.repeat(79));
    expect(cut?.message).toBe(`${'m'.repeat(298)}…`);
    const plain = { ...regressed, check: 'c'.repeat(100) };
    expect(regressionsIn(comparisonMessage(comparison([plain])))?.[0]?.check).toBe('c'.repeat(80));
  });

  it('fits Kubernetes’s 4 KiB, naming as many as fit and counting the rest', () => {
    const long = Array.from({ length: 20 }, (_, i) => ({
      ...regressed,
      check: `check ${i} ${'é'.repeat(70)}`,
      message: 'ü'.repeat(400),
    }));
    const message = comparisonMessage(comparison(long));
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(4096);
    const read = JSON.parse(message) as { regressions: unknown[]; more: number };
    expect(read.regressions.length).toBeGreaterThan(0);
    expect(read.regressions.length + read.more).toBe(20);
    expect(regressionsIn(message)).toHaveLength(read.regressions.length);
    expect(comparisonIn(message)?.counts).toEqual({ base: { passed: 31, ran: 40 }, change: { passed: 30, ran: 40 } });
  });

  it('reads the regressions of a message with no counts, as an older gate wrote, or with bad ones', () => {
    const regressions = [{ sense: 'probe', check: 'checkout/console', route: '/checkout' }];
    expect(comparisonIn(JSON.stringify({ regressions }))).toEqual({ regressions });
    for (const counts of [{ base: { passed: 3, ran: 2 }, change: { passed: 1, ran: 2 } }, { base: 'all' }, 7]) {
      expect(comparisonIn(JSON.stringify({ regressions, counts }))).toEqual({ regressions });
    }
  });

  it('reads nothing from a message that is missing, not JSON, or not what the gate writes', () => {
    for (const text of [undefined, '', '  ', 'Error: Chromium crashed', '{"regressions":[{"sense":"probe"}]}', '[]']) {
      expect(regressionsIn(text)).toBeUndefined();
      expect(comparisonIn(text)).toBeUndefined();
    }
  });
});

describe('image scan', () => {
  const report = (...v: [string, string, string, string][]) => ({
    Results: [
      {
        Target: 'app',
        Vulnerabilities: v.map(([id, pkg, version, severity]) => ({
          VulnerabilityID: id,
          PkgName: pkg,
          InstalledVersion: version,
          Severity: severity,
        })),
      },
    ],
  });

  it('fails on a high or critical vulnerability the change brings in, and not on one the base has', () => {
    const base = report(['CVE-1', 'openssl', '3.0', 'CRITICAL'], ['CVE-2', 'zlib', '1.2', 'LOW']);
    const change = report(
      ['CVE-1', 'openssl', '3.1', 'CRITICAL'],
      ['CVE-3', 'left-pad', '1.0', 'HIGH'],
      ['CVE-4', 'tar', '6', 'MEDIUM'],
    );
    const { added, failing, removed } = newIn(base, change);
    expect(added.map((v) => v.VulnerabilityID)).toEqual(['CVE-3', 'CVE-4']);
    expect(failing.map((v) => v.VulnerabilityID)).toEqual(['CVE-3']);
    expect(removed.map((v) => v.VulnerabilityID)).toEqual(['CVE-2']);
  });
});

describe('journeys, when a check cannot finish on the change', () => {
  const seen = (check: string, failed: boolean, trouble?: string): Seen => ({
    sense: 'probe',
    check,
    route: '/',
    failed,
    ...(trouble ? { trouble } : {}),
  });

  it('fails the gate when it passed on the base and could not finish on the change, twice', async () => {
    const runs: Seen[][] = [
      [seen('buy', false), seen('search', false)],
      [seen('buy', false, 'the button to click is not there'), seen('search', false, 'timed out')],
      [seen('buy', false, 'the button to click is not there'), seen('search', false)],
    ];
    const c = await compareJourneys(async () => runs.shift() ?? [], 'base', 'change');
    expect(c.regressions.map((s) => [s.check, s.trouble])).toEqual([['buy', 'the button to click is not there']]);
    expect(c.flaky.map((s) => s.check)).toEqual(['search']);
    // One that could not finish did not pass.
    expect(c.counts).toEqual({ base: { passed: 2, ran: 2 }, change: { passed: 1, ran: 2 } });
    expect(summary(c)).toContain('the button to click is not there');
  });

  it('does not count as passing a check the second run left out', async () => {
    const runs: Seen[][] = [[seen('buy', false)], [seen('buy', true)], []];
    const c = await compareJourneys(async () => runs.shift() ?? [], 'base', 'change');
    expect(c.flaky.map((s) => s.check)).toEqual(['buy']);
    expect(c.counts.change).toEqual({ passed: 0, ran: 1 });
  });
});

describe('the gates’ scripts, end to end', () => {
  const dirs = async (files: Record<string, string>) => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'gate-'));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    return dir;
  };

  it('test integrity: duplicate names in one file, a test added skipped, and one deleted', async () => {
    const { main } = await import('../../src/gates/test-integrity.ts');
    const twice = `describe('a', () => { it('x', () => { expect(1).toBe(1); }); });\ndescribe('b', () => { it('x', () => { expect(1).toBe(1); }); });`;
    const base = await dirs({ 'test/a.test.ts': twice });
    const kept = await dirs({ 'test/a.test.ts': `${twice}\nit.skip('later', () => {});` });
    const lost = await dirs({ 'test/a.test.ts': `describe('a', () => { it('x', () => { expect(1).toBe(1); }); });` });
    const output: string[] = [];
    const log = console.log;
    console.log = (line: string) => void output.push(line);
    // In Actions the summary goes to the job's page instead.
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    try {
      expect(await main([base, kept], {})).toBe(0);
      expect(output.join('\n')).toContain('"later" was added, but is skipped');
      expect(await main([base, lost], {})).toBe(1);
      expect(output.join('\n')).toContain('"b > x" was deleted');
    } finally {
      console.log = log;
      vi.unstubAllEnvs();
    }
  });

  it('image scan: a report with no results is no vulnerability, new or old', async () => {
    const { main } = await import('../../src/gates/image-scan.ts');
    const dir = await dirs({
      'base.json': '{}',
      'change.json': '{"Results":[{"Target":"app","Vulnerabilities":null}]}',
    });
    const log = console.log;
    console.log = () => {};
    try {
      expect(await main([`${dir}/base.json`, `${dir}/change.json`])).toBe(0);
    } finally {
      console.log = log;
    }
  });

  it('tests first: a result is a file’s by its exact path from the checkout', () => {
    const manifest = { root: '/work/base', files: ['test/a.test.ts'], tests: [{ file: 'test/a.test.ts', name: 'x' }] };
    const elsewhere = {
      testResults: [
        {
          name: '/work/base/src/test/a.test.ts',
          status: 'failed',
          assertionResults: [{ ancestorTitles: [], title: 'x', status: 'failed' }],
        },
      ],
    };
    expect(outcomes(manifest, elsewhere).map((o) => o.outcome)).toEqual(['did not run']);
  });
});
