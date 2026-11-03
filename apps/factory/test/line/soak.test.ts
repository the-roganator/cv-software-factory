import { VERSIONS } from '@software-factory/events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { RED_TEAM_LABEL } from '../../../../policy/attacks.ts';
import {
  endOf,
  type LineRow,
  problemOf,
  type SoakFacts,
  type SpendLimit,
  type StoredEvent,
  soakFacts,
  soakReport,
  soakText,
  stageMinutes,
} from '../../src/line/soak.ts';
import type { Kube } from '../../src/runners/kube.ts';

const at = (time: string) => `2026-10-06T${time}:00.000Z`;
const COMMIT = 'c'.repeat(40);
let seq = 0;

const event = (time: string, type: keyof typeof VERSIONS, payload: unknown): StoredEvent => ({
  seq: ++seq,
  ts: at(time),
  type,
  version: VERSIONS[type],
  payload,
});

/**
 * A work item a dry run takes round: planned, built, through the gates, held at review, merged, waiting at Release for
 * the dry run's release, and verified.
 */
const RELEASE = { release: '6d8f9c7b54', version: 'v0.9.4', previous: 'v0.9.3', watched: true, dryRun: true };

const round = (start: string) => [
  event(start, 'ticket.opened', { title: 'Server errors on /search', severity: 'broken' }),
  event('22:20', 'spec.written', { outcome: 'Search answers.', criteria: [], scope: ['src/'], risks: [] }),
  event('22:50', 'pull-request.pushed', { number: 1_000_000_001, branch: 'factory/1-search', attempt: 1 }),
  event('22:51', 'gates.started', { pullRequest: 1_000_000_001, commit: COMMIT, checks: ['Unit tests'] }),
  event('22:53', 'gates.finished', {
    pullRequest: 1_000_000_001,
    commit: COMMIT,
    conclusion: 'passed',
    passed: 1,
    failed: [],
  }),
  event('23:00', 'hold.started', { stage: 'review', kind: 'held', cause: 'failures', reason: 'The reviewer failed' }),
  event('23:10', 'pull-request.merged', { number: 1_000_000_001, commit: 'd'.repeat(40), by: 'factory' }),
  event('23:20', 'release.started', RELEASE),
  event('23:30', 'release.promoted', RELEASE),
  event('23:40', 'work-item.closed', { outcome: 'verified', reason: 'Cleared' }),
];

const row = (workItem: string, taken: string, more: Partial<LineRow> = {}): LineRow => ({
  workItem,
  stage: 'ended',
  takenAt: new Date(at(taken)),
  heldBy: null,
  heldUntil: null,
  ...more,
});

describe('a work item’s minutes in each stage', () => {
  it('counts from when the line took it, in the stage the line’s own decision had it in, until it ended', () => {
    expect(stageMinutes(round('21:00'), Date.parse(at('22:00')), Date.parse(at('23:59')))).toEqual({
      plan: 20,
      build: 30,
      gates: 3,
      review: 7,
      held: 10,
      release: 20,
      verify: 10,
    });
  });

  it('counts a merged work item as on the line, waiting at Release, until a release carries it', () => {
    const merged = round('21:00').slice(0, 7);
    expect(stageMinutes(merged, Date.parse(at('22:00')), Date.parse(at('23:59')))).toMatchObject({
      held: 10,
      release: 49,
    });
    const deploy = event('23:10', 'hold.started', {
      stage: 'release',
      kind: 'approval',
      cause: 'deploy',
      reason: 'Merged',
    });
    expect(endOf([...merged, deploy], row('1', '22:00', { stage: 'held' }))).toBe('held: deploy');
  });

  it('counts the minutes a spec waits for overlapping work', () => {
    const waits = [
      ...round('21:00').slice(0, 2),
      event('22:25', 'wait.started', { on: ['1001'], files: ['src/'], reason: 'Waits for #1001' }),
    ];
    expect(stageMinutes(waits, Date.parse(at('22:00')), Date.parse(at('23:25')))).toEqual({
      plan: 20,
      build: 5,
      waiting: 60,
    });
  });

  it('counts a work item still on the line until now', () => {
    const waiting = round('21:00').slice(0, 4);
    expect(stageMinutes(waiting, Date.parse(at('22:00')), Date.parse(at('23:00')))).toEqual({
      plan: 20,
      build: 30,
      gates: 10,
    });
  });
});

describe('an event’s validity', () => {
  it('is its payload against its type’s current schema, once upcast', () => {
    expect(problemOf({ type: 'line.stopped', version: 1, payload: { reason: 'Martin stopped the line' } })).toBeNull();
    expect(problemOf({ type: 'line.stopped', version: 1, payload: {} })).toMatch(/^reason: /);
    expect(problemOf({ type: 'spend.cleared', version: 1, payload: { cap: 'day' } })).toBeNull();
    expect(problemOf({ type: 'moon.landed', version: 1, payload: {} })).toBe('a type this factory does not know');
    expect(problemOf({ type: 'line.stopped', version: 99, payload: {} })).toBe('a newer version');
  });
});

