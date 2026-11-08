/**
 * The page reader, for triage: it is given the path of a page of the app, and says what the page looks like, what it
 * says and what it holds. A screenshot goes in the artifact store; the visible text comes back as passages, and the
 * page's links, images, form fields and buttons as elements, for Jev to choose from; the status says whether the page
 * was there. The text of a page is never logged, and its requests carry `UNMEASURED`, as the senses' do.
 *
 *     POST /v1/pages   { "path": "/about" }
 *       ->  { "status": 200, "screenshot": <Screenshot>, "passages": ["…"], "elements": [<PageElement>, …] }
 *     GET  /health
 *
 * The page is loaded fresh, at its path alone, so nothing on it is what a visitor typed. An element is the app's own
 * markup: a link or an image by its path on the app, with no query or fragment, and a field by its label, its name and
 * its type, never its value.
 */
import { createServer, type Server } from 'node:http';
import { appPath, cutAt, elementsOf, type PageElement } from '@software-factory/events';
import type { ArtifactStore } from '@software-factory/store';
import { capture } from '../capture.ts';
import type { BrowserSense } from '../senses/browser.ts';
import { UNMEASURED } from '../senses/http.ts';

export const MAX_PASSAGES = 40;
export const MAX_PASSAGE_LENGTH = 200;

/** Splits a page's text into passages of a sentence or so, in order, each cut to length, with no repeats. */
export function passagesOf(text: string): string[] {
  const seen = new Set<string>();
  const passages: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const passage = cutAt(sentence.replace(/\s+/g, ' ').trim(), MAX_PASSAGE_LENGTH).trim();
      if (!passage || seen.has(passage)) continue;
      seen.add(passage);
      passages.push(passage);
      if (passages.length === MAX_PASSAGES) return passages;
    }
  }
  return passages;
}

/** An element as the browser saw it, with absolute addresses: any field may be anything. */
export interface RawElement {
  kind?: unknown;
  text?: unknown;
  href?: unknown;
  alt?: unknown;
  src?: unknown;
  label?: unknown;
  name?: unknown;
  type?: unknown;
}

/** An absolute address on the app as its path alone, cut at its query; null when it is off the app, or no address. */
function onApp(value: unknown, app: URL): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, app);
    return url.origin === app.origin ? appPath(url.pathname) : null;
  } catch {
    return null;
  }
}

/** The elements a page is read with, from what the browser saw: each address on the app by its path alone. */
export function pageElements(raw: readonly RawElement[], app: string): PageElement[] {
  const base = new URL(app);
  return elementsOf(raw.map(({ href, src, ...rest }) => ({ ...rest, to: onApp(href, base), src: onApp(src, base) })));
}

/**
 * Runs in the page: its links, images, form fields and buttons, in its order, as the markup has them. A field's value
 * is never read; a button's words are its text, or for an input its `value` attribute, which is the markup's.
 */
const READ_ELEMENTS = `(() => {
  const text = (el) => el.innerText || el.getAttribute('aria-label') || el.getAttribute('title');
  const out = [];
  for (const el of document.body.querySelectorAll('a[href], img, input, select, textarea, button')) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') out.push({ kind: 'link', text: text(el), href: el.href });
    else if (tag === 'img') out.push({ kind: 'image', alt: el.getAttribute('alt'), src: el.src });
    else if (tag === 'button') out.push({ kind: 'button', text: text(el) });
    else {
      const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
      if (type === 'hidden') continue;
      if (['submit', 'button', 'reset', 'image'].includes(type)) {
        out.push({ kind: 'button', text: el.getAttribute('value') || el.getAttribute('aria-label') });
        continue;
      }
      const label = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label');
      out.push({ kind: 'field', label, name: el.getAttribute('name'), type });
    }
  }
  return out;
})()`;

/** A path of the app, and nothing else: no host, no query, no fragment. Null if it is anything more. */
export function pathOnly(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  if (!/^\/(?!\/)[^\s?#\\]*$/.test(value)) return null;
  return value;
}

export interface ReaderOptions {
  app: string;
  sense: Pick<BrowserSense<unknown>, 'withPage'>;
  store: ArtifactStore;
  /** The app's version now. */
  version(): Promise<string>;
  log: { info(fields: object, message: string): void; warn(fields: object, message: string): void };
}

export function readerServer({ app, sense, store, version, log }: ReaderOptions): Server {
  return createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return reply(200, { status: 'ok' });
      if (req.method !== 'POST' || req.url !== '/v1/pages') return reply(404, { error: 'not found' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1_000) return reply(413, { error: 'too large' });
      }
      let path: string | null = null;
      try {
        path = pathOnly((JSON.parse(raw) as { path?: unknown }).path);
      } catch {
        // Not JSON: refused below with the rest.
      }
      if (!path)
        return reply(400, { error: 'path must be a path of the app, starting with / and with no query or fragment' });
      const started = Date.now();
      const current = await version();
      const page = await sense.withPage(async (page) => {
        const response = await page.goto(new URL(path, app).href, { waitUntil: 'load' });
        const main = page.locator('main').first();
        const text = await ((await main.count()) ? main : page.locator('body')).innerText();
        return {
          status: response?.status() ?? null,
          text,
          elements: (await page.evaluate(READ_ELEMENTS)) as RawElement[],
          screenshot: await capture(page, store, { route: path, version: current }),
        };
      }, UNMEASURED);
      log.info({ path, status: page.status, ms: Date.now() - started }, 'a page was read');
      return reply(200, {
        status: page.status,
        screenshot: page.screenshot,
        passages: passagesOf(page.text),
        elements: pageElements(page.elements, app),
      });
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message.split('\n')[0] : String(error) },
        'a page could not be read',
      );
      return reply(502, { error: 'the page could not be read' });
    }
  });
}
