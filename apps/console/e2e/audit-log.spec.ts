/**
 * The audit log (`?view=audit`), from the samples: every event a row, newest first, the same for a visitor and for
 * Martin, whose page reads the public stream like anyone's and never his full events; what a visitor wrote left out and
 * saying so; the filters, kept in the address; Show older; and the ways to it from Controls, the account menu and the
 * footer. Against the real admin service, `martin.spec.ts` checks the same of Martin's page. Snapshots are
 * `visual.spec.ts`'s.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MARTINS_WORDS, REPORT_SHOWN } from './full.ts';
import { adminService, consoleUrl, END, expect, ready, THEMES, test, WIDTHS } from './support.ts';

const auditUrl = (theme: 'paper' | 'ink' = 'paper', more = '') => `${consoleUrl({ theme })}&view=audit${more}`;

/** The audit log drawn, with the fonts it is set in. */
async function audit(page: Page, theme: 'paper' | 'ink' = 'paper', more = '') {
  await page.goto(auditUrl(theme, more));
  await page.locator('table.audit tbody tr:not(.day)').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

const rows = (page: Page) => page.locator('table.audit tbody tr:not(.day, .none)');
const caption = (page: Page) => page.locator('table.audit caption');

/** The event streams the page opens, by path, as they open. */
function streams(page: Page): string[] {
  const opened: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.endsWith('/stream') || pathname.startsWith('/admin/events')) opened.push(pathname);
  });
  return opened;
}

