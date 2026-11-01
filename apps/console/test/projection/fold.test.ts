import type { PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { foldAt, foldOf, project, upTo } from '../../web/src/projection/index.ts';
import { stopsRelease } from '../../web/src/projection/items.ts';
import { appVersion, appVersions } from '../../web/src/projection/reel.ts';
import { projectSheet } from '../../web/src/projection/sheet.ts';
import { END, FIXTURE, SAMPLES } from './support.ts';

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
