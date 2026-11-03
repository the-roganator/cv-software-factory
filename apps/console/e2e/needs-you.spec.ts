/**
 * Needs you, end to end: the bottom row's cards against the real admin service on a throwaway store holding the
 * samples, on one origin behind a proxy standing in for Traefik (`admin.ts`), with a virtual passkey. A visitor sees
 * answers the planner's question and its card moves to Answered today; answers the visitor's suggestion in words, which
 * leave it held; and approving the gate's hold asks for his passkey again first. A refusal shows on the card. Then a
 * visitor sees the same cards, read only, as Waiting on Martin, with his answers today but not his words on the
 * visitor's suggestion. Martin answers from a work item's sheet too, through the same card, the passkey asked there
 * as here, and the card leaves both. Answered today is the viewer's own day, so the answers checked are the ones made here, now. Snapshots are
 * `visual.spec.ts`'s. Needs Postgres: TEST_DATABASE_URL, or Docker.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { enrolThroughTheDoor, type Harness, startHarness, virtualPasskey } from './admin.ts';
import { MARTINS_WORDS } from './full.ts';
import { expect, test } from './support.ts';

const PORT = 18_334;

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'needs_you');
});
test.afterAll(async () => {
  await harness?.stop();
});

const panel = (page: Page) => page.locator('article.needs');
const card = (page: Page, workItem: string) =>
  panel(page)
    .locator('.need')
    .filter({ has: page.getByText(`#${workItem} ·`, { exact: false }) });
const answers = (workItem: string) =>
  harness.database.owner<{ payload: { decision: string; answer?: string; hold?: string } }[]>`
    select payload from events where work_item = ${workItem} and type = 'hold.answered' order by seq`;

test('Martin answers a card, which moves to Answered today, and gives his passkey again to approve a gate’s hold', async ({
  page,
}) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');
  await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('Needs you');
  // Ten holds and #1294's flag, but #1321's deploy is not his yet, its checks running: its card stays, out of the
  // count.
  await expect(panel(page).locator('.count-attn')).toHaveText('10 waiting');

  await test.step('Approving the planner’s question asks for nothing', async () => {
    const question = card(page, '1300');
    await expect(question.locator('.kick b')).toHaveText('The planner asks');
    await question.getByRole('button', { name: 'Approve' }).click();
    await expect.poll(async () => (await answers('1300')).map((a) => a.payload.decision)).toEqual(['approved']);
    await expect(question).toHaveCount(0);
    await expect(panel(page).locator('.answered')).toContainText('#1300 · Approved. The line carried on.');
  });

  await test.step('Words on the visitor’s suggestion leave it held', async () => {
    const suggestion = card(page, '1329');
    await suggestion.getByRole('button', { name: 'Answer in words' }).click();
    const field = suggestion.getByLabel('Your answer to #1329');
    await expect(field).toBeFocused();
    // A visitor's report opened it: his words stay his, and the field says so.
    await expect(suggestion).toContainText(
      'Your words stay yours: a visitor’s report opened this, so no visitor and no agent reads them.',
    );
    await field.fill('Ask again when improvements ship');
    await expect(suggestion).toContainText('32 / 300');
    await suggestion.getByRole('button', { name: 'Send' }).click();
    await expect
      .poll(async () => (await answers('1329')).map((a) => a.payload.answer))
      .toEqual([MARTINS_WORDS, 'Ask again when improvements ship']);
    await expect(panel(page).locator('.answered')).toContainText(
      '#1329 · Answered in words, still held. Ask again when improvements ship',
    );
    // His own words, which visitors do not see, he does.
    await expect(suggestion).toBeVisible();
  });

  await test.step('Approving the gate’s hold carries the key, and asks for the passkey again', async () => {
    const gate = card(page, '1274');
    const approve = gate.getByRole('button', { name: 'Approve (asks for your passkey)' });
    await approve.click();
    const dialog = page.getByRole('dialog', { name: 'Approve #1274' });
    await expect(dialog).toContainText('Sends it back to the coder for one more round, past the gates’ limit.');
    await expect(dialog).toContainText('Approving overrides a guardrail, so it needs your passkey again.');
    await dialog.getByRole('button', { name: 'Use your passkey' }).click();
    await expect.poll(async () => (await answers('1274')).map((a) => a.payload.decision)).toEqual(['approved']);
    await expect(gate).toHaveCount(0);
    await expect(page.locator('.top-right .fresh')).toHaveText('Passkey given · 5min left');
  });

  await test.step('a refusal shows on the card', async () => {
    // Answered from elsewhere meanwhile: the service refuses, and the card says why.
    const scope = card(page, '1315');
    await page.route('**/admin/holds/1315/reject', (route) =>
      route.fulfill({
        status: 409,
        json: { refused: 'hold', message: '#1315 has no hold waiting now: it was answered, or moved on.' },
      }),
    );
    await scope.getByRole('button', { name: 'Reject' }).click();
    await expect(scope.getByRole('alert')).toHaveText('#1315 has no hold waiting now: it was answered, or moved on.');
  });
});

