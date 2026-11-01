/**
 * The feature flags as the console draws them (`projection/flags.ts`): each flag an improvement ships behind, from the
 * events, its slider's stops judged by the admin service's own rules (`policy/flag-moves.ts`), its card in Needs you,
 * the card's flag and the sheet's; and the samples' two flags. The move the confirmation sends is the one the admin
 * service takes, and the read of whether the app holds the flags is taken only whole.
 */
import type { PayloadOf, Screenshot } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { MOVE } from '../../../factory/src/admin/flags.ts';
import { isHeld } from '../../web/src/held.ts';
import { flagsView } from '../../web/src/projection/flags.ts';
import { project } from '../../web/src/projection/index.ts';
import { foldItems } from '../../web/src/projection/items.ts';
import { projectSheet } from '../../web/src/projection/sheet.ts';
import { END, SAMPLES, work } from './support.ts';

const START = Date.parse('2026-10-03T09:00:00Z');

/** An improvement whose spec names a flag, released with it off, then whatever moves Martin makes. */
function improvement(number: string, flag: string, released = true) {
  const item = work(number, START)
    .open('improvement')
    .add(5, 'spec.written', 'planner', {
      outcome: 'Something new',
      criteria: [{ given: 'the flag is on', when: 'a page is shown', expect: 'it is new' }],
      scope: ['src/new.ts'],
      risks: [],
      rollout: 'Behind its flag',
      flag,
    });
  if (released) {
    item.add(60, 'release.promoted', 'rollouts', {
      release: `r-${number}`,
      version: 'v1.0.0',
      previous: 'v0.9.9',
      watched: true,
      dryRun: false,
    });
    // Verify's run with the flag off, which Checks waits for.
    item.add(61, 'flag.checked', 'factory', {
      stage: 'off',
      flag,
      version: 'v1.0.0',
      revision: 'none',
      journeys: { passed: 23, ran: 24 },
      notClean: [],
      pages: [],
    });
  }
  return item;
}

type Staged = PayloadOf<'flag.staged'>;
/** The revision a move to a stage wrote, in these tests: one per stage, and per share. */
const moved = (to: Staged['to']) => `r-${to.stage}${to.stage === 'share' ? `-${to.share}` : ''}`;
const staged = (flag: string, from: Staged['from'], to: Staged['to'], action: Staged['action'], reason?: string) => ({
  flag,
  from,
  to,
  action,
  // Each move's revision its own, as the admin service writes them: named by where it went.
  revision: moved(to),
  steppedUp: action === 'flag.widen' || action === 'flag.back-on',
  ...(reason && { reason }),
});

/** A screenshot of the front page, as a check's event carries it. */
const homeShot = (hash: string): Screenshot => ({
  kind: 'screenshot',
  type: 'image/png',
  hash: hash.repeat(64),
  size: 1000,
  width: 1280,
  height: 800,
  route: '/',
  version: 'v1.0.0',
  boxes: [],
});

/** Verify's check of a flag at Checks or Preview, as the line appends it. */
function checked(flag: string, stage: 'checks' | 'preview', outcome: 'passed' | 'failed' | 'unsure', reason?: string) {
  const common = {
    flag,
    version: 'v1.0.0',
    revision: 'r1',
    moveRevision: moved({ stage }),
    against: 'v1.0.0',
    outcome,
    journeys: { base: { passed: 23, ran: 24 }, change: { passed: 23, ran: 24 } },
    regressions: [],
    ...(reason && { reason }),
  };
  return stage === 'checks'
    ? {
        ...common,
        stage,
        pages: [
          {
            page: '/',
            route: '/',
            scheme: 'light' as const,
            off: 'a'.repeat(64),
            on: 'b'.repeat(64),
            changed: 0.04,
            diff: 'c'.repeat(64),
          },
        ],
      }
    : { ...common, stage, device: { allowed: ['cookie preview'], kept: [] } };
}

const viewOf = (events: Parameters<typeof foldItems>[0], t = START + 1000 * 60_000) =>
  flagsView(events, foldItems(events), [], t);

