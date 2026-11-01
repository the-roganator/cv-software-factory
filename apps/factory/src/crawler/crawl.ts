/**
 * Crawling: from the home page, every page and asset it leads to on the same origin: links, images, scripts,
 * stylesheets and icons. Each is asked for over HTTP, so that its status, headers and time are what any client
 * would see. Each HTML page that answers is then opened in a browser, which says what its console said, what links
 * it holds once its scripts have run, and what axe finds wrong with it. A link that redirects is not opened: where
 * it lands is crawled as a link of its own, from the same page, so a page is always browsed at its own address.
 * This module gathers; judging is in `judge.ts`.
 *
 * Every request carries the headers the crawl is given (the mark, `UNMEASURED`), but one: each static asset that
 * answered is asked for once more without the mark, as a visitor's browser asks, because the app answers every marked
 * request `private, no-store` by its own rule, and only a visitor's answer says whether the asset may be kept.
 */

import { AxeBuilder } from '@axe-core/playwright';
import { cutAt, cutTo, type SymptomClass } from '@software-factory/events';
import type { BrowserContext, Page } from 'playwright';
import { aboutTheConnection } from '../senses/browser.ts';
import { type Exchange, exchange, pathOf, type RequestHeaders, UNMEASURED } from '../senses/http.ts';

/** How a resource was reached: a link to follow, an image on a page, or a script, stylesheet or icon. */
export type Kind = 'link' | 'image' | 'asset';

export interface Resource {
  /** The path and query asked for. */
  path: string;
  kind: Kind;
  /** The page that first led to it. The home page leads to itself. */
  from: string;
  answer: Exchange;
  /**
   * For each resource whose caching is judged (`cachingJudged`): the answer a visitor gets, which is the same
   * request again without the mark when the crawl sends it, and `answer` itself when it does not.
   */
  visitor?: Exchange;
}

const STATIC = /\.(?:js|mjs|css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf)$/i;

/**
 * Whether a resource's caching is judged: a static asset (a script, stylesheet, icon or image, or a link to such a
 * file) that answered 200 and is not a page. The one rule, which the crawl asks again by and the judge judges by.
 */
export const cachingJudged = ({ kind, path, answer }: Resource, pages: ReadonlySet<string>): boolean =>
  answer.status === 200 && !pages.has(path) && (kind !== 'link' || STATIC.test(path.split('?')[0] ?? ''));

/** The headers a visitor sends of those the crawl sends: all but the mark. */
const unmarked = (headers: RequestHeaders): RequestHeaders | undefined => {
  const rest = Object.fromEntries(Object.entries(headers).filter(([name]) => !(name.toLowerCase() in UNMEASURED)));
  return Object.keys(rest).length ? rest : undefined;
};

export interface AccessibilityIssue {
  rule: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  help: string;
  symptom: Extract<SymptomClass, 'missing-alt' | 'low-contrast' | 'unlabelled-field'>;
  /** Where on the page, when the element is in view: in CSS pixels from its top left. */
  elements: Array<{ selector: string; box?: { x: number; y: number; width: number; height: number } }>;
}

/** What opening a page in a browser showed. */
export interface Browsed {
  /** The page's own address: a page is opened only where no redirect leads on from. */
  path: string;
  console: Array<{ text: string; source?: string }>;
  accessibility: AccessibilityIssue[];
}

/** A page that answered, and could not then be opened in a browser: it timed out, navigated away, or axe failed on it. */
export interface Unbrowsed {
  path: string;
  /** What went wrong, in a line. */
  message: string;
}

export interface Crawl {
  resources: Resource[];
  pages: Browsed[];
  /** The pages that answered but could not be browsed, which are neither found fine nor found at fault. */
  unbrowsed: Unbrowsed[];
  /** Set when the crawl stopped at its cap, so what it did not reach is unknown. */
  capped: boolean;
}

export interface CrawlOptions {
  app: string;
  context: BrowserContext;
  /** The most resources asked for. */
  limit?: number;
  /** Headers to keep in each exchange's evidence besides the usual. */
  record: readonly string[];
  /** How long a page may take to open in the browser, in milliseconds. */
  pageTimeout?: number;
  /** Sent with each exchange besides the usual, as the context sends them with the pages' requests. */
  headers?: RequestHeaders | undefined;
}

/** Axe rules that name a class of defect, and the class. Rules that fit no class are left out, not forced. */
const RULES: Record<string, AccessibilityIssue['symptom']> = {
  'image-alt': 'missing-alt',
  'input-image-alt': 'missing-alt',
  'area-alt': 'missing-alt',
  'role-img-alt': 'missing-alt',
  'svg-img-alt': 'missing-alt',
  'color-contrast': 'low-contrast',
  label: 'unlabelled-field',
  'select-name': 'unlabelled-field',
  'aria-input-field-name': 'unlabelled-field',
};

/** How long a page may take to open in the browser, in milliseconds, unless the crawl says otherwise. */
export const PAGE_TIMEOUT = 10_000;