test('a visitor reads every event, newest first, with what a visitor wrote left out', async ({ page }) => {
  await adminService(page, 'visitor');
  await audit(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Audit log');
  await expect(caption(page)).toHaveText(
    /^Showing the latest 100, of \d+ in all\. Martin’s own actions are ruled on the left\.$/,
  );
  await expect(rows(page)).toHaveCount(100);
  await expect(page.locator('tr.day th').first()).toHaveText('Today');
  // The newest event first, at the samples' last moment.
  await expect(rows(page).first().locator('time')).toHaveAttribute('datetime', new Date(END).toISOString());

  await page.getByLabel('Work item').fill('1329');
  const report = rows(page).filter({ hasText: 'A visitor reported a problem on /search' });
  await expect(report).toContainText('Its text is left out: a visitor wrote it.');
  await expect(report.locator('.withheld')).toHaveCSS('font-style', 'italic');
  const answered = rows(page).filter({ hasText: 'Martin answered the hold in words' });
  await expect(answered).toHaveClass('martin');
  await expect(answered).toContainText('His words stay his: the hold was about a visitor’s report.');

  await page.getByLabel('Work item').fill('1315');
  const refused = rows(page).filter({ hasText: 'The scope fence refused' }).first();
  await expect(refused.locator('.audit-what')).toHaveClass('audit-what refused');
});

test('Martin, signed in, reads the same rows from the public stream, never his full events', async ({ page }) => {
  await adminService(page, 'visitor');
  await audit(page, 'paper', '&item=1329');
  const visitors = await rows(page).allInnerTexts();

  const opened = streams(page);
  await adminService(page, 'martin');
  await audit(page, 'paper', '&item=1329');
  await expect(page.getByRole('button', { name: 'Martin', exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(visitors.length);
  expect(await rows(page).allInnerTexts()).toEqual(visitors);
  await expect(page.locator('main')).not.toContainText(REPORT_SHOWN.slice(0, 20));
  await expect(page.locator('main')).not.toContainText(MARTINS_WORDS);
  expect(opened).toEqual(['/api/events/stream']);
});

test('the filters narrow the log, live in the address, and say when nothing matches', async ({ page }) => {
  await audit(page);
  const total = Number((await caption(page).textContent())?.match(/of ([\d,]+) in all/)?.[1]?.replace(',', ''));

  await page.getByLabel('Actor', { exact: true }).selectOption({ label: 'the coder' });
  await expect(rows(page).locator('.who')).toHaveText(Array(await rows(page).count()).fill('the coder'));
  await expect(page).toHaveURL(/[?&]actor=coder(&|$)/);

  await page.getByRole('button', { name: 'Agent actions' }).click();
  await expect(page.getByRole('button', { name: 'Agent actions' })).toHaveAttribute('aria-pressed', 'false');
  await expect(rows(page).locator('.kindw')).toHaveText(Array(await rows(page).count()).fill('Model call'));
  await expect(page).toHaveURL(/[?&]kinds=admin%2Cmodel(&|$)/);

  await page.getByLabel('Work item').fill('#1315');
  await expect(caption(page)).toContainText(`that match, of ${total.toLocaleString('en-GB')} in all.`);
  await expect(rows(page).locator('.item')).toHaveText(Array(await rows(page).count()).fill('#1315'));

  // The same filters, from the address.
  await page.reload();
  await expect(page.getByLabel('Actor', { exact: true })).toHaveValue('coder');
  await expect(page.getByLabel('Work item')).toHaveValue('1315');
  await expect(page.getByRole('button', { name: 'Agent actions' })).toHaveAttribute('aria-pressed', 'false');

  // Every kind off matches nothing, from the address too.
  await page.goto(auditUrl('paper', '&kinds=none'));
  await expect(page.locator('tr.none')).toBeVisible();
  for (const name of ['Admin actions', 'Agent actions', 'Model calls'])
    await expect(page.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Model calls' }).click();
  await page.getByRole('button', { name: 'Model calls' }).click();
  await expect(page).toHaveURL(/[?&]kinds=none(&|$)/);

  await page.goto(auditUrl());
  await page.getByLabel('Actor', { exact: true }).selectOption({ label: 'the describer' });
  await page.getByLabel('Work item').fill('1293');
  await expect(page.locator('tr.none')).toHaveText(
    'Nothing matches. Each filter narrows the log: clear one to see more.',
  );
  await expect(caption(page)).toHaveText(`None of the ${total.toLocaleString('en-GB')} in all match.`);
});

test('Show older adds the next hundred below, and a work item’s number opens its sheet', async ({ page }) => {
  await audit(page);
  await expect(rows(page)).toHaveCount(100);
  const last = await rows(page).last().innerText();
  await page.getByRole('button', { name: 'Show older' }).click();
  await expect(rows(page)).toHaveCount(200);
  expect(await rows(page).nth(99).innerText()).toBe(last);
  await expect(caption(page)).toContainText('Showing the latest 200,');

  await page.getByLabel('Work item').fill('1315');
  await rows(page).first().getByRole('link', { name: '#1315' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('the way to it from Controls, the account menu and the footer', async ({ page }) => {
  await adminService(page, 'martin');
  await page.goto(consoleUrl());
  await ready(page);
  await page.getByRole('article', { name: 'Controls' }).getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Audit log');

  await page.getByRole('link', { name: '← The console' }).click();
  await ready(page);
  await page.getByRole('button', { name: 'Martin', exact: true }).click();
  const menu = page.locator('#account-menu');
  await expect(menu.locator('a, button')).toHaveText([
    'Settings',
    'Audit log',
    'Preview as visitor',
    /^Grafana/,
    /^Argo CD/,
    'PAPER',
    'INK',
    'MOTION',
    'STILL',
    'Sign out',
    /^Sign out everywhere/,
  ]);
  await menu.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Audit log');

  await adminService(page, 'visitor');
  await page.goto('/?view=sign-in');
  await page.locator('footer').getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Audit log');
  await expect(page.locator('footer').getByRole('link', { name: 'Martin’s sign-in' })).toBeVisible();
});

for (const [width, viewport] of Object.entries(WIDTHS)) {
  for (const theme of THEMES) {
    test(`the audit log at ${width}, ${theme}, has nothing for axe to find`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await adminService(page, 'visitor');
      await audit(page, theme, '&item=1329');
      const axe = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
      expect((await axe.analyze()).violations).toEqual([]);
      // Nothing is wider than the page.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    });
  }
}
