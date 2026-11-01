/**
 * Milestone 5's states in the browser, from the samples' milestone 5 work items and #1310's merge in a dry run: what
 * each says in words, so it reads without colour, and WCAG 2.2 AA in both themes at a laptop's width and a phone's.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { consoleUrl, expect, MERGE_WAITING, ready, THEMES, test, WIDTHS } from './support.ts';

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('.card[data-place="side"]');

const centre = (page: Page) => page.locator('.card[data-place="centre"]');

/** A fact in the sheet's side column: the value after its name. */
const fact = (sheet: Locator, name: string) =>
  sheet.locator('.facts-dl dt', { hasText: name }).locator('xpath=following-sibling::dd[1]');

test.describe('fixing', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('a fix waiting for Martin’s merge shows the pull request, and Review lists the wait', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1311' }));
    await ready(page);
    await expect(centre(page).locator('.out')).toHaveText('Needs you');
    await expect(centre(page).locator('.waits .cap')).toHaveText('PR #1312 · waiting for Martin’s merge');
    // Its suggestion went back with the first review's blocking findings, and was taken: the approval leaves none.
    await expect(centre(page).locator('.ticks span', { hasText: 'The reviewer approved' })).toHaveText(
      'The reviewer approved',
    );
    await page.getByRole('button', { name: /^Review: needs you, 2 waiting/ }).click();
    await expect(page.getByRole('dialog', { name: 'Review' })).toContainText('Needs you · waiting for Martin’s merge');
  });

  test('a merged fix waits for a release, in the quiet tone, at no cost on the local model', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1310', at: MERGE_WAITING }));
    await ready(page);
    await expect(centre(page).locator('.out')).toHaveText('Merged · waiting for release');
    await expect(centre(page).getByRole('img', { name: 'Waiting at Release' })).toBeVisible();
    await expect(centre(page).locator('.meta')).toContainText('$0 · local');
    await expect(page.getByRole('button', { name: /^Release: idle, 1 waiting/ })).toBeVisible();
  });

  test('each hold names its mechanism and shows what it judged', async ({ page }) => {
    for (const [item, cap] of [
      ['1315', 'Held at Build · patch outside its scope, twice'],
      ['1317', 'Held at Gates · its tests pass without the fix'],
      ['1319', 'Held at Build · its spend cap reached'],
      ['1323', 'Held at Review · still blocking after two reviews'],
    ]) {
      await page.goto(consoleUrl({ item }));
      await ready(page);
      await expect(centre(page).locator('.out')).toHaveText('Held for a human');
      await expect(centre(page).locator('.waits .cap')).toHaveText(cap ?? '');
    }
  });

  test('a fix’s sheet has its spec, its rounds and its review, with each rule in full', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1311', sheet: true }));
    const sheet = page.getByRole('dialog', { name: 'Quantities over nine are refused' });
    await sheet.waitFor();
    await expect(sheet.locator('.byline')).toContainText('The describer, from the ticket');
    await expect(sheet.locator('table.scope')).toContainText('May change · PR #1312');
    await expect(sheet.locator('table.scope tr', { hasText: 'test/support/shop.ts' })).toContainText('untouched');
    await expect(sheet.locator('.ret-pill')).toHaveText('Review → Build · 2 blocking');
    await expect(sheet.locator('.rounds .after')).toContainText('Described, ready, and waiting for Martin’s merge');
    await expect(sheet.locator('.remark').first()).toContainText('RULE 3Test at the seams.');
    await expect(fact(sheet, 'Reviews')).toHaveText('2 of 2');
    await expect(sheet.locator('.gates .sub')).toHaveText('Signals, not required');
    await expect(sheet).toContainText('Attempt 1 passed every required check; the reviewer sent it back.');
    await expect(sheet.locator('.scrub')).toContainText('DESCRIBED');
  });

  test('a return’s next round shows before the coder pushes it, and a step in hand moves, unless motion is reduced', async ({
    page,
  }) => {
    // #1325: the gates sent round 1 back at 14:15:55, and the coder pushed round 2 at 14:19:00.
    await page.goto(consoleUrl({ item: '1325', sheet: true, motion: true, at: Date.parse('2026-10-06T14:17:00Z') }));
    const rounds = page.getByRole('dialog').locator('.rounds');
    await expect(rounds.locator('.rn')).toHaveText(['Round1', 'Round2']);
    // The return's arc lands on round 2's Build, hollow and in hand.
    await expect(rounds.locator('.ret-row .arc')).toHaveCount(1);
    await expect(rounds.locator('.cell.next')).toHaveText(['Running', 'Waiting', 'Waiting']);
    const busy = rounds.locator('.cell.running .busy');
    const moving = () => busy.evaluate((el) => el.getAnimations({ subtree: true }).length);
    await expect.poll(moving).toBe(1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(moving).toBe(0);
    await expect(rounds.locator('.cell.running')).toHaveText('Running');
  });

  test('a refused path says so to a screen reader, not only by its colour and its line', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1315', sheet: true }));
    const row = page.getByRole('dialog').locator('table.scope tr', { hasText: 'src/catalogue.ts' });
    await expect(row).toContainText('(outside the scope, refused)');
    await expect(page.getByRole('dialog').locator('table.scope')).toContainText('May change · patch 2, refused');
  });

  test('a fix sent back by the gates and then the reviewer counts one review of two', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1325', sheet: true }));
    const sheet = page.getByRole('dialog');
    await expect(fact(sheet, 'Reviews')).toHaveText('1 of 2');
    await expect(sheet.locator('.round-h').first()).toContainText('Review 1');
    await expect(sheet.locator('.round-h').first()).toContainText('attempt 2');
  });

  test('a fix that went round twice counts the reviews of its pull request’s pass, and names the pass', async ({
    page,
  }) => {
    await page.goto(consoleUrl({ item: '1306', sheet: true }));
    await expect(fact(page.getByRole('dialog'), 'Reviews')).toHaveText('1 of 2 · pass 2');
  });

  test('an approval’s suggestion the coder declined ends its round with the return, and no attempt after', async ({
    page,
  }) => {
    await page.goto(consoleUrl({ item: '1304', sheet: true }));
    const sheet = page.getByRole('dialog');
    await expect(sheet.locator('.ret-pill')).toHaveText('Review → Build · 1 suggestion, declined');
    // The arc joins two rows, and no row follows a return the coder declined in full.
    await expect(sheet.locator('.ret-row .arc')).toHaveCount(0);
    await expect(fact(sheet, 'Reviews')).toHaveText('1 of 2');
  });

  test('a local model’s row has no company’s logo, and costs $0', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1304', sheet: true }));
    const models = page.getByRole('dialog').locator('table.models');
    await expect(models.locator('tbody tr').first()).toContainText('Qwen3.8 27B · local');
    await expect(models.locator('tbody tr').last()).toContainText('Describer');
    await expect(models.locator('.logo use')).toHaveCount(0);
    await expect(models.locator('tfoot')).toContainText('Total · all local');
    await expect(models).not.toContainText('$0.00');
  });

  test('the line draws a round from what the return records, in the line’s words', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    await expect(page.locator('.ret-pill')).toHaveText('#1325 · round 3 · 1 blocking');
  });

  test('a return the work has moved on from is a row in its sender’s panel, kept in the work item’s one row', async ({
    page,
  }) => {
    await page.goto(consoleUrl());
    await ready(page);
    // #1323 went back to Build and has come round to Review again: no arc, and one row with its return struck through.
    await expect(page.locator('.ret-pill')).not.toContainText('#1323');
    await page.getByRole('button', { name: /^Review:/ }).click();
    const rows = page.getByRole('dialog', { name: 'Review' }).getByRole('button', { name: /^#1323 / });
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAccessibleName(/^#1323 .+: earlier sent back · Needs you · held by review.* Open$/);
    await expect(rows.locator('s')).toHaveText('sent back');
  });

  test('a station’s panel lists the work in hand first, and says it is working', async ({ page }) => {
    // The planner has taken #1314, the oldest ticket waiting, and #1315 has just opened behind it.
    await page.goto(consoleUrl({ at: Date.parse('2026-10-06T08:12:30Z') }));
    await ready(page);
    await page.getByRole('button', { name: /^Plan:/ }).click();
    const rows = page.getByRole('dialog', { name: 'Plan' }).getByRole('button', { name: /^#\d+ / });
    await expect(rows.first()).toHaveAccessibleName(/^#1314 .+: working, Spec written.* Open$/);
    await expect(rows.filter({ hasText: '#1315' })).toHaveAccessibleName(/^#1315 .+: Waiting for the planner Open$/);
    // Its play icon blinks, as the reel's "In progress" does; the waiting ticket's pause icon is still.
    await expect(rows.first().locator('.sicon')).toHaveClass(/blink/);
    await expect(rows.filter({ hasText: '#1315' }).locator('.sicon')).not.toHaveClass(/blink/);
  });
});

// WCAG 2.2 AA for every new state, in both themes, on a laptop and a phone, with motion off.
for (const width of ['laptop', 'phone'] as const) {
  for (const theme of THEMES) {
    test.describe(`fixing, ${width}, ${theme}`, () => {
      test.use({ viewport: WIDTHS[width] });

      // #1310 at the moment its dry run's merge waits for a release: the merged state.
      for (const item of ['1310', '1311', '1315', '1317', '1319', '1323']) {
        test(`the card for #${item} has nothing for axe to find`, async ({ page }) => {
          await page.goto(consoleUrl({ item, theme, ...(item === '1310' && { at: MERGE_WAITING }) }));
          await ready(page);
          expect((await axe(page).include('.card[data-place="centre"]').analyze()).violations).toEqual([]);
        });
      }

      test('Review’s panel has nothing for axe to find', async ({ page }) => {
        await page.goto(consoleUrl({ theme }));
        await ready(page);
        await page.getByRole('button', { name: /^Review:/ }).click();
        await page.getByRole('dialog').waitFor();
        expect((await axe(page).include('#stage-panel').analyze()).violations).toEqual([]);
      });

      for (const item of ['1310', '1311', '1315', '1323']) {
        test(`the sheet for #${item} has nothing for axe to find`, async ({ page }) => {
          await page.goto(consoleUrl({ item, sheet: true, theme, ...(item === '1310' && { at: MERGE_WAITING }) }));
          await page.getByRole('dialog').first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          expect((await axe(page).include('.sheet').analyze()).violations).toEqual([]);
        });
      }
    });
  }
}

test.describe('tool marks', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('a tool’s mark stands beside what it made, hidden from a screen reader, and its drawing loads', async ({
    page,
  }) => {
    // Admission control's refusal is Kyverno's, on an image without the pipeline's Sigstore signature.
    await page.goto(consoleUrl({ item: '1293', sheet: true }));
    const sheet = page.getByRole('dialog');
    const source = sheet.locator('.source', { hasText: 'Kyverno’s own refusal' });
    await expect(source.locator('.toolmark')).toHaveCount(2);
    await expect(source.locator('.toolmark-kyverno')).toHaveAttribute('aria-hidden', 'true');
    await expect(source.locator('.toolmark-sigstore')).toBeVisible();
    // The drawing is an image of this origin's, which the policy lets the stylesheet use.
    const url = await source
      .locator('.toolmark-kyverno')
      .evaluate((mark) => getComputedStyle(mark).maskImage.replace(/^url\("?|"?\)$/g, ''));
    const drawing = await page.request.get(url);
    expect(drawing.headers()['content-type']).toContain('image/svg+xml');

    // The line's agents ran in Kubernetes, said once under their table.
    await page.goto(consoleUrl({ item: '1304', sheet: true }));
    const ran = page.getByRole('dialog').locator('.ran');
    await expect(ran).toHaveCount(1);
    await expect(ran.locator('.toolmark-kubernetes')).toBeVisible();
    await expect(ran).toContainText('Kubernetes pod of its own in the runners namespace');
  });
});
