/**
 * The console keeps nothing on a visitor's device: no cookie, nothing in local or session storage, IndexedDB or Cache
 * Storage, no service worker, across its views, with the theme and motion changed on the page; and it asks no other
 * origin, which every test's guard holds (`support.ts`). Martin's one cookie, after he signs in, is
 * `signing-in.spec.ts`'s. And the privacy page, from the footer, which says so.
 */
import { adminService, consoleUrl, expect, keptInEvery, keptOnDevice, ready, test } from './support.ts';

test.beforeEach(({ page }) => adminService(page, 'visitor'));

test('a visitor keeps nothing on the device, whichever view they open', async ({ page }) => {
  const views: Array<[string, string, string]> = [
    ['the console, live and moving', '/', 'section.line'],
    ['a work item’s sheet', consoleUrl({ item: '1306', sheet: true, motion: true }), '.sheet-head'],
    ['the audit log', '/?view=audit', '.audit-page'],
    ['the settings', '/?view=settings', '.settings-page'],
    ['the privacy page', '/?view=privacy', '.privacy-page'],
    ['Martin’s sign-in', '/?view=sign-in', 'h1'],
    ['the enrolment door', '/?view=enrol', 'h1'],
  ];
  for (const [name, url, drawn] of views) {
    await test.step(name, async () => {
      await page.goto(url);
      await page.locator(drawn).first().waitFor();
      expect(await keptOnDevice(page)).toEqual([]);
    });
  }

  await test.step('Ink and Still are for this visit, and are not kept', async () => {
    await page.goto('/');
    await ready(page);
    await page.getByRole('button', { name: 'INK', exact: true }).click();
    await page.getByRole('button', { name: 'STILL', exact: true }).click();
    expect(await keptOnDevice(page)).toEqual([]);
    await page.reload();
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    expect(await keptOnDevice(page)).toEqual([]);
  });
});

test('the footer leads to the privacy page, which says what is kept and for how long', async ({ page }) => {
  await page.goto(consoleUrl());
  await ready(page);
  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\?view=privacy$/);
  await expect(page).toHaveTitle('Privacy · Software Factory');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  await expect(page.getByText('The console keeps nothing on your device: no cookies and no tracking.')).toBeVisible();
  await expect(page.locator('.privacy-page li').filter({ hasText: 'But Martin’s sign-in.' })).toContainText(
    '__Host-session, for 60 minutes',
  );
  await expect(page.locator('.privacy-page li').filter({ hasText: 'A preview of the app.' })).toContainText(
    'Then it keeps preview, for 24 hours from the last time you asked',
  );
  const kept = page.locator('table.privacy-kept tbody tr');
  await expect(kept).toHaveText([/^Logs.*7 days$/, /^Traces.*3 days$/, /^Metrics.*Up to 7 days$/]);
  await expect(page.locator('.privacy-page li').filter({ hasText: 'Your browser is recorded' })).toContainText(
    'Never your address.',
  );
  // The header and the footer are the console's, and the way back is the crumb.
  await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toBeVisible();
  await page.getByRole('link', { name: '← The console' }).click();
  await ready(page);
});

test.describe('the guard', () => {
  test('reads what a page keeps in another context, and in a popup', async ({ page, browser, baseURL }) => {
    await page.goto('/?view=privacy');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.evaluate(() => window.open('/?view=privacy'))]);
    await popup.waitForLoadState();
    await popup.evaluate(() => sessionStorage.setItem('left', 'by a popup'));
    const other = await browser.newContext({ baseURL: baseURL ?? '' });
    const elsewhere = await other.newPage();
    await elsewhere.goto('/?view=privacy');
    await elsewhere.evaluate(() => localStorage.setItem('left', 'in another context'));

    const kept = await keptInEvery([page.context(), other]);
    expect(kept).toContain(`sessionStorage left on ${new URL(popup.url()).origin}`);
    expect(kept).toContain(`localStorage left on ${new URL(elsewhere.url()).origin}`);

    await popup.evaluate(() => sessionStorage.clear());
    await other.close();
  });

  // Each of these keeps something where the default page cannot see it, or throws what nothing catches, so its guard
  // must fail it.
  test('fails a test that leaves something in a context of its own', async ({ browser, baseURL }) => {
    test.fail();
    const other = await browser.newPage({ baseURL: baseURL ?? '' });
    await other.goto('/?view=privacy');
    await other.evaluate(() => localStorage.setItem('left', 'in another context'));
  });

  test('fails a test that leaves something in a popup', async ({ page }) => {
    test.fail();
    await page.goto('/?view=privacy');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.evaluate(() => window.open('/?view=privacy'))]);
    await popup.waitForLoadState();
    await popup.evaluate(() => sessionStorage.setItem('left', 'by a popup'));
  });

  test('fails a test whose page throws something nothing catches', async ({ page }) => {
    test.fail();
    await page.goto('/?view=privacy');
    await Promise.all([
      page.waitForEvent('pageerror'),
      page.evaluate(() => {
        setTimeout(() => {
          throw Promise.resolve();
        }, 0);
      }),
    ]);
  });
});
