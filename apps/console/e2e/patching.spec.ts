/**
 * Patching (milestone 7, task 32): the panel from the samples' day, above Guardrails. What waits on Martin first, then
 * by deadline; a row opens in place, one at a time; a visitor reads it read-only, a lockfile's package withheld until
 * its pull request is open, and Martin reads it whole, with code scanning a link away. The panel's code arrives as a
 * chunk of its own after the first view, and an event it does not read renders nothing there, while a new day renders
 * it once. Snapshots are `visual.spec.ts`'s.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { RawEvent } from '@software-factory/events';
import { adminService, consoleUrl, END, expect, ready, test, WIDTHS } from './support.ts';

const panel = (page: Page) => page.locator('#patching');
const rows = (page: Page) => panel(page).locator('.pm > button');
const row = (page: Page, name: string) => rows(page).filter({ has: page.locator(`.name:text-is("${name}")`) });

async function patching(page: Page, as: 'visitor' | 'martin' = 'visitor') {
  await adminService(page, as);
  await page.goto(consoleUrl());
  await ready(page);
  await panel(page).scrollIntoViewIfNeeded();
  await rows(page).first().waitFor();
}

test.use({ viewport: WIDTHS.desktop });

test('a visitor reads the day: what waits on Martin first, then by deadline, and the scan’s day in a line', async ({
  page,
}) => {
  await patching(page);
  await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('Patching');
  await expect(panel(page).locator('.panel-head .label')).toHaveText(
    '11 moves · 1 unscanned image running · 4 wait on Martin · Read only',
  );
  await expect(panel(page).locator('.pm .name')).toHaveText([
    'example-cd',
    'example-logs',
    'k3s',
    'Unscanned image running',
    'example/scanner-proxy',
    'A package in the app’s lockfile',
    'example-dashboards',
    'example/sbom-tool',
    'example/sidecar',
    'example/node-base',
    '@example/tokens',
    'example/cluster-proxy',
  ]);
  await expect(panel(page).locator('.pm.wait')).toHaveCount(4);
  await expect(panel(page).locator('.pm.wait .v').first()).toHaveText('Waits on Martin');
  await expect(row(page, 'A package in the app’s lockfile')).toContainText('versions once its pull request opens');
  await expect(panel(page).locator('.patch-day')).toContainText('Scan failed today');
  await expect(panel(page).locator('.patch-day')).toContainText(
    '41 new High or Critical: 6 have a fix (in 2 moves below), 35 have none yet',
  );
  await expect(panel(page).locator('.patch-counts b')).toHaveText(['15,056', '1,732', '0', '0']);
  // Nothing of code scanning for a visitor, who cannot open it.
  await expect(panel(page).getByRole('link', { name: /Code scanning/ })).toHaveCount(0);

  const scan = await new AxeBuilder({ page })
    .include('#patching')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test('a row opens in place, one at a time: why it waits, what to do, what it clears and every pin', async ({
  page,
}) => {
  await patching(page, 'martin');
  const logs = row(page, 'example-logs');
  await logs.click();
  await expect(logs).toHaveAttribute('aria-expanded', 'true');
  const more = panel(page).locator(`#${await logs.getAttribute('aria-controls')}`);
  await expect(more).toContainText('Its fix is a major on, so the review gate passes it only with your approval.');
  await expect(more).toContainText('Move it in a pull request of your own, and review it there.');
  await expect(more).toContainText('Clears · 56 findings');
  await expect(more).toContainText('1 Critical, 21 High, 30 Medium, 4 Low');
  await expect(more.getByRole('link', { name: /Code scanning/ })).toHaveAttribute(
    'href',
    'https://github.com/the-roganator/cv-software-factory/security/code-scanning',
  );
  await expect(more.locator('.pins')).toContainText('telemetry/logs.yaml:14');

  const sbom = row(page, 'example/sbom-tool');
  await sbom.click();
  await expect(sbom).toHaveAttribute('aria-expanded', 'true');
  await expect(logs).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page).locator('.more')).toHaveCount(1);
  await expect(panel(page).locator('.more')).toContainText('Dependabot opened #1339, to v1.55.1');
});

test('Martin reads the app’s lockfile move whole, and “you” for himself', async ({ page }) => {
  await patching(page, 'martin');
  await expect(panel(page).locator('.panel-head .label')).toHaveText(
    '11 moves · 1 unscanned image running · 4 wait on you',
  );
  await expect(row(page, '@example/parser')).toContainText('4.2.0 → 4.2.3');
  await expect(panel(page).locator('.pm.wait .v').first()).toHaveText('Waits on you');
});

/** The samples' events, as the stream would have sent them, and one after them. */
const SAMPLES = readFileSync(
  fileURLToPath(new URL('../../../packages/samples/log/events.ndjson', import.meta.url)),
  'utf-8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as RawEvent & { ts: string; seq: number; payload: unknown });
const LAST = SAMPLES.at(-1)?.seq ?? 0;
const after = (n: number, like: (typeof SAMPLES)[number], payload = like.payload) =>
  ({
    ...like,
    id: `patching-after-${n}`,
    seq: LAST + n,
    ts: new Date(END + n * 1000).toISOString(),
    payload,
  }) as RawEvent;

test('an event Patching does not read renders nothing there, and a new day renders it once', async ({ page }) => {
  // A stream that says the store holds samples and then sends what the test gives it, as the bird's test does.
  await page.addInitScript(() => {
    const scope = globalThis as unknown as { sfStream: unknown; EventSource: unknown };
    class Stream extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        super();
        scope.sfStream = this;
        setTimeout(() => {
          this.onopen?.(new Event('open'));
          this.dispatchEvent(new MessageEvent('store', { data: JSON.stringify({ kind: 'sample' }) }));
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
    }
    scope.EventSource = Stream;
  });
  // A time a minute past the samples' end, which holds every event this test sends.
  const at = new Date(END + 60_000).toISOString();
  await page.goto(`/?t=${at}&theme=paper&motion=off&debug=renders`);
  await ready(page);
  await rows(page).first().waitFor();
  const send = (raw: RawEvent) =>
    page.evaluate((raw) => {
      const stream = (globalThis as unknown as { sfStream: { onmessage: (event: MessageEvent) => void } }).sfStream;
      stream.onmessage(new MessageEvent('message', { data: JSON.stringify(raw) }));
    }, raw);
  const renders = () =>
    page.evaluate(() => (globalThis as { sfRenders?: { patching?: number } }).sfRenders?.patching ?? -1);
  const before = await renders();
  expect(before).toBeGreaterThan(0);

  // Martin's change of his controls, which the header and Controls read, and Patching does not.
  const controls = SAMPLES.findLast((e) => e.type === 'controls.changed');
  if (!controls) throw new Error('the samples have no controls.changed');
  await send(after(1, controls));
  await expect(page.locator('#patching')).toBeVisible();
  // Long enough for a render to have happened.
  await page.waitForTimeout(500);
  expect(await renders()).toBe(before);

  // A new day from the sense, with the unscanned image gone.
  const day = SAMPLES.findLast((e) => e.type === 'patching.read');
  if (!day) throw new Error('the samples have no patching.read');
  const payload = { ...(day.payload as { rows: unknown[] }), rows: [] };
  await send(after(2, day, payload));
  await expect(panel(page).locator('.panel-head .label')).toHaveText('11 moves · 3 wait on Martin · Read only');
  expect(await renders()).toBe(before + 1);
});
