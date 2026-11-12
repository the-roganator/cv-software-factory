/**
 * The line's OpenTelemetry metrics: how work items move through it, and Release and Verify. Until `telemetry.ts`
 * starts an SDK these are no-ops, so tests need none. Every attribute is from a closed list (a stage, an agent, a
 * provider, an outcome, a cause, a sense): never a work item, a job or a release, which would make a series of each.
 *
 * But one: `line.hold.age` has a series for each hold that waits for Martin, named by its work item and, where he
 * answers it on GitHub, its pull request, so the alert for a new hold can say which and link it. Those series are as
 * many as the holds that waited for him since the line started, a handful, and each ends with its hold, reading 0, and goes when the line next
 * starts; both labels are numbers the store assigned, never a title, a reason or anything a visitor wrote. Each hold's
 * alert reads it, and makes links of those numbers (`alerts/rules.ts`, `holdRule`).
 *
 * - What happened is counted where the line records it, and only once the store has taken the event, so a series and
 *   the events cannot disagree: holds and verifications in the line's append, releases in the release watch's.
 * - How many work items are at each stage, and how long the oldest has been there, are read from the store's `line`
 *   table each time the SDK collects, not counted in the process: a line that restarts reports the same, and two
 *   replicas report the same figure, so a reader takes the `max` of them, never the `sum`.
 * - How long a work item spent at a stage is recorded as it leaves it, by whichever worker moves it.
 * - Each count starts at 0 as the line starts, for every label set it can count (`zeroCounts`): Prometheus's
 *   `increase` and `changes` read nothing into a series' first sample, so a series that started at 1 would lose the
 *   first step, hold, release or verification of each kind after every restart.
 * - What the line is carrying, the work items it has taken and should be moving, by stage, with the oldest's time
 *   there and the stage's limit in force (`observeTaken`), and how long any lease has been held past its expiry
 *   (`observeLeases`), are read from the store too: the alerts that the line is stuck read them
 *   (`alerts/rules.ts`, `factoryRules`).
 */
import { type Attributes, type BatchObservableResult, metrics } from '@opentelemetry/api';
import { HOLD_CAUSES, type HoldCause, type PayloadOf, SENSES, STAGES } from '@software-factory/events';
import { fromMartin, lineStopped } from '@software-factory/store';
import type { Sql } from 'postgres';
import { STUCK } from '../../../../policy/stuck.ts';
import { capsInForce } from './caps.ts';
import { openHolds } from './holds.ts';
import { type LineAgent, type QueueStage, STAGE_OF } from './machine.ts';

const meter = metrics.getMeter('factory-line');

export type OpenStage = Exclude<QueueStage, 'ended'>;

/** Every stage but `ended`: a record, so a stage added to the queue's and left out here fails to type-check. */
const EVERY_STAGE: Record<OpenStage, true> = {
  plan: true,
  build: true,
  waiting: true,
  gates: true,
  review: true,
  release: true,
  verify: true,
  held: true,
};

/** The stages a work item waits at on the line: every one the `line` table allows but `ended`. */
export const OPEN_STAGES = Object.keys(EVERY_STAGE) as OpenStage[];

/**
 * How a step ended, as the line counts it:
 * - `done`: its result was acted on, and recorded;
 * - `failed` or `max-turns`: it counts against the step (it handed back nothing, ended failing, its result was
 *   refused, or it ran out of turns), and it runs again up to a limit;
 * - `capped`: it ended at a spend cap set while it ran, and runs again when the cap clears;
 * - `stopped`: the line stopped it, and it runs again when the line starts;
 * - `held`: the pin step's move needs a file only Martin may change, so no agent ran, and the work item waits for him;
 * - `stale`: something was recorded meanwhile that made its result out of date, and it runs again;
 * - `effects-failed`: its result could not be put in GitHub or the store as often as the line tries, and the work item
 *   holds;
 * - `errored`: something outside the agent failed (a read of GitHub, the runners, the store), the line logs it, and the
 *   next pass tries the step again.
 *
 * A result whose effects failed and wait to be tried again has not ended yet: it is counted when they end.
 */
export type StepEnding =
  | 'done'
  | 'failed'
  | 'max-turns'
  | 'capped'
  | 'stopped'
  | 'held'
  | 'stale'
  | 'effects-failed'
  | 'errored';