/** What the page holds, once its scripts have run: where it leads. Runs in the browser, so it is a string. */
const REFERENCES = `(() => {
  const all = (selector, attribute) => [...document.querySelectorAll(selector)].map((e) => e[attribute]).filter(Boolean);
  return {
    links: all('a[href]', 'href'),
    images: all('img[src]', 'currentSrc').concat(all('img[src]', 'src')),
    assets: all('script[src]', 'src').concat(all('link[rel~="stylesheet"][href]', 'href'), all('link[rel~="icon"][href]', 'href')),
  };
})()`;

export async function crawl({
  app,
  context,
  limit = 150,
  record,
  pageTimeout = PAGE_TIMEOUT,
  headers,
}: CrawlOptions): Promise<Crawl> {
  const origin = new URL(app).origin;
  const result: Crawl = { resources: [], pages: [], unbrowsed: [], capped: false };
  const queued = new Map<string, { kind: Kind; from: string }>([['/', { kind: 'link', from: '/' }]]);
  const todo = ['/'];

  const enqueue = (urls: string[], kind: Kind, from: string) => {
    for (const href of urls) {
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        continue;
      }
      if (url.origin !== origin) continue;
      const path = pathOf(url);
      if (!queued.has(path)) {
        queued.set(path, { kind, from });
        todo.push(path);
      }
    }
  };

  for (let next = todo.shift(); next !== undefined; next = todo.shift()) {
    if (result.resources.length >= limit) {
      result.capped = true;
      break;
    }
    const { kind, from } = queued.get(next) as { kind: Kind; from: string };
    const answer = await exchange(app, next, { record, headers });
    result.resources.push({ path: next, kind, from, answer });
    if (kind !== 'link' || answer.status !== 200 || answer.type !== 'text/html') continue;
    // A link that redirects leads to a page with an address of its own, and the page is crawled there, so that what
    // is wrong with it is named by where it is and not by every address that leads to it.
    if (answer.landed !== next) {
      enqueue([new URL(answer.landed, app).href], 'link', from);
      continue;
    }
    // One page that will not open must not end the crawl: it is kept as a resource, and reported as trouble.
    const browsed = await browse(context, new URL(next, app).href, next, pageTimeout).catch((error: unknown) => {
      result.unbrowsed.push({
        path: next,
        message: (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '',
      });
      return null;
    });
    if (!browsed) continue;
    result.pages.push(browsed.page);
    enqueue(browsed.references.links, 'link', next);
    enqueue(browsed.references.images, 'image', next);
    enqueue(browsed.references.assets, 'asset', next);
  }
  const pages = new Set(result.pages.map((page) => page.path));
  const marked = headers !== undefined && Object.keys(headers).some((name) => name.toLowerCase() in UNMEASURED);
  for (const resource of result.resources) {
    if (!cachingJudged(resource, pages)) continue;
    resource.visitor = marked
      ? await exchange(app, resource.path, { record, headers: unmarked(headers) })
      : resource.answer;
  }
  return result;
}

async function browse(context: BrowserContext, url: string, path: string, timeout: number) {
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  const messages: Browsed['console'] = [];
  page.on('console', (message) => {
    // The browser also reports each failed request here; the crawl asks for those itself, and says more of them.
    if (message.type() !== 'error' || message.text().startsWith('Failed to load resource')) return;
    if (aboutTheConnection(message.text())) return;
    const { url: source, lineNumber } = message.location();
    messages.push({
      text: cutTo(message.text().trim(), 300),
      ...(source && { source: cutAt(`${pathOf(source).split('?')[0]}:${lineNumber}`, 300) }),
    });
  });
  page.on('pageerror', (error) => messages.push({ text: cutTo(`Uncaught ${error.message}`, 300) }));
  try {
    await page.goto(url, { waitUntil: 'load' });
    const references = (await page.evaluate(REFERENCES)) as { links: string[]; images: string[]; assets: string[] };
    return { page: { path, console: messages, accessibility: await accessibility(page) }, references };
  } finally {
    await page.close().catch(() => {});
  }
}

async function accessibility(page: Page): Promise<AccessibilityIssue[]> {
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const { violations } = await new AxeBuilder({ page }).analyze();
  const issues: AccessibilityIssue[] = [];
  for (const violation of violations) {
    const symptom = RULES[violation.id];
    if (!symptom) continue;
    const elements: AccessibilityIssue['elements'] = [];
    for (const node of violation.nodes.slice(0, 10)) {
      const selector = cutAt(String(Array.isArray(node.target[0]) ? node.target[0].at(-1) : node.target[0]), 300);
      const found = await page
        .locator(selector)
        .first()
        .boundingBox({ timeout: 1_000 })
        .catch(() => null);
      const x = found ? Math.max(0, Math.round(found.x)) : 0;
      const y = found ? Math.max(0, Math.round(found.y)) : 0;
      const width = found ? Math.round(Math.min(found.x + found.width, viewport.width) - x) : 0;
      const height = found ? Math.round(Math.min(found.y + found.height, viewport.height) - y) : 0;
      elements.push({ selector, ...(width > 0 && height > 0 && { box: { x, y, width, height } }) });
    }
    if (!elements.length) continue;
    issues.push({
      rule: violation.id,
      impact: violation.impact ?? 'minor',
      help: cutTo(violation.help, 200),
      symptom,
      elements,
    });
  }
  return issues;
}
