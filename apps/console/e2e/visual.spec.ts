/**
 * Visual regression, in the pinned Playwright image (`make e2e`; UPDATE=1 rewrites the snapshots) with motion off
 * and t fixed: every station in every state in both themes, Triage's, Plan's, Review's and Verify's tools paused
 * at a moment of their motion, and the line, one card per picture, the sheet and a wipe opened from it at full size at
 * all three widths. Milestone 4's states come from its test data: a card for each new picture and outcome, the line
 * with tickets waiting and with a spend cap, Triage's panel, a ticket's and a quarantined report's sheets, and an
 * empty store for real events. Milestone 5's come from the samples: a card for each wait and hold, Review's panel,
 * Plan's with a ticket in hand, and a fix's spec, rounds, review, gates and models, the sheet in Ink too. Milestone 6's
 * come from the samples too: the Canary panel in each state, a reopened card and one waiting for Martin's deploy, a
 * sheet's releases, the scrubber for work that goes round three times, and the timeline's versions, a release with no
 * work item's among them. Milestone 7's from a stand-in for the admin service: the sign-in and enrolment doors, a code
 * refused, Martin's account menu, a visitor's report quoted on his sheet, Preview as visitor, the settings for Martin
 * with a change unsaved and for a visitor, and the bottom row: Needs you (Waiting on Martin for a visitor, his words
 * being written for him, the passkey asked for on a guardrail's Approve, and nothing waiting) beside Controls, Flags and
 * Spend; and the audit log, whole and narrowed to a visitor's report; and the privacy page. Part B's flags from the
 * samples, with the admin service's check of the app stood in for: the Flags panel, each confirmation, a flag's card,
 * and the sheet, its card and slider for Martin; a held work item's sheet, its card at its head; and the "+" on Plan,
 * for Martin and a visitor, an improvement's spec in Needs you and its sheet's request.
 * Part C's canary paused for Martin, with auto-rollback off: the Canary panel, its card in Needs you, and the switch.
 * Task 22's Guardrails: the checklist with a guardrail that did not hold opened, for a visitor and for Martin, task
 * 23's refusals in a row, the attack in flight in its row, and Launch's dialog for each, at all three widths and in Ink; and an attack's card for
 * each way one stands (refused twice, a refusal cut at five lines, not refused, running), and a sheet's refusals whole.
 */
import type { Page } from '@playwright/test';
import { STAGES as KINDS } from '@software-factory/events';
import { AT_CHECKS, heldAs, RELEASED_OFF, TURNED_OFF } from './flags.ts';
import {
  ATTACKS_END,
  adminService,
  attacksAvailable,
  attacksUrl,
  CANARY,
  consoleUrl,
  END,
  emptyStore,
  expect,
  fixtureUrl,
  MERGE_WAITING,
  picturesDecodeAsDrawn,
  picturesShown,
  ready,
  SCORE,
  SESSION,
  scored,
  shown,
  THEMES,
  test,
  WIDTHS,
} from './support.ts';

/** A time in the samples when nothing waits on Martin: the first work item is open, and its hold has not started. */
const NOTHING_WAITS = Date.parse('2026-09-29T08:32:00Z');
/** A moment the samples have the line stopped, with Martin's reason: after his stop, before he starts it again. */
const STOPPED = Date.parse('2026-10-06T06:40:00Z');

test.beforeEach(({ page }) => picturesDecodeAsDrawn(page));

/**
 * The station kit's states (the design system's README), and a beacon on a working station; its module defines an
 * element, so Node cannot load it.
 */
const STATES = [
  ...(['idle', 'working', 'returning', 'passing', 'blocked', 'failed'] as const).map((status) => ({
    status,
    name: status,
  })),
  { status: 'working', beacon: 'needs-you', name: 'working-needs-you' },
  { status: 'working', beacon: 'failed', name: 'working-failed' },
] as const;

test.describe('stations', () => {
  for (const theme of THEMES) {
    for (const kind of KINDS) {
      // One page for all of a kind's states: each is drawn fresh, alone on the page's background, in place of the
      // last. Soft, so a state that differs doesn't stop the rest being compared, and the report names each one.
      test(`${kind}, ${theme}`, async ({ page }) => {
        // A picture that never settles is retried for expect's five seconds: time enough for all eight to be.
        test.slow();
        await page.goto(consoleUrl({ theme }));
        await ready(page);
        for (const { status, beacon, name } of STATES.map((s) => ({ beacon: undefined, ...s }))) {
          await page.evaluate(
            ([kind, status, beacon]) => {
              const station = document.createElement('sf-station');
              station.setAttribute('kind', kind);
              station.setAttribute('status', status);
              if (beacon) station.setAttribute('beacon', beacon);
              station.setAttribute('motion', 'off');
              const specimen = document.createElement('div');
              specimen.className = 'specimen';
              specimen.append(station);
              document.body.replaceChildren(specimen);
            },
            [kind, status, beacon] as const,
          );
          await expect
            .soft(page.locator('.specimen sf-station'), name)
            .toHaveScreenshot(`${kind}-${name}-${theme}.png`);
        }
      });
    }
  }

  // The tools' motion, which the still poses above never draw: each animation stopped at a moment that shows the tool at
  // work (the big parcel tossed out, the compass partway round its circle, the lens leaning in over its first tick, the
  // pen partway through the signature), the same moment every run, as the still poses' tests set t. Review's and Verify's
  // loops start once the paper has come up, 900ms in, so their moments count from the start of the feed.
  const MOMENTS = { triage: 2000, plan: 1200, review: 2050, verify: 2250 } as const;
  test('tools in motion, paper', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(consoleUrl({ theme: 'paper' }));
    await ready(page);
    for (const [kind, at] of Object.entries(MOMENTS)) {
      const running = await page.evaluate(
        ([kind, at]) => {
          const station = document.createElement('sf-station');
          station.setAttribute('kind', kind);
          station.setAttribute('status', 'working');
          const specimen = document.createElement('div');
          specimen.className = 'specimen';
          specimen.append(station);
          document.body.replaceChildren(specimen);
          const animations = station.shadowRoot?.getAnimations() ?? [];
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = at;
          }
          return animations.length;
        },
        [kind, at] as const,
      );
      expect.soft(running, `${kind} moves`).toBeGreaterThan(0);
      await expect.soft(page.locator('.specimen sf-station'), kind).toHaveScreenshot(`${kind}-motion-paper.png`, {
        // Paused where they are: 'disabled', the default, would cancel them and draw the rest pose.
        animations: 'allow',
      });
    }
  });
});

