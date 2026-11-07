import type { Page } from '@playwright/test';
import { attacksUrl, consoleUrl, END, expect, MERGE_WAITING, ready, test, WIDTHS } from './support.ts';

const renders = (page: Page) =>
  page.evaluate(() => (globalThis as { sfRenders?: { reel: number } }).sfRenders?.reel ?? -1);
/**
 * The render count once it has stopped changing. Letting go of the reel removes its dragging class at once, and the
 * reel renders where it settled a moment later, so a count read straight away can miss a render.
 */
async function settledRenders(page: Page): Promise<number> {
  let last = Number.NaN;
  await expect
    .poll(
      async () => {
        const now = await renders(page);
        const still = now === last;
        last = now;
        return still;
      },
      { intervals: [250] },
    )
    .toBe(true);
  return last;
}
const centre = (page: Page) => page.locator('.card[data-place="centre"] h3').textContent();

/** Drags the reel a card and a half to the right, in a given number of pointer moves. */
async function drag(page: Page, frames: number) {
  await page.locator('.reel').scrollIntoViewIfNeeded();
  const box = await page.locator('.reel').boundingBox();
  if (!box) throw new Error('No reel');
  const y = box.y + 120;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 800, y, { steps: frames });
  await page.mouse.up();
}

/** Scrubs the timeline from its middle to a quarter of the way along, in a given number of pointer moves. */
async function scrub(page: Page, frames: number) {
  await page.locator('.rail').scrollIntoViewIfNeeded();
  const box = await page.locator('.rail').boundingBox();
  if (!box) throw new Error('No timeline');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 4, y, { steps: frames });
  await page.mouse.up();
}

