/**
 * Milestone 6's Canary panel, a sheet's releases and the scoreboard in the browser, from the samples: what each state
 * says in words, so it reads without colour, Martin's controls as a visitor reads them (his own are
 * `canary-controls.spec.ts`'s), that the panel's work items open their sheets, and WCAG 2.2 AA in both
 * themes at a laptop's width and a phone's.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { CANARY, consoleUrl, expect, RETURNED, SCORE, scored, shown, THEMES, test, WIDTHS } from './support.ts';

const panel = (page: Page) => page.getByRole('region', { name: /./ }).and(page.locator('section.canary'));

test.describe('the Canary panel', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('draws the release in flight at the step it is measuring, and opens the work it carries', async ({ page }) => {
    await page.goto(consoleUrl());
    await shown(page);
    const canary = panel(page);
    await expect(canary.locator('.kick')).toHaveText('Canary · 50% of traffic');
    await expect(canary.getByRole('heading', { level: 2 })).toHaveText('The contact form loses your message');
    // Martin's controls, as labels: at 50% the next step is all of the traffic, so there is no step to promote to.
    await expect(canary.locator('.canary-controls dt')).toHaveText(['Promote fully', 'Pause', 'Abort']);
    await expect(canary.locator('.canary-controls').getByRole('button')).toHaveCount(0);
    await expect(canary.getByRole('list', { name: 'The canary’s steps' }).getByRole('listitem')).toHaveText([
      /^25%3min, passed$/,
      /^50%3min, measuring now$/,
      /^100%all, to come$/,
    ]);
    // The background analysis's latest looks, a minute apart, and the step's time left.
    await expect(canary.locator('table.measures caption')).toHaveText(
      'At the 50% step · measuring until 15:24:00 · next look in 0:30',
    );
    await expect(canary.locator('.steptime')).toContainText('Measuring the 50% step0:29 left');
    const row = (name: string) => canary.getByRole('row', { name: new RegExp(`^${name} `) });
    await expect(row('Requests')).toContainText('376');
    await expect(row('Requests')).toContainText('enough');
    await expect(row('Errors')).toContainText('1.02 pt to spare');
    await expect(row('Latency')).toContainText('128 ms');
    await expect(row('Latency')).toContainText('102 ms to spare');
    await expect(row('Journeys')).toContainText('none worse here');
    await expect(page.getByRole('button', { name: /^Release: .*, 50% · 1 waiting[.,] / })).toBeVisible();
    await canary.getByRole('button', { name: '#1314' }).click();
    await expect(page.getByRole('dialog', { name: 'The contact form loses your message' })).toBeVisible();
  });

  test('counts the requests before the first step, and waits for enough of them to judge', async ({ page }) => {
    await page.goto(consoleUrl({ at: CANARY['first-step'] }));
    await shown(page);
    const canary = panel(page);
    await expect(canary.locator('.kick')).toHaveText('Canary · 25% of traffic');
    await expect(canary.locator('table.measures caption')).toHaveText(
      'At the 25% step · measuring until 15:21:00 · next look in 0:31',
    );
    const rows = canary.locator('table.measures tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0).locator('td.mono')).toHaveText(['76 / 100baseline 824', '824']);
    await expect(rows.nth(0)).toContainText('counting');
    for (const row of (await rows.all()).slice(1))
      await expect(row.locator('td.mono')).toHaveText(['—baseline —', '—']);
    await expect(rows.nth(1)).toContainText('waits for 100 requests');
    await expect(rows.nth(2)).toContainText('waits for 100 requests');
    await expect(rows.nth(3)).toContainText('waits for its first run');
  });

  test('says a step passed, in green, until the next look lands', async ({ page }) => {
    await page.goto(consoleUrl({ at: Date.parse('2026-10-06T14:21:05Z') }));
    await shown(page);
    const verdicts = panel(page).locator('table.measures tbody tr td:last-child');
    await expect(verdicts).toHaveText(Array(4).fill('passed at 25%'));
  });

  test('counts a figure up from the look before when a later look arrives on the stream', async ({ page, request }) => {
    type Raw = { seq: number; type: string };
    const events = (await (await request.get('/api/events')).json()) as Raw[];
    const latest = events.findLast((e) => e.type === 'canary.measuring');
    if (!latest) throw new Error('No look in the samples');
    // Everything before the samples' last look is read; the look itself comes on the stream once the panel is drawn.
    await page.route('**/api/events?after=0', (route) =>
      route.fulfill({ json: events.filter((e) => e.seq < latest.seq) }),
    );
    await page.addInitScript(() => {
      const Real = globalThis.EventSource;
      class Held extends EventTarget {
        readyState = 1;
        onopen: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor() {
          super();
          (globalThis as { held?: Held }).held = this;
          setTimeout(() => this.onopen?.(new Event('open')), 0);
        }
        close() {
          this.readyState = 2;
        }
      }
      class Either {
        constructor(url: string, init?: EventSourceInit) {
          // biome-ignore lint/correctness/noConstructorReturn: the public stream held here, any other the browser's
          return url.startsWith('/api/events/stream') ? new Held() : new Real(url, init);
        }
      }
      (globalThis as { EventSource: unknown }).EventSource = Either;
    });
    await page.goto(consoleUrl({ motion: true }));
    await shown(page);
    const cell = panel(page)
      .getByRole('row', { name: /^Requests / })
      .locator('td.mono')
      .first();
    await expect(cell).toHaveText('301baseline 599');
    // Each frame's text of the figure while the look lands, read from the text node React drew.
    const seen = await cell.evaluate(async (td, data) => {
      const held = (globalThis as { held?: { onmessage: ((event: MessageEvent) => void) | null } }).held;
      held?.onmessage?.(new MessageEvent('message', { data }));
      const texts: string[] = [];
      const until = performance.now() + 1200;
      while (performance.now() < until) {
        texts.push(td.firstChild?.nodeValue ?? '');
        await new Promise(requestAnimationFrame);
      }
      return texts;
    }, JSON.stringify(latest));
    const between = seen.map(Number).filter((n) => n > 301 && n < 376);
    expect(between.length, seen.join(' ')).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe('376');
    await expect(cell).toHaveText('376baseline 524');
  });

  test('says a rollback’s story in words, and links the ticket its signal opened', async ({ page }) => {
    await page.goto(consoleUrl({ at: CANARY['rolled-back-no-step'] }));
    await shown(page);
    const canary = panel(page);
    await expect(canary.locator('.kick')).toHaveText('Rolled back at 25%');
    await expect(canary.getByRole('heading', { level: 2 })).toHaveText('Carries no work item');
    await expect(canary).toContainText('No step was measured: it rolled back 3min into the 25% step');
    await expect(canary.getByRole('row', { name: /^Latency / })).toContainText(
      'no figures to compare, which counts as infinitely worse',
    );
    // Argo Rollouts counts the failed looks across the run, not in a row.
    await expect(canary.getByRole('row', { name: /^Latency / })).toContainText('failed twice');
    await expect(canary).toContainText('75% of the traffic never saw it: it stayed on v0.9.8.');
    await expect(canary.getByRole('button', { name: '#1308 Slow responses in a canary release' })).toBeVisible();
  });

  test('says both versions’ figures for a failed measure the line drew', async ({ page, request }) => {
    type Event = { ts: string; type: string; payload: { failed?: Record<string, unknown>[] } };
    const events = (await (await request.get('/api/events')).json()) as Event[];
    // As the line records a rollback with Prometheus to read: the analysis's figure, and each version's series to it.
    const rolledBack = events.find((e) => e.type === 'release.rolled-back' && e.ts.startsWith('2026-10-05T10:23'));
    const [measure] = rolledBack?.payload.failed ?? [];
    if (!measure) throw new Error('No failed measure on Monday’s rollback');
    Object.assign(measure, {
      value: 0.27624,
      series: {
        label: 'p99 latency',
        unit: 'ms',
        stepSeconds: 15,
        canary: [40.1, 415.2],
        baseline: [38.5, 38.96],
        at: 1,
      },
    });
    await page.route('**/api/events?after=0', (route) => route.fulfill({ json: events }));
    await page.goto(consoleUrl({ at: CANARY['rolled-back-no-step'] }));
    await shown(page);
    await expect(panel(page).getByRole('row', { name: /^Latency / })).toContainText(
      'p99 415 ms against 39 ms: 276 ms over its limit',
    );
  });

  test('leaves Release’s panel saying what a merge’s deploy waits for: its checks, before it is Martin’s', async ({
    page,
  }) => {
    await page.goto(consoleUrl());
    await shown(page);
    await page.getByRole('button', { name: /^Release: .*, 50% · 1 waiting[.,] / }).click();
    await expect(page.getByRole('dialog', { name: 'Release' })).toContainText('Merged · deploy #1331’s checks running');
  });

  test('draws each abort and an analysis error, marks a dry run, and keeps the last release in full until the next', async ({
    page,
  }) => {
    await page.goto(consoleUrl({ at: CANARY.stopped }));
    await shown(page);
    await expect(panel(page).locator('.kick')).toHaveText('Stopped with the line at 50%');
    await page.goto(consoleUrl({ at: CANARY.aborted }));
    await shown(page);
    await expect(panel(page).locator('.kick')).toHaveText('Aborted by Martin at 25%');
    await expect(panel(page)).toContainText('Martin aborted the canary at 25%');
    // A visitor reads Martin's controls as labels, with what each does: here, his retry.
    await expect(panel(page).locator('.canary-controls .label')).toHaveText('Martin’s controls');
    await expect(panel(page).locator('.canary-controls dt')).toHaveText(['Retry']);
    await page.goto(consoleUrl({ at: CANARY.errored }));
    await shown(page);
    await expect(panel(page).locator('.kick')).toHaveText('Stopped by an analysis error at 25%');
    await expect(panel(page)).toContainText('The analysis could not judge the canary at 25%');
    await page.goto(consoleUrl({ at: CANARY['dry-run'] }));
    await shown(page);
    await expect(panel(page).locator('.kick')).toHaveText('Canary · 50%, as the dry run records itDry run');
    await expect(panel(page)).toContainText('no image: nothing shipped');
    // Nearly an hour after its promotion, with nothing in flight, the panel still draws it in full.
    await page.goto(consoleUrl({ at: Date.parse('2026-10-06T08:00:00Z') }));
    await shown(page);
    await expect(panel(page).locator('.kick')).toHaveText('Promoted · all traffic');
    await expect(panel(page)).not.toContainText('No release in flight');
  });

  // A row is one line at every laptop width, with the steps beside the measures (above 1180px) or above them; on a
  // tablet a caption may wrap, and the table never runs past the panel.
  for (const width of [800, 1024, 1181, 1200, 1280, 1440]) {
    test(`keeps the measures inside the panel, each rule's caption one line on a laptop, at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(consoleUrl());
      await shown(page);
      const canary = panel(page);
      const captions = canary.locator('.measures small.measure-rule');
      await expect(captions).toHaveCount(4);
      for (const caption of width >= WIDTHS.laptop.width ? await captions.all() : []) {
        const [height, line] = await caption.evaluate((el) => [
          el.getBoundingClientRect().height,
          Number.parseFloat(getComputedStyle(el).lineHeight),
        ]);
        expect(height, await caption.innerText()).toBeLessThan(line * 1.5);
      }
      const right = (el: Element) => el.getBoundingClientRect().right;
      const table = await canary.locator('table.measures').evaluate(right);
      const body = await canary.locator('.canary-body').evaluate(right);
      expect(table).toBeLessThanOrEqual(body + 0.5);
    });
  }

  // A rollback at the step last measured draws the measures' own table, with the trend column once looks were
  // recorded: it takes the same width, and the rollback's words beside it wrap to the table rather than widen it.
  for (const width of [1200, 1440]) {
    test(`keeps a rollback's measures, with looks, inside the panel and beside its steps, at ${width}px`, async ({
      page,
      request,
    }) => {
      type Event = {
        seq: number;
        ts: string;
        work_item: string | null;
        type: string;
        payload: Record<string, unknown>;
      };
      const events = (await (await request.get('/api/events')).json()) as Event[];
      const rolledBack = events.find((e) => e.type === 'release.rolled-back' && e.ts.startsWith('2026-10-02T07:25'));
      const sample = events.find((e) => e.type === 'canary.measuring');
      if (!rolledBack || !sample) throw new Error('No rollback on 2 October, or no look in the samples');
      const at = '2026-10-02T07:24:50Z';
      const look = {
        ...sample,
        id: crypto.randomUUID(),
        ts: '2026-10-02T07:24:55.000Z',
        work_item: rolledBack.work_item,
        payload: {
          ...sample.payload,
          release: rolledBack.payload.release,
          weight: 5,
          at,
          measures: (sample.payload.measures as Record<string, unknown>[]).map((m) => ({ ...m, at })),
        },
      };
      // The look just before the rollback, and every event numbered again in that order.
      const served = events.flatMap((e) => (e === rolledBack ? [look, e] : [e])).map((e, i) => ({ ...e, seq: i + 1 }));
      await page.route('**/api/events?after=0', (route) => route.fulfill({ json: served }));
      await page.setViewportSize({ width, height: 900 });
      await page.goto(consoleUrl({ at: CANARY['rolled-back'] }));
      await shown(page);
      const canary = panel(page);
      await expect(canary.locator('table.measures.trended')).toHaveCount(1);
      const box = (selector: string) =>
        canary
          .locator(selector)
          .first()
          .evaluate((el) => el.getBoundingClientRect().toJSON());
      const [table, body, steps] = [await box('table.measures'), await box('.canary-body'), await box('.canary-steps')];
      expect(table.right).toBeLessThanOrEqual(body.right + 0.5);
      expect(steps.width).toBeGreaterThan(200);
    });
  }
});

