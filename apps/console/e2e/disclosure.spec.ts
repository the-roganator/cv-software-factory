/**
 * A move's one moment of disclosure, from the samples' #1335: before the line opens its issue,
 * its card and sheet read “a package” with no versions and link no issue; from `issue.opened` on, they name the
 * package and its versions, and the sheet links the issue as it does the pull request (a sample's names it only).
 * Snapshots are `visual.spec.ts`'s.
 */
import type { Page } from '@playwright/test';
import { consoleUrl, expect, MOVE_NAMED, MOVE_WITHHELD, ready, test, WIDTHS } from './support.ts';

test.use({ viewport: WIDTHS.desktop });

const facts = (page: Page) => page.getByRole('dialog').locator('.facts-dl');
const fact = (page: Page, name: string) => facts(page).locator(`dt:text-is("${name}") + dd`);

test('a move’s card and sheet withhold its package until its issue opens', async ({ page }) => {
  await page.goto(consoleUrl({ item: '1335', at: MOVE_WITHHELD }));
  await ready(page);
  const card = page.locator('.card[data-place="centre"]');
  await expect(card.locator('.pkg .name')).toHaveText('a package');
  await expect(card).not.toContainText('@example/parser');
  await page.goto(consoleUrl({ item: '1335', sheet: true, at: MOVE_WITHHELD }));
  const sheet = page.getByRole('dialog', { name: /^Move a package in/ });
  await sheet.waitFor();
  await expect(sheet).not.toContainText('@example/parser');
  await expect(sheet).not.toContainText('4.2.3');
  await expect(facts(page)).toContainText('a package · npm');
  await expect(fact(page, 'Issue')).toHaveCount(0);
});

test('from its issue on, a move’s card and sheet name the package and its versions, and the sheet its issue', async ({
  page,
}) => {
  await page.goto(consoleUrl({ item: '1335', sheet: true, at: MOVE_NAMED }));
  const sheet = page.getByRole('dialog', { name: '@example/parser moves past a critical finding' });
  await sheet.waitFor();
  await expect(facts(page)).toContainText('@example/parser · npm');
  // A sample's issue never existed, so it is named and linked nowhere, as its pull request is.
  await expect(fact(page, 'Issue')).toHaveText('#1336');
  await expect(fact(page, 'Pull request')).toHaveText('#1337');
  await expect(sheet.getByRole('link', { name: /#1336/ })).toHaveCount(0);
  await expect(sheet.locator('.pkg .name').first()).toHaveText('@example/parser');
  await expect(sheet.locator('.pkg .bump').first()).toContainText('4.2.0→4.2.3');
});
