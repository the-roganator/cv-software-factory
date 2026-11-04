import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { ATTACK_RULES, attackLimitMs, expectedRefusals } from '../../../../policy/attacks.ts';
import type { Attempt, AttemptResult } from '../../src/red-team/worker.ts';
import { RedTeam } from '../../src/red-team/worker.ts';
import { fakeEvents, fakeSql, never, silent } from './fakes.ts';

const LAUNCH = { seq: '10', work_item: '1274', attack: 'report', at: new Date('2026-11-03T12:00:00Z') };

/** A store that offers one launch of `attack` taken at `at`, and then none (the harness finished it). */
function storeWith(attack: string, at: Date) {
  let gave = false;
  return fakeSql((query, params) => {
    if (query.includes('attack.launched') && !gave) {
      gave = true;
      // Real launches of Martin's roles alone: a sample's is no attack to make, and row security is not the only lock.
      expect(query).toContain('not l.sample');
      expect(query).toContain('l.appended_by = any(');
      expect(params.length).toBeGreaterThan(0);
      return [{ seq: '10', work_item: '1274', attack, at }];
    }
    return [];
  });
}

const refusedResult: AttemptResult = {
  outcome: 'refused',
  refusals: [42],
  attempts: [{ what: 'sent a report', result: 'quarantined', refused: true }],
  subject: { report: 'a-report-id' },
  reason: 'quarantined',
};

describe('the red-team worker', () => {
  it('runs the attack’s attempt and ends its work item with attack.finished and work-item.closed', async () => {
    const events = fakeEvents();
    let seen: { workItem: string } | undefined;
    const report: Attempt = async (ctx) => {
      seen = { workItem: ctx.workItem };
      return refusedResult;
    };
    const harness = new RedTeam({
      sql: storeWith('report', LAUNCH.at),
      events,
      attempts: { report, egress: report, image: report, workflow: report, test: report },
      log: silent,
      now: () => new Date(LAUNCH.at.getTime() + 60_000),
    });
    await harness.once(never);
    expect(seen?.workItem).toBe('1274');
    expect(events.appended.map((e) => e.type)).toEqual(['attack.finished', 'work-item.closed']);
    const finished = events.appended[0]?.payload as PayloadOf<'attack.finished'>;
    expect(finished.attack).toBe('report');
    expect(finished.outcome).toBe('refused');
    expect(finished.expected).toEqual(expectedRefusals('report'));
    expect(finished.refusals).toEqual([42]);
    expect(finished.subject).toEqual({ report: 'a-report-id' });
    const closed = events.appended[1]?.payload as PayloadOf<'work-item.closed'>;
    expect(closed.outcome).toBe('refused');
  });

  it('records a launch past its limit as unfinished, without making the attack', async () => {
    const events = fakeEvents();
    let made = false;
    const report: Attempt = async () => {
      made = true;
      return refusedResult;
    };
    const old = new Date(LAUNCH.at.getTime() - attackLimitMs('report') - 60_000);
    const harness = new RedTeam({
      sql: storeWith('report', old),
      events,
      attempts: { report, egress: report, image: report, workflow: report, test: report },
      log: silent,
      now: () => LAUNCH.at,
    });
    await harness.once(never);
    expect(made).toBe(false);
    expect((events.appended[0]?.payload as PayloadOf<'attack.finished'> | undefined)?.outcome).toBe('unfinished');
  });

  it('skips an unknown attack: it cannot be put in attack.finished, so the line pages it unfinished', async () => {
    const events = fakeEvents();
    const report: Attempt = async () => refusedResult;
    const harness = new RedTeam({
      sql: storeWith('bogus', LAUNCH.at),
      events,
      attempts: { report, egress: report, image: report, workflow: report, test: report },
      log: silent,
      now: () => new Date(LAUNCH.at.getTime() + 60_000),
    });
    await harness.once(never);
    expect(events.appended).toEqual([]);
  });

  it('ends a launch unfinished when the attempt throws, so it is never made twice', async () => {
    const events = fakeEvents();
    const throwing: Attempt = async () => {
      throw new Error('the door was unreachable');
    };
    const harness = new RedTeam({
      sql: storeWith('test', LAUNCH.at),
      events,
      attempts: { report: throwing, egress: throwing, image: throwing, workflow: throwing, test: throwing },
      log: silent,
      now: () => new Date(LAUNCH.at.getTime() + 60_000),
    });
    await harness.once(never);
    expect(events.appended.map((e) => e.type)).toEqual(['attack.finished', 'work-item.closed']);
    const finished = events.appended[0]?.payload as PayloadOf<'attack.finished'> | undefined;
    expect(finished?.outcome).toBe('unfinished');
    // No attempt: to the line an attempt not refused got through, and nothing did.
    expect(finished?.attempts).toEqual([]);
  });

  it('leaves a launch as it is when stopped while the attempt waited, rather than end it unfinished', async () => {
    const events = fakeEvents();
    const stopping = new AbortController();
    const report: Attempt = async (ctx) => {
      stopping.abort();
      // A wait that gave up on the stop signal looks like a limit passed; the worker must tell the two apart.
      expect(ctx.signal.aborted).toBe(true);
      return { outcome: 'unfinished', refusals: [], attempts: [], reason: 'the wait gave up' };
    };
    const harness = new RedTeam({
      sql: storeWith('report', LAUNCH.at),
      events,
      attempts: { report, egress: report, image: report, workflow: report, test: report },
      log: silent,
      now: () => new Date(LAUNCH.at.getTime() + 60_000),
    });
    await harness.once(stopping.signal);
    expect(events.appended).toEqual([]);
  });

  it('knows an attempt for every attack in the catalogue', () => {
    // A guard that the command wires an attempt for each attack the catalogue names.
    expect(Object.keys(ATTACK_RULES).sort()).toEqual(['egress', 'image', 'report', 'test', 'workflow']);
  });
});
