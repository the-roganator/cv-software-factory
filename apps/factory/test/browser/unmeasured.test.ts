/**
 * The senses' requests carry `UNMEASURED`, every one of them, pages, their images and scripts, and the requests made
 * without the browser alike, so none counts in the app's figures, but the crawler's one ask for each static asset as a
 * visitor asks, for its caching; a page a sense lends sends it when asked. Against
 * the small shop made for the tests (shop.ts), which records what it was sent. These tests need Chromium, so they run
 * in the pinned Playwright image.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { listenLocal } from '@software-factory/testing';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBES } from '../../src/probes/index.ts';
import { readerServer } from '../../src/probes/reader.ts';
import { Shop } from '../../src/probes/site.ts';
import { BrowserSense } from '../../src/senses/browser.ts';
import { UNMEASURED } from '../../src/senses/http.ts';
import { observeApp } from '../../src/senses/observe.ts';
import { startShop } from './shop.ts';

let browser: Browser;
const store = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'unmeasured-artifacts-')));
const log = { warn: () => {} };
const [[NAME, VALUE]] = Object.entries(UNMEASURED) as [[string, string]];

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser?.close());

/** The paths the shop was sent with the header, and those it was sent without. */
const split = (requests: Array<{ url: string; headers: Record<string, unknown> }>) => ({
  with: requests.filter((r) => r.headers[NAME] === VALUE).map((r) => r.url),
  without: requests.filter((r) => r.headers[NAME] === undefined).map((r) => r.url),
});

describe('the senses', () => {
  it('send the header with every request, from the browser and without it', async () => {
    const shop = await startShop();
    try {
      await observeApp(shop.url, undefined, { store, log, limit: 50 });
      const { with: sent, without } = split(shop.requests);
      // But the crawler's one ask for each static asset as a visitor asks, whose caching the mark would hide.
      expect(without).toEqual(['/assets/item.svg']);
      // The version asked for, the API the probes compare with, the pages the browser opened, and the error pages
      // the crawler asks for.
      expect(sent).toEqual(expect.arrayContaining(['/version', '/api/products?page=1', '/products', '/%E0%A4%A']));
    } finally {
      await shop.close();
    }
  }, 120_000);

  it('read a page for triage with the header on every request', async () => {
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
    const reader = readerServer({
      app: shop.url,
      sense,
      store,
      version: async () => 'a'.repeat(40),
      log: { info: () => {}, warn: () => {} },
    });
    const { url } = await listenLocal(reader);
    try {
      const answer = await fetch(`${url}/v1/pages`, {
        method: 'POST',
        body: JSON.stringify({ path: '/products' }),
      });
      expect(answer.status).toBe(200);
      const { with: sent, without } = split(shop.requests);
      expect(sent).toContain('/products');
      expect(without).toEqual([]);
    } finally {
      await new Promise((resolve) => reader.close(resolve));
      await shop.close();
    }
  }, 60_000);

  it('lend a page that sends the header when asked, as the pictures do, and none otherwise', async () => {
    const shop = await startShop();
    try {
      const sense = new BrowserSense({
        name: 'probe',
        app: shop.url,
        checks: PROBES,
        store,
        log,
        shared: () => new Shop(shop.url),
        launch: async () => browser,
      });
      // The page and whatever it loads.
      await sense.withPage((page) => page.goto(`${shop.url}/products`), UNMEASURED);
      const asked = split(shop.requests);
      expect(asked.with).toContain('/products');
      expect(asked.without).toEqual([]);
      shop.requests.length = 0;
      await sense.withPage((page) => page.goto(`${shop.url}/about`));
      const not = split(shop.requests);
      expect(not.with).toEqual([]);
      expect(not.without).toContain('/about');
    } finally {
      await shop.close();
    }
  }, 60_000);
});