/** Every way a step ends: a record, so an ending added to `StepEnding` and left out here fails to type-check. */
const EVERY_ENDING: Record<StepEnding, true> = {
  done: true,
  failed: true,
  held: true,
  'max-turns': true,
  capped: true,
  stopped: true,
  stale: true,
  'effects-failed': true,
  errored: true,
};

/** Every outcome a verification has, the same way. */
const EVERY_VERIFICATION: Record<PayloadOf<'verification.finished'>['outcome'], true> = {
  cleared: true,
  persists: true,
};

/** The holds triage starts, which are triage's to count (or a hold that recorded no cause): the line starts the rest. */
const NOT_THE_LINES: readonly HoldCause[] = ['suggestion', 'finding', 'burst', 'environment', 'unknown'];

/** How a release ended: each of the release events that ends one. */
export const RELEASE_ENDINGS = {
  'release.promoted': 'promoted',
  'release.rolled-back': 'rolled-back',
  'release.aborted': 'aborted',
  'release.errored': 'errored',
} as const;

const steps = meter.createCounter('line.steps', {
  description: 'Agents’ steps the line ran, by agent, provider and how they ended',
});

const holds = meter.createCounter('line.holds', {
  description: 'Holds for Martin the line started, by cause and the stage held at',
});

const releases = meter.createCounter('line.releases', {
  description: 'Releases the line recorded the end of, by how they ended and whether a dry run’s',
});

const verifications = meter.createCounter('line.verifications', {
  description:
    'Verifications after a release, by sense, whether the signal cleared or persists, and whether a dry run’s',
});

// A stage can last a minute or a week (a hold over a weekend), so the buckets run from a minute to a week.
const stageDuration = meter.createHistogram('line.stage.duration', {
  description: 'How long a work item was at a stage, recorded as it left it',
  unit: 's',
  advice: { explicitBucketBoundaries: [60, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 86_400, 172_800, 604_800] },
});

const workItems = meter.createObservableGauge('line.work_items', {
  description: 'Work items at each stage of the line, as the store has them',
});

const oldest = meter.createObservableGauge('line.stage.oldest', {
  description: 'How long the work item longest at each stage has been there; 0 with none',
  unit: 's',
});

export function countStep(agent: LineAgent, provider: string, outcome: StepEnding): void {
  steps.add(1, { agent, provider, outcome });
}

/**
 * A work item left `from` after `seconds` there. Its end is no stage, and a move to the same stage is none, unless it
 * starts its time there afresh (`again`), as a reopened work item taken back into Plan does.
 */
export function leftStage(from: QueueStage, to: QueueStage, seconds: number, again = false): void {
  if ((from === to && !again) || from === 'ended') return;
  stageDuration.record(Math.max(0, seconds), { stage: from });
}

/** An event the line drafted, as far as counting it goes. */
export interface Counted {
  type: string;
  payload: unknown;
}

/** Counts the holds and verifications among events the store has taken from the line. */
export function countRecorded(events: readonly Counted[]): void {
  for (const event of events) {
    if (event.type === 'hold.started') {
      const { cause, stage } = event.payload as PayloadOf<'hold.started'>;
      holds.add(1, { cause, stage });
    } else if (event.type === 'verification.finished') {
      const v = event.payload as PayloadOf<'verification.finished'>;
      verifications.add(1, { sense: v.sense ?? 'unknown', outcome: v.outcome, dry_run: v.dryRun === true });
    }
  }
}

/** A release's end, once. */
export interface Ending {
  type: keyof typeof RELEASE_ENDINGS;
  release: string;
  dryRun: boolean;
}

/** Each release's end among events, once however many work items they record it on. */
export function endingsIn(events: readonly Counted[]): Ending[] {
  const endings = new Map<string, Ending>();
  for (const { type, payload } of events) {
    if (!Object.hasOwn(RELEASE_ENDINGS, type)) continue;
    const { release, dryRun } = payload as { release: string; dryRun?: boolean };
    endings.set(`${type} ${release}`, { type: type as Ending['type'], release, dryRun: dryRun === true });
  }
  return [...endings.values()];
}

/** What the line counts by, as it starts. */
export interface Counting {
  /** The provider each agent's calls go to, as the line counts its steps. */
  providerOf: (agent: LineAgent) => string;
  /** Whether the line runs a dry run, whose releases and verifications it counts with `dry_run` true. */
  dryRun: boolean;
}

