/**
 * Martin's controls of the line, within policy (`policy/line.ts`): what is in force from whatever an event says, and
 * which of the access table's actions each change is.
 */
import { describe, expect, it } from 'vitest';
import { ACCESS } from '../../../../policy/access.ts';
import {
  type ControlChange,
  controlAction,
  controlsInForce,
  DEFAULT_CONTROLS,
  TAKE,
  type Take,
  takeSet,
} from '../../../../policy/line.ts';
import { takesOf } from '../../src/line/queue.ts';

const SINCE = '2026-10-24T09:00:00.000Z';
const every: Take = { kind: 'every' };
const next = (count: number): Take => ({ kind: 'next-few', count, since: SINCE });
const one = (workItem: string): Take => ({ kind: 'just-one', workItem });

describe('the controls in force', () => {
  it('are policy’s defaults before Martin sets any: Supervised, new work, no auto-merge, every ticket, and auto-rollback', () => {
    expect(controlsInForce()).toEqual({ ...DEFAULT_CONTROLS, outside: [] });
    expect(DEFAULT_CONTROLS).toEqual({
      autonomy: 'supervised',
      newWork: true,
      autoMerge: false,
      take: { kind: 'every' },
      autoRollback: true,
    });
  });

  it('take every ticket with no take set, from an event that sets none', () => {
    const chosen = { autonomy: 'guarded', newWork: false, autoMerge: true, take: null, autoRollback: false };
    expect(controlsInForce(chosen)).toEqual({ ...chosen, take: every, outside: [] });
    expect(takeSet(chosen)).toBe(false);
    expect(takeSet(undefined)).toBe(false);
    expect(takeSet({ ...chosen, take: next(50) })).toBe(false);
    expect(takeSet({ ...chosen, take: every })).toBe(true);
    expect(takeSet({ ...chosen, take: one('1290') })).toBe(true);
  });

  it('are what the latest event says, within policy', () => {
    const chosen = { autonomy: 'guarded', newWork: false, autoMerge: true, take: next(3), autoRollback: false };
    expect(controlsInForce(chosen)).toEqual({ ...chosen, outside: [] });
    expect(controlsInForce({ ...chosen, take: one('1290') }).take).toEqual(one('1290'));
    expect(controlsInForce({ ...chosen, take: next(TAKE.most) }).take).toEqual(next(TAKE.most));
  });

  it('leave out anything outside policy, field by field, for policy’s default', () => {
    const chosen = { autonomy: 'guarded', newWork: false, autoMerge: true, autoRollback: false };
    for (const take of [
      next(0),
      next(TAKE.most + 1),
      next(2.5),
      { kind: 'next-few', count: 3 },
      { kind: 'next-few', count: 3, since: 'yesterday' },
      one('0'),
      one('12a'),
      { kind: 'all' },
      'every',
    ]) {
      expect(controlsInForce({ ...chosen, take }), JSON.stringify(take)).toEqual({
        ...chosen,
        take: every,
        outside: ['take'],
      });
    }
    expect(controlsInForce({ autonomy: 'yolo', newWork: 'yes', autoMerge: 1, take: null, autoRollback: 0 })).toEqual({
      ...DEFAULT_CONTROLS,
      outside: ['autonomy', 'newWork', 'autoMerge', 'autoRollback'],
    });
    // Auto-rollback outside policy, or not said, is on: a bad canary rolls back.
    expect(controlsInForce({ ...chosen, take: null, autoRollback: 'off' }).autoRollback).toBe(true);
    expect(controlsInForce({ autonomy: 'guarded', newWork: true, autoMerge: false, take: null }).autoRollback).toBe(
      true,
    );
    expect(controlsInForce('guarded')).toEqual({ ...DEFAULT_CONTROLS, outside: [] });
  });
});

describe('what the line takes', () => {
  it('is Martin’s take in force', () => {
    expect(takesOf(every)).toEqual({ only: null, take: null });
    expect(takesOf(next(3))).toEqual({ only: null, take: { most: 3, since: SINCE } });
    expect(takesOf(one('1290'))).toEqual({ only: '1290', take: null });
    expect(takesOf(controlsInForce().take)).toEqual({ only: null, take: null });
  });
});

