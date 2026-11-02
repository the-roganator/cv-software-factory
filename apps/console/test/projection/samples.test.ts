import { STAGES } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { project, projectSheet, upTo } from '../../web/src/projection/index.ts';
import { END, SAMPLES, work } from './support.ts';

const view = project(SAMPLES, END);
const card = (number: string) => view.cards.find((c) => c.number === number);

// Projecting the whole sample log at every one of its moments takes about a second here and several on a shared CI
// runner, past the default five.
const WHOLE_TIMELINE = 30_000;

describe('the samples, projected', () => {
  it('show every outcome', () => {
    expect(new Set(view.cards.map((c) => c.outcome))).toEqual(
      new Set([
        'verified',
        'rolled-back',
        'held',
        'closed',
        'no-ticket',
        'turned-off',
        'needs-you',
        'waiting',
        'waits-on-work',
        'deploying',
        'in-progress',
      ]),
    );
  });

  it('show every picture in the design system’s table', () => {
    // And none for #1308, the canary's ticket, whose rollback picture the console does not draw yet.
    expect(new Set(view.cards.map((c) => c.picture.type))).toEqual(
      new Set([
        ...['wipe', 'metric', 'logs', 'package', 'scan', 'rollback', 'refusal', 'judgement', 'spec', 'http'],
        ...['merge', 'deploy', 'scope', 'tests-pass', 'spend', 'blocking', 'suggestion', 'none'],
      ]),
    );
  });

  it('put every station in every state at some point, and send work back', { timeout: WHOLE_TIMELINE }, () => {
    const seen = new Set<string>();
    for (const event of SAMPLES) {
      const at = Date.parse(event.ts);
      for (const t of [at, at + 60_000]) for (const s of project(SAMPLES, t).stations) seen.add(s.status);
    }
    expect(seen).toEqual(new Set(['idle', 'working', 'returning', 'passing', 'blocked', 'failed']));
  });

  it('end with the line working: the reviewer has just sent a fix back, and the coder is at it', () => {
    expect(view.header).toMatchObject({ running: true, autonomy: 'guarded' });
    expect(card('1325')?.outcome).toBe('in-progress');
    expect(view.returns[0]).toMatchObject({
      item: '1325',
      from: 'review',
      to: 'build',
      text: '#1325 · round 3 · 1 blocking',
    });
  });

  it('keep what waits on Martin in the reel, held when a mechanism stopped it and waiting when the line asked', () => {
    expect(card('1300')?.outcome).toBe('needs-you');
    expect(card('1334')?.outcome).toBe('needs-you');
    expect(card('1274')?.outcome).toBe('held');
    const station = (stage: string) => view.stations.find((s) => s.stage === stage);
    expect(station('plan')).toMatchObject({ status: 'blocked', figure: '2 waiting' });
    // Build works on another item beside the two it holds: at work, with its beacon lit.
    expect(station('build')).toMatchObject({ status: 'working', beacon: 'needs-you', figure: '2 held' });
    expect(station('gates')).toMatchObject({ status: 'blocked', figure: '2 held' });
    expect(station('review')).toMatchObject({ status: 'blocked', figure: '2 waiting' });
  });

  it('say how far each item got, and where it stopped', () => {
    expect(card('1271')?.segments).toEqual(['skipped', 'skipped', ...Array(6).fill('passed')]);
    expect(card('1276')?.segments).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'passed',
      'passed',
      'stopped',
      'none',
    ]);
    expect(card('1274')?.segments).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'passed',
      'stopped',
      'none',
      'none',
      'none',
    ]);
    expect(card('1268')?.segments).toEqual(['passed', 'closed', ...Array(6).fill('none')]);
    expect(card('1300')?.segments).toEqual(['skipped', 'skipped', 'waiting', ...Array(5).fill('none')]);
    expect(card('1302')?.segments).toEqual(Array(8).fill('passed'));
    expect(card('1311')?.segments).toEqual([...Array(5).fill('passed'), 'waiting', 'none', 'none']);
    expect(card('1315')?.segments).toEqual([...Array(3).fill('passed'), 'stopped', ...Array(4).fill('none')]);
  });

  it('strike through a version that was rolled back, on the timeline', () => {
    expect(view.timeline.versions).toContainEqual(
      expect.objectContaining({ card: 5, version: 'v0.9.1', rolledBack: true }),
    );
    expect(view.timeline.days).toHaveLength(8);
  });

  it('say which work a visitor started, and nothing about the visitor', () => {
    const cards = project(SAMPLES, END).cards;
    expect(cards.filter((c) => c.byVisitor).map((c) => c.number)).toEqual([
      '1268',
      '1274',
      '1293',
      '1296',
      '1302',
      '1329',
    ]);
    expect(SAMPLES.some((e) => e.type === 'work-item.opened' && 'visitor' in e.payload)).toBe(false);
  });

  it('list a work item verified today in Verify’s panel as verified, the one place a row is `ok`', () => {
    const { rows } = project(SAMPLES, Date.parse('2026-09-29T08:54:10Z')).panels.verify;
    expect(rows).toMatchObject([{ item: '1262', note: 'verified', tone: 'ok', state: 'verified', left: true }]);
  });

  it('label every card a sample', () => {
    expect(view.sample).toBe(true);
    expect(view.cards.every((c) => c.sample)).toBe(true);
  });
});