/**
 * Starts every count at 0 for each label set the line can count, so the first of each after a restart is counted:
 * each agent's step by its provider and each way it ends; each hold the line starts, by cause, at each stage from Plan
 * on; each release's end; and each sense's verification. A real release can end under a dry run too, so `dry_run`
 * false always, and true only on a dry run. Adding 0 again is harmless.
 */
export function zeroCounts({ providerOf, dryRun }: Counting): void {
  const agents = Object.keys(STAGE_OF) as LineAgent[];
  for (const agent of agents) {
    for (const outcome of Object.keys(EVERY_ENDING)) steps.add(0, { agent, provider: providerOf(agent), outcome });
  }
  const stages = STAGES.slice(STAGES.indexOf('plan'));
  for (const cause of HOLD_CAUSES.filter((c) => !NOT_THE_LINES.includes(c))) {
    for (const stage of stages) holds.add(0, { cause, stage });
  }
  for (const dry_run of dryRun ? [false, true] : [false]) {
    for (const outcome of Object.values(RELEASE_ENDINGS)) releases.add(0, { outcome, dry_run });
    // `unknown` for one that names no sense: a dry run's whose ticket no sense saw, or one recorded before senses were.
    for (const sense of [...SENSES, 'unknown']) {
      for (const outcome of Object.keys(EVERY_VERIFICATION)) verifications.add(0, { sense, outcome, dry_run });
    }
  }
}

/** A release's end, the first time the store records it: on however many work items it carried, it is one. */
export function countReleaseEnd({ type, dryRun }: Ending): void {
  releases.add(1, { outcome: RELEASE_ENDINGS[type], dry_run: dryRun });
}

/**
 * Reports the work items at each stage, and the oldest's time there, from the store, each time the SDK collects,
 * until the function it gives back is called. Every stage is reported, with none as 0, so a stage that empties reads
 * as empty rather than as gone. A read that fails reports nothing that time.
 */
export function observeStages(sql: Sql): () => void {
  const callback = async (result: BatchObservableResult) => {
    const rows = await sql<{ stage: OpenStage; n: number; oldest: number }[]>`
      select stage, count(*)::int as n,
             extract(epoch from clock_timestamp() - min(moved_at))::float8 as oldest
      from line where stage <> 'ended' group by stage`;
    const by = new Map(rows.map((row) => [row.stage, row]));
    for (const stage of OPEN_STAGES) {
      const row = by.get(stage);
      result.observe(workItems, row?.n ?? 0, { stage });
      result.observe(oldest, Math.max(0, row?.oldest ?? 0), { stage });
    }
  };
  meter.addBatchObservableCallback(callback, [workItems, oldest]);
  return () => meter.removeBatchObservableCallback(callback, [workItems, oldest]);
}

/**
 * A work item's or a pull request's number, as the store and GitHub give them: all a hold's series may carry, and all
 * its alert's rule admits (`alerts/rules.ts`), from this one pattern.
 */
export const NUMBER_PATTERN = '[1-9][0-9]*';
const NUMBER = new RegExp(`^${NUMBER_PATTERN}$`);

const holdAge = meter.createObservableGauge('line.hold.age', {
  description:
    'How long each hold that waits for Martin has waited, by work item, cause and the pull request he answers it on, if any; 0 once it no longer waits',
  unit: 's',
});

/**
 * Reports each hold that waits for Martin (`holds.ts`), as the store has it, each time the SDK collects, until the
 * function it gives back is called: one series per hold, by `work_item`, `cause` and, where there is one,
 * `pull_request`, whose value is how long it has waited. A hold that is answered, or that stops waiting for him (a
 * deploy pull request's checks running again), reads 0 from then. The process remembers each series it reported
 * while its hold waits, only to say once that it has ended, and then forgets it: what waits is the store's alone.
 *
 * An ended series stays, at 0, until the line next starts: the SDK (`@opentelemetry/sdk-metrics` 3.0) keeps an
 * attribute set it has seen once in the reader's cumulative storage, and sends it each collection whether or not the
 * callback observed it again, and neither an observable nor a synchronous gauge can remove one. Only delta temporality
 * drops a set not observed, and temporality is the reader's, chosen by instrument type, not by instrument or view:
 * it would change every worker's observable gauges, and mean building the OTLP reader by hand. The series kept are
 * one for each hold that waited for Martin while the line ran, and every deploy of the factory starts it again; the
 * SDK's own limit of 2000 sets an instrument folds any beyond it into one overflow series. A line that starts again
 * reports only what waits then. A read that fails observes nothing that time: the SDK sends the last values again.
 */
