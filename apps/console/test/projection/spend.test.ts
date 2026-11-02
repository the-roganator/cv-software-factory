/**
 * The console's readers of what models cost, held to the events' current shapes: `model.called` is one agent's step
 * with every call it made summed (version 2; version 1 was one call), and `spend.capped` and `spend.cleared` are the
 * factory's day or month cap or, since version 2, a provider's own. Each reader is driven by events at their current
 * version, and by a version 1 event read through the upcasters, as the store holds both.
 */
import { type PayloadOf, type PublicEvent, upcast, VERSIONS } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { project, projectSheet } from '../../web/src/projection/index.ts';
import { header } from '../../web/src/projection/line.ts';
import { work } from './support.ts';

const step = (
  agent: PayloadOf<'model.called'>['agent'],
  calls: number,
  costUsd: number,
): PayloadOf<'model.called'> => ({
  agent,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  settings: { effort: 'medium', maxTurns: 50 },
  tokens: { input: 100 * calls, output: 10 * calls, cacheRead: 1000 * calls, cacheWrite: 50 * calls },
  costUsd,
  durationMs: 1000 * calls,
  calls,
});

const end = (events: readonly PublicEvent[]) => Date.parse(events.at(-1)?.ts ?? '');

describe('the readers of model.called, one event per step', () => {
  const events = work('2001')
    .open()
    .add(1, 'model.called', 'planner', step('planner', 7, 0.2))
    .add(2, 'model.called', 'coder', step('coder', 12, 0.9))
    .add(3, 'model.called', 'coder', step('coder', 5, 0.4)).events;

  it('counts each step’s calls and tokens in the sheet, and each event as one step', () => {
    const agents = projectSheet(project(events, end(events)), '2001')?.agents;
    expect(agents?.map(({ agent, calls, steps }) => ({ agent, calls, steps }))).toEqual([
      { agent: 'planner', calls: 7, steps: 1 },
      { agent: 'coder', calls: 17, steps: 2 },
    ]);
    const coder = agents?.find((a) => a.agent === 'coder');
    // Tokens in are the prompt, the cache's reads and its writes; tokens out the answers.
    expect(coder?.tokensIn).toBe(17 * (100 + 1000 + 50));
    expect(coder?.tokensOut).toBe(17 * 10);
    expect(coder?.cost).toBeCloseTo(1.3);
    expect(coder?.details).toEqual(['effort medium · ≤ 50 turns · 2 steps']);
  });

  it('sums every step’s cost on the card', () => {
    const card = project(events, end(events)).cards.find((c) => c.number === '2001');
    expect(card?.spend).toBeCloseTo(1.5);
    expect(card?.local).toBe(false);
  });

  it('draws a spend hold’s picture by agent, and the step the cap stopped', () => {
    const held = work('2002')
      .open()
      .add(1, 'model.called', 'planner', step('planner', 7, 0.5))
      .add(2, 'model.called', 'coder', step('coder', 12, 1.0))
      .add(3, 'model.called', 'coder', step('coder', 9, 0.6))
      .add(4, 'hold.started', 'factory', {
        stage: 'build',
        kind: 'held',
        cause: 'spend',
        reason: 'The work item has spent $2.10 on models, and may spend $2.00',
        limitUsd: 2,
      }).events;
    const card = project(held, end(held)).cards.find((c) => c.number === '2002');
    expect(card?.picture).toMatchObject({
      type: 'spend',
      cap: 2,
      agents: [
        { agent: 'planner', steps: 1 },
        { agent: 'coder', steps: 2 },
      ],
      stopped: { agent: 'coder', step: 2 },
    });
  });

  it('says a step served by the local model cost nothing, whatever it called', () => {
    const local = work('2003')
      .open()
      .add(1, 'model.called', 'planner', {
        ...step('planner', 30, 0),
        provider: 'local',
        model: 'qwen/qwen3.8-27b',
      }).events;
    expect(project(local, end(local)).cards.find((c) => c.number === '2003')).toMatchObject({ local: true, spend: 0 });
    expect(projectSheet(project(local, end(local)), '2003')?.agents[0]).toMatchObject({ provider: 'local', calls: 30 });
  });

  it('reads a version 1 event, one call with its cassette, as a step of one call', () => {
    const [opened] = work('2004').open().events;
    const v1 = upcast({
      type: 'model.called',
      version: 1,
      payload: { ...step('coder', 1, 0.05), calls: undefined, cassette: 'f'.repeat(64) },
    });
    if (!v1.ok || !opened) throw new Error('a version 1 model.called should upcast');
    const events = [opened, { ...opened, ...v1.event, id: '2004-v1', seq: (opened.seq ?? 0) + 1 }] as PublicEvent[];
    expect(projectSheet(project(events, end(events)), '2004')?.agents[0]).toMatchObject({
      agent: 'coder',
      calls: 1,
      steps: 1,
    });
  });
});

