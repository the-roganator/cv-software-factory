/**
 * The settings (`?view=settings`) and the Spend panel, against a stand-in for the admin service: a visitor's
 * read-only page, and Martin's, where a change is a draft in words until saved, a save that raises asks for the
 * passkey, a local model has no effort, and a cap that is no figure cannot be saved. The real service's save, and its
 * checks, are `apps/factory/test/admin/admin.test.ts`'s. Snapshots are `visual.spec.ts`'s.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { adminService, consoleUrl, expect, ready, SESSION, THEMES, test, WIDTHS } from './support.ts';

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('.card[data-place="side"]');

const settingsUrl = (theme: 'paper' | 'ink' = 'paper') => `${consoleUrl({ theme })}&view=settings`;

/** The settings page drawn, with the fonts it is set in. */
async function settings(page: Page, theme: 'paper' | 'ink' = 'paper') {
  await page.goto(settingsUrl(theme));
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** What the page sends the admin service when it saves, answered as the service would. */
async function saves(page: Page, answer: (count: number) => { status: number; json: object }) {
  const sent: unknown[] = [];
  await page.route('**/admin/settings', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill(answer(sent.length));
  });
  return sent;
}

test('a visitor sees the models and the caps, read only, and who changes them', async ({ page }) => {
  await adminService(page, 'visitor');
  await settings(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Models and spend');
  await expect(page.getByLabel('The coder’s model')).toBeDisabled();
  await expect(page.getByLabel('The coder’s model')).toHaveValue('claude-sonnet-5-5');
  await expect(page.getByLabel('Each day')).toBeDisabled();
  await expect(page.getByLabel('Each day')).toHaveValue('20');
  await expect(page.getByRole('heading', { name: 'Who changes these' })).toBeVisible();
  // The line's controls, Controls' own, read only as there.
  const line = page.locator('article', { has: page.getByRole('heading', { name: 'The line', exact: true }) });
  await expect(line.locator('.panel-head .label')).toHaveText('Read only');
  await expect(line.getByRole('group', { name: 'Autonomy' }).getByRole('button', { name: 'Guarded' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  for (const button of await line.getByRole('button').all()) await expect(button).toBeDisabled();
  await expect(line.locator('.glyph.key')).toHaveCount(0);
  await expect(line).toContainText('Only Martin changes these');
  await expect(page.getByRole('heading', { name: 'Passkeys' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  // The describer may have no more than medium: high and beyond are listed, and disabled.
  await expect(page.getByLabel('The describer’s effort').locator('option[disabled]')).toHaveText([
    'high · above policy',
    'xhigh · above policy',
    'max · above policy',
  ]);
});

test('Martin’s change is a draft in words until he saves it, and raising spend asks for his passkey', async ({
  page,
}) => {
  await adminService(page, 'martin');
  const sent = await saves(page, (n) =>
    n === 1
      ? { status: 403, json: { refused: 'step-up', message: 'This needs your passkey again.' } }
      : { status: 200, json: {} },
  );
  await settings(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await expect(page.locator('.save-bar')).toHaveCount(0);

  await page.getByLabel('The coder’s effort').selectOption('high');
  const bar = page.locator('.save-bar');
  await expect(bar).toContainText(
    '1 change: the coder’s effort, medium → high. It raises spend, so saving asks for your passkey.',
  );
  await expect(page.getByLabel('The coder’s effort').locator('xpath=ancestor::td')).toHaveClass('changed');
  await bar.getByRole('button', { name: 'Save (asks for your passkey)' }).click();
  // The service asks for the passkey: the page asks Martin, in words, and sends nothing more until he gives it.
  const dialog = page.getByRole('dialog', { name: 'Save the settings' });
  await expect(dialog).toContainText('The coder’s effort, medium → high, from each agent’s next step.');
  expect(sent).toEqual([{ agents: { coder: { model: 'claude-sonnet-5-5', effort: 'high' } } }]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(bar).toBeVisible();

  await bar.getByRole('button', { name: 'Discard' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByLabel('The coder’s effort')).toHaveValue('medium');
});

test('when the passkey’s dialog cannot be fetched, saving says so and is not left busy', async ({ page }) => {
  await adminService(page, 'martin');
  // The dialog's code is its own chunk, which the session check fetches first: neither fetch arrives.
  await page.route('**/*StepUpDialog*', (route) => route.abort());
  const sent = await saves(page, () => ({
    status: 403,
    json: { refused: 'step-up', message: 'This needs your passkey again.' },
  }));
  await settings(page);
  await page.getByLabel('The coder’s effort').selectOption('high');
  const bar = page.locator('.save-bar');
  const save = bar.getByRole('button', { name: 'Save (asks for your passkey)' });
  await save.click();
  await expect(page.getByRole('alert')).toContainText(
    'The passkey’s code could not be fetched: reload the page and try again.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(save).not.toHaveAttribute('aria-disabled', 'true');
  expect(sent).toHaveLength(1);
});

test('a cheaper model or a lower cap saves without the passkey, and a local model takes no effort', async ({
  page,
}) => {
  await adminService(page, 'martin');
  const sent = await saves(page, () => ({ status: 200, json: {} }));
  await settings(page);

  await page.getByLabel('The reviewer’s model').selectOption('qwen/qwen3.8-27b');
  await expect(page.getByLabel('The reviewer’s effort')).toBeDisabled();
  await expect(page.getByLabel('The reviewer’s effort').locator('xpath=..')).toContainText(
    'Effort is set in LM Studio',
  );
  await page.getByLabel('Each day').fill('12.50');
  const bar = page.locator('.save-bar');
  await expect(bar).toContainText(
    '3 changes: the reviewer’s model, Claude Sonnet 5.5 → Qwen3.8 27B; the reviewer’s effort, medium → none; the day’s cap, $20.00 → $12.50.',
  );
  await expect(bar).not.toContainText('passkey');
  await bar.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(() => sent)
    .toEqual([{ agents: { reviewer: { model: 'qwen/qwen3.8-27b' } }, caps: { dayUsd: 12.5 } }]);
});

test('a cap that is no figure, or past its ceiling, cannot be saved', async ({ page }) => {
  await adminService(page, 'martin');
  await settings(page);
  const bar = page.locator('.save-bar');
  for (const figure of ['twenty', '0', '25.01']) {
    await page.getByLabel('Each day').fill(figure);
    await expect(bar).toContainText('Each cap is a figure in dollars above nothing, up to its ceiling.');
    await expect(bar.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(page.getByLabel('Each day')).toHaveAttribute('aria-invalid', 'true');
  }
});

test('Martin’s passkeys and this session, and the way here from his account menu', async ({ page }) => {
  await adminService(page, 'martin');
  await page.goto(consoleUrl());
  await ready(page);
  await page.getByRole('button', { name: 'Martin', exact: true }).click();
  await page.locator('#account-menu').getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  const keys = page.locator('.keys');
  await expect(keys).toContainText(SESSION.passkeys[0]?.name ?? '');
  await expect(keys).toContainText('this device');
  await expect(keys.getByRole('button', { name: /Revoke MacBook Air \(asks for your passkey\)/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This session' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out everywhere' })).toBeVisible();
});

test('the Spend panel shows the spend against today’s caps, for everyone, with a way to the caps', async ({ page }) => {
  await adminService(page, 'visitor');
  await page.goto(consoleUrl());
  await ready(page);
  const spend = page.getByRole('article', { name: 'Spend' });
  await expect(spend.locator('.panel-head .label')).toHaveText('resets at 00:00 UTC');
  await expect(spend).toContainText(/Models today\$\d+\.\d\d of \$20\.00/);
  await expect(spend).toContainText('of $1.00, at the cap');
  await expect(spend).toContainText('Martin sets each cap within its ceiling');
  // Controls holds the line's controls alone: the meters and the way to the caps are Spend's.
  await expect(page.getByRole('article', { name: 'Controls' })).not.toContainText('Models today');
  await spend.getByRole('link', { name: 'Models and spend caps' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Models and spend');
});

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test(`the bottom row on ${width}: Needs you, then Controls, Flags, Patching, Guardrails and Spend one above the other`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await adminService(page, 'martin');
    await page.goto(consoleUrl());
    await ready(page);
    const box = async (name: string) => {
      const found = await page.locator('section.bottom').getByRole('article', { name, exact: true }).boundingBox();
      if (!found) throw new Error(`no ${name}`);
      return found;
    };
    const [needs, controls, flags, patching, guardrails, spend] = await Promise.all([
      box('Needs you'),
      box('Controls'),
      box('Flags'),
      box('Patching'),
      box('Guardrails'),
      box('Spend'),
    ]);
    // In order, each under the one before, and as wide.
    const column = [controls, flags, patching, guardrails, spend];
    for (const [above, below] of column.slice(0, -1).map((panel, i) => [panel, column[i + 1]] as const)) {
      if (!below) continue;
      expect(below.y).toBeGreaterThan(above.y + above.height);
      expect(below.x).toBe(controls.x);
      expect(below.width).toBe(controls.width);
    }
    if (width === 'phone') {
      // One column: Needs you above them all, as wide as they are.
      expect(controls.y).toBeGreaterThan(needs.y + needs.height);
      expect(controls.x).toBe(needs.x);
    } else {
      // Two columns: Needs you on the left, the five on the right, from the top of the row.
      expect(controls.x).toBeGreaterThan(needs.x + needs.width);
      expect(controls.y).toBe(needs.y);
    }
  });

  for (const theme of THEMES) {
    test.describe(`${width}, ${theme}`, () => {
      test.use({ viewport });

      for (const as of ['visitor', 'martin'] as const) {
        test(`the settings, for ${as === 'martin' ? 'Martin' : 'a visitor'}, have nothing for axe to find`, async ({
          page,
        }) => {
          await adminService(page, as);
          await settings(page, theme);
          if (as === 'martin') await page.getByLabel('The coder’s effort').selectOption('high');
          expect((await axe(page).analyze()).violations).toEqual([]);
        });
      }

      test('the bottom row has nothing for axe to find', async ({ page }) => {
        await adminService(page, 'martin');
        await page.goto(consoleUrl({ theme }));
        await ready(page);
        expect((await axe(page).include('.bottom').analyze()).violations).toEqual([]);
      });
    });
  }
}
