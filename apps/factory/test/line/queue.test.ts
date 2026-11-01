import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, issueJobToken, nextWorkItem, storeClock } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { type Pending, Queue } from '../../src/line/queue.ts';

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('queue');
});
afterEach(() => database?.end());

const writer = () =>
  new EventWriter(database.as.line, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });

/** An event of a work item's, as its actor appends it. */
const event = (workItem: string, actor: string, type: NewEvent['type'], payload: object) =>
  ({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type,
    version: VERSIONS[type],
    actor,
    summary: `${type} for the test`,
    payload,
    artifacts: [],
  }) as NewEvent;

/** A ticket as triage opens one, with its severity. */
async function ticket(severity: 'broken' | 'degraded' | 'cosmetic', route: string): Promise<string> {
  const workItem = await nextWorkItem(database.as.triage);
  await writer().append([
    event(workItem, 'triage', 'work-item.opened', { kind: 'defect-fix', title: 'Server errors', sample: false }),
    event(workItem, 'triage', 'ticket.opened', {
      title: `Server errors on ${route}`,
      category: 'errors',
      severity,
      fingerprint: { route, class: 'server-error' },
      traces: [],
    }),
  ]);
  return workItem;
}

/** A work item the line worked on, ended: a step of it had started. */
const end = (workItem: string) =>
  database.as.line`update line set stage = 'ended', steps = greatest(steps, 1) where work_item = ${workItem}`;

/**
 * The line's look at a ticket as it took it: gone, it closes on that look, and its row ends; otherwise its issue opens,
 * for the planner.
 */
async function lookedAtTake(workItem: string, outcome: 'cleared' | 'persists' | 'unsure'): Promise<void> {
  const look = {
    for: 'take',
    outcome,
    check: 'errors on /search',
    carried: [],
    ...(outcome === 'unsure' ? { why: 'the sense could not be asked' } : { version: 'a'.repeat(40) }),
  };
  const closed = { outcome: 'verified', reason: 'Gone as the line took it.' };
  await writer().append([
    event(workItem, 'factory', 'signal.rechecked', look),
    ...(outcome === 'cleared' ? [event(workItem, 'factory', 'work-item.closed', closed)] : []),
  ]);
  if (outcome === 'cleared') await database.as.line`update line set stage = 'ended' where work_item = ${workItem}`;
  else await new Queue(database.as.line, 'test').setIssue(workItem, 40 + Number(workItem.slice(-2)));
}

const pending: Pending = {
  agent: 'reviewer',
  round: 1,
  job: 'reviewer-1001-1',
  since: 7,
  commit: 'a'.repeat(40),
  base: 'b'.repeat(40),
  handback: { ending: 'finished', patch: '', note: 'Reviewed.', turns: 4, session: null },
  called: [],
  begun: [],
  done: {},
  tries: 0,
  failure: null,
  retryAt: null,
};

describe('a kept handback', () => {
  it('keeps what each write gave back, nothing among it, and stays kept', async () => {
    const queue = new Queue(database.as.line, 'test');
    await database.as.line`insert into line (work_item, stage) values ('1001', 'review')`;
    await queue.keep('1001', pending);
    await queue.begun('1001', 'check-run');
    await queue.done('1001', 'check-run', 42);
    await queue.begun('1001', 'review');
    // A write that gives back nothing, as a review does.
    await queue.done('1001', 'review', null);
    const kept = (await queue.get('1001'))?.effects;
    expect(kept).toMatchObject({ begun: ['check-run', 'review'], done: { 'check-run': 42, review: null } });
  });
});

describe('a failed step', () => {
  it('keeps why, cut between characters and marked, for a hold reason to quote', async () => {
    const queue = new Queue(database.as.line, 'test');
    await database.as.line`insert into line (work_item, stage) values ('1001', 'review')`;
    const why = `${'a'.repeat(498)}\u{1F600} and more`;
    await queue.failed('1001', why);
    expect((await queue.get('1001'))?.failure).toBe(`${'a'.repeat(498)}…`);
    await queue.keep('1001', pending);
    await queue.effectsFailed('1001', why, new Date());
    expect((await queue.get('1001'))?.effects?.failure).toBe(`${'a'.repeat(498)}…`);
  });
});

