/**
 * Patching (milestone 7, task 32), from the samples' days: its summary in the bottom row, every open finding and what
 * the moves clear under C, H, M and L, read at a glance, and why it needs Martin; and its sheet, which the summary
 * opens. What waits on Martin grouped by what he does, each group by deadline, then what moves by itself, then Done in
 * the last 28 days, closed until opened; a row opens in place, one at a time, with why it waits, what failed and its
 * run, and its one way forward on GitHub; a visitor reads it read-only, a lockfile's package withheld and, of one that
 * waits on Martin, what it waits for, and Martin reads it whole. An event neither reads renders nothing in either,
 * while a new day renders each once, and a day the sense read long ago says so. Needs you has one Patching card,
 * which opens the sheet. Snapshots are `visual.spec.ts`'s.
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
const card = (page: Page) =>
  page.locator('article.needs .need').filter({ has: page.locator('.kick b', { hasText: /^Patching$/ }) });

/** The console, and Patching's sheet opened from its summary. */
async function patching(page: Page, as: 'visitor' | 'martin' = 'visitor', at?: number) {
  await adminService(page, as);
  await page.goto(consoleUrl({ at }));
  await ready(page);
  await summary(page).getByRole('button', { name: 'All 22 moves' }).click();
  await rows(page).first().waitFor();
}

test.use({ viewport: WIDTHS.desktop });

test('the summary counts every open finding and what the moves clear at a glance, and says why it needs Martin', async ({
  page,
}) => {
  await adminService(page, 'visitor');
  await page.goto(consoleUrl());
  await ready(page);
  const shown = summary(page);
  await expect(shown.getByRole('heading', { level: 2 })).toHaveText('Patching');
  await expect(shown.locator('.panel-head .label')).toHaveText('22 moves · 16 wait on Martin');
  // Needs you's rule: moves wait on Martin, a deadline is within a day, and the scan failed.
  await expect(shown).toHaveClass(/\battn\b/);
  await expect(shown.locator('.clr-head span')).toHaveText(['C', 'H', 'M', 'L']);
  const [open, clears] = [shown.locator('.sum-clr > div').nth(1), shown.locator('.sum-clr > div').nth(2)];
  await expect(open.locator('.clr > span[aria-hidden]')).toHaveText(['C12', 'H1.4K', 'M11K', 'L4.2K']);
  await expect(open.locator('.sr')).toHaveText('All open: 12 Critical, 1,392 High, 11,141 Medium, 4,178 Low');
  await expect(open.locator('.crit')).toHaveText('C12');
  await expect(clears.locator('> span').first()).toHaveText('The moves clear');
  await expect(clears.locator('.clr > span[aria-hidden]')).toHaveText(['C−10', 'H−264', 'M−1.1K', 'L−407']);
  await expect(clears.locator('.sr')).toHaveText('The moves clear 10 Critical, 264 High, 1,089 Medium, 407 Low');
  await expect(shown.locator('.sum-lines li')).toHaveText([
    '1 unscanned image running',
    'Next due in 8 h: example/scanner-proxy',
    'Scan failed today · 05:21',
  ]);
  await expect(shown.locator('.sum-lines li.tone-attn')).toHaveCount(3);

  const scan = await new AxeBuilder({ page })
    .include('#patching-summary')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);

  // Its link opens the sheet, its title focused; Escape closes it, and focus is back on the link.
  const link = shown.getByRole('button', { name: 'All 22 moves' });
  await link.click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole('heading', { level: 2, name: 'Patching' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(link).toBeFocused();
});

test('a visitor reads what waits on Martin by what he does, what moves by itself, and the day in two lines', async ({
  page,
}) => {
  await patching(page);
  await expect(sheet(page).locator('.sheet-head .panel-count')).toHaveText(
    '22 moves · 1 unscanned image running · 16 wait on Martin · Read only',
  );
  await expect(panel(page).locator('.pm-group h3')).toHaveText([
    'Martin’s to approve · 2',
    'Held by a person · 2',
    'Tried and stopped · 3',
    'Martin’s to do by hand · 5',
    'Waits on Martin · 4',
    'Moving by itself · 7',
  ]);
  await expect(panel(page).locator('.pm.wait')).toHaveCount(16);
  await expect(panel(page).locator('.pm.wait .v').first()).toHaveText('Approve');
  // The factory's lockfile moves that wait on Martin: nothing of what they wait for, nor their numbers.
  const withheld = row(page, 'A package in the factory’s lockfile');
  await expect(withheld).toHaveCount(4);
  for (const each of await withheld.all()) {
    await expect(each.locator('.v')).toHaveText('Waits on Martin');
    await expect(each.locator('.ft')).toHaveText('versions withheld');
    await expect(each.locator('.clr')).toHaveText('withheld');
    await expect(each.locator('.route')).toHaveText('Martin’s approval');
  }
  await withheld.first().click();
  await expect(panel(page).locator('.more')).toContainText(
    'Its package is withheld while it has an open finding, and so is what it waits for. Martin sees both, signed in.',
  );
  await expect(panel(page).locator('.more a.way')).toHaveCount(0);
  // The moves in flight, each its state, and a major left to clear the rest.
  await expect(row(page, 'example/scanner-proxy').locator('.v')).toHaveText('Checks running');
  await expect(row(page, 'example-dashboards').locator('.v')).toHaveText('In the merge queue');
  await expect(row(page, 'example-dashboards')).toContainText('a major clears the rest');
  await expect(row(page, 'example/cache').locator('.v')).toHaveText('Waits its day');
  await expect(row(page, 'example/cluster-proxy').locator('.v')).toHaveText('Nothing to move to');
  await expect(row(page, 'example-logs').locator('.route')).toHaveText('Martin’s approval · #1344');
  await expect(row(page, 'example/setup-tool').locator('.route')).toHaveText('Dependabot · #1350');
  await expect(panel(page).locator('.patch-day').first()).toContainText(
    '41 new High or Critical: 6 have a fix (in 2 moves below), 35 have none yet',
  );
  await expect(panel(page).locator('.patch-read')).toHaveText(
    'Judged: the factory’s 05:16 · the app’s 05:20 · pull requests read 06:12 · 1 fix waits its day (example/cache, below)',
  );
  await expect(panel(page).locator('.patch-stale')).toHaveCount(0);
  await expect(panel(page).locator('.patch-counts b')).toHaveText(['15,056', '1,770', '0', '0']);
  await expect(panel(page).locator('.pm-head .clr-head span')).toHaveText(['C', 'H', 'M', 'L']);
  await expect(panel(page).locator('.pm-total .clr > span[aria-hidden]')).toHaveText(['C12', 'H1.4K', 'M11K', 'L4.2K']);
  await expect(panel(page).getByRole('link', { name: /Code scanning/ })).toHaveCount(0);

  const scan = await new AxeBuilder({ page })
    .include('#patching')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test('Done in the last 28 days is closed until opened: what merged, and what is no longer listed', async ({ page }) => {
  await patching(page);
  const done = panel(page).locator('.pm-group.done button');
  await expect(done).toHaveText('Done in the last 28 days · 4');
  await expect(done).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page).locator('.pm-group.done .help')).toHaveText(
    '2 merged, 2 no longer listed · cleared 2 Critical, 30 High, 22 Medium, 6 Low',
  );
  await expect(row(page, 'example/old-sidecar')).toHaveCount(0);
  await done.click();
  await expect(done).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'example/old-sidecar').locator('.v')).toHaveText('Merged');
  await expect(row(page, 'example/runtime').locator('.v')).toHaveText('No longer listed');
  // A lockfile's merged move keeps its withholding: its package and what it cleared.
  const ws = rows(page).filter({ hasText: '#1327' });
  await expect(ws.locator('.name')).toHaveText('A package in the factory’s lockfile');
  await expect(ws.locator('.clr')).toHaveText('withheld');
  const closed = rows(page).filter({ hasText: '#1180' });
  await closed.click();
  await expect(panel(page).locator('.more')).toContainText('The move goes on under its new target, 13.7.2.');
});

