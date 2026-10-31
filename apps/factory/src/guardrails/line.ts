/**
 * Guardrail 9's proofs, from the store as the proofs' role reads it, and the drill.
 *
 * - `rollback`: the last real rollback of a canary, by the line's role alone (which alone may append it), with its
 *   analysis's verdict verbatim, who rolled it back and how long ago. None, and it does not hold: the drill that makes
 *   one is the rollback switch's (task 25).
 * - `stop-the-line`, in two parts. The drill, against the line as it is, after Martin says yes: `make stop-the-line`;
 *   then the line's stop is recorded by one of his roles, no pod is left in `runners`, the gateway refused an agent's
 *   call because the line had stopped, and the line took no work item while it was stopped; then
 *   `make start-the-line`, whatever happened. And the last real canary a stop aborted, by the line's role, and how
 *   long ago: none, and it does not hold.
 *
 * Stopping loses the step in hand, which runs again from its last event when the line starts (`line/worker.ts`).
 * The gateway refuses a call only from an agent whose step is running, so the drill can show its refusal only when an
 * agent is running as the line stops: Martin is told how many are before he says yes.
 */
import { randomUUID } from 'node:crypto';
import { upcast } from '@software-factory/events';
import { storeClock } from '@software-factory/store';
import type { Sql } from 'postgres';
import { MARTINS_ROLES } from '../../../../policy/store-grants.ts';

export interface Taken {
  held: boolean;
  output: string;
}

interface Row {
  seq: string;
  type: string;
  version: number;
  payload: Record<string, unknown>;
  appended_at: Date;
}

/** The events of a type the line's role appended, upcast, the newest first. */
async function byTheLine(sql: Sql, type: string): Promise<(Row & { payload: Record<string, unknown> })[]> {
  const rows = await sql<Row[]>`
    select seq, type, version, payload, appended_at from events
    where type = ${type} and appended_by = 'factory_line' order by seq desc`;
  return rows.map((row) => {
    const result = upcast({ type: row.type, version: row.version, payload: row.payload });
    return { ...row, payload: result.ok ? (result.event.payload as Record<string, unknown>) : row.payload };
  });
}

/** How long ago, in the largest whole unit that fits. */
export function age(at: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 120) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export async function rollback(sql: Sql, now: Date): Promise<Taken> {
  const last = (await byTheLine(sql, 'release.rolled-back')).find((e) => e.payload.dryRun === false);
  if (!last) {
    return {
      held: false,
      output: 'No real canary has been rolled back in the store: the rollback switch’s drill makes one.',
    };
  }
  const p = last.payload;
  return {
    held: true,
    output: [
      `Release ${String(p.release)}: version ${String(p.version)} rolled back to ${String(p.restored)} at ${String(p.weight)}% of the traffic, by ${String(p.by ?? 'analysis')}, ${age(last.appended_at, now)} (${last.appended_at.toISOString()}).`,
      `The analysis: ${String(p.reason)}`,
      `Failed: ${JSON.stringify(p.failed ?? [])}`,
    ].join('\n'),
  };
}

/** The last real canary a stop aborted, and how long ago: the drill's second part. */
export async function abortedByStop(sql: Sql, now: Date): Promise<Taken> {
  const last = (await byTheLine(sql, 'release.aborted')).find((e) => e.payload.by === 'stop');
  if (!last) {
    return {
      held: false,
      output:
        'No canary in flight has been aborted by Stop the line in the store: the rollback switch’s drill makes one.',
    };
  }
  const p = last.payload;
  return {
    held: true,
    output: `Release ${String(p.release)}: the canary of version ${String(p.version)} aborted by Stop the line at ${String(p.abortedAt)}, back to ${String(p.restored)}, ${age(last.appended_at, now)}.`,
  };
}

/** What the drill needs of the world: the store, the cluster, Martin, the Makefile and a clock. */
export interface Drill {
  sql: Sql;
  /** The pods in `runners`, by name, with the runner part (`agent` or `prepare`) each is. */
  runnerPods(): Promise<{ name: string; part?: string }[]>;
  ask(question: string): Promise<boolean>;
  /** `make stop-the-line` or `make start-the-line`, with a reason; true when it exited 0. */
  make(target: 'stop-the-line' | 'start-the-line', reason: string): Promise<boolean>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  say(line: string): void;
}

/** How long the drill waits for the runners' pods to go, and for the gateway's refusal. */
export const PODS_GONE_MS = 180_000;
export const REFUSED_MS = 60_000;
/** How long the line stays stopped at least: three of its passes, so that one that took anything would have. */
export const STOPPED_MS = 45_000;
const POLL_MS = 3_000;

export type DrillTaken = Taken | { declined: string };

