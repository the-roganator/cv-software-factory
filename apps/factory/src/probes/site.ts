/**
 * What the probes know about a shop in general, from outside: how to read a page of products, follow a pager, use a
 * search box and a form, and what the shop's own API says. Nothing here knows about one shop's wording or products.
 * Reading a page runs scripts in the browser, which are strings because this package is type-checked for Node.
 */
import type { DefectSymptom, Evidence } from '@software-factory/events';
import type { Page, Response } from 'playwright';
import type { CheckContext } from '../senses/browser.ts';
import { type Exchange, evidenceOf, exchange, pathOf, type RequestHeaders } from '../senses/http.ts';
import { type Finding, Found } from '../senses/types.ts';

/** A product as the shop's own API says it is: what the pages are compared against. */
export interface Product {
  slug: string;
  name: string;
  department: string;
  /** The price as the API formats it, such as £1.25. */
  price: string;
  pricePence: number;
}

/** What the probes share in one pass: the app's API, asked for once however many checks use it. */
export class Shop {
  readonly app: string;
  private readonly headers: RequestHeaders | undefined;
  private products_: Promise<Product[]> | undefined;

  /** `headers` go with each request to the API besides the usual. */
  constructor(app: string, headers?: RequestHeaders) {
    this.app = app;
    this.headers = headers;
  }

  /** Every product the API lists, whichever page of its listing each is on, each once. */
  products(): Promise<Product[]> {
    this.products_ ??= this.listProducts();
    return this.products_;
  }

  private async listProducts(): Promise<Product[]> {
    const bySlug = new Map<string, Product>();
    let pages = 1;
    for (let page = 1; page <= pages && page <= 100; page++) {
      const answer = await exchange(this.app, `/api/products?page=${page}`, { headers: this.headers });
      if (answer.status !== 200) throw new Error(`The shop's API did not list its products: ${describe(answer)}`);
      let body: unknown;
      try {
        body = JSON.parse(answer.body);
      } catch {
        throw new Error(`The shop's API did not answer in JSON: ${describe(answer)}`);
      }
      const { products, pages: count } = body as { products?: unknown; pages?: unknown };
      if (!Array.isArray(products) || typeof count !== 'number') {
        throw new Error("The shop's API listed its products in a shape the probes do not know");
      }
      pages = count;
      for (const item of products) {
        const p = item as Partial<Record<keyof Product, unknown>>;
        if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.price !== 'string') {
          throw new Error("The shop's API gave a product in a shape the probes do not know");
        }
        bySlug.set(p.slug, {
          slug: p.slug,
          name: p.name,
          price: p.price,
          department: typeof p.department === 'string' ? p.department : '',
          pricePence: typeof p.pricePence === 'number' ? p.pricePence : Number.NaN,
        });
      }
    }
    return [...bySlug.values()];
  }
}

const describe = (answer: Exchange) =>
  `status ${answer.status ?? 'none'}${answer.failure ? ` (${answer.failure})` : ''}`;

export type Context = CheckContext<Shop>;

/** A finding, with the evidence and boxes a check usually has. */
export const fail = (
  symptom: DefectSymptom,
  message: string,
  more: Omit<Finding, 'symptom' | 'message'> = {},
): Finding => ({
  symptom,
  message,
  ...more,
});

/** What a fair observer calls a response that is not a page: a link that leads nowhere, or a server that fell over. */
export function badStatus(status: number | null, what: string, evidence: Evidence[]): Finding | null {
  if (status === null || status < 400) return null;
  return status >= 500
    ? fail('server-error', `${what} answered ${status}.`, { evidence })
    : fail('broken-link', `${what} answered ${status}, so it leads nowhere.`, { evidence });
}

/** Opens a path of the app, and says what it answered. */
export async function visit(context: Context, path: string): Promise<{ status: number; evidence: Evidence[] }> {
  const url = new URL(path, context.app).href;
  const response = await context.page.goto(url, { waitUntil: 'load' }).catch(async (error: Error) => {
    if (!error.message.includes('ERR_TOO_MANY_REDIRECTS')) throw error;
    const { evidence } = await exchange(context.app, path, { headers: context.headers });
    throw new Found(fail('redirect-loop', `${path} redirects round in a circle.`, { evidence: [evidence] }));
  });
  if (!response) throw new Error(`${path} gave no response`);
  return { status: response.status(), evidence: [await evidenceOf(response)] };
}

/** Clicks something that navigates, and says what the app answered. */
export async function follow(
  page: Page,
  click: () => Promise<void>,
): Promise<{ status: number; evidence: Evidence[] }> {
  const answered = page.waitForResponse(
    (r: Response) => r.request().isNavigationRequest() && r.frame() === page.mainFrame(),
  );
  await click();
  const response = await answered;
  await page.waitForLoadState('load');
  return { status: response.status(), evidence: [await evidenceOf(response)] };
}

/** One product as a page lists it: a link to its page, and the first price near it. */
export interface Card {
  slug: string;
  name: string;
  price: string | null;
}

