/**
 * Screenshots of the invented pages (pages.ts) for the console's milestone 4 test data, taken the way a probe takes
 * them, with the factory's own capture code.
 *
 *     node apps/console/test/fixture/capture.ts
 *
 * Writes each screenshot into the fixture's event log (log/artifacts, named by hash) and what the test data needs
 * to know about it into captures.json: the boxes the capture marked, and where the elements an accessibility check
 * would name sit on the page. Run it again only when a page changes; the export reads captures.json.
 */
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { BROWSER_LAUNCH, type Check, capture } from '@software-factory/factory/capture';
import { DiskArtifacts } from '@software-factory/store';
import { ARTIFACTS, CAPTURES, type Captures, VERSION } from './captures.ts';
import { PAGES } from './pages.ts';

interface Shot {
  name: string;
  page: string;
  checks?: Check[];
  /** Elements whose boxes an accessibility finding gives, or none when they are out of view. */
  elements?: string[];
}

const faint: Check = { selector: '[data-mark="footer"]', kind: 'problem' };

const SHOTS: Shot[] = [
  ...PAGES.map((page) => ({ name: page.name, page: page.name })),
  ...PAGES.map((page) => ({ name: `${page.name}-faint`, page: page.name, checks: [faint] })),
  {
    name: 'about-link',
    page: 'about',
    checks: [{ selector: '[data-mark="link"]', kind: 'problem', label: 'Leads to a 404' }],
  },
  {
    name: 'contact-error',
    page: 'contact',
    checks: [{ selector: '[data-mark="error"]', kind: 'problem', label: '500 on send' }],
  },
  { name: 'delivery-images', page: 'delivery', elements: ['img.van', 'img.map', 'img.badge'] },
];

const store = new DiskArtifacts(ARTIFACTS);
const browser = await chromium.launch(BROWSER_LAUNCH);
const tab = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const captures: Captures = { shots: {}, elements: {} };
try {
  for (const shot of SHOTS) {
    const page = PAGES.find((p) => p.name === shot.page);
    if (!page) throw new Error(`No page called ${shot.page}`);
    await tab.setContent(page.html, { waitUntil: 'load' });
    const {
      kind: _kind,
      type: _type,
      version: _version,
      ...rest
    } = await capture(tab, store, {
      route: page.route,
      version: VERSION,
      ...(shot.checks && { checks: shot.checks }),
    });
    captures.shots[shot.name] = rest;
    for (const selector of shot.elements ?? []) {
      const box = await tab.locator(selector).boundingBox();
      const inView = box && box.y + box.height <= 800;
      captures.elements[`${shot.name} ${selector}`] = inView
        ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
        : null;
    }
  }
} finally {
  await browser.close();
}
writeFileSync(CAPTURES, `${JSON.stringify(captures, null, 2)}\n`);
console.log(`captured ${SHOTS.length} screenshots`);
