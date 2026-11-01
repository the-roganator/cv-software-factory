/**
 * The crawler: a sense that follows every link, image, script and stylesheet from the home page, and checks what it
 * finds by the checks any site should pass (`judge.ts`). The runner treats it as it does the probes: a finding
 * becomes a signal only when it has failed twice in a row.
 *
 * A check here is a symptom class on a route, named `<symptom>@<route>`, such as `missing-header@/about`. Every route
 * crawled has one for every class the crawler looks for, so a class that stops being found passes, and its streak
 * ends. The exception is what only a page can show (`OF_A_PAGE` in `judge.ts`): it is checked on the routes where a
 * page was opened, and is trouble on those where a link led to no page, so that a route the crawl could not see
 * into never passes. A class found on every page crawled is one finding on `*` instead of one on each route.
 *
 * Every request the crawl makes, from the browser and without it, carries `UNMEASURED`: a crawl is not a visit, and
 * must not weigh on the figures a canary or its baseline is judged on. The one exception is a second ask for each
 * static asset, without it, whose caching is judged as a visitor's browser would read it (`crawl.ts`): the app answers
 * every marked request `private, no-store`. Those few requests are counted as a visitor's.
 */
import { cutAt, type Evidence, type SymptomClass } from '@software-factory/events';
import type { ArtifactStore } from '@software-factory/store';
import type { Browser } from 'playwright';
import { capture } from '../capture.ts';
import { SharedBrowser } from '../senses/browser.ts';
import { UNMEASURED } from '../senses/http.ts';
import { templater } from '../senses/routes.ts';
import type { Observation, Sense } from '../senses/types.ts';
import { crawl, PAGE_TIMEOUT } from './crawl.ts';
import { askForErrors, type Issue, judge, OF_A_PAGE, RECORDED } from './judge.ts';

/** Every class the crawler can find. */
export const CLASSES = [
  'broken-link',
  'broken-image',
  'redirect-loop',
  'server-error',
  'browser-error',
  'missing-alt',
  'low-contrast',
  'unlabelled-field',
  'missing-header',
  'not-cached',
  'slow-response',
  'leaks-detail',
] as const satisfies readonly SymptomClass[];

/** Fewest pages that can be said to have a class on every one of them. */
const EVERY_PAGE_NEEDS = 3;

export interface CrawlerOptions {
  app: string;
  store: ArtifactStore;
  log: { warn(fields: object, message: string): void };
  launch?: () => Promise<Browser>;
  /** The most resources a crawl asks for. */
  limit?: number;
  /** An answer slower than this, in milliseconds, is slow (`SLOW` in `judge.ts` by default). */
  slow?: number;
  /** How long a page may take to open in the browser, in milliseconds (`PAGE_TIMEOUT` in `crawl.ts` by default). */
  pageTimeout?: number;
}

export class Crawler implements Sense {
  readonly name = 'crawler';
  private readonly options: CrawlerOptions;
  private readonly browser: SharedBrowser;

  constructor(options: CrawlerOptions) {
    this.options = options;
    this.browser = new SharedBrowser(options.launch);
  }

