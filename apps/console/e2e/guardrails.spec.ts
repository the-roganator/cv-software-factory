/**
 * Guardrails (milestone 7, tasks 22 and 23): its summary in the bottom row, how many hold, the eleven as a strip, the
 * last proof and the last attack, opening its sheet, as Controls' line on the guardrails does; and in the sheet the
 * checklist's head and rows, one row open at a time in place, a guardrail
 * that did not hold and why, each guardrail's refusals in the last seven days, and each attack in its guardrail's row. Against the samples, as the cluster is now: no attack can
 * be launched (`policy/attacks.ts`): every one is, and the samples launch none, so each card says it has not been
 * launched yet, with Launch for Martin and a label for a visitor.
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

const summary = (page: Page) => page.locator('#guardrails-summary');
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Guardrails' });
const panel = (page: Page) => page.locator('#guardrails');
const rowButton = (page: Page, n: number) =>
  panel(page)
    .locator('.gr > button')
    .filter({ has: page.locator(`.n:text-is("${n}")`) });

/** The samples' checklist, in its sheet, opened from its summary. */
async function guardrails(page: Page) {
  await page.goto(consoleUrl());
  await ready(page);
  await summary(page).getByRole('button', { name: 'All eleven guardrails' }).click();
  await panel(page).waitFor();
}

/** The attacks' test data's checklist, every attack available, at their last moment or another, in its sheet. */
async function attacks(page: Page, at?: number) {
  await attacksAvailable(page);
  await page.goto(`${attacksUrl({ at })}&sheet=guardrails`);
  await panel(page).waitFor();
}

test('the summary says how many hold, the eleven as one picture, the last proof and attack, and why it needs Martin', async ({
  page,
}) => {
  await page.goto(consoleUrl());
  await ready(page);
  const card = summary(page);
  await expect(card.getByRole('heading', { level: 2 })).toHaveText('Guardrails');
  await expect(card.locator('.panel-head .label')).toHaveText('9 held · 1 did not · 1 not proved yet');
  await expect(card.locator('.panel-head .label')).toHaveClass(/tone-attn/);
  // A guardrail that did not hold is the one reason it needs Martin: Needs you's rule, and its line in attn.
  await expect(card).toHaveClass(/\battn\b/);
  const strip = card.getByRole('img');
  await expect(strip).toHaveAccessibleName(/^The eleven, in order: 1 held, 2 held, .*5 did not hold, .*not proved/);
  await expect(strip.locator('> span')).toHaveCount(11);
  await expect(strip.locator('> span.is-attn')).toHaveText(['5']);
  const lines = card.locator('.sum-lines li');
  await expect(lines.first()).toHaveClass(/tone-attn/);
  await expect(lines.first()).toContainText('5 did not hold');
  await expect(lines.first()).toContainText('Agent sandboxes are disposable and fenced. Martin was paged.');
  await expect(lines.nth(1)).toContainText(/^Last proved .+ · make guardrails proves the rest$/);
  await expect(lines.nth(2)).toHaveText('No attack launched yet');

  const scan = await new AxeBuilder({ page })
    .include('#guardrails-summary')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);

  // Controls' line on the guardrails opens the same sheet, and focus comes back to it.
  const link = page.getByRole('article', { name: 'Controls' }).getByRole('button', { name: 'Guardrails' });
  await link.click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator('.sheet-head .panel-count')).toHaveText(
    '9 held · 1 did not · 1 not proved yet · Read only',
  );
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(link).toBeFocused();
});

test('with attacks run, the summary says the last attack, and Martin reads that he was paged', async ({ page }) => {
  await adminService(page, 'martin', [], 'attacks');
  await attacksAvailable(page);
  await page.goto(attacksUrl());
  await ready(page);
  const lines = summary(page).locator('.sum-lines li');
  await expect(lines.first()).toContainText('You were paged.');
  await expect(lines.last()).toHaveText('An attack is running: Shipping an image it built itself');
});

test('the address opens the sheet at a guardrail: opened, scrolled to and focused', async ({ page }) => {
  await page.goto(`${consoleUrl()}&open=9`);
  await expect(sheet(page)).toBeVisible();
  await expect(rowButton(page, 9)).toHaveAttribute('aria-expanded', 'true');
  await expect(rowButton(page, 9)).toBeFocused();
  await expect(rowButton(page, 9)).toBeInViewport();
});

