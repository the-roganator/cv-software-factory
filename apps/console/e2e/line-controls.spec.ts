/**
 * The line's controls, end to end: Stop the line and Start the line in the header, and Controls' autonomy level,
 * switches and take, against the real admin service on a throwaway store holding the samples (at Guarded, taking the
 * next five), on one origin behind a proxy standing in for Traefik (`admin.ts`), with a virtual passkey. The app's
 * Rollout is the harness's stand-in, at the samples' release in flight, which the store records as the line would.
 *
 * A visitor sees every control read-only, and no Stop or Start. Martin stops the line with a reason, which aborts the
 * canary in flight, and the header says why for everyone; starting it asks for his passkey in its own dialog. Then he
 * tightens autonomy at once, loosens it with the passkey again, turns agents' new work off and on, widens and narrows
 * what the line takes, and a take the service refuses says why under it. Nothing under Autonomy moves as the level
 * changes, on a phone or a desktop, in Controls or in the settings, which draw the same controls: a change made in
 * one shows in the other. He sends alerts to his phone, and stops them with his passkey again, and turns auto-rollback
 * off with his passkey again, which the Canary panel's last line then says, and on at once. Snapshots are `visual.spec.ts`'s, and axe's look is `quality.spec.ts`'s. Needs Postgres:
 * TEST_DATABASE_URL, or Docker.
 */
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { VERSIONS } from '@software-factory/events';
import { appendMartins } from '../../factory/src/admin/store.ts';
import { enrolThroughTheDoor, type Harness, Rollout, startHarness, virtualPasskey } from './admin.ts';
import { expect, test, WIDTHS } from './support.ts';

const PORT = 18_336;
const RELEASE = 'v8q7chmx72-913';
const REASON = 'Holding releases while I look at the deploy';

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;
const rollout = new Rollout();
/** The last event before the tests: the samples, and the release in flight. */
let before = 0;

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'line_controls', {
    rollout: { namespace: 'website', name: 'website' },
    kube: rollout,
  });
  // The line's record of the release in flight, as the samples have it.
  const line = harness.database.as.line;
  await line.begin((tx) =>
    appendMartins(line, tx, [
      {
        id: randomUUID(),
        ts: new Date().toISOString(),
        work_item: null,
        type: 'release.started',
        version: VERSIONS['release.started'],
        actor: 'rollouts',
        summary: 'Canary of v0.9.13 started',
        payload: {
          release: RELEASE,
          version: 'v0.9.13',
          previous: 'v0.9.12',
          image: { digest: `sha256:${'6'.repeat(64)}`, signed: true, admitted: true },
          watched: true,
          steps: null,
          dryRun: false,
        },
        artifacts: [],
      },
    ] as never),
  );
  [{ before = 0 } = {}] = await harness.database.owner<
    { before: number }[]
  >`select max(seq)::int as before from events`;
});
test.afterAll(async () => {
  await harness?.stop();
});

const controls = (page: Page) => page.locator('article.controls');
/** The settings' panel of the line's controls. */
const linePanel = (page: Page) =>
  page.locator('article', { has: page.getByRole('heading', { name: 'The line', exact: true }) });
/** Where the line's controls are drawn, on a phone and on a desktop: Controls, and the settings' panel of them. */
const PLACES = [
  ['Controls, on a phone', '/?motion=off', WIDTHS.phone, controls],
  ['Controls, on a desktop', '/?motion=off', WIDTHS.desktop, controls],
  ['the settings, on a phone', '/?view=settings&motion=off', WIDTHS.phone, linePanel],
  ['the settings, on a desktop', '/?view=settings&motion=off', WIDTHS.desktop, linePanel],
] as const;
/** How far a group's label sits below Autonomy's, in CSS pixels: what the header does above the panel is not its. */
const labelTop = async (panel: Locator, label: string) => {
  const top = (name: string) =>
    panel.locator('.ctl-group > .label', { hasText: name }).evaluate((element) => element.getBoundingClientRect().top);
  return (await top(label)) - (await top('Autonomy'));
};
const status = (page: Page) => page.locator('header.top .status');
/** What the tests have appended of a type, oldest first. A store of samples marks every event a sample. */
const stored = <T>(type: string) =>
  harness.database.owner<{ payload: T; actor: string }[]>`
    select payload, actor from events where type = ${type} and seq > ${before} order by seq`;