test.describe('the reel', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('drags without rendering on every frame', async ({ page }) => {
    // The stream's opening and first message arrive a few hundred milliseconds in, and render the page: held, they
    // can't land in one drag's count and not the other's.
    await page.route('**/api/events/stream*', () => {});
    const counts: number[] = [];
    for (const frames of [8, 80]) {
      await page.goto(consoleUrl({ debug: 'renders' }));
      await ready(page);
      const before = await settledRenders(page);
      await drag(page, frames);
      await expect(page.locator('.reel')).not.toHaveClass(/dragging/);
      counts.push((await settledRenders(page)) - before);
    }
    // State hears where the drag settled, however many frames it drew on the way.
    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBeLessThanOrEqual(2);
  });

  test('scrubs the timeline without rendering on every frame', async ({ page }) => {
    await page.route('**/api/events/stream*', () => {});
    const counts: number[] = [];
    for (const frames of [8, 80]) {
      await page.goto(consoleUrl({ debug: 'renders' }));
      await ready(page);
      const before = await settledRenders(page);
      await scrub(page, frames);
      counts.push((await settledRenders(page)) - before);
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBeLessThanOrEqual(2);
  });

  test('holds still under a drag while a live console’s clock ticks', async ({ page }) => {
    await page.clock.install({ time: END });
    // No t in the address: the console follows the clock, ticking every ten seconds.
    await page.goto('/?motion=off');
    await ready(page);
    await page.locator('.reel').scrollIntoViewIfNeeded();
    const box = await page.locator('.reel').boundingBox();
    if (!box) throw new Error('No reel');
    const [x, y] = [box.x + box.width / 2, box.y + 120];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 300, y, { steps: 10 });
    const latest = page.locator('.card').last();
    const held = await latest.evaluate((el) => el.style.transform);
    await page.clock.runFor(21_000);
    expect(await latest.evaluate((el) => el.style.transform)).toBe(held);
    await page.mouse.up();
  });

  test('credits work a visitor started to “a visitor”, never by name, and an attack to Martin', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296' }));
    await ready(page);
    await expect(page.locator('.card[data-place="centre"] .kind')).toHaveText('· Injected by a visitor');
    await page.goto(attacksUrl({ item: '1293' }));
    await ready(page);
    await expect(page.locator('.card[data-place="centre"] .kind')).toHaveText('· Red-team attack by Martin');
  });

  test('settles on a whole card when the drag ends, carried a little further by a flick', async ({ page }) => {
    await page.clock.install({ time: END });
    await page.goto(consoleUrl());
    await ready(page);
    // A flick is a speed, read from the page's clock: held still, the drag takes no time at all, however slow the
    // machine, and is always a flick.
    await page.clock.pauseAt(END + 60_000);
    await drag(page, 20);
    await page.clock.resume();
    await expect(page.locator('.reel')).not.toHaveClass(/dragging/);
    // A card and a third to the left, and half a card more for the flick.
    await expect(page.locator('.transport .count')).toHaveText('26 of 28');
    await expect(page.locator('.card[data-place="centre"]')).toHaveCount(1);
  });

  test('moves with the arrow keys, Home and End, and opens with Enter', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    await page.locator('.reel').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => centre(page)).toBe('The second page of search results repeats the first’s last');
    await page.keyboard.press('Home');
    await expect.poll(() => centre(page)).toBe('pino 10.4.0, and nothing to see');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Search lists the first result twice' })).toBeVisible();
  });

  test('brings a neighbour to the centre when it is clicked, and opens the centre card', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    await page.locator('.card[data-index="26"]').click({ position: { x: 300, y: 40 } });
    await expect.poll(() => centre(page)).toBe('The second page of search results repeats the first’s last');
    await page.locator('.card[data-place="centre"]').click({ position: { x: 300, y: 40 } });
    await expect(
      page.getByRole('dialog', { name: 'The second page of search results repeats the first’s last' }),
    ).toBeVisible();
  });

  test('writes the app’s version under the timeline by a commit’s first seven characters', async ({
    page,
    request,
  }) => {
    // The samples name their releases by version; the cluster's are commits. The app is on v0.9.12 at the end.
    const commit = 'b5702d4e1f9a3c6087d2e5b1a4c7f0e3d6b9a2c5';
    const events = (await (await request.get('/api/events')).text()).replaceAll('v0.9.12', commit);
    // The stream is held, so nothing it sends can bring v0.9.12 back.
    await page.route('**/api/events/stream*', () => {});
    await page.route('**/api/events?after=0', (route) =>
      route.fulfill({ body: events, contentType: 'application/json' }),
    );
    await page.goto(consoleUrl());
    await ready(page);
    const version = page.locator('.at-line b.mono');
    await expect(version).toHaveText('b5702d4');
    await expect(version).toHaveAttribute('title', commit);
  });

  test('says the app’s version in words, and that the work item’s own release was rolled back', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1276' }));
    await ready(page);
    const rail = page.getByRole('slider', { name: 'Timeline of work items' });
    await expect(rail).toHaveAttribute('aria-valuetext', /\. The app at v[\d.]+; v[\d.]+ was rolled back\.$/);
    await expect(page.locator('.at-line')).toContainText(/The app at v[\d.]+ · v[\d.]+ was rolled back/);
  });

  test('moves the wipe with its handle’s arrow keys', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296' }));
    await ready(page);
    const handle = page.locator('.card[data-place="centre"] .handle');
    const before = Number(await handle.getAttribute('aria-valuenow'));
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', String(before + 5));
  });
});

test.describe('the sheet', () => {
  test('holds focus while open and gives it back when it closes', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296' }));
    await ready(page);
    await page.locator('.reel').focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Prices go negative' });
    await expect(sheet).toBeVisible();
    await expect(page.locator('#sheet-title')).toBeFocused();
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('.sheet') !== null)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.locator('.reel')).toBeFocused();
  });

  test('steps to the previous and next work items, and the reel follows', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296', sheet: true }));
    const sheet = page.getByRole('dialog');
    await expect(sheet).toHaveAccessibleName('Prices go negative');
    await sheet.getByRole('button', { name: 'Next work item' }).click();
    await expect(sheet).toHaveAccessibleName('A gift note in the basket');
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => centre(page)).toBe('A gift note in the basket');
  });

  test('steps through the stages, showing the site as it stood', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296', sheet: true }));
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /T\+04:20, signal/ })
      .click();
    await expect(page.locator('.site-head')).toContainText('BROKEN · v0.9.4');
    await expect(page.locator('.event.now')).toContainText('The home journey saw a price of £-6.00');
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.locator('.event.now')).toContainText('Ticket #1296');
  });
});