test('a visitor reads the checklist: how many hold, one row open at a time, and why one did not hold', async ({
  page,
}) => {
  await guardrails(page);
  await expect(sheet(page).getByRole('heading', { level: 2 })).toHaveText('Guardrails');
  await expect(sheet(page).locator('.sheet-head .panel-count')).toHaveText(
    '9 held · 1 did not · 1 not proved yet · Read only',
  );
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
  await expect(details.locator('.gr-attack .last .v')).toHaveText('Not launched yet');

  // Opening another closes it.
  const eight = rowButton(page, 8);
  await eight.click();
  await expect(eight).toHaveAttribute('aria-expanded', 'true');
  await expect(five).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page).locator('.more')).toHaveCount(1);
  await expect(panel(page).locator('.more')).toContainText('None yet: its attack, or make guardrails, proves it.');

  const scan = await new AxeBuilder({ page })
    .include('#guardrails')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test('a visitor reads each guardrail’s refusals in the week, checked by the server, each leading to where it is', async ({
  page,
}) => {
  await guardrails(page);
  const details = () => panel(page).locator('.more');
  const lines = () => details().locator('.reflist > li');

  // Guardrail 1: the GitHub worker's guard refusing a deploy, signed and verified, and GitHub's 403 whose payload was
  // changed after it was signed, which is shown, unverified, and not counted. Neither has a work item.
  await rowButton(page, 1).click();
  await expect(details().locator('.label').filter({ hasText: 'Refusals' })).toHaveText(
    'Refusals · 7 days · 1 · 1 unverified',
  );
  await expect(lines()).toHaveCount(2);
  await expect(lines().nth(0).locator('.mech')).toHaveText('GitHub worker’s guard');
  await expect(lines().nth(0)).toContainText('openDeploy branch');
  await expect(lines().nth(0).locator('small')).toHaveCount(0);
  await expect(lines().nth(1).locator('.mech')).toHaveText('token permission');
  await expect(lines().nth(1).locator('small')).toHaveText(
    'Unverified: its signature does not check out, so it is not counted.',
  );
  await expect(lines().nth(0).getByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '?view=audit');

  // Guardrail 2: the review check's refusal, whose words a visitor reads redacted, counted all the same.
  await rowButton(page, 2).click();
  await expect(lines()).toHaveCount(1);
  await expect(lines().locator('.mech')).toHaveText('review gate');
  await expect(lines().locator('small')).toHaveText(
    'Redacted in public: the line checked its signature when it was recorded.',
  );
  await expect(details().locator('.label').filter({ hasText: 'Refusals' })).toHaveText('Refusals · 7 days · 1');

  // Guardrail 7: the gateway's three refusals at a work item's cap, folded into one, whose number opens its sheet.
  await rowButton(page, 7).click();
  await expect(details().locator('.label').filter({ hasText: 'Refusals' })).toHaveText('Refusals · 7 days · 3');
  await expect(lines().locator('.mech')).toHaveText('gateway');
  await expect(lines()).toContainText('A model call by the coder agent, the work item’s cap · 3 times');
  // It opens in the sheet's place; closed, the page is back, and the summary opens the checklist again.
  await lines().getByRole('button', { name: '#1319' }).click();
  await expect(page.getByRole('dialog', { name: /The wishlist empties itself/ })).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(summary(page).getByRole('button', { name: 'All eleven guardrails' })).toBeFocused();
  await summary(page).getByRole('button', { name: 'All eleven guardrails' }).click();

  // Guardrail 6: nothing refused this week.
  await rowButton(page, 6).click();
  await expect(lines()).toHaveCount(0);
  await expect(details()).toContainText('None.');

  // Guardrail 9: nothing refused, and what proves it instead, the line's last rollback.
  await rowButton(page, 9).click();
  await expect(details().locator('p.instead')).toContainText('The last rollback: ');
  await expect(details().locator('p.instead')).toContainText('by its analysis.');
  await expect(details()).not.toContainText('None.');

  const scan = await new AxeBuilder({ page })
    .include('#guardrails')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test('a relayed refusal the server could not answer for is asked about again, and reads as checked once it is', async ({
  page,
}) => {
  let failed = 0;
  await page.route('**/api/refusals', async (route) => {
    if (failed++ === 0) return route.fulfill({ status: 500, body: 'The refusals could not be checked.\n' });
    return route.continue();
  });
  await guardrails(page);
  await rowButton(page, 2).click();
  const line = panel(page).locator('.more .reflist > li');
  await expect(line.locator('small')).toHaveText('Checking its signature.');
  await expect(line.locator('small')).toHaveText(
    'Redacted in public: the line checked its signature when it was recorded.',
    { timeout: 15_000 },
  );
  expect(failed).toBeGreaterThan(1);
});

for (const as of ['martin', 'visitor'] as const) {
  test(`every attack says it has not been launched yet, with Launch ${as === 'martin' ? 'for Martin' : 'as a label for a visitor'}`, async ({
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
      // Every attack is available (policy/attacks.ts), and the samples launch none.
      await expect(attack.locator('.last .v')).toHaveText('Not launched yet');
      // What it tries is the dialog's to say for an available attack; the card keeps its name and its last run.
      await expect(attack.locator('.tries')).toHaveCount(0);
      if (as === 'martin') {
        await expect(attack.getByRole('button', { name: 'Launch' })).toBeEnabled();
      } else {
        // A visitor's Launch is a label: it opens the dialog read-only, and launches nothing.
        await expect(attack.locator('.ro')).toHaveText('Launch');
      }
    }
    // No attack's dialog opened: the one dialog is the sheet.
    await expect(page.locator('dialog')).toHaveCount(0);
  });
}

test('with attacks run, a visitor reads each one’s last run in its guardrail’s row', async ({ page }) => {
  await attacks(page);
  await expect(sheet(page).locator('.sheet-head .panel-count')).toHaveText('10 held · 1 did not · Read only');
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
  await expect(page.locator('dialog')).toHaveCount(1);
});