describe("a step's number", () => {
  it('counts on from the last, and from the job tokens of a row made afresh, so no job name comes round again', async () => {
    const queue = new Queue(database.as.line, 'test');
    await database.as.line`insert into line (work_item, stage) values ('1001', 'plan')`;
    expect(await queue.startStep('1001')).toBe(1);
    expect(await queue.startStep('1001')).toBe(2);
    // The row taken away by hand (only the owner may), and made again: its job tokens stay, the fourth the last.
    for (const job of ['planner-1001-1-1', 'planner-1001-1-2', 'coder-1001-1-4']) {
      await issueJobToken(database.as.line, { job, workItem: '1001', agent: job.split('-')[0] as string });
    }
    // Another work item's tokens count for nothing here, nor names the line does not make.
    await issueJobToken(database.as.line, { job: 'coder-1002-1-9', workItem: '1002', agent: 'coder' });
    for (const job of ['coder-1001-by-hand', 'coder-1001-1730000000000']) {
      await issueJobToken(database.as.line, { job, workItem: '1001', agent: 'coder' });
    }
    await database.owner`delete from line where work_item = '1001'`;
    await database.as.line`insert into line (work_item, stage) values ('1001', 'plan')`;
    expect(await queue.startStep('1001')).toBe(5);
    expect(await queue.startStep('1001')).toBe(6);
    await expect(queue.startStep('1003')).rejects.toThrow('not on the line');
  });
});

describe('a queue of one work item', () => {
  it('sees only that work item on the line, and the whole line sees them all', async () => {
    await database.as
      .line`insert into line (work_item, stage) values ('1001', 'build'), ('1002', 'plan'), ('1003', 'review')`;
    const one = new Queue(database.as.line, 'test', { only: '1002' });
    expect((await one.free()).map((i) => i.workItem)).toEqual(['1002']);
    expect(await one.claim('1002', 60)).toMatchObject({ workItem: '1002' });
    expect(await one.free()).toEqual([]);
    const all = new Queue(database.as.line, 'other');
    expect((await all.free()).map((i) => i.workItem).sort()).toEqual(['1001', '1003']);
  });
});

