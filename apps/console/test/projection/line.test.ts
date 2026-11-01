import { HOLD_CAUSES, type PayloadOf, type PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { project } from '../../web/src/projection/index.ts';
import { PASSING_MS, RETURNING_MS, whileSending } from '../../web/src/projection/line.ts';
import { payloads, work } from './support.ts';

const gatesStatus = (events: PublicEvent[], t: number) =>
  project(events, t).stations.find((s) => s.stage === 'gates')?.status;

// The design system's six rules for a station's state, one case each, in order of precedence.
describe('a station’s state', () => {
  const at = work('1').at;

  it.each([
    [
      'failed: an item failed in the stage and nothing has happened since',
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesFailed).events,
      at(4),
      'failed',
    ],
    [
      'blocked: an item waits on a human',
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
        .add(3.1, 'hold.started', 'factory', { stage: 'gates', kind: 'held', cause: 'gates', reason: 'Tests removed' })
        .events,
      at(4),
      'blocked',
    ],
    [
      'returning: an item was sent upstream in the last few minutes',
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
        .add(3.5, 'work.returned', 'factory', { from: 'gates', to: 'build', reason: 'A check failed' }).events,
      at(3.5) + RETURNING_MS - 1000,
      'returning',
    ],
    [
      'working: an item is in progress in the stage',
      work('1').open().add(1, 'gates.started', 'actions', payloads.gatesStarted).events,
      at(2),
      'working',
    ],
    [
      'passing: the most recent item left the stage, and nothing is in progress',
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesPassed)
        .add(4, 'review.submitted', 'reviewer', { pullRequest: 7, verdict: 'approved', note: 'Fine', findings: [] })
        .events,
      at(4) + PASSING_MS - 1000,
      'passing',
    ],
    [
      'idle: otherwise',
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesPassed)
        .add(4, 'review.submitted', 'reviewer', { pullRequest: 7, verdict: 'approved', note: 'Fine', findings: [] })
        .events,
      at(4) + PASSING_MS + 1000,
      'idle',
    ],
  ])('%s', (_rule, events, t, status) => {
    expect(gatesStatus(events, t)).toBe(status);
  });

  // Work item 1 stops at Gates while work item 2 runs there: the station stays at work, and its beacon is lit.
  describe('with another item in progress beside one that', () => {
    const running = work('2').open().add(2, 'gates.started', 'actions', payloads.gatesStarted).events;
    const failing = work('1')
      .open()
      .add(1, 'gates.started', 'actions', payloads.gatesStarted)
      .add(3, 'gates.finished', 'actions', payloads.gatesFailed);
    const gates = (events: PublicEvent[], t: number) =>
      project(
        [...events, ...running].sort((a, b) => a.ts.localeCompare(b.ts)),
        t,
      ).stations.find((s) => s.stage === 'gates');
    const held = () =>
      work('1')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
        .add(3.1, 'hold.started', 'factory', { stage: 'gates', kind: 'held', cause: 'gates', reason: 'Tests removed' });

    it('failed, works on with a failed beacon', () => {
      expect(gates(failing.events, at(4))).toMatchObject({ status: 'working', beacon: 'failed', figure: '2 PRs' });
    });

    it('waits on a human, works on with a needs-you beacon, and counts what is held', () => {
      expect(gates(held().events, at(4))).toMatchObject({ status: 'working', beacon: 'needs-you', figure: '1 held' });
    });

    it('waits on a human, keeps its beacon while it sends a third back', () => {
      const sent = work('3')
        .open()
        .add(1, 'gates.started', 'actions', payloads.gatesStarted)
        .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
        .add(3.5, 'work.returned', 'factory', { from: 'gates', to: 'build', reason: 'A check failed' }).events;
      expect(gates([...held().events, ...sent], at(4))).toMatchObject({ status: 'returning', beacon: 'needs-you' });
    });

    it('waits on a human, is blocked with no beacon under Stop the line', () => {
      const stop = {
        ...(held().events[0] as PublicEvent),
        ts: new Date(at(3.5)).toISOString(),
        work_item: null,
        type: 'line.stopped',
        payload: { reason: 'Martin stopped the line' },
      } as PublicEvent;
      expect(gates([...held().events, stop], at(4))).toMatchObject({ status: 'blocked', beacon: undefined });
    });
  });

  it('lights no beacon on a station with nothing waiting on anyone', () => {
    const station = project(
      work('1').open().add(1, 'gates.started', 'actions', payloads.gatesStarted).events,
      at(2),
    ).stations.find((s) => s.stage === 'gates');
    expect(station).toMatchObject({ status: 'working', beacon: undefined });
  });

  it('is blocked everywhere under Stop the line', () => {
    const line: PublicEvent = {
      ...(work('1').open().events[0] as PublicEvent),
      work_item: null,
      type: 'line.stopped',
      payload: { reason: 'Martin stopped the line' },
    } as PublicEvent;
    const view = project([line], Date.now());
    expect(view.stations.every((s) => s.status === 'blocked')).toBe(true);
    expect(view.header).toMatchObject({ running: false, stopped: 'Martin stopped the line' });
  });

  it('reads the autonomy level from Martin’s controls, Supervised until he sets one, whatever a start names', () => {
    const line = (type: 'line.started' | 'line.stopped' | 'controls.changed', payload: object, actor = 'martin') =>
      ({ ...(work('1').open().events[0] as PublicEvent), work_item: null, type, actor, payload }) as PublicEvent;
    const controls = (autonomy: string) => ({
      autonomy,
      newWork: true,
      autoMerge: false,
      take: null,
      change: { control: 'autonomy', before: 'supervised', after: autonomy },
    });
    const started = line('line.started', { autonomy: 'guarded' });
    expect(project([started], Date.now()).header).toMatchObject({ running: true, autonomy: 'supervised' });
    const view = project(
      [
        started,
        line('controls.changed', controls('lights-out')),
        line('line.stopped', { reason: 'Lunch' }),
        line('line.started', { reason: 'Back' }),
      ],
      Date.now(),
    );
    expect(view.header).toMatchObject({ running: true, autonomy: 'lights-out', stopped: undefined });
    // Outside policy, or not Martin's, it is not in force.
    expect(project([started, line('controls.changed', controls('yolo'))], Date.now()).header.autonomy).toBe(
      'supervised',
    );
    expect(
      project([started, line('controls.changed', controls('guarded'), 'factory')], Date.now()).header.autonomy,
    ).toBe('supervised');
  });

  it('says “sending back” while its return is drawn, unless it has failed or waits on a human', () => {
    for (const status of ['idle', 'working', 'passing', 'returning'] as const) {
      expect(whileSending(status, true)).toBe('returning');
    }
    expect(whileSending('failed', true)).toBe('failed');
    expect(whileSending('blocked', true)).toBe('blocked');
    expect(whileSending('working', false)).toBe('working');
  });

  it('stops saying “sending back” once the return is a few minutes old', () => {
    const events = work('1')
      .open()
      .add(1, 'gates.started', 'actions', payloads.gatesStarted)
      .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
      .add(3.5, 'work.returned', 'factory', { from: 'gates', to: 'build', reason: 'A check failed' }).events;
    expect(gatesStatus(events, at(3.5) + RETURNING_MS + 1000)).toBe('idle');
    expect(project(events, at(4)).stations.find((s) => s.stage === 'build')?.status).toBe('working');
  });
});