describe('a flag', () => {
  it('shows once its release is out, off, with Checks the one stop it can widen to', () => {
    const before = improvement('2001', 'new-thing', false);
    expect(viewOf(before.events).flags).toEqual([]);
    const { flags, needs } = viewOf(improvement('2001', 'new-thing').events);
    expect(flags.map((row) => [row.name, row.workItem, row.stage.stage])).toEqual([['new-thing', '2001', 'off']]);
    const stops = flags[0]?.stops.map((stop) => [stop.stage, stop.place, stop.move.action, Boolean(stop.move.refused)]);
    expect(stops).toEqual([
      ['off', 'now', undefined, true],
      ['checks', 'ahead', 'flag.to-checks', false],
      ['preview', 'ahead', 'flag.widen', true],
      ['share', 'ahead', 'flag.widen', true],
      ['everyone', 'ahead', 'flag.back-on', true],
    ]);
    // Released and still off, it waits for Martin, with no Turn off: it is off already.
    expect(needs).toMatchObject([
      { flag: 'new-thing', kicker: 'Shipped behind its flag', widen: { to: { stage: 'checks' } } },
    ]);
    expect(needs[0]?.turnOff).toBeUndefined();
  });

  it('waits at Off for Verify’s run with the flag off before Checks can be taken', () => {
    const events = improvement('2016', 'unseen').events.filter((event) => event.type !== 'flag.checked');
    const { flags, needs } = viewOf(events);
    expect(flags[0]?.stops.find((stop) => stop.stage === 'checks')?.move.refused).toMatch(
      /^Verify has no picture of the app with the flag off, in light and dark, yet/,
    );
    expect(needs[0]?.widen.refused).toMatch(/no picture of the app with the flag off/);
  });

  it('may skip Preview from Checks, and no other stage', () => {
    const item = improvement('2002', 'skip').add(
      70,
      'flag.staged',
      'martin',
      staged('skip', { stage: 'off' }, { stage: 'checks' }, 'flag.to-checks'),
    );
    item.add(80, 'flag.checked', 'factory', checked('skip', 'checks', 'passed'));
    const [row] = viewOf(item.events).flags;
    const refused = Object.fromEntries(row?.stops.map((stop) => [stop.stage, stop.move.refused]) ?? []);
    expect(refused.preview).toBeUndefined();
    expect(refused.share).toBeUndefined();
    expect(refused.everyone).toMatch(/One stage at a time/);
    expect(row?.stops.find((stop) => stop.stage === 'off')?.move.action).toBe('flag.off');
  });

  it('waits at Checks and Preview while Verify checks, with no card, and widening past each refused until it passes', () => {
    const item = improvement('2015', 'checked').add(
      70,
      'flag.staged',
      'martin',
      staged('checked', { stage: 'off' }, { stage: 'checks' }, 'flag.to-checks'),
    );
    const checking = viewOf(item.events);
    expect(checking.flags[0]).toMatchObject({ check: 'checking', checked: undefined });
    const refusedAt = (view: typeof checking, stage: string) =>
      view.flags[0]?.stops.find((stop) => stop.stage === stage)?.move.refused;
    expect(refusedAt(checking, 'preview')).toBe(
      'Verify is still checking the flag at Checks: Preview can be taken once the check has passed.',
    );
    expect(refusedAt(checking, 'share')).toMatch(/still checking the flag at Checks: Share/);
    expect(checking.needs).toEqual([]);
    expect(foldItems(item.events)[0]?.outcome).toBe('in-progress');
    // Its block on the sheet says it is checking.
    const block = () => projectSheet(project(item.events, START + 1000 * 60_000), '2015')?.flag?.blocks[0];
    expect(block()).toMatchObject({ kind: 'staged', current: true, checked: undefined });

    // A check another actor appended is no check of Verify's.
    item.add(75, 'flag.checked', 'martin', checked('checked', 'checks', 'passed'));
    expect(viewOf(item.events).flags[0]?.check).toBe('checking');
    expect(block()).toMatchObject({ checked: undefined });
    item.add(76, 'flag.checked', 'triage', checked('checked', 'checks', 'passed'));
    expect(viewOf(item.events).flags[0]?.check).toBe('checking');
    // Nor one that names an earlier move, however late it comes.
    item.add(77, 'flag.checked', 'factory', { ...checked('checked', 'checks', 'passed'), moveRevision: 'r-earlier' });
    expect(viewOf(item.events).flags[0]?.check).toBe('checking');
    expect(block()).toMatchObject({ checked: undefined });

    item.add(80, 'flag.checked', 'factory', {
      ...checked('checked', 'checks', 'passed'),
    });
    // Each screenshot the check names is among its event's artifacts.
    const last = item.events.at(-1) as (typeof item.events)[number];
    last.artifacts = [homeShot('a'), homeShot('b'), homeShot('c')];
    const passed = viewOf(item.events);
    expect(passed.flags[0]?.check).toBe('passed');
    expect(refusedAt(passed, 'preview')).toBeUndefined();
    expect(passed.needs[0]).toMatchObject({
      kicker: 'Ready to widen',
      widen: { to: { stage: 'preview' } },
      pictures: { page: '/', off: { hash: 'a'.repeat(64) }, on: { hash: 'b'.repeat(64) } },
    });
    expect(passed.needs[0]?.evidence).toBe(
      '23 of 24 checks passed with it on, against 23 of 24 with it off: none that passed with it off failed. No probe knows a new feature: judge the pages off and on before you widen.',
    );
    expect(foldItems(item.events)[0]?.outcome).toBe('needs-you');
    expect(block()).toMatchObject({ checked: { stage: 'checks', outcome: 'passed', at: START + 80 * 60_000 } });

    // Widened to Preview, the check at Checks is of the flag as it was: Share waits for Preview's own.
    item.add(90, 'flag.staged', 'martin', staged('checked', { stage: 'checks' }, { stage: 'preview' }, 'flag.widen'));
    expect(refusedAt(viewOf(item.events), 'share')).toMatch(/still checking the flag at Preview: Share/);
    expect(viewOf(item.events).needs).toEqual([]);
    item.add(
      95,
      'flag.checked',
      'factory',
      checked('checked', 'preview', 'failed', 'The app kept no preview cookie when a probe asked to preview the flag'),
    );
    const failed = viewOf(item.events);
    expect(failed.flags[0]?.check).toBe('failed');
    expect(failed.needs[0]?.widen.refused).toBe(
      "Verify's check at Preview failed: Share can't be taken. Narrow it to Checks to check it again, or turn it off.",
    );
    expect(failed.needs[0]?.evidence).toBe(
      '23 of 24 checks passed with it on, against 23 of 24 with it off. The app kept no preview cookie when a probe asked to preview the flag.',
    );
    expect(failed.needs[0]?.pictures).toBeUndefined();
    const blocks = projectSheet(project(item.events, START + 1000 * 60_000), '2015')?.flag?.blocks;
    expect(blocks?.map((b) => (b.kind === 'staged' ? [b.stage.stage, b.checked?.outcome] : b.kind))).toEqual([
      ['preview', 'failed'],
      ['checks', 'passed'],
      'released',
    ]);
  });

  it('waits at Share while Verify compares, with no card, and Everyone refused until the comparison passes', () => {
    const item = improvement('2003', 'shared').add(
      70,
      'flag.staged',
      'martin',
      staged('shared', { stage: 'preview' }, { stage: 'share', share: 25 }, 'flag.widen'),
    );
    const comparing = viewOf(item.events);
    expect(comparing.flags[0]).toMatchObject({ share: 25, comparison: 'comparing' });
    expect(comparing.flags[0]?.stops.at(-1)?.move.refused).toMatch(/still comparing/);
    expect(comparing.needs).toEqual([]);
    expect(foldItems(item.events)[0]?.outcome).toBe('in-progress');

    item.add(120, 'flag.compared', 'factory', {
      flag: 'shared',
      share: 25,
      moveRevision: 'r-share-25',
      window: { from: new Date(START).toISOString(), to: new Date(START + 1).toISOString() },
      setAsideMinutes: 0,
      outcome: 'passed',
      sides: {
        on: { requests: 412, errorRate: 0.0097, p99Ms: 41 },
        off: { requests: 398, errorRate: 0.0101, p99Ms: 40 },
      },
    });
    const compared = viewOf(item.events);
    expect(compared.flags[0]?.comparison).toBe('passed');
    expect(compared.needs[0]).toMatchObject({
      kicker: 'Ready to widen',
      widen: { to: { stage: 'everyone' }, action: 'flag.widen' },
    });
    expect(compared.needs[0]?.widen.refused).toBeUndefined();
    expect(compared.needs[0]?.evidence).toContain(
      'errors 0.97% and 1.01%, p99 41 ms and 40 ms, over 412 and 398 requests',
    );
    // Waiting for Martin to widen, its outcome is Needs you.
    expect(foldItems(item.events)[0]?.outcome).toBe('needs-you');
  });

  it('turned off from Everyone may go straight back, with the passkey, and stays among the flags', () => {
    const item = improvement('2004', 'back')
      .add(
        70,
        'flag.staged',
        'martin',
        staged('back', { stage: 'share', share: 50 }, { stage: 'everyone' }, 'flag.widen'),
      )
      .add(
        80,
        'flag.staged',
        'martin',
        staged('back', { stage: 'everyone' }, { stage: 'off' }, 'flag.off', 'Wrong on Sundays'),
      )
      .add(81, 'work-item.closed', 'factory', { outcome: 'verified', reason: 'Verified' });
    const { flags, closed } = viewOf(item.events);
    expect(closed).toEqual([]);
    expect(flags[0]).toMatchObject({ backOn: true, turnedOff: true });
    expect(flags[0]?.stops.at(-1)?.move).toMatchObject({ action: 'flag.back-on' });
    expect(flags[0]?.stops.at(-1)?.move.refused).toBeUndefined();
  });

  it('closed as verified at Everyone stays among the flags, Martin’s to turn off, and folds once narrowed and off', () => {
    const item = improvement('2015', 'shipped')
      .add(
        70,
        'flag.staged',
        'martin',
        staged('shipped', { stage: 'share', share: 50 }, { stage: 'everyone' }, 'flag.widen'),
      )
      .add(71, 'work-item.closed', 'factory', {
        outcome: 'verified',
        reason: "Martin widened shipped to Everyone, after Verify's comparison at Share passed",
      });
    const at = START + 1000 * 60_000;
    const { flags, closed, needs } = viewOf(item.events);
    expect(closed).toEqual([]);
    expect(needs).toEqual([]);
    expect(flags[0]).toMatchObject({ name: 'shipped', open: false, done: true, backOn: false });
    expect(flags[0]?.stops.at(0)?.move).toMatchObject({ action: 'flag.off' });
    expect(flags[0]?.stops.at(0)?.move.refused).toBeUndefined();
    // Its outcome is Verified, a chapter of its own, and its story ends saying how.
    expect(foldItems(item.events)[0]?.outcome).toBe('verified');
    const sheet = projectSheet(project(item.events, at), '2015');
    expect(sheet?.chapters.at(-1)).toMatchObject({ label: 'VERIFIED', tone: 'ok' });
    // Its story ends with the line's reason: no sense verified it, so there is no check to name.
    expect(sheet?.closing).toBe(
      "It closed: Martin widened shipped to Everyone, after Verify's comparison at Share passed.",
    );
    // Narrowed and turned off, it can't go straight back, and folds as a turned-off one does.
    const off = item
      .add(
        80,
        'flag.staged',
        'martin',
        staged('shipped', { stage: 'everyone' }, { stage: 'share', share: 50 }, 'flag.narrow'),
      )
      .add(
        90,
        'flag.staged',
        'martin',
        staged('shipped', { stage: 'share', share: 50 }, { stage: 'off' }, 'flag.off', 'No'),
      );
    expect(viewOf(off.events).closed.map((row) => row.name)).toEqual(['shipped']);
    expect(foldItems(off.events)[0]?.outcome).toBe('verified');
  });

  it('turned off before everyone had it, its work item closed, folds under Turned off and closed', () => {
    const item = improvement('2005', 'gone')
      .add(70, 'flag.staged', 'martin', staged('gone', { stage: 'off' }, { stage: 'checks' }, 'flag.to-checks'))
      .add(80, 'flag.staged', 'martin', staged('gone', { stage: 'checks' }, { stage: 'off' }, 'flag.off', 'Not needed'))
      .add(81, 'work-item.closed', 'factory', { outcome: 'turned-off', reason: 'Not needed' });
    const { flags, closed, needs } = viewOf(item.events);
    expect(flags).toEqual([]);
    expect(closed.map((row) => row.name)).toEqual(['gone']);
    expect(closed[0]?.open).toBe(false);
    expect(needs).toEqual([]);
    // Its outcome is Turned off, and its story ends with Martin's reason: nothing rolled back.
    expect(foldItems(item.events)[0]?.outcome).toBe('turned-off');
    expect(projectSheet(project(item.events, START + 1000 * 60_000), '2005')?.closing).toBe(
      'Martin turned its flag off: Not needed. It closed as turned off, its code still in the app, off, and nothing rolled back.',
    );
  });

  it('says which work item Just one names, when it is another, which the line closes this one only after', () => {
    const item = improvement('2014', 'later').add(
      70,
      'flag.staged',
      'martin',
      staged('later', { stage: 'off' }, { stage: 'checks' }, 'flag.to-checks'),
    );
    const last = item.events.at(-1) as (typeof item.events)[number];
    const take = (workItem: string) =>
      ({
        ...last,
        id: `take-${workItem}`,
        seq: last.seq + 1,
        work_item: null,
        type: 'controls.changed',
        summary: `Martin chose Just one, #${workItem}`,
        payload: {
          autonomy: 'guarded',
          newWork: true,
          autoMerge: false,
          take: { kind: 'just-one', workItem },
          change: { control: 'take', before: null, after: { kind: 'just-one', workItem } },
        },
      }) as unknown as (typeof item.events)[number];
    expect(viewOf(item.events).flags[0]?.justOne).toBeUndefined();
    expect(viewOf([...item.events, take('1302')]).flags[0]?.justOne).toBe('1302');
    expect(viewOf([...item.events, take('2014')]).flags[0]?.justOne).toBeUndefined();
  });

  it('keeps a flag turned off and closed some other way among the flags, unfolded', () => {
    const item = improvement('2013', 'other')
      .add(70, 'flag.staged', 'martin', staged('other', { stage: 'off' }, { stage: 'checks' }, 'flag.to-checks'))
      .add(80, 'flag.staged', 'martin', staged('other', { stage: 'checks' }, { stage: 'off' }, 'flag.off', 'Not now'))
      .add(81, 'work-item.closed', 'martin', { outcome: 'no-change', reason: 'Martin closed it' });
    const { flags, closed } = viewOf(item.events);
    expect(closed).toEqual([]);
    expect(flags.map((row) => row.name)).toEqual(['other']);
  });

  it('says on the sheet which flags set by hand a move’s write dropped', () => {
    const item = improvement('2012', 'tidy').add(70, 'flag.staged', 'martin', {
      ...staged('tidy', { stage: 'off' }, { stage: 'checks' }, 'flag.to-checks'),
      dropped: ['hand-made'],
    });
    const blocks = projectSheet(project(item.events, START + 1000 * 60_000), '2012')?.flag?.blocks;
    expect(blocks?.[0]).toMatchObject({ kind: 'staged', dropped: ['hand-made'] });
    expect(blocks?.[1]).toMatchObject({ kind: 'released' });
  });

  it('believes only Martin’s moves, which only his roles can append', () => {
    const item = improvement('2006', 'forged').add(
      70,
      'flag.staged',
      'coder',
      staged('forged', { stage: 'off' }, { stage: 'everyone' }, 'flag.back-on'),
    );
    expect(viewOf(item.events).flags[0]?.stage.stage).toBe('off');
  });

  it('waits for Martin only once its release is out, as its card does', () => {
    const early = improvement('2009', 'early', false).add(
      70,
      'flag.staged',
      'martin',
      staged('early', { stage: 'off' }, { stage: 'checks' }, 'flag.to-checks'),
    );
    expect(viewOf(early.events).needs).toEqual([]);
    expect(foldItems(early.events)[0]?.outcome).not.toBe('needs-you');
  });

  it('belongs to the work item whose spec named it last, as the admin service reads it', () => {
    const older = improvement('2010', 'other');
    const newer = improvement('2011', 'shared-name');
    // The older improvement's spec is written again, later, naming the same flag.
    older.add(200, 'spec.written', 'planner', {
      outcome: 'Something new, again',
      criteria: [{ given: 'the flag is on', when: 'a page is shown', expect: 'it is new' }],
      scope: ['src/new.ts'],
      risks: [],
      rollout: 'Behind its flag',
      flag: 'shared-name',
    });
    const events = [...older.events, ...newer.events].sort((a, b) => a.seq - b.seq);
    expect(viewOf(events).flags.find((row) => row.name === 'shared-name')?.workItem).toBe('2010');
  });

  it('holds Share for a flag while another is at it', () => {
    const one = improvement('2007', 'one').add(
      70,
      'flag.staged',
      'martin',
      staged('one', { stage: 'preview' }, { stage: 'share', share: 50 }, 'flag.widen'),
    );
    const two = improvement('2008', 'two').add(
      70,
      'flag.staged',
      'martin',
      staged('two', { stage: 'checks' }, { stage: 'preview' }, 'flag.widen'),
    );
    const [, row] = viewOf([...one.events, ...two.events]).flags;
    expect(row?.stops.find((stop) => stop.stage === 'share')?.move.refused).toBe(
      'one is at Share: one flag at a time, so each comparison varies one thing.',
    );
  });
});

