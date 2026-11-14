/**
 * A move's signal, as the dependency sense sends one: one move, one open ticket, whatever arrives for it, and its
 * severity the policy's reading of its worst finding with a fix, never lower than it was.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InboxSignal, type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { publicView } from '@software-factory/events/public';
import { DiskArtifacts, EventWriter, lastEnd, sendSignal } from '@software-factory/store';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BURST } from '../../../../policy/triage.ts';
import { type Database, freshDatabase } from '../../../store/test/database.ts';
import { startLine } from '../../../store/test/line.ts';
import { Triage } from '../../src/worker.ts';

let database: Database;
let writer: Sql;
let events: EventWriter;
const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
const quiet = { info: () => {}, warn: () => {} };
const at = '2026-11-13T05:30:00.000Z';

beforeAll(async () => {
  database = await freshDatabase('triage_moves');
  writer = database.as.triage;
  events = new EventWriter(writer, { kind: 'real', artifacts });
  await startLine(database.admin);
});
afterAll(() => database?.end());

beforeEach(async () => {
  await database.owner`update inbox set triaged_at = now(), outcome = 'counted' where triaged_at is null`;
  const open = await writer<{ work_item: string }[]>`
    select distinct o.work_item from events o
    where o.type = 'ticket.opened' and ${lastEnd(writer, 'o.work_item')} is distinct from 'work-item.closed'`;
  for (const { work_item } of open) await events.append([closed(work_item, 'discarded')]);
});

function closed(item: string, outcome: PayloadOf<'work-item.closed'>['outcome'], ts = at): NewEvent {
  return {
    id: crypto.randomUUID(),
    ts,
    work_item: item,
    type: 'work-item.closed',
    version: VERSIONS['work-item.closed'],
    actor: 'factory',
    summary: 'Closed for the test',
    payload: { outcome, reason: 'Closed for the test' },
    artifacts: [],
  } as NewEvent;
}

type Finding = Extract<NonNullable<InboxSignal['evidence']>[number], { kind: 'scan' }>['findings'][number];

const finding = (
  advisory: string,
  scanner: Finding['severity']['scanner'],
  fixed: string | null = '1.2.4',
): Finding => ({
  advisory,
  package: 'left-pad',
  severity: { scanner },
  ...(fixed !== null && { fixed }),
});

const none = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

/** A lockfile move's signal: its package, in npm, at one line of the app's lockfile. */
const move = (findings: Finding[], overrides: Partial<NonNullable<InboxSignal['move']>> = {}): InboxSignal => ({
  sense: 'dependency',
  check: 'the vulnerability scan',
  version: 'a'.repeat(40),
  symptom: 'vulnerable-dependency',
  move: {
    repository: 'the-roganator/cv-worlds-worst-website',
    name: 'left-pad',
    ecosystem: 'npm',
    from: '1.2.3',
    to: '1.2.4',
    pins: [{ file: 'pnpm-lock.yaml', line: 812 }],
    ...overrides,
  },
  evidence: [{ kind: 'scan', findings, rest: none }],
  observedAt: at,
  artifacts: [],
});

const triage = () =>
  new Triage({ sql: writer, events, judge: async () => ({}) as never, read: async () => null, log: quiet });

/** Sends a signal, and triages everything waiting. */
async function send(signal: InboxSignal, id: string = crypto.randomUUID()) {
  await sendSignal(database.owner, signal, id);
  const t = triage();
  const took = [];
  for (let next = await t.takeOne(); next !== 'idle'; next = await t.takeOne()) took.push(next);
  return took;
}

const typesOf = (item: string) =>
  writer<{ type: string }[]>`select type from events where work_item = ${item} order by seq`.then((rows) =>
    rows.map((r) => r.type),
  );

const ticketOf = async (name = 'left-pad') => {
  const [row] = await writer<{ work_item: string; payload: PayloadOf<'ticket.opened'>; public: unknown }[]>`
    select work_item, payload, public from events where type = 'ticket.opened'
      and payload->'fingerprint'->>'name' = ${name} order by seq desc limit 1`;
  return row;
};

const ratings = (item: string) =>
  writer<{ payload: PayloadOf<'ticket.rated'> }[]>`
    select payload from events where work_item = ${item} and type = 'ticket.rated' order by seq`.then((rows) =>
    rows.map((r) => r.payload),
  );