/** One card for each kind of picture the design system draws. */
const PICTURES = {
  wipe: '1296',
  metric: '1288',
  logs: '1265',
  package: '1262',
  scan: '1282',
  rollback: '1276',
  judgement: '1268',
  spec: '1300',
};

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(width, () => {
    test.use({ viewport });

    test('the line', async ({ page }) => {
      await page.goto(consoleUrl());
      await ready(page);
      await expect(page.getByRole('region', { name: 'The line' })).toHaveScreenshot(`line-${width}.png`);
    });

    for (const [picture, item] of Object.entries(PICTURES)) {
      test(`a card with a ${picture} picture`, async ({ page }) => {
        await page.goto(consoleUrl({ item }));
        await ready(page);
        const card = page.locator('.card[data-place="centre"]');
        await card.scrollIntoViewIfNeeded();
        await picturesShown(card);
        await expect(card).toHaveScreenshot(`card-${picture}-${width}.png`);
      });
    }

    test('a card with a refusal picture, an attack’s', async ({ page }) => {
      await page.goto(attacksUrl({ item: '1293' }));
      await ready(page);
      const card = page.locator('.card[data-place="centre"]');
      await card.scrollIntoViewIfNeeded();
      await expect(card).toHaveScreenshot(`card-refusal-${width}.png`);
    });

    test('the sheet', async ({ page }) => {
      await page.goto(consoleUrl({ item: '1296', sheet: true }));
      await page.getByRole('dialog', { name: 'Prices go negative' }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveScreenshot(`sheet-${width}.png`);
    });

    test('a screenshot at full size', async ({ page }) => {
      await page.goto(consoleUrl({ item: '1296', sheet: true }));
      await page.getByRole('button', { name: 'Open at full size: The home page, broken and fixed' }).click();
      const view = page.getByRole('dialog', { name: 'The home page, broken and fixed' });
      await picturesShown(view);
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`full-size-${width}.png`);
    });
  });
}

/** Milestone 4's states, from the test data: one card for each new picture and outcome. */
const SENSING = {
  'waiting-screenshot': '1001',
  'every-page': '1002',
  'http-redirects': '1003',
  'http-headers': '1004',
  'browser-console': '1005',
  accessibility: '1006',
  quarantined: '1007',
  parked: '1008',
  discarded: '1009',
  'report-ticket': '1010',
};

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, sensing and triage`, () => {
    test.use({ viewport });

    for (const [state, item] of Object.entries(SENSING)) {
      test(`a card: ${state}`, async ({ page }) => {
        await page.goto(fixtureUrl({ item }));
        await ready(page);
        const card = page.locator('.card[data-place="centre"]');
        await card.scrollIntoViewIfNeeded();
        await picturesShown(card);
        await expect(card).toHaveScreenshot(`m04-card-${state}-${width}.png`);
      });
    }

    for (const at of ['afternoon', 'capped'] as const) {
      test(`the line, ${at}`, async ({ page }) => {
        await page.goto(fixtureUrl({ at }));
        await ready(page);
        // The header and any notice with the line: a spend cap is said in all three.
        await expect(page).toHaveScreenshot(`m04-line-${at}-${width}.png`, {
          clip: { x: 0, y: 0, width: viewport.width, height: width === 'phone' ? 760 : 700 },
        });
      });
    }

    test('Triage’s panel, after the cap cleared', async ({ page }) => {
      await page.goto(fixtureUrl({ at: 'cleared' }));
      await ready(page);
      await page.getByRole('button', { name: /^Triage:/ }).click();
      const panel = page.getByRole('dialog', { name: 'Triage' });
      await expect(panel).toHaveScreenshot(`m04-triage-panel-${width}.png`);
    });

    for (const [name, item] of [
      ['ticket', '1000'],
      ['quarantined', '1007'],
    ] as const) {
      test(`a sheet: ${name}`, async ({ page }) => {
        await page.goto(fixtureUrl({ item, sheet: true }));
        await page.getByRole('dialog').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForLoadState('networkidle');
        await expect(page).toHaveScreenshot(`m04-sheet-${name}-${width}.png`);
      });
    }

    test('an empty store for real events', async ({ page }) => {
      await emptyStore(page, 'real');
      await page.goto(consoleUrl());
      await page.getByText('Watching, nothing yet').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`m04-empty-real-${width}.png`, { fullPage: true });
    });
  });
}

test.describe('the line in Ink, sensing and triage', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('a spend cap reached', async ({ page }) => {
    await page.goto(fixtureUrl({ at: 'capped', theme: 'ink' }));
    await ready(page);
    await expect(page).toHaveScreenshot('m04-line-capped-ink.png', {
      clip: { x: 0, y: 0, width: WIDTHS.desktop.width, height: 700 },
    });
  });

  test('a ticket’s sheet', async ({ page }) => {
    await page.goto(fixtureUrl({ item: '1000', sheet: true, theme: 'ink' }));
    await page.getByRole('dialog').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('m04-sheet-ticket-ink.png');
  });
});

/**
 * Milestone 5's states, from the samples: a card for each wait and hold, and a merge waiting for a release, which is a
 * dry run's now that every other merge waits for Martin's deploy.
 */
const FIXING: Record<string, { item: string; at?: number }> = {
  'merge-wait': { item: '1311' },
  'held-scope': { item: '1315' },
  'held-tests-first': { item: '1317' },
  'held-spend': { item: '1319' },
  'held-still-blocking': { item: '1323' },
  merged: { item: '1310', at: MERGE_WAITING },
};

/** A fix's sheet, a part at a time: the parts below the fold are the new ones. */
async function sheetParts(page: Page, item: string, theme: 'paper' | 'ink' = 'paper', at?: number) {
  await page.goto(consoleUrl({ item, sheet: true, theme, at }));
  await page.getByRole('dialog').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  const section = (title: string) =>
    page.locator('.sheet .sec').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const side = (title: string) =>
    page.locator('.sheet .side-card').filter({ has: page.getByRole('heading', { name: title }) });
  return { section, side };
}

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, fixing`, () => {
    test.use({ viewport });

    for (const [state, { item, at }] of Object.entries(FIXING)) {
      test(`a card: ${state}`, async ({ page }) => {
        await page.goto(consoleUrl({ item, at }));
        await ready(page);
        const card = page.locator('.card[data-place="centre"]');
        await card.scrollIntoViewIfNeeded();
        await picturesShown(card);
        await expect(card).toHaveScreenshot(`m05-card-${state}-${width}.png`);
      });
    }

    test('Review’s panel, with a merge waiting and a round sent back', async ({ page }) => {
      await page.goto(consoleUrl());
      await ready(page);
      await page.getByRole('button', { name: /^Review:/ }).click();
      await expect(page.getByRole('dialog', { name: 'Review' })).toHaveScreenshot(`m05-review-panel-${width}.png`);
    });

    test('Plan’s panel, with a ticket in hand, one held and newer ones waiting', async ({ page }) => {
      // In the samples, the planner has taken #1314 and #1315 has just opened behind it.
      await page.goto(consoleUrl({ at: Date.parse('2026-10-06T08:12:30Z') }));
      await ready(page);
      await page.getByRole('button', { name: /^Plan:/ }).click();
      // The screenshot scrolls the panel into view, which would move a row under the pointer left on the station and
      // show it hovered: scroll first, then rest the pointer on the panel's heading.
      const dialog = page.getByRole('dialog', { name: 'Plan' });
      await dialog.scrollIntoViewIfNeeded();
      await dialog.getByRole('heading', { name: 'Plan' }).hover();
      await expect(dialog).toHaveScreenshot(`m05-plan-panel-${width}.png`);
    });

    test('a fix’s sheet: the spec, its rounds and its review', async ({ page }) => {
      const { section } = await sheetParts(page, '1311');
      for (const [title, name] of [
        ['The spec', 'spec'],
        ['Rounds', 'rounds'],
        ['Review', 'review'],
      ] as const) {
        await expect(section(title)).toHaveScreenshot(`m05-sheet-${name}-${width}.png`);
      }
    });

    test('a fix’s sheet: its gates by attempt, and its agents and models', async ({ page }) => {
      const { side } = await sheetParts(page, '1311');
      await expect(side('Gates')).toHaveScreenshot(`m05-sheet-gates-${width}.png`);
      await expect(side('Agents and models')).toHaveScreenshot(`m05-sheet-models-${width}.png`);
      const local = await sheetParts(page, '1304');
      await expect(local.side('Agents and models')).toHaveScreenshot(`m05-sheet-models-local-${width}.png`);
    });

    test('a fix’s sheet: an approval’s suggestion sent back, and declined', async ({ page }) => {
      const { section } = await sheetParts(page, '1304');
      await expect(section('Rounds')).toHaveScreenshot(`m05-sheet-rounds-declined-${width}.png`);
    });

    test('a fix’s sheet: the round a return sent it into, before the coder pushed it, and gates running', async ({
      page,
    }) => {
      // #1325: the gates sent round 1 back at 14:15:55, the coder pushed round 2 at 14:19:00, and its gates ran on.
      const between = await sheetParts(page, '1325', 'paper', Date.parse('2026-10-06T14:17:00Z'));
      await expect(between.section('Rounds')).toHaveScreenshot(`m05-sheet-rounds-next-${width}.png`);
      const running = await sheetParts(page, '1325', 'paper', Date.parse('2026-10-06T14:20:00Z'));
      await expect(running.section('Rounds')).toHaveScreenshot(`m05-sheet-rounds-running-${width}.png`);
    });
  });
}