describe('the samples’ flags', () => {
  const view = project(SAMPLES, END);

  it('are last-one, on for everyone, and delivery-dates at Preview, Share held by the canary in flight at 50%', () => {
    expect(view.flags.flags.map((row) => [row.name, row.workItem, row.stage.stage])).toEqual([
      ['last-one', '1271', 'everyone'],
      ['delivery-dates', '1294', 'preview'],
    ]);
    const share = view.flags.flags[1]?.stops.find((stop) => stop.stage === 'share');
    expect(share?.move.refused).toBe(
      'v0.9.13 is at 50%, and its two versions would mix the two sides. Share can be taken once it ends.',
    );
    expect(view.flags.needs).toMatchObject([
      { flag: 'delivery-dates', kicker: 'Ready to widen', widen: { to: { stage: 'share', share: 50 } } },
    ]);
    // Verify's checks at Checks and Preview have passed: only the canary holds Share.
    expect(view.flags.flags[1]).toMatchObject({ check: 'passed', checked: { stage: 'preview', outcome: 'passed' } });
  });

  it('draw the flag on its card and its sheet: the stage on the card, the fact, the chapters and a block per move', () => {
    expect(view.cards.find((card) => card.number === '1294')).toMatchObject({
      outcome: 'needs-you',
      flag: { name: 'delivery-dates', stage: 'preview' },
    });
    // An improvement whose spec waits has no flag on its card, and its fact says so.
    expect(view.cards.find((card) => card.number === '1300')?.flag).toBeUndefined();
    expect(projectSheet(project(SAMPLES, END), '1300')?.facts.flag).toBe('sort-by-price · not built yet');

    const sheet = projectSheet(project(SAMPLES, END), '1271');
    expect(sheet?.facts.flag).toBe('last-one · everyone');
    expect(sheet?.chapters.map((c) => c.label)).toEqual(
      expect.arrayContaining(['CHECKS', 'PREVIEW', 'SHARE', 'COMPARED', 'EVERYONE']),
    );
    expect(sheet?.chapters.find((c) => c.label === 'PREVIEW')?.text).toBe(
      'Martin widened last-one from Checks to Preview, with his passkey',
    );
    expect(sheet?.chapters.find((c) => c.label === 'CHECKS')?.text).toBe('Martin widened last-one from Off to Checks');
    expect(sheet?.flag?.blocks.map((b) => (b.kind === 'released' ? 'released' : b.stage.stage))).toEqual([
      'everyone',
      'share',
      'preview',
      'checks',
      'released',
    ]);
    const share = sheet?.flag?.blocks[1];
    expect(share?.kind === 'staged' && share.compared?.outcome).toBe('passed');
    // Each stage before Share was checked before it widened, the pages pictured at Checks.
    const [, , preview, checks] = sheet?.flag?.blocks ?? [];
    expect(preview?.kind === 'staged' && preview.checked?.outcome).toBe('passed');
    expect(checks?.kind === 'staged' && checks.checked?.stage === 'checks' && checks.checked.pages).toEqual([
      expect.objectContaining({ page: '/', scheme: 'light', changed: 0 }),
      expect.objectContaining({ page: '/', scheme: 'dark', changed: 0 }),
    ]);
    expect(checks?.kind === 'staged' && checks.checked?.shots.map((shot) => shot.route)).toEqual(['/', '/']);
  });
});

describe('what the console sends and reads', () => {
  it('sends a move as the admin service takes it', () => {
    expect(MOVE.safeParse({ from: { stage: 'preview' }, to: { stage: 'share', share: 50 } }).success).toBe(true);
    expect(
      MOVE.safeParse({ from: { stage: 'checks' }, to: { stage: 'off' }, reason: 'Wrong on Sundays' }).success,
    ).toBe(true);
  });

  it('takes the read of whether the app holds the flags only whole', () => {
    const held = { state: 'held', revision: 'r6', held: ['r6'], since: null, checkedAt: '2026-10-06T14:23:00.000Z' };
    expect(isHeld(held)).toBe(true);
    expect(isHeld({ ...held, state: 'fine' })).toBe(false);
    expect(isHeld({ ...held, held: [6] })).toBe(false);
    expect(isHeld({ ...held, checkedAt: 'yesterday' })).toBe(false);
    expect(isHeld({ ...held, revision: undefined })).toBe(false);
  });
});
