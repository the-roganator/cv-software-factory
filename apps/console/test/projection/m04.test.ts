/**
 * Milestone 4's states (the design system's README, "Sensing and triage"), projected from the test data: tickets
 * waiting for the planner, the senses' pictures, reports triage quarantined, parked or closed, a ticket's sheet,
 * where Triage's work comes from, and a spend cap reached and cleared.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { REPORTS } from '../../../../policy/triage.ts';
import { project, projectSheet, QUARANTINE_AT } from '../../web/src/projection/index.ts';
import { VERSION } from '../fixture/captures.ts';
import { AFTERNOON, CAPPED, CLEARED, FIXTURE, work } from './support.ts';

const view = project(FIXTURE, AFTERNOON);
const card = (number: string) => view.cards.find((c) => c.number === number);
const station = (stage: string, t = AFTERNOON) => project(FIXTURE, t).stations.find((s) => s.stage === stage);
const sheet = (number: string, t = AFTERNOON) => projectSheet(project(FIXTURE, t), number);

describe('a ticket from a sense', () => {
  it('has left Triage and waits at Plan for the planner, in the quiet tone', () => {
    expect(card('1001')).toMatchObject({ outcome: 'waiting', seenOn: VERSION, calls: 0, from: undefined });
    expect(card('1001')?.segments).toEqual(['passed', 'passed', 'queued', ...Array(5).fill('none')]);
  });

  it('stays at Plan as other senses add their evidence', () => {
    expect(card('1000')?.outcome).toBe('waiting');
    expect(card('1000')?.segments.slice(0, 3)).toEqual(['passed', 'passed', 'queued']);
  });

  it('is pictured by what its sense captured: a marked screenshot, tagged as seen', () => {
    expect(card('1001')?.picture).toMatchObject({ type: 'screenshot', tag: 'SEEN' });
  });
});

describe('the line, with tickets waiting for the planner', () => {
  it('keeps Plan idle, counting what waits and queueing their parcels', () => {
    expect(station('plan')).toMatchObject({ status: 'idle', figure: '8 waiting', queued: 8 });
  });

  it('says Triage needs you from the moment a suggestion is parked', () => {
    expect(station('triage')).toMatchObject({ status: 'blocked', figure: '1 waiting' });
    const row = view.panels.triage.rows.find((r) => r.item === '1008');
    expect(row).toMatchObject({ note: 'Needs you · a visitor suggests', tone: 'attn' });
  });

  it('lists what waits in Plan’s panel, and what left Sense’s, newest first by work-item number', () => {
    const plan = view.panels.plan.rows.map((r) => r.item);
    expect(plan).toEqual(['1010', '1006', '1005', '1004', '1003', '1002', '1001', '1000']);
    const sense = view.panels.sense.rows.map((r) => r.item);
    expect(sense).toEqual([...sense].sort((a, b) => Number(b) - Number(a)));
  });
});

describe('pictures for what a screenshot can’t show', () => {
  it('shows four of the pages a problem is on, and how many more', () => {
    const picture = card('1002')?.picture;
    expect(picture?.type).toBe('pages');
    if (picture?.type !== 'pages') return;
    expect(picture.shots).toHaveLength(4);
    expect(picture.more).toBe(3);
    expect(picture.source).toMatchObject({ sense: 'crawler', every: true });
  });

  it('draws an HTTP exchange where there is nothing to point at on the page', () => {
    expect(card('1003')?.picture).toMatchObject({ type: 'http', exchange: { status: null, url: '/gift-wrap' } });
    expect(card('1004')?.picture).toMatchObject({ type: 'http', source: { every: true } });
  });

  it('gives the browser’s console word for word, beside the page', () => {
    const picture = card('1005')?.picture;
    expect(picture).toMatchObject({ type: 'console', shot: { route: '/wishlist' } });
  });

  it('numbers the elements an accessibility check named, keeping those out of view', () => {
    const picture = card('1006')?.picture;
    expect(picture?.type).toBe('accessibility');
    if (picture?.type !== 'accessibility') return;
    const elements = picture.findings.findings[0]?.elements ?? [];
    expect(elements.map((e) => Boolean(e.box))).toEqual([true, true, false]);
  });
});

describe('a report', () => {
  it('quarantined: quiet, the deciding answer first, no page, and its text never shown', () => {
    expect(card('1007')).toMatchObject({ outcome: 'quarantined', category: 'red-team', from: '/about' });
    expect(card('1007')?.picture.type).toBe('quarantine');
    // Typed judgement refused it at Triage, as the line draws any refusal at the stage that refused.
    expect(card('1007')?.segments.slice(0, 2)).toEqual(['passed', 'stopped']);
    expect(sheet('1007')?.report).toEqual({ page: '/about', quarantined: true, by: 'visitor', times: 1, texts: [] });
    expect(sheet('1007')?.chapters.find((c) => c.label === 'QUARANTINED')?.tone).toBe('faint');
  });

  it('parked: a suggestion that needs Martin, with the page it named', () => {
    expect(card('1008')).toMatchObject({ outcome: 'needs-you', category: 'improvement', from: '/gift-cards' });
    expect(card('1008')?.picture).toMatchObject({ type: 'suggestion', page: { route: '/gift-cards' } });
  });

  it('discarded: closed with no ticket, and the judgement as its picture', () => {
    expect(card('1009')).toMatchObject({ outcome: 'no-ticket', category: 'not-a-defect' });
    expect(card('1009')?.picture.type).toBe('judgement');
  });

  it('that opened a ticket waits for the planner like any other', () => {
    expect(card('1010')).toMatchObject({ outcome: 'waiting', category: 'content', from: '/about' });
  });
});

describe('a report that became a ticket, later on the line', () => {
  const later = (type: string, payload: object, stage = 1) => ({
    id: `00000000-0000-8000-8000-00000000000${stage}`,
    seq: 10_000 + stage,
    ts: new Date(AFTERNOON - 60_000 + stage * 1000).toISOString(),
    work_item: '1010',
    type,
    version: 1,
    actor: 'factory',
    summary: `${type} for the test`,
    payload,
    artifacts: [],
  });
  const pushed = later('pull-request.pushed', {
    number: 2001,
    title: 'fix(about): put the right words back',
    branch: 'factory/1010',
    attempt: 1,
    testsFirst: true,
    files: [{ path: 'src/pages/about.ts', added: 2, removed: 2 }],
  });
  const held = later('hold.started', { stage: 'gates', kind: 'held', cause: 'gates', reason: 'A test was removed' }, 2);
  const events = [...FIXTURE, pushed, held] as typeof FIXTURE;

  it('leaves Jev’s answers behind once the line has evidence of its own', () => {
    expect(
      project([...FIXTURE, pushed] as typeof FIXTURE, AFTERNOON).cards.find((c) => c.number === '1010')?.picture.type,
    ).not.toBe('judgement');
  });

  it('shows the later hold, not the park', () => {
    const row = project(events, AFTERNOON).panels.gates.rows.find((r) => r.item === '1010');
    expect(row?.note).toBe('Needs you · held by a gate');
  });
});

describe('a ticket’s sheet', () => {
  it('lists every sense, those that saw it first and in order, and the rest as not yet', () => {
    const seen = sheet('1000')?.seenBy ?? [];
    expect(seen.map((s) => [s.sense, s.opened, s.at !== undefined])).toEqual([
      ['probe', true, true],
      ['logs', false, true],
      ['crawler', false, true],
      ['metrics', false, true],
      ['report', false, false],
    ]);
    expect(seen[1]?.added).toBe('with 2 log lines');
  });

  it('shows each sense’s evidence, the first time it saw the problem', () => {
    expect(sheet('1000')?.senseEvidence.map((e) => [e.sense, e.picture.type])).toEqual([
      ['probe', 'screenshot'],
      ['logs', 'logs'],
      ['crawler', 'http'],
      ['metrics', 'metric'],
    ]);
  });

  it('gives the ticket’s facts, and says why no model was called', () => {
    const ticket = sheet('1000');
    expect(ticket?.facts.ticket).toEqual({
      category: 'errors',
      severity: 'broken',
      fingerprint: '/contact · server-error',
    });
    expect(ticket?.agents).toEqual([]);
    expect(ticket?.noModel).toBe(
      'A sense knows what it saw, so the category and severity come from a table in the factory’s policy: a server error is an error, and broken. The planner will be the first model this ticket meets.',
    );
  });

  it('ends the story waiting at Plan, labelling the later senses by name', () => {
    const chapters = sheet('1000')?.chapters ?? [];
    expect(chapters.map((c) => c.label)).toEqual(['SIGNAL', 'TICKET', 'LOGS', 'CRAWLER', 'METRICS', 'WAITING · PLAN']);
    expect(chapters.at(-1)).toMatchObject({ waiting: true, text: 'Waiting for the planner' });
  });

  it('names the provider on every model row: Jev from TypeSafe, with each question set asked', () => {
    expect(sheet('1010')?.agents).toEqual([
      expect.objectContaining({
        agent: 'triage',
        provider: 'typesafe',
        model: 'jev-1.13.0',
        details: ['triage/v2 · 4 questions', 'passage/v1 · 1 question'],
        calls: 2,
      }),
    ]);
  });

  it('reads Claude’s provider from the event, Amazon Bedrock as much as Anthropic', () => {
    const events = work('1')
      .open()
      .add(1, 'model.called', 'planner', {
        agent: 'planner',
        provider: 'bedrock',
        model: 'claude-opus-5-5',
        settings: { effort: 'high' },
        tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.01,
        durationMs: 4000,
        calls: 1,
      }).events;
    expect(projectSheet(project(events, Date.parse(events.at(-1)?.ts ?? '')), '1')?.agents[0]).toMatchObject({
      provider: 'bedrock',
      details: ['effort high'],
    });
  });
});

describe('Triage’s panel', () => {
  it('counts what each sense has sent, from events alone', () => {
    expect(view.panels.triage.senses).toEqual([
      { sense: 'probe', signals: 2, tickets: 2, routes: undefined },
      { sense: 'crawler', signals: 6, tickets: 5, routes: undefined },
      { sense: 'metrics', signals: 1, tickets: 0, routes: undefined },
      { sense: 'logs', signals: 1, tickets: 0, routes: undefined },
      { sense: 'canary', signals: 0, tickets: 0, routes: undefined },
      { sense: 'report', signals: 4, tickets: 1, routes: { quarantined: 1, parked: 1, closed: 1, joined: 0 } },
    ]);
  });

  it('counts no planner’s finding as a sense’s signal, nor its judgement as a report’s', () => {
    const judgement: PayloadOf<'judgement.made'> = {
      questionSet: 'triage/v1',
      model: 'jev-1.13.0',
      state: { report: { page: '/contact' } },
      answers: [{ type: 'noul', key: 'injection', question: 'Orders?', probability: 0.01 }],
      route: 'park',
      costUsd: 0.0001,
      durationMs: 90,
      cassette: 'c'.repeat(64),
    };
    const finding = work('2001', AFTERNOON - 60_000)
      .open('planner-finding')
      .add(0, 'signal.received', 'planner', {
        sense: 'planner',
        check: 'planning ticket #1001',
        route: '/contact',
        version: 'a'.repeat(40),
        report: { page: '/contact' },
      })
      .add(0.1, 'judgement.made', 'triage', judgement)
      .add(0.1, 'hold.started', 'triage', {
        stage: 'triage',
        kind: 'held',
        cause: 'finding',
        defect: { fingerprint: { route: '/contact', class: 'wrong-result' }, symptom: 'wrong-result' },
        reason: 'The planner noticed a defect outside its ticket.',
      }).events;
    const t = AFTERNOON;
    const counts = project([...FIXTURE, ...finding], t).panels.triage.senses;
    expect(counts).toEqual(view.panels.triage.senses);
    expect(projectSheet(project(finding, t), '2001')?.report).toEqual({
      page: '/contact',
      quarantined: false,
      by: 'planner',
      times: 1,
      texts: [],
    });
    expect(projectSheet(project(finding, t), '2001')?.chapters.map((c) => c.label)).toContain('FINDING');
    expect(project(finding, t).cards[0]?.picture.type).toBe('judgement');

    // Noticed again, by another planner in its own words: triage counts it into the hold, which still waits once.
    const again = work('2001', AFTERNOON - 30_000)
      .add(0, 'signal.received', 'planner', {
        sense: 'planner',
        check: 'planning ticket #1002',
        route: '/contact',
        version: 'a'.repeat(40),
        report: { page: '/contact' },
      })
      .add(0.1, 'judgement.made', 'triage', { ...judgement, route: 'repeat', joined: '2001' })
      .events.map((event) => ({ ...event, id: `${event.id}-again` }));
    const twice = [...finding, ...again];
    expect(projectSheet(project(twice, t), '2001')?.report?.times).toBe(2);
    expect(projectSheet(project(twice, t), '2001')?.chapters.filter((c) => c.label === 'FINDING')).toHaveLength(2);
    expect(project(twice, t).cards.map((card) => [card.number, card.outcome])).toEqual([['2001', 'held']]);
  });

  it('pictures a planner’s finding by its page, and keeps a defect it noticed apart from a suggestion once answered', () => {
    const shot = FIXTURE.flatMap((event) => event.artifacts).find((a) => a.kind === 'screenshot');
    if (!shot) throw new Error('The test data has no screenshot');
    const finding = work('2002', AFTERNOON - 60_000)
      .open('planner-finding')
      .add(0, 'signal.received', 'planner', {
        sense: 'planner',
        check: 'planning ticket #1001',
        route: '/contact',
        version: 'a'.repeat(40),
        report: { page: '/contact' },
        planning: '1001',
      })
      .add(0.1, 'judgement.made', 'triage', {
        questionSet: 'triage/v1',
        model: 'jev-1.13.0',
        state: { report: { page: '/contact' } },
        answers: [{ type: 'noul', key: 'injection', question: 'Orders?', probability: 0.01 }],
        route: 'park',
        costUsd: 0.0001,
        durationMs: 90,
        cassette: 'c'.repeat(64),
      })
      .add(0.1, 'hold.started', 'triage', {
        stage: 'triage',
        kind: 'held',
        cause: 'finding',
        reason: 'A defect.',
        defect: { fingerprint: { route: '/contact', class: 'wrong-result' }, symptom: 'wrong-result' },
      })
      .add(0.5, 'hold.answered', 'martin', { decision: 'answered', answer: 'Leave it for a sense.' }).events;
    const signal = finding[1];
    if (signal) signal.artifacts = [shot];
    const picture = project(finding, AFTERNOON).cards[0]?.picture;
    expect(picture).toMatchObject({ type: 'judgement', page: shot });
    // His words settle nothing: the defect is still held, waiting for him to approve or reject it.
    expect(project(finding, AFTERNOON).cards[0]?.outcome).toBe('held');
    expect(projectSheet(project(finding, AFTERNOON), '2002')?.chapters.map((c) => c.label)).toContain('ANSWERED');
    // Once Martin has approved it, and triage opened its ticket, it waits at Plan like any ticket, pictured by what
    // triage made of it, as a report's ticket is, until the line has evidence of its own.
    const ticketed = work('2002', AFTERNOON - 60_000)
      .add(0.55, 'hold.answered', 'martin', { decision: 'approved' })
      .add(0.6, 'ticket.opened', 'triage', {
        title: 'A wrong result on /contact',
        category: 'functional',
        severity: 'broken',
        fingerprint: { route: '/contact', class: 'wrong-result' },
        traces: [],
      }).events;
    const card = project([...finding, ...ticketed], AFTERNOON).cards[0];
    expect(card).toMatchObject({ outcome: 'waiting', picture: { type: 'judgement' } });
    expect(card?.segments.slice(0, 3)).toEqual(['passed', 'passed', 'queued']);
  });
});

describe('the spend cap', () => {
  it('is not there before it is reached', () => {
    expect(view.header.capped).toBeUndefined();
    expect(view.panels.triage.caps).toEqual([]);
  });

  it('when reached, says so in the header and caps Triage until it resets, while the senses carry on', () => {
    const capped = project(FIXTURE, CAPPED);
    expect(capped.header.capped).toMatchObject({ cap: 'day', limitUsd: 20, resets: Date.parse('2026-10-04T00:00Z') });
    expect(station('triage', CAPPED)).toMatchObject({
      status: 'blocked',
      cappedUntil: Date.parse('2026-10-04T00:00Z'),
    });
    expect(capped.panels.triage.caps).toHaveLength(1);
  });

  it('when cleared, leaves the header and the station, and stays in Triage’s panel for the day', () => {
    const cleared = project(FIXTURE, CLEARED);
    expect(cleared.header.capped).toBeUndefined();
    expect(station('triage', CLEARED)?.cappedUntil).toBeUndefined();
    expect(cleared.panels.triage.caps).toEqual([
      expect.objectContaining({ reached: CAPPED - 6 * 60_000, cleared: Date.parse('2026-10-04T00:00Z') }),
    ]);
  });
});

describe('the quarantine threshold', () => {
  it('is the policy’s, which the console’s image is built without', () => {
    expect(QUARANTINE_AT).toBe(REPORTS.quarantine);
  });
});
