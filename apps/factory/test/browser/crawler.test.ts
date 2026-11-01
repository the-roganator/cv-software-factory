/**
 * The crawler against a small site made for the test (crawl-site.ts): once on a site that is right, where nothing
 * is found, and once for each fault, where the crawler finds it on the route and in the class a fair observer would
 * name. A class found on every page is one finding on `*`. These tests need Chromium, so they run in the pinned
 * Playwright image.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSignal } from '@software-factory/events/schemas';
import { DiskArtifacts } from '@software-factory/store';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLASSES, Crawler } from '../../src/crawler/index.ts';
import { OF_A_PAGE } from '../../src/crawler/judge.ts';
import { compareJourneys, type Seen } from '../../src/gates/journeys.ts';
import type { Observation } from '../../src/senses/types.ts';
import { type Fault, SLOW_ANSWER, startSite } from './crawl-site.ts';

let browser: Browser;
const store = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'crawler-artifacts-')));
const log = { warn: () => {} };
/**
 * Shorter than a real site's, so that the slow and hanging faults do not take long: an answer is slow after 500 ms,
 * under the test site's slow answers and far over its others. A page has 5 s to open, room for one whose every
 * request is slow (its HTML, then its script, stylesheet and image) and less than the usual 10 s for one that hangs.
 */
const timing = { slow: SLOW_ANSWER - 200, pageTimeout: 5_000 };

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser?.close());

async function crawl(...faults: Fault[]): Promise<Observation[]> {
  const site = await startSite(...faults);
  try {
    return await new Crawler({ app: site.url, store, log, launch: async () => browser, ...timing }).pass(
      'c'.repeat(40),
    );
  } finally {
    await site.close();
  }
}

const found = (observations: Observation[]) => observations.filter((o) => o.finding).map((o) => o.check);
/** What was reported as trouble on a route. */
const troubleOn = (observations: Observation[], route: string) =>
  observations.filter((o) => o.route === route && o.trouble);

describe('on a site that is right', () => {
  it('finds nothing, and has a check for every class on every route it crawled', async () => {
    const observations = await crawl();
    expect(found(observations)).toEqual([]);
    const checks = observations.map((o) => o.check);
    expect(checks).toContain('missing-header@/items/:item');
    expect(checks).toContain('not-cached@/static/:file');
    expect(checks).toContain('missing-header@*');
  }, 120_000);
});

/** [a fault of the site, the one check that finds it, what the crawler calls it]. */
const CASES: Array<[Fault, string, string]> = [
  ['dead-link', 'broken-link@/', 'broken-link'],
  ['dead-image', 'broken-image@/', 'broken-image'],
  ['not-an-image', 'broken-image@/', 'broken-image'],
  ['loop', 'redirect-loop@/loop', 'redirect-loop'],
  ['error-500', 'server-error@/items/:item', 'server-error'],
  ['console-home', 'browser-error@/', 'browser-error'],
  ['no-alt-about', 'missing-alt@/about', 'missing-alt'],
  ['contrast-about', 'low-contrast@/about', 'low-contrast'],
  ['unlabelled', 'unlabelled-field@/about', 'unlabelled-field'],
  ['no-headers-home', 'missing-header@/', 'missing-header'],
  ['no-cache', 'not-cached@/static/:file', 'not-cached'],
  ['slow-about', 'slow-response@/about', 'slow-response'],
  ['leaky-missing', 'leaks-detail@/:missing', 'leaks-detail'],
  ['leaky-malformed', 'leaks-detail@/:malformed', 'leaks-detail'],
  ['powered-by', 'leaks-detail@/:missing', 'leaks-detail'],
  // A class found on every page crawled is one finding for every route.
  ['console-all', 'browser-error@*', 'browser-error'],
  ['no-alt-all', 'missing-alt@*', 'missing-alt'],
  ['contrast-all', 'low-contrast@*', 'low-contrast'],
  ['no-headers-all', 'missing-header@*', 'missing-header'],
];

describe('a class found on every page', () => {
  it('is one finding for the pages, and still found on the assets that had it too', async () => {
    const observations = await crawl('slow-all');
    expect(found(observations).sort()).toEqual(['slow-response@*', 'slow-response@/static/:file']);
  }, 120_000);
});

describe('what the crawl could not tell', () => {
  it('is trouble, not a pass, when a page that answered will not open in the browser, and the crawl goes on', async () => {
    const observations = await crawl('page-hangs');
    const trouble = troubleOn(observations, '/hangs');
    expect(trouble.map((o) => o.check).sort()).toEqual(
      [
        'broken-image',
        'broken-link',
        'browser-error',
        'low-contrast',
        'missing-alt',
        'missing-header',
        'unlabelled-field',
      ]
        .map((c) => `${c}@/hangs`)
        .sort(),
    );
    expect(trouble[0]?.trouble).toContain('/hangs');
    expect(found(observations)).toEqual([]);
    // The rest of the site was still looked at.
    expect(observations.map((o) => o.check)).toContain('missing-header@/items/:item');
  }, 60_000);

  it('is trouble, not a pass, for caching, when an asset asked for as a visitor asks gets no answer to judge', async () => {
    const observations = await crawl('visitor-unanswered');
    expect(troubleOn(observations, '/static/:file').map((o) => o.check)).toEqual(['not-cached@/static/:file']);
    expect(troubleOn(observations, '/static/:file')[0]?.trouble).toMatch(/answered 503 when asked for as a visitor/);
    expect(found(observations)).toEqual([]);
  }, 60_000);

  it('is trouble, not a pass, when a link gets no answer', async () => {
    const observations = await crawl('no-answer');
    expect(troubleOn(observations, '/reset')).toHaveLength(CLASSES.length);
    expect(troubleOn(observations, '/').map((o) => o.check)).toEqual(['broken-link@/']);
    expect(found(observations)).toEqual([]);
  }, 60_000);
});

