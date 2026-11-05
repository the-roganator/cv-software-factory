/**
 * A screenshot opened at full size from a sheet, from the samples: a shot's frame, a wipe's two sides and a strip of
 * unchanged pages each open the whole page with its marks, by the keyboard as by the pointer, and close back to the
 * control that opened them, with the sheet still open behind; every mark is drawn, the ones a frame leaves out too;
 * a tall page scrolls inside the view, under its title and Close; a flag's pages are told apart by name; on a phone
 * the view is the screen's width and a wipe's sides are one above the other; on a card, which opens its sheet, a
 * screenshot opens nothing of its own; a label is set unhinted, as a desktop browser sets it; and WCAG 2.2 AA in both
 * themes.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { AT_CHECKS } from './flags.ts';
import { consoleUrl, expect, THEMES, test, WIDTHS } from './support.ts';

const sheetOf = (page: Page) => page.locator('section.sheet');
const viewer = (page: Page) => page.locator('dialog.viewer');

test.describe('a screenshot at full size', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('a wipe opens both its sides whole by the keyboard, and Escape closes it back to the wipe', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296', sheet: true }));
    const sheet = sheetOf(page);
    const open = sheet.getByRole('button', { name: 'Open at full size: The home page, broken and fixed' });
    await open.focus();
    await page.keyboard.press('Enter');
    const view = page.getByRole('dialog', { name: 'The home page, broken and fixed' });
    await expect(view).toBeVisible();
    await expect(view.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(view.locator('figcaption')).toHaveText(['BROKEN · v0.9.4', 'FIXED · v0.9.5']);
    await expect(view.getByRole('img')).toHaveCount(2);
    await expect(view.locator('.mk-label')).toHaveText(['Prices below zero', 'Back above zero']);
    // Side by side on a laptop, the two pages the same size.
    const [before, after] = await view
      .locator('.viewer-page')
      .evaluateAll((pages) => pages.map((p) => p.getBoundingClientRect().toJSON() as DOMRect));
    expect(before?.y).toBe(after?.y);
    expect(before?.width).toBe(after?.width);
    await page.keyboard.press('Escape');
    await expect(view).toBeHidden();
    await expect(open).toBeFocused();
    await expect(page.getByRole('dialog', { name: 'Prices go negative' })).toBeVisible();
  });

  // A label's text is set at the widths a desktop browser sets it. Hinted, as headless Chromium on Linux sets text
  // unless told not to (playwright.config.ts), each glyph's advance snaps to a whole pixel: this line is 86px, its
  // spaces 2px, and a snapshot records "Pricesbelow zero".
  test('a label’s text is set unhinted, at a fraction of a pixel', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296', sheet: true }));
    const width = await page.evaluate(async () => {
      await document.fonts.load('500 10px Geist');
      const span = document.createElement('span');
      span.textContent = 'Prices below zero';
      span.style.cssText = 'position: absolute; font: 500 10px Geist; letter-spacing: 0; white-space: nowrap';
      document.body.append(span);
      const { width } = span.getBoundingClientRect();
      span.remove();
      return width;
    });
    expect(width).toBeCloseTo(82.67, 0);
  });

  test('a press on a wipe’s tag opens it too, and on its handle does not', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296', sheet: true }));
    const wipe = sheetOf(page).locator('.evidence-big .wipe');
    await wipe.locator('.handle').click();
    await expect(viewer(page)).toHaveCount(0);
    // The tag takes no pointer events, so the press lands on what is under it: the wipe's opener.
    const tag = await wipe.locator('.wtag.r').boundingBox();
    if (!tag) throw new Error('No tag');
    await page.mouse.click(tag.x + tag.width / 2, tag.y + tag.height / 2);
    await expect(viewer(page)).toBeVisible();
  });

  test('a page from Verify opens whole, and Close gives the focus back', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1306', sheet: true }));
    const open = sheetOf(page)
      .locator('.regress')
      .first()
      .getByRole('button', { name: /^Open at full size: / })
      .first();
    const name = (await open.getAttribute('aria-label'))?.replace('Open at full size: ', '') ?? '';
    expect(name).toMatch(/^Screenshot of .+ at v\d/);
    await open.click();
    const view = page.getByRole('dialog', { name });
    await expect(view).toBeVisible();
    await expect(view.locator('.label').first()).toHaveText(/^The whole page · \d+ × \d+$/);
    await view.getByRole('button', { name: 'Close' }).click();
    await expect(view).toBeHidden();
    await expect(open).toBeFocused();
  });

  test('each unchanged page in the strip opens whole', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1262', sheet: true }));
    const thumbs = sheetOf(page).locator('.unchanged .thumbs').getByRole('button');
    await expect(thumbs).toHaveCount(4);
    await thumbs.nth(1).click();
    await expect(viewer(page)).toBeVisible();
    await expect(viewer(page).locator('.label').first()).toHaveText(/^No visible change · \d+ × \d+$/);
    await expect(viewer(page).getByRole('img')).toHaveCount(1);
  });

  test('draws every mark on the whole page, the ones outside a frame too', async ({ page, request }) => {
    type Shot = { kind: string; width: number; height: number; boxes: { y: number; label: string }[] };
    type Event = { work_item: string | null; type: string; artifacts: Shot[] };
    const events = (await (await request.get('/api/events')).json()) as Event[];
    // The fix's picture as a whole page, 1600 tall: its first mark far down, and a second where the mark was.
    for (const event of events) {
      if (event.work_item !== '1296' || event.type !== 'verification.finished') continue;
      for (const shot of event.artifacts) {
        const [mark] = shot.boxes;
        if (shot.kind !== 'screenshot' || !mark) continue;
        shot.height = 1600;
        shot.boxes = [{ ...mark, y: 1200, label: 'Further down' }, mark];
      }
    }
    await page.route('**/api/events?after=0', (route) => route.fulfill({ json: events }));
    await page.goto(consoleUrl({ item: '1296', sheet: true }));
    await sheetOf(page)
      .locator('.evidence-big')
      .getByRole('button', { name: /^Open at full size/ })
      .click();
    const fixed = viewer(page).locator('.viewer-side').nth(1);
    await expect(fixed.locator('.mk-label')).toHaveText(['Further down', 'Back above zero']);
    // The mark far down is three quarters of the way down the page, as drawn.
    const page1600 = await fixed.locator('.viewer-page').boundingBox();
    const far = await fixed.locator('.mk').first().boundingBox();
    if (!page1600 || !far) throw new Error('No page or mark');
    expect(Math.abs(far.y - page1600.y - page1600.height * 0.75)).toBeLessThan(1);
  });

  test('a page taller than the view scrolls inside it, by the keyboard too, under the title and Close', async ({
    page,
  }) => {
    await page.setViewportSize(WIDTHS.laptop);
    await page.goto(consoleUrl({ item: '1306', sheet: true }));
    await sheetOf(page)
      .locator('.regress')
      .first()
      .getByRole('button', { name: /^Open at full size/ })
      .first()
      .click();
    const scroller = viewer(page).locator('.viewer-scroll');
    await expect(viewer(page).getByRole('img')).toHaveJSProperty('complete', true);
    const { scrollHeight, clientHeight } = await scroller.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight);
    await scroller.focus();
    await page.keyboard.press('End');
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(scrollHeight - clientHeight);
    await expect(viewer(page).getByRole('heading', { level: 2 })).toBeInViewport();
    await expect(viewer(page).getByRole('button', { name: 'Close' })).toBeInViewport();
  });

  test('a flag’s pages are named by their scheme and the flag, off and on', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1271', sheet: true, at: AT_CHECKS }));
    const buttons = sheetOf(page)
      .locator('.flag-pages')
      .getByRole('button', { name: /^Open at full size: / });
    // The sheet is a chunk of its own, loaded as it opens, and `evaluateAll` reads once: wait for every page first,
    // the home page off and on in light and dark.
    await expect(buttons).toHaveCount(4);
    const names = await buttons.evaluateAll((all) => all.map((button) => button.getAttribute('aria-label')));
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((name) => /, (light|dark), the flag off$/.test(name ?? ''))).toBe(true);
  });

  test('on a card, a screenshot opens nothing of its own: the card opens its sheet', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296' }));
    await expect(page.locator('.card[data-place="centre"] .wipe')).toBeVisible();
    await expect(page.locator('.card .shot-open')).toHaveCount(0);
  });

  for (const theme of THEMES) {
    test(`meets WCAG 2.2 AA, ${theme}`, async ({ page }) => {
      await page.goto(consoleUrl({ item: '1296', sheet: true, theme }));
      await sheetOf(page)
        .locator('.evidence-big')
        .getByRole('button', { name: /^Open at full size/ })
        .click();
      await expect(viewer(page)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .include('dialog.viewer')
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});

test.describe('a screenshot at full size on a phone', () => {
  test.use({ viewport: WIDTHS.phone });

  test('is the screen’s width, a wipe’s sides one above the other, and closes back to the wipe', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296', sheet: true }));
    const open = sheetOf(page).getByRole('button', { name: 'Open at full size: The home page, broken and fixed' });
    await open.click();
    const view = viewer(page);
    await expect(view).toBeVisible();
    const box = await view.boundingBox();
    expect(box?.width).toBe(WIDTHS.phone.width);
    const [before, after] = await view
      .locator('.viewer-page')
      .evaluateAll((pages) => pages.map((p) => p.getBoundingClientRect().toJSON() as DOMRect));
    if (!before || !after) throw new Error('No pages');
    expect(after.y).toBeGreaterThan(before.y + before.height);
    // The title and Close stay on the screen: only the pages scroll.
    await expect(view.getByRole('heading', { level: 2 })).toBeInViewport({ ratio: 1 });
    await expect(view.getByRole('button', { name: 'Close' })).toBeInViewport({ ratio: 1 });
    expect(await view.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
    await view.getByRole('button', { name: 'Close' }).click();
    await expect(view).toBeHidden();
    await expect(open).toBeFocused();
  });

  for (const theme of THEMES) {
    test(`meets WCAG 2.2 AA, ${theme}`, async ({ page }) => {
      await page.goto(consoleUrl({ item: '1306', sheet: true, theme }));
      await sheetOf(page)
        .locator('.regress')
        .first()
        .getByRole('button', { name: /^Open at full size/ })
        .first()
        .click();
      await expect(viewer(page)).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .include('dialog.viewer')
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