describe('a sheet', () => {
  it('says when a sense saw the ticket’s problem again in a later version, such as another release rolled back', () => {
    const canary = projectSheet(project(SAMPLES, END), '1308')?.seenBy?.find((s) => s.sense === 'canary');
    expect(canary).toMatchObject({
      opened: true,
      again: { versions: ['efef168f4eec299dfc27c8fc78477ce28379b38d'], at: Date.parse('2026-10-05T17:43:40Z') },
    });
    // The log watcher saw #1306's error again in the release that reopened it.
    const logs = projectSheet(project(SAMPLES, END), '1306')?.seenBy?.find((s) => s.sense === 'logs');
    expect(logs?.again?.versions).toEqual(['v0.9.12']);
    // A sense seen in one version only says nothing more.
    expect(projectSheet(project(SAMPLES, END), '1302')?.seenBy?.every((s) => s.again === undefined)).toBe(true);
  });

  it('steps through the item’s story, from the injection to its verification', () => {
    const sheet = projectSheet(project(SAMPLES, END), '1302');
    expect(sheet?.chapters.map((c) => c.label)).toEqual([
      'INJECT',
      'ON SITE',
      'SIGNAL',
      'TICKET',
      'SPEC',
      'PR',
      'GATES',
      'SENT BACK',
      'TRY 2',
      'GATES',
      'REVIEW',
      'MERGED',
      'PROMOTED',
      'VERIFIED',
    ]);
    const positions = sheet?.chapters.map((c) => c.position) ?? [];
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions[0]).toBe(0);
    expect(positions.at(-1)).toBeCloseTo(100, 0);
  });

  it('ends at now while the item is still on the line', () => {
    expect(projectSheet(project(SAMPLES, END), '1325')?.chapters.at(-1)).toMatchObject({ label: 'NOW', position: 100 });
  });

  it('shows the site as it stood at each step', () => {
    const sheet = projectSheet(project(SAMPLES, END), '1296');
    const site = (label: string) => sheet?.chapters.find((c) => c.label === label)?.site?.side;
    expect(site('INJECT')).toBeUndefined();
    expect(site('ON SITE')).toBe('before');
    expect(site('SIGNAL')).toBe('broken');
    expect(site('VERIFIED')).toBe('fixed');
  });

  describe('the fix, from a verification laid out as the line lays it out', () => {
    // Each page on the version before and then on the canary (the hash the page names), then the ticket's own pages
    // after the rollout: 1296's verification, with its own page `/` intended, and pictures of both versions.
    const laidOut = (rollout: boolean) =>
      SAMPLES.map((event) => {
        if (event.work_item !== '1296' || event.type !== 'verification.finished') return event;
        const canary = event.artifacts.slice(1).flatMap((a) => (a.kind === 'screenshot' ? [a] : []));
        const pages = event.payload.pages.map((page) => ({ ...page, intended: page.route === '/' }));
        const before = (hash: string) => ({ hash: `b${hash.slice(1)}`, version: event.payload.against });
        const after = canary.find((a) => a.route === '/');
        return {
          ...event,
          payload: { ...event.payload, pages },
          artifacts: [
            ...pages.flatMap((page, i) => {
              const shot = canary[i];
              if (!shot || shot.hash !== page.screenshot) throw new Error('the samples’ pages and shots differ');
              return [
                {
                  ...shot,
                  ...before(shot.hash),
                  boxes: [{ x: 0, y: 0, width: 1, height: 1, kind: 'problem' as const }],
                },
                shot,
              ];
            }),
            ...(rollout && after ? [{ ...after, hash: 'f'.repeat(64) }] : []),
          ],
        };
      });
    const fixed = (events: typeof SAMPLES) => {
      const sheet = projectSheet(project(events, END), '1296');
      const verified = sheet?.chapters.find((c) => c.label === 'VERIFIED')?.site;
      const evidence = sheet?.captures.filter((c) => c.side === 'fixed');
      return { side: verified?.side, version: verified?.shot.version, hash: verified?.shot.hash, evidence };
    };

    it('shows the ticket’s own page after the rollout, when it was pictured again', () => {
      const shown = fixed(laidOut(true));
      expect(shown).toMatchObject({ side: 'fixed', version: 'v0.9.5', hash: 'f'.repeat(64) });
      expect(shown.evidence?.map((c) => c.shot.hash)).toEqual(['f'.repeat(64)]);
    });

    it('else shows the ticket’s own page on the canary, never the version before', () => {
      const events = laidOut(false);
      const own = events.find((e) => e.work_item === '1296' && e.type === 'verification.finished');
      const named = own?.type === 'verification.finished' ? own.payload.pages[0]?.screenshot : undefined;
      const shown = fixed(events);
      expect(shown).toMatchObject({ side: 'fixed', version: 'v0.9.5', hash: named });
      expect(shown.evidence?.map((c) => c.shot.hash)).toEqual([named]);
    });

    it('shows no fix when no page compared is the ticket’s own', () => {
      const events = laidOut(false).map((event) =>
        event.type === 'verification.finished'
          ? {
              ...event,
              payload: { ...event.payload, pages: event.payload.pages.map((p) => ({ ...p, intended: false })) },
            }
          : event,
      );
      expect(fixed(events)).toMatchObject({ side: 'canary', evidence: [] });
    });
  });

  it('draws a verification that found the problem still there as persisting, never warm the first time', () => {
    const chapter = (events: typeof SAMPLES, label: string) =>
      projectSheet(project(events, END), '1296')?.chapters.find((c) => c.label === label);
    expect(chapter(SAMPLES, 'VERIFIED')?.tone).toBe('ok');
    const persisted = SAMPLES.map((event) =>
      event.work_item === '1296' && event.type === 'verification.finished'
        ? { ...event, payload: { ...event.payload, outcome: 'persists' as const } }
        : event,
    );
    expect(chapter(persisted, 'PERSISTS')?.tone).toBe('signal');
    expect(chapter(persisted, 'REOPENED')).toBeUndefined();
  });

  it('opens a verified item again when its ticket reopens, back at Plan, waiting for the planner', () => {
    const later = work('1296', END);
    later.add(10, 'work-item.reopened', 'triage', {
      sense: 'probe',
      check: 'home journey',
      route: '/',
      version: 'v0.9.9',
      reason: 'The probes saw it again on / in version v0.9.9: home journey',
      dryRun: false,
    });
    const reopened = [...SAMPLES, ...later.events];
    const at = later.at(11);
    expect(projectSheet(project(SAMPLES, at), '1296')?.card).toMatchObject({ outcome: 'verified' });
    const sheet = projectSheet(project(reopened, at), '1296');
    expect(sheet?.card).toMatchObject({
      outcome: 'waiting',
      segments: ['passed', 'passed', 'queued', ...Array(5).fill('none')],
    });
    expect(sheet?.chapters.find((c) => c.label === 'REOPENED')).toMatchObject({ tone: 'attn' });
    // Nothing of the closed pass's release says it is live or verified.
    expect(sheet?.card.versions).toMatchObject({ from: undefined, to: undefined, rolledBack: false });
    expect(sheet?.chapters.map((c) => c.label).slice(-2)).toEqual(['REOPENED', 'WAITING · PLAN']);
  });

  it('totals each agent’s calls, tokens and cost', () => {
    const sheet = projectSheet(project(SAMPLES, END), '1296');
    expect(sheet?.agents.map((a) => a.agent)).toEqual(['planner', 'coder', 'reviewer']);
    const total = sheet?.agents.reduce((sum, a) => sum + a.cost, 0) ?? 0;
    expect(total).toBeCloseTo(sheet?.card.spend ?? 0, 6);
    expect(sheet?.facts).toEqual({
      foundBy: 'Probe · home journey',
      humanLines: 0,
      reviews: { done: 1, of: 2 },
      ticket: { category: 'functional', severity: 'broken', fingerprint: '/ · wrong-result' },
    });
  });

  it('lists the gates of the latest attempt', () => {
    const gates = projectSheet(project(SAMPLES, END), '1302')?.gates ?? [];
    expect(gates).toHaveLength(12);
    expect(gates.every((g) => g.conclusion === 'success')).toBe(true);
  });

  it('withholds a visitor’s report, saying where it came from', () => {
    expect(projectSheet(project(SAMPLES, END), '1268')?.report).toEqual({
      page: '/contact',
      quarantined: false,
      by: 'visitor',
      times: 1,
      texts: [],
    });
  });

  it('compares every page with the version before, the intended one first', () => {
    const verification = projectSheet(project(SAMPLES, END), '1304')?.shipped[0]?.verification;
    expect(verification?.against).toBe('v0.9.7');
    expect(verification?.pages[0]).toMatchObject({ page: 'Contact', intended: true });
    expect(verification?.pages.find((p) => p.page === 'Home')).toMatchObject({ changed: 0, intended: false });
  });

  it('shows each page as the verification took it, though a later one took the same picture', () => {
    // #1306's pages are the same to the pixel on v0.9.8 and v0.9.10: one picture, one hash, in both verifications.
    const versions = projectSheet(project(SAMPLES, END), '1306')?.shipped.flatMap((s) =>
      s.verification ? [[s.release.version, s.verification.pages.map((p) => p.screenshot?.version)]] : [],
    );
    expect(versions).toEqual([
      ['v0.9.10', ['v0.9.10', 'v0.9.10', 'v0.9.10', 'v0.9.10']],
      ['v0.9.8', ['v0.9.8', 'v0.9.8', 'v0.9.8', 'v0.9.8']],
    ]);
  });

  it('names the other work item the release carried on a page that is its own, before the pages the same', () => {
    const shared = projectSheet(project(SAMPLES, END), '1306')?.shipped.find((s) => s.release.version === 'v0.9.8');
    expect(shared?.verification?.pages.map((p) => [p.page, p.intended, p.intendedFor])).toEqual([
      ['Contact', false, '1304'],
      ['Home', false, undefined],
      ['Products', false, undefined],
      ['Search', false, undefined],
    ]);
  });
});

