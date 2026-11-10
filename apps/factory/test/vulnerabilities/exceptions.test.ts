import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exception } from '../../../../policy/vulnerabilities.ts';
import * as policy from '../../../../policy/vulnerabilities.ts';
import { except, type Finding as GateFinding } from '../../src/gates/lockfile-scan.ts';
import { REPOSITORIES } from '../../src/github/config.ts';
import { type Alert, type Api, changes, hold, keyOf, WONT_FIX } from '../../src/vulnerabilities/alerts.ts';
import { idle, judge, osvScannerToml, problems } from '../../src/vulnerabilities/exceptions.ts';
import { inventory } from '../../src/vulnerabilities/inventory.ts';
import { alertKey, type Finding } from '../../src/vulnerabilities/sarif.ts';

/**
 * The exceptions (policy/vulnerabilities.ts): the policy's own entries held to its rules, what an entry excepts and for
 * how long, the scan's decisions from it, the alerts it dismisses and reopens, on code scanning's recorded answers
 * (fixtures/alerts, in the shape GitHub's API gives, with invented advisories), and the lockfile gate reading the same.
 */
const ROOT = resolve(import.meta.dirname, '../../../..');
const FACTORY = 'the-roganator/cv-software-factory';
const APP = 'the-roganator/cv-worlds-worst-website';
const TODAY = '2026-11-10';
const recorded = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/alerts/${name}.json`, import.meta.url), 'utf-8')) as Alert[];

const entry = (over: Partial<Exception> = {}): Exception => ({
  repository: FACTORY,
  item: 'pnpm-lock.yaml',
  advisory: 'CVE-2099-10001',
  package: 'example-a',
  reason: 'example-a is reached only by the build, which never parses untrusted input.',
  expires: '2026-12-31',
  ...over,
});
/** The policy's own functions over entries of the test's. */
const withEntries = (entries: Exception[]) => ({ ...policy, EXCEPTIONS: entries });

const IMAGE = `ghcr.io/example/app@sha256:${'a'.repeat(64)}`;
const finding = (over: Partial<Finding> = {}): Finding => ({
  item: 'lockfile pnpm-lock.yaml',
  listed: 'pnpm-lock.yaml',
  label: 'pnpm-lock.yaml',
  file: 'pnpm-lock.yaml',
  line: 120,
  type: 'pnpm',
  package: 'example-a',
  installed: '1.0.0',
  fixed: '1.0.1',
  advisory: 'CVE-2099-10001',
  severity: 'HIGH',
  ...over,
});
/** The three results the recorded alerts are of: example-a in the lockfile and in an image, and example-b. */
const A_LOCKFILE = finding();
const B_LOCKFILE = finding({
  package: 'example-b',
  installed: '2.0.0',
  fixed: undefined,
  advisory: 'CVE-2099-10002',
  severity: 'MEDIUM',
  line: 140,
});
const A_IMAGE = finding({
  item: `deploy/app.yaml ghcr.io/example/app`,
  listed: IMAGE,
  label: IMAGE,
  file: 'deploy/app.yaml',
  line: 4,
  type: 'node-pkg',
});

describe('the policy', () => {
  it('is reached only by what checks it out: coverage.ts and graph.ts, which check out the scan folder alone, never import it', () => {
    // Every module a file reaches through its relative imports.
    const reach = (file: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(file)) return seen;
      seen.add(file);
      for (const [, spec] of readFileSync(file, 'utf-8').matchAll(/\bfrom\s+'(\.[^']+)'/g))
        if (spec) reach(resolve(file, '..', spec), seen);
      return seen;
    };
    for (const start of ['coverage.ts', 'graph.ts']) {
      const reached = [...reach(join(ROOT, 'apps/factory/src/vulnerabilities', start))].map((f) =>
        f.slice(ROOT.length + 1),
      );
      expect(
        reached.filter((f) => !f.startsWith('apps/factory/src/vulnerabilities/')),
        start,
      ).toEqual([]);
    }
    expect([...reach(join(ROOT, 'apps/factory/src/vulnerabilities/scan.ts'))]).toContain(
      join(ROOT, 'policy/vulnerabilities.ts'),
    );
  });

  it('imports nothing, so a sparse checkout of it from main is all the scan and the gate read', () => {
    const source = readFileSync(join(ROOT, 'policy/vulnerabilities.ts'), 'utf-8');
    expect(source).not.toMatch(/^\s*import\b|\bimport\s*\(|\brequire\s*\(/m);
  });

  it("holds every entry to its rules: a reason, an expiry within 90 days, a repository of ours, an item on that repository's list, and a CVE or GHSA id", () => {
    // The app's list is read from its checkout beside this one where there is one; the daily scan of the app names an
    // entry whose item is not on its list in any case.
    const app = process.env.APP_DIR ?? resolve(ROOT, '../cv-worlds-worst-website');
    const listOf = (root: string) => inventory(root).items.map((item) => item.name);
    const lists = {
      [FACTORY]: listOf(ROOT),
      [APP]: policy.EXCEPTIONS.some((e) => e.repository === APP) && existsSync(app) ? listOf(app) : undefined,
    };
    expect(problems(policy, REPOSITORIES, lists)).toEqual([]);
  });

  it('fails each kind of entry the rules refuse, and passes an expired one, which is the scan to report', () => {
    const lists = {
      [FACTORY]: ['pnpm-lock.yaml', IMAGE, 'node:24.22.2-alpine3.24@sha256:1', 'node:24.22.2-alpine3.24@sha256:2'],
    };
    const check = (over: Partial<Exception>) => problems(withEntries([entry(over)]), REPOSITORIES, lists, TODAY);
    expect(check({})).toEqual([]);
    expect(check({ expires: '2026-11-01' })).toEqual([]);
    expect(check({ reason: '  ' })).toEqual([expect.stringContaining('gives no reason')]);
    expect(check({ expires: '2027-02-09' })).toEqual([expect.stringContaining('more than 90 days away')]);
    expect(check({ expires: '2026-12-32' })).toEqual([expect.stringContaining('is not a day')]);
    expect(check({ repository: 'someone/else' })).toEqual([expect.stringContaining('is not one of the repositories')]);
    expect(check({ advisory: 'OSV-2026-1' })).toEqual([expect.stringContaining('is not a CVE or GHSA id')]);
    expect(check({ advisory: 'GHSA-2222-3333-4444' })).toEqual([]);
    expect(check({ item: 'apps/x/pnpm-lock.yaml' })).toEqual([
      expect.stringContaining("is not on the-roganator/cv-software-factory's list"),
    ]);
    // An image by its reference, its digest aside; one that names two of the list's items is not one item.
    expect(check({ item: 'ghcr.io/example/app' })).toEqual([]);
    expect(check({ item: 'node:24.22.2-alpine3.24' })).toEqual([expect.stringContaining('names 2 items')]);
    // Two entries for one finding: a renewal that left the old one.
    expect(problems(withEntries([entry(), entry({ expires: '2027-01-31' })]), REPOSITORIES, lists, TODAY)).toEqual([
      expect.stringContaining('it is excepted by 2 entries'),
    ]);
  });

  it('is in force to its expiry and no further than 90 days off', () => {
    expect(policy.lapsed(entry({ expires: TODAY }), TODAY)).toBeUndefined();
    expect(policy.lapsed(entry({ expires: '2027-02-08' }), TODAY)).toBeUndefined();
    expect(policy.lapsed(entry({ expires: '2027-02-09' }), TODAY)).toMatch(/more than 90 days/);
    expect(policy.lapsed(entry({ expires: '2026-11-09' }), TODAY)).toBe('it expired on 2026-11-09');
  });

  it('excepts its item alone: the same package and advisory elsewhere is still a finding', () => {
    const entries = [entry()];
    const at = (over: object) =>
      policy.exceptionFor(
        entries,
        { repository: FACTORY, item: 'pnpm-lock.yaml', package: 'example-a', advisory: 'CVE-2099-10001', ...over },
        TODAY,
      );
    expect(at({})).toBe(entries[0]);
    expect(at({ item: 'apps/x/pnpm-lock.yaml' })).toBeUndefined();
    expect(at({ repository: APP })).toBeUndefined();
    expect(at({ package: 'example-b' })).toBeUndefined();
    expect(at({ advisory: 'CVE-2099-10002' })).toBeUndefined();
    expect(
      policy.exceptionFor(
        [entry({ expires: '2026-11-09' })],
        { repository: FACTORY, item: 'pnpm-lock.yaml', package: 'example-a', advisory: 'CVE-2099-10001' },
        TODAY,
      ),
    ).toBeUndefined();
  });

  it("keeps an image's exception when its tag's digest is refreshed, and not when its tag moves", () => {
    const entries = [entry({ item: 'node:24.22.2-alpine3.24', package: 'openssl' })];
    const at = (item: string) =>
      policy.exceptionFor(
        entries,
        { repository: FACTORY, item, package: 'openssl', advisory: 'CVE-2099-10001' },
        TODAY,
      );
    expect(at(`node:24.22.2-alpine3.24@sha256:${'b'.repeat(64)}`)).toBeDefined();
    expect(at(`node:24.22.3-alpine3.24@sha256:${'b'.repeat(64)}`)).toBeUndefined();
  });

  it('dismisses with the reason and the expiry, within 280 characters', () => {
    expect(policy.dismissal(entry())).toBe(
      'Excepted in policy/vulnerabilities.ts until 2026-12-31: example-a is reached only by the build, which never parses untrusted input.',
    );
    expect(policy.dismissal(entry({ reason: 'x'.repeat(400) }))).toHaveLength(280);
  });
});

describe("the scan's reading of it", () => {
  it('excepts the results an entry in force covers, by their alerts, and names the rest', () => {
    const p = withEntries([
      entry(),
      entry({ advisory: 'CVE-2099-10009', expires: '2026-11-01' }),
      entry({ advisory: 'CVE-2099-10008', item: 'apps/gone/pnpm-lock.yaml' }),
      entry({ advisory: 'CVE-2099-10007' }),
      entry({ repository: APP }),
    ]);
    const toml = osvScannerToml(p, FACTORY, TODAY);
    const out = judge(p, FACTORY, ['pnpm-lock.yaml', IMAGE], [A_LOCKFILE, B_LOCKFILE, A_IMAGE], toml, TODAY);
    expect([...out.excepted]).toEqual([[alertKey(A_LOCKFILE), policy.dismissal(entry())]]);
    expect(out.lines[0]).toBe(
      'Exceptions: 4 for the-roganator/cv-software-factory in policy/vulnerabilities.ts on main, 2 in force, excepting 1 result.',
    );
    expect(out.lines).toContain('  The exception for pnpm-lock.yaml: example-a CVE-2099-10007 met no finding today.');
    expect(out.warnings).toEqual([
      'The exception for pnpm-lock.yaml: example-a CVE-2099-10009 excepts nothing, it expired on 2026-11-01: remove it from policy/vulnerabilities.ts.',
      'The exception for apps/gone/pnpm-lock.yaml: example-a CVE-2099-10008 excepts nothing, its item is not on the list: remove it from policy/vulnerabilities.ts.',
    ]);
    expect(idle(p, APP, ['pnpm-lock.yaml'], TODAY)).toEqual([]);
  });

  it("excepts a result two stages of one Dockerfile share only when an entry covers each stage's image", () => {
    const stage = (tag: string) =>
      finding({
        item: 'apps/x/Dockerfile node',
        listed: `node:${tag}@sha256:${'c'.repeat(64)}`,
        label: `node:${tag}`,
        file: 'apps/x/Dockerfile',
        line: 2,
        type: 'debian',
        package: 'openssl',
      });
    const both = [stage('22'), stage('24')];
    const names = both.map((f) => f.listed ?? '');
    const one = withEntries([entry({ item: 'node:24', package: 'openssl' })]);
    expect(judge(one, FACTORY, names, both, osvScannerToml(one, FACTORY, TODAY), TODAY).excepted.size).toBe(0);
    const each = withEntries([
      entry({ item: 'node:24', package: 'openssl' }),
      entry({ item: 'node:22', package: 'openssl' }),
    ]);
    expect(judge(each, FACTORY, names, both, osvScannerToml(each, FACTORY, TODAY), TODAY).excepted.size).toBe(1);
  });

  it("warns, and fails nothing, when the repository's osv-scanner.toml is not the policy's or is missing", () => {
    const p = withEntries([entry()]);
    expect(judge(p, FACTORY, ['pnpm-lock.yaml'], [], osvScannerToml(p, FACTORY, TODAY), TODAY).warnings).toEqual([]);
    expect(
      judge(p, FACTORY, ['pnpm-lock.yaml'], [], osvScannerToml(withEntries([]), FACTORY, TODAY), TODAY).warnings,
    ).toEqual([expect.stringContaining('osv-scanner.toml differs from the policy')]);
    expect(judge(p, APP, [], [], undefined, TODAY).warnings).toEqual([
      expect.stringContaining('has no osv-scanner.toml'),
    ]);
  });
});

describe('osv-scanner.toml', () => {
  it('gives each advisory excepted in a repository until its earliest expiry, and nothing lapsed or elsewhere', () => {
    const p = withEntries([
      entry({ expires: '2026-12-31' }),
      entry({ item: 'apps/x/pnpm-lock.yaml', expires: '2026-12-01', reason: 'Only "tests" reach it.' }),
      entry({ advisory: 'CVE-2099-10002', expires: '2026-11-01' }),
      entry({ advisory: 'CVE-2099-10003', repository: APP }),
    ]);
    expect(osvScannerToml(p, FACTORY, TODAY).split('\n').slice(3)).toEqual([
      '',
      '[[IgnoredVulns]]',
      'id = "CVE-2099-10001"',
      'ignoreUntil = 2026-12-01T23:59:59Z',
      'reason = "pnpm-lock.yaml (example-a): example-a is reached only by the build, which never parses untrusted input. apps/x/pnpm-lock.yaml (example-a): Only \\"tests\\" reach it."',
      '',
    ]);
  });

  it("is this repository's, beside its lockfile, as the policy gives it", () => {
    expect(readFileSync(join(ROOT, 'osv-scanner.toml'), 'utf-8')).toBe(osvScannerToml(policy, FACTORY));
  });
});

describe('the alerts, on code scanning’s recorded answers', () => {
  const excepted = { [alertKey(A_LOCKFILE)]: policy.dismissal(entry()) };

  it("knows a result's alert by the key the API gives back", () => {
    const [a, b] = recorded('open-1');
    const [image] = recorded('open-2');
    expect(keyOf(a as Alert)).toBe(alertKey(A_LOCKFILE));
    expect(keyOf(b as Alert)).toBe(alertKey(B_LOCKFILE));
    expect(keyOf(image as Alert)).toBe(alertKey(A_IMAGE));
  });

  it("dismisses the excepted one's alert, reopens each of its categories' dismissed with none in force, and leaves others' alone", () => {
    const alerts = [...recorded('open-1'), ...recorded('open-2'), ...recorded('dismissed')];
    expect(changes(alerts, excepted)).toEqual([
      { number: 101, to: 'dismissed', comment: policy.dismissal(entry()) },
      // Dismissed as a false positive by hand: the policy holds no exception for it.
      { number: 201, to: 'open' },
      // Dismissed for the exception, with older words: dismissed again with the policy's. (#205's words, stored with a
      // trailing newline, would count as the same.)
      { number: 202, to: 'open' },
      { number: 202, to: 'dismissed', comment: policy.dismissal(entry()) },
      // A finding no longer reported, dismissed: reopened, as nothing excepts it.
      { number: 203, to: 'open' },
      // The same package and advisory in an image, dismissed with the lockfile's words: the entry is the lockfile's alone.
      { number: 205, to: 'open' },
    ]);
  });

  it('reads every page, the open ones only when something is excepted, and makes each change through the API', async () => {
    const asked: string[] = [];
    const patched: { path: string; body: Record<string, string> }[] = [];
    const base = `/repos/${FACTORY}/code-scanning/alerts?tool_name=Trivy`;
    const pages: Record<string, { body: unknown; next?: string }> = {
      [`${base}&state=open&per_page=100`]: { body: recorded('open-1'), next: 'https://api.github.com/page-2' },
      'https://api.github.com/page-2': { body: recorded('open-2') },
      [`${base}&state=dismissed&per_page=100`]: { body: recorded('dismissed') },
    };
    const api: Api = {
      async get(path) {
        asked.push(path);
        const page = pages[path];
        if (!page) throw new Error(`no recorded answer for ${path}`);
        return page;
      },
      async patch(path, body) {
        patched.push({ path, body });
        return recorded('patched');
      },
    };
    const lines: string[] = [];
    await hold(api, FACTORY, excepted, (line) => lines.push(line));
    expect(asked).toEqual([
      `${base}&state=dismissed&per_page=100`,
      `${base}&state=open&per_page=100`,
      'https://api.github.com/page-2',
    ]);
    expect(patched).toEqual([
      {
        path: `/repos/${FACTORY}/code-scanning/alerts/101`,
        body: { state: 'dismissed', dismissed_reason: WONT_FIX, dismissed_comment: policy.dismissal(entry()) },
      },
      { path: `/repos/${FACTORY}/code-scanning/alerts/201`, body: { state: 'open' } },
      { path: `/repos/${FACTORY}/code-scanning/alerts/202`, body: { state: 'open' } },
      {
        path: `/repos/${FACTORY}/code-scanning/alerts/202`,
        body: { state: 'dismissed', dismissed_reason: WONT_FIX, dismissed_comment: policy.dismissal(entry()) },
      },
      { path: `/repos/${FACTORY}/code-scanning/alerts/203`, body: { state: 'open' } },
      { path: `/repos/${FACTORY}/code-scanning/alerts/205`, body: { state: 'open' } },
    ]);
    expect(lines[0]).toBe(
      'Alerts held to the policy: 1 results excepted, 1 alerts dismissed, 1 dismissed again with a new comment, 3 reopened.',
    );

    asked.length = 0;
    await hold(api, FACTORY, {}, () => {});
    expect(asked).toEqual([`${base}&state=dismissed&per_page=100`]);
  });

  it('stops on an answer that is not a list, having changed nothing', async () => {
    const patched: string[] = [];
    const api: Api = {
      get: async () => ({ body: { message: 'Resource not accessible by integration' } }),
      patch: async (path) => patched.push(path),
    };
    await expect(hold(api, FACTORY, excepted, () => {})).rejects.toThrow(/other than a list/);
    expect(patched).toEqual([]);
  });

  it('takes a comment code scanning stored with whitespace about it as the same comment', () => {
    const stored = recorded('patched') as unknown as Alert;
    const alert = { ...stored, dismissed_comment: ` ${policy.dismissal(entry())}\n` } as Alert;
    expect(changes([alert], excepted)).toEqual([]);
  });
});

describe('the lockfile gate', () => {
  const brought = (over: Partial<GateFinding> = {}): GateFinding => ({
    lockfile: 'pnpm-lock.yaml',
    advisory: 'CVE-2099-10001',
    pkg: 'example-a',
    version: '1.0.0',
    dev: false,
    severity: 'HIGH',
    fixed: '1.0.1',
    title: '',
    ...over,
  });

  it("fails nothing an entry in force excepts for the repository's lockfile, and everything else", () => {
    const entries = [entry(), entry({ advisory: 'CVE-2099-10002', expires: '2026-11-01' })];
    const { excepted, failing } = except(
      [brought(), brought({ lockfile: 'apps/x/pnpm-lock.yaml' }), brought({ advisory: 'CVE-2099-10002' })],
      FACTORY,
      entries,
      TODAY,
    );
    expect(excepted).toEqual([{ ...brought(), expires: '2026-12-31' }]);
    expect(failing).toEqual([brought({ lockfile: 'apps/x/pnpm-lock.yaml' }), brought({ advisory: 'CVE-2099-10002' })]);
    expect(except([brought()], APP, entries, TODAY).failing).toHaveLength(1);
    // The policy's own entries, none today.
    expect(except([brought()], FACTORY).failing).toHaveLength(1);
  });
});
