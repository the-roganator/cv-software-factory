/**
 * A work item's release and verification on its sheet and its card (the design system's README, "Shipping"): from
 * the samples' work that goes round twice, is reopened, waits for Martin's deploy, and ships in a dry run.
 */
import type { PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { project } from '../../web/src/projection/index.ts';
import { type Chapter, marksNote, projectSheet, scrubbed, spread, TARGET } from '../../web/src/projection/sheet.ts';
import { END, SAMPLES } from './support.ts';

const sheet = (item: string, t = END) => projectSheet(project(SAMPLES, t), item);
const returned = Date.parse(SAMPLES.find((e) => e.work_item === '1306' && e.type === 'work.returned')?.ts ?? '');

describe('Release and Verify on the sheet', () => {
  it('has a block for each release that carried the work item, newest first, each with its verification', () => {
    const shipped = sheet('1306')?.shipped ?? [];
    expect(shipped.map((s) => s.release.version)).toEqual(['v0.9.10', 'v0.9.8']);
    expect(shipped[0]?.verification).toMatchObject({ outcome: 'cleared', sense: 'logs', version: 'v0.9.10' });
    expect(shipped[1]?.verification).toMatchObject({
      outcome: 'persists',
      held: false,
      against: 'v0.9.7',
      words: 'The logs still saw “new error pattern” on v0.9.8, the release that carried the fix',
    });
    // The release carried #1304's fix too.
    expect(shipped[1]?.release.items.map((i) => i.number)).toEqual(['1304', '1306']);
  });

  it('marks nothing on the pages for a sense that looks at no page', () => {
    const verification = sheet('1306')?.shipped[0]?.verification;
    expect(verification?.marked).toBe(false);
    expect(verification?.pages.every((p) => !p.screenshot?.boxes.length)).toBe(true);
    expect(verification?.pages.length).toBeLessThanOrEqual(4);
  });

  it('says a pageless sense marks nothing, even when it compared no page', () => {
    const verification = sheet('1306')?.shipped[0]?.verification;
    if (!verification) throw new Error('no verification');
    expect(marksNote({ ...verification, pages: [], more: { count: 0, same: true } })).toBe(
      'No marks: the log watcher looks at no page, so nothing on one is its finding.',
    );
  });

  it('shows the wait for a deploy as the merge and the deploy pull request, on the card and the sheet', () => {
    const view = project(SAMPLES, END);
    const picture = view.cards.find((c) => c.number === '1321')?.picture;
    expect(picture).toMatchObject({
      type: 'deploy',
      pullRequest: 1322,
      merged: { byMartin: true },
      deploy: { pullRequest: 1331, state: 'checking' },
      waitsForMartin: false,
    });
    // Earlier, #1314's deploy pull request had passed its checks, and waited for Martin.
    const before = project(SAMPLES, Date.parse('2026-10-06T09:30:00Z')).cards.find((c) => c.number === '1314');
    expect(before?.picture).toMatchObject({ type: 'deploy', deploy: { pullRequest: 1330, state: 'passed' } });
    expect(before).toMatchObject({ outcome: 'needs-you', picture: { waitsForMartin: true } });
    expect(sheet('1321')?.deploy).toEqual(picture);
    expect(sheet('1321')?.shipped).toEqual([]);
  });

  it('marks a dry run’s release, and gives its chapters no tone', () => {
    const s = sheet('1310');
    expect(s?.shipped[0]?.release.dryRun).toBe(true);
    expect(s?.chapters.find((c) => c.label === 'PROMOTED')?.tone).toBe('faint');
    expect(s?.chapters.find((c) => c.label === 'VERIFIED')?.tone).toBe('faint');
  });
});

describe('a work item that goes round more than once', () => {
  it('has one chapter for each release, PERSISTS where the signal persisted, and a pass for each time round', () => {
    const chapters = sheet('1306')?.chapters ?? [];
    const labels = chapters.map((c) => `${c.pass} ${c.label}`);
    expect(labels.filter((l) => /PROMOTED|PERSISTS|PLAN|VERIFIED|REOPENED/.test(l))).toEqual([
      '1 PROMOTED',
      '1 PERSISTS',
      '2 PLAN',
      '2 PROMOTED',
      '2 VERIFIED',
      '3 REOPENED',
      '3 WAITING · PLAN',
    ]);
    expect(chapters.some((c) => c.label === 'CANARY')).toBe(false);
  });

  it('warms a persisting verification only the second time, when the work holds for Martin', () => {
    const verified = SAMPLES.filter((e) => e.work_item === '1306' && e.type === 'verification.finished').at(-1);
    const closed = SAMPLES.find((e) => e.work_item === '1306' && e.type === 'work-item.closed');
    const held = SAMPLES.flatMap((event): PublicEvent[] => {
      if (event === verified && event.type === 'verification.finished')
        return [{ ...event, payload: { ...event.payload, outcome: 'persists' } }];
      if (event === closed) {
        const payload = { stage: 'verify', kind: 'held', cause: 'verify', reason: 'It needs Martin' } as const;
        return [{ ...event, type: 'hold.started', payload } as PublicEvent];
      }
      return [event];
    });
    const s = projectSheet(project(held, Date.parse(closed?.ts ?? '')), '1306');
    expect(s?.chapters.filter((c) => c.label === 'PERSISTS').map((c) => c.tone)).toEqual(['signal', 'attn']);
    expect(s?.shipped[0]?.verification).toMatchObject({ outcome: 'persists', held: true, words: 'It needs Martin' });
  });

  it('ends a fix waiting for Martin’s deploy at the waiting ring, after its merge', () => {
    const chapters = sheet('1321')?.chapters ?? [];
    expect(chapters.slice(-2).map((c) => c.label)).toEqual(['MERGED', 'WAITING']);
    expect(chapters.at(-1)?.waiting).toBe(true);
  });

  it('says a return from Verify in the design’s words, on the line and in the events', () => {
    const view = project(SAMPLES, returned + 60_000);
    expect(view.returns.find((r) => r.item === '1306')).toMatchObject({
      text: '#1306 · persists · back to Plan',
      detail: 'persists',
    });
    expect(sheet('1306')?.chapters.find((c) => c.label === 'PLAN')?.text).toBe(
      'Persists · back to Plan, with the verification as evidence',
    );
  });

  it('carries a reopened ticket’s pill and version until it next closes', () => {
    const card = project(SAMPLES, END).cards.find((c) => c.number === '1306');
    expect(card?.reopened).toMatchObject({ sense: 'logs', route: '/basket', version: 'v0.9.12' });
    expect(project(SAMPLES, returned).cards.find((c) => c.number === '1306')?.reopened).toBeUndefined();
  });
});

describe('the scrubber', () => {
  /** The narrowest gap between two chapters' targets, in pixels, at every chapter chosen. */
  const narrowest = (chapters: Chapter[], width: number) =>
    Math.min(
      ...chapters.flatMap((_, at) => {
        const lefts = scrubbed(chapters, at, width).map((s) => (s.left / 100) * width);
        return lefts.slice(1).map((left, i) => left - (lefts[i] ?? 0));
      }),
    );

  it('keeps every chapter a target’s width from the next on a phone, for #1304 and #1306 (#210)', () => {
    for (const item of ['1302', '1304', '1306']) {
      expect(narrowest(sheet(item)?.chapters ?? [], 332)).toBeGreaterThanOrEqual(TARGET);
    }
  });

  it('counts the reviews of the pull request’s pass against the line’s limit for a pass, and names the pass (#280)', () => {
    // One review in each of two passes, and reopened since: the second pass's pull request has had one of its two.
    expect(sheet('1306')?.review).toHaveLength(2);
    expect(sheet('1306')?.facts.reviews).toEqual({ done: 1, of: 2, pass: 2 });
    // Back at Plan, before the second pass's push, the first pass's pull request is still the one beside them.
    expect(sheet('1306', returned)?.facts.reviews).toEqual({ done: 1, of: 2, pass: 1 });
    // Before it went back, there was one pass, and no pass to name.
    expect(sheet('1306', returned - 1)?.facts.reviews).toEqual({ done: 1, of: 2, pass: undefined });
  });

  it('draws the first pass and the chosen one in full, and folds the others to one chapter each', () => {
    const chapters = sheet('1306')?.chapters ?? [];
    const shown = scrubbed(chapters, chapters.length - 1, 874);
    expect(shown.filter((s) => s.pass).map((s) => s.pass)).toEqual([2]);
    // On a phone, the first pass folds too, so the targets keep apart.
    const phone = scrubbed(chapters, chapters.length - 1, 332);
    expect(phone.filter((s) => s.pass).map((s) => s.pass)).toEqual([1, 2]);
    // Past twelve, only the chosen chapter and the ends keep their labels: here, the last is the chosen one.
    expect(shown.length).toBeGreaterThan(12);
    expect(shown.flatMap((s, j) => (s.labelled ? [j] : []))).toEqual([0, shown.length - 1]);
  });

  it('spreads chapters by time, never closer than the gap, and evenly when the gap cannot be kept', () => {
    expect(spread([0, 0, 0, 100])).toEqual([0, 7.5, 15, 100]);
    expect(spread([0, 98, 99, 100])).toEqual([0, 85, 92.5, 100]);
    expect(spread(Array(21).fill(0))[1]).toBe(5);
    // A single chapter keeps its place in time.
    expect(spread([40])).toEqual([40]);
  });
});
