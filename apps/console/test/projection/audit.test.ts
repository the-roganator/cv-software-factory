/**
 * The audit log (`projection/audit.ts`): every event a row, newest first, under a row for each day, drawn from its public
 * summary with a line of detail for a few types; the filters, the caption and Show older's pages. And the plan's
 * done-when for it: nothing a visitor wrote, and none of Martin's words on a hold about a visitor's report, reaches a
 * row, from hand-made events with a marker in every field a visitor writes and from the samples with their reports'
 * text given back, each through its public view as the store writes it.
 */
import {
  type EventType,
  type PayloadOf,
  type PublicEvent,
  type RawEvent,
  upcast,
  VERSIONS,
} from '@software-factory/events';
import { publicView } from '@software-factory/events/public';
import { describe, expect, it } from 'vitest';
import { ACCESS } from '../../../../policy/access.ts';
import { full, MARTINS_WORDS, REPORT_TEXT } from '../../e2e/full.ts';
import { dayLabel, startOfDay } from '../../web/src/format.ts';
import { type AuditFilter, type AuditRow, auditRows, auditView, NO_FILTER } from '../../web/src/projection/audit.ts';
import { END, SAMPLES } from './support.ts';

const START = Date.parse('2026-10-05T12:00:00Z');
let seq = 0;

/** One event, minutes from the start. */
function event<K extends EventType>(
  minute: number,
  type: K,
  actor: PublicEvent['actor'],
  payload: PayloadOf<K>,
  summary: string = type,
  item: string | null = null,
): PublicEvent {
  return {
    id: `event-${++seq}`,
    seq,
    ts: new Date(START + minute * 60_000).toISOString(),
    work_item: item,
    type,
    version: VERSIONS[type],
    actor,
    summary,
    payload,
    artifacts: [],
  } as PublicEvent;
}

const AT = START + 60 * 60_000;
const rows = (events: PublicEvent[], t = AT) => auditRows(events, t, 'local');
const only = (events: PublicEvent[]) => {
  const [row] = rows(events).filter((r) => r.seq === events.at(-1)?.seq);
  if (!row) throw new Error('no row');
  return row;
};
const filter = (over: Partial<AuditFilter>): AuditFilter => ({ ...NO_FILTER, ...over });

const modelCall: PayloadOf<'model.called'> = {
  agent: 'coder',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  settings: { effort: 'high' },
  tokens: { input: 1200, output: 2400, cacheRead: 15_000, cacheWrite: 2000 },
  costUsd: 0.0912,
  durationMs: 60_000,
  calls: 4,
};