test('a visitor sees what waits on Martin, read only, and not his words on a visitor’s report', async ({ page }) => {
  await page.goto('/?motion=off');
  await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('Waiting on Martin');
  // Two of the samples' nine holds that wait on him Martin answered above; #1294's flag waits too.
  await expect(panel(page).locator('.count-attn')).toHaveText('8 waiting');
  const review = card(page, '1323');
  await expect(review.locator('.kick b')).toHaveText('Held by review');
  await expect(review.locator('.ro')).toHaveText(['Approve', 'Answer in words', 'Reject']);
  await expect(review).toContainText('Martin answers, signed in');
  await expect(panel(page).getByRole('button', { name: 'Approve' })).toHaveCount(0);
  // A deploy takes only his rejection: approving or words would leave it waiting just the same.
  await expect(card(page, '1321').locator('.ro')).toHaveText(['Reject']);
  await expect(card(page, '1321').locator('.kick b')).toHaveText('Its deploy’s checks are running');
  // A sample's deploy pull request never existed: the card names it, and links nowhere.
  await expect(card(page, '1321').locator('.way')).toHaveText('Deploy #1331');
  await expect(card(page, '1321').locator('.way .toolmark-github')).toBeVisible();
  await expect(card(page, '1321').getByRole('link')).toHaveCount(0);
  // His words on the visitor's suggestion stay his; his approval of the planner's question is public.
  const today = panel(page).locator('.answered');
  await expect(today).toContainText(
    '#1329 · Answered in words, still held. His words stay his: the hold was about a visitor’s report.',
  );
  await expect(today).toContainText('#1300 · Approved. The line carried on.');
  await expect(today).not.toContainText('Ask again when improvements ship');
  const scan = await new AxeBuilder({ page })
    .include('.bottom')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test('Martin answers from a work item’s sheet as from Needs you, his passkey asked there too', async ({ page }) => {
  await virtualPasskey(page);
  // A second passkey, on a second device: a fresh page has not given one in the last five minutes.
  await enrolThroughTheDoor(page, await harness.code(), 'Phone');
  await page.goto('/?motion=off&item=1334&sheet');
  const sheet = page.locator('section.sheet');
  const waits = sheet.locator('.sheet-needs');

  await test.step('An improvement’s spec, approved from its sheet, asks for the passkey and leaves both', async () => {
    await expect(waits.getByRole('heading', { level: 3 })).toHaveText('Needs you');
    const spec = waits.locator('.need');
    await expect(spec).toHaveAccessibleName('An improvement’s spec');
    await spec.getByRole('button', { name: 'Approve (asks for your passkey)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve #1334' });
    await expect(dialog).toContainText('Approving an improvement’s spec sets the line building something new');
    await dialog.getByRole('button', { name: 'Use your passkey' }).click();
    await expect.poll(async () => (await answers('1334')).map((a) => a.payload.decision)).toEqual(['approved']);
    await expect(waits).toHaveCount(0);
    await expect(sheet).toBeVisible();
    // Its button went with it: the sheet's title takes focus, so the sheet keeps it, and Escape closes it.
    await expect(sheet.getByRole('heading', { level: 2 })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(card(page, '1334')).toHaveCount(0);
    await expect(panel(page).locator('.answered')).toContainText('#1334 · Approved.');
  });

  await test.step('Words from a sheet go through the same route, and a refusal shows on its card', async () => {
    await page.goto('/?motion=off&item=1317&sheet');
    const tests = waits.locator('.need');
    await page.route('**/admin/holds/1317/reject', (route) =>
      route.fulfill({
        status: 409,
        json: { refused: 'hold', message: '#1317 has no hold waiting now: it was answered, or moved on.' },
      }),
    );
    await tests.getByRole('button', { name: 'Reject' }).click();
    await expect(tests.getByRole('alert')).toHaveText('#1317 has no hold waiting now: it was answered, or moved on.');
    await tests.getByRole('button', { name: 'Answer in words' }).click();
    const field = tests.getByLabel('Your answer to #1317');
    await expect(field).toBeFocused();
    await field.fill('Test the empty basket too');
    await tests.getByRole('button', { name: 'Send' }).click();
    await expect
      .poll(async () => (await answers('1317')).map((a) => [a.payload.decision, a.payload.answer]))
      .toEqual([['answered', 'Test the empty basket too']]);
    await expect(waits).toHaveCount(0);
  });
});
