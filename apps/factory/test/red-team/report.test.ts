import { refusalIdFor } from '@software-factory/triage/events';
import { describe, expect, it } from 'vitest';
import { reportAttempt } from '../../src/red-team/report.ts';
import type { AttemptContext } from '../../src/red-team/worker.ts';
import { fakeEvents, fakeSql, never, silent } from './fakes.ts';

const SIGNAL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function ctx(sql: AttemptContext['sql'], events = fakeEvents()): AttemptContext {
  return { sql, events, workItem: '1274', launchedAt: new Date(), limitMs: 80, log: silent, signal: never };
}

/** A store where the report's signal is found (or not), and triage's refusal is present (or not). */
function store({ signal = SIGNAL_ID as string | null, refused }: { signal?: string | null; refused: boolean }) {
  return fakeSql((query) => {
    if (query.includes('red_team_report_signal')) return [{ id: signal }];
    if (query.includes('typed-judgement')) return refused && signal ? [{ seq: '42' }] : [];
    return [];
  });
}

describe('attack 1 (report)', () => {
  it('is refused when triage quarantines the report it sent', async () => {
    let posted: { page: string; text: string } | undefined;
    const attempt = reportAttempt({
      report: async (r) => {
        posted = r;
      },
    });
    const result = await attempt(ctx(store({ refused: true })));
    expect(posted?.text).toMatch(/\[red-team-/); // a marker of its own, so it finds its own report
    expect(result.outcome).toBe('refused');
    expect(result.refusals).toEqual([42]);
    expect(result.subject).toEqual({ report: SIGNAL_ID });
  });

  it('is not refused when the report reached the inbox but was not quarantined', async () => {
    const attempt = reportAttempt({ report: async () => {} });
    const result = await attempt(ctx(store({ refused: false })));
    expect(result.outcome).toBe('not-refused');
    expect(result.subject).toEqual({ report: SIGNAL_ID });
  });

  it('is unfinished when the report never reached the inbox', async () => {
    const attempt = reportAttempt({ report: async () => {} });
    const result = await attempt(ctx(store({ signal: null, refused: false })));
    expect(result.outcome).toBe('unfinished');
  });

  it('cites triage’s refusal by the id triage gives a quarantine’s refusal of the signal', () => {
    // The harness looks for the event whose id is refusalIdFor(signalId); a guard that it uses triage's own naming.
    expect(refusalIdFor(SIGNAL_ID)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