test.describe('a fix’s sheet in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the spec, its rounds, its review and its gates', async ({ page }) => {
    const { section, side } = await sheetParts(page, '1311', 'ink');
    await expect(section('The spec')).toHaveScreenshot('m05-sheet-spec-ink.png');
    await expect(section('Rounds')).toHaveScreenshot('m05-sheet-rounds-ink.png');
    await expect(section('Review')).toHaveScreenshot('m05-sheet-review-ink.png');
    await expect(side('Gates')).toHaveScreenshot('m05-sheet-gates-ink.png');
  });
});

/** Milestone 6's Canary panel, from the samples: in flight, and each way a release ends, at every width. */
const PANEL = { 'in-flight': undefined, ...CANARY };

/** Milestone 6's cards: a ticket open again, and a merge waiting for Martin's deploy. */
const SHIPPED_CARDS = { reopened: '1306', 'deploy-wait': '1321' };

/** A sheet's releases: twice round and verified, a rollback, a dry run, and the wait for Martin's deploy. */
const SHIPPED = { 'twice-round': '1306', 'rolled-back': '1276', 'dry-run': '1310', 'deploy-wait': '1321' };

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, shipping`, () => {
    test.use({ viewport });

    for (const [state, at] of Object.entries(PANEL)) {
      test(`the Canary panel: ${state}`, async ({ page }) => {
        await page.goto(consoleUrl({ at }));
        await shown(page);
        await expect(page.locator('section.canary')).toHaveScreenshot(`m06-canary-${state}-${width}.png`);
      });
    }

    // Out of its cage while a release is in flight: sitting still on the panel's top edge, as motion off has it, and
    // a dashed paper bird for a dry run.
    for (const state of ['in-flight', 'dry-run'] as const) {
      test(`the canary bird on the panel: ${state}`, async ({ page }) => {
        await page.goto(consoleUrl({ at: PANEL[state] }));
        await shown(page);
        await page.locator('.bird-fly').waitFor();
        const card = await page.locator('section.canary').boundingBox();
        if (!card) throw new Error('No Canary panel');
        await page.evaluate((y) => scrollBy(0, y - 120), card.y);
        const top = await page.locator('section.canary').boundingBox();
        if (!top) throw new Error('No Canary panel');
        const clip = { x: top.x, y: top.y - 60, width: top.width, height: 100 };
        await expect(page).toHaveScreenshot(`m06-bird-${state}-${width}.png`, { clip });
        await expect(page.locator('.stations sf-station[kind="release"]')).toHaveScreenshot(
          `m06-bird-cage-${state}-${width}.png`,
        );
      });
    }

    for (const [state, item] of Object.entries(SHIPPED_CARDS)) {
      test(`a card: ${state}`, async ({ page }) => {
        await page.goto(consoleUrl({ item }));
        await ready(page);
        const card = page.locator('.card[data-place="centre"]');
        await picturesShown(card);
        await expect(card).toHaveScreenshot(`m06-card-${state}-${width}.png`);
      });
    }

    for (const [state, item] of Object.entries(SHIPPED)) {
      test(`a sheet’s Release and Verify: ${state}`, async ({ page }) => {
        // Tall enough that the section is in the sheet whole, at every width.
        await page.setViewportSize({ ...viewport, height: 2400 });
        const { section } = await sheetParts(page, item);
        const part = section('Release and Verify');
        await picturesShown(part);
        await expect(part).toHaveScreenshot(`m06-sheet-release-${state}-${width}.png`);
      });
    }

    test('the timeline, with the versions of releases that carry no work item', async ({ page }) => {
      await page.goto(consoleUrl({ item: '1306' }));
      await ready(page);
      await expect(page.locator('.rail')).toHaveScreenshot(`m06-timeline-${width}.png`);
    });

    test('a sheet’s scrubber, for work that goes round three times', async ({ page }) => {
      const { section } = await sheetParts(page, '1306');
      await expect(section('How it went')).toHaveScreenshot(`m06-sheet-scrubber-${width}.png`);
      await page.getByRole('button', { name: /^Pass 2/ }).click();
      await expect(section('How it went')).toHaveScreenshot(`m06-sheet-scrubber-pass-2-${width}.png`);
    });
  });
}

test.describe('the Canary panel in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  for (const state of ['in-flight', 'rolled-back-no-step', 'dry-run'] as const) {
    test(state, async ({ page }) => {
      await page.goto(consoleUrl({ at: PANEL[state], theme: 'ink' }));
      await shown(page);
      await expect(page.locator('section.canary')).toHaveScreenshot(`m06-canary-${state}-ink.png`);
    });
  }

  test('a sheet’s Release and Verify', async ({ page }) => {
    await page.setViewportSize({ ...WIDTHS.desktop, height: 2400 });
    const { section } = await sheetParts(page, '1306', 'ink');
    const part = section('Release and Verify');
    await picturesShown(part);
    await expect(part).toHaveScreenshot('m06-sheet-release-ink.png');
  });
});

/** Milestone 6's scoreboard beside the app's name, from the samples: off, before the first fix, and with figures. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the scoreboard`, () => {
    test.use({ viewport });

    for (const theme of THEMES) {
      for (const [state, at] of Object.entries(SCORE)) {
        test(`${state}, ${theme}`, async ({ page }) => {
          await page.goto(consoleUrl({ at, theme }));
          await scored(page);
          await expect(page.locator('section.intro')).toHaveScreenshot(`m06-score-${state}-${width}-${theme}.png`);
        });
      }
    }
  });
}