describe('a queue with a limit', () => {
  it('takes tickets by its rule until it has taken that many in all, and none after, though it restarts', async () => {
    const cosmetic = await ticket('cosmetic', '/');
    const broken = await ticket('broken', '/search');
    const degraded = await ticket('degraded', '/products');
    const two = new Queue(database.as.line, 'test', { take: 2 });
    expect(await two.admit()).toBe(broken);
    await end(broken);
    expect(await two.admit()).toBe(degraded);
    await end(degraded);
    // Two have come onto the line: the cosmetic ticket waits, for this queue and for one that starts afresh.
    expect(await two.admit()).toBeUndefined();
    expect(await new Queue(database.as.line, 'again', { take: 2 }).admit()).toBeUndefined();
    expect(await new Queue(database.as.line, 'all').admit()).toBe(cosmetic);
  });

  it('does not count a ticket that closed on the look as it was taken, but one that went on to the planner', async () => {
    const broken = await ticket('broken', '/search');
    const degraded = await ticket('degraded', '/products');
    const cosmetic = await ticket('cosmetic', '/');
    const unsure = await ticket('cosmetic', '/about');
    const two = new Queue(database.as.line, 'test', { take: 2 });
    expect(await two.admit()).toBe(broken);
    // Gone as the line took it, and closed with nothing spent: the line only looked at it.
    await lookedAtTake(broken, 'cleared');
    expect(await two.admit()).toBe(degraded);
    // Still seen: on to the planner, whose step starts, and it counts.
    await lookedAtTake(degraded, 'persists');
    await two.startStep(degraded);
    await end(degraded);
    expect(await two.admit()).toBe(cosmetic);
    // The sense could not tell: on to Plan, with its issue, and it counts, its step started or not.
    await lookedAtTake(cosmetic, 'unsure');
    await end(cosmetic);
    expect(await two.admit()).toBeUndefined();
    expect(await new Queue(database.as.line, 'all').admit()).toBe(unsure);
  });

  it('counts a ticket that has not ended, though its look at take cleared', async () => {
    const broken = await ticket('broken', '/search');
    await ticket('degraded', '/products');
    const one = new Queue(database.as.line, 'test', { take: 1 });
    expect(await one.admit()).toBe(broken);
    // Gone as it was taken, but held before it closed on that look or its issue opened: it has not ended, and counts.
    const look = { for: 'take', outcome: 'cleared', check: 'errors on /search', carried: [], version: 'a'.repeat(40) };
    await writer().append([event(broken, 'factory', 'signal.rechecked', look)]);
    await database.as.line`update line set stage = 'held' where work_item = ${broken}`;
    expect(await one.admit()).toBeUndefined();
  });

  it('counts a ticket the look cleared once a step had started for it', async () => {
    const broken = await ticket('broken', '/search');
    await ticket('degraded', '/products');
    const one = new Queue(database.as.line, 'test', { take: 1 });
    expect(await one.admit()).toBe(broken);
    await one.startStep(broken);
    await lookedAtTake(broken, 'cleared');
    expect(await one.admit()).toBeUndefined();
  });

  it('counts the work items already on the line, and takes none at all with a limit of none', async () => {
    await ticket('broken', '/search');
    expect(await new Queue(database.as.line, 'test', { take: 0 }).admit()).toBeUndefined();
    await database.owner`insert into line (work_item, stage, steps) values ('1001', 'ended', 1)`;
    expect(await new Queue(database.as.line, 'test', { take: 1 }).admit()).toBeUndefined();
    expect(await new Queue(database.as.line, 'test', { take: 2 }).admit()).toBeDefined();
  });
});

describe('a queue set to take what Martin chose', () => {
  it('counts the next few from when he chose them, and takes from then on whatever was taken before', async () => {
    await database.owner`insert into line (work_item, stage, steps) values ('9001', 'ended', 1), ('9002', 'ended', 1)`;
    // As the admin service stamps it, to the microsecond; the two ended came onto the line the microsecond before.
    const since = await storeClock(database.owner);
    await database.owner`update line set taken_at = ${since}::text::timestamptz - interval '1 microsecond'`;
    const broken = await ticket('broken', '/search');
    const degraded = await ticket('degraded', '/products');
    const cosmetic = await ticket('cosmetic', '/');
    const queue = new Queue(database.as.line, 'test', { take: 2 });
    // LINE_TAKE's two are spent; the next one, counted from now, takes one more.
    expect(await queue.admit()).toBeUndefined();
    queue.takes({ only: null, take: { most: 1, since } });
    expect(await queue.admit()).toBe(broken);
    // It closed on the look as it was taken: not one of his few.
    await lookedAtTake(broken, 'cleared');
    expect(await queue.admit()).toBe(degraded);
    await end(degraded);
    expect(await queue.admit()).toBeUndefined();
    // Every ticket.
    queue.takes({ only: null, take: null });
    expect(await queue.admit()).toBe(cosmetic);
  });

  it('sees only the one work item he chose, from when he chose it', async () => {
    await database.as.line`insert into line (work_item, stage) values ('1001', 'build'), ('1002', 'plan')`;
    const queue = new Queue(database.as.line, 'test');
    expect((await queue.free()).map((i) => i.workItem).sort()).toEqual(['1001', '1002']);
    queue.takes({ only: '1001', take: null });
    expect((await queue.free()).map((i) => i.workItem)).toEqual(['1001']);
  });
});

/**
 * An improvement, as the admin service opens it with Martin's request: or, with `by`, one a worker opened before row
 * security refused it, or one with no request.
 */