export async function stopTheLine(drill: Drill): Promise<DrillTaken> {
  const { sql } = drill;
  const before = await drill.runnerPods();
  const agents = before.filter((p) => p.part === 'agent');
  drill.say(
    `The drill stops the line, as make stop-the-line does: every step in hand is lost, and runs again when it starts, and a canary in flight is aborted. ${agents.length} agent pod(s) and ${before.length - agents.length} other pod(s) are running in runners now${
      agents.length
        ? ''
        : ': with no agent running, nothing calls the gateway to be refused, and the proof will not hold'
    }.`,
  );
  if (!(await drill.ask('Stop the line now, and start it again after the checks?'))) {
    return { declined: 'Martin did not say yes: the drill was not taken, and nothing is recorded for it.' };
  }

  // The store's clock, which stamps what the drill reads, not the Mac's, which may differ from it: as its text, to the
  // microsecond, for the bounds the queries compare, as Date would cut it to the millisecond.
  const storeNow = () => storeClock(sql);
  const from = await storeNow();
  // This drill's own stop, told from any other by its reason.
  const reason = `make guardrails: the stop-the-line drill ${randomUUID().slice(0, 8)}`;
  const lines: string[] = [];
  let held = true;
  const fail = (line: string) => {
    held = false;
    lines.push(`✗ ${line}`);
  };
  // The line is started again once, whether the drill ends or is interrupted.
  let starting: Promise<boolean> | undefined;
  const start = () => {
    starting ??= drill.make('start-the-line', 'make guardrails: the stop-the-line drill is over');
    return starting;
  };
  // Interrupted from here on, the process would end before the finally below: start the line first, then end.
  const interrupted = async (signal: NodeJS.Signals) => {
    drill.say(`Interrupted (${signal}) during the drill: starting the line again.`);
    drill.say(
      (await start().catch(() => false))
        ? 'The line started again.'
        : 'make start-the-line failed: the line is still stopped; run make start-the-line.',
    );
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    if (!(await drill.make('stop-the-line', reason))) {
      fail('make stop-the-line failed');
    }
    const stops = await sql<{ seq: string; at: string; appended_by: string }[]>`
      select seq, to_char(appended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, appended_by
      from events
      where type = 'line.stopped' and appended_by = any(${MARTINS_ROLES}) and appended_at >= ${from}::timestamptz
        and payload->>'reason' = ${reason}
      order by seq limit 1`;
    const stop = stops[0];
    if (!stop) fail('no line.stopped by Martin’s roles was recorded for this drill');
    else lines.push(`✓ The line stopped at ${stop.at}, recorded by ${stop.appended_by}.`);
    const at = stop?.at ?? from;
    const since = (to: string) => Date.parse(to) - Date.parse(at);

    // Listed again once stopped, so a pod started after the prompt is seen, and an agent then running is waited for.
    const atStop = await drill.runnerPods();
    const seen = new Map([...before, ...atStop].map((p) => [p.name, p]));
    const agentsSeen = [...seen.values()].filter((p) => p.part === 'agent');
    // The runners' pods go, and the gateway refuses an agent's call, side by side.
    const started = drill.now().getTime();
    let left = atStop;
    let refusal: { output: string; appended_at: Date } | undefined;
    while (drill.now().getTime() - started < PODS_GONE_MS) {
      if (left.length) left = await drill.runnerPods();
      if (!refusal && agentsSeen.length && drill.now().getTime() - started < REFUSED_MS) {
        [refusal] = await sql<{ output: string; appended_at: Date }[]>`
          select payload->>'output' as output, appended_at from events
          where type = 'action.refused' and appended_by = 'factory_gateway' and payload->>'mechanism' = 'gateway'
            and payload->'guardrails' @> '[9]'::jsonb and appended_at >= ${at}::timestamptz
          order by seq limit 1`;
      }
      const waitingForRefusal = !refusal && agentsSeen.length > 0 && drill.now().getTime() - started < REFUSED_MS;
      if (!left.length && !waitingForRefusal) break;
      await drill.sleep(POLL_MS);
    }
    if (left.length) fail(`pods still in runners: ${left.map((p) => p.name).join(', ')}`);
    else lines.push(`✓ No pod is left in runners (${seen.size} were running at the prompt or the stop).`);
    if (refusal) {
      lines.push(`✓ The gateway refused an agent's call at ${refusal.appended_at.toISOString()}: ${refusal.output}`);
    } else if (agentsSeen.length)
      fail(`the gateway recorded no refusal of an agent's call within ${REFUSED_MS / 1000}s`);
    else
      fail(
        'no agent was running at the stop, so none called the gateway to be refused: take the drill again while one runs',
      );

    const waited = since(await storeNow());
    if (waited < STOPPED_MS) await drill.sleep(STOPPED_MS - waited);
    const stoppedFor = since(await storeNow());
    const taken = await sql<{ work_item: string; taken_at: Date }[]>`
      select work_item, taken_at from line where taken_at >= ${at}::timestamptz order by taken_at`;
    if (taken.length) fail(`work items taken while the line was stopped: ${taken.map((t) => t.work_item).join(', ')}`);
    else lines.push(`✓ No work item was taken in the ${Math.round(stoppedFor / 1000)}s the line was stopped.`);
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    if (await start()) {
      lines.push('✓ The line started again.');
    } else {
      fail('make start-the-line failed: the line is still stopped; run make start-the-line');
    }
  }
  const aborted = await abortedByStop(sql, drill.now());
  if (aborted.held) lines.push(`✓ ${aborted.output}`);
  else fail(aborted.output);
  return { held, output: lines.join('\n') };
}