describe('the rows', () => {
  it('are every event up to t, newest first, under a row for each day where the viewer is', () => {
    const all = rows(SAMPLES, END);
    expect(all).toHaveLength(SAMPLES.length);
    expect(all[0]?.seq).toBe(SAMPLES.at(-1)?.seq);
    expect(all.map((row) => row.seq)).toEqual([...SAMPLES.map((e) => e.seq)].reverse());
    expect(rows(SAMPLES, Date.parse(SAMPLES[10]?.ts ?? '')).length).toBeLessThan(SAMPLES.length);

    const { days } = auditView(all, NO_FILTER, END, Number.NEGATIVE_INFINITY);
    const today = startOfDay(END);
    expect(days[0]?.label).toBe('Today');
    expect(days[0]?.day).toBe(today);
    expect(days[1]?.label).toBe('Yesterday');
    const third = days[2];
    expect(third?.label).toBe(dayLabel(third?.rows[0]?.at ?? 0));
    for (const day of days) for (const row of day.rows) expect(startOfDay(row.at)).toBe(day.day);
    expect(days.flatMap((day) => day.rows)).toHaveLength(SAMPLES.length);
  });

  it('are of three kinds: Martin’s admin actions, model calls, and every other action', () => {
    const events = [
      event(0, 'admin.signed-in', 'martin', {}, 'Martin signed in with a passkey'),
      event(1, 'model.called', 'coder', modelCall),
      event(2, 'pull-request.merged', 'martin', { number: 7, commit: 'a'.repeat(40), by: 'martin' }),
      event(3, 'gates.started', 'actions', { pullRequest: 7, commit: 'a'.repeat(40), checks: ['Unit tests'] }),
      event(4, 'score.updated', 'scoreboard', { keyed: false }),
    ];
    expect(rows(events).map((row) => [row.kind, row.martin])).toEqual([
      ['agent', false],
      ['agent', false],
      ['admin', true],
      ['model', false],
      ['admin', true],
    ]);
    const triage = SAMPLES.find((e) => e.type === 'judgement.made');
    expect(rows(SAMPLES, END).find((row) => row.seq === triage?.seq)?.kind).toBe('model');
  });

  it('mark a mechanism’s refusal, and the gateway’s at a cap, and nothing else', () => {
    const all = rows(SAMPLES, END);
    const refused = all.filter((row) => row.refused);
    expect(refused.map((row) => SAMPLES.find((e) => e.seq === row.seq)?.type)).toEqual(
      expect.arrayContaining(['action.refused']),
    );
    expect(refused.every((row) => /refused/i.test(row.what))).toBe(true);
    expect(refused.map((row) => row.item)).toEqual(expect.arrayContaining(['1315', '1293']));
    // Admission control's refusal is Kyverno's, and only it carries Kyverno's mark.
    expect(all.filter((row) => row.admission).map((row) => row.item)).toEqual(['1293']);
    const capped = event(0, 'spend.capped', 'factory', {
      cap: 'day',
      limitUsd: 5,
      spentUsd: 5.01,
      resets: '2026-10-06T00:00:00Z',
    });
    expect(only([capped]).refused).toBe(true);
    const failed = SAMPLES.find((e) => e.type === 'gate.finished' && e.payload.conclusion === 'failure');
    expect(all.find((row) => row.seq === failed?.seq)?.refused).toBe(false);
  });

  it('say what happened in the event’s own summary, a type it has never heard of too', () => {
    const unknown = {
      ...event(0, 'line.started', 'martin', { autonomy: 'guarded' }),
      type: 'controls.changed',
      summary: 'Martin let the line take the next 3 work items',
      payload: { anything: 'at all' },
    } as unknown as PublicEvent;
    const row = only([unknown]);
    expect(row).toMatchObject({ what: 'Martin let the line take the next 3 work items', kind: 'admin' });
    expect(row.detail).toBeUndefined();
  });
});