export function observeHolds(sql: Sql): () => void {
  const reported = new Map<string, Attributes>();
  const callback = async (result: BatchObservableResult) => {
    const now = Date.now();
    const open = new Map<string, Attributes>();
    const ages = new Map<string, number>();
    for (const hold of await openHolds(sql)) {
      // Only numbers become labels, which an alert makes links of: the store's checks say so, and this again.
      if (!NUMBER.test(hold.workItem) || (hold.pullRequest !== undefined && !NUMBER.test(String(hold.pullRequest)))) {
        continue;
      }
      const attributes = {
        work_item: hold.workItem,
        cause: hold.cause,
        ...(hold.pullRequest !== undefined && { pull_request: String(hold.pullRequest) }),
      };
      const key = JSON.stringify(attributes);
      open.set(key, attributes);
      ages.set(key, Math.max(1, (now - hold.since.getTime()) / 1000));
    }
    for (const [key, attributes] of reported) {
      if (open.has(key)) continue;
      result.observe(holdAge, 0, attributes);
      reported.delete(key);
    }
    for (const [key, attributes] of open) {
      result.observe(holdAge, ages.get(key) ?? 1, attributes);
      reported.set(key, attributes);
    }
  };
  meter.addBatchObservableCallback(callback, [holdAge]);
  return () => meter.removeBatchObservableCallback(callback, [holdAge]);
}

const takenItems = meter.createObservableGauge('line.taken.work_items', {
  description:
    'Work items the line has taken and is carrying, by stage: none while it is stopped or a day’s or month’s cap is reached',
});

const takenOldest = meter.createObservableGauge('line.taken.oldest', {
  description: 'How long the work item the line is carrying longest at each stage has been there; 0 with none',
  unit: 's',
});

const takenLimit = meter.createObservableGauge('line.taken.limit', {
  description: 'How long a work item the line carries may stay at each stage that has a limit, as it is in force',
  unit: 's',
});

const leaseOverrun = meter.createObservableGauge('line.lease.overrun', {
  description: 'How long the lease held longest past its expiry has been so; 0 with none',
  unit: 's',
});

/** Where an agent's calls go, as the line reads its settings. */
export type StepProvider = 'anthropic' | 'bedrock' | 'local';

/**
 * Each stage's limit in force, in seconds, or null for none: `policy/stuck.ts`'s, and for a stage whose agents' steps
 * run on the local model (Plan, Build, Review), that times `pace`, as a step there is given that much longer
 * (`LOCAL_MODEL_PACE.deadline`, `agents/agent.ts`). ALL_LOCAL sends every agent there, and Martin's settings may send
 * one.
 */
export function limitsFor(
  providerOf: (agent: LineAgent) => StepProvider,
  pace: number,
): Record<OpenStage, number | null> {
  const local = new Set(
    (Object.keys(STAGE_OF) as LineAgent[]).filter((agent) => providerOf(agent) === 'local').map((a) => STAGE_OF[a]),
  );
  return Object.fromEntries(
    OPEN_STAGES.map((stage) => {
      const { minutes } = STUCK[stage];
      if (minutes === null) return [stage, null];
      return [stage, minutes * 60 * (local.has(stage as (typeof STAGE_OF)[LineAgent]) ? pace : 1)];
    }),
  ) as Record<OpenStage, number | null>;
}

/** What the line is carrying, as it last read Martin's controls and its settings. */
export interface Carrying {
  /** The one work item it acts on, under Just one: no other is carried. */
  only: string | null;
  /** Whether agents take new work: with it off no step starts, so a work item at Plan, Build or Review stands. */
  newWork: boolean;
  /** Each stage's limit in force (`limitsFor`). */
  limits: Record<OpenStage, number | null>;
}

/** The stages a work item moves on from only by an agent's step. */
const STEP_STAGES = new Set<OpenStage>(Object.values(STAGE_OF));

