/**
 * The red-team harness (`factory red-team`): it makes each of spec 5.3's attacks Martin launches from the console,
 * against the real mechanism, and records how it ended (`attack.finished`). It does not grade itself: the line
 * re-derives each outcome from the refusals it cites (apps/factory/src/line/attacks.ts), so the harness only has to
 * make the attempt, wait for the refusals it expects matched to its own attempt, and say what it saw.
 *
 * It acts only on an `attack.launched` one of Martin's roles appended, which its store role (`factory_redteam`) alone
 * among the workers may read, and only on a work item that launch opened: row security holds both to those roles, and
 * holds the harness to appending an attack's end, the refusals it relays, and the work item's close, and nothing else
 * (0045_red-team-attacks.sql). It holds no GitHub credential: attacks 2 and 3 ask the GitHub worker's attack door,
 * which makes those attempts and answers each refusal signed, and the harness relays them.
 *
 * One attack at a time, oldest launch first. A launch past its limit with no end of the harness's is recorded
 * `unfinished`, so a harness that restarts after a crash closes what it missed rather than leave the line to page it
 * for ever. A refusal the attack met is the guardrail working; only an attempt that got through, or one nothing
 * refused in time, is a finding, and the line pages it.
 */
import { randomUUID } from 'node:crypto';
import { ATTACKS, type Attack, cutTo, type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import type { Sql } from 'postgres';
import { ATTACK_RULES, attackLimitMs, expectedRefusals } from '../../../../policy/attacks.ts';
import { MARTINS_ROLES } from '../../../../policy/store-grants.ts';
import type { Logger } from '../log.ts';

/** How an attack ended, as the harness saw it: what the line re-derives again from the refusals it cites. */
export interface AttemptResult {
  outcome: 'refused' | 'not-refused' | 'unfinished';
  /** The seqs of the `action.refused` it counted, in the order the attack expects them. */
  refusals: number[];
  /** The attack's own record of each attempt it made: what it tried, what came back, and whether that was a refusal. */
  attempts: { what: string; result: string; refused: boolean }[];
  /** The egress attack's control, kept apart from its attempts: the gateway, which its pod may reach. */
  control?: { what: string; result: string; reached: boolean };
  /** What its refusals must be about, so none from someone else's report, pull request or pod is counted. */
  subject?: PayloadOf<'attack.finished'>['subject'];
  /** A sentence for the work item's close. */
  reason: string;
}

/** What an attempt is given: the store it reads and appends through, and the clients each attack needs. */
export interface AttemptContext {
  sql: Sql;
  events: Pick<EventWriter, 'append'>;
  workItem: string;
  /** When the launch was taken, by the store's clock: the attempt waits for refusals no older than it. */
  launchedAt: Date;
  /** How long the attempt may take before it is left unfinished. */
  limitMs: number;
  log: Logger;
  /** Rejects when the worker is stopping, so a wait ends promptly. */
  signal: AbortSignal;
}

/** One attack's attempt: makes it, waits for its refusals, and says how it ended. Never throws for the attack failing. */
export type Attempt = (ctx: AttemptContext) => Promise<AttemptResult>;

/** A launch the harness has not finished: the attack, its work item, and when it was taken. */
interface Launch {
  seq: number;
  workItem: string;
  attack: string;
  at: Date;
}

export interface RedTeamOptions {
  sql: Sql;
  events: Pick<EventWriter, 'append'>;
  /** The attempt for each attack; tests pass fakes. */
  attempts: Record<Attack, Attempt>;
  log: Logger;
  now?: () => Date;
  /** How often to look for a launch to act on, when nothing woke it. */
  pollMs?: number;
}

export class RedTeam {
  readonly #o: RedTeamOptions;
  readonly #now: () => Date;
  readonly #pollMs: number;

  constructor(options: RedTeamOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
    this.#pollMs = options.pollMs ?? 10_000;
  }

  /** Looks for launches to act on until stopped, waking at once when an event is appended. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.once(signal);
      } catch (error) {
        if (!signal.aborted) this.#o.log.warn({ err: error }, 'the red-team harness could not take a launch');
      }
      await new Promise((resolve) => setTimeout(resolve, this.#pollMs)).catch(() => undefined);
      if (signal.aborted) return;
    }
  }

  /** Takes the oldest launch it has not finished, makes its attack, and records how it ended. One at a time. */
  async once(signal: AbortSignal): Promise<void> {
    const launch = await this.#next();
    if (!launch) return;
    await this.#act(launch, signal);
  }

  /**
   * The oldest `attack.launched` one of Martin's roles appended, real and not a sample, with no `attack.finished` of
   * the harness's after it. Row security already shows the harness no other role's launch; read again here, as the
   * line does, so a hole in a policy is not the only lock. A sample's launch is no attack to make (`make samples`
   * loads a store of them): a store holds samples or real work, and the harness appends real work alone.
   */
  async #next(): Promise<Launch | undefined> {
    const [row] = await this.#o.sql<{ seq: string; work_item: string; attack: string; at: Date }[]>`
      select l.seq::text as seq, l.work_item, l.payload->>'attack' as attack, l.appended_at as at
      from events l
      where l.type = 'attack.launched' and l.payload->>'attack' = any(${ATTACKS as unknown as string[]})
        and not l.sample and l.appended_by = any(${MARTINS_ROLES as unknown as string[]})
        and not exists (select 1 from events f
                        where f.work_item = l.work_item and f.type = 'attack.finished'
                          and f.appended_by = 'factory_redteam' and f.seq > l.seq)
      order by l.seq
      limit 1`;
    return row ? { seq: Number(row.seq), workItem: row.work_item, attack: row.attack, at: row.at } : undefined;
  }

  async #act(launch: Launch, signal: AbortSignal): Promise<void> {
    const attempt = isAttack(launch.attack) ? this.#o.attempts[launch.attack] : undefined;
    if (!attempt) {
      // An attack this code does not know, launched by a newer version: left for the line to page unfinished and a
      // newer harness to make. #next does not pick one; this guards the edge, and never loops (once() is one pass).
      this.#o.log.warn({ workItem: launch.workItem, attack: launch.attack }, 'skipping a launch of an unknown attack');
      return;
    }
    const limitMs = attackLimitMs(launch.attack);
    const ageMs = this.#now().getTime() - launch.at.getTime();
    // A launch past its limit is left unfinished rather than run late: a second attack never meets the first's
    // refusals, and the line has already begun to page it.
    if (ageMs >= limitMs) {
      await this.#finish(launch, {
        outcome: 'unfinished',
        refusals: [],
        attempts: [],
        reason: 'The attack was already past its limit when the harness reached it.',
      });
      return;
    }
    this.#o.log.info({ workItem: launch.workItem, attack: launch.attack }, 'making a red-team attack');
    let result: AttemptResult;
    try {
      result = await attempt({
        sql: this.#o.sql,
        events: this.#o.events,
        workItem: launch.workItem,
        launchedAt: launch.at,
        limitMs: limitMs - ageMs,
        log: this.#o.log,
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        this.#o.log.info({ workItem: launch.workItem, attack: launch.attack }, 'stopping: the launch is left as it is');
        return;
      }
      // An attempt must never leave a launch without an end, or the loop would make it again (a second pull request,
      // a second pod). What it could not finish is recorded unfinished, with why, and the line judges it.
      this.#o.log.warn({ workItem: launch.workItem, attack: launch.attack, err: error }, 'a red-team attempt failed');
      const said = error instanceof Error ? error.message : String(error);
      result = {
        outcome: 'unfinished',
        refusals: [],
        attempts: [{ what: 'made the attack', result: said || 'it failed without saying why', refused: false }],
        reason: 'The attack could not be made to its end; the harness logged why.',
      };
    }
    // Stopped while the attempt waited: its waits gave up, not the attack. The launch is left for the next harness,
    // within its limit, rather than ended unfinished and paged for a restart.
    if (signal.aborted) {
      this.#o.log.info({ workItem: launch.workItem, attack: launch.attack }, 'stopping: the launch is left as it is');
      return;
    }
    await this.#finish(launch, result);
  }

  /** Appends `attack.finished` and the work item's close, in one batch: that ends the attack's work item. */
  async #finish(launch: Launch, result: AttemptResult): Promise<void> {
    // Only a known attack reaches here (#act skips the rest): a guard, never hit, that also narrows the type.
    if (!isAttack(launch.attack)) throw new Error(`cannot finish an unknown attack: ${launch.attack}`);
    const finished: PayloadOf<'attack.finished'> = {
      attack: launch.attack,
      outcome: result.outcome,
      expected: expectedRefusals(launch.attack),
      refusals: result.refusals,
      // Each attempt's record as the schema takes it: what came back, cut to its length, and never empty.
      attempts: result.attempts.map((attempt) => ({
        ...attempt,
        what: cutTo(attempt.what, 200),
        result: cutTo(attempt.result || 'nothing came back', 2000),
      })),
      ...(result.control && {
        control: { ...result.control, result: cutTo(result.control.result || 'nothing came back', 2000) },
      }),
      ...(result.subject && { subject: result.subject }),
    };
    const closed: PayloadOf<'work-item.closed'> = { outcome: result.outcome, reason: cutTo(result.reason, 200) };
    await this.#o.events.append([
      event(launch.workItem, 'attack.finished', summaryOf(launch.attack, result.outcome), finished),
      event(launch.workItem, 'work-item.closed', closedSummary(result.outcome), closed),
    ]);
    this.#o.log.info(
      { workItem: launch.workItem, attack: launch.attack, outcome: result.outcome },
      'a red-team attack ended',
    );
  }
}

const isAttack = (attack: string): attack is Attack => Object.hasOwn(ATTACK_RULES, attack);

function event<K extends 'attack.finished' | 'work-item.closed'>(
  workItem: string,
  type: K,
  summary: string,
  payload: PayloadOf<K>,
): NewEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type,
    version: VERSIONS[type],
    actor: 'factory',
    summary,
    payload,
    artifacts: [],
  } as NewEvent;
}

const OUTCOME_WORDS: Record<AttemptResult['outcome'], string> = {
  refused: 'refused, as it should be',
  'not-refused': 'NOT refused',
  unfinished: 'left unfinished',
};

const summaryOf = (attack: Attack, outcome: AttemptResult['outcome']): string =>
  `${ATTACK_RULES[attack].name}: ${OUTCOME_WORDS[outcome]}`;

const closedSummary = (outcome: AttemptResult['outcome']): string =>
  outcome === 'refused'
    ? 'The attack was refused by its mechanism'
    : outcome === 'not-refused'
      ? 'The attack was not refused'
      : 'The attack was left unfinished';