/** The local profile's cap on a work item, as `policy/spend.ts` has it while milestone 5 measures. */
const CAPPED: SpendLimit = { kind: 'capped', profile: 'local', workItemUsd: 5 };
const NONE: SpendLimit = { kind: 'none' };

describe('the morning’s report', () => {
  const facts = (more: Partial<SoakFacts> = {}): SoakFacts => ({
    now: new Date(at('23:59')),
    since: new Date(at('21:30')),
    line: [row('1', '22:00'), row('2', '22:00', { stage: 'plan' }), row('0', '20:00')],
    events: new Map([
      ['1', round('21:00')],
      ['2', round('21:00').slice(0, 1)],
    ]),
    checked: 120,
    invalid: [],
    runners: [{ kind: 'volume', name: 'work-2', workItem: '2' }],
    spend: [{ provider: 'local', calls: 41, usd: 0 }],
    workItemSpend: [
      { workItem: '1', calls: 30, usd: 0 },
      { workItem: '2', calls: 11, usd: 0 },
    ],
    ...more,
  });

  it('is all clear for a night that left nothing behind and spent nothing', () => {
    const report = soakReport(facts(), NONE);
    expect(report.ok).toBe(true);
    expect(report.workItems).toMatchObject({ taken: 2, byEnd: { closed: 1, plan: 1 } });
    expect(report.workItems.stages.plan).toEqual({ items: 2, medianMinutes: (20 + 119) / 2, maxMinutes: 119 });
    expect(report.spend).toMatchObject({ usd: 0, calls: 41 });
    expect(soakText(report).split('\n')[0]).toContain('all clear');
  });

  it('names a lease held past its expiry, a runner left for an ended work item, an event not valid, and any spend when none is allowed', () => {
    const report = soakReport(
      facts({
        line: [
          row('1', '22:00'),
          row('2', '22:00', { stage: 'build', heldBy: 'line-a', heldUntil: new Date(at('23:00')) }),
        ],
        runners: [
          { kind: 'job', name: 'reviewer-1-1-3-agent', workItem: '1' },
          { kind: 'volume', name: 'work-1', workItem: '1' },
          { kind: 'volume', name: 'work-2', workItem: '2' },
        ],
        invalid: [{ seq: 7, type: 'line.stopped', version: 1, problem: 'reason: Required' }],
        spend: [{ provider: 'anthropic', calls: 2, usd: 0.04 }],
        workItemSpend: [{ workItem: '1', calls: 2, usd: 0.04 }],
      }),
      NONE,
    );
    expect(report.ok).toBe(false);
    expect(report.leases.stuck).toEqual([
      { workItem: '2', stage: 'build', heldBy: 'line-a', heldUntil: '2026-10-06T23:00:00.000Z' },
    ]);
    expect(report.runners.left.map((r) => r.name)).toEqual(['reviewer-1-1-3-agent', 'work-1']);
    expect(report.events).toMatchObject({ checked: 120, invalid: 1 });
    const text = soakText(report);
    expect(text).toContain('NO  leases: 1 held past expiry (#2 by line-a)');
    expect(text).toContain('left for ended or merged work items: job reviewer-1-1-3-agent, volume work-1');
    expect(text).toContain('#7 line.stopped v1: reason: Required');
    expect(text).toContain('NO  spend: $0.0400 over 2 calls (anthropic 2, $0.0400); none allowed');
  });

  it('names a volume left for a merged work item waiting for its release, but not one still at work', () => {
    const merged = round('21:00').slice(0, 7);
    const report = soakReport(
      facts({
        line: [row('1', '22:00', { stage: 'held' }), row('2', '22:00', { stage: 'plan' })],
        events: new Map([
          ['1', merged],
          ['2', round('21:00').slice(0, 1)],
        ]),
        runners: [
          { kind: 'volume', name: 'work-1', workItem: '1' },
          { kind: 'volume', name: 'work-2', workItem: '2' },
        ],
      }),
      NONE,
    );
    expect(report.ok).toBe(false);
    expect(report.runners.left.map((r) => r.name)).toEqual(['work-1']);
  });

  it('is clear for a night on Claude whose work items each spent within the cap on one, and says the total', () => {
    const report = soakReport(
      facts({
        spend: [{ provider: 'anthropic', calls: 60, usd: 7.5 }],
        workItemSpend: [
          { workItem: '1', calls: 35, usd: 4.25 },
          { workItem: '2', calls: 25, usd: 3.25 },
        ],
      }),
      CAPPED,
    );
    expect(report.ok).toBe(true);
    expect(report.spend).toMatchObject({ ok: true, usd: 7.5, calls: 60, over: [] });
    expect(soakText(report)).toContain(
      "ok  spend: $7.5000 over 60 calls (anthropic 60, $7.5000); each work item within the local profile's $5.00 cap on a work item",
    );
  });

  it('names a work item that spent more than the cap on one', () => {
    const report = soakReport(
      facts({
        spend: [{ provider: 'anthropic', calls: 60, usd: 8.5 }],
        workItemSpend: [
          { workItem: '1', calls: 40, usd: 5.25 },
          { workItem: '2', calls: 20, usd: 3.25 },
        ],
      }),
      CAPPED,
    );
    expect(report.ok).toBe(false);
    expect(report.spend.over).toEqual([{ workItem: '1', usd: 5.25 }]);
    expect(soakText(report)).toContain(
      "NO  spend: $8.5000 over 60 calls (anthropic 60, $8.5000); over the local profile's $5.00 cap on a work item: #1 $5.2500",
    );
  });

  it('still allows nothing at all when asked, however small', () => {
    const report = soakReport(
      facts({
        spend: [{ provider: 'anthropic', calls: 1, usd: 0.0001 }],
        workItemSpend: [{ workItem: '1', calls: 1, usd: 0.0001 }],
      }),
      NONE,
    );
    expect(report.ok).toBe(false);
    expect(soakReport(facts({ spend: [{ provider: 'anthropic', calls: 1, usd: 0.0001 }] }), CAPPED).ok).toBe(true);
  });

  it('is not clear when it could not read the cluster', () => {
    const report = soakReport(facts({ runners: { error: 'No service account here' } }), CAPPED);
    expect(report.ok).toBe(false);
    expect(soakText(report)).toContain('NO  runners: not read (No service account here)');
  });
});