/** A door drawn, with the fonts it is set in. */
async function door(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator('.door').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** Milestone 7: the doors, and Martin's account menu, against a stand-in for the admin service. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, signing in`, () => {
    test.use({ viewport });

    test('the sign-in door', async ({ page }) => {
      await adminService(page, 'visitor');
      await door(page, '/?view=sign-in');
      await expect(page).toHaveScreenshot(`m07-sign-in-${width}.png`);
    });

    test('the enrolment door, and a wrong code', async ({ page }) => {
      await adminService(page, 'visitor');
      await page.route('**/admin/enrol/options', (route) =>
        route.fulfill({ status: 403, json: { refused: 'code', message: 'That code isn’t right.', left: 3 } }),
      );
      await door(page, '/?view=enrol');
      await expect(page).toHaveScreenshot(`m07-enrol-${width}.png`);
      await page.getByLabel('One-time code').fill('AAAAAA-AAAAA-AAAAA-AAAAA-AAAAB');
      await page.getByRole('button', { name: 'Check the code' }).click();
      await page.getByRole('alert').waitFor();
      await expect(page).toHaveScreenshot(`m07-enrol-wrong-${width}.png`);
    });

    test('Martin’s account menu', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      await page.getByRole('button', { name: 'Martin', exact: true }).click();
      await page.locator('#account-menu').waitFor();
      await expect(page).toHaveScreenshot(`m07-account-menu-${width}.png`, {
        clip: { x: 0, y: 0, width: viewport.width, height: 600 },
      });
    });

    test('the header’s pill while the passkey is fresh, which ends it when pressed', async ({ page }) => {
      test.skip(width === 'phone', 'on a phone the header has no room for the pill: it is a line in the account menu');
      await adminService(page, 'martin');
      await page.route('**/admin/session', (route) =>
        route.fulfill({ json: { ...SESSION, steppedUp: true, steppedUpAt: new Date().toISOString() } }),
      );
      await page.goto(consoleUrl());
      await ready(page);
      const pill = page.locator('.top-right .fresh');
      await pill.hover();
      await expect(page.locator('header.top')).toHaveScreenshot(`m07-step-up-pill-${width}.png`);
    });

    test('a visitor’s report, quoted on Martin’s sheet', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl({ item: '1268', sheet: true }));
      await page.locator('.report-said').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveScreenshot(`m07-sheet-report-${width}.png`);
    });

    test('Preview as visitor', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      await page.getByRole('button', { name: 'Martin', exact: true }).click();
      await page.getByRole('button', { name: 'Preview as visitor' }).click();
      await ready(page);
      await page.getByRole('button', { name: 'Back to admin' }).blur();
      await expect(page).toHaveScreenshot(`m07-preview-${width}.png`, {
        clip: { x: 0, y: 0, width: viewport.width, height: 360 },
      });
    });
  });
}

test.describe('the doors in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the sign-in door, after the session ended', async ({ page }) => {
    await adminService(page, 'visitor');
    await door(page, '/?view=sign-in&theme=ink&ended=expired&at=2026-10-06T15%3A40%3A00Z');
    await expect(page).toHaveScreenshot('m07-sign-in-ended-ink.png');
  });
});

