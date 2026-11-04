/**
 * What each guardrail refused in the seven days to t (`refusals.ts`), in its opened row: under the rows a refusal's own
 * guardrails name, from a role that may append its mechanism alone, a relayed one counted only once the server's check
 * says it is what the GitHub worker signed, folded ones by their count; and the line that says what proves guardrail 9
 * where nothing refuses.
 */
import type { PayloadOf, PublicEvent } from '@software-factory/events';
import { publicView } from '@software-factory/events/public';
import { describe, expect, it } from 'vitest';
import { type Check, project } from '../../web/src/projection/index.ts';
import { REFUSAL_WINDOW_MS } from '../../web/src/projection/refusals.ts';
import { END, SAMPLES, work } from './support.ts';

const START = Date.parse('2026-10-03T09:00:00Z');
const MINUTE = 60_000;
const SIGNED = { record: 'a'.repeat(64), signature: `${'A'.repeat(86)}==` };

const by = (role: string, events: readonly PublicEvent[]) => events.map((event) => ({ ...event, appended_by: role }));

/** One refusal on work item `number`, `minute` minutes after the start, as `role` appended it. */
function refused(
  number: string,
  minute: number,
  role: string,
  payload: Partial<PayloadOf<'action.refused'>> & Pick<PayloadOf<'action.refused'>, 'mechanism' | 'guardrails'>,
) {
  return by(
    role,
    work(number, START).add(minute, 'action.refused', 'factory', {
      action: `An attempt by ${payload.mechanism}`,
      output: `✕ refused by ${payload.mechanism}`,
      ...payload,
    } as PayloadOf<'action.refused'>).events,
  );
}

const row = (events: PublicEvent[], n: number, t = START + 60 * MINUTE, checks = new Map<number, Check>()) => {
  const found = project(events, t, () => true, checks).guardrails.rows.find((r) => r.n === n);
  if (!found) throw new Error(`no row ${n}`);
  return found;
};

describe('a guardrail’s refusals', () => {
  it('counts a refusal under the rows its own guardrails name, never by its mechanism', () => {
    const events = [
      ...refused('2001', 1, 'factory_gateway', { mechanism: 'gateway', guardrails: [7] }),
      ...refused('2002', 2, 'factory_gateway', { mechanism: 'gateway', guardrails: [6] }),
    ];
    expect(row(events, 7).refusals).toMatchObject({ counted: 1, lines: [{ workItem: '2001', mechanism: 'gateway' }] });
    expect(row(events, 6).refusals).toMatchObject({ counted: 1, lines: [{ workItem: '2002' }] });
    expect(row(events, 9).refusals).toMatchObject({ counted: 0, lines: [] });
  });

  it('trusts only a role that may append its mechanism, and only guardrails its mechanism can show', () => {
    const events = [
      // The line may not record the gateway's refusals, nor the gateway admission control's.
      ...refused('2003', 1, 'factory_line', { mechanism: 'gateway', guardrails: [7] }),
      ...refused('2004', 2, 'factory_gateway', { mechanism: 'admission-control', guardrails: [3] }),
      ...refused('2005', 3, 'factory_admin', { mechanism: 'scope-fence', guardrails: [11] }),
      // The gateway shows 6, 7 or 9, never 1.
      ...refused('2006', 4, 'factory_gateway', { mechanism: 'gateway', guardrails: [1, 7] }),
    ];
    expect(row(events, 7).refusals.lines.map((l) => l.workItem)).toEqual(['2006']);
    expect(row(events, 3).refusals.lines).toEqual([]);
    expect(row(events, 11).refusals.lines).toEqual([]);
    expect(row(events, 1).refusals.lines).toEqual([]);
  });

  it('shows the last three in the seven days to t, newest first, and counts every one, folded ones by their count', () => {
    const events = [
      ...refused('2010', 0, 'factory_line', { mechanism: 'scope-fence', guardrails: [11] }),
      ...refused('2011', 10, 'factory_line', { mechanism: 'scope-fence', guardrails: [11] }),
      ...refused('2012', 20, 'factory_gateway', {
        mechanism: 'gateway',
        guardrails: [7],
        count: 4,
        lastAt: new Date(START + 20.5 * MINUTE).toISOString(),
      }),
      ...refused('2013', 30, 'factory_line', { mechanism: 'scope-fence', guardrails: [11] }),
      ...refused('2014', 40, 'factory_line', { mechanism: 'scope-fence', guardrails: [11] }),
    ];
    const eleven = row(events, 11).refusals;
    expect(eleven.lines.map((l) => l.workItem)).toEqual(['2014', '2013', '2011']);
    expect(eleven.counted).toBe(4);
    expect(row(events, 7).refusals).toMatchObject({ counted: 4, lines: [{ count: 4 }] });
    // Before the last two, the view at that time reads only what had happened.
    expect(row(events, 11, START + 25 * MINUTE).refusals.lines.map((l) => l.workItem)).toEqual(['2011', '2010']);
    // A week after the first, it has left the window.
    const later = START + REFUSAL_WINDOW_MS + 5 * MINUTE;
    expect(row(events, 11, later).refusals).toMatchObject({ counted: 3 });
    expect(row(events, 11, START + REFUSAL_WINDOW_MS + 50 * MINUTE).refusals).toMatchObject({ counted: 0, lines: [] });
  });

  it('counts a relayed refusal only once the server says it checks out, and shows the rest as they stand', () => {
    const relayed = (number: string, minute: number, extra = {}) =>
      refused(number, minute, 'factory_line', { mechanism: 'github-guard', guardrails: [1], ...extra });
    const events = [
      ...relayed('2020', 1, SIGNED),
      ...relayed('2021', 2, SIGNED),
      ...relayed('2022', 3, SIGNED),
      // Relayed, but with no signed record at all.
      ...relayed('2023', 4),
    ];
    const [a, b, c] = events.map((e) => e.seq);
    const before = row(events, 1).refusals;
    expect(before.lines.map((l) => l.standing)).toEqual(['unverified', 'checking', 'checking']);
    expect(before).toMatchObject({ counted: 0, unverified: 1 });
    const checks = new Map<number, Check>([
      [a ?? 0, 'verified'],
      [b ?? 0, 'redacted'],
      [c ?? 0, 'unverified'],
    ]);
    const after = row(events, 1, START + 60 * MINUTE, checks).refusals;
    expect(after.lines.map((l) => [l.workItem, l.standing])).toEqual([
      ['2023', 'unverified'],
      ['2022', 'unverified'],
      ['2021', 'redacted'],
    ]);
    expect(after).toMatchObject({ counted: 2, unverified: 2 });
  });

  it('holds any refusal that carries a signature to it, whatever its mechanism', () => {
    const events = refused('2030', 1, 'factory_line', { mechanism: 'admission-control', guardrails: [3], ...SIGNED });
    expect(row(events, 3).refusals.lines[0]?.standing).toBe('checking');
    const seq = events[0]?.seq ?? 0;
    expect(row(events, 3, START + 60 * MINUTE, new Map([[seq, 'verified']])).refusals.counted).toBe(1);
  });

  it('keeps a refusal’s few words as a visitor reads them', () => {
    const payload: PayloadOf<'action.refused'> = {
      mechanism: 'gateway',
      action: 'A model call by the coder agent, the work item’s cap',
      output: 'The work item has spent $5.03 on models, and may spend $5.00.',
      guardrails: [7],
    };
    const shown = publicView('action.refused', { summary: '', payload, artifacts: [] }).payload;
    expect(shown.action).toBe(payload.action);
  });
});