async function improvement({ by = 'admin' }: { by?: 'admin' | 'triage' | 'no-request' } = {}): Promise<string> {
  const opener = by === 'triage' ? database.as.triage : database.admin;
  const workItem = await nextWorkItem(opener);
  const event = (type: 'work-item.opened' | 'improvement.requested', payload: object) =>
    ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: workItem,
      type,
      version: VERSIONS[type],
      actor: 'martin',
      summary: `${type} for the test`,
      payload,
      artifacts: [],
    }) as NewEvent;
  const events = [
    event('work-item.opened', { kind: 'improvement', title: 'Delivery dates', sample: false }),
    ...(by === 'no-request' ? [] : [event('improvement.requested', { words: 'Delivery dates.', steppedUp: true })]),
  ];
  const kind = { kind: 'real', artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))) } as const;
  if (by !== 'triage') await new EventWriter(opener, kind).append(events);
  else {
    await database.owner`alter table events disable row level security`;
    try {
      await new EventWriter(opener, kind).append(events);
    } finally {
      await database.owner`alter table events enable row level security`;
    }
  }
  return workItem;
}

describe('an improvement Martin asked for', () => {
  it('waits behind every open ticket not yet taken, whatever their ages, and goes oldest first', async () => {
    const older = await improvement();
    const newer = await improvement();
    const cosmetic = await ticket('cosmetic', '/');
    const queue = new Queue(database.as.line, 'test');
    expect(await queue.admit()).toBe(cosmetic);
    await end(cosmetic);
    expect(await queue.admit()).toBe(older);
    await end(older);
    // A ticket opened since goes before the improvement still waiting.
    const broken = await ticket('broken', '/search');
    expect(await queue.admit()).toBe(broken);
    await end(broken);
    expect(await queue.admit()).toBe(newer);
  });

  it('is taken at once with just one, and counted like a ticket in the next few', async () => {
    await ticket('broken', '/search');
    const asked = await improvement();
    const one = new Queue(database.as.line, 'test', { only: asked });
    expect(await one.admit()).toBe(asked);
    const queue = new Queue(database.as.line, 'other', { take: 1 });
    expect(await queue.admit()).toBeUndefined();
  });

  it('is never taken unless Martin both opened it and asked for it, nor made one by a ticket', async () => {
    const forged = await improvement({ by: 'triage' });
    const unasked = await improvement({ by: 'no-request' });
    const queue = new Queue(database.as.line, 'test');
    expect(await queue.admit()).toBeUndefined();
    expect(await new Queue(database.as.line, 'one', { only: forged }).admit()).toBeUndefined();
    expect(await new Queue(database.as.line, 'one', { only: unasked }).admit()).toBeUndefined();
    // A worker's ticket on his improvement does not make it a ticket: it waits as an improvement.
    const asked = await improvement();
    const later = await ticket('cosmetic', '/');
    await writer().append([
      {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        work_item: asked,
        type: 'ticket.opened',
        version: VERSIONS['ticket.opened'],
        actor: 'triage',
        summary: 'A ticket on an improvement',
        payload: {
          title: 'Broken',
          category: 'errors',
          severity: 'broken',
          fingerprint: { route: '/', class: 'server-error' },
          traces: [],
        },
        artifacts: [],
      } as NewEvent,
    ]);
    expect(await queue.admit()).toBe(later);
    await end(later);
    expect(await queue.admit()).toBe(asked);
  });

  it('is never taken once it has closed', async () => {
    const asked = await improvement();
    await writer().append([
      {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        work_item: asked,
        type: 'work-item.closed',
        version: VERSIONS['work-item.closed'],
        actor: 'factory',
        summary: 'Closed',
        payload: { outcome: 'turned-off', reason: 'Not now' },
        artifacts: [],
      } as NewEvent,
    ]);
    expect(await new Queue(database.as.line, 'test').admit()).toBeUndefined();
  });
});

describe('a spec waiting for overlapping work', () => {
  it('waits at a stage of its own, which leaves room for the next ticket', async () => {
    const first = await ticket('broken', '/search');
    const queue = new Queue(database.as.line, 'test');
    expect(await queue.admit()).toBe(first);
    const next = await ticket('degraded', '/products');
    expect(await queue.admit()).toBeUndefined();
    await database.as.line`update line set stage = 'waiting' where work_item = ${first}`;
    expect(await queue.admit()).toBe(next);
  });
});

