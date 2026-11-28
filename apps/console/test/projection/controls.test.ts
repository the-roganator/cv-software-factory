import type { PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTROLS } from '../../../../policy/line.ts';
import { changeAction, controlsView } from '../../web/src/projection/controls.ts';
import { project } from '../../web/src/projection/index.ts';
import { END, SAMPLES, work } from './support.ts';

const start = Date.parse('2026-10-03T09:00:00Z');
const at = (minute: number) => start + minute * 60_000;

/** A change of the line's controls, as the admin service appends it, minutes from the start. */
function changed(minute: number, controls: object, actor = 'martin'): PublicEvent {
  return {
    id: `controls-${minute}`,
    seq: minute,
    ts: new Date(at(minute)).toISOString(),
    work_item: null,
    type: 'controls.changed',
    version: 1,
    actor,
    summary: 'Martin changed a control',
    payload: {
      ...DEFAULT_CONTROLS,
      ...controls,
      change: { control: 'new-work', before: true, after: false },
    },
    artifacts: [],
  } as PublicEvent;
}

/** A work item the line took onto it at a minute: its ticket, and its planner's first step ending two minutes later. */
const taken = (number: string, minute: number) =>
  work(number, start)
    .open()
    .add(minute - 1, 'ticket.opened', 'triage', {} as never)
    .add(minute + 2, 'model.called', 'planner', {} as never).events;

describe('the line’s controls', () => {
  it('are policy’s defaults until Martin sets any', () => {
    expect(controlsView([], at(0))).toEqual({
      ...DEFAULT_CONTROLS,
      outside: [],
      nextFew: undefined,
      at: undefined,
      phone: undefined,
    });
  });

  it('are the latest Martin set, at t', () => {
    const events = [changed(1, { autonomy: 'guarded' }), changed(5, { autonomy: 'lights-out', newWork: false })];
    expect(controlsView(events, at(3))).toMatchObject({ autonomy: 'guarded', newWork: true, at: at(1) });
    expect(controlsView(events, at(6))).toMatchObject({ autonomy: 'lights-out', newWork: false, at: at(5) });
  });

  it('carry Martin’s latest switch of alerts to his phone, at t, and no one else’s', () => {
    const switched = (minute: number, phone: boolean, actor = 'martin') =>
      ({
        id: `phone-${minute}`,
        seq: minute,
        ts: new Date(at(minute)).toISOString(),
        work_item: null,
        type: 'alerts.switched',
        version: 1,
        actor,
        summary: 'Martin switched alerts',
        payload: { phone },
        artifacts: [],
      }) as PublicEvent;
    const events = [switched(1, true), switched(3, false), switched(4, true, 'factory')];
    expect(controlsView(events, at(2)).phone).toEqual({ phone: true });
    expect(controlsView(events, at(5)).phone).toEqual({ phone: false });
  });

  it('take nothing outside policy, control by control, and nothing anyone but Martin appended', () => {
    const outside = changed(1, {
      autonomy: 'yolo',
      newWork: 'yes',
      take: { kind: 'next-few', count: 21, since: '' },
    });
    expect(controlsView([outside], at(2))).toMatchObject({
      ...DEFAULT_CONTROLS,
      outside: ['autonomy', 'newWork', 'take'],
    });
    expect(controlsView([changed(1, { autonomy: 'lights-out' }, 'factory')], at(2)).autonomy).toBe('supervised');
  });

  it('count what the next few have taken from when Martin chose them, by the first thing the line did with each', () => {
    const since = new Date(at(10)).toISOString();
    const events = [
      ...taken('1', 2),
      changed(10, { take: { kind: 'next-few', count: 3, since } }),
      ...taken('2', 12),
      ...taken('3', 20),
      // An improvement Martin asked for counts as a ticket does.
      ...work('5', start)
        .open()
        .add(23, 'improvement.requested', 'martin', {} as never)
        .add(24, 'model.called', 'planner', {} as never).events,
      // A change that keeps when they started counts on from then: the count follows the event's own start.
      changed(22, { take: { kind: 'next-few', count: 4, since } }),
      // Triage's ticket alone is not taken, nor one the line only recorded something on: no agent has worked on it.
      ...work('4', start)
        .open()
        .add(25, 'ticket.opened', 'triage', {} as never)
        .add(26, 'work-item.closed', 'factory', {} as never).events,
    ].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    expect(controlsView(events, at(11)).nextFew).toEqual({ since: at(10), taken: 0 });
    expect(controlsView(events, at(15)).nextFew).toEqual({ since: at(10), taken: 1 });
    expect(controlsView(events, at(30))).toMatchObject({
      take: { kind: 'next-few', count: 4, since },
      nextFew: { since: at(10), taken: 3 },
    });
    // Only the next few count.
    expect(controlsView([...events, changed(31, { take: { kind: 'every' } })], at(32)).nextFew).toBeUndefined();
    // Chosen again, as the admin service stamps it, they start again, fewer too.
    const again = [
      ...events,
      changed(31, { take: { kind: 'next-few', count: 2, since: new Date(at(31)).toISOString() } }),
    ];
    expect(controlsView(again, at(32)).nextFew).toEqual({ since: at(31), taken: 0 });
  });

  it('count from the change itself in a replay, which moves every event’s time and none of a payload’s', () => {
    const since = new Date(at(10)).toISOString();
    const day = 86_400_000;
    const moved = [...taken('1', 2), changed(10, { take: { kind: 'next-few', count: 3, since } }), ...taken('2', 12)]
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .map((event) => ({ ...event, ts: new Date(Date.parse(event.ts) + 18 * day).toISOString() }));
    expect(controlsView(moved, at(30) + 18 * day).nextFew).toEqual({ since: at(10) + 18 * day, taken: 1 });
  });

  it('tell which action a recorded change is, and none for one that is not a change', () => {
    expect(changeAction({ control: 'autonomy', before: 'supervised', after: 'guarded' })).toBe('autonomy.loosen');
    // The auto-merge switch the line no longer has is no action now.
    expect(changeAction({ control: 'auto-merge', before: false, after: true })).toBeUndefined();
    expect(changeAction({ control: 'auto-rollback', before: true, after: false })).toBe('auto-rollback.off');
    expect(changeAction({ control: 'auto-rollback', before: false, after: true })).toBe('auto-rollback.on');
    expect(changeAction({ control: 'take', before: null, after: { kind: 'just-one', workItem: '7' } })).toBe(
      'take.widen',
    );
    for (const change of [
      undefined,
      { control: 'autonomy', before: 'supervised', after: 'yolo' },
      { control: 'new-work', before: 'yes', after: false },
      { control: 'take', before: { kind: 'every' }, after: null },
      { control: 'take', before: { kind: 'every' }, after: { kind: 'next-few', count: 99, since: '' } },
      { control: 'auto-rollback', before: true, after: 'off' },
      { control: 'a-new-control', before: true, after: false },
    ]) {
      expect(changeAction(change), JSON.stringify(change)).toBeUndefined();
    }
  });

  it('are in the view, with the samples’ Guarded and their next few', () => {
    const { controls } = project(SAMPLES, END);
    expect(controls).toMatchObject({ autonomy: 'guarded', newWork: true, outside: [] });
    expect(controls.take).toMatchObject({ kind: 'next-few', count: 5 });
    expect(controls.nextFew?.taken).toBeGreaterThan(0);
    expect(controls.nextFew?.taken).toBeLessThan(5);
  });
});
