/**
 * The feature flags in the console (milestone 7, task 16), against the samples, with the admin service stood in for
 * (`adminService`, and each route of the flags answered here): last-one on for everyone, and delivery-dates at Preview
 * with a canary in flight, so Share can't be taken.
 *
 * A visitor sees every flag read-only, its card in Needs you as Waiting on Martin, and whether the app holds the
 * flags. Martin opens each confirmation from a stop, a drag or a card: widening, with the passkey and Share's choice of
 * share, Preview skipped, to Checks with no passkey, narrowing, turning off with a reason, turning back on, and a stop
 * that can't be taken, which says why and only closes. The move he confirms is what the console sends. Dragging the
 * handle renders nothing until it is let go. The line under the flags says each state of the admin service's check.
 * An improvement's sheet carries the same slider and the flag's card: Martin moves the flag there as in Flags, and
 * a visitor reads both, as the sheet of any held work item heads with its card, read-only.
 * Snapshots are `visual.spec.ts`'s, and axe's look is `quality.spec.ts`'s.
 */
import type { Locator, Page, Request } from '@playwright/test';
import type { RawEvent } from '@software-factory/events';
import { AT_CHECKS, COMPARING, heldAs, RELEASED_OFF, TURNED_OFF } from './flags.ts';
import { adminService, consoleUrl, END, expect, test, WIDTHS } from './support.ts';

/** Adds events after the samples' to what a visitor's page reads. */
async function visitorEvents(page: Page, extra: readonly RawEvent[]): Promise<void> {
  await page.route('**/api/events?after=0', async (route) => {
    const response = await route.fetch();
    route.fulfill({ response, json: [...((await response.json()) as RawEvent[]), ...extra] });
  });
}

/** Each move the page sends, answered as the admin service would once made. */
function moves(page: Page): { bodies: unknown[] } {
  const sent = { bodies: [] as unknown[] };
  void page.route('**/admin/flags/*/stage', (route, request: Request) => {
    sent.bodies.push(request.postDataJSON());
    return route.fulfill({ json: { staged: null } });
  });
  return sent;
}

const flags = (page: Page) => page.getByRole('article', { name: 'Flags' }).locator('.ctl-group.flags');
const flag = (page: Page, name: string) =>
  flags(page).locator('.flag', { has: page.locator('code', { hasText: name }) });
const slider = (page: Page, name: string) => flag(page, name).getByRole('group', { name: new RegExp(`^${name}:`) });
/** A confirmation: the browser's own `<dialog>`, over Flags or over the sheet, which is a dialog itself. */
const dialog = (page: Page) => page.locator('dialog');

async function open(page: Page, as: 'visitor' | 'martin', at = END, extra: readonly RawEvent[] = []) {
  await adminService(page, as, extra);
  if (as === 'visitor' && extra.length) await visitorEvents(page, extra);
  await page.goto(consoleUrl({ at }));
  await expect(flags(page)).toBeVisible();
}

test('a visitor sees each flag read-only, its card waiting on Martin, and whether the app holds them', async ({
  page,
}) => {
  await heldAs(page, 'held');
  await open(page, 'visitor');
  await expect(page.getByRole('article', { name: 'Flags' }).locator('.panel-head .label')).toHaveText(
    '2 in the app · Read only',
  );
  await expect(slider(page, 'last-one')).toHaveAccessibleName('last-one: Everyone');
  await expect(slider(page, 'delivery-dates')).toHaveAccessibleName('delivery-dates: Preview');
  await expect(flags(page).getByRole('button', { name: /Widen|Narrow|Turn/ })).toHaveCount(0);
  await expect(flags(page).locator('.fthumb')).toHaveCount(0);
  // gift-note's, turned off and closed, is folded at the foot.
  await expect(flags(page).locator('.fstop[aria-current]')).toHaveText(['Everyone', 'Preview', 'Off']);
  // Share is dashed: a canary is in flight.
  await expect(flag(page, 'delivery-dates').locator('.fstop.cant')).toHaveText(['Share 50%', 'Everyone']);
  // Preview it stays a link for a visitor.
  await expect(flag(page, 'delivery-dates').getByRole('link', { name: /Preview it on the app/ })).toHaveAttribute(
    'href',
    'http://website.localhost:8080/?preview=delivery-dates',
  );
  await expect(flags(page).locator('.sync')).toHaveText('The app holds every flag as set: r8, checked 40s ago.');

  const card = page.locator('article.needs .flag-need');
  await expect(card.locator('.kick')).toContainText('Ready to widen#1294 · Verify · Preview');
  await expect(card.locator('.ro')).toHaveText(['Widen to Share', 'Turn off']);
  await expect(card).toContainText('v0.9.13 is at 50%, and its two versions would mix the two sides.');
  await expect(card).toContainText('Martin answers, signed in');
});