describe('work at Release and Verify', () => {
  it('waits there on the line, handed out as any other, and leaves room for the next ticket', async () => {
    await database.as.line`insert into line (work_item, stage) values ('1001', 'release'), ('1002', 'verify')`;
    const queue = new Queue(database.as.line, 'test');
    expect((await queue.free()).map((i) => i.workItem)).toEqual(['1001', '1002']);
    expect(await queue.claim('1001', 60)).toMatchObject({ workItem: '1001', stage: 'release' });
    await queue.release('1001', 'verify');
    expect(await queue.get('1001')).toMatchObject({ stage: 'verify' });
    // Neither is in Plan or Build, so the line takes the next ticket.
    const next = await ticket('broken', '/search');
    expect(await queue.admit()).toBe(next);
  });

  it('refuses a stage the line does not have', async () => {
    await expect(database.as.line`insert into line (work_item, stage) values ('1001', 'shipped')`).rejects.toThrow(
      /line_stage_check/,
    );
  });
});

describe('a reopened work item', () => {
  /** Appends a close or a reopening, as the line and triage write them. */
  const closeOrReopen = (workItem: string, type: 'work-item.closed' | 'work-item.reopened', outcome = 'verified') =>
    writer().append({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: workItem,
      type,
      version: VERSIONS[type],
      actor: type === 'work-item.closed' ? 'factory' : 'triage',
      summary: `${type} for the test`,
      payload:
        type === 'work-item.closed'
          ? { outcome, reason: 'The probe passed twice in a row' }
          : {
              sense: 'probe',
              check: 'pages load',
              route: '/search',
              version: 'v0.9.6',
              reason: 'It came back',
              dryRun: false,
            },
      artifacts: [],
    } as NewEvent);

  it('comes back into Plan from its end, afresh, whatever else is on the line and whatever the limit', async () => {
    const reopened = await ticket('degraded', '/search');
    const queue = new Queue(database.as.line, 'test', { take: 1 });
    expect(await queue.admit()).toBe(reopened);
    await database.as.line`update line set stage = 'ended', failures = 2, failure = 'It failed', session = 'abc'
                          where work_item = ${reopened}`;
    await closeOrReopen(reopened, 'work-item.closed');
    expect(await queue.reopened()).toEqual([]);
    await closeOrReopen(reopened, 'work-item.reopened');
    // Not straight after its end, while its volume may still be going.
    expect(await queue.reopened()).toEqual([]);
    await database.as.line`update line set moved_at = moved_at - interval '2 minutes' where work_item = ${reopened}`;
    // Another ticket fills Plan, and the limit is reached: the reopened one comes back all the same, and only once.
    await database.as.line`insert into line (work_item, stage) values ('1999', 'plan')`;
    expect((await queue.reopened()).map((item) => item.workItem)).toEqual([reopened]);
    expect(await queue.revive(reopened)).toBe(true);
    expect(await queue.revive(reopened)).toBe(false);
    expect(await queue.get(reopened)).toMatchObject({
      stage: 'plan',
      failures: 0,
      failure: null,
      session: null,
      effects: null,
    });
    expect(await queue.reopened()).toEqual([]);
    // Reopened again, after another verified close, it comes back again.
    await closeOrReopen(reopened, 'work-item.closed');
    await closeOrReopen(reopened, 'work-item.reopened');
    expect(await queue.revive(reopened, { forgetIssue: true })).toBe(true);
    expect(await queue.get(reopened)).toMatchObject({ stage: 'plan', issue: null });
  });

  it('is handed to nobody from where it was, when it reopened before its end, until it comes back', async () => {
    const queue = new Queue(database.as.line, 'test');
    const workItem = await ticket('broken', '/search');
    await database.as.line`insert into line (work_item, stage) values (${workItem}, 'verify')`;
    await closeOrReopen(workItem, 'work-item.closed');
    await closeOrReopen(workItem, 'work-item.reopened');
    expect(await queue.free()).toEqual([]);
    expect(await queue.claim(workItem, 60)).toBeUndefined();
    expect((await queue.reopened()).map((item) => item.workItem)).toEqual([workItem]);
    // Not while another holds it.
    await database.as.line`update line set held_by = 'other', held_until = now() + interval '1 minute'
                          where work_item = ${workItem}`;
    expect(await queue.reopened()).toEqual([]);
    expect(await queue.revive(workItem)).toBe(false);
    await database.as.line`update line set held_by = null, held_until = null where work_item = ${workItem}`;
    expect(await queue.revive(workItem)).toBe(true);
    expect((await queue.free()).map((item) => item.workItem)).toEqual([workItem]);
  });

  it('is open to the queue again: the last of its closes and reopenings decides', async () => {
    const queue = new Queue(database.as.line, 'test');
    const closed = await ticket('broken', '/search');
    await closeOrReopen(closed, 'work-item.closed');
    expect(await queue.admit()).toBeUndefined();
    // Reopened before the line ever took it, it is taken as any open ticket is.
    await closeOrReopen(closed, 'work-item.reopened');
    expect(await queue.admit()).toBe(closed);
  });

  it('is left alone by a queue of another work item, and stays ended while it is closed', async () => {
    const workItem = await ticket('broken', '/search');
    await database.owner`insert into line (work_item, stage, moved_at) values (${workItem}, 'ended', now() - interval '1 hour')`;
    await closeOrReopen(workItem, 'work-item.closed');
    await closeOrReopen(workItem, 'work-item.reopened');
    expect(await new Queue(database.as.line, 'test', { only: '1999' }).reopened()).toEqual([]);
    await closeOrReopen(workItem, 'work-item.closed', 'no-change');
    expect(await new Queue(database.as.line, 'test').reopened()).toEqual([]);
    expect(await new Queue(database.as.line, 'test').revive(workItem)).toBe(false);
  });
});