const changes = async () =>
  (await stored<{ change: { control: string; after: unknown } }>('controls.changed')).map((e) => e.payload.change);

test('a visitor sees every control read-only, and no Stop or Start', async ({ page }) => {
  await page.goto('/?motion=off');
  await expect(status(page)).toHaveText('Line running · Guarded');
  await expect(page.getByRole('button', { name: /the line/ })).toHaveCount(0);
  const panel = controls(page);
  await expect(panel.locator('.panel-head .label')).toHaveText('Read only');
  const autonomy = panel.getByRole('group', { name: 'Autonomy' });
  await expect(autonomy.getByRole('button', { name: 'Guarded' })).toHaveAttribute('aria-pressed', 'true');
  // Every control of the line: the flags are a panel of their own, and `flags.spec.ts`'s.
  for (const button of await panel.locator('.ctl-group').getByRole('button').all()) {
    await expect(button).toBeDisabled();
  }
  await expect(panel.getByRole('switch', { name: /Agents take new work/ })).toBeChecked();
  await expect(panel.getByRole('switch', { name: /Auto-merge/ })).not.toBeChecked();
  await expect(panel.getByRole('switch', { name: /Auto-rollback/ })).toBeChecked();
  await expect(panel.getByRole('switch', { name: /Auto-rollback/ })).toContainText(
    'On: a canary the analysis judges bad rolls back by itself. Off, errors or latency judged bad would pause it for Martin instead.',
  );
  // What the line takes, tightest first, as Autonomy is.
  await expect(panel.getByRole('group', { name: 'What the line takes' }).getByRole('button')).toHaveText([
    'Just one',
    'The next few',
    'Every ticket',
  ]);
  // Off by default on the laptop's profile, the harness's.
  await expect(panel.getByRole('switch', { name: /Alerts to Martin’s phone/ })).not.toBeChecked();
  const take = panel.getByRole('group', { name: 'What the line takes' });
  await expect(take.getByRole('button', { name: 'The next few' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toContainText('The next 5 work items from');
  // Every level's words are in the panel, the others invisible: the chosen one's are what show.
  await expect(panel.locator('.means .chosen')).toHaveText(
    'Low-risk changes ship on their own. Anything risky waits for Martin. Recorded: until approval routing comes, every merge waits for Martin.',
  );
  await expect(panel.locator('.means > span:not(.chosen)')).toHaveCount(2);
  for (const words of await panel.locator('.means > span:not(.chosen)').all()) await expect(words).toBeHidden();
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expect(panel.locator('.glyph.key')).toHaveCount(0);
});

test('Martin stops the line with a reason, and starts it with his passkey', async ({ page }) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');

  await test.step('Stop the line asks for a reason, and aborts the canary in flight', async () => {
    await page.getByRole('button', { name: 'Stop the line' }).click();
    const dialog = page.getByRole('dialog', { name: 'Stop the line' });
    await expect(dialog).toContainText('make stop-the-line does the same when the console can’t.');
    const stop = dialog.getByRole('button', { name: 'Stop the line' });
    await expect(stop).toBeDisabled();
    await dialog.getByLabel('Reason').fill(REASON);
    await expect(dialog).toContainText(`${REASON.length} / 200`);
    await stop.click();
    await expect(dialog).toBeHidden();
    await expect(status(page)).toHaveText(`Line stopped · “${REASON}”`);
    expect((await stored<{ reason: string }>('line.stopped')).map((e) => e.payload.reason)).toEqual([REASON]);
    await expect.poll(() => rollout.patches.at(-1)).toEqual({ status: { abort: true } });
    expect((await stored<{ stop?: boolean }>('release.controlled')).map((e) => e.payload.stop)).toEqual([true]);
  });

  await test.step('Start the line takes its place, with the key, and runs the passkey sheet in its own dialog', async () => {
    const start = page.getByRole('button', { name: 'Start the line (asks for your passkey)' });
    await expect(page.getByRole('button', { name: 'Stop the line' })).toHaveCount(0);
    await start.click();
    const dialog = page.getByRole('dialog', { name: 'Start the line' });
    await expect(dialog).toContainText('A release stopped with the line stays stopped until you retry it.');
    await dialog.getByLabel('Reason').fill('The deploy is fine');
    await dialog.getByRole('button', { name: 'Use your passkey and start' }).click();
    await expect(dialog).toBeHidden();
    // No second dialog asked for it.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(status(page)).toHaveText('Line running · Guarded');
    await expect(page.locator('.top-right .fresh')).toHaveText('Passkey given · 5min left');
    const started = await stored<{ reason?: string }>('line.started');
    expect(started.map((e) => [e.actor, e.payload.reason])).toEqual([['martin', 'The deploy is fine']]);
    await expect(page.getByRole('button', { name: 'Stop the line' })).toBeVisible();
  });

  await test.step('a stop the service refuses says why in the dialog', async () => {
    // Stopped from elsewhere since the page last heard: the service says so, where he pressed.
    await page.route('**/admin/line/stop', (route) =>
      route.fulfill({ status: 409, json: { refused: 'line', message: 'The line is stopped already.' } }),
    );
    await page.getByRole('button', { name: 'Stop the line' }).click();
    const dialog = page.getByRole('dialog', { name: 'Stop the line' });
    await dialog.getByLabel('Reason').fill('Again');
    await dialog.getByRole('button', { name: 'Stop the line' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('The line is stopped already.');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.unroute('**/admin/line/stop');
  });
});

test('Martin tightens and loosens autonomy, turns a switch, and widens and narrows the take, in Controls and in the settings', async ({
  page,
}) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  const panel = controls(page);
  const autonomy = panel.getByRole('group', { name: 'Autonomy' });
  const take = panel.getByRole('group', { name: 'What the line takes' });

  // Where Switches and What the line takes sit under Autonomy in each place, at the first level seen there: the same
  // at every level after, with the keys drawn or not. Then back to Controls, at the test's own width.
  const under = new Map<string, number[]>();
  const viewport = page.viewportSize() ?? WIDTHS.laptop;
  const steady = (level: string) =>
    test.step(`nothing under Autonomy moves at ${level}`, async () => {
      for (const [where, url, size, find] of PLACES) {
        await page.setViewportSize(size);
        await page.goto(url);
        await page.evaluate(() => document.fonts.ready);
        const here = find(page);
        await expect(
          here.getByRole('group', { name: 'Autonomy' }).getByRole('button', { name: new RegExp(`^${level}`) }),
        ).toHaveAttribute('aria-pressed', 'true');
        const at = [await labelTop(here, 'Switches'), await labelTop(here, 'What the line takes')];
        expect(at, `${where}, at ${level}`).toEqual(under.get(where) ?? at);
        under.set(where, at);
      }
      await page.setViewportSize(viewport);
      await page.goto('/?motion=off');
    });

  // Before the passkey is given: the keys are drawn.
  await steady('Guarded');

  await test.step('the key is drawn only where a change loosens', async () => {
    await expect(panel.locator('.panel-head .label')).toHaveCount(0);
    await expect(autonomy.getByRole('button', { name: 'Lights-out (asks for your passkey)' })).toBeVisible();
    await expect(autonomy.getByRole('button', { name: 'Supervised', exact: true })).toBeVisible();
    await expect(
      panel.getByRole('switch', { name: /Auto-merge low-risk changes \(asks for your passkey\)/ }),
    ).toBeVisible();
    await expect(take.getByRole('button', { name: 'Every ticket (asks for your passkey)' })).toBeVisible();
    await expect(take.getByRole('button', { name: 'Just one', exact: true })).toBeVisible();
    // Fewer of the next few count again from now, which may take more: Set asks too.
    await panel.getByLabel('How many').fill('2');
    await expect(panel.getByRole('button', { name: 'Set (asks for your passkey)' })).toBeVisible();
    await panel.getByRole('button', { name: 'Cancel' }).click();
    // Auto-rollback is on: turning it off overrides a guardrail.
    await expect(panel.getByRole('switch', { name: /Auto-rollback \(asks for your passkey\)/ })).toBeChecked();
  });

  await test.step('tightening autonomy acts at once', async () => {
    await autonomy.getByRole('button', { name: 'Supervised', exact: true }).click();
    await expect(autonomy.getByRole('button', { name: 'Supervised', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(status(page)).toHaveText('Line running · Supervised');
    expect(await changes()).toEqual([{ control: 'autonomy', before: 'guarded', after: 'supervised' }]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
  await steady('Supervised');

  await test.step('loosening it asks for the passkey again', async () => {
    await autonomy.getByRole('button', { name: 'Guarded (asks for your passkey)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Loosen autonomy' });
    await expect(dialog).toContainText('The line runs at Guarded.');
    await dialog.getByRole('button', { name: 'Use your passkey' }).click();
    await expect(dialog).toBeHidden();
    await expect(status(page)).toHaveText('Line running · Guarded');
    expect((await changes()).at(-1)).toEqual({ control: 'autonomy', before: 'supervised', after: 'guarded' });
    // Fresh now: the keys are gone.
    await expect(panel.locator('.glyph.key')).toHaveCount(1);
    await expect(panel.locator('.legend .glyph.key')).toHaveCount(1);
  });

  await test.step('agents’ new work turns off and on, asking for nothing', async () => {
    const work = panel.getByRole('switch', { name: /Agents take new work/ });
    await work.click();
    await expect(work).not.toBeChecked();
    await work.click();
    await expect(work).toBeChecked();
    expect((await changes()).slice(-2)).toEqual([
      { control: 'new-work', before: true, after: false },
      { control: 'new-work', before: false, after: true },
    ]);
  });

  await test.step('a wider take, then a narrower one', async () => {
    await take.getByRole('button', { name: 'Every ticket' }).click();
    await expect(take.getByRole('button', { name: 'Every ticket' })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).toContainText('The oldest open ticket of the highest severity');
    expect((await changes()).at(-1)).toMatchObject({ control: 'take', after: { kind: 'every' } });

    await take.getByRole('button', { name: 'The next few' }).click();
    await panel.getByLabel('How many').fill('2');
    await panel.getByRole('button', { name: 'Set' }).click();
    await expect(panel).toContainText('The next 2 work items from');
    await expect(panel).toContainText('0 taken so far');
    expect((await changes()).at(-1)).toMatchObject({ control: 'take', after: { kind: 'next-few', count: 2 } });
    await expect(panel.getByRole('button', { name: 'Set' })).toHaveCount(0);
  });

  await test.step('a take the service refuses says why under it', async () => {
    await take.getByRole('button', { name: 'Just one' }).click();
    await panel.getByLabel('Work item #').fill('#1329');
    await panel.getByRole('button', { name: 'Set' }).click();
    // A sample's ticket is none the line takes.
    await expect(panel.getByRole('alert')).toHaveText('#1329 has no open ticket or improvement for the line to take.');
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(take.getByRole('button', { name: 'The next few' })).toHaveAttribute('aria-pressed', 'true');
  });
  await test.step('a looser level and a tighter one, the passkey fresh', async () => {
    for (const level of ['Lights-out', 'Guarded']) {
      await autonomy.getByRole('button', { name: level, exact: true }).click();
      await expect(autonomy.getByRole('button', { name: level, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await steady(level);
    }
  });

  await test.step('a switch turned in the settings shows in Controls', async () => {
    await page.goto('/?view=settings&motion=off');
    const work = linePanel(page).getByRole('switch', { name: /Agents take new work/ });
    await work.click();
    await expect(work).not.toBeChecked();
    await page.goto('/?motion=off');
    const there = controls(page).getByRole('switch', { name: /Agents take new work/ });
    await expect(there).not.toBeChecked();
    await there.click();
    await expect(there).toBeChecked();
    expect((await changes()).slice(-2)).toEqual([
      { control: 'new-work', before: true, after: false },
      { control: 'new-work', before: false, after: true },
    ]);
  });
});

test('Martin sends alerts to his phone, and stops them with his passkey again', async ({ page }) => {
  // Two passkeys at most: the tests before enrolled theirs.
  await harness.database.owner`update passkeys set revoked_at = now() where revoked_at is null`;
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  // The enrolment page stays where it is once the passkey is made: Controls is on the console's.
  await page.goto('/?motion=off');
  const phone = controls(page).getByRole('switch', { name: /Alerts to my phone/ });
  await expect(phone).not.toBeChecked();
  const switched = async () => (await stored<{ phone: boolean }>('alerts.switched')).map((e) => e.payload.phone);

  await test.step('on asks for nothing', async () => {
    await phone.click();
    await expect(phone).toBeChecked();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await switched()).toEqual([true]);
  });

  await test.step('off asks for the passkey again, and says the dashboard still shows them', async () => {
    await expect(
      controls(page).getByRole('switch', { name: /Alerts to my phone \(asks for your passkey\)/ }),
    ).toBeVisible();
    await phone.click();
    const dialog = page.getByRole('dialog', { name: 'Stop alerts to your phone' });
    await expect(dialog).toContainText(
      'Off: none reaches the phone. Grafana’s Alerts dashboard still shows every one.',
    );
    await dialog.getByRole('button', { name: 'Use your passkey' }).click();
    await expect(dialog).toBeHidden();
    await expect(phone).not.toBeChecked();
    expect(await switched()).toEqual([true, false]);
  });
});

test('Martin turns auto-rollback off with his passkey again, and on at once', async ({ page }) => {
  // Two passkeys at most: the tests before enrolled theirs.
  await harness.database.owner`update passkeys set revoked_at = now() where revoked_at is null`;
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');
  const rollback = controls(page).getByRole('switch', { name: /Auto-rollback/ });
  await expect(rollback).toBeChecked();

  await test.step('off asks for the passkey again, and says what still rolls a canary back', async () => {
    await rollback.click();
    const dialog = page.getByRole('dialog', { name: 'Turn off auto-rollback' });
    await expect(dialog).toContainText(
      'A failed journeys check still rolls it back, and Stop the line still aborts one.',
    );
    await expect(dialog).toContainText('Turning auto-rollback off overrides a guardrail');
    await dialog.getByRole('button', { name: 'Use your passkey' }).click();
    await expect(dialog).toBeHidden();
    await expect(rollback).not.toBeChecked();
    await expect(rollback).toContainText(
      'Off: a canary whose errors or latency the analysis judges bad pauses for you, in Needs you, instead of rolling back.',
    );
    expect((await changes()).at(-1)).toEqual({ control: 'auto-rollback', before: true, after: false });
    // The Canary panel's last line says a failing measure now pauses the canary for Martin.
    await expect(page.locator('section.canary .tooled')).toContainText(
      'With auto-rollback off, the moment errors or latency fail it pauses for Martin',
    );
  });

  await test.step('on asks for nothing', async () => {
    // The passkey is fresh from turning it off, so this shows only that nothing more is asked here; that on never asks
    // is the access table's (`test/access.test.ts`).
    await rollback.click();
    await expect(rollback).toBeChecked();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await changes()).at(-1)).toEqual({ control: 'auto-rollback', before: false, after: true });
  });
});
