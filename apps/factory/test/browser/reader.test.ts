/**
 * The page reader, against the small shop made for the tests: it takes only a path of the app, and answers with the
 * status, a screenshot in the artifact store, the page's text in passages and its elements.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ELEMENTS } from '@software-factory/events';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_LAUNCH } from '../../src/capture.ts';
import { PROBES } from '../../src/probes/index.ts';
import {
  MAX_PASSAGE_LENGTH,
  MAX_PASSAGES,
  pageElements,
  passagesOf,
  pathOnly,
  readerServer,
} from '../../src/probes/reader.ts';
import { Shop } from '../../src/probes/site.ts';
import { BrowserSense } from '../../src/senses/browser.ts';
import { startShop } from './shop.ts';

let browser: Browser;
const store = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'reader-artifacts-')));
const log = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  browser = await chromium.launch(BROWSER_LAUNCH);
});
afterAll(() => browser?.close());

type Ask = (path: string, body?: string) => Promise<Response>;

/** Runs the work against a reader of a fresh test shop. `ask` posts a body to /v1/pages, or gets a path. */
async function withReader<T>(work: (post: (body: string) => Promise<Response>, get: Ask) => Promise<T>) {
  const shop = await startShop();
  const sense = new BrowserSense({
    name: 'probe',
    app: shop.url,
    checks: PROBES,
    store,
    log,
    shared: () => new Shop(shop.url),
    launch: async () => browser,
  });
  const server = readerServer({ app: shop.url, sense, store, version: async () => 'a'.repeat(40), log });
  const { url: base } = await listenLocal(server);
  try {
    return await work(
      (body) => fetch(`${base}/v1/pages`, { method: 'POST', body }),
      (path) => fetch(`${base}${path}`),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await shop.close();
  }
}

describe('the page reader', () => {
  it('takes a path and nothing more', () => {
    expect(pathOnly('/about')).toBe('/about');
    expect(pathOnly('/products/oak-stool')).toBe('/products/oak-stool');
    for (const refused of [
      'about',
      '/about?x=1',
      '/about#top',
      '//elsewhere.test/',
      'http://elsewhere.test/',
      '/a b',
      // A path the browser would collapse or read as another host's, so it would end at another page than it names.
      '/a/../b',
      '/a/./b',
      '/%2e%2e/b',
      '/a//b',
      '/\\elsewhere.test',
      '/a\\b',
      '',
      7,
      null,
    ]) {
      expect(pathOnly(refused)).toBeNull();
    }
  });

  it('refuses a path with a query, and anything that is not JSON with a path', async () => {
    await withReader(async (post) => {
      expect((await post(JSON.stringify({ path: '/about?x=1' }))).status).toBe(400);
      expect((await post(JSON.stringify({ path: 'about' }))).status).toBe(400);
      expect((await post('not json')).status).toBe(400);
    });
  });

  it('answers a path with a stored screenshot and the page’s passages', async () => {
    await withReader(async (post, get) => {
      expect((await get('/health')).status).toBe(200);
      const response = await post(JSON.stringify({ path: '/products/oak-stool' }));
      expect(response.status).toBe(200);
      const { screenshot, passages } = (await response.json()) as {
        screenshot: { hash: string; route: string };
        passages: string[];
      };
      expect(screenshot).toMatchObject({ kind: 'screenshot', route: '/products/oak-stool', boxes: [] });
      expect(await store.size(screenshot.hash)).toBeGreaterThan(0);
      expect(passages).toEqual(['Oak stool', '£45.00', 'A fine thing.']);
    });
  }, 30_000);

  it('answers with the page’s status and its elements, a link by its path and a field never by its value', async () => {
    await withReader(async (post) => {
      const product = (await (await post(JSON.stringify({ path: '/products/oak-stool' }))).json()) as {
        status: number;
        elements: unknown[];
      };
      expect(product.status).toBe(200);
      expect(product.elements).toEqual(
        expect.arrayContaining([
          { kind: 'link', text: 'Products', to: '/products' },
          { kind: 'image', alt: 'Oak stool', src: '/assets/item.svg' },
        ]),
      );
      const contact = (await (await post(JSON.stringify({ path: '/contact' }))).json()) as { elements: unknown[] };
      expect(contact.elements).toEqual(
        expect.arrayContaining([
          { kind: 'field', label: 'Name', name: 'name', type: 'text' },
          { kind: 'field', label: 'Email', name: 'email', type: 'email' },
          { kind: 'button', text: 'Send' },
        ]),
      );
      const missing = (await (await post(JSON.stringify({ path: '/no-such-page' }))).json()) as { status: number };
      expect(missing.status).toBe(404);
      // A page that ends at another path is not the one asked for, whatever that one answered.
      const moved = (await (await post(JSON.stringify({ path: '/moved' }))).json()) as { status: number | null };
      expect(moved.status).toBeNull();
      // A path an address would collapse to another page is not read at all.
      expect((await post(JSON.stringify({ path: '/[typed](//elsewhere.test/x)/../../../..' }))).status).toBe(400);
    });
  }, 30_000);

  it('bounds the elements it answers with: paths on the app alone, no values, no repeats, so many of each kind', () => {
    const app = 'http://shop.test';
    const elements = pageElements(
      [
        { kind: 'link', text: '  Lost\n property ', href: 'http://shop.test/lost?q=typed#top' },
        { kind: 'link', text: 'Elsewhere', href: 'https://elsewhere.test/page' },
        { kind: 'link', text: 'Lost property', href: 'http://shop.test/lost' },
        { kind: 'image', alt: null, src: 'data:image/png;base64,AAAA' },
        { kind: 'image', alt: 'Waiting', src: '' },
        { kind: 'field', label: 'Email', name: 'email', type: 'email', value: 'someone@example.com' } as never,
        { kind: 'button', text: 'x'.repeat(200) },
        { kind: 'script', text: 'not an element' },
        ...Array.from({ length: 50 }, (_, i) => ({ kind: 'link', text: `Page ${i}`, href: `/page/${i}` })),
      ],
      app,
    );
    expect(elements.slice(0, 6)).toEqual([
      { kind: 'link', text: 'Lost property', to: '/lost' },
      { kind: 'link', text: 'Elsewhere', to: null },
      { kind: 'image', alt: null, src: null },
      // An empty address is none, not the app's front page.
      { kind: 'image', alt: 'Waiting', src: null },
      { kind: 'field', label: 'Email', name: 'email', type: 'email' },
      { kind: 'button', text: 'x'.repeat(80) },
    ]);
    expect(elements.filter((e) => e.kind === 'link')).toHaveLength(MAX_ELEMENTS);
    expect(JSON.stringify(elements)).not.toContain('someone@example.com');
  });

  it('splits a long page into passages, capped in number and length, with no repeats', async () => {
    await withReader(async (post) => {
      const { passages } = (await (await post(JSON.stringify({ path: '/about' }))).json()) as { passages: string[] };
      expect(passages).toHaveLength(MAX_PASSAGES);
      expect(passages.slice(0, 3)).toEqual(['About', 'Sentence number 0 is here.', 'Sentence number 1 is here.']);
      expect(new Set(passages).size).toBe(passages.length);
    });
  }, 30_000);

  it('cuts a passage that runs on', () => {
    const [passage] = passagesOf(`${'Long '.repeat(80)}end.`);
    expect(passage?.length).toBeLessThanOrEqual(MAX_PASSAGE_LENGTH);
  });

  it('cuts a passage as a fingerprint keeps it: as before with no emoji, and never inside one', () => {
    const plain = `${'Long '.repeat(80)}end.`;
    expect(passagesOf(plain)[0]).toBe(plain.slice(0, MAX_PASSAGE_LENGTH).trim());
    // The emoji's first half would be the passage's last unit: it goes with its second, and no mark is added.
    const [passage] = passagesOf(`${'a'.repeat(MAX_PASSAGE_LENGTH - 1)}😀 and more.`);
    expect(passage).toBe('a'.repeat(MAX_PASSAGE_LENGTH - 1));
  });
});