describe('a station’s figure', () => {
  it('counts what is in the stage, and what left it today when nothing is', () => {
    const one = work('1').open().add(1, 'gates.started', 'actions', payloads.gatesStarted);
    expect(project(one.events, one.at(2)).stations.find((s) => s.stage === 'gates')?.figure).toBe('1 PR');
    one.add(3, 'gates.finished', 'actions', payloads.gatesPassed).add(4, 'review.submitted', 'reviewer', {
      pullRequest: 7,
      verdict: 'approved',
      note: 'Fine',
      findings: [],
    });
    expect(project(one.events, one.at(5)).stations.find((s) => s.stage === 'gates')?.figure).toBe('1 today');
    expect(project(one.events, one.at(5)).panels.gates.rows).toMatchObject([
      { item: '1', note: 'passed on to review', state: 'passed', left: true },
    ]);
  });

  it('gives a canary’s share of traffic at Release', () => {
    const one = work('1')
      .open()
      .add(1, 'release.started', 'rollouts', {
        release: '7c9d5f8b6d',
        version: 'v1.0.1',
        previous: 'v1.0.0',
        image: { digest: `sha256:${'b'.repeat(64)}`, signed: true, admitted: true },
        watched: true,
        steps: null,
        dryRun: false,
      })
      .add(2, 'canary.stepped', 'rollouts', {
        release: '7c9d5f8b6d',
        version: 'v1.0.1',
        weight: 25,
        analysis: { phase: 'successful', requests: 225, measures: [] },
        dryRun: false,
      });
    expect(project(one.events, one.at(3)).stations.find((s) => s.stage === 'release')?.figure).toBe('25%');
    // The end of an older release, after a newer one started, says nothing of the newer.
    const late = one.add(4, 'release.rolled-back', 'rollouts', {
      release: '4b5c6d7f8g',
      version: 'v1.0.0',
      restored: 'v0.9.9',
      weight: 25,
      reason: 'An older release',
      failed: [],
      dryRun: false,
      by: 'analysis',
    });
    const release = project(late.events, late.at(5)).stations.find((s) => s.stage === 'release');
    expect(release).toMatchObject({ figure: '25%' });
    expect(release?.status).not.toBe('failed');
  });
});

