/**
 * The morning after a soak: what the line left behind, read from the store and the cluster, and whether it is what
 * an unattended night on the local model should leave (milestone 5, task 15). `factory line soak-check` prints it.
 *
 * - No lease held past its expiry: a worker that let go of nothing it took.
 * - No runner Job or volume left for a work item that has ended, and no volume for one that has merged: each step's
 *   Jobs go when it ends, and a work item's volume when it merges or ends.
 * - Every event in the store valid against its type's schema, once upcast to the current version.
 * - The spend, from the gateway's audit log: each work item's within the profile's cap on one work item, with the total
 *   said too. A soak on the local model must spend nothing at all, and asks for that (`{ kind: 'none' }`).
 * - How many work items went round, by how each ended or where each waits, and how long each spent in each stage.
 *
 * The decision is `soakReport`, a pure function of what was read, so tests drive it with plain values. A stage's
 * time is read from the work item's events by the line's own `decide`, so it is the stage the line had it in.
 */
import { type RawEvent, upcast } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { isRedTeam, NAMESPACE, NOT_RED_TEAM } from '../runners/jobs.ts';
import type { Kube } from '../runners/kube.ts';
import { decide, fold, type LineEvent, type QueueStage } from './machine.ts';

/** A work item's row in the line's table. */
export interface LineRow {
  workItem: string;
  stage: QueueStage;
  takenAt: Date;
  heldBy: string | null;
  heldUntil: Date | null;
}

/** An event as the store holds it. */
export interface StoredEvent extends RawEvent {
  seq: number;
  ts: string;
}

/** A runner's Job or volume, by the work item its label names. */
export interface Runner {
  kind: 'job' | 'volume';
  name: string;
  workItem: string | undefined;
}

export interface InvalidEvent {
  seq: number;
  type: string;
  version: number;
  problem: string;
}

/** What was read for the report. */
export interface SoakFacts {
  now: Date;
  /** Work items taken onto the line from here on are the soak's. */
  since: Date;
  line: LineRow[];
  /** The events of each of the soak's work items, in order. */
  events: Map<string, StoredEvent[]>;
  /** How many events the store holds, and those that are not valid. */
  checked: number;
  invalid: InvalidEvent[];
  /** The runners' Jobs and volumes, or why they could not be read. */
  runners: Runner[] | { error: string };
  /** The gateway's audit log since `since`, by provider. */
  spend: { provider: string; calls: number; usd: number }[];
  /** What each work item with a call since `since` has spent in all, as the gateway counts it against its cap. */
  workItemSpend: { workItem: string; calls: number; usd: number }[];
}

/**
 * What a soak may spend: up to the profile's cap on each work item (`policy/spend.ts`), as a night on Claude does by
 * design, or nothing at all, as a night on the local model must.
 */
export type SpendLimit = { kind: 'capped'; profile: string; workItemUsd: number } | { kind: 'none' };

const STAGES = ['plan', 'build', 'waiting', 'gates', 'review', 'release', 'verify', 'held'] as const;
type TimedStage = (typeof STAGES)[number];

export interface SoakReport {
  ok: boolean;
  since: string;
  at: string;
  leases: { stuck: { workItem: string; stage: QueueStage; heldBy: string; heldUntil: string }[] };
  runners: { read: boolean; error?: string; jobs: number; volumes: number; left: Runner[] };
  events: { checked: number; invalid: number; first: InvalidEvent[] };
  spend: {
    ok: boolean;
    usd: number;
    calls: number;
    byProvider: { provider: string; calls: number; usd: number }[];
    limit: SpendLimit;
    /** The work items that spent more than the cap on one, with what each spent. */
    over: { workItem: string; usd: number }[];
  };
  workItems: {
    taken: number;
    /** Those that ended (`closed`), and where each of the others waits (`held: <cause>`, or a stage). */
    byEnd: Record<string, number>;
    /** Minutes in each stage, across the work items that spent any time there. */
    stages: Partial<Record<TimedStage, { items: number; medianMinutes: number; maxMinutes: number }>>;
    items: { workItem: string; end: string; minutes: Partial<Record<TimedStage, number>> }[];
  };
}