describe('the detail under a row', () => {
  it('is a model call’s model, effort, tokens in and out, and cost', () => {
    const row = only([event(0, 'model.called', 'coder', modelCall, 'Coder called claude-sonnet-5-5 4 times', '1312')]);
    expect(row).toMatchObject({ what: 'Coder called claude-sonnet-5-5 4 times', item: '1312', kind: 'model' });
    expect(row.detail).toBe('Claude Sonnet 5.5 · high · 18k in · 2k out · $0.09');
  });

  it('is triage’s question set and cost, with its report’s text left out', () => {
    const triage = SAMPLES.find((e) => e.type === 'judgement.made');
    const row = rows(SAMPLES, END).find((r) => r.seq === triage?.seq);
    expect(row?.detail).toMatch(/^Jev 1\.13\.0 · triage\/v1 · \d+ questions · <\$0\.01$/);
    expect(row?.withheld).toBe('Its text is left out: a visitor wrote it.');
  });

  it('says whose text triage’s judgement left out: a visitor’s, or the planner’s', () => {
    const finding = event(
      0,
      'signal.received',
      'planner',
      { sense: 'planner', check: 'finding', route: '/', version: 'v1', report: { page: '/' }, planning: '2' },
      'The planner noted something on /',
      '9',
    );
    const judged = event(
      1,
      'judgement.made',
      'triage',
      {
        questionSet: 'triage/v1',
        model: 'jev-1.13.0',
        state: { report: { page: '/' } },
        answers: [{ type: 'choice', key: 'category', question: 'What kind?', answer: 'content', probabilities: {} }],
        costUsd: 0.001,
        durationMs: 100,
        cassette: 'a'.repeat(64),
      } as PayloadOf<'judgement.made'>,
      'Triage: content',
      '9',
    );
    expect(only([finding, judged]).withheld).toBe(
      'Its text is left out, as a visitor’s is: the planner wrote it from a page.',
    );
  });

  it('is the reason Martin gave to stop or start the line', () => {
    expect(only([event(0, 'line.stopped', 'martin', { reason: 'Going out' })]).detail).toBe('“Going out”');
    // A start with a reason, as a later version of the type carries it.
    const started = { ...event(1, 'line.started', 'martin', { autonomy: 'guarded' }), payload: { reason: 'Back' } };
    expect(only([started as PublicEvent]).detail).toBe('“Back”');
    expect(only([event(2, 'line.started', 'martin', { autonomy: 'guarded' })]).detail).toBeUndefined();
  });

  it('is Martin’s words on a hold, quoted, or the line that says they stay his', () => {
    const words = event(0, 'hold.answered', 'martin', { decision: 'answered', answer: 'Fix the logging only.' });
    expect(only([words]).detail).toBe('“Fix the logging only.”');
    const kept = event(1, 'hold.answered', 'martin', { decision: 'answered', report: true });
    expect(only([kept])).toMatchObject({
      withheld: 'His words stay his: the hold was about a visitor’s report.',
    });
    expect(only([kept]).detail).toBeUndefined();
    const approved = event(2, 'hold.answered', 'martin', { decision: 'approved', report: true });
    expect(only([approved]).withheld).toBe('Any words of his stay his: the hold was about a visitor’s report.');
    const plain = event(3, 'hold.answered', 'martin', { decision: 'approved' });
    expect(only([plain]).detail).toBeUndefined();
    expect(only([plain]).withheld).toBeUndefined();
  });

  it('is each setting changed, before and after, and when the passkey was given for a raise', () => {
    const steppedUp = event(0, 'admin.stepped-up', 'martin', {}, 'Martin gave his passkey again');
    const raised = event(2, 'settings.changed', 'martin', {
      agents: {
        planner: { model: 'claude-sonnet-5-5', effort: 'medium' },
        coder: { model: 'claude-sonnet-5-5', effort: 'high' },
        reviewer: { model: 'claude-sonnet-5-5', effort: 'medium' },
        describer: { model: 'claude-sonnet-5-5', effort: 'low' },
      },
      caps: { dayUsd: 10, monthUsd: null, workItemUsd: 1 },
      changes: [
        { field: 'effort', agent: 'coder', before: 'medium', after: 'high' },
        { field: 'cap', cap: 'day', beforeUsd: 5, afterUsd: 10 },
      ],
    });
    const at = new Date(START).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    expect(only([steppedUp, raised]).detail).toBe(
      `the coder’s effort, medium → high; the day’s cap, $5.00 → $10.00 · passkey given at ${at}`,
    );
    // A lower cap asks for nothing, so the passkey is not its detail, fresh or not.
    const lowered = event(3, 'settings.changed', 'martin', {
      ...(raised.payload as PayloadOf<'settings.changed'>),
      changes: [{ field: 'cap', cap: 'day', beforeUsd: 10, afterUsd: 5 }],
    });
    expect(only([steppedUp, lowered]).detail).toBe('the day’s cap, $10.00 → $5.00');
  });

  it('is the release Martin controlled, and the passkey only while it was fresh', () => {
    const steppedUp = event(0, 'admin.stepped-up', 'martin', {});
    const promote = (minute: number) =>
      event(minute, 'release.controlled', 'martin', {
        action: 'promote-fully',
        release: 'n4bvkfjhnd-911',
        version: 'v0.9.11',
        weight: 50,
        to: 100,
      });
    expect(only([steppedUp, promote(4)]).detail).toMatch(/^release n4bvkfjhnd-911 · 50% → 100% · passkey given at /);
    expect(only([steppedUp, promote(6)]).detail).toBe('release n4bvkfjhnd-911 · 50% → 100%');
    const pause = event(1, 'release.controlled', 'martin', {
      action: 'pause',
      release: 'n4bvkfjhnd-911',
      version: 'v0.9.11',
      weight: 50,
    });
    expect(only([steppedUp, pause]).detail).toBe('release n4bvkfjhnd-911 · at 50%');
  });

  it('says when the passkey was given to approve a guardrail’s hold, and not another’s', () => {
    const hold = (cause: 'gates' | 'spec') =>
      event(
        0,
        'hold.started',
        'factory',
        { stage: 'gates', kind: 'approval', cause, reason: 'Held' } as PayloadOf<'hold.started'>,
        'Held',
        '7',
      );
    const steppedUp = event(1, 'admin.stepped-up', 'martin', {});
    for (const [cause, asks] of [
      ['gates', true],
      ['spec', false],
    ] as const) {
      const held = hold(cause);
      const approved = event(2, 'hold.answered', 'martin', { decision: 'approved', hold: held.id }, 'Approved', '7');
      expect(Boolean(only([held, steppedUp, approved]).detail?.includes('passkey given'))).toBe(asks);
    }
  });

  it('says when the passkey was given for a change of the line’s controls that loosens, and not for one that tightens', () => {
    const steppedUp = event(0, 'admin.stepped-up', 'martin', {});
    const controls = { autonomy: 'guarded', newWork: true, autoMerge: false, take: null, autoRollback: true } as const;
    const changed = (change: PayloadOf<'controls.changed'>['change']) =>
      event(2, 'controls.changed', 'martin', { ...controls, change }, 'Martin changed a control');
    const marked = (change: PayloadOf<'controls.changed'>['change']) =>
      Boolean(only([steppedUp, changed(change)]).detail?.includes('passkey given'));
    expect(marked({ control: 'autonomy', before: 'supervised', after: 'guarded' })).toBe(true);
    expect(marked({ control: 'autonomy', before: 'lights-out', after: 'guarded' })).toBe(false);
    expect(marked({ control: 'auto-merge', before: false, after: true })).toBe(true);
    expect(marked({ control: 'auto-merge', before: true, after: false })).toBe(false);
    expect(marked({ control: 'auto-rollback', before: true, after: false })).toBe(true);
    expect(marked({ control: 'auto-rollback', before: false, after: true })).toBe(false);
    expect(marked({ control: 'new-work', before: false, after: true })).toBe(false);
    expect(marked({ control: 'take', before: { kind: 'just-one', workItem: '7' }, after: { kind: 'every' } })).toBe(
      true,
    );
    expect(marked({ control: 'take', before: { kind: 'every' }, after: { kind: 'just-one', workItem: '7' } })).toBe(
      false,
    );
  });

  it('marks every action the access table asks the passkey for, or names the event it waits for', () => {
    // Each marked action, and events that record it.
    const controls = { autonomy: 'guarded', newWork: true, autoMerge: false, take: null, autoRollback: true } as const;
    const control = (change: PayloadOf<'controls.changed'>['change']) => [
      event(2, 'controls.changed', 'martin', { ...controls, change }),
    ];
    const release = (action: 'promote-fully' | 'retry') => [
      event(2, 'release.controlled', 'martin', {
        action,
        release: 'n4bvkfjhnd-911',
        version: 'v0.9.11',
        weight: 50,
        ...(action === 'promote-fully' && { to: 100 }),
      } as PayloadOf<'release.controlled'>),
    ];
    const saved = (changes: PayloadOf<'settings.changed'>['changes']) => [
      event(2, 'settings.changed', 'martin', {
        agents: {
          planner: { model: 'claude-sonnet-5-5', effort: 'medium' },
          coder: { model: 'claude-sonnet-5-5', effort: 'high' },
          reviewer: { model: 'claude-sonnet-5-5', effort: 'medium' },
          describer: { model: 'claude-sonnet-5-5', effort: 'low' },
        },
        caps: { dayUsd: 10, monthUsd: null, workItemUsd: 1 },
        changes,
      }),
    ];
    const staged = (from: PayloadOf<'flag.staged'>['from'], to: PayloadOf<'flag.staged'>['to']) =>
      event(2, 'flag.staged', 'martin', {
        flag: 'delivery-dates',
        from,
        to,
        action: to.stage === 'everyone' && from?.stage === 'off' ? 'flag.back-on' : 'flag.widen',
        revision: 'r2',
        steppedUp: true,
      });
    const held = event(1, 'hold.started', 'factory', {
      stage: 'gates',
      kind: 'approval',
      cause: 'gates',
      reason: 'Held',
    } as PayloadOf<'hold.started'>);
    const opened = (kind: PayloadOf<'work-item.opened'>['kind']) =>
      event(0, 'work-item.opened', 'martin', { kind, title: 'Delivery dates', sample: true }, 'Opened', '1400');
    const specHeld = event(
      1,
      'hold.started',
      'factory',
      { stage: 'plan', kind: 'approval', cause: 'spec', reason: 'Held' } as PayloadOf<'hold.started'>,
      'Held',
      '1400',
    );
    const approvedSpec = event(2, 'hold.answered', 'martin', { decision: 'approved', hold: specHeld.id }, 'Ok', '1400');
    const recorded: Record<string, PublicEvent[] | 'no event yet'> = {
      'line.start': [event(2, 'line.started', 'martin', { reason: 'Back' })],
      'autonomy.loosen': control({ control: 'autonomy', before: 'supervised', after: 'guarded' }),
      'auto-merge.on': control({ control: 'auto-merge', before: false, after: true }),
      'auto-rollback.off': control({ control: 'auto-rollback', before: true, after: false }),
      'take.widen': control({ control: 'take', before: null, after: { kind: 'every' } }),
      'release.promote': release('promote-fully'),
      'release.retry': release('retry'),
      'agent.raise': saved([{ field: 'effort', agent: 'coder', before: 'medium', after: 'high' }]),
      'caps.raise': saved([{ field: 'cap', cap: 'day', beforeUsd: 5, afterUsd: 10 }]),
      'hold.approve-guardrail': [held, event(2, 'hold.answered', 'martin', { decision: 'approved', hold: held.id })],
      'passkey.revoke': [event(2, 'passkey.revoked', 'martin', { from: 'console' })],
      'flag.widen': [staged({ stage: 'checks' }, { stage: 'share', share: 50 })],
      'flag.back-on': [staged({ stage: 'off' }, { stage: 'everyone' })],
      'improvement.request': [
        opened('improvement'),
        event(2, 'improvement.requested', 'martin', { words: 'Dates.', steppedUp: true }, 'Asked', '1400'),
      ],
      'hold.approve-improvement-spec': [opened('improvement'), specHeld, approvedSpec],
      'phone.off': [event(2, 'alerts.switched', 'martin', { phone: false })],
    };
    const marked = Object.entries(ACCESS as Record<string, { stepUp: boolean }>)
      .filter(([name, access]) => access.stepUp && name !== 'step-up')
      .map(([name]) => name);
    expect(Object.keys(recorded).sort()).toEqual(marked.sort());
    const steppedUp = event(0, 'admin.stepped-up', 'martin', {});
    for (const [action, events] of Object.entries(recorded)) {
      if (events === 'no event yet') continue;
      expect(only([steppedUp, ...events]).detail, action).toMatch(/passkey given at/);
    }
    // Approving the spec of any other work item asks for nothing more.
    expect(only([steppedUp, opened('defect-fix'), specHeld, approvedSpec]).detail).toBeUndefined();
  });

  it('says each move of a flag, from where it stood to where Martin set it, and his reason for turning it off', () => {
    const off = event(
      1,
      'flag.staged',
      'martin',
      {
        flag: 'delivery-dates',
        from: { stage: 'share', share: 50 },
        to: { stage: 'off' },
        action: 'flag.off',
        revision: 'r7',
        reason: 'The date is wrong on Sundays',
        steppedUp: false,
      },
      'Martin turned delivery-dates off, from Share 50%',
      '1294',
    );
    expect(only([off])).toMatchObject({
      what: 'Martin turned delivery-dates off, from Share 50%',
      item: '1294',
      martin: true,
      detail: 'share 50% → off · “The date is wrong on Sundays”',
    });
    const dropping = event(
      2,
      'flag.staged',
      'martin',
      {
        flag: 'delivery-dates',
        from: { stage: 'checks' },
        to: { stage: 'preview' },
        action: 'flag.widen',
        revision: 'r8',
        steppedUp: true,
        dropped: ['hand-made'],
      },
      'Martin widened delivery-dates from Checks to Preview, and dropped 1 set by hand',
      '1294',
    );
    expect(only([dropping]).detail).toBe('checks → preview · dropped hand-made, set by hand');
  });

  it('is nothing more for a sign-in than its summary', () => {
    const signedIn = event(0, 'admin.signed-in', 'martin', {}, 'Martin signed in with a passkey');
    expect(only([signedIn])).toMatchObject({ what: 'Martin signed in with a passkey', martin: true });
    expect(only([signedIn]).detail).toBeUndefined();
  });
});

