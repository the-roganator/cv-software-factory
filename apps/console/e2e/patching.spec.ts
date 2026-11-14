/**
 * Patching (milestone 7, task 32), from the samples' day: its summary in the bottom row, every open finding and what
 * the moves clear under C, H, M and L, read at a glance, and why it needs Martin; and its sheet, which the summary
 * opens. What waits on Martin first, then by deadline; a row opens in place, one at a time; All open under the rows; a
 * visitor reads it read-only, a lockfile's package withheld until its pull request is open, and Martin reads it whole,
 * with code scanning a link away. An event neither reads renders nothing in either, while a new day renders each once,
 * and a day from a scan that did not count every open finding shows a dash. Each move that waits on Martin is a card in
 * Needs you too, which opens the sheet at its row. Snapshots are `visual.spec.ts`'s.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { RawEvent } from '@software-factory/events';
import { adminService, consoleUrl, END, expect, ready, test, WIDTHS } from './support.ts';

const summary = (page: Page) => page.locator('#patching-summary');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Patching' });
const panel = (page: Page) => page.locator('#patching');
const rows = (page: Page) => panel(page).locator('.pm > button');
const row = (page: Page, name: string) => rows(page).filter({ has: page.locator(`.name:text-is("${name}")`) });

/** The console, and Patching's sheet opened from its summary. */
async function patching(page: Page, as: 'visitor' | 'martin' = 'visitor') {
  await adminService(page, as);
  await page.goto(consoleUrl());
  await ready(page);
  await summary(page).getByRole('button', { name: 'All 11 moves' }).click();
  await rows(page).first().waitFor();
}

test.use({ viewport: WIDTHS.desktop });