/** Milestone 7: the settings, for Martin with a change unsaved and for a visitor, and the bottom row. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the settings`, () => {
    test.use({ viewport });

    test('the settings, with a change unsaved', async ({ page }) => {
      await adminService(page, 'martin');
      await settingsPage(page);
      await page.getByLabel('The coder’s effort').selectOption('high');
      await expect(page).toHaveScreenshot(`m07-settings-${width}.png`, { fullPage: true });
    });

    test('the settings, for a visitor', async ({ page }) => {
      await adminService(page, 'visitor');
      await settingsPage(page);
      await expect(page).toHaveScreenshot(`m07-settings-visitor-${width}.png`, { fullPage: true });
    });

    test('the bottom row, for a visitor', async ({ page }) => {
      await adminService(page, 'visitor');
      await page.goto(consoleUrl());
      await ready(page);
      await expect(page.locator('.bottom')).toHaveScreenshot(`m07-bottom-visitor-${width}.png`);
    });

    test('the bottom row, for Martin, answering in words', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      await page.locator('article.needs h2', { hasText: 'Needs you' }).waitFor();
      const card = page.locator('.need').filter({ hasText: '#1300 ·' });
      await card.getByRole('button', { name: 'Answer in words' }).click();
      await card.getByLabel('Your answer to #1300').fill('Out of stock last, whatever the price.');
      await card.getByLabel('Your answer to #1300').blur();
      await expect(page.locator('.bottom')).toHaveScreenshot(`m07-bottom-martin-${width}.png`);
    });

    test('a held fix’s sheet, for Martin: its card from Needs you at its head', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl({ item: '1319', sheet: true }));
      const needs = page.locator('.sheet .sheet-needs');
      await needs.getByRole('button', { name: /^Approve/ }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expect(needs).toHaveScreenshot(`m07-sheet-needs-hold-${width}.png`);
    });

    test('Approve on a guardrail’s hold, asking for the passkey again', async ({ page }) => {
      await adminService(page, 'martin');
      await page.route('**/admin/holds/**', (route) =>
        route.fulfill({ status: 403, json: { refused: 'step-up', message: 'This needs your passkey again.' } }),
      );
      await page.goto(consoleUrl());
      await ready(page);
      const card = page.locator('.need').filter({ hasText: '#1319 ·' });
      await card.getByRole('button', { name: 'Approve (asks for your passkey)' }).click();
      await page.getByRole('dialog', { name: 'Approve #1319' }).waitFor();
      await expect(page).toHaveScreenshot(`m07-needs-step-up-${width}.png`);
    });

    test('Needs you, with nothing waiting', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl({ at: NOTHING_WAITS }));
      await ready(page);
      await page.locator('article.needs h2', { hasText: 'Needs you' }).waitFor();
      await expect(page.locator('article.needs')).toHaveScreenshot(`m07-needs-empty-${width}.png`);
    });
  });
}

/**
 * Part C: a canary paused for Martin. He switched auto-rollback off, and the analysis judged the samples' release in
 * flight bad at its 50% step: the line records the step, inconclusive, and holds #1314, which it carries.
 */
