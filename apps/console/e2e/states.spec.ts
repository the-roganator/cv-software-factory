/**
 * The states the design system's README describes for when there is nothing ordinary to show, each made by
 * standing in for the server's answer.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { consoleUrl, emptyStore, expect, test } from './support.ts';

const noFindings = async (page: Page) =>
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze()).violations).toEqual([]);

test('while connecting, the stations wait, idle, and the header says so', async ({ page }) => {
  await page.route('**/api/events?after=0', () => {});
  await page.goto(consoleUrl());
  await expect(page.locator('header .status')).toHaveText('Connecting to the factory');
  await expect(page.getByRole('button', { name: 'Sense: reading the factory’s events' })).toBeDisabled();
  await noFindings(page);
});

test('the stations take their states as the events arrive, and keep still when motion is switched off', async ({
  page,
}) => {
  // The stations are custom elements: JSX hands them their state as properties, which they reflect as attributes.
  const stations = () =>
    page
      .locator('sf-station')
      .evaluateAll((elements) =>
        elements.map((element) => ['kind', 'status', 'beacon', 'motion'].map((name) => element.getAttribute(name))),
      );
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  await page.route('**/api/events?after=0', async (route) => {
    await arrived;
    await route.continue();
  });
  await page.goto(consoleUrl({ motion: true }));
  await expect(page.getByRole('button', { name: 'Sense: reading the factory’s events' })).toBeDisabled();
  const kinds = ['sense', 'triage', 'plan', 'build', 'gates', 'review', 'release', 'verify'];
  expect(await stations()).toEqual(kinds.map((kind) => [kind, 'idle', null, null]));

  arrive();
  const drawn = [
    ['sense', 'idle', null],
    ['triage', 'blocked', null],
    ['plan', 'blocked', null],
    ['build', 'working', 'needs-you'],
    ['gates', 'blocked', null],
    ['review', 'blocked', null],
    // The canary runs; #1321's deploy is not Martin's yet, its checks running.
    ['release', 'working', null],
    // #1294's flag waits for Martin to widen it.
    ['verify', 'blocked', null],
  ];
  await expect.poll(stations).toEqual(drawn.map((station) => [...station, null]));
  await page.getByRole('group', { name: 'Motion' }).getByRole('button', { name: 'STILL' }).click();
  await expect.poll(stations).toEqual(drawn.map((station) => [...station, 'off']));
  await page.getByRole('group', { name: 'Motion' }).getByRole('button', { name: 'MOTION' }).click();
  await expect.poll(stations).toEqual(drawn.map((station) => [...station, null]));
});

test('when the factory can’t be reached, the console says so and keeps trying', async ({ page }) => {
  let tries = 0;
  await page.route('**/api/events?after=0', (route) => {
    tries++;
    return route.fulfill({ status: 503, body: '' });
  });
  await page.goto(consoleUrl());
  await expect(page.getByRole('status').filter({ hasText: 'Unreachable' })).toBeVisible();
  await expect.poll(() => tries, { timeout: 8000 }).toBeGreaterThan(1);
  await noFindings(page);
});

test('an empty store keeps the idle line, and says where the work will appear', async ({ page }) => {
  await emptyStore(page, null);
  await page.goto(consoleUrl());
  await expect(page.getByText('Nothing yet')).toBeVisible();
  await expect(page.locator('header .status')).toHaveText('Line not started');
  await expect(page.getByRole('button', { name: /^Sense: idle, none/ })).toBeVisible();
  await noFindings(page);
});

test('an empty store for real events says the senses are watching, and sends nobody to the samples', async ({
  page,
}) => {
  await emptyStore(page, 'real');
  await page.goto(consoleUrl());
  await expect(page.getByText('Watching, nothing yet')).toBeVisible();
  await expect(page.getByText('The first tickets usually appear within fifteen minutes.')).toBeVisible();
  await expect(page.getByText('make samples won’t load into it')).toBeVisible();
  await expect(page.getByText('Nothing yet', { exact: true })).toHaveCount(0);
  await noFindings(page);
});