test.describe('the Canary panel on a phone', () => {
  test.use({ viewport: WIDTHS.phone });

  test('keeps a measure’s own words, and drops the rules’ captions', async ({ page, request }) => {
    type Measure = { name: string; phase: string; message?: string };
    type Event = { type: string; payload: { version?: string; measures?: Measure[] } };
    const events = (await (await request.get('/api/events')).json()) as Event[];
    // The release in flight's latest look at the journeys, as if they could not be measured.
    const look = events.findLast(
      (e) =>
        e.type === 'canary.measuring' &&
        e.payload.version === 'v0.9.13' &&
        e.payload.measures?.some((m) => m.name === 'journeys'),
    );
    const journeys = look?.payload.measures?.find((m) => m.name === 'journeys');
    if (!journeys) throw new Error('No journeys looked at on v0.9.13');
    Object.assign(journeys, { phase: 'error', message: 'The journeys Job did not finish' });
    await page.route('**/api/events?after=0', (route) => route.fulfill({ json: events }));
    await page.goto(consoleUrl());
    await shown(page);
    const row = panel(page).getByRole('row', { name: /^Journeys/ });
    await expect(row).toContainText('could not measure');
    await expect(row.getByText('The journeys Job did not finish')).toBeVisible();
    await expect(row.locator('.measure-rule')).toBeHidden();
  });
});