describe('a promoted release', () => {
  const RELEASE = '7c9d5f8b6d';
  /** Merged at minute 1, released at 2, promoted at 4: the line moves it to Verify then, and a sense looks later. */
  const promoted = () =>
    work('1')
      .open()
      .add(1, 'pull-request.merged', 'factory', { number: 7, commit: 'c'.repeat(40), by: 'martin' })
      .add(2, 'release.started', 'rollouts', {
        release: RELEASE,
        version: 'v1.0.1',
        previous: 'v1.0.0',
        image: { digest: `sha256:${'b'.repeat(64)}`, signed: true, admitted: true },
        watched: true,
        steps: null,
        dryRun: false,
      })
      .add(4, 'release.promoted', 'rollouts', {
        release: RELEASE,
        version: 'v1.0.1',
        previous: 'v1.0.0',
        watched: true,
        dryRun: false,
      });
  const stationAt = (events: PublicEvent[], t: number, stage: 'release' | 'verify') =>
    project(events, t).stations.find((s) => s.stage === stage);

  // A sense can take a while to look: the log watcher waits out a window of half an hour.
  it('puts the work it carries at Verify while the sense looks, and Release has nothing in hand', () => {
    const item = promoted();
    const t = item.at(4) + PASSING_MS + 60_000;
    const view = project(item.events, t);
    // The panel still draws the promoted release in full: it stays until the next starts.
    expect(view.canary).toMatchObject({ state: 'shown', release: { end: { kind: 'promoted' } } });
    expect(stationAt(item.events, t, 'release')).toMatchObject({ status: 'idle', figure: '1 today' });
    expect(view.panels.release.rows).toMatchObject([{ item: '1', note: 'passed on to verify', state: 'passed' }]);
    expect(stationAt(item.events, t, 'verify')).toMatchObject({ status: 'working', figure: '1 check' });
    expect(view.panels.verify.rows).toMatchObject([{ item: '1', note: 'Promoted · verifying', state: 'in-hand' }]);
  });

  it('leaves the work at Release while the canary is in flight, and at Verify once a sense has looked', () => {
    const item = promoted();
    expect(project(item.events, item.at(3)).panels.release.rows).toMatchObject([{ item: '1', state: 'in-hand' }]);
    item.add(40, 'verification.finished', 'factory', {
      outcome: 'cleared',
      sense: 'logs',
      check: 'server-error on /',
      version: 'v1.0.1',
      against: 'v1.0.0',
      pages: [],
      dryRun: false,
    });
    expect(project(item.events, item.at(41)).panels.verify.rows).toMatchObject([
      { item: '1', note: 'verification.finished', state: 'in-hand' },
    ]);
  });

  it.each([
    ['a dry run’s', { dryRun: true, watched: true }, 'Promoted in a dry run · verifying'],
    ['a release found live', { dryRun: false, watched: false }, 'Found live · verifying'],
  ])('says so at Verify for %s', (_, flags, note) => {
    const item = promoted();
    const last = item.events.at(-1) as PublicEvent<'release.promoted'>;
    last.payload = { ...last.payload, ...flags };
    expect(project(item.events, item.at(5)).panels.verify.rows).toMatchObject([{ item: '1', note }]);
  });
});

