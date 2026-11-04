/**
 * The replay site's mechanism, proved early: the same build, fed from an event-log file with no server behind it,
 * draws the same page at the same t as it does live.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { pixelDifference } from '@software-factory/factory/capture';
import { CONTENT_SECURITY_POLICY } from '../src/app.ts';
import { consoleUrl, expect, ready, test } from './support.ts';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const LOG = fileURLToPath(new URL('../../../packages/samples/log/', import.meta.url));
const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

/**
 * Serves the build and the samples' event log as plain files, as GitHub Pages will: no server code at all. The log's
 * relayed refusals are checked beside it (`refusals.json`), as the live server checks them.
 */
async function servePlainFiles(page: Page, origin: string) {
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'content-security-policy': CONTENT_SECURITY_POLICY };
    if (path === '/') {
      // The one difference between the two: the page is told to read a log folder instead of a server. The app's
      // address is the one the live server writes from APP_URL (playwright.config.ts), as a replay site would name it.
      const page = readFileSync(join(DIST, 'index.html'), 'utf-8')
        .replace('content="live"', 'content="log:/log/"')
        .replace('<meta name="sf-app" content="">', '<meta name="sf-app" content="http://website.localhost:8080">')
        .replace(/<link rel="preload" href="\/api\/events[^>]*>/, '');
      return route.fulfill({ body: page, contentType: 'text/html', headers });
    }
    if (path.startsWith('/log/')) {
      const file = join(LOG, path.slice('/log/'.length));
      const type = path.endsWith('.ndjson')
        ? 'application/x-ndjson'
        : path.endsWith('.json')
          ? 'application/json'
          : 'image/png';
      return route.fulfill({ body: readFileSync(file), contentType: type, headers });
    }
    return route.fulfill({ body: readFileSync(join(DIST, path)), contentType: TYPES[extname(path)] ?? '', headers });
  });
}

async function drawn(page: Page) {
  await ready(page);
  await page.waitForLoadState('networkidle');
  return {
    text: await page.locator('main').innerText(),
    stations: await page.locator('.stage').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label'))),
    picture: await page.locator('main').screenshot({ animations: 'disabled' }),
  };
}

test.use({ viewport: { width: 1440, height: 2200 } });

for (const item of [undefined, '1271', '1302', '1311']) {
  test(`draws the same page from a file as live${item ? `, at #${item}` : ''}`, async ({ page, context, guard }) => {
    await page.goto(consoleUrl({ item }));
    const live = await drawn(page);

    // The stand-in for GitHub Pages is served here, by route: nothing asked of it leaves the machine.
    guard.served.push('http://replay.test');
    const replay = await context.newPage();
    await servePlainFiles(replay, 'http://replay.test');
    await replay.goto(`http://replay.test${consoleUrl({ item })}`);
    const recorded = await drawn(replay);

    expect(recorded.stations).toEqual(live.stations);
    expect(recorded.text).toEqual(live.text);
    // Scaled screenshots in the neighbouring cards can rasterise a few pixels differently from one load to the
    // next; anything beyond that is a different page.
    const blank = await context.newPage();
    const differ = await pixelDifference(blank, live.picture, recorded.picture);
    if (differ > 0) {
      writeFileSync(test.info().outputPath('live.png'), live.picture);
      writeFileSync(test.info().outputPath('recorded.png'), recorded.picture);
    }
    expect(differ, 'the share of pixels that differ').toBeLessThan(0.0002);
  });
}