test.describe('a rollback’s chart', () => {
  test.use({ viewport: WIDTHS.desktop });

  // At 20 seconds a step, the x axis labels each minute: a rollback at 1:00 leaves its time to the axis, one at 1:20
  // keeps it.
  for (const [at, label] of [
    [3, 'rolled back'],
    [4, 'rolled back · 1:20'],
  ] as const) {
    test(`keeps each label clear of the others where both lines end at the rollback, "${label}"`, async ({
      page,
      request,
    }) => {
      type Series = { canary: (number | null)[]; baseline: (number | null)[]; at: number };
      type Event = { work_item: string | null; type: string; payload: { failed?: { series?: Series }[] } };
      const events = (await (await request.get('/api/events')).json()) as Event[];
      // As the release worker reads one: both lines end where the canary failed, the baseline's near nothing.
      const rolledBack = events.find((e) => e.work_item === '1276' && e.type === 'release.rolled-back');
      const measure = rolledBack?.payload.failed?.find((m) => m.series);
      if (!measure?.series) throw new Error('No series on #1276’s rollback');
      const canary = [0, 2, 6, 12, 18].slice(0, at + 1);
      measure.series = { ...measure.series, canary, baseline: canary.map(() => 0), at };
      await page.route('**/api/events?after=0', (route) => route.fulfill({ json: events }));
      await page.goto(consoleUrl({ item: '1276' }));
      const chart = page.locator('.card[data-place="centre"] svg.chart');
      await chart.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      const boxes = await chart
        .locator('text')
        .evaluateAll((texts) =>
          texts.map((text) => ({ text: text.textContent, box: text.getBoundingClientRect().toJSON() as DOMRect })),
        );
      const overlap = (a: DOMRect, b: DOMRect) =>
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const clashes = boxes.flatMap((a, i) =>
        boxes.slice(i + 1).flatMap((b) => (overlap(a.box, b.box) ? [`${a.text} over ${b.text}`] : [])),
      );
      expect(clashes).toEqual([]);
      await expect(chart.locator('text.axis', { hasText: 'rolled back' })).toHaveText(label);
    });
  }
});

