/**
 * Guardrails (milestone 7, task 22): the checklist's head and rows, one row open at a time in place, a guardrail that
 * did not hold and why, and each attack in its guardrail's row. Against the samples, as the cluster is now: no attack can
 * be launched (`policy/attacks.ts`), so each attack's card says it is not available yet, with no Launch for anyone.
 * Against the attacks' test data, with every attack available as the flag will make them (`attacksAvailable`): its last
 * run and Launch; for a visitor Launch is a label, whose dialog says Martin launches it, with only Close; for Martin,
 * with a stand-in for the admin service, Launch waits while an attack is in flight, says the service's refusal in its
 * words, and closes once launched. The launch against the real service is `attacks.spec.ts`'s. Snapshots are
 * `visual.spec.ts`'s.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { ATTACKS_END, adminService, attacksAvailable, attacksUrl, consoleUrl, expect, ready, test } from './support.ts';

/** After the attacks' one in flight has passed its limit, unfinished: every Launch is free again. */
const AFTER_LIMIT = ATTACKS_END + 15 * 60_000;

const panel = (page: Page) => page.locator('#guardrails');
const rowButton = (page: Page, n: number) =>
  panel(page)
    .locator('.gr > button')
    .filter({ has: page.locator(`.n:text-is("${n}")`) });

/** The samples' checklist. */
async function guardrails(page: Page) {
  await page.goto(consoleUrl());
  await ready(page);
  await panel(page).scrollIntoViewIfNeeded();
}

/** The attacks' test data's checklist, every attack available, at their last moment or another. */
async function attacks(page: Page, at?: number) {
  await attacksAvailable(page);
  await page.goto(attacksUrl({ at }));
  await ready(page);
  await panel(page).scrollIntoViewIfNeeded();
}

test('a visitor reads the checklist: how many hold, one row open at a time, and why one did not hold', async ({
  page,
}) => {
  await guardrails(page);
  await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('Guardrails');
  await expect(panel(page).locator('.panel-head .label')).toHaveText('9 held · 1 did not · 1 not proved yet');
  await expect(panel(page).locator('.gr > button .name')).toHaveCount(11);
  await expect(panel(page).locator('.gr.failed .name')).toHaveText(['Agent sandboxes are disposable and fenced']);

  const five = rowButton(page, 5);
  await expect(five).toHaveAttribute('aria-expanded', 'false');
  await five.click();
  await expect(five).toHaveAttribute('aria-expanded', 'true');
  const details = panel(page).locator(`#${await five.getAttribute('aria-controls')}`);
  await expect(details.locator('p.attn')).toContainText('Its proof did not hold');
  await expect(details.locator('p.attn')).toContainText('runners → 93.184.215.14: allowed');
  await expect(details.locator('p.attn')).toContainText('It reads as not held until the same proof holds again.');
  await expect(details).toContainText('Did not hold: make guardrails');
  await expect(details.locator('.gr-attack .last .v')).toHaveText('Not available yet');

  // Opening another closes it.
  const eight = rowButton(page, 8);
  await eight.click();
  await expect(eight).toHaveAttribute('aria-expanded', 'true');
  await expect(five).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page).locator('.more')).toHaveCount(1);
  await expect(panel(page).locator('.more')).toContainText('None yet: make guardrails proves it.');

  const scan = await new AxeBuilder({ page })
    .include('#guardrails')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});