test('a row opens in place, one at a time: why it waits, what failed and its run, and the way forward', async ({
  page,
}) => {
  await patching(page, 'martin');
  const sidecar = row(page, 'example/sidecar');
  await sidecar.click();
  await expect(sidecar).toHaveAttribute('aria-expanded', 'true');
  const more = panel(page).locator(`#${await sidecar.getAttribute('aria-controls')}`);
  await expect(more).toContainText(
    'The review gate passed #1348 as the scan’s move, and its required checks failed on each of its 3 tries, so the worker stopped trying.',
  );
  // A failed check by its name, its try and its run: never its log.
  await expect(more.locator('p.failed-run')).toHaveText('database tests · failed · try 3 of 3 · its run ↗');
  await expect(more.locator('p.run a')).toHaveAttribute(
    'href',
    'https://github.com/the-roganator/cv-software-factory/actions/runs/19220481337',
  );
  await expect(more.getByRole('link', { name: 'Open #1348 on GitHub (opens GitHub in a new tab)' })).toHaveAttribute(
    'href',
    'https://github.com/the-roganator/cv-software-factory/pull/1348',
  );
  await expect(more).toContainText('Left as it is, the scan fails from');
  await expect(more).toContainText('Clears · 60 findings');
  await expect(more.getByRole('link', { name: /Code scanning/ })).toHaveAttribute(
    'href',
    'https://github.com/the-roganator/cv-software-factory/security/code-scanning',
  );

  const logs = row(page, 'example-logs');
  await logs.click();
  await expect(sidecar).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page).locator('.more')).toHaveCount(1);
  await expect(panel(page).locator('.more')).toContainText(
    'The review gate passed #1344 as a major: exactly the scan’s move, and a major. Below Lights-out a major waits for you; at Lights-out it would merge by itself.',
  );
});