/** Why an event is not valid as its type's current version, or null if it is. */
export function problemOf(event: RawEvent): string | null {
  const read = upcast(event);
  if (!read.ok) return read.reason === 'unknown-type' ? 'a type this factory does not know' : 'a newer version';
  const schema = PAYLOADS[read.event.type as keyof typeof PAYLOADS];
  const parsed = schema.safeParse(read.event.payload);
  if (parsed.success) return null;
  const [issue] = parsed.error.issues;
  return `${issue?.path.join('.') || 'payload'}: ${issue?.message ?? 'not valid'}`;
}

/** The facts the line decides on that no event carries: the soak reads stages, not the next step, so any will do. */
const FACTS = { issue: 1, failures: 0, failure: null };

/**
 * Minutes a work item spent in each stage after it was taken onto the line, until it ended or `until`. After each of
 * its events it is in the stage `decide` puts it in, until the next.
 */
export function stageMinutes(
  events: readonly StoredEvent[],
  takenAt: number,
  until: number,
): Partial<Record<TimedStage, number>> {
  const read = events.flatMap((event) => {
    const current = upcast(event);
    return current.ok ? [{ at: Date.parse(event.ts), event: current.event as unknown as LineEvent }] : [];
  });
  const minutes: Partial<Record<TimedStage, number>> = {};
  const seen: LineEvent[] = [];
  let stage: QueueStage = 'plan';
  let from = takenAt;
  const spend = (to: number) => {
    if (stage !== 'ended' && to > from) minutes[stage] = (minutes[stage] ?? 0) + (to - from) / 60_000;
    from = Math.max(from, to);
  };
  for (const { at, event } of read) {
    seen.push(event);
    if (at <= takenAt) {
      stage = decide(seen, FACTS).stage;
      continue;
    }
    spend(Math.min(at, until));
    stage = decide(seen, FACTS).stage;
  }
  spend(until);
  return minutes;
}

/** A work item's state, as the line folds it from its events. */
const stateOf = (events: readonly StoredEvent[]) =>
  fold(
    events.flatMap((event) => {
      const read = upcast(event);
      return read.ok ? [read.event as unknown as LineEvent] : [];
    }),
  );