/**
 * Reports what the line is carrying each time the SDK collects, until the function it gives back is called: for each
 * stage, how many of the work items it has taken stand there, how long the oldest has, and the stage's limit in force.
 * "Stuck" is the line not moving a work item it should be moving, so what it should not move reads as none:
 *
 * - everything, while the line is stopped;
 * - Plan, Build and Review, where only a step moves a work item on, while a day's or a month's cap is reached, when it
 *   starts no step, or agents take no new work: gates, Release and Verify go on;
 * - every work item but the one, under Just one.
 *
 * And the time a pause lasted does not count: a work item's time runs from the later of its move to the stage and the
 * line's last start, and at Plan, Build and Review from the last day's or month's cap cleared, or change of Martin's
 * controls, too, so a line that starts again does not page at once for the hours it was told to stand.
 *
 * Every stage is reported, none as 0, so a figure falls when the line is told to stop rather than standing at its last
 * value, which the SDK would otherwise send again. The limits are reported whatever the line carries. A read that
 * fails reports nothing that time, and the SDK sends the last figures again.
 */
export function observeTaken(sql: Sql, carrying: () => Carrying): () => void {
  const callback = async (result: BatchObservableResult) => {
    const { only, newWork, limits } = carrying();
    const [stopped, caps] = await Promise.all([lineStopped(sql), capsInForce(sql)]);
    const capped = caps.some((cap) => cap.cap === 'day' || cap.cap === 'month');
    // A pause does not count towards a work item's time: from the line's last start, for every stage, and for a step's
    // stage from the last day's or month's cap cleared or change of Martin's controls (new work on among them) too.
    const rows = stopped
      ? []
      : await sql<{ stage: OpenStage; n: number; oldest: number; stepping: number }[]>`
          with resumed as (
            select max(e.ts) filter (where e.type = 'line.started') as started,
                   max(e.ts) filter (where e.type = 'controls.changed'
                                       or (e.type = 'spend.cleared' and e.payload->>'cap' in ('day', 'month'))) as steps
            from events e
            where e.type in ('line.started', 'controls.changed', 'spend.cleared') and not e.sample
              and ${fromMartin(sql, 'e')})
          select stage, count(*)::int as n,
                 extract(epoch from clock_timestamp()
                   - greatest(min(moved_at), (select started from resumed)))::float8 as oldest,
                 extract(epoch from clock_timestamp()
                   - greatest(min(moved_at), (select started from resumed), (select steps from resumed)))::float8
                   as stepping
          from line where stage <> 'ended' ${only ? sql`and work_item = ${only}` : sql``}
          group by stage`;
    const by = new Map(rows.map((row) => [row.stage, row]));
    for (const stage of OPEN_STAGES) {
      const step = STEP_STAGES.has(stage);
      const found = by.get(stage);
      // A cap, or no new work, stops only the stages a step moves on: gates, Release and Verify go on.
      const row =
        step && (capped || !newWork) ? undefined : found && { ...found, oldest: step ? found.stepping : found.oldest };
      result.observe(takenItems, row?.n ?? 0, { stage });
      result.observe(takenOldest, Math.max(0, row?.oldest ?? 0), { stage });
      const limit = limits[stage];
      if (limit !== null) result.observe(takenLimit, limit, { stage });
    }
  };
  const observed = [takenItems, takenOldest, takenLimit];
  meter.addBatchObservableCallback(callback, observed);
  return () => meter.removeBatchObservableCallback(callback, observed);
}

/**
 * Reports, each time the SDK collects, how long the lease held longest past its expiry has been so, or 0 with none:
 * a worker that took a work item and neither let go of it nor renewed its lease, as one that died mid-step leaves it
 * until a line takes the work item again. Every open work item's, whatever the line carries, stopped or not, and whatever
 * LINE_MODE is: `factory line serve` starts it beside the security events, not the line's loop. A read that fails
 * reports nothing that time.
 */
export function observeLeases(sql: Sql): () => void {
  const callback = async (result: BatchObservableResult) => {
    const [row] = await sql<{ overrun: number | null }[]>`
      select extract(epoch from clock_timestamp() - min(held_until))::float8 as overrun
      from line where held_by is not null and held_until < clock_timestamp() and stage <> 'ended'`;
    result.observe(leaseOverrun, Math.max(0, row?.overrun ?? 0));
  };
  meter.addBatchObservableCallback(callback, [leaseOverrun]);
  return () => meter.removeBatchObservableCallback(callback, [leaseOverrun]);
}