test('the line under the flags says each state of the admin service’s check of the app', async ({ page }) => {
  const sync = flags(page).locator('.sync');
  const says = {
    taking:
      'The app is taking the change to r9: Martin’s phone hears if it hasn’t within a minute of a narrowing or Off, or 5 of a widening.',
    lagging:
      'The app still holds r8, 3min after r9: Martin’s phone hears at 5min, or at a minute for a narrowing or Off.',
    unchecked: 'The admin service couldn’t ask every copy of the app which flags it holds, at 15:23.',
    off: 'The admin service doesn’t check which flags the app holds here.',
  } as const;
  for (const [state, words] of Object.entries(says) as [keyof typeof says, string][]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await heldAs(page, state);
    await open(page, 'visitor');
    await expect(sync).toHaveText(words);
    await expect(sync).toHaveClass(state === 'lagging' ? /tone-attn/ : /^sync( tone-taking)?$/);
  }
  // With nothing to ask, nothing is said.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/admin/flags/held', (route) => route.abort());
  await open(page, 'visitor');
  await expect(sync).toHaveCount(0);
});

test('Martin narrows, turns off with a reason, and finds a stop that can’t be taken says why', async ({ page }) => {
  await heldAs(page, 'held');
  const sent = moves(page);
  await open(page, 'martin');

  await test.step('Narrowing to Checks acts at once, with no passkey', async () => {
    await flag(page, 'delivery-dates').getByRole('button', { name: 'Narrow to Checks, delivery-dates' }).click();
    await expect(dialog(page).getByRole('heading')).toHaveText('Narrow delivery-dates to Checks');
    await expect(dialog(page).locator('.fromto')).toHaveText('Preview → to Checks');
    await expect(dialog(page)).toContainText('Narrowing acts at once, and never asks for the passkey.');
    await expect(dialog(page).locator('.glyph.key')).toHaveCount(0);
    await dialog(page).getByRole('button', { name: 'Narrow' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(sent.bodies).toEqual([{ from: { stage: 'preview' }, to: { stage: 'checks' } }]);
  });

  await test.step('Turning off asks why, and sends it', async () => {
    await flag(page, 'delivery-dates').getByRole('button', { name: 'Turn off, delivery-dates' }).click();
    await expect(dialog(page).getByRole('heading')).toHaveText('Turn off delivery-dates');
    await expect(dialog(page)).toContainText('#1294 closes as turned off; its code stays in the app, off.');
    const button = dialog(page).getByRole('button', { name: 'Turn off' });
    await expect(button).toBeDisabled();
    await dialog(page).getByLabel('Reason').fill('The date is wrong on Sundays');
    await button.click();
    await expect(dialog(page)).toHaveCount(0);
    expect(sent.bodies.at(-1)).toEqual({
      from: { stage: 'preview' },
      to: { stage: 'off' },
      reason: 'The date is wrong on Sundays',
    });
  });

  await test.step('Share can’t be taken while a canary is in flight: the dialog says why, and only closes', async () => {
    await flag(page, 'delivery-dates')
      .getByRole('button', { name: /^Widen to Share 50%: can’t be taken now/ })
      .click();
    await expect(dialog(page).getByRole('heading')).toHaveText('Share can’t be taken now');
    await expect(dialog(page)).toContainText(
      'v0.9.13 is at 50%, and its two versions would mix the two sides. Share can be taken once it ends.',
    );
    await expect(dialog(page).getByRole('button')).toHaveText(['Close']);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    expect(sent.bodies).toHaveLength(2);
  });

  await test.step('Its card in Needs you has Widen to Share dashed, with the reason, and Turn off', async () => {
    const card = page.locator('article.needs .flag-need');
    await expect(card.getByRole('button', { name: 'Widen to Share' })).toBeDisabled();
    await expect(card.locator('p.why')).toHaveText(
      'v0.9.13 is at 50%, and its two versions would mix the two sides. Share can be taken once it ends.',
    );
    await card.getByRole('button', { name: 'Turn off' }).click();
    await expect(dialog(page).getByRole('heading')).toHaveText('Turn off delivery-dates');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });
});

test('Martin widens with his passkey, chooses Share’s share with Preview skipped, and widens to Checks with none', async ({
  page,
}) => {
  await heldAs(page, 'held');
  const asked: unknown[] = [];
  await page.route('**/admin/flags/*/stage', (route, request) => {
    asked.push(request.postDataJSON());
    // Not fresh: the service asks for the passkey again, and the page asks the browser for it.
    return route.fulfill({ status: 403, json: { refused: 'step-up', message: 'Give your passkey again.' } });
  });
  await page.route('**/admin/step-up/options', (route) =>
    route.fulfill({ status: 500, json: { message: 'No passkey could be asked for here.' } }),
  );
  await open(page, 'martin', AT_CHECKS);

  await test.step('Widening past Checks says it asks for the passkey', async () => {
    await flag(page, 'last-one').getByRole('button', { name: 'Widen to Preview, last-one' }).click();
    await expect(dialog(page).getByRole('heading')).toHaveText('Widen last-one to Preview');
    await expect(dialog(page).locator('.kickline')).toHaveText('Your passkey, again');
    await expect(dialog(page)).toContainText(
      'The admin service then checks the app has it. Widening shows a change to more people, so it asks for your passkey again.',
    );
    await dialog(page).getByRole('button', { name: 'Widen' }).click();
    await expect(dialog(page).getByRole('alert')).toHaveText('No passkey could be asked for here.');
    expect(asked).toEqual([{ from: { stage: 'checks' }, to: { stage: 'preview' } }]);
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  });

  await test.step('From Checks, Share skips Preview, and asks how big a share: 50 chosen', async () => {
    await flag(page, 'last-one').getByRole('button', { name: 'Widen to Share 50%, last-one' }).click();
    await expect(dialog(page).getByRole('heading')).toHaveText('Widen last-one to Share');
    await expect(dialog(page)).toContainText('Preview is skipped: no probe checks a preview first');
    const shares = dialog(page).getByRole('group', { name: 'Share of the generator’s requests' });
    await expect(shares.getByRole('button', { name: '50%' })).toHaveAttribute('aria-pressed', 'true');
    await shares.getByRole('button', { name: '25%' }).click();
    await expect(dialog(page).locator('.fromto')).toHaveText('Checks → to Share 25%');
    await dialog(page).getByRole('button', { name: 'Widen' }).click();
    await expect.poll(() => asked.at(-1)).toEqual({ from: { stage: 'checks' }, to: { stage: 'share', share: 25 } });
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  });

  await test.step('Off to Checks shows it to nobody but the factory’s own checks, so it asks for no passkey', async () => {
    await page.goto(consoleUrl({ at: RELEASED_OFF }));
    await flag(page, 'delivery-dates').getByRole('button', { name: 'Widen to Checks, delivery-dates' }).click();
    await expect(dialog(page).getByRole('heading')).toHaveText('Widen delivery-dates to Checks');
    await expect(dialog(page).locator('.kickline')).toHaveCount(0);
    await expect(dialog(page).locator('.glyph.key')).toHaveCount(0);
  });
});

test('Kubernetes failing a move is said in the service’s words, and what each answer means', async ({ page }) => {
  await heldAs(page, 'held');
  const answers = [
    {
      status: 502,
      message: 'Kubernetes refused the change, and nothing was done.',
      means: 'The flag stands where it was: try again in a moment.',
    },
    {
      status: 504,
      message:
        "Kubernetes didn't answer, and whether the change was made can't be told: look again before trying again.",
      means: 'If it was made, the slider moves to it, and the line under the flags says when the app has it.',
    },
  ];
  let next = 0;
  await page.route('**/admin/flags/*/stage', (route) => {
    const { status, message } = answers[Math.min(next, answers.length - 1)] as (typeof answers)[number];
    next += 1;
    return route.fulfill({ status, json: { refused: 'kubernetes', message } });
  });
  await open(page, 'martin');
  for (const { message, means } of answers) {
    await flag(page, 'delivery-dates').getByRole('button', { name: 'Narrow to Checks, delivery-dates' }).click();
    await dialog(page).getByRole('button', { name: 'Narrow' }).click();
    await expect(dialog(page).getByRole('alert')).toHaveText(`${message} ${means}`);
    await page.keyboard.press('Escape');
  }
});

test('a flag turned off from Everyone goes straight back, and one turned off and closed folds at the foot', async ({
  page,
}) => {
  await heldAs(page, 'held');
  await open(page, 'martin', END, TURNED_OFF);
  await expect(slider(page, 'last-one')).toHaveAccessibleName('last-one: turned off');
  await flag(page, 'last-one').getByRole('button', { name: 'Turn back on for everyone, last-one' }).click();
  await expect(dialog(page).getByRole('heading')).toHaveText('Turn last-one back on');
  await expect(dialog(page).getByRole('button', { name: 'Turn back on' })).toBeVisible();
  await page.keyboard.press('Escape');

  const closed = flags(page).locator('details.flags-closed');
  await expect(closed.locator('summary')).toHaveText('Turned off and closed · 2');
  await closed.locator('summary').click();
  await expect(closed.locator('code')).toHaveText(['delivery-dates', 'gift-note']);
  await expect(closed.getByRole('button', { name: /Widen|Narrow|Turn/ })).toHaveCount(0);
});

test('Everyone waits while Verify compares at Share, and no card waits for Martin', async ({ page }) => {
  await open(page, 'martin', COMPARING);
  await flag(page, 'last-one')
    .getByRole('button', { name: /^Widen to Everyone: can’t be taken now/ })
    .click();
  await expect(dialog(page)).toContainText(
    'Verify is still comparing the two sides at Share: Everyone can be taken once the comparison has passed.',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('article.needs .flag-need')).toHaveCount(0);
});

const sheet = (page: Page) => page.locator('section.sheet');
/** The sheet's flag: its section, The flag. */
const sheetFlag = (page: Page) =>
  sheet(page)
    .locator('.sec')
    .filter({ has: page.getByRole('heading', { name: 'The flag', exact: true }) });

test('Martin moves a flag from its improvement’s sheet, as from Controls, and its card heads the sheet', async ({
  page,
}) => {
  await heldAs(page, 'held');
  const sent = moves(page);
  await adminService(page, 'martin');
  await page.goto(consoleUrl({ item: '1294', sheet: true }));
  const waits = sheet(page).locator('.sheet-needs');
  await expect(waits.getByRole('heading', { level: 3 })).toHaveText('Needs you');

  await test.step('The flag’s card heads it, as in Needs you, but for its title and the link to the sheet', async () => {
    const card = waits.locator('.flag-need');
    await expect(card).toHaveAccessibleName('Ready to widen');
    await expect(card.locator('.kick')).toContainText('#1294 · Verify · Preview');
    await expect(card.getByRole('heading')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Open the work item' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Widen to Share' })).toBeDisabled();
    // Its confirmation opens over the sheet, and Escape closes it, not the sheet.
    await card.getByRole('button', { name: 'Turn off' }).click();
    await expect(dialog(page).getByRole('heading')).toHaveText('Turn off delivery-dates');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(sheet(page)).toBeVisible();
  });

  await test.step('The sheet’s slider takes a stop, through the same confirmation, and sends the same move', async () => {
    await expect(sheetFlag(page)).toContainText('Each stage is Martin’s, here or in Flags');
    const stop = sheetFlag(page).getByRole('button', { name: 'Narrow to Checks, delivery-dates' });
    await stop.click();
    await expect(dialog(page).getByRole('heading')).toHaveText('Narrow delivery-dates to Checks');
    await dialog(page).getByRole('button', { name: 'Narrow' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(sent.bodies).toEqual([{ from: { stage: 'preview' }, to: { stage: 'checks' } }]);
    // Focus goes back to the stop it came from, in the sheet, which is still open.
    await expect(stop).toBeFocused();
    await expect(sheet(page)).toBeVisible();
  });

  await test.step('A stop that can’t be taken says why, in the same words', async () => {
    await sheetFlag(page)
      .getByRole('button', { name: /^Widen to Share 50%: can’t be taken now/ })
      .click();
    await expect(dialog(page)).toContainText(
      'v0.9.13 is at 50%, and its two versions would mix the two sides. Share can be taken once it ends.',
    );
    await expect(dialog(page).getByRole('button')).toHaveText(['Close']);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
  });
});

test('a visitor reads an improvement’s flag and a held work item’s answers on its sheet, read-only', async ({
  page,
}) => {
  await heldAs(page, 'held');
  await open(page, 'visitor');
  await page.goto(consoleUrl({ item: '1294', sheet: true }));
  const waits = sheet(page).locator('.sheet-needs');
  await expect(waits.getByRole('heading', { level: 3 })).toHaveText('Waiting on Martin');
  await expect(waits.locator('.ro')).toHaveText(['Widen to Share', 'Turn off']);
  await expect(waits).toContainText('Martin answers, signed in');
  await expect(sheetFlag(page).getByRole('button')).toHaveCount(0);
  await expect(sheetFlag(page).locator('.fthumb')).toHaveCount(0);

  // A ticket's hold: the same card as Waiting on Martin's, each answer a label beside what it does.
  await page.goto(consoleUrl({ item: '1323', sheet: true }));
  await expect(waits).toHaveAccessibleName('Waiting on Martin');
  await expect(waits.locator('.need')).toHaveAccessibleName('Held by review');
  await expect(waits.locator('.ro')).toHaveText(['Approve', 'Answer in words', 'Reject']);
  await expect(waits.getByRole('button')).toHaveCount(0);
  // Nothing waits on a work item that is done.
  await page.goto(consoleUrl({ item: '1271', sheet: true }));
  await expect(sheet(page).getByRole('heading', { name: 'The flag', exact: true })).toBeVisible();
  await expect(waits).toHaveCount(0);
});

/** The centre of a stop, in the page's pixels. */
const centre = async (stop: Locator) => {
  const box = await stop.boundingBox();
  if (!box) throw new Error('no stop');
  return { x: box.x + box.width / 2, y: box.y + 12 };
};
const renders = (page: Page) => page.evaluate(() => (globalThis as { sfRenders?: { flags: number } }).sfRenders?.flags);

for (const [width, viewport, where] of [
  ['a desktop', WIDTHS.desktop, 'Flags'],
  ['a phone', WIDTHS.phone, 'Flags'],
  ['a desktop', WIDTHS.desktop, 'the sheet'],
  ['a phone', WIDTHS.phone, 'the sheet'],
] as const) {
  test(`dragging the handle in ${where} on ${width} renders nothing until it is let go, then opens that stop’s confirmation`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await adminService(page, 'martin');
    const inSheet = where === 'the sheet';
    await page.goto(consoleUrl({ debug: 'renders', ...(inSheet && { item: '1294', sheet: true }) }));
    const row = inSheet ? sheetFlag(page) : flag(page, 'delivery-dates');
    await row.scrollIntoViewIfNeeded();
    const thumb = row.locator('.fthumb');
    const from = await centre(thumb);
    const to = await centre(row.locator('.fstop', { hasText: 'Checks' }));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    const before = (await renders(page)) ?? 0;
    expect(before).toBeGreaterThan(0);
    for (let i = 1; i <= 20; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 20, from.y);
    // The handle follows the pointer, and nothing rendered.
    const left = await thumb.evaluate((el) => el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2);
    expect(Math.abs(left - to.x)).toBeLessThan(4);
    expect(await renders(page)).toBe(before);
    await page.mouse.up();
    await expect(dialog(page).getByRole('heading')).toHaveText('Narrow delivery-dates to Checks');
    // Letting go is what renders: the count moves now.
    expect(await renders(page)).toBeGreaterThan(before);
    // Until the change is made, the handle goes back to where the flag stands.
    await expect(thumb).toHaveAttribute('style', /^$|^left: ?;?$/);
    await page.keyboard.press('Escape');
    expect(Math.abs((await centre(thumb)).x - from.x)).toBeLessThan(2);
  });
}

test('the slider’s stops are reached and pressed from the keyboard', async ({ page }) => {
  await adminService(page, 'martin');
  await page.goto(consoleUrl());
  const stop = flag(page, 'delivery-dates').getByRole('button', { name: 'Narrow to Checks, delivery-dates' });
  await stop.focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page).getByRole('heading')).toHaveText('Narrow delivery-dates to Checks');
  await page.keyboard.press('Escape');
  await expect(stop).toBeFocused();
});
