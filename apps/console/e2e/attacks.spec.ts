/**
 * Launching a red-team attack, end to end (milestone 7, task 22): the console against the real admin service on a
 * throwaway store holding the samples, on one origin behind a proxy standing in for Traefik (`admin.ts`), with a
 * virtual passkey. Martin launches an attack from its guardrail's row, with no passkey asked; the service opens its
 * work item and records his launch on it, and its card and its row's Running arrive with those events, every other
 * Launch waiting. Needs Postgres: TEST_DATABASE_URL, or Docker.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { enrolThroughTheDoor, type Harness, startHarness, virtualPasskey } from './admin.ts';
import { expect, test } from './support.ts';

const PORT = 18_342;

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'attacks');
});
test.afterAll(async () => {
  await harness?.stop();
});

const rowButton = (page: Page, n: number) =>
  page.locator('#guardrails .gr > button').filter({ has: page.locator(`.n:text-is("${n}")`) });

/**
 * The samples end with an attack in flight, their times moved so the last is now: the harness's role records it
 * unfinished, as a harness that restarts would, so the next launch need not wait out its 10 minutes.
 */
async function endTheSamplesAttack() {
  const writer = new EventWriter(harness.database.redteam, {
    kind: 'sample',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
  await writer.append({
    id: randomUUID(),
    ts: new Date().toISOString(),
    work_item: '1335',
    type: 'attack.finished',
    version: 1,
    actor: 'factory',
    summary: 'The attack was not seen to its end',
    payload: { attack: 'image', outcome: 'unfinished', expected: ['admission-control'], refusals: [], attempts: [] },
    artifacts: [],
  });
}

test('Martin launches an attack from its guardrail’s row, and every other Launch waits for it', async ({ page }) => {
  await endTheSamplesAttack();
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');
  await page.locator('#guardrails').scrollIntoViewIfNeeded();

  await rowButton(page, 5).click();
  await page.locator('#guardrails .more').getByRole('button', { name: 'Launch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Data to an outside URL' });
  // No key on Launch: an attack asks for no passkey.
  await expect(dialog.getByRole('button', { name: 'Launch' })).toHaveAccessibleName('Launch');
  await dialog.getByRole('button', { name: 'Launch' }).click();
  await expect(dialog).toHaveCount(0);

  const launched = () =>
    harness.database.owner<
      { work_item: string; type: string; appended_by: string; payload: Record<string, unknown> }[]
    >`
      select work_item, type, appended_by, payload from events
      where work_item = (select work_item from events where type = 'attack.launched' and payload->>'attack' = 'egress'
                         order by seq desc limit 1)
      order by seq`;
  await expect
    .poll(async () => (await launched()).map((e) => [e.type, e.appended_by]))
    .toEqual([
      ['work-item.opened', 'factory_admin'],
      ['attack.launched', 'factory_admin'],
    ]);
  const [opened] = await launched();
  expect(opened?.payload).toMatchObject({ kind: 'red-team', category: 'red-team', title: 'Red-team attack by Martin' });

  // Its row reads Running as its events arrive, and every other attack's Launch waits, saying which runs.
  await expect(page.locator('#guardrails .more').getByRole('button', { name: 'Running' })).toBeDisabled();
  await rowButton(page, 8).click();
  await expect(page.locator('#guardrails .more').getByRole('button', { name: 'Launch' })).toBeDisabled();
  await expect(page.locator('#guardrails .more .gr-busy')).toContainText(
    `One at a time: #${opened?.work_item} is running`,
  );
  // And its card is on the reel, named by its attack.
  await page.goto(`/?motion=off&item=${opened?.work_item}`);
  await expect(page.locator('.card[data-place="centre"] h3')).toHaveText('Data to an outside URL');
  await expect(page.locator('.card[data-place="centre"] .kind')).toHaveText('· Red-team attack by Martin');
});