test('the summary counts every open finding and what the moves clear at a glance, and says why it needs Martin', async ({
  page,
}) => {
  await adminService(page, 'visitor');
  await page.goto(consoleUrl());
  await ready(page);
  const card = summary(page);
  await expect(card.getByRole('heading', { level: 2 })).toHaveText('Patching');
  await expect(card.locator('.panel-head .label')).toHaveText('11 moves · 4 wait on Martin');
  // Needs you's rule: moves wait on Martin, a deadline is within a day, and the scan failed.
  await expect(card).toHaveClass(/\battn\b/);
  await expect(card.locator('.clr-head span')).toHaveText(['C', 'H', 'M', 'L']);
  const [open, clears] = [card.locator('.sum-clr > div').nth(1), card.locator('.sum-clr > div').nth(2)];
  await expect(open.locator('.clr > span[aria-hidden]')).toHaveText(['C12', 'H1.4K', 'M11K', 'L4.2K']);
  await expect(open.locator('.sr')).toHaveText('All open: 12 Critical, 1,392 High, 11,141 Medium, 4,178 Low');
  await expect(open.locator('.clr > span[title="1,392"]')).toHaveText('H1.4K');
  // A Critical above zero is in the warm colour; what the moves clear, a minus in green.
  await expect(open.locator('.crit')).toHaveText('C12');
  await expect(clears.locator('> span').first()).toHaveText('The moves clear');
  await expect(clears.locator('.clr > span[aria-hidden]')).toHaveText(['C−9', 'H−245', 'M−1.1K', 'L−405']);
  await expect(clears.locator('.cleared')).toHaveCount(4);
  await expect(clears.locator('.sr')).toHaveText('The moves clear 9 Critical, 245 High, 1,073 Medium, 405 Low');
  await expect(card.locator('.sum-lines li')).toHaveText([
    '1 unscanned image running',
    'Next due in 8 h: example/scanner-proxy',
    'Scan failed today · 05:21',
  ]);
  await expect(card.locator('.sum-lines li.tone-attn')).toHaveCount(3);

  const scan = await new AxeBuilder({ page })
    .include('#patching-summary')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);

  // Its link opens the sheet, its title focused; Escape closes it, and focus is back on the link.
  const link = card.getByRole('button', { name: 'All 11 moves' });
  await link.click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole('heading', { level: 2, name: 'Patching' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(link).toBeFocused();
});

test('a visitor reads the day: what waits on Martin first, then by deadline, and the scan’s day in a line', async ({
  page,
}) => {
  await patching(page);
  await expect(sheet(page).locator('.sheet-head .panel-count')).toHaveText(
    '11 moves · 1 unscanned image running · 4 wait on Martin · Read only',
  );
  await expect(panel(page).locator('.pm .name')).toHaveText([
    'example-cd',
    'example-logs',
    'k3s',
    'Unscanned image running',
    'example/scanner-proxy',
    'A package in the app’s lockfile',
    'example-dashboards',
    'example/sbom-tool',
    'example/sidecar',
    'example/node-base',
    '@example/tokens',
    'example/cluster-proxy',
  ]);
  await expect(panel(page).locator('.pm.wait')).toHaveCount(4);
  await expect(panel(page).locator('.pm.wait .v').first()).toHaveText('Waits on Martin');
  await expect(row(page, 'A package in the app’s lockfile')).toContainText('versions once its pull request opens');
  await expect(panel(page).locator('.patch-day')).toContainText('Scan failed today');
  await expect(panel(page).locator('.patch-day')).toContainText(
    '41 new High or Critical: 6 have a fix (in 2 moves below), 35 have none yet',
  );
  await expect(panel(page).locator('.patch-counts b')).toHaveText(['15,056', '1,732', '0', '0']);
  // The Clears column under its headers, and All open under the rows as its total.
  await expect(panel(page).locator('.pm-head .clr-head span')).toHaveText(['C', 'H', 'M', 'L']);
  await expect(panel(page).locator('.pm-total .label')).toHaveText('All open');
  await expect(panel(page).locator('.pm-total .clr > span[aria-hidden]')).toHaveText(['C12', 'H1.4K', 'M11K', 'L4.2K']);
  const [head, total] = [panel(page).locator('.pm-head .clr-head'), panel(page).locator('.pm-total .clr')];
  expect((await head.boundingBox())?.x).toBe((await total.boundingBox())?.x);
  // Nothing of code scanning for a visitor, who cannot open it.
  await expect(panel(page).getByRole('link', { name: /Code scanning/ })).toHaveCount(0);

  const scan = await new AxeBuilder({ page })
    .include('#patching')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test('a row opens in place, one at a time: why it waits, what to do, what it clears and every pin', async ({
  page,
}) => {
  await patching(page, 'martin');
  const logs = row(page, 'example-logs');
  await logs.click();
  await expect(logs).toHaveAttribute('aria-expanded', 'true');
  const more = panel(page).locator(`#${await logs.getAttribute('aria-controls')}`);
  await expect(more).toContainText('Its fix is a major one, so the review gate passes it only with your approval.');
  await expect(more).toContainText('Move it in a pull request of your own, and review it there.');
  await expect(more).toContainText('Clears · 56 findings');
  await expect(more).toContainText('1 Critical, 21 High, 30 Medium, 4 Low');
  await expect(more.getByRole('link', { name: /Code scanning/ })).toHaveAttribute(
    'href',
    'https://github.com/the-roganator/cv-software-factory/security/code-scanning',
  );
  await expect(more.locator('.pins')).toContainText('telemetry/logs.yaml:14');

  const sbom = row(page, 'example/sbom-tool');
  await sbom.click();
  await expect(sbom).toHaveAttribute('aria-expanded', 'true');
  await expect(logs).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page).locator('.more')).toHaveCount(1);
  await expect(panel(page).locator('.more')).toContainText('Dependabot opened #1339, to v1.55.1');
});

test('Martin reads the app’s lockfile move whole, and “you” for himself', async ({ page }) => {
  await patching(page, 'martin');
  await expect(sheet(page).locator('.sheet-head .panel-count')).toHaveText(
    '11 moves · 1 unscanned image running · 4 wait on you',
  );
  await expect(row(page, '@example/parser')).toContainText('4.2.0 → 4.2.3');
  await expect(panel(page).locator('.pm.wait .v').first()).toHaveText('Waits on you');
});

/** The samples' events, as the stream would have sent them, and one after them. */
const SAMPLES = readFileSync(
  fileURLToPath(new URL('../../../packages/samples/log/events.ndjson', import.meta.url)),
  'utf-8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as RawEvent & { ts: string; seq: number; payload: unknown });
const LAST = SAMPLES.at(-1)?.seq ?? 0;
const after = (n: number, like: (typeof SAMPLES)[number], payload = like.payload) =>
  ({
    ...like,
    id: `patching-after-${n}`,
    seq: LAST + n,
    ts: new Date(END + n * 1000).toISOString(),
    payload,
  }) as RawEvent;

test('an event Patching does not read renders nothing in its summary or sheet, and a new day renders each once', async ({
  page,
}) => {
  // A stream that says the store holds samples and then sends what the test gives it, as the bird's test does.
  await page.addInitScript(() => {
    const scope = globalThis as unknown as { sfStream: unknown; EventSource: unknown };
    class Stream extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        super();
        scope.sfStream = this;
        setTimeout(() => {
          this.onopen?.(new Event('open'));
          this.dispatchEvent(new MessageEvent('store', { data: JSON.stringify({ kind: 'sample' }) }));
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
    }
    scope.EventSource = Stream;
  });
  // A time a minute past the samples' end, which holds every event this test sends.
  const at = new Date(END + 60_000).toISOString();
  await page.goto(`/?t=${at}&theme=paper&motion=off&debug=renders&sheet=patching`);
  await ready(page);
  await rows(page).first().waitFor();
  const send = (raw: RawEvent) =>
    page.evaluate((raw) => {
      const stream = (globalThis as unknown as { sfStream: { onmessage: (event: MessageEvent) => void } }).sfStream;
      stream.onmessage(new MessageEvent('message', { data: JSON.stringify(raw) }));
    }, raw);
  const renders = () =>
    page.evaluate(() => {
      const counted = (globalThis as { sfRenders?: { patching?: number; patchingSheet?: number } }).sfRenders;
      return [counted?.patching ?? -1, counted?.patchingSheet ?? -1];
    });
  const before = await renders();
  expect(before.every((n) => n > 0)).toBe(true);

  // Martin's change of his controls, which the header and Controls read, and Patching does not.
  const controls = SAMPLES.findLast((e) => e.type === 'controls.changed');
  if (!controls) throw new Error('the samples have no controls.changed');
  await send(after(1, controls));
  await expect(page.locator('#patching')).toBeVisible();
  // Long enough for a render to have happened.
  await page.waitForTimeout(500);
  expect(await renders()).toEqual(before);

  // A new day from the sense, with the unscanned image gone, from a scan made before every open finding was counted.
  const day = SAMPLES.findLast((e) => e.type === 'patching.read');
  if (!day) throw new Error('the samples have no patching.read');
  type Totals = Record<string, unknown> & { open?: unknown };
  const sent = day.payload as { rows: unknown[]; repositories: { totals: Totals | null }[] };
  const payload = {
    ...sent,
    rows: [],
    repositories: sent.repositories.map((r) => {
      if (!r.totals) return r;
      const { open: _, ...totals } = r.totals;
      return { ...r, totals };
    }),
  };
  await send(after(2, day, payload));
  await expect(sheet(page).locator('.sheet-head .panel-count')).toHaveText('11 moves · 3 wait on Martin · Read only');
  await expect(summary(page).locator('.panel-head .label')).toHaveText('11 moves · 3 wait on Martin');
  expect(await renders()).toEqual(before.map((n) => n + 1));
  // All open is a dash under each header, in the summary and under the sheet's rows, never a figure worked out from
  // what the moves clear; what they clear is still there.
  for (const counts of [summary(page).locator('.sum-clr > div').nth(1), panel(page).locator('.pm-total')]) {
    await expect(counts.locator('.clr > span[aria-hidden]')).toHaveText(['C—', 'H—', 'M—', 'L—']);
    await expect(counts.locator('.sr')).toHaveText(
      'All open: not counted: the day’s scan is from before every open finding was counted',
    );
  }
  await expect(summary(page).locator('.sum-clr > div').nth(2).locator('.cleared')).toHaveCount(4);
});

test('each move that waits on Martin is a card in Needs you, which opens its row in Patching', async ({ page }) => {
  await adminService(page, 'martin');
  await page.goto(consoleUrl());
  await ready(page);
  const cards = page.locator('article.needs .need').filter({ has: page.locator('.kick b', { hasText: /^Patch · / }) });
  await expect(cards.locator('h3')).toHaveText([
    'example-cd needs moving by hand',
    'example-logs waits for a review',
    'k3s needs the cluster moved',
    'An unscanned image is running',
  ]);
  await expect(cards.locator('.kick b')).toHaveText([
    'Patch · an issue',
    'Patch · your approval',
    'Patch · your cluster',
    'Patch · your cluster',
  ]);
  const logs = cards.filter({ hasText: 'example-logs waits for a review' });
  await expect(logs.locator('.ev')).toHaveText(
    'Clears 1 Critical and 21 High. It changes more than a pin, or its fix is a major one, so the review gate passes its pull request only with your approval.',
  );
  // A card has no answer of its own: the move is moved on GitHub or the cluster, and the card goes with the next day.
  await expect(logs.locator('.answers')).toHaveCount(0);
  const open = logs.getByRole('button', { name: 'Open its row in Patching' });
  await open.click();
  // Patching's sheet, at the card's row: opened, scrolled to and focused.
  await expect(sheet(page)).toBeVisible();
  await expect(row(page, 'example-logs')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'example-logs')).toBeInViewport();
  await expect(row(page, 'example-logs')).toBeFocused();
  // Closed, focus is back on the card's link.
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(open).toBeFocused();
});

test('the address opens the sheet at a row: opened, scrolled to and focused', async ({ page }) => {
  await page.goto(`${consoleUrl()}&move=${encodeURIComponent('the-roganator/cv-software-factory example/sidecar')}`);
  await expect(sheet(page)).toBeVisible();
  await expect(row(page, 'example/sidecar')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'example/sidecar')).toBeInViewport();
  await expect(row(page, 'example/sidecar')).toBeFocused();
});