describe('guardrail 9, where nothing refuses', () => {
  const rolledBack = (minute: number, by: 'analysis' | 'martin', role = 'factory_line') =>
    (
      work('2040', START).add(minute, 'release.rolled-back', 'rollouts', {
        release: 'website-v0-9-10',
        version: 'v0.9.10',
        restored: 'v0.9.9',
        weight: 25,
        failed: [],
        by,
      } as unknown as PayloadOf<'release.rolled-back'>).events as PublicEvent[]
    ).map((event) => ({ ...event, work_item: null, appended_by: role }));

  it('says what the line’s last rollback was, and only the line’s', () => {
    expect(row(rolledBack(5, 'analysis'), 9).rollback).toMatchObject({
      last: { version: 'v0.9.10', by: 'analysis' },
      autoRollback: true,
    });
    expect(row(rolledBack(5, 'martin', 'factory_admin'), 9).rollback).toMatchObject({ last: undefined });
    expect(row([], 1).rollback).toBeUndefined();
  });
});

describe('the samples’ refusals', () => {
  const rows = project(SAMPLES, END, () => false).guardrails.rows;
  const of = (n: number) => rows.find((r) => r.n === n)?.refusals;

  it('show each guardrail’s from the week, the relayed ones being checked until the server answers', () => {
    expect(of(1)?.lines.map((l) => [l.mechanism, l.standing])).toEqual([
      ['github-guard', 'checking'],
      ['token-permission', 'checking'],
    ]);
    expect(of(3)?.lines).toHaveLength(1);
    expect(of(3)?.lines[0]).toMatchObject({ mechanism: 'admission-control', workItem: null });
    expect(of(4)?.lines[0]).toMatchObject({ mechanism: 'admission-control', workItem: null });
    expect(of(7)).toMatchObject({ counted: 3, lines: [{ mechanism: 'gateway', workItem: '1319', count: 3 }] });
    expect(of(8)?.lines[0]).toMatchObject({ mechanism: 'typed-judgement', workItem: '1291' });
    expect(of(10)?.lines[0]).toMatchObject({ mechanism: 'github-guard', workItem: null });
    expect(of(11)?.lines.map((l) => l.workItem)).toEqual(['1315', '1315']);
    expect(of(5)?.lines).toEqual([]);
  });
});