  async pass(version: string): Promise<Observation[]> {
    const { app, log } = this.options;
    const browser = await this.browser.ready();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'en-GB',
      extraHTTPHeaders: UNMEASURED,
    });
    try {
      const reached = await crawl({
        app,
        context,
        record: RECORDED,
        ...(this.options.limit && { limit: this.options.limit }),
        ...(this.options.pageTimeout && { pageTimeout: this.options.pageTimeout }),
        headers: UNMEASURED,
      });
      if (reached.capped) log.warn({ resources: reached.resources.length }, 'the crawl stopped at its cap');
      const template = templater([...reached.resources.map((r) => r.path)]);
      const { issues, trouble } = judge({
        crawl: reached,
        errors: await askForErrors(app, UNMEASURED),
        secure: new URL(app).protocol === 'https:',
        version,
        template,
        ...(this.options.slow && { slow: this.options.slow }),
      });
      const pages = reached.pages.map((p) => p.path);
      const { findings, every } = collapse(issues, pages);
      const routes = new Set([
        ...reached.resources.map((r) => template(r.path)),
        ...findings.map((f) => f.route),
        ...trouble.map((t) => t.route),
      ]);
      routes.delete('*');
      const pageRoutes = new Set(reached.pages.map((p) => template(p.path)));

      const observations: Observation[] = [];
      for (const symptom of CLASSES) {
        // On every route, so that a class that is no longer found passes. Not on the pages where it is `*`, which is one
        // finding, but still where it was found beyond them (a slow asset is not a page).
        const wide = every.has(symptom);
        const ofAPage = OF_A_PAGE.includes(symptom);
        for (const route of [...routes, '*']) {
          const found = findings.find((f) => f.symptom === symptom && f.route === route);
          if (wide && route !== '*' && pageRoutes.has(route) && !found) continue;
          // What could not be told is neither a pass nor a failure, so it does not end a streak.
          const unknown = found
            ? undefined
            : trouble.find((t) => t.route === route && (!t.symptoms || t.symptoms.includes(symptom)));
          // Where no page was opened and none was missed, what a page shows is not a question.
          if (ofAPage && route !== '*' && !pageRoutes.has(route) && !found && !unknown) continue;
          observations.push({
            check: cutAt(`${symptom}@${route}`, 80),
            route,
            finding: found ?? null,
            ...(found ? await this.keep(context, found, version, template) : { artifacts: [] }),
            ...(unknown && { trouble: unknown.message }),
          });
        }
      }
      return observations;
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  /** A screenshot of the page the finding was seen on, with the boxes it asked for. */
  private async keep(
    context: Awaited<ReturnType<Browser['newContext']>>,
    found: Issue,
    version: string,
    template: (path: string) => string,
  ): Promise<Pick<Observation, 'artifacts' | 'look'>> {
    const { app, store, log } = this.options;
    const page = await context.newPage();
    page.setDefaultTimeout(2_000);
    try {
      await page.goto(new URL(found.at, app).href, {
        waitUntil: 'load',
        timeout: this.options.pageTimeout ?? PAGE_TIMEOUT,
      });
      const route = template(found.at);
      const elements = (found.look ?? []).slice(0, 4);
      for (const box of elements)
        await page
          .locator(box.selector)
          .first()
          .scrollIntoViewIfNeeded()
          .catch(() => {});
      const shot = await capture(page, store, { route, version, checks: elements }).catch(() =>
        capture(page, store, { route, version }),
      );
      return { artifacts: [shot], ...(shot.boxes.length && { look: { path: found.at, elements } }) };
    } catch (error) {
      log.warn({ err: String(error).split('\n')[0], route: found.route }, 'no screenshot of a finding');
      return { artifacts: [] };
    } finally {
      await page.close().catch(() => {});
    }
  }
}

/**
 * Folds issues into findings, one for each class on each route, and says which classes are found on every page
 * crawled: those become one finding on `*`, and the pages' own are dropped.
 */
function collapse(issues: Issue[], pages: string[]) {
  const every = new Set<SymptomClass>();
  if (pages.length >= EVERY_PAGE_NEEDS) {
    for (const symptom of CLASSES) {
      const onPages = new Set(issues.filter((i) => i.scope === 'page' && i.symptom === symptom).map((i) => i.at));
      if (pages.every((page) => onPages.has(page))) every.add(symptom);
    }
  }
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const wide = every.has(issue.symptom) && issue.scope === 'page';
    const key = `${issue.symptom}\n${wide ? '*' : issue.route}`;
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  const findings: Issue[] = [];
  for (const [key, group] of groups) {
    const [first] = group as [Issue];
    const route = key.split('\n')[1] as string;
    const evidence: Evidence[] = group.flatMap((i) => i.evidence).slice(0, 3);
    const more = group.length - 1;
    const message =
      route === '*'
        ? `Every page crawled (${pages.length}) has this: ${first.message}`
        : `${first.message}${more ? ` (and ${more} more like it on this route)` : ''}`;
    findings.push({ ...first, route, message, evidence });
  }
  return { findings, every };
}