test.describe('a sheet’s releases', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('tells each release, newest first, with what Verify found after it', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1306', sheet: true }));
    const sheet = page.getByRole('dialog');
    await expect(sheet.locator('.kicker')).toContainText('Reopened');
    await expect(sheet.locator('.facts-dl')).toContainText('logs, new error pattern on /basket from v0.9.12');
    const blocks = sheet.locator('.rels > .rel');
    await expect(blocks.first().locator('.out')).toHaveText('Promoted · all traffic');
    await expect(blocks.first().locator('.verify .v')).toHaveText('Cleared');
    await expect(blocks.first()).toContainText('No marks: the log watcher looks at no page');
    // The older release is folded to its head, and opens.
    await expect(blocks.nth(1).locator('.verify')).toBeHidden();
    await blocks.nth(1).getByText('Show this release').click();
    await expect(blocks.nth(1).locator('.verify .v')).toHaveText('Persists · back to Plan');
    await expect(blocks.nth(1)).toContainText('with #1304');
    // The page that release changed for #1304 says whose change it was.
    await expect(blocks.nth(1).locator('.regress figure').first()).toContainText('Contact0.0% · intended for #1304');
  });

  test('folds the passes it is not in, and windows the events', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1306', sheet: true }));
    const replay = page.getByRole('dialog').locator('.replay');
    await expect(replay.locator('.event')).toHaveCount(5);
    await replay.getByRole('button', { name: /^All events \(\d+\)$/ }).click();
    await expect(replay.locator('.event')).not.toHaveCount(5);
    await replay.getByRole('button', { name: 'Fewer events' }).click();
    await expect(replay.locator('.event')).toHaveCount(5);
    await replay.getByRole('button', { name: /^Pass 2: / }).click();
    await expect(replay.getByRole('button', { name: /persists$/ })).toBeVisible();
    await expect(replay.locator('.ch.pass span')).toHaveText(['PASS 3']);
  });

  test('says a wait for Martin’s deploy, and a return from Verify, in the design’s words', async ({ page }) => {
    // #1314's deploy pull request passed its checks, and waited for Martin, before he merged it.
    await page.goto(consoleUrl({ item: '1314', sheet: true, at: Date.parse('2026-10-06T09:30:00Z') }));
    await expect(page.getByRole('dialog').locator('.deploy-wait')).toContainText(
      'Merged · waiting for Martin’s deploy',
    );
    // A sample's deploy pull request never existed: its fact names it, and links nowhere.
    await expect(page.locator('.facts-dl').getByRole('link', { name: '#1330 on GitHub' })).toHaveCount(0);
    await expect(page.locator('.facts-dl')).toContainText('#1330');
    await page.goto(consoleUrl({ item: '1321', sheet: true }));
    await expect(page.getByRole('dialog').locator('.deploy-wait')).toContainText(
      'Merged · deploy #1331’s checks running',
    );
    await page.goto(consoleUrl({ at: RETURNED }));
    await shown(page);
    await expect(page.locator('.ret-pill')).toHaveText('#1306 · persists · back to Plan');
  });
});