test('Martin reads every lockfile move named, grouped by what it asks of him, and a line move’s findings', async ({
  page,
}) => {
  await patching(page, 'martin');
  await expect(sheet(page).locator('.sheet-head .panel-count')).toHaveText(
    '22 moves · 1 unscanned image running · 15 wait on you',
  );
  await expect(panel(page).locator('.pm-group h3')).toHaveText([
    'Yours to approve · 2',
    'Waits for your bench run · 1',
    'Held by you · 3',
    'Tried and stopped · 4',
    'Yours to do by hand · 5',
    'Moving by itself · 7',
  ]);
  await expect(row(page, '@example/agent-sdk').locator('.route')).toHaveText('Your bench run · #1352');
  await expect(row(page, '@example/tokens')).toContainText('holds 1 more with it');
  await row(page, '@example/tokens').click();
  await expect(panel(page).locator('.more')).toContainText('Held with it');
  await expect(panel(page).locator('.more .pins')).toContainText('@example/ws');
  // The line's move lists its findings by package, severity and deadline, never an advisory.
  const parser = row(page, '@example/parser');
  await expect(parser).toContainText('4.2.0 → 4.2.3');
  await parser.click();
  const more = panel(page).locator('.more');
  await expect(more).toContainText('Its findings · 2');
  await expect(more).toContainText('Critical · due');
  await expect(more).not.toContainText('GHSA');
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
  await expect(sheet(page).locator('.sheet-head .panel-count')).toHaveText('22 moves · 15 wait on Martin · Read only');
  await expect(summary(page).locator('.panel-head .label')).toHaveText('22 moves · 15 wait on Martin');
  expect(await renders()).toEqual(before.map((n) => n + 1));
  for (const counts of [summary(page).locator('.sum-clr > div').nth(1), panel(page).locator('.pm-total')]) {
    await expect(counts.locator('.clr > span[aria-hidden]')).toHaveText(['C—', 'H—', 'M—', 'L—']);
    await expect(counts.locator('.sr')).toHaveText(
      'All open: not counted: the day’s scan is from before every open finding was counted',
    );
  }
  await expect(summary(page).locator('.sum-clr > div').nth(2).locator('.cleared')).toHaveCount(4);
});

test('Needs you has one Patching card, counting what waits by what Martin does, which opens the sheet', async ({
  page,
}) => {
  await adminService(page, 'martin');
  await page.goto(consoleUrl());
  await ready(page);
  await expect(card(page)).toHaveCount(1);
  await expect(card(page).locator('h3')).toHaveText('15 patches wait on you');
  await expect(card(page).locator('.kick span')).toHaveText('next due in 8 h');
  await expect(card(page).locator('.need-counts li')).toHaveText([
    '2 to approve',
    '1 bench run',
    '3 held by you',
    '4 tried and stopped',
    '5 to do by hand',
  ]);
  await expect(card(page)).toContainText('First due: example-cd, in 8 h.');
  // It has no answer of its own: each is answered on GitHub or the cluster, from its row.
  await expect(card(page).locator('.answers')).toHaveCount(0);
  const open = card(page).getByRole('button', { name: 'Open Patching' });
  await open.click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole('heading', { level: 2, name: 'Patching' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(open).toBeFocused();
});

test('a visitor’s card says what waits on Martin, the withheld apart', async ({ page }) => {
  await adminService(page, 'visitor');
  await page.goto(consoleUrl());
  await ready(page);
  await expect(card(page).locator('h3')).toHaveText('16 patches wait on Martin');
  await expect(card(page).locator('.need-counts li')).toHaveText([
    '2 to approve',
    '2 held by a person',
    '3 tried and stopped',
    '5 to do by hand',
    '4 waiting on Martin',
  ]);
  await expect(card(page).locator('.need-foot')).toContainText('Martin answers each, on GitHub or his cluster');
});

test('a day the sense read long ago says so, in the summary, the sheet and the card, and a scan past its 36 hours', async ({
  page,
}) => {
  // 40 hours on: the sense's read is 49 hours old, and both scans past their 36.
  const at = END + 40 * 3_600_000;
  await patching(page, 'visitor', at);
  const banners = panel(page).locator('.patch-stale');
  await expect(banners).toHaveCount(3);
  await expect(banners.first()).toContainText('The dependency sense has not read since');
  await expect(banners.first()).toContainText('Martin has been told.');
  await expect(banners.nth(1)).toContainText('The factory’s scan was last judged');
  await expect(banners.nth(1)).toContainText('every factory move below waits until a scan runs again');
  await page.keyboard.press('Escape');
  await expect(summary(page).locator('.sum-lines li').first()).toContainText('Not read since');
  await expect(card(page).locator('.ev.tone-attn').first()).toContainText('The dependency sense has not read since');
});

test('the address opens the sheet at a row: opened, scrolled to and focused', async ({ page }) => {
  await page.goto(`${consoleUrl()}&move=${encodeURIComponent('the-roganator/cv-software-factory example/sidecar')}`);
  await expect(sheet(page)).toBeVisible();
  await expect(row(page, 'example/sidecar')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'example/sidecar')).toBeInViewport();
  await expect(row(page, 'example/sidecar')).toBeFocused();
});