/** How a work item ended, or where it waits. */
export function endOf(events: readonly StoredEvent[], row: LineRow): string {
  const state = stateOf(events);
  if (state.closed) return 'closed';
  if (state.hold) return `held: ${state.hold.cause}`;
  return row.stage;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

export function soakReport(facts: SoakFacts, limit: SpendLimit): SoakReport {
  const now = facts.now.getTime();
  const stuck = facts.line
    .filter((row) => row.heldBy !== null && row.heldUntil !== null && row.heldUntil.getTime() < now)
    .map((row) => ({
      workItem: row.workItem,
      stage: row.stage,
      heldBy: row.heldBy ?? '',
      heldUntil: row.heldUntil?.toISOString() ?? '',
    }));

  const ended = new Set(facts.line.filter((row) => row.stage === 'ended').map((row) => row.workItem));
  const merged = new Set(
    facts.line
      .filter((row) => row.stage !== 'ended' && stateOf(facts.events.get(row.workItem) ?? []).merged)
      .map((row) => row.workItem),
  );
  const leftFor = (r: Runner) =>
    r.workItem !== undefined && (ended.has(r.workItem) || (r.kind === 'volume' && merged.has(r.workItem)));
  const runners = Array.isArray(facts.runners)
    ? {
        read: true,
        jobs: facts.runners.filter((r) => r.kind === 'job').length,
        volumes: facts.runners.filter((r) => r.kind === 'volume').length,
        left: facts.runners.filter(leftFor),
      }
    : { read: false, error: facts.runners.error, jobs: 0, volumes: 0, left: [] };

  const usd = facts.spend.reduce((sum, row) => sum + row.usd, 0);
  const calls = facts.spend.reduce((sum, row) => sum + row.calls, 0);
  const over =
    limit.kind === 'capped'
      ? facts.workItemSpend
          .filter((row) => row.usd > limit.workItemUsd)
          .map((row) => ({ workItem: row.workItem, usd: round(row.usd, 6) }))
      : [];
  const spendOk = limit.kind === 'none' ? usd === 0 : !over.length;

  const soak = facts.line.filter((row) => row.takenAt.getTime() >= facts.since.getTime());
  const items = soak.map((row) => {
    const events = facts.events.get(row.workItem) ?? [];
    const end = endOf(events, row);
    const last = Date.parse(events.at(-1)?.ts ?? '') || now;
    const minutes = stageMinutes(events, row.takenAt.getTime(), end === 'closed' ? last : now);
    return {
      workItem: row.workItem,
      end,
      minutes: Object.fromEntries(Object.entries(minutes).map(([stage, m]) => [stage, round(m)])),
    };
  });
  const byEnd: Record<string, number> = {};
  for (const item of items) byEnd[item.end] = (byEnd[item.end] ?? 0) + 1;
  const stages: SoakReport['workItems']['stages'] = {};
  for (const stage of STAGES) {
    const spent = items.flatMap((item) => (item.minutes[stage] === undefined ? [] : [item.minutes[stage]]));
    if (spent.length)
      stages[stage] = {
        items: spent.length,
        medianMinutes: round(median(spent)),
        maxMinutes: round(Math.max(...spent)),
      };
  }

  const report: SoakReport = {
    ok: false,
    since: facts.since.toISOString(),
    at: facts.now.toISOString(),
    leases: { stuck },
    runners,
    events: { checked: facts.checked, invalid: facts.invalid.length, first: facts.invalid.slice(0, 20) },
    spend: { ok: spendOk, usd: round(usd, 6), calls, byProvider: facts.spend, limit, over },
    workItems: { taken: items.length, byEnd, stages, items },
  };
  report.ok = !stuck.length && runners.read && !runners.left.length && !facts.invalid.length && spendOk;
  return report;
}

/** The report as a few lines for a person: each check, then what went round. */
export function soakText(report: SoakReport): string {
  const mark = (good: boolean) => (good ? 'ok ' : 'NO ');
  const { leases, runners, events, spend, workItems } = report;
  const lines = [
    `Soak since ${report.since}, read at ${report.at}: ${report.ok ? 'all clear' : 'something to look at'}.`,
    `${mark(!leases.stuck.length)} leases: ${leases.stuck.length ? `${leases.stuck.length} held past expiry (${leases.stuck.map((l) => `#${l.workItem} by ${l.heldBy}`).join(', ')})` : 'none held past expiry'}`,
    runners.read
      ? `${mark(!runners.left.length)} runners: ${runners.jobs} jobs and ${runners.volumes} volumes; ${runners.left.length ? `left for ended or merged work items: ${runners.left.map((r) => `${r.kind} ${r.name}`).join(', ')}` : 'none left for an ended or merged work item'}`
      : `NO  runners: not read (${runners.error})`,
    `${mark(!events.invalid)} events: ${events.checked} checked, ${events.invalid ? `${events.invalid} not valid, first #${events.first[0]?.seq} ${events.first[0]?.type} v${events.first[0]?.version}: ${events.first[0]?.problem}` : 'all valid'}`,
    `${mark(spend.ok)} spend: $${spend.usd.toFixed(4)} over ${spend.calls} calls${spend.byProvider.length ? ` (${spend.byProvider.map((p) => `${p.provider} ${p.calls}, $${p.usd.toFixed(4)}`).join('; ')})` : ''}; ${spendLimitText(spend)}`,
    `    work items taken: ${workItems.taken}${
      Object.keys(workItems.byEnd).length
        ? ` (${Object.entries(workItems.byEnd)
            .map(([end, n]) => `${n} ${end}`)
            .join(', ')})`
        : ''
    }`,
    ...Object.entries(workItems.stages).map(
      ([stage, s]) =>
        `    ${stage.padEnd(6)} ${s.items} items, median ${s.medianMinutes} min, longest ${s.maxMinutes} min`,
    ),
  ];
  return lines.join('\n');
}

function spendLimitText({ limit, over }: SoakReport['spend']): string {
  if (limit.kind === 'none') return 'none allowed';
  const cap = `the ${limit.profile} profile's $${limit.workItemUsd.toFixed(2)} cap on a work item`;
  if (!over.length) return `each work item within ${cap}`;
  return `over ${cap}: ${over.map((o) => `#${o.workItem} $${o.usd.toFixed(4)}`).join(', ')}`;
}

const LIST = z.object({
  items: z.array(
    z.object({ metadata: z.object({ name: z.string(), labels: z.record(z.string(), z.string()).optional() }) }),
  ),
});

const WORK_ITEM_LABEL = 'factory.mrogan.dev/work-item';

/** Reads what the report needs: the line's table, the soak's events, every event's validity, the spend, the runners. */
export async function soakFacts({
  sql,
  kube,
  now,
  since,
}: {
  sql: Sql;
  kube: () => Kube;
  now: Date;
  since: Date;
}): Promise<SoakFacts> {
  const line = (
    await sql<
      { work_item: string; stage: QueueStage; taken_at: Date; held_by: string | null; held_until: Date | null }[]
    >`
      select work_item, stage, taken_at, held_by, held_until from line order by taken_at`
  ).map((row) => ({
    workItem: row.work_item,
    stage: row.stage,
    takenAt: row.taken_at,
    heldBy: row.held_by,
    heldUntil: row.held_until,
  }));
  const soak = line.filter((row) => row.takenAt.getTime() >= since.getTime()).map((row) => row.workItem);
  const events = new Map<string, StoredEvent[]>();
  if (soak.length) {
    const rows = await sql<
      { seq: string; ts: Date; work_item: string; type: string; version: number; payload: unknown }[]
    >`
      select seq, ts, work_item, type, version, payload from events where work_item in ${sql(soak)} order by seq`;
    for (const row of rows) {
      const list = events.get(row.work_item) ?? [];
      list.push({
        seq: Number(row.seq),
        ts: row.ts.toISOString(),
        type: row.type,
        version: row.version,
        payload: row.payload,
      });
      events.set(row.work_item, list);
    }
  }

  let checked = 0;
  const invalid: InvalidEvent[] = [];
  const cursor = sql<{ seq: string; type: string; version: number; payload: unknown }[]>`
    select seq, type, version, payload from events order by seq`.cursor(1000);
  for await (const rows of cursor) {
    for (const row of rows) {
      checked += 1;
      const event = { seq: Number(row.seq), type: row.type, version: row.version, payload: row.payload };
      const problem = problemOf(event);
      if (problem) invalid.push({ ...event, problem });
    }
  }

  const spend = await sql<{ provider: string; calls: number; usd: number }[]>`
    select provider, count(*)::int as calls, coalesce(sum(cost_usd), 0)::float8 as usd
    from model_calls where at >= ${since} group by provider order by provider`;
  const workItemSpend = await sql<{ workItem: string; calls: number; usd: number }[]>`
    select work_item as "workItem", count(*)::int as calls, coalesce(sum(cost_usd), 0)::float8 as usd
    from model_calls
    where work_item in (select work_item from model_calls where at >= ${since} and work_item is not null)
    group by work_item order by work_item`;

  let runners: SoakFacts['runners'];
  try {
    const client = kube();
    // What the red-team harness makes in runners is its own, and no runner the line left behind.
    const list = async (kind: Runner['kind'], path: string) =>
      ((await client.get(`${path}?labelSelector=${encodeURIComponent(NOT_RED_TEAM)}`, LIST))?.items ?? [])
        .filter((item) => !isRedTeam(item.metadata.labels))
        .map((item) => ({
          kind,
          name: item.metadata.name,
          workItem: item.metadata.labels?.[WORK_ITEM_LABEL],
        }));
    runners = [
      ...(await list('job', `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`)),
      ...(await list('volume', `/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims`)),
    ];
  } catch (error) {
    runners = { error: error instanceof Error ? error.message : String(error) };
  }

  return { now, since, line, events, checked, invalid, runners, spend: [...spend], workItemSpend: [...workItemSpend] };
}
