/**
 * The console's side of signing in, against a stand-in for the admin service: who the page takes the viewer for, the
 * account menu, what a write sends, and the doors' notes. `signing-in.spec.ts` takes the same doors through the real
 * service with a passkey.
 */
import { adminService, consoleUrl, expect, ready, SESSION, test } from './support.ts';

test('offers no sign-in where there is no admin service to sign in to', async ({ page }) => {
  // The console's server answers `/admin/session` with its own 404, as a deployment without the service does.
  await page.goto(consoleUrl());
  await ready(page);
  await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Martin', exact: true })).toHaveCount(0);
});

test('takes nothing less than a whole session for Martin’s', async ({ page }) => {
  // A token and nothing else, as something other than the service might answer: not Martin, and not the service.
  await page.route('**/admin/session', (route) => route.fulfill({ json: { token: 'test-token' } }));
  await page.goto(consoleUrl());
  await ready(page);
  await expect(page.getByRole('button', { name: 'Martin', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toHaveCount(0);
});

test('offers a visitor Martin’s sign-in in the footer, and nothing more', async ({ page }) => {
  await adminService(page, 'visitor');
  await page.goto(consoleUrl());
  await ready(page);
  await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toHaveAttribute('href', '/?view=sign-in');
  await expect(page.getByRole('button', { name: 'Martin', exact: true })).toHaveCount(0);
});

test('shows Martin his account, whose menu closes on a click outside', async ({ page }) => {
  await adminService(page, 'martin');
  await page.goto(consoleUrl());
  await ready(page);
  const account = page.getByRole('button', { name: 'Martin', exact: true });
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await account.click();
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  const menu = page.locator('#account-menu');
  // In London, where the tests' browser is: the session's hour, from 15:40.
  await expect(menu).toContainText('Signed in with a passkey at 15:40');
  await expect(menu).toContainText('The session ends at 16:40');
  await page.locator('section.intro h1').click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toHaveCount(0);
});

test('keeps the switches in a visitor’s header, and in Martin’s menu for him, with the tools he is told of', async ({
  page,
}) => {
  await adminService(page, 'visitor');
  await page.goto(consoleUrl());
  await ready(page);
  const header = page.locator('header.top');
  await expect(header.getByRole('group', { name: 'Theme' })).toBeVisible();
  await expect(header.getByRole('group', { name: 'Motion' })).toBeVisible();

  await page.unroute('**/admin/session');
  await adminService(page, 'martin');
  await page.goto(consoleUrl());
  await ready(page);
  await expect(header.getByRole('group', { name: 'Theme' })).toBeHidden();
  await expect(header.getByRole('button', { name: 'Preview as visitor' })).toBeHidden();
  await page.getByRole('button', { name: 'Martin', exact: true }).click();
  const menu = page.locator('#account-menu');
  await menu.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'INK' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ink');
  // Each tool opens in a new tab, with no hold on this one.
  for (const [name, href] of [
    ['Grafana', SESSION.tools.grafana],
    ['Argo CD', SESSION.tools.argocd],
  ] as const) {
    const link = menu.getByRole('link', { name: new RegExp(`^${name}`) });
    await expect(link).toHaveAttribute('href', href);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener');
    await expect(link).toContainText('(opens in a new tab)');
  }
});

for (const [grafana, argocd] of [
  ['http://[::1', 'javascript:alert(1)'],
  ['https://admin:secret@grafana.example', 'ftp://argocd.example'],
]) {
  test(`draws no link to a tool at ${grafana} or ${argocd}`, async ({ page }) => {
    // An address that does not parse, one with credentials in it, or one that is not http or https.
    await page.route('**/admin/session', (route) =>
      route.fulfill({ json: { ...SESSION, tools: { grafana, argocd } } }),
    );
    await page.goto(consoleUrl());
    await ready(page);
    await page.getByRole('button', { name: 'Martin', exact: true }).click();
    const menu = page.locator('#account-menu');
    await expect(menu).toContainText('Settings');
    await expect(menu.getByRole('link', { name: /^Grafana|^Argo CD/ })).toHaveCount(0);
  });
}

test('takes anyone home from the brand, and names the footer’s icons', async ({ page }) => {
  await adminService(page, 'visitor');
  await page.goto('/?view=privacy');
  const footer = page.locator('footer');
  await expect(footer).toContainText('© 2026 Martin Rogan · MIT');
  await expect(footer.getByRole('link', { name: 'MIT' })).toHaveAttribute(
    'href',
    'https://github.com/the-roganator/cv-software-factory/blob/main/LICENSE',
  );
  await expect(footer.getByRole('link', { name: 'The source on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/the-roganator/cv-software-factory',
  );
  await expect(footer.getByRole('link', { name: 'Martin Rogan on LinkedIn' })).toHaveAttribute(
    'href',
    'https://www.linkedin.com/in/martinrogan/',
  );
  await expect(footer.getByRole('link', { name: 'Martin’s sign-in' })).toHaveAttribute('title', 'Martin’s sign-in');
  await expect(footer.getByRole('link', { name: 'Why it exists' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Software Factory: Martin Rogan, a live CV, home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await ready(page);
  // On the console itself it goes to the top, and nothing is reloaded.
  await expect(page.getByRole('link', { name: 'Software Factory: Martin Rogan, a live CV, home' })).toHaveAttribute(
    'href',
    '#top',
  );
  // The icons are drawn on the doors too, which have a page of their own.
  await page.goto('/?view=sign-in');
  await expect(page.locator('#logo-github')).toHaveCount(1);
  await expect(page.locator('#logo-linkedin')).toHaveCount(1);
});

test('signs out with a POST of JSON carrying the session’s token, and lands on the door that says so', async ({
  page,
}) => {
  await adminService(page, 'martin');
  const sent: { method: string; type: string | undefined; token: string | undefined; body: string | null }[] = [];
  await page.route('**/admin/sign-out*', (route) => {
    const request = route.request();
    sent.push({
      method: request.method(),
      type: request.headers()['content-type'],
      token: request.headers()['x-csrf-token'],
      body: request.postData(),
    });
    return route.fulfill({ json: { signedOut: 'everywhere' } });
  });
  await page.goto(consoleUrl());
  await ready(page);
  await page.getByRole('button', { name: 'Martin', exact: true }).click();
  // The door asks the service again, which now finds no session.
  await page.unroute('**/admin/session');
  await adminService(page, 'visitor');
  await page.getByRole('button', { name: /Sign out everywhere/ }).click();
  await expect(page).toHaveURL(/\/\?view=sign-in&ended=everywhere$/);
  await expect(page.getByRole('status')).toHaveText(
    'Signed out everywhere: every session on every device has ended, this one too.',
  );
  expect(sent).toEqual([{ method: 'POST', type: 'application/json', token: SESSION.token, body: '{}' }]);
});

test('says when the session ended, and why, in the viewer’s own time', async ({ page }) => {
  await adminService(page, 'visitor');
  await page.goto(`/?view=sign-in&ended=expired&at=${encodeURIComponent(SESSION.expiresAt)}`);
  await expect(page.getByRole('status')).toHaveText(
    'Your session ended at 16:40. A session lasts 60 minutes from signing in, however busy.',
  );
});

test('sends a signed-in browser from the sign-in door to the console', async ({ page }) => {
  await adminService(page, 'martin');
  await page.goto('/?view=sign-in');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Martin', exact: true })).toBeVisible();
});

test('says the service’s own words when it refuses, and ours when it cannot be reached', async ({ page }) => {
  await adminService(page, 'visitor');
  await page.route('**/admin/sign-in/options', (route) =>
    route.fulfill({
      status: 429,
      json: { refused: 'rate', message: 'Too many tries from here: wait, then try again.' },
    }),
  );
  await page.goto('/?view=sign-in');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toHaveText('Too many tries from here: wait, then try again.');
  await page.unroute('**/admin/sign-in/options');
  await page.route('**/admin/sign-in/options', (route) => route.abort());
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toHaveText('The admin service can’t be reached. Try again in a moment.');
});

test('enrolment: a code that can no longer be used disables the field, and the foot names recovery', async ({
  page,
}) => {
  await adminService(page, 'visitor');
  await page.route('**/admin/enrol/options', (route) =>
    route.fulfill({ status: 403, json: { refused: 'code', message: 'That code can’t be used any more.', left: 0 } }),
  );
  await page.goto('/?view=enrol');
  await expect(page.locator('.steps-list li.past')).toHaveCount(1);
  await page.getByLabel('One-time code').fill('AAAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
  await page.getByRole('button', { name: 'Check the code' }).click();
  await expect(page.getByRole('alert')).toContainText('It has expired, been used, or had its five tries.');
  await expect(page.getByLabel('One-time code')).toBeDisabled();
  await expect(page.getByText('factory admin enrol --revoke-others')).toBeVisible();
});
