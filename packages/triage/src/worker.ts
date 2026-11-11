/**
 * The triage worker: takes each signal from the inbox once and decides what it becomes.
 *
 * - A sense's signal with a fingerprint no open ticket has opens a work item with its ticket, unless a ticket closed as
 *   verified has exactly that fingerprint: the same defect came back, so that ticket and its work item reopen. A
 *   signal the sense saw before that close is of the version the fix replaced, and is only counted.
 * - One on an open ticket adds its evidence the first time each sense sees it in each version of the app: the ticket
 *   records every version the defect was seen in, such as each release rolled back on it. Within a version the inbox
 *   counts it, with no event, so the event count grows with tickets and releases, not with the minutes a defect stays
 *   unfixed.
 * - A sense's signal that would open a ticket when that sense has found more new problems than a handful at once
 *   (`BURST`) is held instead, with the others, as one burst: a work item with no ticket, which waits for Martin.
 *   Each new problem the sense finds while it waits joins it. Martin approving it opens their tickets, as the sense's
 *   would have been; his rejection closes it (`settleOne`). A signal that would add evidence to an open ticket counts
 *   as a new problem, and is held as one, unless a release explains it: its version went live at most
 *   `BURST.releaseMinutes` before, and a release has every sense see each open ticket's defect there again.
 * - Before it trusts a sense's signal, triage looks at what that sense reads besides the app, as it stood when the
 *   sense saw it (`ENVIRONMENT`), and records the look with the signal. One that would open or reopen a ticket while
 *   any of it was not seen to be healthy is held for Martin as a burst is, with its cause the environment: no agent
 *   can mend a full disk or a backend that stores nothing.
 * - Every report becomes events, judged by Jev: a new ticket, a repeat that joins an open one, or a work item
 *   that says it was quarantined, parked or discarded.
 * - So does every finding the planner leaves, judged the same way and trusted no more, except that it never opens a
 *   ticket: a defect is parked until a sense sees it or Martin opens one. Another finding with the fingerprint of one
 *   parked joins it, as a repeat joins a ticket, so one defect waits for one answer; one that joins after Martin
 *   answered starts the hold again, since he did not read it. A ticket triage opens with the same
 *   fingerprint closes it into that ticket; Martin approving it opens its ticket, by the policy's table as a sense's
 *   would be, or joins it to an open ticket that has it; his rejection closes it (`settleOne`). Nothing else opens a
 *   ticket from a finding.
 * - A suggestion, a visitor's or the planner's, is parked for Martin, who alone asks for improvements. His rejection
 *   closes it; his words leave it waiting, and nothing acts on his approval: a suggestion never starts work, and Martin
 *   asks for an improvement himself with the console's "+", in his own words.
 * - An answer of Martin's to one of these holds that triage cannot act on, in as many tries as a signal gets, is left:
 *   the hold starts again, with its cause, saying so (`askedAgain`). Needs you asks him again, a restart finds nothing
 *   answered to try, and his next answer is tried afresh.
 *
 * One worker decides at a time (it holds an advisory lock), so two signals with the same new fingerprint cannot
 * open two tickets. It takes nothing while the line is stopped, and no report while the gateway waits on a spend cap.
 */

import { setTimeout as pause } from 'node:timers/promises';
import type {
  DefectCategory,
  DefectSymptom,
  Environment,
  InboxSignal,
  NewEvent,
  PayloadOf,
  SignalSource,
} from '@software-factory/events';
import { samePoints, ticketPoints } from '@software-factory/events';
import {
  type EventWriter,
  fingerprintOf,
  fromMartin,
  IgnoredCommands,
  lastEnd,
  lineStopped,
  nextWorkItem,
} from '@software-factory/store';
import type { Sql, TransactionSql } from 'postgres';
import { BURST, ENVIRONMENT, INBOX, REPORT_TEXT, SYMPTOMS } from '../../../policy/triage.ts';
import {
  type AskedAgain,
  approvedFinding,
  askedAgain,
  burstEvents,
  closedFinding,
  closedHeld,
  closedSuggestion,
  environmentEvents,
  findingEvents,
  healthy,
  heldAgain,
  idsFor,
  type ParkedDefect,
  reportEvents,
  routeOf,
  type Seen,
  senseEvidence,
  senseReopened,
  senseTicket,
  ticketTitle,
} from './events.ts';
import { type Judge, JudgeWaiting } from './judge.ts';
import type { Candidate } from './questions.ts';
import { judgeReport, type PageReader } from './reports.ts';
import { routeFinding, routeReport } from './routing.ts';
import { privatePath } from './scrub.ts';

/** What triage made of a signal, as the inbox records it. */
export type Outcome = 'opened' | 'evidence' | 'counted' | 'report' | 'finding' | 'reopened' | 'held';

export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface TriageOptions {
  /** As triage's role (`factory_triage`). */
  sql: Sql;
  events: EventWriter;
  judge: Judge;
  read: PageReader;
  log: Logger;
  now?: () => Date;
  /**
   * How what the senses read stood at a time (`apps/factory/src/environment.ts`). Without it, triage looks at nothing,
   * records no look, and holds nothing for the environment.
   */
  look?: ((at: Date) => Promise<Environment>) | undefined;
  /** Told of each signal triaged, with how long it waited in the inbox. */
  onTriaged?: (outcome: Outcome, signal: InboxSignal, waitedSeconds: number, ticketOpened: boolean) => void;
  /** How `run` waits out a store it cannot reach: `OUTAGE`, unless a test shortens it. */
  outage?: Outage;
  /** How often a copy waiting for triage's lock asks for it again: `LOCK_ASKED_MS`, unless a test shortens it. */
  lockAskedMs?: number;
}

/**
 * A second copy asks for the lock every few seconds, rather than waiting on it in a query: a query cancelled when the
 * copy is stopped could be granted the lock just before, and the cancel then land on the unlock, which would leave the
 * lock held on a connection back in the pool.
 */
export const LOCK_ASKED_MS = 2000;

/** How `run` waits out an event store it cannot reach. */
export interface Outage {
  /** The first wait after a failure, in milliseconds; each failure in a row doubles it. */
  firstMs: number;
  /** The longest wait. */
  mostMs: number;
  /** Failures in a row, with no pass between them, after which `run` gives up and throws the last. */
  tries: number;
}

/**
 * A restart of Postgres or a short outage is waited out, 1 s, 2 s, 4 s and so on up to 30 s apart: a 45 s outage costs
 * at most 30 s more. Twelve failures in a row are three and a half minutes with nothing triaged, which is no blip: `run` throws,
 * the process exits, and the pod's restarts say so (`WorkerCrashLooping`).
 */
export const OUTAGE: Outage = { firstMs: 1000, mostMs: 30_000, tries: 12 };

interface Taken {
  id: string;
  sense: string;
  signal: InboxSignal;
  attempts: number;
  received_at: Date;
}

