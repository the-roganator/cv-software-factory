/**
 * Martin's controls of the canary, end to end: the Canary panel's buttons against the real admin service on a
 * throwaway store, on one origin behind a proxy standing in for Traefik (`admin.ts`), with a virtual passkey. The
 * Rollout is a stand-in that merge-patches as Kubernetes does, at the samples' release in flight (v0.9.13 at 50%),
 * which the store records as the line would. Pausing acts at once; aborting asks first in a dialog, and says when
 * Martin's pause could not be cleared after it; retrying and promoting ask for the passkey again, then the header's
 * pill counts it down and the keys are gone. An abort, a retry and a full promotion each show as under way the moment
 * the admin service records them, with nothing left to press, until the line records what came of them, which the
 * test appends as the line would at its next pass. Needs Postgres: TEST_DATABASE_URL, or Docker.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { VERSIONS } from '@software-factory/events';
import { appendMartins } from '../../factory/src/admin/store.ts';
import { enrolThroughTheDoor, type Harness, Rollout, startHarness, virtualPasskey } from './admin.ts';
import { expect, test } from './support.ts';

const PORT = 18_332;
const RELEASE = 'v8q7chmx72-913';

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;
const rollout = new Rollout();

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'canary_controls', {
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
});
test.afterAll(async () => {
  await harness?.stop();
});

const panel = (page: Page) => page.locator('section.canary');
const controlled = () =>
  harness.database.owner<{ payload: { action: string } }[]>`
    select payload from events where type = 'release.controlled' order by seq`;

test('a visitor sees Martin’s controls as labels, beside what each does', async ({ page }) => {
  await page.goto('/?motion=off');
  const controls = panel(page).locator('.canary-controls');
  await expect(controls.locator('.label')).toHaveText('Martin’s controls');
  await expect(controls.locator('dt')).toHaveText(['Promote fully', 'Pause', 'Abort']);
  await expect(controls.getByRole('button')).toHaveCount(0);
  await expect(controls).toContainText('Sends all the traffic back to v0.9.12. Nothing failed, so it opens no ticket.');
});

/** The line's record of what came of an act, as it would append it at its next pass. */
async function lineRecords(type: 'release.aborted' | 'release.started', payload: object) {
  const line = harness.database.as.line;
  await line.begin((tx) =>
    appendMartins(line, tx, [
      {
        id: randomUUID(),
        ts: new Date().toISOString(),
        work_item: null,
        type,
        version: VERSIONS[type],
        actor: 'rollouts',
        summary: type,
        payload: { release: RELEASE, version: 'v0.9.13', ...payload },
        artifacts: [],
      },
    ] as never),
  );
}

