/**
 * The pictures of a canary in a real browser, against two copies of the small shop made for the tests: the stable one
 * as it should be, and a canary whose product pages show the wrong heading. Every page is found from the stable's front
 * door, pictured on both, and compared; only the product pages differ.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_LAUNCH, capturePage } from '../../src/capture.ts';
import type { Picture } from '../../src/pictures/index.ts';
import { Pictures } from '../../src/pictures/take.ts';
import { discover, httpGet } from '../../src/traffic/traffic.ts';
import { startShop } from './shop.ts';

let browser: Browser;
const store = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'pictures-artifacts-')));
const log = { info: () => {}, warn: () => {} };

beforeAll(async () => {
  browser = await chromium.launch(BROWSER_LAUNCH);
});
afterAll(() => browser?.close());

describe('the pictures of a canary', () => {
  it('compares every page on the stable and the canary, and finds only the pages that changed', async () => {
    const [stable, canary] = await Promise.all([startShop(), startShop('product-heading')]);
    const recorded: Picture[] = [];
    const looked = [
      // Another check boxed four elements on the page, so the probe's heading is the fifth.
      {
        sense: 'crawler' as const,
        check: 'links',
        route: '/products/:slug',
        path: '/products/oak-stool',
        elements: ['header', 'header nav', 'header ul', 'header li'].map((selector) => ({
          selector,
          kind: 'problem' as const,
        })),
      },
      {
        sense: 'probe' as const,
        check: 'product/heading',
        route: '/products/:slug',
        path: '/products/oak-stool',
        elements: [{ selector: 'main h1', kind: 'problem' as const }],
      },
    ];
    try {
      const pictures = new Pictures({
        stable: stable.url,
        canary: canary.url,
        version: async (app) => (app === stable.url ? 'a'.repeat(40) : 'b'.repeat(40)),
        pages: (app) => discover(httpGet(app)),
        shoot: async (app, path, { route, version, elements }) => {
          const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
          try {
            const page = await context.newPage();
            await page.goto(new URL(path, app).href, { waitUntil: 'load' });
            return await capturePage(page, store, { route, version, checks: elements, maxHeight: 1600 });
          } finally {
            await context.close();
          }
        },
        index: {
          pictured: async () => new Set(recorded.map((p) => p.path)),
          record: async (pictures) => void recorded.push(...pictures),
          awaitingRollout: async () => [],
          rolledOut: async () => {},
          looks: async () => looked,
          forget: async () => 0,
        },
        store,
        log,
      });
      expect(await pictures.tick()).toMatchObject({ compared: expect.any(Number) });
      const changed = recorded.filter((p) => p.changed > 0).map((p) => p.route);
      expect(new Set(changed)).toEqual(new Set(['/products/:slug']));
      expect(recorded.find((p) => p.path === '/')).toMatchObject({ changed: 0, diff: null });
      // The page a probe boxed is pictured with every element boxed on both versions, its heading among them.
      const own = recorded.find((p) => p.path === '/products/oak-stool');
      expect(own?.before.boxes).toHaveLength(5);
      expect(own?.after.boxes).toHaveLength(5);
      expect(own?.after.selectors?.at(-1)).toBe('main h1');
      expect(own?.diff).not.toBeNull();
      for (const p of recorded) expect(await store.size(p.after.hash)).toBe(p.after.size);
    } finally {
      await Promise.all([stable.close(), canary.close()]);
    }
  }, 120_000);
});