describe('each change', () => {
  const change = (control: ControlChange['control'], before: unknown, after: unknown) =>
    controlAction({ control, before, after } as ControlChange);

  it('loosens autonomy towards Lights-out, and tightens it towards Supervised', () => {
    expect(change('autonomy', 'supervised', 'guarded')).toBe('autonomy.loosen');
    expect(change('autonomy', 'supervised', 'lights-out')).toBe('autonomy.loosen');
    expect(change('autonomy', 'lights-out', 'guarded')).toBe('autonomy.tighten');
    expect(change('autonomy', 'guarded', 'supervised')).toBe('autonomy.tighten');
  });

  it('turns each switch on or off', () => {
    expect(change('new-work', true, false)).toBe('new-work.off');
    expect(change('new-work', false, true)).toBe('new-work.on');
    expect(change('auto-merge', false, true)).toBe('auto-merge.on');
    expect(change('auto-merge', true, false)).toBe('auto-merge.off');
    // Auto-rollback off overrides a guardrail, so it loosens, and needs the passkey again; on asks for nothing.
    expect(change('auto-rollback', true, false)).toBe('auto-rollback.off');
    expect(change('auto-rollback', false, true)).toBe('auto-rollback.on');
    expect(ACCESS['auto-rollback.off'].stepUp).toBe(true);
    expect(ACCESS['auto-rollback.on'].stepUp).toBe(false);
  });

  it('widens a take to more kinds of work or a larger number, and narrows it the other way', () => {
    expect(change('take', one('1290'), next(3))).toBe('take.widen');
    expect(change('take', next(3), every)).toBe('take.widen');
    expect(change('take', one('1290'), every)).toBe('take.widen');
    expect(change('take', next(3), next(4))).toBe('take.widen');
    expect(change('take', every, next(20))).toBe('take.narrow');
    expect(change('take', next(3), one('1290'))).toBe('take.narrow');
    // Fewer from the same start admit no more.
    expect(change('take', next(4), next(3))).toBe('take.narrow');
    // Counted again from later, whatever the number: five with four taken, chosen again as two, admit one more, and
    // policy cannot see how many were taken.
    for (const count of [1, 3, 5]) {
      expect(change('take', next(3), { kind: 'next-few', count, since: '2026-10-24T10:00:00.000Z' }), `${count}`).toBe(
        'take.widen',
      );
    }
    // Even in the same millisecond, as the admin service stamps it to the microsecond.
    expect(
      change(
        'take',
        { kind: 'next-few', count: 3, since: '2026-10-24T10:00:00.000100Z' },
        { kind: 'next-few', count: 3, since: '2026-10-24T10:00:00.000200Z' },
      ),
    ).toBe('take.widen');
    // Just one, moved to another work item, is still one.
    expect(change('take', one('1290'), one('1291'))).toBe('take.narrow');
  });

  it('narrows, or leaves, every ticket, which is what the line takes with no take set', () => {
    for (const after of [every, next(1), one('1290')]) {
      expect(change('take', controlsInForce().take, after)).toBe('take.narrow');
    }
  });

  it('widens whatever a change recorded over no take set, which was then a default policy could not see', () => {
    for (const after of [every, next(1), one('1290')]) expect(change('take', null, after)).toBe('take.widen');
  });

  it('asks for the passkey again exactly when it loosens, as the access table marks', () => {
    const loosens = ['autonomy.loosen', 'auto-merge.on', 'take.widen'];
    for (const action of [
      'autonomy.loosen',
      'autonomy.tighten',
      'new-work.on',
      'new-work.off',
      'auto-merge.on',
      'auto-merge.off',
      'take.widen',
      'take.narrow',
    ] as const) {
      expect(ACCESS[action].stepUp, action).toBe(loosens.includes(action));
    }
  });
});
