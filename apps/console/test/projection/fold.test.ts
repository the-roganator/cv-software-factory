import type { PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { foldAt, foldOf, project, upTo } from '../../web/src/projection/index.ts';
import { foldItem, stopsRelease } from '../../web/src/projection/items.ts';
import { appVersion, appVersions } from '../../web/src/projection/reel.ts';
import { projectSheet } from '../../web/src/projection/sheet.ts';
import { END, FIXTURE, SAMPLES, work } from './support.ts';

// The live console's clock moves t every ten seconds with no new event: the fold of the events is made once for them,
// and only what depends on the time is drawn again.
describe('the fold of the events', () => {
  const later = END + 10_000;

  it('is made once while t cuts the events the same', () => {
    const events = [...SAMPLES];
    const fold = foldAt(events, END);
    expect(foldAt(events, later)).toBe(fold);
    expect(foldAt(events, END + 3_600_000)).toBe(fold);
    // The view at each t is drawn from it.
    expect(foldOf(project(events, later))).toBe(fold);
  });

  it('is made again when t cuts them elsewhere, or new events arrive', () => {
    const events = [...SAMPLES];
    const fold = foldAt(events, END);
    const earlier = Date.parse(SAMPLES.at(-40)?.ts ?? '');
    expect(foldAt(events, earlier)).not.toBe(fold);
    expect(foldAt(events, earlier).seen).toEqual(upTo(SAMPLES, earlier));
    expect(foldAt(events, END)).not.toBe(fold);
    expect(foldAt(events, END)).toEqual(fold);
    expect(foldAt([...events], END)).not.toBe(foldAt(events, END));
  });

  it('is made again when an event by t is added to the same list', () => {
    const events = SAMPLES.slice(0, -1);
    const fold = foldAt(events, END);
    events.push(SAMPLES.at(-1) as PublicEvent);
    const again = foldAt(events, END);
    expect(again).not.toBe(fold);
    expect(again.seen).toEqual(upTo(SAMPLES, END));
  });

  it('draws the same view at a t as a fold made for it alone', () => {
    const events = [...SAMPLES];
    project(events, END);
    for (const t of [later, END + 20 * 60_000, END + 30 * 3_600_000]) {
      const kept = project(events, t);
      expect(foldOf(kept)).toBe(foldAt(events, END));
      const fresh = project([...SAMPLES], t);
      expect(kept).toEqual(fresh);
      for (const card of fresh.cards) expect(projectSheet(kept, card.number)).toEqual(projectSheet(fresh, card.number));
    }
  });

  it('leaves what depends on the time to the time', () => {
    const events = [...SAMPLES];
    const now = project(events, END);
    const after = project(events, END + 2 * 3_600_000);
    expect(foldOf(after)).toBe(foldOf(now));
    // A wait for Martin has waited longer, and work still open has taken longer.
    expect(after.needs.holds.map((h) => h.waited)).not.toEqual(now.needs.holds.map((h) => h.waited));
    const open = now.cards.findIndex((c) => c.outcome === 'in-progress');
    expect(after.cards[open]?.durationMs).toBe((now.cards[open]?.durationMs ?? 0) + 2 * 3_600_000);
    // A closed work item's card is the same card.
    const closed = now.cards.findIndex((c) => c.outcome === 'verified');
    expect(after.cards[closed]).toBe(now.cards[closed]);
  });
});

/** The version the app was on at a time, by walking the events up to it. */
function walked(events: readonly PublicEvent[], at: number): string | undefined {
  let version: string | undefined;
  for (const event of events) {
    if (Date.parse(event.ts) > at) break;
    if ('dryRun' in event.payload && event.payload.dryRun) continue;
    if (event.type === 'release.promoted' || event.type === 'defect.injected') version = event.payload.version;
    if (stopsRelease(event)) version = event.payload.restored;
    if (event.type === 'release.started' && !version) version = event.payload.previous;
  }
  return version;
}

describe('the version the app was on', () => {
  it.each([
    ['the samples', SAMPLES],
    ['the fixture', FIXTURE],
  ])('is found in the list of versions as by walking %s', (_, events) => {
    const versions = appVersions(events);
    const times = events.flatMap((e) => [Date.parse(e.ts) - 1, Date.parse(e.ts), Date.parse(e.ts) + 1]);
    for (const at of [0, ...times, Number.POSITIVE_INFINITY]) expect(appVersion(versions, at)).toBe(walked(events, at));
  });

  it('stops at the first event later than the time, as a walk does, though a later one is earlier', () => {
    const [a, b, c] = SAMPLES.filter((e) => e.type === 'release.promoted');
    if (!a || !b || !c) throw new Error('The samples promote fewer than three releases');
    const ts = (e: PublicEvent, at: number) => ({ ...e, ts: new Date(at).toISOString() }) as PublicEvent;
    const events = [ts(a, 1000), ts(b, 3000), ts(c, 2000)];
    const versions = appVersions(events);
    for (const at of [999, 1000, 2000, 2500, 3000]) expect(appVersion(versions, at)).toBe(walked(events, at));
  });
});

describe("a ticket's severity, raised by triage", () => {
  it('shows the worst of its opening and its ratings, and never a lower one', () => {
    const { events } = work('1500')
      .open('dependency-update')
      .add(1, 'ticket.opened', 'triage', {
        title: 'Move node, in docker',
        category: 'security',
        severity: 'degraded',
        fingerprint: { name: 'node', ecosystem: 'docker' },
        traces: [],
      })
      .add(2, 'ticket.rated', 'triage', { severity: 'broken', was: 'degraded' });
    const item = foldItem(events);
    expect(item?.ticket?.severity).toBe('broken');
    // It moves the work item nowhere: still at Plan, queued.
    expect(item?.stage).toBe('plan');
    const view = project(events, Date.parse(events.at(-1)?.ts ?? '') + 60_000);
    expect(projectSheet(view, '1500')?.facts.ticket?.severity).toBe('broken');
  });
});

describe('a move reopened', () => {
  it('reads as a reopening with its move, and names no route', () => {
    const { events } = work('1501')
      .open('dependency-update')
      .add(1, 'ticket.opened', 'triage', {
        title: 'Move node, in docker',
        category: 'security',
        severity: 'broken',
        fingerprint: { name: 'node', ecosystem: 'docker' },
        traces: [],
      })
      .add(2, 'work-item.closed', 'factory', { outcome: 'verified', reason: 'Gone from the scan' })
      .add(3, 'work-item.reopened', 'triage', {
        sense: 'dependency',
        check: 'the vulnerability scan',
        move: { name: 'node', ecosystem: 'docker' },
        version: 'a'.repeat(40),
        reason: 'The day’s scan found the move again',
        dryRun: false,
      });
    const item = foldItem(events);
    expect(item?.reopened).toMatchObject({ sense: 'dependency', move: { name: 'node' } });
    expect(item?.reopened).not.toHaveProperty('route');
  });
});

describe('a move named by its issue', () => {
  // As the public views have them: a lockfile move's package and versions withheld until its issue opens.
  const { events } = work('1502')
    .add(0, 'work-item.opened', 'triage', {
      kind: 'dependency-update',
      title: 'Move a package in `pnpm-lock.yaml`',
      sample: false,
      category: 'security',
      dependency: { name: 'a package', ecosystem: 'npm', from: '', to: '', security: true },
    })
    .add(0, 'ticket.opened', 'triage', {
      title: 'Move a package in `pnpm-lock.yaml`',
      category: 'security',
      severity: 'broken',
      fingerprint: { name: 'a package', ecosystem: 'npm' },
      traces: [],
    })
    .add(2, 'issue.opened', 'factory', {
      repository: 'the-roganator/cv-worlds-worst-website',
      number: 77,
      move: {
        name: 'left-pad',
        ecosystem: 'npm',
        from: '1.2.3',
        to: '1.2.4',
        pins: [{ file: 'pnpm-lock.yaml', line: 812 }],
        findings: [
          { advisory: 'GHSA-aaaa-bbbb-cccc', package: 'left-pad', severity: { scanner: 'high' }, fixed: '1.2.4' },
        ],
      },
    })
    .add(3, 'ticket.rated', 'triage', { severity: 'broken', was: 'degraded' });
  const sheetAt = (minute: number) =>
    projectSheet(project(events, Date.parse('2026-10-03T09:00:00Z') + minute * 60_000), '1502');

  it('withholds the move on its ticket line and its picture until the issue opens, and links no issue', () => {
    const sheet = sheetAt(1);
    expect(sheet?.facts.ticket?.fingerprint).toBe('a package · npm');
    expect(sheet?.evidence).toMatchObject({ type: 'package', dependency: { name: 'a package', from: '', to: '' } });
    expect(sheet?.issue).toBeUndefined();
  });

  it('names it from `issue.opened` on, and links the issue, whatever follows', () => {
    const sheet = sheetAt(4);
    expect(sheet?.facts.ticket?.fingerprint).toBe('left-pad · npm');
    expect(sheet?.evidence).toMatchObject({
      type: 'package',
      dependency: { name: 'left-pad', ecosystem: 'npm', from: '1.2.3', to: '1.2.4', security: true },
    });
    expect(sheet?.issue).toEqual({ repository: 'the-roganator/cv-worlds-worst-website', number: 77 });
  });

  it('keeps the versions it had when the issue named the fingerprint’s move alone', () => {
    const fingerprint = events.map((event) =>
      event.type === 'issue.opened'
        ? { ...event, payload: { ...event.payload, move: { name: 'left-pad', ecosystem: 'npm' } } }
        : event,
    ) as PublicEvent[];
    expect(foldItem(fingerprint)?.dependency).toEqual({
      name: 'left-pad',
      ecosystem: 'npm',
      from: '',
      to: '',
      security: true,
    });
  });
});

describe('a disclosed move reopened', () => {
  it('reads its reopening with the name its issue gave, whichever came first', () => {
    const reopened = {
      sense: 'dependency',
      check: 'the vulnerability scan',
      move: { name: 'a package', ecosystem: 'npm' },
      version: 'a'.repeat(40),
      reason: 'The day’s scan found the move again',
      dryRun: false,
    } as const;
    const issue = {
      repository: 'the-roganator/cv-worlds-worst-website',
      number: 78,
      move: { name: 'left-pad', ecosystem: 'npm' },
    } as const;
    const after = work('1503')
      .open('dependency-update')
      .add(1, 'issue.opened', 'factory', issue)
      .add(2, 'work-item.closed', 'factory', { outcome: 'verified', reason: 'Gone from the scan' })
      .add(3, 'work-item.reopened', 'triage', reopened);
    expect(foldItem(after.events)?.reopened?.move?.name).toBe('left-pad');
    const before = work('1504')
      .open('dependency-update')
      .add(1, 'work-item.reopened', 'triage', reopened)
      .add(2, 'issue.opened', 'factory', issue);
    expect(foldItem(before.events)?.reopened?.move?.name).toBe('left-pad');
  });
});