for (const [width, viewport] of Object.entries({ laptop: WIDTHS.laptop, phone: WIDTHS.phone })) {
  for (const theme of THEMES) {
    test.describe(`a sheet’s releases, accessible, ${width}, ${theme}`, () => {
      test.use({ viewport });
      // #1304 and #1306 go round with a release they share: their scrubbers crowded on a phone (#210).
      for (const item of ['1304', '1306', '1310', '1321', '1276']) {
        test(`the sheet for #${item}`, async ({ page }) => {
          await page.goto(consoleUrl({ item, sheet: true, theme }));
          await page.getByRole('dialog').first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .include('.sheet')
            .analyze();
          expect(results.violations).toEqual([]);
        });
      }
    });
  }
}

for (const [width, viewport] of Object.entries({ laptop: WIDTHS.laptop, phone: WIDTHS.phone })) {
  for (const theme of THEMES) {
    test.describe(`the Canary panel, accessible, ${width}, ${theme}`, () => {
      test.use({ viewport });
      for (const [state, at] of Object.entries({ 'in-flight': undefined, ...CANARY })) {
        test(state, async ({ page }) => {
          await page.goto(consoleUrl({ at, theme }));
          await shown(page);
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .include('section.canary')
            .analyze();
          expect(results.violations).toEqual([]);
        });
      }
    });
  }
}