describe('the filters, the caption and Show older', () => {
  const all = rows(SAMPLES, END);
  const shown = (view: ReturnType<typeof auditView>) => view.days.flatMap((day) => day.rows);

  it('shows the latest page of every row, and says so', () => {
    const view = auditView(all, NO_FILTER, END);
    expect(view.shown).toBe(100);
    expect(view.caption).toBe(`Showing the latest 100, of ${all.length} in all.`);
    expect(view.filtered).toBe(false);
  });

  it('narrows by actor, the senses as one', () => {
    const coder = shown(auditView(all, filter({ actor: 'coder' }), END, Number.NEGATIVE_INFINITY));
    expect(coder.length).toBeGreaterThan(0);
    expect(coder.every((row) => row.actor === 'coder')).toBe(true);
    const senses = shown(auditView(all, filter({ actor: 'senses' }), END, Number.NEGATIVE_INFINITY));
    expect(new Set(senses.map((row) => row.actor))).toEqual(new Set(['probe', 'logs', 'metrics', 'canary']));
    const martin = shown(auditView(all, filter({ actor: 'martin' }), END, Number.NEGATIVE_INFINITY));
    expect(martin.every((row) => row.martin)).toBe(true);
    // Who is in none of the choices still shows under Everyone.
    expect(shown(auditView(all, NO_FILTER, END, Number.NEGATIVE_INFINITY)).some((r) => r.actor === 'rollouts')).toBe(
      true,
    );
  });

  it('narrows by work item, with or without its #', () => {
    for (const item of ['1315', '#1315', ' 1315 ']) {
      const view = auditView(all, filter({ item }), END);
      expect(view.matching).toBe(SAMPLES.filter((e) => e.work_item === '1315').length);
      expect(shown(view).every((row) => row.item === '1315')).toBe(true);
    }
  });

  it('narrows by kind', () => {
    const models = auditView(all, filter({ kinds: { admin: false, agent: false, model: true } }), END);
    expect(models.matching).toBe(
      SAMPLES.filter((e) => e.type === 'model.called' || e.type === 'judgement.made').length,
    );
    expect(shown(models).every((row) => row.kind === 'model')).toBe(true);
  });

  it('narrows by all three together, and says how many match', () => {
    const view = auditView(
      all,
      filter({ actor: 'coder', item: '1315', kinds: { admin: false, agent: false, model: true } }),
      END,
    );
    const expected = SAMPLES.filter((e) => e.actor === 'coder' && e.work_item === '1315' && e.type === 'model.called');
    expect(view.matching).toBe(expected.length);
    expect(view.caption).toBe(`Showing the ${expected.length} that match, of ${all.length} in all.`);
  });

  it('says when nothing matches', () => {
    const view = auditView(all, filter({ actor: 'describer', item: '1293' }), END);
    expect(view).toMatchObject({ shown: 0, matching: 0, filtered: true });
    expect(view.caption).toBe(`None of the ${all.length} in all match.`);
    expect(auditView([], NO_FILTER, END).caption).toBe('Nothing has happened yet.');
  });

  it('pages back a hundred at a time, and holds its floor as new rows arrive', () => {
    const first = auditView(all, NO_FILTER, END);
    expect(first.older).toBe(all[199]?.seq);
    const second = auditView(all, NO_FILTER, END, first.older);
    expect(second.shown).toBe(200);
    expect(second.caption).toBe(`Showing the latest 200, of ${all.length} in all.`);
    const last = auditView(all, NO_FILTER, END, Number.NEGATIVE_INFINITY);
    expect(last).toMatchObject({ shown: all.length, older: undefined });
    expect(last.caption).toBe(`Showing all ${all.length} in all.`);

    // A new event joins the top, and the oldest row shown stays the same.
    const later = END + 60_000;
    const arrived: AuditRow = { ...(all[0] as AuditRow), seq: (all[0]?.seq ?? 0) + 1, at: later };
    const held = auditView([arrived, ...all], NO_FILTER, later, first.floor);
    expect(held.shown).toBe(101);
    expect(held.floor).toBe(first.floor);
  });
});

