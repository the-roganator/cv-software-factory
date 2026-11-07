/**
 * A new cluster's console, end to end: the store holds nothing, as `make up` leaves it, and the line has not started.
 * The header says so, calmly, every station is idle, Controls has Every ticket chosen, and Martin's button reads Start
 * the line, whose dialog says this is the first start and takes every ticket. Against the real admin service on a
 * throwaway store, behind the proxy standing in for Traefik (`admin.ts`), with a virtual passkey. Needs Postgres:
 * TEST_DATABASE_URL, or Docker.
 */
import type { Page } from '@playwright/test';
import { enrolThroughTheDoor, type Harness, startHarness, virtualPasskey } from './admin.ts';
import { expect, test } from './support.ts';

const PORT = 18_344;

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;
test.beforeAll(async () => {
  harness = await startHarness(PORT, 'first_start', undefined, 'empty');
});
test.afterAll(async () => {
  await harness?.stop();
});

const status = (page: Page) => page.locator('header.top .status');
const take = (page: Page) => page.locator('article.controls').getByRole('group', { name: 'What the line takes' });

test('a visitor sees a line not started, idle and calm, taking every ticket once it starts', async ({ page }) => {
  await page.goto('/?motion=off');
  await expect(status(page)).toHaveText('Line not started');
  await expect(page.getByRole('button', { name: /the line/ })).toHaveCount(0);
  // The stations reflect their state as attributes: every one idle, none blocked or failed.
  await expect
    .poll(() => page.locator('sf-station').evaluateAll((all) => all.map((station) => station.getAttribute('status'))))
    .toEqual(Array(8).fill('idle'));
  await expect(take(page).getByRole('button', { name: 'Every ticket' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('article.controls')).not.toContainText('Deployment');
});

test('Martin starts a new line for the first time, with his passkey, and it takes every ticket', async ({ page }) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');
  await expect(status(page)).toHaveText('Line not started');
  await expect(page.getByRole('button', { name: 'Stop the line' })).toHaveCount(0);
  // Every ticket is what the line takes already: no key on it, and the narrower choices ask nothing either.
  await expect(take(page).getByRole('button', { name: 'Every ticket', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(take(page).getByRole('button', { name: 'Just one', exact: true })).toBeVisible();

  const start = page.getByRole('button', { name: 'Start the line (asks for your passkey)' });
  await expect(start).toHaveClass(/primary/);
  await start.click();
  const dialog = page.getByRole('dialog', { name: 'Start the line' });
  await expect(dialog).toContainText('The line has not started yet.');
  await expect(dialog).toContainText('every ticket, until you choose otherwise in Controls.');
  await expect(dialog).not.toContainText('stays stopped');
  await dialog.getByLabel('Reason').fill('The first run');
  await dialog.getByRole('button', { name: 'Use your passkey and start' }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toHaveText('Line running · Supervised');
  await expect(page.getByRole('button', { name: 'Stop the line' })).toBeVisible();
  const started = await harness.database.owner<{ appended_by: string; payload: { reason?: string } }[]>`
    select appended_by, payload from events where type = 'line.started'`;
  expect(started.map((e) => [e.appended_by, e.payload.reason])).toEqual([['factory_admin', 'The first run']]);
});