describe("a move's signal", () => {
  it('opens a work item of kind dependency-update with its pin, and its ticket, by its worst finding with a fix', async () => {
    // A Critical with no fix sets nothing: the Medium with one does.
    expect(
      await send(move([finding('GHSA-aaaa-bbbb-cccc', 'critical', null), finding('CVE-2026-1', 'medium')])),
    ).toEqual(['opened']);
    const ticket = await ticketOf();
    expect(ticket?.payload).toMatchObject({
      title: 'Move left-pad in `pnpm-lock.yaml`',
      category: 'security',
      severity: 'degraded',
      fingerprint: { name: 'left-pad', ecosystem: 'npm' },
    });
    const item = ticket?.work_item as string;
    expect(await typesOf(item)).toEqual([
      'work-item.opened',
      'signal.received',
      'ticket.opened',
      'work-item.summarised',
    ]);
    const [opened] = await writer<{ payload: PayloadOf<'work-item.opened'> }[]>`
      select payload from events where work_item = ${item} and type = 'work-item.opened'`;
    expect(opened?.payload).toMatchObject({
      kind: 'dependency-update',
      title: 'Move a package in `pnpm-lock.yaml`',
      dependency: { name: 'left-pad', ecosystem: 'npm', from: '1.2.3', to: '1.2.4', security: true },
    });
  });

  it('is counted on its ticket, with no event, when it says what the last said: the next day, or the sense restarted', async () => {
    const day = move([finding('CVE-2026-1', 'high')]);
    await send(day);
    const item = (await ticketOf())?.work_item as string;
    const before = await typesOf(item);
    // The next day's send, under its own id, says the same: counted.
    expect(await send({ ...day, observedAt: '2026-11-14T05:30:00.000Z' })).toEqual(['counted']);
    // The sense restarted sends the same signal under the same id: the inbox keeps the first.
    const id = crypto.randomUUID();
    expect(await send(day, id)).toEqual(['counted']);
    expect(await send(day, id)).toEqual([]);
    expect(await typesOf(item)).toEqual(before);
    // A deadline that moved is not a new finding.
    expect(await send(move([{ ...finding('CVE-2026-1', 'high'), deadline: '2026-11-20T00:00:00Z' }]))).toEqual([
      'counted',
    ]);
  });

  it('joins its ticket as evidence when its target or findings change, and raises the severity only when worse', async () => {
    await send(move([finding('CVE-2026-1', 'low')]));
    const ticket = await ticketOf();
    const item = ticket?.work_item as string;
    expect(ticket?.payload.severity).toBe('cosmetic');
    // A new target: evidence, and no rating, since its worst finding is no worse.
    expect(await send(move([finding('CVE-2026-1', 'low', '1.2.5')], { to: '1.2.5' }))).toEqual(['evidence']);
    expect(await ratings(item)).toEqual([]);
    // A worse finding: evidence, and the severity raised.
    expect(await send(move([finding('CVE-2026-1', 'low'), finding('CVE-2026-2', 'high')]))).toEqual(['evidence']);
    expect(await ratings(item)).toEqual([{ severity: 'broken', was: 'cosmetic' }]);
    // A better day joins too, and lowers nothing.
    expect(await send(move([finding('CVE-2026-1', 'medium')]))).toEqual(['evidence']);
    expect(await ratings(item)).toEqual([{ severity: 'broken', was: 'cosmetic' }]);
    // The same worse finding again, after a better day, is new evidence and raises nothing: it is broken already.
    expect(await send(move([finding('CVE-2026-1', 'low'), finding('CVE-2026-2', 'high')]))).toEqual(['evidence']);
    expect(await ratings(item)).toEqual([{ severity: 'broken', was: 'cosmetic' }]);
    expect((await typesOf(item)).filter((t) => t === 'ticket.opened')).toHaveLength(1);
  });

  it('opens a ticket for each package of the lockfile, named by the package', async () => {
    expect(await send(move([finding('CVE-2026-1', 'high')]))).toEqual(['opened']);
    expect(await send(move([finding('CVE-2026-3', 'high')], { name: 'is-even' }))).toEqual(['opened']);
    expect((await ticketOf('left-pad'))?.work_item).not.toBe((await ticketOf('is-even'))?.work_item);
  });

  it('is never held in a burst: a day of moves arrives together by design', async () => {
    const names = Array.from({ length: BURST.tickets + 3 }, (_, i) => `package-${i}`);
    for (const name of names) await sendSignal(database.owner, move([finding('CVE-2026-1', 'high')], { name }));
    const t = triage();
    const took = [];
    for (let next = await t.takeOne(); next !== 'idle'; next = await t.takeOne()) took.push(next);
    expect(took).toEqual(names.map(() => 'opened'));
  });

  it('opens a new ticket after its ticket was closed by hand, never swallowed by the closed one', async () => {
    const day = move([finding('CVE-2026-1', 'high')]);
    await send(day);
    const first = (await ticketOf())?.work_item as string;
    // As `make close-work-item` closes it: Martin's, discarded.
    await events.append([closed(first, 'discarded')]);
    expect(await send({ ...day, observedAt: '2026-11-14T05:30:00.000Z' })).toEqual(['opened']);
    expect((await ticketOf())?.work_item).not.toBe(first);
  });

  it('reopens its ticket closed as verified when seen after the close, and is counted when seen before', async () => {
    await send(move([finding('CVE-2026-1', 'medium')]));
    const item = (await ticketOf())?.work_item as string;
    await events.append([closed(item, 'verified', '2026-11-13T12:00:00.000Z')]);
    // Seen before the close: the pin the fix replaced.
    expect(await send(move([finding('CVE-2026-1', 'medium')]))).toEqual(['counted']);
    // Seen after it, and worse: the move is back.
    const later = { ...move([finding('CVE-2026-2', 'critical')]), observedAt: '2026-11-14T05:30:00.000Z' };
    expect(await send(later)).toEqual(['reopened']);
    expect((await typesOf(item)).slice(-3)).toEqual(['work-item.reopened', 'signal.received', 'ticket.rated']);
    const [reopened] = await writer<{ payload: PayloadOf<'work-item.reopened'>; public: { payload: object } }[]>`
      select payload, public from events where work_item = ${item} and type = 'work-item.reopened'`;
    expect(reopened?.payload).toMatchObject({ sense: 'dependency', move: { name: 'left-pad', ecosystem: 'npm' } });
    expect(reopened?.payload).not.toHaveProperty('route');
    expect(reopened?.public.payload).toMatchObject({ move: { name: 'a package', ecosystem: 'npm' } });
  });

  it('is public with no package and no advisory: its signal, its ticket and its work item', async () => {
    await send(move([finding('GHSA-aaaa-bbbb-cccc', 'high')]));
    const item = (await ticketOf())?.work_item as string;
    const rows = await writer<{ public: object }[]>`select public from events where work_item = ${item}`;
    const shown = JSON.stringify(rows.map((r) => r.public));
    expect(shown).not.toContain('left-pad');
    expect(shown).not.toContain('GHSA-aaaa-bbbb-cccc');
    expect(shown).toContain('Move a package in `pnpm-lock.yaml`');
    // A version's digits are in no field that could carry one: an event's id, which is random, may hold any digits.
    type Shown = {
      payload: {
        move?: { from: string; to: string; pins: { line: number }[] };
        dependency?: { from: string; to: string };
        evidence?: { kind: string; findings?: object[] }[];
      };
    };
    const payloads = rows.map((r) => (r.public as Shown).payload);
    const moved = payloads.flatMap((p) => (p.move ? [p.move] : []));
    expect(moved.length).toBeGreaterThan(0);
    for (const m of moved) expect([m.from, m.to, ...m.pins.map((pin) => pin.line)]).toEqual(['', '', 0]);
    for (const d of payloads.flatMap((p) => (p.dependency ? [p.dependency] : []))) {
      expect([d.from, d.to]).toEqual(['', '']);
    }
    const findings = payloads.flatMap((p) => p.evidence?.flatMap((e) => e.findings ?? []) ?? []);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(Object.keys(f)).not.toContain('fixed');
    // The public view is the event's own, made once at the append: the same as the view of its payload now.
    const [ticket] = await writer<{ payload: PayloadOf<'ticket.opened'>; public: { payload: object } }[]>`
      select payload, public from events where work_item = ${item} and type = 'ticket.opened'`;
    if (!ticket) throw new Error('No ticket');
    expect(ticket.public.payload).toEqual(
      publicView('ticket.opened', { summary: '', payload: ticket.payload, artifacts: [] } as never).payload,
    );
  });

  it('fails, never opening a ticket, when it names no symptom, or no scan for a vulnerability', async () => {
    const { symptom: _, ...nameless } = move([finding('CVE-2026-1', 'high')]);
    const bare = { ...move([finding('CVE-2026-1', 'high')]), evidence: [] };
    const tickets = () => writer`select 1 from events where type = 'ticket.opened'`.then((rows) => rows.length);
    const before = await tickets();
    for (const [signal, why] of [
      [nameless, 'names no dependency’s symptom'],
      [bare, 'carries no scan'],
    ] as const) {
      const id = crypto.randomUUID();
      // As a signal could reach the inbox past `sendSignal`'s own check.
      await database.owner`insert into inbox (id, sense, fingerprint, signal)
                           values (${id}, 'dependency', 'move npm left-pad', ${database.owner.json(signal as never)})`;
      expect(await triage().takeOne()).toBe('failed');
      const [row] = await database.owner<{ failure: string; triaged_at: Date | null }[]>`
        select failure, triaged_at from inbox where id = ${id}`;
      expect(row).toMatchObject({ triaged_at: null });
      expect(row?.failure).toContain(why);
      await database.owner`update inbox set triaged_at = now(), outcome = 'counted' where id = ${id}`;
    }
    expect(await tickets()).toBe(before);
  });
});