/** A marker in every field a visitor writes, and in Martin's words on a hold about a visitor's report. */
const MARKER = 'ZZ-VISITOR-WROTE-THIS-ZZ';
/** A visitor's key, which is a credential and never public. */
const KEY = 'zz-visitorkey';

/** An event as the store keeps its public view: the view's summary, payload and artifacts in the envelope. */
function stored(event: PublicEvent): PublicEvent {
  const view = publicView(event.type, { summary: event.summary, payload: event.payload, artifacts: event.artifacts });
  return { ...event, ...view } as PublicEvent;
}

describe('nothing a visitor wrote', () => {
  const report = { text: `Broken! ${MARKER}`, page: `/search?q=${MARKER}#${MARKER}` };
  const written = [
    event(0, 'work-item.opened', 'visitor', {
      kind: 'visitor-report',
      title: 'A report from the search page',
      sample: false,
      visitor: { key: KEY },
    }),
    event(
      1,
      'signal.received',
      'widget',
      { sense: 'report', check: 'report widget', route: '/search', version: 'v0.9.7', report },
      `A visitor said: ${MARKER}`,
      '1',
    ),
    event(
      2,
      'signal.received',
      'planner',
      {
        sense: 'planner',
        check: 'planner finding',
        route: '/search',
        version: 'v0.9.7',
        report,
        planning: '2',
      } as PayloadOf<'signal.received'>,
      `The planner said: ${MARKER}`,
      '3',
    ),
    event(
      3,
      'judgement.made',
      'triage',
      {
        questionSet: 'triage/v1',
        model: 'jev-1.13.0',
        state: { report },
        answers: [
          {
            type: 'choice',
            key: 'category',
            question: 'What kind?',
            answer: 'suggestion',
            probabilities: { suggestion: 0.9 },
          },
        ],
        costUsd: 0.001,
        durationMs: 100,
        cassette: 'a'.repeat(64),
      } as PayloadOf<'judgement.made'>,
      'Triage: suggestion (0.90)',
      '1',
    ),
    event(
      4,
      'hold.answered',
      'martin',
      { decision: 'answered', answer: `Yes: ${MARKER}`, report: true },
      `Martin: ${MARKER}`,
      '1',
    ),
  ];

  it('reaches no row of hand-made events, through their public views', () => {
    // Each event really carries the marker before its public view is taken.
    for (const e of written.slice(1)) expect(JSON.stringify(e)).toContain(MARKER);
    expect(JSON.stringify(written[0])).toContain(KEY);
    const audit = rows(written.map(stored));
    expect(audit).toHaveLength(written.length);
    expect(JSON.stringify(audit)).not.toContain(MARKER);
    expect(JSON.stringify(audit)).not.toContain(KEY);
    expect(audit.filter((row) => row.withheld).map((row) => row.withheld)).toEqual([
      'His words stay his: the hold was about a visitor’s report.',
      'Its text is left out: a visitor wrote it.',
      'Its text is left out, as a visitor’s is: the planner wrote it from a page.',
      'Its text is left out: a visitor wrote it.',
    ]);
  });

  it('reaches no row of the samples, given back their reports’ text and Martin’s words', () => {
    const fulls = SAMPLES.map((e) => full(e as unknown as RawEvent)).map((raw) => {
      const result = upcast(raw);
      if (!result.ok) throw new Error(raw.type);
      return result.event;
    });
    expect(JSON.stringify(fulls)).toContain(REPORT_TEXT.slice(0, 30));
    expect(JSON.stringify(fulls)).toContain(MARTINS_WORDS);
    const text = JSON.stringify(auditRows(fulls.map(stored), END, 'local'));
    expect(text).not.toContain(REPORT_TEXT.slice(0, 30));
    expect(text).not.toContain('someone@example.com');
    expect(text).not.toContain(MARTINS_WORDS);
  });
});