/** What a ticket, or a report's decision, points at, a content fingerprint's passage among it (`ticketPoints`). */
const pointsOf = (of: (Pick<Ticket, 'points'> & { fingerprint?: Ticket['fingerprint'] | undefined }) | undefined) =>
  of?.fingerprint ? ticketPoints({ fingerprint: of.fingerprint, points: of.points }) : of?.points;

type Ticket = { workItem: string } & Pick<
  PayloadOf<'ticket.opened'>,
  'title' | 'category' | 'fingerprint' | 'points'
> & {
    /** The source of the signal that opened it. */
    sense: SignalSource | undefined;
  };

export type Took = Outcome | 'idle' | 'stopped' | 'waiting' | 'failed';

/** What a sense's signal makes: the events to append, and the ticket it opens, if it opens one. */
interface Made {
  outcome: Outcome;
  workItem: string;
  events: NewEvent[];
  ticket?: Ticket;
}

export class Triage {
  readonly #o: Required<Omit<TriageOptions, 'onTriaged' | 'look'>> & Pick<TriageOptions, 'onTriaged' | 'look'>;
  /**
   * The connection that holds triage's advisory lock while `run` does. The lock is the connection's, so it is asked
   * before each pass and each append: one that no longer answers has lost the lock, which another copy may hold now.
   */
  #lock: { sql: Awaited<ReturnType<Sql['reserve']>>; pid: number } | undefined;
  /** The writer, but each append is refused unless the lock still holds, while `run` holds it. */
  readonly #events: Pick<EventWriter, 'append'>;
  /** Until when reports wait: the gateway cannot answer before then. The senses' signals need no model. */
  #reportsWaitUntil = 0;
  /** Whether an event has been appended since the held findings were last settled: only an answer can settle one. */
  #settleDue = true;
  /**
   * How often acting on each of Martin's answers to a hold has failed (`settleKey`), so one that keeps failing is left,
   * not tried for ever. Leaving it starts the hold again in the store, so a restart has nothing answered to try.
   */
  readonly #settleFailures = new Map<string, number>();
  /** Martin's commands that a role not his appended: ignored, and each logged once. */
  readonly #ignored: IgnoredCommands;

  constructor(options: TriageOptions) {
    this.#o = { now: () => new Date(), outage: OUTAGE, lockAskedMs: LOCK_ASKED_MS, ...options };
    this.#ignored = new IgnoredCommands(this.#o.sql, this.#o.log);
    this.#events = { append: (events) => this.#append(events) };
  }