describe('migration 0008', () => {
  const MIGRATION = new URL('../../../../packages/store/migrations/0008_line-release-verify.sql', import.meta.url);

  /** A work item that ended on the line before Release, with the events that ended it. */
  async function ended(types: ('pull-request.merged' | 'work-item.closed')[], number = 17): Promise<string> {
    const workItem = await nextWorkItem(database.as.triage);
    const payloads = {
      'work-item.opened': { kind: 'defect-fix', title: 'Server errors', sample: false },
      'pull-request.merged': { number, commit: 'd'.repeat(40), by: 'martin' },
      'work-item.closed': { outcome: 'no-change', reason: 'Closed unmerged' },
    };
    await writer().append(
      (['work-item.opened', ...types] as const).map(
        (type) =>
          ({
            id: crypto.randomUUID(),
            ts: new Date().toISOString(),
            work_item: workItem,
            type,
            version: VERSIONS[type],
            actor: 'factory',
            summary: `${type} for the test`,
            payload: payloads[type],
            artifacts: [],
          }) as NewEvent,
      ),
    );
    await database.as.line`insert into line (work_item, stage) values (${workItem}, 'ended')`;
    return workItem;
  }

  it('moves a work item that merged and never closed to Release, and leaves those that closed or never shipped', async () => {
    const merged = await ended(['pull-request.merged']);
    const closed = await ended(['pull-request.merged', 'work-item.closed']);
    const unmerged = await ended(['work-item.closed']);
    // A dry run's pull requests are numbered from a billion up: its merge never shipped.
    const dryRun = await ended(['pull-request.merged'], 1_000_000_003);
    await database.owner.unsafe(readFileSync(MIGRATION, 'utf-8'));
    const queue = new Queue(database.as.line, 'test');
    expect(await queue.get(merged)).toMatchObject({ stage: 'release' });
    expect(await queue.get(closed)).toMatchObject({ stage: 'ended' });
    expect(await queue.get(unmerged)).toMatchObject({ stage: 'ended' });
    expect(await queue.get(dryRun)).toMatchObject({ stage: 'ended' });
  });
});