test('a dropped connection keeps the page, and says when it dropped', async ({ page }) => {
  await page.route('**/api/events/stream*', (route) => route.fulfill({ status: 503, body: '' }));
  await page.goto(consoleUrl());
  await expect(page.getByRole('status').filter({ hasText: 'The connection to the factory dropped at' })).toBeVisible();
  await expect(page.locator('header .status')).toHaveText('Reconnecting');
  await expect(page.locator('.card[data-place="centre"]')).toBeVisible();
});

test('events from a newer factory are left out, with a note', async ({ page, request }) => {
  const events = (await (await request.get('/api/events')).json()) as { seq: number }[];
  const last = events.at(-1) ?? { seq: 0 };
  await page.route('**/api/events?after=0', (route) =>
    route.fulfill({ json: [...events, { ...last, seq: last.seq + 1, type: 'robot.danced', version: 1 }] }),
  );
  let after: string | null = null;
  await page.route('**/api/events/stream*', (route) => {
    after = new URL(route.request().url()).searchParams.get('after');
  });
  await page.goto(consoleUrl());
  await expect(page.getByText('One event was written by a newer version of the factory')).toBeVisible();
  await expect(page.locator('.transport .count')).toHaveText('29 of 29');
  // The stream carries on after the event left out, so it is never sent, or counted, twice.
  await expect.poll(() => after).toBe(String(last.seq + 1));
});

test('a screenshot that fails to load says so in its place', async ({ page }) => {
  await page.route('**/artifacts/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto(consoleUrl({ item: '1296' }));
  const card = page.locator('.card[data-place="centre"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole('img', { name: /It could not be loaded/ }).first()).toBeVisible();
});

test('a whole page shows the window around its first mark, and counts the marks outside it', async ({
  page,
  request,
}) => {
  type Shot = { kind: string; width: number; height: number; boxes: { y: number; label: string }[] };
  type Event = { work_item: string | null; type: string; artifacts: Shot[] };
  const events = (await (await request.get('/api/events')).json()) as Event[];
  // The fix's picture as a whole page, 1600 tall: its first mark far down, and a second where the mark was, near the top.
  for (const event of events) {
    if (event.work_item !== '1296' || event.type !== 'verification.finished') continue;
    for (const shot of event.artifacts) {
      const [mark] = shot.boxes;
      if (shot.kind !== 'screenshot' || !mark) continue;
      shot.height = 1600;
      shot.boxes = [{ ...mark, y: 1200, label: 'Further down' }, mark];
    }
  }
  await page.route('**/api/events?after=0', (route) => route.fulfill({ json: events }));
  await page.goto(consoleUrl({ item: '1296' }));
  const after = page.locator('.card[data-place="centre"] .wipe .wipe-after .shot');
  await after.scrollIntoViewIfNeeded();
  await expect(after.locator('.fold')).toHaveText('↑ 1 more mark outside the frame');
  await expect(after.locator('.mk')).toHaveCount(1);
  const frame = await after.boundingBox();
  const mark = await after.locator('.mk').boundingBox();
  if (!frame || !mark) throw new Error('No frame or mark');
  // The window would put the mark a third of the way down, but stops at the page's foot: it shows the last 800 of
  // the page's 1600, each of the 1280 wide page's pixels drawn at the frame's width.
  expect(Math.abs(mark.y - frame.y - ((1200 - 800) / 1280) * frame.width)).toBeLessThan(1);
  // The before side, 800 tall, has no window further down to show: it stays at its top.
  const before = page.locator('.card[data-place="centre"] .wipe .wipe-before .shot');
  const image = await before.locator('img').boundingBox();
  if (!image) throw new Error('No image');
  expect(Math.abs(image.y - frame.y)).toBeLessThan(1);
});
