/**
 * The "+" on Plan, end to end (milestone 7, task 18): the console against the real admin service on a throwaway store
 * holding the samples, on one origin behind a proxy standing in for Traefik (`admin.ts`), with a virtual passkey.
 * Martin asks for an improvement in his own words, sees the title they will give it, and gives his passkey again from
 * the Request button; the work item opens with his request, waiting at Plan. Approving an improvement's spec carries
 * the key and asks for his passkey again. A visitor opens the same "+", read-only, holding Martin's latest request.
 * Snapshots are `visual.spec.ts`'s. Needs Postgres: TEST_DATABASE_URL, or Docker.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { enrolThroughTheDoor, type Harness, startHarness, virtualPasskey } from './admin.ts';
import { expect, test } from './support.ts';

const PORT = 18_340;

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'improvements');
});
test.afterAll(async () => {
  await harness?.stop();
});

const WORDS =
  'Say on the basket page how many items are in it. Count each product once, however many of it are in the basket.';
const TITLE = 'Say on the basket page how many items are in it';

const requested = () =>
  harness.database.owner<{ work_item: string; type: string; actor: string; payload: Record<string, unknown> }[]>`
    select work_item, type, actor, payload from events
    where work_item = (select work_item from events where type = 'improvement.requested' and payload->>'words' = ${WORDS})
    order by seq`;

async function signIn(page: Page) {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');
}

test('Martin asks for an improvement with the “+”, giving his passkey again, and it waits at Plan', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Request an improvement' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request an improvement' });
  await expect(dialog.locator('.kickline')).toHaveText('An improvement');
  // The samples' open tickets, waiting for the planner.
  await expect(dialog.locator('ul.dialog-what li').first()).toHaveText(
    /^It waits behind every open ticket, \d+ now, oldest first\. To take it at once, choose Just one in Controls\.$/,
  );
  const request = dialog.getByRole('button', { name: 'Request (asks for your passkey)' });
  await expect(request).toBeDisabled();
  await expect(dialog).toContainText(
    'Requesting widens what the line does, so it asks for your passkey again, and tells your phone.',
  );

  await dialog.getByLabel('What you want').fill(WORDS);
  await expect(dialog.getByLabel('What you want')).toHaveAccessibleDescription(
    `Titled “${TITLE}” until the planner names it in the spec. ${WORDS.length} / 600`,
  );
  const scan = await new AxeBuilder({ page })
    .include('dialog')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);

  // The service asks for the passkey again, and the button gives it, through the browser's own sheet.
  await request.click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await requested()).map((e) => [e.type, e.actor]))
    .toEqual([
      ['work-item.opened', 'martin'],
      ['improvement.requested', 'martin'],
    ]);
  const [opened, asked] = await requested();
  expect(opened?.payload).toMatchObject({ kind: 'improvement', title: TITLE, category: 'improvement' });
  expect(asked?.payload).toEqual({ words: WORDS, steppedUp: true });
  await expect(page.locator('.top-right .fresh')).toHaveText('Passkey given · 5min left');

  // Its row arrives with its events, at Plan, behind the open tickets.
  await page.getByRole('button', { name: /^Plan:/ }).click();
  const panel = page.getByRole('dialog', { name: 'Plan' });
  await expect(panel.getByRole('button', { name: new RegExp(`^#${opened?.work_item} ${TITLE}`) })).toContainText(
    'Asked by Martin · waiting behind the open tickets',
  );
  // The panel ends with the same "+", which opens the same form, the key gone while the passkey is fresh.
  await panel.getByRole('button', { name: 'Request an improvement' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Request an improvement' }).getByRole('button', { name: 'Request' }),
  ).toHaveAccessibleName('Request');
});

test('approving an improvement’s spec carries the key, and asks for the passkey again; a request made already closes', async ({
  page,
}) => {
  await signIn(page);
  const card = page.locator('article.needs .need').filter({ has: page.getByText('#1334 ·', { exact: false }) });
  await expect(card.locator('.kick b')).toHaveText('An improvement’s spec');
  await expect(card).toContainText(
    'The spec names its flag, free-delivery-gap, the page it changes, /basket, and three acceptance criteria, each tested with the flag on or off.',
  );
  await card.getByRole('button', { name: 'Approve (asks for your passkey)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve #1334' });
  await expect(dialog).toContainText(
    'The coder starts: tests first, with the flag on and off. Its pull request waits for you too.',
  );
  await expect(dialog).toContainText(
    'Approving an improvement’s spec sets the line building something new, so it needs your passkey again.',
  );
  await dialog.getByRole('button', { name: 'Use your passkey' }).click();
  await expect
    .poll(async () =>
      (
        await harness.database.owner<{ decision: string }[]>`
            select payload->>'decision' as decision from events where work_item = '1334' and type = 'hold.answered'`
      ).map((row) => row.decision),
    )
    .toEqual(['approved']);
  await expect(card).toHaveCount(0);

  // A request whose first answer was lost: the service says it was made already, and the dialog closes as made.
  await page.route('**/admin/improvements', (route) =>
    route.fulfill({
      status: 409,
      json: { refused: 'request', message: 'That request has been made already: it opened #1340.' },
    }),
  );
  await page.getByRole('button', { name: 'Request an improvement' }).click();
  const form = page.getByRole('dialog', { name: 'Request an improvement' });
  await form.getByLabel('What you want').fill('Say the basket’s weight.');
  await form.getByRole('button', { name: /^Request/ }).click();
  await expect(form).toHaveCount(0);
});

test('a visitor opens the same “+”, read-only, with Martin’s latest request', async ({ page }) => {
  await page.goto('/?motion=off');
  await page.getByRole('button', { name: 'How Martin asks for an improvement' }).click();
  const dialog = page.getByRole('dialog', { name: 'How Martin asks' });
  await expect(dialog.getByLabel('What he wants')).toBeDisabled();
  await expect(dialog.getByLabel('What he wants')).toHaveValue(WORDS);
  await expect(dialog).toContainText(/His latest request, .+, #\d+\./);
  await expect(dialog).toContainText(
    'A suggestion you send from the app reaches Martin, and never starts work by itself.',
  );
  await expect(dialog.locator('.ro')).toHaveText('Request');
  await expect(dialog).toContainText(
    'Martin requests it signed in, with his passkey again: it widens what the line does.',
  );
  await expect(dialog.getByRole('button')).toHaveText(['Close']);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'How Martin asks for an improvement' })).toBeFocused();
});