describe('a page reached through a redirect', () => {
  it('is judged where it landed, and the address that redirected has no page checks', async () => {
    const observations = await crawl('moved', 'no-alt-about');
    expect(found(observations)).toEqual(['missing-alt@/about']);
    const moved = observations.filter((o) => o.route === '/old-about');
    expect(moved.map((o) => o.check)).toContain('redirect-loop@/old-about');
    expect(moved.filter((o) => OF_A_PAGE.some((c) => o.check === `${c}@/old-about`))).toEqual([]);
    expect(moved.filter((o) => o.trouble)).toEqual([]);
  }, 60_000);

  it('is trouble, not a pass, for what a page shows, where a loop means no page was opened', async () => {
    const observations = await crawl('department-loops');
    expect(found(observations).sort()).toEqual(['missing-alt@/products', 'redirect-loop@/departments/home']);
    const trouble = troubleOn(observations, '/departments/home');
    expect(trouble.map((o) => o.check).sort()).toEqual(OF_A_PAGE.map((c) => `${c}@/departments/home`).sort());
    expect(trouble[0]?.trouble).toMatch(/^No page was opened at \/departments\/home/);
  }, 60_000);

  it('compares in the journeys gate as the app as it was, when a loop becomes a redirect to a failing page', async () => {
    const sites: Record<string, Fault> = { base: 'department-loops', change: 'department-moves' };
    // As `factory gate journeys` reads an observation.
    const observe = async (app: string): Promise<Seen[]> =>
      (await crawl(sites[app] as Fault)).map((o) => ({
        sense: 'crawler',
        check: o.check,
        route: o.route,
        failed: o.finding !== null && !o.trouble,
        ...(o.trouble ? { trouble: o.trouble } : {}),
      }));
    const c = await compareJourneys(observe, 'base', 'change');
    expect(c.regressions).toEqual([]);
    expect(c.unchanged.map((s) => s.check)).toEqual(['missing-alt@/products']);
    expect(c.fixed.map((s) => s.check)).toEqual(['redirect-loop@/departments/home']);
  }, 120_000);
});

describe.each(CASES)('%s', (fault, check, symptom) => {
  it(`is found as ${check}`, async () => {
    const observations = await crawl(fault);
    expect(found(observations)).toEqual([check]);
    const observation = observations.find((o) => o.check === check) as Observation;
    expect(observation.finding?.symptom).toBe(symptom);
    expect(observation.finding?.message).not.toBe('');
    // Its proof: a screenshot with at most four boxes, and a signal the inbox takes.
    const screenshot = observation.artifacts.find((a) => a.kind === 'screenshot');
    expect(screenshot?.kind === 'screenshot' && screenshot.boxes.length <= 4).toBe(true);
    expect(
      validateSignal({
        sense: 'crawler',
        check,
        route: observation.route,
        version: 'c'.repeat(40),
        symptom,
        summary: observation.finding?.message.slice(0, 200),
        evidence: observation.finding?.evidence,
        observedAt: new Date().toISOString(),
        artifacts: observation.artifacts,
      }),
    ).toEqual({ ok: true });
  }, 60_000);
});

describe('what the evidence holds', () => {
  it('has the HTTP exchange for a server error, with the headers looked at', async () => {
    const observations = await crawl('error-500');
    const { evidence } = observations.find((o) => o.check === 'server-error@/items/:item')?.finding ?? {};
    expect(evidence?.[0]).toMatchObject({ kind: 'http', status: 500, url: '/items/b' });
  }, 60_000);

  it('has the answer a visitor got for an asset not cached, not the crawl’s marked one', async () => {
    const observations = await crawl('no-cache');
    const finding = observations.find((o) => o.check === 'not-cached@/static/:file')?.finding;
    expect(finding?.evidence?.[0]).toMatchObject({
      kind: 'http',
      status: 200,
      headers: { 'cache-control': 'no-cache' },
    });
    expect(finding?.message).toContain('"no-cache"');
  }, 60_000);

  it('has the elements of an accessibility finding, with their boxes where they are in view', async () => {
    const observations = await crawl('no-alt-all');
    const finding = observations.find((o) => o.check === 'missing-alt@*')?.finding;
    expect(finding?.evidence?.[0]).toMatchObject({ kind: 'accessibility', findings: [{ rule: 'image-alt' }] });
    const screenshot = observations
      .find((o) => o.check === 'missing-alt@*')
      ?.artifacts.find((a) => a.kind === 'screenshot');
    expect(screenshot?.kind === 'screenshot' && screenshot.boxes.length).toBeGreaterThan(0);
  }, 60_000);

  it('has the console messages of a browser error', async () => {
    const observations = await crawl('console-home');
    const finding = observations.find((o) => o.check === 'browser-error@/')?.finding;
    expect(finding?.evidence?.[0]).toMatchObject({ kind: 'console', messages: [{ level: 'error' }] });
  }, 60_000);
});