describe('the spend, as read from the gateway’s audit log', () => {
  let database: Database;
  beforeEach(async () => {
    database = await freshDatabase('soak');
  });
  afterEach(() => database?.end());

  const call = (workItem: string | null, usd: number, at: string, provider = 'anthropic') => database.as.gateway`
    insert into model_calls (id, at, agent, work_item, provider, model, question_set, cost_usd, duration_ms, outcome)
    values (${crypto.randomUUID()}, ${at}, 'coder', ${workItem}, ${provider}, 'claude', 'messages', ${usd}, 1000,
            'answered')`;

  it('totals the calls since the soak began, and gives each of its work items all it has spent, as the gateway counts', async () => {
    await call('7', 1.5, at('20:00')); // before the soak, on a work item it went on with
    await call('7', 2, at('22:00'));
    await call('8', 0.25, at('22:30'));
    await call('6', 4, at('20:00')); // a work item the soak did not touch
    await call(null, 0.1, at('22:40'), 'typesafe'); // triage, for no work item
    const facts = await soakFacts({
      sql: database.as.line,
      kube: () => {
        throw new Error('No cluster here');
      },
      now: new Date(at('23:59')),
      since: new Date(at('21:30')),
    });
    expect(facts.spend).toEqual([
      { provider: 'anthropic', calls: 2, usd: 2.25 },
      { provider: 'typesafe', calls: 1, usd: 0.1 },
    ]);
    expect(facts.workItemSpend).toEqual([
      { workItem: '7', calls: 2, usd: 3.5 },
      { workItem: '8', calls: 1, usd: 0.25 },
    ]);
  });
});

describe('the runners, as read from the cluster', () => {
  let database: Database;
  beforeEach(async () => {
    database = await freshDatabase('soak_runners');
  });
  afterEach(() => database?.end());

  it('counts none of the red-team harness’s pods or Jobs as a runner, whatever else their labels say', async () => {
    const asked: string[] = [];
    const runner = { 'factory.mrogan.dev/runner': 'agent', 'factory.mrogan.dev/work-item': '7' };
    const attack = { ...runner, [RED_TEAM_LABEL]: 'egress' };
    const kube = {
      async get<T>(path: string) {
        asked.push(path);
        const [where, query = ''] = path.split('?');
        const selector = decodeURIComponent(new URLSearchParams(query).get('labelSelector') ?? '');
        const items = where?.endsWith('/jobs')
          ? [
              { metadata: { name: 'coder-7-1-1-agent', labels: runner } },
              { metadata: { name: 'attack-egress', labels: attack } },
            ]
          : [{ metadata: { name: 'work-7', labels: runner } }];
        // Each, as an API that took no notice of the selector would give them: the line reads the labels too.
        expect(selector).toBe(`!${RED_TEAM_LABEL}`);
        return { items } as T;
      },
    } as unknown as Kube;
    const facts = await soakFacts({
      sql: database.as.line,
      kube: () => kube,
      now: new Date(at('23:59')),
      since: new Date(at('21:30')),
    });
    expect(facts.runners).toEqual([
      { kind: 'job', name: 'coder-7-1-1-agent', workItem: '7' },
      { kind: 'volume', name: 'work-7', workItem: '7' },
    ]);
    expect(asked).toHaveLength(2);
  });
});