test('Martin pauses at once, aborts behind a dialog, retries with his passkey again, and promotes, each shown as he acts', async ({
  page,
}) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');
  const controls = panel(page).locator('.canary-controls');
  const kicker = panel(page).locator('.kick .out');
  const note = panel(page).locator('.canary-note');
  await expect(controls.locator('.label')).toHaveText('Your controls');

  await test.step('Pause asks for nothing, and holds the canary at once', async () => {
    await controls.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(async () => (await controlled()).map((c) => c.payload.action)).toEqual(['pause']);
    expect(rollout.patches).toEqual([{ spec: { paused: true } }]);
    await expect(kicker).toHaveText(/^Paused by Martin/);
    await expect(controls.getByRole('button', { name: 'Resume' })).toBeVisible();
  });

  await test.step('Abort asks first, and Cancel or Escape does nothing', async () => {
    // His pause is set, so the abort clears it, which finds the Rollout changed every time it is tried.
    rollout.specConflicts = 3;
    await controls.getByRole('button', { name: 'Abort' }).click();
    const dialog = page.getByRole('dialog', { name: 'Abort the canary' });
    await expect(dialog).toContainText(
      'v0.9.12, the version before, takes all the traffic at once. Nothing failed, so it opens no ticket, and #1314 waits for your retry or the next deploy.',
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(controls.getByRole('button', { name: 'Abort' })).toBeFocused();
    await controls.getByRole('button', { name: 'Abort' }).click();
    await dialog.getByRole('button', { name: 'Abort' }).click();
    await expect.poll(async () => (await controlled()).map((c) => c.payload.action)).toEqual(['pause', 'abort']);
    expect(rollout.patches.at(-1)).toEqual({ status: { abort: true } });
  });

  await test.step('the abort shows at once, before the line records it, with what was left undone', async () => {
    await expect(kicker).toHaveText('Aborting at 50%…');
    await expect(note).toContainText('You aborted the canary at 50%');
    await expect(note).toContainText('The line records it at its next pass.');
    await expect(controls.getByRole('button')).toHaveCount(0);
    // Made, and recorded, with the pause still set: the panel says so where he pressed.
    await expect(controls.getByRole('alert')).toHaveText(
      'Done, but your pause is still set: the Rollout kept changing. Resume the canary when the panel offers it, or the next release starts paused.',
    );
    await lineRecords('release.aborted', { by: 'martin', restored: 'v0.9.12', abortedAt: new Date().toISOString() });
    await expect(kicker).toHaveText(/^Aborted by Martin/);
  });

  await test.step('Retry carries the key, asks for the passkey again, and shows at once', async () => {
    const retry = controls.getByRole('button', { name: 'Retry (asks for your passkey)' });
    await expect(retry).toBeVisible();
    await expect(page.locator('.top-right .fresh')).toHaveCount(0);
    await retry.click();
    const dialog = page.getByRole('dialog', { name: 'Retry the release' });
    await expect(dialog).toContainText('Your passkey, again');
    await expect(dialog.getByRole('heading', { name: 'Retry the release' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Use your passkey' }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await controlled()).map((c) => c.payload.action))
      .toEqual(['pause', 'abort', 'retry']);
    // Fresh for five minutes: the pill counts it down.
    await expect(page.locator('.top-right .fresh')).toHaveText('Passkey given · 5min left. End it now');
    await expect(kicker).toHaveText('Starting again…');
    await expect(note).toContainText('You retried the release');
    await expect(controls.getByRole('button')).toHaveCount(0);
    await lineRecords('release.started', {
      previous: 'v0.9.12',
      image: { digest: `sha256:${'6'.repeat(64)}`, signed: true, admitted: true },
      watched: true,
      steps: null,
      dryRun: false,
    });
    await expect(kicker).toHaveText(/^Canary · /);
  });

  await test.step('a refusal shows where he pressed', async () => {
    // The stand-in's release moved on: the service refuses, and the panel says why. The passkey is still fresh, so
    // Promote fully asks for nothing, and its key is gone.
    const hash = (rollout.object.status as { currentPodHash: string }).currentPodHash;
    (rollout.object.status as { currentPodHash: string }).currentPodHash = 'zzzzzzzzzz';
    await controls.getByRole('button', { name: 'Promote fully', exact: true }).click();
    await expect(controls.getByRole('alert')).toHaveText(
      'That release is no longer the one in the Rollout: look again.',
    );
    (rollout.object.status as { currentPodHash: string }).currentPodHash = hash;
  });

  await test.step('Promote fully shows at once, with nothing left to press', async () => {
    await controls.getByRole('button', { name: 'Promote fully', exact: true }).click();
    await expect
      .poll(async () => (await controlled()).map((c) => c.payload.action))
      .toEqual(['pause', 'abort', 'retry', 'promote-fully']);
    expect(rollout.patches.at(-1)).toEqual({ status: { promoteFull: true } });
    await expect(kicker).toHaveText('Promoting fully…');
    await expect(note).toContainText('You promoted the canary fully');
    await expect(controls.getByRole('button')).toHaveCount(0);
  });
});