test.describe('a sheet’s events on a phone', () => {
  test.use({ viewport: WIDTHS.phone });

  test('fits each event’s time in its column, however long the item has been open', async ({ page }) => {
    // #1306 has been open for most of a day, so its latest times are the widest the samples hold.
    await page.goto(consoleUrl({ item: '1306', sheet: true }));
    const events = page.getByRole('dialog').locator('.replay .event');
    await events.first().waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /^All events \(\d+\)$/ })
      .click();
    const overlaps = await events.evaluateAll((rows) =>
      rows.flatMap((row) => {
        const [when, ...rest] = [...row.children].filter((child) => getComputedStyle(child).display !== 'none');
        const name = rest.at(-1);
        if (!when || !name) return [];
        const fits = when.scrollWidth <= when.clientWidth;
        const clear = when.getBoundingClientRect().right <= name.getBoundingClientRect().left;
        return fits && clear ? [] : [when.textContent];
      }),
    );
    expect(overlaps).toEqual([]);
  });
});

test.describe('the scoreboard', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('says it is off, then counts from nothing, then shows its three figures', async ({ page }) => {
    const intro = page.locator('section.intro');
    await page.goto(consoleUrl({ at: SCORE.off }));
    await scored(page);
    await expect(intro.locator('.score-off')).toHaveText(
      'Scoreboard off This copy of the factory has no answer key, so it counts nothing.',
    );
    await page.goto(consoleUrl({ at: SCORE.first }));
    await scored(page);
    const score = intro.getByRole('group', { name: 'Scoreboard: seeded and injected defects' });
    await expect(score.locator('div')).toHaveText(['0found', '0verified fixed', '—none yetmedian to verified']);
    await page.goto(consoleUrl());
    await scored(page);
    await expect(score.locator('div')).toHaveText([
      /^\d+found$/,
      /^\d+verified fixed$/,
      /^\d+(s|min|h|d)(\u00a0\d+(min|h))?median to verified$/,
    ]);
  });

  test('draws nothing before the scoreboard has said anything', async ({ page }) => {
    await page.goto(consoleUrl({ at: Date.parse('2026-09-29T07:00:00Z') }));
    await shown(page);
    await expect(page.locator('section.intro').locator('.score, .score-off')).toHaveCount(0);
  });
});

for (const [width, viewport] of Object.entries({ laptop: WIDTHS.laptop, phone: WIDTHS.phone })) {
  for (const theme of THEMES) {
    test.describe(`the scoreboard, accessible, ${width}, ${theme}`, () => {
      test.use({ viewport });
      for (const [state, at] of Object.entries(SCORE)) {
        test(state, async ({ page }) => {
          await page.goto(consoleUrl({ at, theme }));
          await scored(page);
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .include('section.intro')
            .analyze();
          expect(results.violations).toEqual([]);
        });
      }
    });
  }
}