const PAUSED_AT = new Date(END - 10_000).toISOString();
const PAUSED = [
  {
    id: '00000000-0000-4000-8000-000000000911',
    seq: 911,
    ts: new Date(END - 30 * 60_000).toISOString(),
    work_item: null,
    type: 'controls.changed',
    version: 2,
    actor: 'martin',
    summary: 'Martin turned auto-rollback off',
    payload: {
      autonomy: 'guarded',
      newWork: true,
      autoMerge: false,
      take: { kind: 'next-few', count: 5, since: '2026-10-06T12:00:00.000Z' },
      autoRollback: false,
      change: { control: 'auto-rollback', before: true, after: false },
    },
    artifacts: [],
  },
  {
    id: '00000000-0000-4000-8000-000000000912',
    seq: 912,
    ts: PAUSED_AT,
    work_item: '1314',
    type: 'canary.stepped',
    version: 2,
    actor: 'rollouts',
    summary: 'Canary at 50%: the analysis was inconclusive',
    payload: {
      release: 'v8q7chmx72-913',
      version: 'v0.9.13',
      weight: 50,
      analysis: {
        phase: 'inconclusive',
        requests: 846,
        measures: [
          { name: 'enough-requests', phase: 'successful', value: 846, limit: 100 },
          {
            name: 'errors',
            phase: 'inconclusive',
            value: 0.0253,
            limit: 0.01,
            message: 'Metric "errors" assessed Inconclusive due to inconclusive (1) > inconclusiveLimit (0)',
          },
          { name: 'latency', phase: 'successful', value: -0.088, limit: 0 },
          { name: 'journeys', phase: 'successful', value: null, limit: null },
        ],
      },
      figures: {
        canary: { requests: 846, errorRate: 0.0392, p99Ms: 42, journeys: [24, 24] },
        baseline: { requests: 902, errorRate: 0.0139, p99Ms: 39, journeys: [24, 24] },
      },
      dryRun: false,
    },
    artifacts: [],
  },
  {
    id: '00000000-0000-4000-8000-000000000913',
    seq: 913,
    ts: PAUSED_AT,
    work_item: '1314',
    type: 'hold.started',
    version: 10,
    actor: 'rollouts',
    summary: 'Canary paused for Martin at 50%: the analysis judged it bad',
    payload: {
      stage: 'release',
      kind: 'held',
      cause: 'canary',
      reason:
        'With auto-rollback off, the analysis judged the canary of v0.9.13 bad at 50% (errors 0.0253 against at most 0.01). It keeps its share of the traffic until Martin promotes it fully or aborts it, which rolls it back',
      release: 'v8q7chmx72-913',
    },
    artifacts: [],
  },
];

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, a canary paused for Martin`, () => {
    test.use({ viewport });

    test('the Canary panel, its card in Needs you, and the switch off in Controls', async ({ page }) => {
      await adminService(page, 'martin', PAUSED);
      await page.goto(consoleUrl());
      await ready(page);
      const card = page.locator('.need').filter({ hasText: 'A canary paused for you' });
      await card.getByRole('button', { name: /^Promote fully/ }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('section.canary')).toHaveScreenshot(`m07-canary-paused-${width}.png`);
      await expect(card).toHaveScreenshot(`m07-canary-paused-card-${width}.png`);
      await expect(page.locator('article.controls .ctl-group').filter({ hasText: 'Switches' })).toHaveScreenshot(
        `m07-switches-rollback-off-${width}.png`,
      );
    });
  });
}

test.describe('the settings in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the settings, with a change unsaved', async ({ page }) => {
    await adminService(page, 'martin');
    await settingsPage(page, 'ink');
    await page.getByLabel('The coder’s effort').selectOption('high');
    await expect(page).toHaveScreenshot('m07-settings-ink.png', { fullPage: true });
  });

  test('the bottom row, for a visitor', async ({ page }) => {
    await adminService(page, 'visitor');
    await page.goto(consoleUrl({ theme: 'ink' }));
    await ready(page);
    await expect(page.locator('.bottom')).toHaveScreenshot('m07-bottom-visitor-ink.png');
  });

  test('the bottom row, for Martin', async ({ page }) => {
    await adminService(page, 'martin');
    await page.goto(consoleUrl({ theme: 'ink' }));
    await ready(page);
    await page.locator('article.needs h2', { hasText: 'Needs you' }).waitFor();
    await expect(page.locator('.bottom')).toHaveScreenshot('m07-bottom-martin-ink.png');
  });
});

/**
 * Milestone 7, Part B: the flags. The Flags panel for Martin and a visitor, each of the slider's confirmations, a
 * flag's card in Needs you, the app's copy lagging, and an improvement's sheet, its flag part way out and out to
 * everyone, at all three widths; the app taking a change, not checked, and a flag turned off and closed, on a laptop.
 */
const flagsGroup = (page: Page) => page.getByRole('article', { name: 'Flags' }).locator('.ctl-group.flags');

/** The console with the flags drawn, and the admin service's check of the app answering as asked. */
async function withFlags(
  page: Page,
  as: 'martin' | 'visitor',
  {
    at,
    theme = 'paper',
    held = 'held',
    extra = [],
  }: { at?: number; theme?: 'paper' | 'ink'; held?: Parameters<typeof heldAs>[1]; extra?: typeof TURNED_OFF } = {},
) {
  await heldAs(page, held);
  await adminService(page, as, extra);
  await page.goto(consoleUrl({ theme, ...(at !== undefined && { at }) }));
  await ready(page);
  await flagsGroup(page).locator('.sync').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** Opens a stop's confirmation, and waits for it. */
async function confirmation(page: Page, stop: string) {
  await page.getByRole('button', { name: stop }).click();
  await page.getByRole('dialog').waitFor();
}

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the flags`, () => {
    test.use({ viewport });

    test('the Flags panel, for Martin and for a visitor', async ({ page }) => {
      await withFlags(page, 'martin');
      await expect(flagsGroup(page)).toHaveScreenshot(`m07-flags-${width}.png`);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await withFlags(page, 'visitor');
      await expect(flagsGroup(page)).toHaveScreenshot(`m07-flags-visitor-${width}.png`);
    });

    test('the Flags panel, the app still holding the revision before', async ({ page }) => {
      await withFlags(page, 'martin', { held: 'lagging' });
      await expect(flagsGroup(page)).toHaveScreenshot(`m07-flags-lagging-${width}.png`);
    });

    test('a flag’s card in Needs you, Share dashed while a canary is in flight', async ({ page }) => {
      await withFlags(page, 'martin');
      await expect(page.locator('.flag-need')).toHaveScreenshot(`m07-flag-card-${width}.png`);
    });

    test('widening to Share, with the passkey, Preview skipped', async ({ page }) => {
      await withFlags(page, 'martin', { at: AT_CHECKS });
      await confirmation(page, 'Widen to Share 50%, last-one');
      await expect(page).toHaveScreenshot(`m07-flag-widen-${width}.png`);
    });

    test('widening to Checks, with no passkey', async ({ page }) => {
      await withFlags(page, 'martin', { at: RELEASED_OFF });
      await confirmation(page, 'Widen to Checks, delivery-dates');
      await expect(page).toHaveScreenshot(`m07-flag-checks-${width}.png`);
    });

    test('narrowing', async ({ page }) => {
      await withFlags(page, 'martin');
      await confirmation(page, 'Narrow to Checks, delivery-dates');
      await expect(page).toHaveScreenshot(`m07-flag-narrow-${width}.png`);
    });

    test('turning off, with a reason', async ({ page }) => {
      await withFlags(page, 'martin');
      await confirmation(page, 'Turn off, delivery-dates');
      const reason = page.getByRole('dialog').getByLabel('Reason');
      await reason.fill('The date is wrong on Sundays');
      await reason.blur();
      await expect(page).toHaveScreenshot(`m07-flag-off-${width}.png`);
    });

    test('turning back on for everyone', async ({ page }) => {
      await withFlags(page, 'martin', { extra: TURNED_OFF });
      await confirmation(page, 'Turn back on for everyone, last-one');
      await expect(page).toHaveScreenshot(`m07-flag-back-on-${width}.png`);
    });

    test('a stop that can’t be taken now', async ({ page }) => {
      await withFlags(page, 'martin');
      await confirmation(page, 'Widen to Share 50%: can’t be taken now, delivery-dates');
      await expect(page).toHaveScreenshot(`m07-flag-cant-${width}.png`);
    });

    for (const item of ['1294', '1271']) {
      test(`#${item}’s sheet, its flag`, async ({ page }) => {
        await page.goto(consoleUrl({ item, sheet: true }));
        const section = page.locator('.sheet section.sec', { has: page.getByRole('heading', { name: 'The flag' }) });
        await section.waitFor();
        await page.evaluate(() => document.fonts.ready);
        await expect(section).toHaveScreenshot(`m07-sheet-flag-${item}-${width}.png`);
      });
    }

    test('#1294’s sheet, for Martin: its flag’s card at its head, and its slider to set', async ({ page }) => {
      await withFlags(page, 'martin');
      await page.goto(consoleUrl({ item: '1294', sheet: true }));
      const needs = page.locator('.sheet .sheet-needs');
      const section = page.locator('.sheet section.sec', { has: page.getByRole('heading', { name: 'The flag' }) });
      await section.locator('.fthumb').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expect(needs).toHaveScreenshot(`m07-sheet-needs-flag-${width}.png`);
      await expect(section).toHaveScreenshot(`m07-sheet-flag-martin-${width}.png`);
    });

    test('#1271’s sheet, its flag at Checks: the pages off and on, in light and dark', async ({ page }) => {
      // Tall enough that the block is in the sheet whole, both schemes' rows, at every width.
      await page.setViewportSize({ ...viewport, height: 2400 });
      await page.goto(consoleUrl({ item: '1271', sheet: true }));
      const checks = page.locator('.sheet details.rel', { hasText: /^Checks/ });
      await checks.locator('summary').click();
      await checks.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      // The front page, off and on, in light and then in dark.
      await expect(checks.locator('img')).toHaveCount(4);
      for (const img of await checks.locator('img').all()) await expect(img).toHaveJSProperty('complete', true);
      await expect(checks).toHaveScreenshot(`m07-sheet-flag-checks-${width}.png`);
    });
  });
}

test.describe('the flags on a laptop', () => {
  test.use({ viewport: WIDTHS.laptop });

  for (const held of ['taking', 'unchecked'] as const) {
    test(`the Flags panel, the app’s copy ${held}`, async ({ page }) => {
      await withFlags(page, 'visitor', { held });
      await expect(flagsGroup(page).locator('.sync')).toHaveScreenshot(`m07-flags-${held}.png`);
    });
  }

  test('a flag turned off and closed, folded at the foot', async ({ page }) => {
    await withFlags(page, 'martin', { extra: TURNED_OFF });
    await flagsGroup(page).locator('summary').click();
    await expect(flagsGroup(page)).toHaveScreenshot('m07-flags-closed.png');
  });

  test('a card’s line of facts, with its flag', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1294' }));
    await ready(page);
    await expect(page.locator('.card[data-place="centre"]')).toHaveScreenshot('m07-card-flag.png');
  });
});