  /**
   * Appends, while `run` holds the lock, on the lock's own connection, in one transaction: it commits only while that
   * connection is the one that took the lock, so a copy that has lost it appends nothing (`LockLost`).
   */
  async #append(events: Parameters<EventWriter['append']>[0]) {
    const lock = this.#lock;
    if (!lock) return this.#o.events.append(events);
    await this.#holding();
    // A reserved connection has no `begin` of its own: it is the transaction, between this begin and its commit.
    const tx = lock.sql as unknown as TransactionSql;
    try {
      await lock.sql`begin`;
      const stored = await this.#o.events.appendWithin(tx, events);
      await lock.sql`commit`;
      return stored;
    } catch (error) {
      await lock.sql`rollback`.catch(() => {});
      // A refused append is refused; one that failed because the connection went is the lock lost. If the commit was
      // the one that failed, the events may be stored: their ids are the signal's, so taking it again stores none twice.
      await this.#holding();
      throw error;
    }
  }

  /**
   * Throws `LockLost` unless the connection that holds the lock still answers, as the backend that took it, while `run`
   * holds it. A reserved connection that dropped refuses every query; the backend's pid is asked too, so no client that
   * reconnected one in its place could pass for it.
   */
  async #holding(): Promise<void> {
    const lock = this.#lock;
    if (!lock) return;
    let pid: number | undefined;
    try {
      [{ pid } = { pid: undefined }] = await lock.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    } catch (error) {
      throw new LockLost(error);
    }
    if (pid !== lock.pid) throw new LockLost(new Error(`the lock's connection is backend ${pid}, not ${lock.pid}`));
  }

  /** Takes one signal, if the line is running and one is waiting, and triages it. */
  async takeOne(): Promise<Took> {
    const now = this.#o.now();
    if (await lineStopped(this.#o.sql)) return 'stopped';
    const reportsWait = now.getTime() < this.#reportsWaitUntil;
    const taken = await this.#claim(reportsWait);
    if (!taken) return reportsWait ? 'waiting' : 'idle';
    const log = { signal: taken.id, sense: taken.sense, attempt: taken.attempts };
    try {
      const { outcome, workItem, ticketOpened } = await this.#triage(taken);
      await this.#o.sql`update inbox set triaged_at = ${now}, outcome = ${outcome}, work_item = ${workItem},
                        failure = null where id = ${taken.id}`;
      const waited = (now.getTime() - taken.received_at.getTime()) / 1000;
      this.#o.log.info({ ...log, outcome, workItem }, 'triaged a signal');
      this.#o.onTriaged?.(outcome, taken.signal, waited, ticketOpened);
      return outcome;
    } catch (error) {
      if (error instanceof LockLost) {
        // Not the signal's fault either: it keeps its attempt, and the copy that holds the lock may take it at once.
        // Only its own claim: one whose lease ran out may be another copy's by now.
        await this.#o.sql`update inbox set attempts = attempts - 1, not_before = clock_timestamp()
                          where id = ${taken.id} and attempts = ${taken.attempts} and triaged_at is null`.catch(
          () => {},
        );
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof JudgeWaiting) {
        // Not the signal's fault: it keeps its attempt, and no report is taken until the gateway can answer. The
        // senses' signals carry on, because they call no model.
        this.#reportsWaitUntil = error.until.getTime();
        await this.#o.sql`update inbox set attempts = attempts - 1, failure = ${reason}, not_before = ${error.until}
                          where id = ${taken.id}`;
        this.#o.log.warn({ ...log, until: error.until.toISOString(), reason }, 'triage is waiting for the gateway');
        return 'waiting';
      }
      const retry = new Date(now.getTime() + 2 ** taken.attempts * 15_000);
      await this.#o.sql`update inbox set failure = ${reason}, not_before = ${retry} where id = ${taken.id}`;
      const last = taken.attempts >= INBOX.attempts;
      this.#o.log.warn({ ...log, err: error, last }, last ? 'a signal failed for the last time' : 'a signal failed');
      return 'failed';
    }
  }

  /**
   * Triages until aborted: woken by a new signal or a new event (the line starting again), and every half a minute
   * for signals waiting to be tried again. Only one worker runs at a time: it holds triage's advisory lock.
   *
   * A store it cannot reach is waited out (`OUTAGE`). The lock is held on a connection of its own, and goes when that
   * connection drops, so after any failure the worker lets go of the lock and takes it again, on a new connection,
   * before another pass: a copy waiting for the lock may take it meanwhile, and this one then waits instead. A signal in
   * hand when the store went is taken again once its lease is up, as after a restart.
   */
  async run(abort: AbortSignal): Promise<void> {
    const { sql, log, outage } = this.#o;
    const wake = new Wake();
    abort.addEventListener('abort', wake.nudge);
    const heard = () => {
      this.#settleDue = true;
      wake.nudge();
    };
    // Each listen is made again after its connection drops, with nothing heard meanwhile: so when it is, triage looks,
    // and finds out at once whether it still holds its lock. They are made in the loop, so a store out of reach as
    // triage starts is waited out too.
    const listening: { unlisten(): Promise<void> }[] = [];
    const listen = async () => {
      if (listening.length) return;
      const made = await Promise.allSettled([
        sql.listen('inbox', wake.nudge, heard),
        sql.listen('events', heard, heard),
      ]);
      for (const m of made) if (m.status === 'fulfilled') listening.push(m.value);
      const failed = made.find((m) => m.status === 'rejected');
      if (failed) {
        await Promise.all(listening.splice(0).map((l) => l.unlisten())).catch(() => {});
        throw failed.reason;
      }
    };
    let failures = 0;
    try {
      while (!abort.aborted) {
        try {
          await listen();
          await this.#whileLocked(abort, wake, () => {
            failures = 0;
          });
        } catch (error) {
          if (abort.aborted) break;
          failures += 1;
          if (failures >= outage.tries) throw error;
          const waitMs = Math.min(outage.firstMs * 2 ** (failures - 1), outage.mostMs);
          log.warn(
            { err: error, failures, waitMs },
            'triage could not reach the store, and takes its lock again first',
          );
          // A timer alone, which only stopping cuts short: a signal heard meanwhile would bring the next try forward.
          await pause(waitMs, undefined, { signal: abort }).catch(() => {});
        }
      }
    } finally {
      abort.removeEventListener('abort', wake.nudge);
      await Promise.all(listening.map((l) => l.unlisten())).catch(() => {});
    }
  }

  /**
   * Takes triage's lock on a connection of its own, then triages while it holds, until aborted or until anything fails,
   * which it throws. `going` is told each time the store answered as it should: a pass went through, or another copy
   * holds the lock, which this one then waits for, as no failure. Waking for a signal or an event, it asks for the lock
   * then too.
   */
  async #whileLocked(abort: AbortSignal, wake: Wake, going: () => void): Promise<void> {
    const lock = await this.#o.sql.reserve();
    try {
      // Another copy may hold it: this one waits, asking again, until it has it or is stopped.
      while (!(await lock<{ taken: boolean }[]>`select pg_try_advisory_lock(hashtext('triage')) as taken`)[0]?.taken) {
        going();
        await wake.after(this.#o.lockAskedMs);
        if (abort.aborted) return;
      }
      const [{ pid } = { pid: 0 }] = await lock<{ pid: number }[]>`select pg_backend_pid() as pid`;
      this.#lock = { sql: lock, pid };
      // An event appended while the store was out of reach was heard by no one, and a pass that failed may have been
      // settling.
      this.#settleDue = true;
      while (!abort.aborted) {
        await this.#holding();
        // Martin's answers arrive as events, so the held findings are looked at only after one is appended. The flag is
        // cleared before looking, so an event appended meanwhile sets it again; one settled may leave more.
        let settled = false;
        if (this.#settleDue) {
          this.#settleDue = false;
          settled = await this.settleOne();
          if (settled) this.#settleDue = true;
        }
        const took = await this.takeOne();
        going();
        if (!settled && (took === 'idle' || took === 'stopped' || took === 'waiting')) {
          const pause = took === 'waiting' ? Math.max(1000, this.#reportsWaitUntil - Date.now()) : 30_000;
          await wake.after(Math.min(pause, 30_000));
        }
      }
    } finally {
      this.#lock = undefined;
      await lock`select pg_advisory_unlock(hashtext('triage'))`.catch(() => {});
      lock.release();
    }
  }

  /**
   * Does what Martin answered to one defect the planner noticed, if he has approved or rejected one that is still
   * parked. Approving opens its ticket on its own work item, with the category and severity the policy gives its
   * symptom, unless an open ticket has its fingerprint, which it then joins; any other finding parked with the same
   * fingerprint joins the new ticket. Rejecting closes it. Answering in words leaves it waiting. An answer settles only
   * the findings that reached the hold before it, in the store's order: if another joined after, the hold starts again,
   * waiting for an answer that has read it.
   */
  async settleOne(): Promise<boolean> {
    const { sql, log } = this.#o;
    const events = this.#events;
    const now = this.#o.now();
    await this.#ignored.check();
    if (await lineStopped(sql)) return false;
    if (await this.#settleHeld()) return true;
    if (await this.#settleSuggestion()) return true;
    const answered = (await parkedFindings(sql)).find((parked) => parked.decision !== null);
    if (!answered?.decision) return false;
    const { workItem, defect, decision, late } = answered;
    const seed = `finding:${workItem}:${decision}`;
    try {
      if (late) {
        // A finding joined the hold after he answered, however the answer was written and whatever triage saw when it
        // joined: his answer was to words that did not include it, so it settles nothing, and the hold asks again.
        await events.append(heldAgain(workItem, defect, `finding:${workItem}:again:${answered.answered}`, now));
      } else if (decision === 'rejected') {
        await events.append(closedFinding(workItem, { rejected: true }, seed, now));
      } else {
        const same = (await openTickets(sql)).find((ticket) =>
          sameFingerprint(ticket.fingerprint, defect.fingerprint, { open: ticket.sense, found: 'planner' }),
        );
        if (same) {
          await events.append(closedFinding(workItem, { joined: same.workItem, by: 'martin' }, seed, now));
        } else {
          const joined = await this.#joinFindings(defect.fingerprint, workItem, 'martin', seed, 'planner');
          await events.append([...approvedFinding(workItem, defect, now), ...joined]);
        }
      }
    } catch (error) {
      // Not the line's to stop for: it is tried again on the next event, as often as a signal is, then left.
      await this.#failedToSettle(answered, { cause: 'finding', defect }, decision, error);
      return false;
    }
    this.#settleFailures.delete(settleKey(answered));
    log.info({ workItem, decision }, 'settled a defect the planner noticed, as Martin answered');
    return true;
  }

  /**
   * Does what Martin answered to signals triage held, a burst or a sense's problems seen while what it reads was not
   * healthy, if he has approved or rejected a hold of them. Approving makes of each signal held what it would have made
   * without the hold, in the order the sense sent them: a ticket, as a rule, or evidence on a ticket opened since; and
   * closes the hold, naming the tickets. Rejecting closes it, with none.
   */
  async #settleHeld(): Promise<boolean> {
    const { sql, log } = this.#o;
    const events = this.#events;
    const now = this.#o.now();
    const answered = (await heldSignals(sql)).find((held) => held.decision !== null);
    if (!answered?.decision) return false;
    const { workItem, cause, decision } = answered;
    try {
      if (decision === 'rejected') {
        await events.append(closedHeld(workItem, cause, { rejected: true }, now));
      } else {
        const held = await sql<{ id: string; signal: InboxSignal }[]>`
          select id, signal from inbox where work_item = ${workItem} and outcome = 'held' order by received_at, id`;
        let tickets = await openTickets(sql);
        const made: NewEvent[] = [];
        const opened: string[] = [];
        // What this approval appends, which the store does not have until it does: each work item it closes (a
        // finding two of its tickets would both take), and each sense's evidence in a version on each ticket.
        const closes = new Set<string>();
        const seen = new Set<string>();
        for (const { id, signal } of held) {
          // Seeded apart from the signal's own events, which the hold has. Its look is taken again, as of when the
          // sense saw it, and never holds it again: Martin let it through.
          // A hold has each fingerprint once (`#hold` counts the rest), so no two of its signals reopen one ticket.
          const next = await this.#sense(await this.#seen(signal), `burst:${id}`, tickets);
          if (next.outcome === 'reopened') opened.push(next.workItem);
          const evidence = `${next.workItem} ${signal.sense} ${signal.version}`;
          if (next.outcome === 'evidence' && seen.has(evidence)) continue;
          seen.add(evidence);
          for (const event of next.events) {
            if (event.type === 'work-item.closed' && closes.has(event.work_item ?? '')) continue;
            if (event.type === 'work-item.closed') closes.add(event.work_item ?? '');
            made.push(event);
          }
          if (next.ticket) {
            tickets = [next.ticket, ...tickets];
            opened.push(next.workItem);
          }
        }
        await events.append([...made, ...closedHeld(workItem, cause, { opened }, now)]);
      }
    } catch (error) {
      await this.#failedToSettle(answered, { cause }, decision, error);
      return false;
    }
    this.#settleFailures.delete(settleKey(answered));
    log.info({ workItem, cause, decision }, 'settled held signals, as Martin answered');
    return true;
  }

  /**
   * Closes a suggestion Martin rejected, a visitor's or the planner's. Nothing acts on his approval of one until
   * improvements do (Needs you does not offer it), and his words leave it waiting.
   */
  async #settleSuggestion(): Promise<boolean> {
    const { sql, log } = this.#o;
    const events = this.#events;
    const rejected = (await heldSuggestions(sql)).find((held) => held.decision === 'rejected');
    if (!rejected) return false;
    try {
      await events.append(closedSuggestion(rejected.workItem, this.#o.now()));
    } catch (error) {
      await this.#failedToSettle(rejected, { cause: 'suggestion' }, 'rejected', error);
      return false;
    }
    this.#settleFailures.delete(settleKey(rejected));
    log.info({ workItem: rejected.workItem }, 'closed a suggestion, as Martin rejected it');
    return true;
  }

  /**
   * Counts a failure to act on Martin's answer to a hold. The last of as many as a signal gets leaves his answer: the
   * hold starts again, saying so, which asks him again in Needs you, and a restart finds nothing answered to try. If the
   * store cannot take that either, the answer is tried once more on the next event, and so on until it can.
   */
  async #failedToSettle(
    hold: Answerable,
    held: AskedAgain,
    decision: 'approved' | 'rejected',
    error: unknown,
  ): Promise<void> {
    const { log } = this.#o;
    const events = this.#events;
    // Not the answer's fault: tried again once the lock is held again.
    if (error instanceof LockLost) throw error;
    const { workItem, answered } = hold;
    const key = settleKey(hold);
    const tries = (this.#settleFailures.get(key) ?? 0) + 1;
    this.#settleFailures.set(key, tries);
    const last = tries >= INBOX.attempts;
    log.warn({ workItem, cause: held.cause, decision, err: error, last }, 'could not do as Martin answered a hold');
    if (!last || !answered) return;
    try {
      await events.append(askedAgain(workItem, held, decision, answered, tries, this.#o.now()));
      this.#settleFailures.delete(key);
      log.warn({ workItem, cause: held.cause, decision }, 'left an answer it could not act on, and asked Martin again');
    } catch (failure) {
      if (failure instanceof LockLost) throw failure;
      this.#settleFailures.set(key, tries - 1);
      log.warn({ workItem, cause: held.cause, err: failure }, 'could not ask Martin again');
    }
  }

  /**
   * A sense's signal with triage's look at what the sense reads, as of when it saw it: only what the policy says the
   * sense reads, and only what triage has an address for. Nothing for a report or a finding, which no backend made.
   */
  async #seen(signal: InboxSignal): Promise<Seen> {
    const { look } = this.#o;
    if (!look || judged(signal)) return signal;
    const reads: readonly string[] = ENVIRONMENT.reads[signal.sense as keyof typeof ENVIRONMENT.reads] ?? [];
    const environment = await look(new Date(signal.observedAt));
    const dependencies = environment.dependencies.filter((dependency) => reads.includes(dependency.name));
    return dependencies.length ? { ...signal, environment: { at: environment.at, dependencies } } : signal;
  }

  /** The events that close every parked finding a new ticket has, into that ticket. */
  async #joinFindings(
    fingerprint: PayloadOf<'ticket.opened'>['fingerprint'],
    ticket: string,
    by: 'sense' | 'report' | 'martin',
    seed: string,
    source: SignalSource,
  ) {
    const now = this.#o.now();
    return (await parkedFindings(this.#o.sql))
      .filter(
        (parked) =>
          parked.workItem !== ticket &&
          sameFingerprint(fingerprint, parked.defect.fingerprint, { open: source, found: 'planner' }),
      )
      .flatMap((parked) =>
        closedFinding(parked.workItem, { joined: ticket, by }, `${seed}:joined:${parked.workItem}`, now),
      );
  }

  /**
   * Holds the oldest waiting signal for a while, so another worker leaves it alone, and counts the attempt. While
   * reports wait for the gateway, it takes only the senses' signals. A report that has waited `REPORT_TEXT.judgeDays`
   * is never taken: it is forgotten unjudged, so neither its events nor Jev's cassette of it keep the visitor's words
   * past their time.
   */
  async #claim(skipReports: boolean): Promise<Taken | undefined> {
    const [row] = await this.#o.sql<Taken[]>`
      update inbox set attempts = attempts + 1,
                       not_before = clock_timestamp() + make_interval(secs => ${INBOX.leaseSeconds})
      where id = (select id from inbox
                  where triaged_at is null and not_before <= clock_timestamp() and attempts < ${INBOX.attempts}
                    and (not ${skipReports} or sense not in ('report', 'planner'))
                    and (sense <> 'report'
                         or received_at > clock_timestamp() - make_interval(days => ${REPORT_TEXT.judgeDays}))
                  order by received_at limit 1 for update skip locked)
      returning id, sense, signal, attempts, received_at`;
    return row;
  }

  async #triage(taken: Taken): Promise<{ outcome: Outcome; workItem: string; ticketOpened: boolean }> {
    const { sql } = this.#o;
    const events = this.#events;
    const now = this.#o.now();
    const signal = taken.signal;

    // Its events may have been appended before a crash stopped the inbox hearing of it.
    const [done] = await sql<{ work_item: string; type: string }[]>`
      select work_item, type from events where id = ${idsFor(taken.id)()}`;
    if (done) {
      const [hold] = await sql<{ closed: boolean }[]>`
        select exists (select 1 from events c where c.work_item = ${done.work_item} and c.type = 'work-item.closed')
               as closed
        from events where work_item = ${done.work_item} and type = 'hold.started'
          and payload->>'cause' in ('burst', 'environment')
        limit 1`;
      if (hold?.closed) {
        // Martin answered the hold before the inbox heard it held this signal, so settling it passed the signal by:
        // the signal is let through now, as the hold's were, unless he rejected it.
        const rejected = await sql`select 1 from events where work_item = ${done.work_item}
                                   and type = 'work-item.closed' and payload->>'outcome' = 'discarded' limit 1`;
        if (rejected.length) return { outcome: 'held', workItem: done.work_item, ticketOpened: false };
        const made = await this.#sense(await this.#seen(signal), `burst:${taken.id}`, await openTickets(sql));
        if (made.events.length) await events.append(made.events);
        return { outcome: made.outcome, workItem: made.workItem, ticketOpened: made.ticket !== undefined };
      }
      const outcome = hold
        ? 'held'
        : judged(signal)
          ? signal.sense === 'planner'
            ? 'finding'
            : 'report'
          : done.type === 'work-item.opened'
            ? 'opened'
            : done.type === 'work-item.reopened'
              ? 'reopened'
              : 'evidence';
      // Counted once already, if at all: the time it took is not this attempt's.
      return { outcome, workItem: done.work_item, ticketOpened: false };
    }

    const tickets = await openTickets(sql);
    if (judged(signal)) {
      const finding = signal.sense === 'planner';
      const text = signal.report?.text;
      // The inbox refuses a report without its text; one that got in some other way is nothing to judge.
      if (!text) throw new Error(`A ${finding ? 'finding' : 'report'} reached triage without its text`);
      // The visitor may have typed the path, so anything private in it goes before anything is matched or asked.
      const page = privatePath(signal.report?.page ?? routeOf(signal));
      const route = privatePath(routeOf(signal));
      // A planner's finding is about something beyond the ticket it was planning, so it never joins that one.
      const others = tickets.filter((ticket) => ticket.workItem !== signal.planning);
      const candidates = others.filter((ticket) => onPage(ticket, route, page, signal.sense)).slice(0, 10);
      const decision = await judgeReport(
        { page, text, route },
        candidates.map(candidateOf),
        this.#o.judge,
        this.#o.read,
        finding ? routeFinding : routeReport,
        !finding,
      );
      // A report's ticket carries what was reported: a report Jev judged a repeat of a ticket that points at
      // something else opens the ticket it would have opened alone, with its own points.
      const repeated = decision.routed.route === 'repeat' ? decision.routed.joined : undefined;
      if (decision.alone && !samePoints(pointsOf(others.find((t) => t.workItem === repeated)), pointsOf(decision))) {
        decision.routed = decision.alone;
        const first = decision.judgements[0];
        if (first) {
          const { joined: _, ...alone } = first;
          decision.judgements[0] = { ...alone, route: 'ticket' };
        }
      }
      // One fingerprint, one ticket: a new ticket that matches an open one joins it instead, as does a defect the
      // planner noticed that an open ticket already has. A report's joins only one that points at the same thing.
      const { routed } = decision;
      const defect = routed.route === 'ticket' || (routed.route === 'park' && routed.defect !== undefined);
      const { fingerprint } = decision;
      const same =
        fingerprint &&
        others.find(
          (ticket) =>
            sameFingerprint(ticket.fingerprint, fingerprint, { open: ticket.sense, found: signal.sense }) &&
            (finding || samePoints(pointsOf(ticket), pointsOf(decision))),
        );
      // One fingerprint, one hold: a defect the planner noticed that one held already has is counted into that hold,
      // its words kept beside the first's, so Martin answers it once. One he has answered already takes it too: an
      // answer settles only the findings that reached the hold before it, and the hold then asks again
      // (`settleOne`). One that could not be settled as he answered is left.
      const twin =
        finding &&
        defect &&
        !same &&
        fingerprint &&
        (await parkedFindings(sql)).find((parked) =>
          sameFingerprint(parked.defect.fingerprint, fingerprint, { open: 'planner', found: 'planner' }),
        );
      const joins = same || twin;
      if (defect && joins) {
        decision.routed = { route: 'repeat', joined: joins.workItem };
        const first = decision.judgements[0];
        if (first) decision.judgements[0] = { ...first, route: 'repeat', joined: joins.workItem };
      }
      const workItem = decision.routed.route === 'repeat' ? decision.routed.joined : await nextWorkItem(sql);
      if (finding) {
        // A defect with the fingerprint of the ticket being planned cannot have a ticket of its own while that one is
        // open (one fingerprint, one ticket), and is not that ticket's to absorb: it is held, saying so, until that
        // ticket closes and a sense's ticket can take it, or Martin answers.
        const held = decision.routed.route === 'park' && decision.routed.defect && decision.fingerprint;
        const planned = held
          ? tickets.find(
              (ticket) =>
                ticket.workItem === signal.planning &&
                sameFingerprint(ticket.fingerprint, held, { open: ticket.sense, found: 'planner' }),
            )
          : undefined;
        await events.append(findingEvents(signal, taken.id, workItem, decision, now, planned?.workItem));
        return { outcome: 'finding', workItem, ticketOpened: false };
      }
      const opened = decision.routed.route === 'ticket' && decision.fingerprint;
      const joined = opened ? await this.#joinFindings(opened, workItem, 'report', taken.id, signal.sense) : [];
      await events.append([...reportEvents(signal, taken.id, workItem, decision, now), ...joined]);
      return { outcome: 'report', workItem, ticketOpened: decision.routed.route === 'ticket' };
    }

    const made = await this.#sense(await this.#seen(signal), taken.id, tickets, taken);
    if (made.events.length) await events.append(made.events);
    return { outcome: made.outcome, workItem: made.workItem, ticketOpened: made.ticket !== undefined };
  }

  /**
   * What a sense's signal makes, given the open tickets, with its events' ids from `seed`. One taken from the inbox
   * (`taken`) may be held instead of opening or reopening a ticket, or adding to an open one; one held, as Martin lets
   * it through, may not.
   */
  async #sense(signal: Seen, seed: string, tickets: Ticket[], taken?: Taken): Promise<Made> {
    const { sql } = this.#o;
    const now = this.#o.now();
    const fingerprint = { route: routeOf(signal), class: signal.symptom as DefectSymptom };
    const ticket = tickets.find((open) =>
      sameFingerprint(open.fingerprint, fingerprint, { open: open.sense, found: signal.sense }),
    );
    if (!ticket) {
      // One fingerprint, one ticket: the same defect on a ticket closed as verified is a regression of it.
      // A signal the sense saw before that close is of the version the fix replaced: counted, as a repeat is. So is
      // any signal on a ticket a dry run verified: its fix never shipped, so the sense still sees what it saw.
      const verified = await verifiedTicket(sql, fingerprint, signal.sense);
      if (verified && (verified.dryRun || Date.parse(signal.observedAt) <= verified.closedAt.getTime())) {
        return { outcome: 'counted', workItem: verified.workItem, events: [] };
      }
      const held = taken && (await this.#hold(signal, taken, tickets, verified ? 'reopen' : 'open'));
      if (held) return held;
      if (verified) {
        return {
          outcome: 'reopened',
          workItem: verified.workItem,
          events: senseReopened(signal, seed, verified.workItem, now),
        };
      }
      const workItem = await nextWorkItem(sql);
      const joined = await this.#joinFindings(fingerprint, workItem, 'sense', seed, signal.sense);
      const { category } = SYMPTOMS[fingerprint.class];
      return {
        outcome: 'opened',
        workItem,
        events: [...senseTicket(signal, seed, workItem, now), ...joined],
        ticket: {
          workItem,
          title: ticketTitle(fingerprint, signal.sense, signal.evidence),
          category,
          fingerprint,
          sense: signal.sense,
        },
      };
    }
    // Seen again in a version this sense has not seen it in, such as another release rolled back on it: the ticket
    // records it, with its evidence, for the console and for the planner when it takes the ticket.
    if (await seenIn(sql, ticket.workItem, signal.sense, signal.version))
      return { outcome: 'counted', workItem: ticket.workItem, events: [] };
    // Seen there in a version no release has just put live, it is found again, not re-seen: it counts toward a burst,
    // and is held in one, as a new problem is.
    const live: LiveTimes = new Map();
    const held =
      taken &&
      !(await released(sql, live, signal.version, taken.received_at)) &&
      (await this.#hold(signal, taken, tickets, 'add', live, ticket.workItem));
    if (held) return held;
    return {
      outcome: 'evidence',
      workItem: ticket.workItem,
      events: senseEvidence(signal, seed, ticket.workItem, now),
    };
  }

  /**
   * Holds a signal that would open or reopen a ticket if it was seen while what its sense reads was not seen to be
   * healthy; one that would add to an open ticket is never held for that. One that would open a ticket, or add to an
   * open one in a version no release explains, is also held if its sense has a hold waiting for Martin, or if with it the
   * sense has found more problems than `BURST.tickets` within `BURST.minutes` of it: the tickets it opened, the open
   * tickets it added to in versions no release explains, and those problems in its signals still waiting in the inbox,
   * which triage would otherwise take one by one. A held signal joins its sense's waiting hold, of either cause, or
   * starts one; a problem the hold has already is counted.
   */
  async #hold(
    signal: Seen,
    taken: Taken,
    tickets: Ticket[],
    would: 'open' | 'reopen' | 'add',
    live: LiveTimes = new Map(),
    /** The open ticket a signal that would add to one would add to. */
    onto?: string,
  ): Promise<Made | undefined> {
    const { sql } = this.#o;
    const now = this.#o.now();
    const unhealthy = would !== 'add' && !healthy(signal.environment);
    if (would === 'reopen' && !unhealthy) return undefined;
    const fingerprint = fingerprintOf(signal);
    const waiting = (await heldSignals(sql)).find((held) => held.sense === taken.sense);
    if (waiting) {
      const [seen] = await sql`select 1 from inbox where work_item = ${waiting.workItem} and outcome = 'held'
                               and fingerprint = ${fingerprint} limit 1`;
      if (seen) return { outcome: 'counted', workItem: waiting.workItem, events: [] };
      return {
        outcome: 'held',
        workItem: waiting.workItem,
        events: senseEvidence(signal, taken.id, waiting.workItem, now),
      };
    }
    if (unhealthy) {
      const workItem = await nextWorkItem(sql);
      return { outcome: 'held', workItem, events: environmentEvents(signal, taken.id, workItem, now) };
    }
    const near = await sql<
      {
        fingerprint: string;
        outcome: string | null;
        work_item: string | null;
        route: string;
        symptom: DefectSymptom;
        version: string;
        received_at: Date;
      }[]
    >`
      select fingerprint, outcome, work_item, signal->>'route' as route, signal->>'symptom' as symptom,
             signal->>'version' as version, received_at
      from inbox
      where sense = ${taken.sense} and id <> ${taken.id} and fingerprint is distinct from ${fingerprint}
        and received_at between ${taken.received_at}::timestamptz - make_interval(mins => ${BURST.minutes})
                            and ${taken.received_at}::timestamptz + make_interval(mins => ${BURST.minutes})
        and (outcome in ('opened', 'evidence') or (triaged_at is null and attempts < ${INBOX.attempts}))`;
    const explains = (version: string, at: Date) => released(sql, live, version, at);
    // The tickets the sense opened and the open tickets it found problems on again, each ticket once, and the new
    // problems waiting, each fingerprint once. A ticket it opened and then found again in another version is one
    // problem, as is a ticket on every route found again on several routes, and the ticket this signal would add to.
    const opened = new Set<string>();
    const again = new Set<string>();
    const fresh = new Map<string, { route: string; class: DefectSymptom }>();
    for (const row of near) {
      const found = { route: row.route, class: row.symptom };
      if (row.outcome === 'opened') opened.add(row.work_item ?? row.fingerprint);
      else if (row.outcome === 'evidence') {
        if (!(await explains(row.version, row.received_at))) again.add(row.work_item ?? row.fingerprint);
      } else {
        const open = tickets.find((ticket) =>
          sameFingerprint(ticket.fingerprint, found, { open: ticket.sense, found: signal.sense }),
        );
        if (!open) fresh.set(row.fingerprint, found);
        else if (
          !(await seenIn(sql, open.workItem, signal.sense, row.version)) &&
          !(await explains(row.version, row.received_at))
        ) {
          again.add(open.workItem);
        }
      }
    }
    // A waiting signal that a verified ticket has exactly would reopen it, which never counts.
    if (onto) {
      opened.delete(onto);
      again.delete(onto);
    }
    let ahead = [...again].filter((ticket) => !opened.has(ticket)).length;
    for (const found of fresh.values()) if (!(await verifiedTicket(sql, found, signal.sense))) ahead++;
    const found = 1 + opened.size + ahead;
    if (found <= BURST.tickets) return undefined;
    const workItem = await nextWorkItem(sql);
    return { outcome: 'held', workItem, events: burstEvents(signal, taken.id, workItem, found, now) };
  }
}

/** Whether a sense has seen what an open ticket has in a version of the app: the ticket has its signal there. */
async function seenIn(sql: Sql, workItem: string, sense: string, version: string): Promise<boolean> {
  const [seen] = await sql`select 1 from events where work_item = ${workItem} and type = 'signal.received'
                           and payload->>'sense' = ${sense} and payload->>'version' = ${version} limit 1`;
  return seen !== undefined;
}

/**
 * Whether a release explains a signal in a version of the app that reached the inbox at `at`: that version went live
 * at most `BURST.releaseMinutes` before. A release puts a version live, and every sense sees each open ticket's defect
 * there again within a run or two, which is the release's doing, not a burst. A sighting later than that is found
 * again, which is the sense's doing: a defect back after it had stopped seeing it, or a fault in what it reads.
 */
async function released(sql: Sql, live: LiveTimes, version: string, at: Date): Promise<boolean> {
  if (!live.has(version)) live.set(version, await liveSince(sql, version));
  const since = live.get(version);
  return !since || at.getTime() <= since.getTime() + BURST.releaseMinutes * 60_000;
}

/** When each version of the app went live, as one signal's triage has asked: each is asked once. */
type LiveTimes = Map<string, Date | undefined>;

/**
 * When a version of the app last went live: when its canary started, when it was promoted, or when a release rolled
 * back, aborted or errored restored it, as the line recorded; or, for a release the line did not watch, when a sense
 * first saw it.
 */
async function liveSince(sql: Sql, version: string): Promise<Date | undefined> {
  const [row] = await sql<{ live: Date | null }[]>`
    select coalesce(
      (select max(ts) from events
       where (type in ('release.started', 'release.promoted') and payload->>'version' = ${version})
          or (type in ('release.rolled-back', 'release.aborted', 'release.errored')
              and payload->>'restored' = ${version})),
      least((select min(received_at) from inbox where signal->>'version' = ${version}),
            (select min(ts) from events where type = 'signal.received' and payload->>'version' = ${version}))
    ) as live`;
  return row?.live ? new Date(row.live) : undefined;
}

/** A hold of triage's that Martin may have answered. */
interface Answerable {
  workItem: string;
  /** Martin's answer, when he has approved or rejected it and triage has yet to do as he said. */
  decision: 'approved' | 'rejected' | null;
  /** Where his last answer since it was held is in the store, if he has answered. */
  answered: string | null;
}

/** Acting on one of Martin's answers to a hold: a new answer is tried afresh. */
const settleKey = (hold: Answerable) => `${hold.workItem}:${hold.answered ?? ''}`;

/** A defect the planner noticed, parked for a sense or Martin: held, with no ticket and not closed. */
interface Parked extends Answerable {
  defect: ParkedDefect;
  /** Whether a finding reached the hold after that answer, in the store's order: words he answered without reading. */
  late: boolean;
}

/**
 * Every defect the planner noticed that is held, with no ticket and not closed, oldest first, with Martin's last
 * answer to it. The finding holds have an index of their own (0007), so this reads only them.
 */
async function parkedFindings(sql: Sql): Promise<Parked[]> {
  const rows = await sql<
    { work_item: string; defect: ParkedDefect; decision: string | null; answered: string | null; late: boolean }[]
  >`
    select h.work_item, h.payload->'defect' as defect, a.decision, a.seq as answered,
           a.seq is not null and exists (select 1 from events s where s.work_item = h.work_item
                                         and s.type = 'signal.received' and s.seq > a.seq) as late
    from events h
    left join lateral (
      select a.payload->>'decision' as decision, a.seq from events a
      where a.work_item = h.work_item and a.type = 'hold.answered' and a.seq > h.seq and ${fromMartin(sql, 'a')}
      order by a.seq desc limit 1
    ) a on true
    where h.type = 'hold.started' and h.payload->>'cause' = 'finding'
      and not exists (select 1 from events e where e.work_item = h.work_item
                      and e.type in ('work-item.closed', 'ticket.opened'))
      -- A hold started again is its question now: only the latest, and the answers after it.
      and not exists (select 1 from events n where n.work_item = h.work_item and n.type = 'hold.started'
                      and n.seq > h.seq)
    order by h.seq`;
  return rows.map((row) => ({
    workItem: row.work_item,
    defect: row.defect,
    decision: decisionOf(row.decision),
    answered: row.answered,
    late: row.late,
  }));
}

/**
 * Every suggestion still held, oldest first, with Martin's last answer to it: its hold, and his answers after it, from
 * his roles alone.
 */
async function heldSuggestions(sql: Sql): Promise<Answerable[]> {
  const rows = await sql<{ work_item: string; decision: string | null; answered: string | null }[]>`
    select h.work_item, a.decision, a.seq as answered
    from events h
    left join lateral (
      select a.payload->>'decision' as decision, a.seq from events a
      where a.work_item = h.work_item and a.type = 'hold.answered' and a.seq > h.seq and ${fromMartin(sql, 'a')}
      order by a.seq desc limit 1
    ) a on true
    where h.type = 'hold.started' and h.payload->>'cause' = 'suggestion'
      and not exists (select 1 from events e where e.work_item = h.work_item and e.type = 'work-item.closed')
      and not exists (select 1 from events n where n.work_item = h.work_item and n.type = 'hold.started'
                      and n.seq > h.seq)
    order by h.seq`;
  return rows.map((row) => ({ workItem: row.work_item, decision: decisionOf(row.decision), answered: row.answered }));
}

const decisionOf = (decision: string | null) => (decision === 'approved' || decision === 'rejected' ? decision : null);

/**
 * Signals triage holds for Martin, a burst or a sense's problems seen while what it reads was not healthy: the sense
 * whose signals it holds, and his answer, when triage has yet to act on it.
 */
interface Held extends Answerable {
  cause: 'burst' | 'environment';
  sense: string;
}

/**
 * Every hold of a sense's signals still waiting, oldest first, with Martin's last answer to it. Their holds have an
 * index of their own (0015).
 */
async function heldSignals(sql: Sql): Promise<Held[]> {
  const rows = await sql<
    {
      work_item: string;
      cause: Held['cause'];
      sense: string;
      decision: string | null;
      answered: string | null;
    }[]
  >`
    select h.work_item, h.payload->>'cause' as cause,
           (select s.payload->>'sense' from events s
            where s.work_item = h.work_item and s.type = 'signal.received' order by s.seq limit 1) as sense,
           a.decision, a.seq as answered
    from events h
    left join lateral (
      select a.payload->>'decision' as decision, a.seq from events a
      where a.work_item = h.work_item and a.type = 'hold.answered' and a.seq > h.seq and ${fromMartin(sql, 'a')}
      order by a.seq desc limit 1
    ) a on true
    where h.type = 'hold.started' and h.payload->>'cause' in ('burst', 'environment')
      and not exists (select 1 from events e where e.work_item = h.work_item and e.type = 'work-item.closed')
      -- A hold started again, when triage could not do as he answered, is its question now: the answers after it.
      and not exists (select 1 from events n where n.work_item = h.work_item and n.type = 'hold.started'
                      and n.seq > h.seq)
    order by h.seq`;
  return rows.map((row) => ({
    workItem: row.work_item,
    cause: row.cause,
    sense: row.sense,
    decision: decisionOf(row.decision),
    answered: row.answered,
  }));
}

/** Whether a signal's words are for Jev to judge: a visitor's report, or a planner's finding. */
const judged = (signal: InboxSignal) => signal.sense === 'report' || signal.sense === 'planner';

/** Tickets whose work item is open: never closed, or reopened since it last closed. */
export async function openTickets(sql: Sql): Promise<Ticket[]> {
  const rows = await sql<{ work_item: string; payload: PayloadOf<'ticket.opened'>; sense: SignalSource | null }[]>`
    select t.work_item, t.payload,
           (select s.payload->>'sense' from events s
            where s.work_item = t.work_item and s.type = 'signal.received' order by s.seq limit 1) as sense
    from events t
    where t.type = 'ticket.opened' and ${lastEnd(sql, 't.work_item')} is distinct from 'work-item.closed'
    order by t.seq desc`;
  return rows.map(({ work_item, payload, sense }) => ({
    workItem: work_item,
    title: payload.title,
    category: payload.category,
    fingerprint: payload.fingerprint,
    ...(payload.points && { points: payload.points }),
    sense: sense ?? undefined,
  }));
}

/**
 * The latest ticket whose last close or reopening is a close as verified, with exactly this fingerprint, when it
 * closed, and whether its last verification was a dry run's. Exactly: a ticket on every route matches each route's
 * signal while it is open, but a signal on one route is not the same defect come back as a ticket on all of them, nor
 * the other way round. Only a verified close reopens (a ticket closed any other way was never fixed, or never a
 * defect), and only a sense's fingerprint is matched. On every route, the canary's and the other senses' are not the
 * same problem (`sameFingerprint`).
 */
async function verifiedTicket(sql: Sql, fingerprint: { route: string; class: DefectSymptom }, source: SignalSource) {
  const [row] = await sql<{ work_item: string; closed_at: Date; dry_run: boolean }[]>`
    select t.work_item, last_end.ts as closed_at, coalesce(last_check.dry_run, false) as dry_run from events t
    left join lateral (
      select s.payload->>'sense' as sense from events s
      where s.work_item = t.work_item and s.type = 'signal.received' order by s.seq limit 1
    ) opener on true
    cross join lateral (
      select c.type, c.ts, c.payload->>'outcome' as outcome from events c
      where c.work_item = t.work_item and c.type in ('work-item.closed', 'work-item.reopened')
      order by c.seq desc limit 1
    ) last_end
    left join lateral (
      -- A version 1 verification has no dryRun: it was never a dry run's. Nor is a look again that cleared, which a
      -- real sense made on a real release.
      select (v.payload->>'dryRun')::boolean as dry_run from events v
      where v.work_item = t.work_item
        and (v.type = 'verification.finished' or (v.type = 'signal.rechecked' and v.payload->>'outcome' = 'cleared'))
      order by v.seq desc limit 1
    ) last_check on true
    where t.type = 'ticket.opened'
      and t.payload->'fingerprint'->>'route' = ${fingerprint.route}
      and t.payload->'fingerprint'->>'class' = ${fingerprint.class}
      and last_end.type = 'work-item.closed' and last_end.outcome = 'verified'
      and (${fingerprint.route} <> '*' or (coalesce(opener.sense, '') = 'canary') = ${source === 'canary'})
    order by t.seq desc limit 1`;
  return row && { workItem: row.work_item, closedAt: new Date(row.closed_at), dryRun: row.dry_run };
}

type Fingerprint = PayloadOf<'ticket.opened'>['fingerprint'];

/**
 * The same problem: the same class on the same route, or on every route; the same passage of the same page; or the
 * same move, by its name and ecosystem, whatever its target. Given
 * where the open ticket's first signal and what was found came from, a route of `*` means what its source means by it
 * (`everyRoute`).
 */
export function sameFingerprint(
  open: Fingerprint,
  found: Fingerprint,
  sources?: { open: SignalSource | undefined; found: SignalSource },
): boolean {
  if ('class' in open && 'class' in found) {
    if (open.class !== found.class) return false;
    const widens = !sources || everyRoute(sources.open, sources.found);
    const alike = !sources || (sources.open === 'canary') === (sources.found === 'canary');
    if (open.route === found.route) return open.route !== '*' || alike;
    return widens && open.route === '*';
  }
  if ('page' in open && 'page' in found) return open.page === found.page && open.text === found.text;
  if ('ecosystem' in open && 'ecosystem' in found)
    return open.name === found.name && open.ecosystem === found.ecosystem;
  return false;
}

/**
 * Whether an open ticket on every route (`*`) takes what is seen on one route of its class. A sense's `*` says it saw
 * the problem on every page it checked. The canary's says only that a release did worse on more than one route, as a
 * whole: another sense's signal on one route is not shown to be its defect, nor its rollback another sense's, and the
 * canary's `*` is not another sense's `*` either. So where either side is the canary, only the same route is the same
 * problem, and on every route only when both are the canary's.
 */
export const everyRoute = (ticket: SignalSource | undefined, found: SignalSource) =>
  ticket !== 'canary' && found !== 'canary';

function defectCategory(ticket: Ticket): DefectCategory {
  if (ticket.category === 'dependency') throw new Error(`Ticket #${ticket.workItem} is a dependency's, on no page`);
  return ticket.category;
}

/** Whether a report sent from a page could be about this ticket. A dependency's ticket is on no page. */
const onPage = (ticket: Ticket, route: string, page: string, source: SignalSource) =>
  'class' in ticket.fingerprint
    ? ticket.fingerprint.route === route || (everyRoute(ticket.sense, source) && ticket.fingerprint.route === '*')
    : 'page' in ticket.fingerprint && ticket.fingerprint.page === page;

/** An open ticket offered as one a report might repeat: a defect's, since only a defect's ticket is on a page (`onPage`). */
const candidateOf = (ticket: Ticket): Candidate => ({
  workItem: ticket.workItem,
  title: ticket.title,
  category: defectCategory(ticket),
  symptom: 'class' in ticket.fingerprint ? ticket.fingerprint.class : undefined,
});

/** What `run` waits on: a nudge (a signal, an event, the abort), or the time it was given, whichever is first. */
class Wake {
  #woken = Promise.withResolvers<void>();
  readonly nudge = () => this.#woken.resolve();

  async after(ms: number): Promise<void> {
    const timer = setTimeout(this.nudge, ms);
    await this.#woken.promise;
    clearTimeout(timer);
    this.#woken = Promise.withResolvers<void>();
  }
}

/** Triage's lock is no longer held by the connection that took it: another copy may hold it now. */
class LockLost extends Error {
  constructor(cause: unknown) {
    super('triage lost its lock on the store', { cause });
    this.name = 'LockLost';
  }
}