/** An event of the line itself, not of a work item. */
function lineEvent<K extends 'spend.capped' | 'spend.cleared'>(
  seq: number,
  ts: string,
  type: K,
  payload: PayloadOf<K>,
): PublicEvent {
  return {
    id: `line-${seq}`,
    seq,
    ts,
    work_item: null,
    type,
    version: VERSIONS[type],
    actor: 'factory',
    summary: type,
    payload,
    artifacts: [],
  } as PublicEvent;
}

describe('the readers of spend.capped and spend.cleared', () => {
  it('hold the line’s header at the factory’s own cap until it clears', () => {
    const capped = lineEvent(1, '2026-10-06T21:00:00Z', 'spend.capped', {
      cap: 'day',
      limitUsd: 20,
      spentUsd: 20.4,
      resets: '2026-10-07T00:00:00.000Z',
    });
    expect(header([capped]).capped).toMatchObject({ cap: 'day', limitUsd: 20, spentUsd: 20.4 });
    const cleared = lineEvent(2, '2026-10-07T00:00:05Z', 'spend.cleared', { cap: 'day' });
    expect(header([capped, cleared]).capped).toBeUndefined();
    expect(header([capped, cleared]).caps[0]?.cleared).toBe(Date.parse('2026-10-07T00:00:05Z'));
  });

  it('show a provider waiting, apart from the factory’s caps, until that provider answers again', () => {
    const refused = lineEvent(1, '2026-10-06T23:00:00Z', 'spend.capped', {
      cap: 'provider',
      provider: 'local',
      reason: 'unreachable',
      message: 'Nothing answered at 0.250.250.254:1234',
    });
    const waiting = header([refused]);
    expect(waiting.capped).toBeUndefined();
    expect(waiting.waiting).toMatchObject({ provider: 'local', reason: 'unreachable' });
    // Another provider answering clears nothing.
    const other = lineEvent(2, '2026-10-06T23:05:00Z', 'spend.cleared', { cap: 'provider', provider: 'anthropic' });
    expect(header([refused, other]).waiting?.provider).toBe('local');
    const back = lineEvent(3, '2026-10-06T23:10:00Z', 'spend.cleared', { cap: 'provider', provider: 'local' });
    expect(header([refused, other, back]).waiting).toBeUndefined();
  });

  it('reads a version 1 cap as the cap it was', () => {
    const v1 = upcast({
      type: 'spend.capped',
      version: 1,
      payload: { cap: 'month', limitUsd: 100, spentUsd: 100.2, resets: '2026-11-01T00:00:00.000Z' },
    });
    if (!v1.ok) throw new Error('a version 1 spend.capped should upcast');
    expect(v1.event.version).toBe(2);
    const event = { ...lineEvent(1, '2026-10-30T12:00:00Z', 'spend.cleared', { cap: 'month' }), ...v1.event };
    expect(header([event as PublicEvent]).capped).toMatchObject({ cap: 'month', limitUsd: 100 });
  });
});