test.describe('the flags in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the Flags panel, the app still holding the revision before', async ({ page }) => {
    await withFlags(page, 'martin', { theme: 'ink', held: 'lagging' });
    await expect(flagsGroup(page)).toHaveScreenshot('m07-flags-ink.png');
  });

  test('a flag’s card in Needs you', async ({ page }) => {
    await withFlags(page, 'martin', { theme: 'ink' });
    await expect(page.locator('.flag-need')).toHaveScreenshot('m07-flag-card-ink.png');
  });

  test('widening to Share, with the passkey', async ({ page }) => {
    await withFlags(page, 'martin', { theme: 'ink', at: AT_CHECKS });
    await confirmation(page, 'Widen to Share 50%, last-one');
    await expect(page).toHaveScreenshot('m07-flag-widen-ink.png');
  });

  test('#1271’s sheet, its flag', async ({ page }) => {
    await page.goto(consoleUrl({ theme: 'ink', item: '1271', sheet: true }));
    const section = page.locator('.sheet section.sec', { has: page.getByRole('heading', { name: 'The flag' }) });
    await section.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expect(section).toHaveScreenshot('m07-sheet-flag-1271-ink.png');
  });
});

/**
 * Milestone 7, Part B: the "+" on Plan. Martin's form with his words being written, a visitor's read-only form, an
 * improvement's spec in Needs you with the key on its Approve, and its sheet's request and spec, at all three widths;
 * Plan's panel ending with the "+" on a laptop, and Martin's form in Ink.
 */
async function improve(page: Page, as: 'martin' | 'visitor', theme: 'paper' | 'ink' = 'paper') {
  await adminService(page, as);
  await page.goto(consoleUrl({ theme }));
  await ready(page);
  await page
    .getByRole('button', { name: as === 'martin' ? 'Request an improvement' : 'How Martin asks for an improvement' })
    .click();
  await page.getByRole('dialog').waitFor();
  if (as === 'martin') {
    const words = page.getByLabel('What you want');
    await words.fill(
      'Say on the basket page how many items are in it. Count each product once, however many of it are in the basket.',
    );
    await words.blur();
  }
  await page.evaluate(() => document.fonts.ready);
}

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the "+"`, () => {
    test.use({ viewport });

    test('Martin asks for an improvement', async ({ page }) => {
      await improve(page, 'martin');
      await expect(page).toHaveScreenshot(`m07-improve-${width}.png`);
    });

    test('a visitor reads how Martin asks', async ({ page }) => {
      await improve(page, 'visitor');
      await expect(page).toHaveScreenshot(`m07-improve-visitor-${width}.png`);
    });

    test('an improvement’s spec in Needs you, Approve with the key', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      const card = page.locator('article.needs .need').filter({ hasText: '#1334 ·' });
      await expect(card).toHaveScreenshot(`m07-improvement-spec-card-${width}.png`);
    });

    test('#1334’s sheet: the request, and the spec', async ({ page }) => {
      await page.goto(consoleUrl({ item: '1334', sheet: true }));
      const request = page.locator('.sheet figure.martins-request');
      await request.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expect(request).toHaveScreenshot(`m07-sheet-request-${width}.png`);
      const spec = page.locator('.sheet section.sec', { has: page.getByRole('heading', { name: 'The spec' }) });
      await expect(spec).toHaveScreenshot(`m07-sheet-improvement-spec-${width}.png`);
    });
  });
}

test.describe('the "+" on a laptop', () => {
  test.use({ viewport: WIDTHS.laptop });

  test('Plan’s panel ends with the "+"', async ({ page }) => {
    await adminService(page, 'martin');
    await page.goto(consoleUrl());
    await ready(page);
    await page.getByRole('button', { name: /^Plan:/ }).click();
    const panel = page.getByRole('dialog', { name: 'Plan' });
    await expect(panel).toHaveScreenshot('m07-plan-panel.png');
  });
});

test.describe('the "+" in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('Martin asks for an improvement', async ({ page }) => {
    await improve(page, 'martin', 'ink');
    await expect(page).toHaveScreenshot('m07-improve-ink.png');
  });
});

/** Milestone 7: Stop the line and Start the line in the header, and choosing what the line takes in Controls. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the line's controls`, () => {
    test.use({ viewport });

    test('Stop the line, with a reason', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      await page.getByRole('button', { name: 'Stop the line' }).click();
      const dialog = page.getByRole('dialog', { name: 'Stop the line' });
      await dialog.getByLabel('Reason').fill('Holding releases while I look at the deploy');
      await dialog.getByLabel('Reason').blur();
      await expect(page).toHaveScreenshot(`m07-stop-${width}.png`);
    });

    test('the header while the line is stopped, for a visitor', async ({ page }) => {
      await adminService(page, 'visitor');
      await page.goto(consoleUrl({ at: STOPPED }));
      await ready(page);
      await expect(page).toHaveScreenshot(`m07-stopped-${width}.png`, {
        clip: { x: 0, y: 0, width: viewport.width, height: 240 },
      });
    });

    test('Start the line, with a reason and the passkey', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl({ at: STOPPED }));
      await ready(page);
      await page.getByRole('button', { name: 'Start the line (asks for your passkey)' }).click();
      const dialog = page.getByRole('dialog', { name: 'Start the line' });
      await dialog.getByLabel('Reason').fill('The deploy is fine');
      await dialog.getByLabel('Reason').blur();
      await expect(page).toHaveScreenshot(`m07-start-${width}.png`);
    });

    test('Controls, choosing Just one', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      const controls = page.locator('article.controls');
      await controls.getByRole('button', { name: 'Just one' }).click();
      await controls.getByLabel('Work item #').fill('1329');
      await controls.getByLabel('Work item #').blur();
      await expect(controls).toHaveScreenshot(`m07-controls-just-one-${width}.png`);
    });
  });
}

test.describe("the line's controls in Ink", () => {
  test.use({ viewport: WIDTHS.desktop });

  test('Stop the line, with a reason', async ({ page }) => {
    await adminService(page, 'martin');
    await page.goto(consoleUrl({ theme: 'ink' }));
    await ready(page);
    await page.getByRole('button', { name: 'Stop the line' }).click();
    await page.getByRole('dialog', { name: 'Stop the line' }).getByLabel('Reason').fill('Holding releases');
    await page.getByRole('dialog', { name: 'Stop the line' }).getByLabel('Reason').blur();
    await expect(page).toHaveScreenshot('m07-stop-ink.png');
  });
});