/**
 * An amount of money in pounds as a page shows it, which may have text right up against it with no space (a price
 * and a label that follow each other, a comma, a unit), so it is the amount and nothing after. A negative amount is
 * still an amount, whether it is written £-6.00 or -£6.00.
 */
const PRICE = /-?£-?\d[\d,]*(?:\.\d{2})?/;

/** A price written -£6.00 as £-6.00, which is how the shop's own API formats it. */
const normalPrice = (price: string): string => (price.startsWith('-£') ? `£-${price.slice(2)}` : price);

const READ_CARDS = `(() => {
  const scope = document.querySelector('main') ?? document.body;
  const cards = [];
  const seen = new Set();
  for (const link of scope.querySelectorAll('a[href]')) {
    const url = new URL(link.href);
    const match = url.origin === location.origin && url.pathname.match(/^\\/products\\/([^/]+)$/);
    const name = link.textContent.trim().replace(/\\s+/g, ' ');
    if (!match || !name) continue;
    const card = link.closest('li, article') ?? link.parentElement;
    if (seen.has(card)) continue;
    seen.add(card);
    const price = card.textContent.match(new RegExp(${JSON.stringify(PRICE.source)}));
    cards.push({ slug: decodeURIComponent(match[1]), name, price: price ? price[0] : null });
  }
  return cards;
})()`;

/** The products a page lists, in the order it lists them, with any that it lists twice listed twice. */
export const readCards = async (page: Page): Promise<Card[]> =>
  ((await page.evaluate(READ_CARDS)) as Card[]).map((card) => ({
    ...card,
    price: card.price && normalPrice(card.price),
  }));

/** The selector for a page's cards, for boxing them in a screenshot. */
export const CARDS = 'main li:has(a[href^="/products/"])';

const READ_LINKS = (scope: string) => `(() => {
  const links = [];
  for (const link of document.querySelectorAll(${JSON.stringify(scope)})) {
    const url = new URL(link.href);
    if (url.origin !== location.origin) continue;
    links.push({ path: url.pathname + url.search, text: link.textContent.trim().replace(/\\s+/g, ' ') });
  }
  return links;
})()`;

/** The links on the page, to the same site, as paths with their query but no fragment. */
export const readLinks = (page: Page, selector = 'a[href]'): Promise<Array<{ path: string; text: string }>> =>
  page.evaluate(READ_LINKS(selector)) as Promise<Array<{ path: string; text: string }>>;

/** The path of the page's link to its next page, if it has one. */
export async function nextPath(page: Page): Promise<string | null> {
  const [next] = await readLinks(page, 'a[rel~="next"]');
  return next?.path ?? null;
}

export interface Walked {
  cards: Card[];
  pages: number;
  /** Set when a page along the way answered with something other than a page. */
  failed?: { path: string; status: number; evidence: Evidence[] };
}

/**
 * Reads the products on the page the browser is on, then those on each next page, as a shopper pages through.
 * Stops at the last page, or when a page repeats, so a pager that loops cannot trap the probe.
 */
export async function pageThrough(context: Context, limit = 50): Promise<Walked> {
  const { page } = context;
  const walked: Walked = { cards: [], pages: 0 };
  const opened = new Set<string>();
  for (;;) {
    const here = pathOf(page.url());
    if (opened.has(here) || opened.size >= limit) return walked;
    opened.add(here);
    walked.pages++;
    walked.cards.push(...(await readCards(page)));
    const next = await nextPath(page);
    if (!next) return walked;
    const { status, evidence } = await visit(context, next);
    if (status >= 400) return { ...walked, failed: { path: next, status, evidence } };
  }
}

/**
 * What a fair observer says of a walk that met a page that was not a page: the finding for that page's own path, so
 * that a server that fell over is not reported as products missing. `what` is whose pages these are, such as "the
 * catalogue".
 */
export function walkFailure(walked: Walked, what: string): Finding | null {
  if (!walked.failed) return null;
  const { path, status, evidence } = walked.failed;
  return (
    badStatus(status, `The next page ${path} of ${what}`, evidence) ??
    fail('wrong-result', `The next page ${path} of ${what} could not be opened.`, { evidence })
  );
}

/** A list of names for a message: a few, then how many more. */
export function listed(names: string[], most = 4): string {
  const shown = names.slice(0, most).join(', ');
  return names.length > most ? `${shown} and ${names.length - most} more` : shown;
}

/** The price a product should show: its pence as pounds, as the shop's own API has them. */
export const priceOf = (product: Product): string =>
  Number.isFinite(product.pricePence) ? `£${(product.pricePence / 100).toFixed(2)}` : product.price;

/** The price a product page or card shows: the first amount of money in the text, whatever it looks like. */
export const firstPrice = (text: string): string | null => {
  const price = text.match(PRICE)?.[0];
  return price ? normalPrice(price) : null;
};

/** Selector for the smallest element in the main content that shows this text. */
export const showing = (text: string) => `main :text(${JSON.stringify(text)})`;

/** The words of a name that a search could be asked for: letters and digits, three or more of them. */
export const wordsOf = (name: string): string[] => name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);

/** What the page's main content says, as a shopper reads it. */
export const mainText = (page: Page): Promise<string> => page.locator('main').first().innerText();