/** Where the sheet's head draws its words, line by line: a reason when any leaves its column or meets the buttons. */
function headClash(head: HTMLElement): string {
  const nav = head.querySelector('.sheet-nav')?.getBoundingClientRect();
  const title = head.querySelector('.sheet-title');
  const column = title?.getBoundingClientRect();
  if (!nav || !column || !title) return 'no head';
  const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(text);
    for (const box of range.getClientRects()) {
      if (box.width === 0) continue;
      if (box.right > column.right + 0.5) return `“${text.textContent}” runs out of its column`;
      const apart = box.right <= nav.left || box.bottom <= nav.top || box.top >= nav.bottom;
      if (!apart) return `“${text.textContent}” touches the buttons`;
    }
  }
  return '';
}

/**
 * The sheet's head keeps its words clear of its buttons: on a phone, and on the narrowest screen reflow allows, every
 * line of every work item's kicker and title stays inside its column, a long state wrapping rather than running under
 * the buttons. Every work item at the samples' end, and #1310 as its merge waits for a release, the longest state they show.
 */
for (const viewport of [WIDTHS.phone, { width: 320, height: 640 }]) {
  test.describe(`${viewport.width}px, the sheet's head`, () => {
    test.use({ viewport });

    test('keeps every work item’s words clear of its buttons', async ({ page }) => {
      await page.goto(consoleUrl({ item: '1310', sheet: true }));
      const sheet = page.getByRole('dialog').first();
      await sheet.waitFor();
      await page.evaluate(() => document.fonts.ready);
      // Back to the first work item, then forward through every one.
      const previous = sheet.getByRole('button', { name: 'Previous work item' });
      while (await previous.isEnabled()) await previous.click();
      const next = sheet.getByRole('button', { name: 'Next work item' });
      for (;;) {
        const title = (await page.locator('#sheet-title').textContent()) ?? '';
        expect(await page.locator('.sheet-head').evaluate(headClash), title).toBe('');
        if (!(await next.isEnabled())) break;
        await next.click();
      }
    });

    test('keeps a merge waiting for a release clear of its buttons', async ({ page }) => {
      await page.goto(consoleUrl({ item: '1310', sheet: true, at: MERGE_WAITING }));
      await page.getByRole('dialog').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.sheet-head .out')).toHaveText(/waiting for release/i);
      expect(await page.locator('.sheet-head').evaluate(headClash)).toBe('');
    });
  });
}