describe('replay', () => {
  // A seeded sequence, so a failure can be reproduced.
  function* times(count: number) {
    let state = 1_296;
    const first = Date.parse(SAMPLES[0]?.ts ?? '');
    for (let i = 0; i < count; i++) {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      yield first + (state / 2_147_483_648) * (END - first + 3_600_000);
    }
  }
  const instants = [...SAMPLES.map((event) => Date.parse(event.ts)), ...times(40)];

  it('draws the same view at t from every event as from only the events up to t', { timeout: WHOLE_TIMELINE }, () => {
    for (const t of instants) expect(project(SAMPLES, t)).toEqual(project(upTo(SAMPLES, t), t));
  });

  it('draws the same sheet at t, the same way', () => {
    for (const t of instants.filter((_, i) => i % 7 === 0)) {
      for (const number of ['1271', '1296', '1302', '1304', '1311', '1315', '1319', '1323']) {
        expect(projectSheet(project(SAMPLES, t), number)).toEqual(projectSheet(project(upTo(SAMPLES, t), t), number));
      }
    }
  });

  it('shows nothing of a work item before it opened', () => {
    const before1302 = Date.parse('2026-10-03T09:11:00Z');
    expect(projectSheet(project(SAMPLES, before1302), '1302')).toBeUndefined();
    expect(project(SAMPLES, before1302).cards.map((c) => c.number)).not.toContain('1302');
    expect(STAGES).toHaveLength(8);
  });
});