describe('a return', () => {
  const PUSHED = {
    number: 7,
    title: 'fix: the products journey',
    branch: 'factory/1-products',
    attempt: 2,
    testsFirst: false,
    files: [],
    whole: [],
  } satisfies PayloadOf<'pull-request.pushed'>;
  /** Sent back by the gates at minute 3.5, then pushed again at Build at minute 5. */
  const sentBack = () =>
    work('1')
      .open()
      .add(1, 'gates.started', 'actions', payloads.gatesStarted)
      .add(3, 'gates.finished', 'actions', payloads.gatesFailed)
      .add(3.5, 'work.returned', 'factory', { from: 'gates', to: 'build', round: 2, reason: 'A check failed' })
      .add(5, 'pull-request.pushed', 'coder', PUSHED);
  const drawn = (events: PublicEvent[], t: number) => project(events, t).returns.map((r) => r.item);

  it('is drawn while its work item is still in the stage it was sent to', () => {
    const item = sentBack();
    expect(drawn(item.events, item.at(6))).toEqual(['1']);
    expect(drawn(item.events, item.at(600))).toEqual(['1']);
  });

  it.each([
    ['its next stage', (w: ReturnType<typeof sentBack>) => w.add(7, 'gates.started', 'actions', payloads.gatesStarted)],
    [
      'a hold',
      (w: ReturnType<typeof sentBack>) =>
        w.add(7, 'hold.started', 'factory', { stage: 'build', kind: 'held', cause: 'scope', reason: 'Out of scope' }),
    ],
    [
      'its close',
      (w: ReturnType<typeof sentBack>) =>
        w.add(7, 'work-item.closed', 'factory', { outcome: 'no-change', reason: 'Done' }),
    ],
  ])('is no longer drawn once its work item moves on: %s', (_, next) => {
    const item = next(sentBack());
    expect(drawn(item.events, item.at(6.9))).toEqual(['1']);
    expect(drawn(item.events, item.at(8))).toEqual([]);
  });

  it('stays a row in its sender’s panel, struck through once the work item is back in the stage', () => {
    const item = sentBack();
    expect(project(item.events, item.at(6)).panels.gates.rows).toMatchObject([
      {
        item: '1',
        note: 'Sent back to Build · round 2 · sent back from gates',
        earlier: [],
        state: 'sent-back',
        left: true,
      },
    ]);
    item.add(7, 'gates.started', 'actions', payloads.gatesStarted);
    // Back in the stage, it takes its state now; the earlier one is in its note.
    const [row] = project(item.events, item.at(8)).panels.gates.rows;
    expect(row).toMatchObject({ item: '1', note: 'gates.started', earlier: ['sent back'], state: 'in-hand' });
    expect(row?.left).toBeUndefined();
  });

  it('is not its sender’s row once the work item has passed the stage and gone upstream from a later one', () => {
    const item = sentBack()
      .add(7, 'gates.started', 'actions', payloads.gatesStarted)
      .add(8, 'gates.finished', 'actions', payloads.gatesPassed)
      .add(9, 'review.submitted', 'reviewer', {
        pullRequest: 7,
        verdict: 'changes-requested',
        note: 'No',
        findings: [],
      })
      .add(10, 'work.returned', 'factory', { from: 'review', to: 'build', round: 3, reason: 'Changes asked' });
    expect(project(item.events, item.at(11)).panels.gates.rows).toEqual([]);
  });
});