/** Milestone 7: the audit log, the same for everyone, as a visitor reads it. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the audit log`, () => {
    test.use({ viewport });

    test('the audit log', async ({ page }) => {
      await adminService(page, 'visitor');
      await auditPage(page);
      await expect(page).toHaveScreenshot(`m07-audit-${width}.png`);
    });

    test('the audit log, narrowed to a visitor’s report', async ({ page }) => {
      await adminService(page, 'visitor');
      await auditPage(page, 'paper', '&item=1329');
      await expect(page).toHaveScreenshot(`m07-audit-report-${width}.png`, { fullPage: true });
    });
  });
}

test.describe('the audit log in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the audit log', async ({ page }) => {
    await adminService(page, 'visitor');
    await auditPage(page, 'ink');
    await expect(page).toHaveScreenshot('m07-audit-ink.png');
  });
});

/** The privacy page, from the footer, as a visitor reads it. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the privacy page`, () => {
    test.use({ viewport });

    test('the privacy page', async ({ page }) => {
      await adminService(page, 'visitor');
      await privacyPage(page);
      await expect(page).toHaveScreenshot(`privacy-${width}.png`, { fullPage: true });
    });
  });
}

test.describe('the privacy page in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the privacy page', async ({ page }) => {
    await adminService(page, 'visitor');
    await privacyPage(page, 'ink');
    await expect(page).toHaveScreenshot('privacy-ink.png', { fullPage: true });
  });
});

/** The privacy page drawn, with the fonts it is set in. */
async function privacyPage(page: Page, theme: 'paper' | 'ink' = 'paper') {
  await page.goto(`${consoleUrl({ theme })}&view=privacy`);
  await page.locator('.privacy-page').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** The audit log drawn, with the fonts it is set in. */
async function auditPage(page: Page, theme: 'paper' | 'ink' = 'paper', more = '') {
  await page.goto(`${consoleUrl({ theme })}&view=audit${more}`);
  await page.locator('table.audit tbody tr:not(.day)').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** The settings page drawn, with the fonts it is set in. */
async function settingsPage(page: Page, theme: 'paper' | 'ink' = 'paper') {
  await page.goto(`${consoleUrl({ theme })}&view=settings`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Task 22: Guardrails, opened at a row (`?open=`), for a visitor or for Martin: from the samples, where no attack can be
 * launched, or from the attacks' test data with every attack available, as the flag will make them.
 */
async function guardrailsAt(
  page: Page,
  as: 'martin' | 'visitor',
  open: number,
  {
    theme = 'paper',
    from = 'samples',
    at,
  }: { theme?: 'paper' | 'ink'; from?: 'samples' | 'attacks'; at?: number } = {},
) {
  await adminService(page, as, [], from);
  if (from === 'attacks') await attacksAvailable(page);
  await page.goto(`${from === 'attacks' ? attacksUrl({ theme, at }) : consoleUrl({ theme, at })}&open=${open}`);
  await ready(page);
  const panel = page.locator('#guardrails');
  await panel.locator('.more').waitFor();
  await panel.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  return panel;
}

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, Guardrails`, () => {
    test.use({ viewport });

    test('the checklist, a guardrail that did not hold opened, for a visitor', async ({ page }) => {
      const panel = await guardrailsAt(page, 'visitor', 5);
      await expect(panel).toHaveScreenshot(`m07-guardrails-visitor-${width}.png`);
    });

    test('a guardrail’s refusals in the week opened, one unverified, for a visitor', async ({ page }) => {
      const panel = await guardrailsAt(page, 'visitor', 1);
      await panel.locator('.reflist small').first().waitFor();
      await expect(panel).toHaveScreenshot(`m07-guardrails-refusals-${width}.png`);
    });

    test('the checklist for Martin, the attack in flight in its row', async ({ page }) => {
      const panel = await guardrailsAt(page, 'martin', 3, { from: 'attacks' });
      await expect(panel).toHaveScreenshot(`m07-guardrails-martin-${width}.png`);
    });

    test('Launch’s dialog, for Martin and for a visitor', async ({ page }) => {
      // After the attack in flight has passed its limit, so Launch is free.
      await guardrailsAt(page, 'martin', 5, { from: 'attacks', at: ATTACKS_END + 60 * 60_000 });
      await page.locator('#guardrails .more').getByRole('button', { name: 'Launch' }).click();
      await page.getByRole('dialog', { name: 'Data to an outside URL' }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`m07-attack-dialog-${width}.png`);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      const panel = await guardrailsAt(page, 'visitor', 5, { from: 'attacks' });
      await panel.locator('.more .gr-attack .ro').click();
      await page.getByRole('dialog', { name: 'Data to an outside URL' }).waitFor();
      await expect(page).toHaveScreenshot(`m07-attack-dialog-visitor-${width}.png`);
    });
  });
}

/** An attack's card for each way it stands, and a sheet's refusals whole, from the attacks' test data. */
const ATTACK_CARDS = { cut: '1289', 'not-refused': '1333', running: '1335' };

test.describe('attacks on the desktop', () => {
  test.use({ viewport: WIDTHS.desktop });

  for (const [state, item] of Object.entries(ATTACK_CARDS)) {
    test(`an attack’s card, ${state}`, async ({ page }) => {
      await page.goto(attacksUrl({ item }));
      await ready(page);
      const card = page.locator('.card[data-place="centre"]');
      await expect(card).toHaveScreenshot(`m07-attack-card-${state}.png`);
    });
  }

  test('an attack’s sheet: every refusal whole', async ({ page }) => {
    await page.goto(attacksUrl({ item: '1289', sheet: true }));
    const evidence = page.locator('.sheet .evidence-big');
    await evidence.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expect(evidence).toHaveScreenshot('m07-attack-sheet-evidence.png');
  });

  test('an attack’s sheet: what got through, and the egress attack’s control apart', async ({ page }) => {
    await page.goto(attacksUrl({ item: '1333', sheet: true }));
    const evidence = page.locator('.sheet .evidence-big');
    await evidence.waitFor();
    await expect(evidence.locator('.control')).toContainText('The control');
    await page.evaluate(() => document.fonts.ready);
    await expect(evidence).toHaveScreenshot('m07-attack-sheet-not-refused.png');
  });
});

test.describe('Guardrails on the desktop', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('an attack never launched, in its guardrail’s row, for Martin', async ({ page }) => {
    const panel = await guardrailsAt(page, 'martin', 1);
    await expect(panel.locator('.gr:has(.more)')).toHaveScreenshot('m07-guardrail-not-launched.png');
  });
});

test.describe('Guardrails in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the checklist, a guardrail that did not hold opened', async ({ page }) => {
    const panel = await guardrailsAt(page, 'martin', 5, { theme: 'ink' });
    await expect(panel).toHaveScreenshot('m07-guardrails-ink.png');
  });
});
