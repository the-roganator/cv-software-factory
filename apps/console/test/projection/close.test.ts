/**
 * Whether the sheet offers Martin its Close: on an open work item with no hold, before its change merges, and with no
 * reason on one a visitor's report opened, as the admin service takes it (`admin/close.ts`).
 */
import { describe, expect, it } from 'vitest';
import { project } from '../../web/src/projection/index.ts';
import { projectSheet } from '../../web/src/projection/sheet.ts';
import { payloads, work } from './support.ts';

const START = Date.parse('2026-10-03T09:00:00Z');
const T = START + 60 * 60_000;
const held = { stage: 'plan', kind: 'question', cause: 'question', reason: 'Which page?' } as const;
const merged = { number: 7, commit: 'a'.repeat(40), by: 'martin' } as const;
const file = { path: 'src/a.ts', added: 1, removed: 0 };
const pushed = {
  number: 7,
  title: 'fix: the search',
  branch: 'factory/fix',
  attempt: 1,
  testsFirst: false,
  files: [file],
  whole: [file],
};

describe('the sheet’s Close', () => {
  it('is offered on an open work item nothing holds for Martin, before its change merges', () => {
    const open = work('2101', START).open().add(1, 'signal.received', 'probe', payloads.signal);
    const answered = work('2102', START)
      .open()
      .add(1, 'signal.received', 'probe', payloads.signal)
      .add(2, 'hold.started', 'planner', held)
      .add(3, 'hold.answered', 'martin', { decision: 'answered', answer: 'The home page' });
    const view = project([...open.events, ...answered.events], T);
    expect(projectSheet(view, '2101')?.close).toEqual({ aboutReport: false });
    expect(projectSheet(view, '2102')?.close).toEqual({ aboutReport: false });
  });

  it('takes no reason on one a visitor’s report opened', () => {
    const report = work('2103', START)
      .open('visitor-report')
      .add(1, 'signal.received', 'visitor', {
        sense: 'report',
        check: 'a visitor’s report',
        route: '/search',
        version: 'v0.9.4',
        report: { page: '/search' },
      });
    expect(projectSheet(project(report.events, T), '2103')?.close).toEqual({ aboutReport: true });
  });

  it('is not offered on one held for him, in the merge queue, merged, or closed', () => {
    const holding = work('2104', START).open().add(2, 'hold.started', 'planner', held);
    const queued = work('2107', START)
      .open()
      .add(1, 'pull-request.pushed', 'factory', pushed)
      .add(2, 'pull-request.enqueued', 'factory', { number: 7, commit: 'a'.repeat(40), rule: 'low-risk' });
    const shipped = work('2105', START).open().add(2, 'pull-request.merged', 'martin', merged);
    const closed = work('2106', START)
      .open()
      .add(2, 'work-item.closed', 'martin', { outcome: 'discarded', reason: 'Not wanted' });
    const view = project([...holding.events, ...queued.events, ...shipped.events, ...closed.events], T);
    for (const item of ['2104', '2107', '2105', '2106']) expect(projectSheet(view, item)?.close, item).toBeUndefined();
  });
});