for (const as of ['martin', 'visitor'] as const) {
  test(`every attack says it is not available yet, with what it tries, and no Launch, for ${as === 'martin' ? 'Martin' : 'a visitor'}`, async ({
    page,
  }) => {
    await adminService(page, as);
    await guardrails(page);
    for (const [n, name] of [
      [1, '“Fix CI” by editing a workflow'],
      [2, 'A pull request that deletes the failing test'],
      [3, 'Shipping an image it built itself'],
      [5, 'Data to an outside URL'],
      [8, 'An instruction in a problem report'],
    ] as const) {
      await rowButton(page, n).click();
      const attack = panel(page).locator('.more .gr-attack');
      await expect(attack.locator('b')).toHaveText(name);
      await expect(attack.locator('.last .v')).toHaveText('Not available yet');
      await expect(attack.locator('.tries')).not.toBeEmpty();
      await expect(attack.getByRole('button')).toHaveCount(0);
      await expect(attack.locator('.ro')).toHaveCount(0);
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}

test('with attacks run, a visitor reads each one’s last run in its guardrail’s row', async ({ page }) => {
  await attacks(page);
  await expect(panel(page).locator('.panel-head .label')).toHaveText('10 held · 1 did not');
  await rowButton(page, 5).click();
  const details = panel(page).locator('.more');
  await expect(details.locator('p.attn')).toContainText('Attack #1333 was not refused: something it tried got through');
  await expect(details.locator('p.attn')).toContainText('It reads as not held until its attack holds again.');
  await expect(details).toContainText('Did not hold: attack #1333');
  await expect(details.locator('.gr-attack')).toHaveClass(/failed/);
  await expect(details.locator('.gr-attack .last .v')).toHaveText('Not refused · Martin paged');

  // The attack in flight reads Running, and a visitor's Launch is a label still.
  await rowButton(page, 3).click();
  await expect(panel(page).locator('.more .gr-attack')).toContainText('Shipping an image it built itself');
  await expect(panel(page).locator('.more .gr-attack .last .v')).toHaveText('Running');
  await expect(panel(page).locator('.more .gr-attack .ro')).toHaveText('Launch');

  // An attack's number opens its sheet.
  await panel(page).locator('.more .gr-attack').getByRole('button', { name: '#1335' }).click();
  await expect(page.getByRole('dialog', { name: /Shipping an image it built itself/ })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('a visitor’s Launch opens the attack’s dialog read-only, with only Close', async ({ page }) => {
  await attacks(page);
  await rowButton(page, 8).click();
  const launch = panel(page).locator('.more .gr-attack .ro');
  await launch.click();
  const dialog = page.getByRole('dialog', { name: 'An instruction in a problem report' });
  await expect(dialog.locator('.kickline')).toHaveText('A red-team attack · guardrail 8');
  await expect(dialog).toContainText('What should refuse it: Jev’s typed questions, which quarantine it.');
  await expect(dialog).toContainText('If nothing refuses it, that is a failure: Martin’s phone hears');
  await expect(dialog).toContainText('Martin launches it, signed in. Milestone 8 opens this menu to visitors.');
  await expect(dialog.getByRole('button')).toHaveText(['Close']);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(launch).toBeFocused();
});

test('Martin’s Launch waits while an attack is in flight, saying which', async ({ page }) => {
  await adminService(page, 'martin', [], 'attacks');
  await attacks(page);
  await rowButton(page, 3).click();
  const mine = panel(page).locator('.more');
  await expect(mine.getByRole('button', { name: 'Running' })).toBeDisabled();
  await rowButton(page, 5).click();
  await expect(panel(page).locator('.more').getByRole('button', { name: 'Launch' })).toBeDisabled();
  await expect(panel(page).locator('.more .gr-busy')).toContainText(
    'One at a time: #1335 is running, until it ends or',
  );
});

test('Martin launches an attack with no passkey; the service’s refusal is said in its words', async ({ page }) => {
  await adminService(page, 'martin', [], 'attacks');
  let answer: { status: number; json: object } = {
    status: 409,
    json: { refused: 'attack', message: 'One attack at a time: #1340 has not finished.' },
  };
  const asked: string[] = [];
  await page.route('**/admin/attacks/*', (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill(answer);
  });
  await attacks(page, AFTER_LIMIT);
  // Past its limit, the attack that was in flight is unfinished, and pages Martin.
  await rowButton(page, 3).click();
  await expect(panel(page).locator('.more .gr-attack .last .v')).toHaveText('Unfinished · Martin paged');
  await rowButton(page, 8).click();
  await panel(page).locator('.more').getByRole('button', { name: 'Launch' }).click();
  const dialog = page.getByRole('dialog', { name: 'An instruction in a problem report' });
  await expect(dialog).toContainText('What it costs: Jev’s calls, a fraction of a cent: they are the mechanism.');
  await expect(dialog).toContainText('No passkey: an attack loosens nothing, and asks the line for no work.');
  await dialog.getByRole('button', { name: 'Launch' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('One attack at a time: #1340 has not finished.');
  answer = { status: 200, json: { workItem: '1341', attack: 'report' } };
  await dialog.getByRole('button', { name: 'Launch' }).click();
  await expect(dialog).toHaveCount(0);
  expect(asked).toEqual(['/admin/attacks/report', '/admin/attacks/report']);
});

test('the service’s refusal of an attack not available is said in its words', async ({ page }) => {
  await adminService(page, 'martin', [], 'attacks');
  await page.route('**/admin/attacks/*', (route) =>
    route.fulfill({ status: 403, json: { refused: 'attack', message: 'This attack is not available yet.' } }),
  );
  // Drawn as available, as a page loaded before policy held the attack back would be.
  await attacks(page, AFTER_LIMIT);
  await rowButton(page, 8).click();
  await panel(page).locator('.more').getByRole('button', { name: 'Launch' }).click();
  const dialog = page.getByRole('dialog', { name: 'An instruction in a problem report' });
  await dialog.getByRole('button', { name: 'Launch' }).click();
  // A 403 that is not the passkey's asks for no passkey: it is said, and the dialog stays.
  await expect(dialog.getByRole('alert')).toHaveText('This attack is not available yet.');
  await expect(page.getByRole('dialog')).toHaveCount(1);
});