describe('a stage panel', () => {
  const ticket = (number: string, minute: number) =>
    work(number)
      .open()
      .add(minute, 'ticket.opened', 'triage', {
        title: `Ticket ${number}`,
        category: 'functional',
        severity: 'broken',
        fingerprint: { route: '/products', class: 'wrong-result' },
        traces: [],
      });
  const planned = (number: string, minute: number) =>
    ticket(number, 0).add(minute, 'model.called', 'planner', {
      agent: 'planner',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      settings: {},
      tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.01,
      durationMs: 4000,
      calls: 1,
    });

  it('lists what the station is working on first, then what is held, then what waits, each newest first', () => {
    const events = [
      // The line takes the oldest ticket, so the one in hand is older than those waiting behind it.
      ...planned('1', 5).events,
      ...planned('5', 4).events,
      ...planned('2', 2).add(3, 'hold.started', 'factory', {
        stage: 'plan',
        kind: 'held',
        cause: 'spec',
        reason: 'The spec has no criteria',
      }).events,
      ...ticket('3', 1).events,
      ...ticket('4', 1).events,
    ];
    const { rows } = project(events, work('1').at(6)).panels.plan;
    expect(rows.map((r) => [r.item, r.tone, r.state, r.working])).toEqual([
      ['5', 'signal', 'in-hand', true],
      ['1', 'signal', 'in-hand', true],
      ['2', 'attn', 'held', undefined],
      ['4', 'faint', 'waiting', undefined],
      ['3', 'faint', 'waiting', undefined],
    ]);
    expect(rows[3]?.note).toBe('Waiting for the planner');
  });

  // Merge's and deploy's waits keep notes of their own, which say more; a canary's hold holds only with its release
  // in flight.
  const labelled = HOLD_CAUSES.filter((cause) => !['merge', 'deploy', 'canary'].includes(cause));
  const reason = 'I can’t find a defect in this repo that would explain it: no test would fail at this commit.';

  it.each(labelled)('notes a %s hold in its card’s words, never the agent’s own', (cause) => {
    const item = ticket('1', 0).add(1, 'hold.started', 'factory', { stage: 'plan', kind: 'held', cause, reason });
    const note = project(item.events, item.at(2)).panels.plan.rows[0]?.note;
    expect(note).toMatch(/^Needs you · /);
    expect(note).not.toContain('defect');
    expect(note?.length).toBeLessThanOrEqual(40);
  });

  it.each([
    ['ticket-rejected', 'plan', 'Needs you · the planner turned it down'],
    ['gates', 'gates', 'Needs you · held by a gate'],
    ['verify', 'verify', 'Needs you · Verify asks you'],
    ['question', 'build', 'Needs you · the coder asks'],
  ] as const)('notes a %s hold as “%s”', (cause, stage, note) => {
    const item = ticket('1', 0).add(1, 'hold.started', 'factory', { stage, kind: 'held', cause, reason });
    expect(project(item.events, item.at(2)).panels[stage].rows[0]?.note).toBe(note);
  });

  it('lists a work item closed at Verify with no change as passed, not verified', () => {
    const item = work('1')
      .open()
      .add(1, 'hold.started', 'factory', { stage: 'verify', kind: 'approval', cause: 'verify', reason: 'V' })
      .add(2, 'work-item.closed', 'factory', { outcome: 'no-change', reason: 'Martin closed it' });
    expect(project(item.events, item.at(3)).panels.verify.rows).toMatchObject([
      { item: '1', note: 'closed, no change', tone: 'faint', state: 'passed', left: true },
    ]);
  });

  it('marks nothing as working under Stop the line, when the station says it is blocked', () => {
    const item = planned('1', 5);
    const stop = {
      ...(item.events[0] as PublicEvent),
      id: 'stop',
      ts: new Date(item.at(5.5)).toISOString(),
      work_item: null,
      type: 'line.stopped',
      payload: { reason: 'Martin stopped the line' },
    } as PublicEvent;
    const view = project([...item.events, stop], item.at(6));
    expect(view.stations.find((s) => s.stage === 'plan')?.status).toBe('blocked');
    // Still the work in hand, and first, but not marked as at work.
    expect(view.panels.plan.rows.map((r) => [r.item, r.tone, r.working])).toEqual([['1', 'signal', undefined]]);
  });
});