test.describe('the line', () => {
  test('opens a stage panel that lists what is in the stage, each opening its sheet', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    await page.getByRole('button', { name: /^Plan: needs you/ }).click();
    const panel = page.getByRole('dialog', { name: 'Plan' });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: /^#1300 / }).click();
    await expect(page.getByRole('dialog', { name: 'Sort products by price' })).toBeVisible();
  });

  test('lists a release with no work item by its commit’s first seven characters', async ({ page }) => {
    // Monday evening: a build of one of Martin's commits has just rolled back.
    await page.goto(consoleUrl({ at: Date.parse('2026-10-05T17:50:00Z') }));
    await ready(page);
    await page.getByRole('button', { name: /^Release:/ }).click();
    const id = page
      .getByRole('dialog', { name: 'Release' })
      .locator('.srow .id[title="efef168f4eec299dfc27c8fc78477ce28379b38d"]');
    await expect(id).toHaveText('efef168');
    // It fits its column, clear of the row's words.
    expect(await id.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test('closes the stage panel with Escape, back to its station', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    const gates = page.getByRole('button', { name: /^Gates:/ });
    await gates.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(gates).toBeFocused();
  });
});

test.describe('opening the console', () => {
  // Short enough that the reel starts out of sight, below the line.
  test.use({ viewport: { width: 1440, height: 560 } });

  test('opens the reel on now, and it stays there when it comes into sight', async ({ page }) => {
    await page.clock.install({ time: END });
    await page.goto(consoleUrl({ motion: true }));
    await ready(page);
    const count = page.locator('.transport .count');
    await expect(count).toHaveText('28 of 28');
    expect((await page.locator('.reel').boundingBox())?.y).toBeGreaterThan(560);
    // Nothing to play the history with.
    await expect(page.locator('.transport').getByRole('button', { name: /play|pause/i })).toHaveCount(0);

    await page.locator('.reel').scrollIntoViewIfNeeded();
    await page.clock.runFor(10_000);
    await expect(count).toHaveText('28 of 28');
  });
});

/**
 * The timeline's version labels never touch: where two would, one is thinned to a hairline, and the centre card's
 * and the app's version now keep their labels. At every width, at rest on the latest card, a rollback's (#1276) and a release's own (#1306).
 */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the timeline's versions`, () => {
    test.use({ viewport });

    for (const item of [undefined, '1276', '1306']) {
      test(`never touch, with ${item ? `#${item}` : 'the latest'} at the centre`, async ({ page }) => {
        await page.goto(consoleUrl({ item }));
        await ready(page);
        const labels = await page.locator('.rail .ver').evaluateAll((marks) =>
          marks.map((m) => {
            const { left, right, width } = m.getBoundingClientRect();
            const [here, now] = [m.classList.contains('here'), m.classList.contains('now')];
            return { text: m.textContent, left, right, shown: width > 1, here, now };
          }),
        );
        const shown = labels.filter((l) => l.shown).sort((a, b) => a.left - b.left);
        for (const [a, b] of shown.slice(1).map((b, i) => [shown[i], b] as const))
          expect(b.left, `${a?.text} touches ${b.text}`).toBeGreaterThan(a?.right ?? 0);
        for (const here of labels.filter((l) => l.here)) expect(here.shown, `${here.text} at the centre`).toBe(true);
        // The version the app is on keeps its label too.
        expect(labels.find((l) => l.now)?.shown, 'the app’s version now').toBe(true);
      });
    }
  });
}

/**
 * The timeline shows a window of itself around the playhead, the same at every width: no work item's mark touches
 * another, the centre card's is in the window whole, and a phone's window holds only part of the timeline.
 */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the timeline's window`, () => {
    test.use({ viewport });

    for (const item of ['first', 'latest', '1276']) {
      test(`keeps every mark apart, with ${item === '1276' ? `#${item}` : `the ${item}`} at the centre`, async ({
        page,
      }) => {
        await page.goto(consoleUrl({ item: item === '1276' ? item : undefined }));
        await ready(page);
        if (item === 'first') {
          await page.locator('.reel').focus();
          await page.keyboard.press('Home');
          await expect(page.locator('.transport .count')).toHaveText(/^1 of/);
        }
        const shown = await page.locator('.rail .window').boundingBox();
        if (!shown) throw new Error('No timeline');
        // Read once the strip has stopped sliding.
        await expect
          .poll(() => page.locator('.rail .tick.here').evaluate((el) => el.getAnimations({ subtree: true }).length))
          .toBe(0);
        const marks = await page.locator('.rail .tick').evaluateAll((ticks) =>
          ticks.map((t) => {
            const { left, right } = t.getBoundingClientRect();
            return { left, right, here: t.classList.contains('here') };
          }),
        );
        const sorted = [...marks].sort((a, b) => a.left - b.left);
        for (const [a, b] of sorted.slice(1).map((b, i) => [sorted[i], b] as const))
          expect(b.left, 'a mark touches the one before it').toBeGreaterThanOrEqual(a?.right ?? 0);
        const here = marks.find((m) => m.here);
        expect(here?.left).toBeGreaterThanOrEqual(shown.x);
        expect(here?.right).toBeLessThanOrEqual(shown.x + shown.width);
        const outside = marks.filter((m) => m.right <= shown.x || m.left >= shown.x + shown.width);
        if (width === 'phone') expect(outside.length, 'marks beyond a phone’s window').toBeGreaterThan(0);
      });
    }
  });
}
