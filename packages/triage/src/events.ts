/**
 * The events triage writes for each outcome, with summaries from templates over typed fields. A report's text is
 * never in a summary, a title or a story: those are public.
 *
 * Every event's id is derived from the signal's id in the inbox, so triage taking the same signal again after a
 * crash appends nothing twice (the store stores an event appended again once).
 */
import { createHash } from 'node:crypto';
import {
  cutTo,
  type Dependency,
  type Environment,
  type EventType,
  type InboxSignal,
  type NewEvent,
  type PayloadOf,
  type Sense,
  type SignalSource,
  type SymptomClass,
  VERSIONS,
} from '@software-factory/events';
import { guardrailsFor } from '../../../policy/refusals.ts';
import { BURST, REPORT_TEXT, SYMPTOMS } from '../../../policy/triage.ts';
import type { Fingerprint, Judgement, ReportDecision } from './reports.ts';
import { privatePath, shortPath } from './scrub.ts';

/** A UUID that is always the same for the same seed: version 8, for a custom scheme, with the RFC 9562 variant. */
export function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  h[12] = '8';
  h[16] = ((Number.parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Ids for the events made from one signal: the same signal always gives the same ids, in the same order. */
export function idsFor(signalId: string): () => string {
  let n = 0;
  return () => uuidFrom(`triage:${signalId}:${n++}`);
}

/** A sense's signal as triage records it: as the sense left it, with triage's look at what it reads, if it took one. */
export type Seen = InboxSignal & { environment?: Environment };

/** Whether everything a sense reads was seen to be healthy: a dependency triage could not tell about was not. */
export const healthy = (environment: Environment | undefined) =>
  !environment || environment.dependencies.every((dependency) => dependency.healthy === true);

/** Writes a work item's events in order, with ids from the signal and one time for all of them. */
class Writer {
  readonly events: NewEvent[] = [];
  readonly #id: () => string;
  readonly #signalId: string;
  readonly #item: string;
  readonly #ts: string;

  constructor(signalId: string, workItem: string, now: Date) {
    this.#id = idsFor(signalId);
    this.#signalId = signalId;
    this.#item = workItem;
    this.#ts = now.toISOString();
  }

  /**
   * Adds an event, with the next id from the signal, or with one from the signal and `named`, for an event added after
   * the others' ids were set: the events around it keep theirs, so a retried append stores nothing twice.
   */
  add<K extends EventType>(
    type: K,
    actor: NewEvent<K>['actor'],
    summary: string,
    payload: PayloadOf<K>,
    artifacts: NewEvent<K>['artifacts'] = [],
    named?: string,
  ): this {
    this.events.push({
      id: named ? uuidFrom(`triage:${this.#signalId}:${named}`) : this.#id(),
      ts: this.#ts,
      work_item: this.#item,
      type,
      version: VERSIONS[type],
      actor,
      summary,
      payload,
      artifacts,
    } as NewEvent);
    return this;
  }
}

const SENSE_NAMES: Record<Exclude<Sense, 'report'>, string> = {
  probe: 'The probes',
  crawler: 'The crawler',
  metrics: 'The metrics',
  logs: 'The log watcher',
  canary: 'The canary',
};

/** A ticket's title, from what was seen and where. */
const TITLES: Record<SymptomClass, string> = {
  'broken-link': 'A link leads nowhere',
  'broken-image': 'An image does not load',
  'redirect-loop': 'A page redirects without end',
  'wrong-result': 'A wrong result',
  'rejects-valid-input': 'Valid input is refused',
  'server-error': 'Server errors',
  'browser-error': 'Errors in the browser',
  'slow-response': 'Slow responses',
  'not-cached': 'Files the browser may not keep',
  'missing-alt': 'Images without alternative text',
  'low-contrast': 'Text too faint to read',
  'unlabelled-field': 'A form field without a label',
  'missing-header': 'A security header is missing',
  'leaks-detail': 'Errors give away the server’s insides',
  'missing-log': 'Requests leave no log record',
  'wrong-metric': 'Metrics with a wrong label',
};

/**
 * Where a canary's signal on `*` is: its analysis found the canary worse on more than one route, or could not name
 * one. Any other sense's `*` is every page it checked.
 */
export const CANARY_ANY_ROUTE = 'routes it could not narrow to one';

const where = (route: string, sense?: SignalSource) =>
  route !== '*' ? shortPath(route) : sense === 'canary' ? CANARY_ANY_ROUTE : 'every page';

/** A ticket's title, from what was seen and where, and by which sense when it was a sense. */
export const ticketTitle = (fingerprint: Fingerprint, sense?: SignalSource): string =>
  !('class' in fingerprint)
    ? `Wrong words on ${shortPath(fingerprint.page)}`
    : fingerprint.route === '*' && sense === 'canary'
      ? `${TITLES[fingerprint.class]} in a canary release`
      : `${TITLES[fingerprint.class]} on ${where(fingerprint.route)}`;

/** A report's ticket says a visitor raised it. Its title is the factory's words, never the visitor's. */
export const reportedTitle = (fingerprint: Fingerprint): string => {
  const title = ticketTitle(fingerprint);
  return `A visitor reports ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
};

/** Trace ids in the signal's evidence, so the planner can follow a failing request. */
function tracesOf(signal: InboxSignal): string[] {
  const ids = (signal.evidence ?? []).flatMap((evidence) =>
    evidence.kind === 'logs'
      ? [...(evidence.trace ? [evidence.trace.id] : []), ...evidence.lines.flatMap((line) => line.traceId ?? [])]
      : [],
  );
  return [...new Set(ids)].slice(0, 10);
}

/** The signal as an event of the work item, with its own artifacts. */
function signalEvent(writer: Writer, signal: Seen): Writer {
  const { observedAt: _at, summary, artifacts, ...payload } = signal;
  const actor = signal.sense === 'report' ? 'widget' : signal.sense;
  const page = shortPath(payload.report?.page ?? payload.route);
  const line =
    signal.sense === 'report'
      ? `A visitor reported a problem on ${page}`
      : signal.sense === 'planner'
        ? `The planner noted something on ${page}`
        : (summary ?? `${signal.check}: ${TITLES[signal.symptom as SymptomClass].toLowerCase()}`);
  return writer.add('signal.received', actor, line, payload, artifacts);
}

/** A sense's signal with a fingerprint no open ticket has: a new work item with its ticket, waiting for Plan. */
export function senseTicket(signal: Seen, signalId: string, workItem: string, now: Date): NewEvent[] {
  const symptom = signal.symptom as SymptomClass;
  const { category, severity } = SYMPTOMS[symptom];
  const fingerprint = { route: signal.route, class: symptom };
  const title = ticketTitle(fingerprint, signal.sense);
  const sense = SENSE_NAMES[signal.sense as Exclude<Sense, 'report'>];
  const writer = new Writer(signalId, workItem, now);
  writer.add('work-item.opened', 'triage', `${sense} opened a work item`, {
    kind: 'defect-fix',
    title,
    sample: false,
    category,
  });
  signalEvent(writer, signal);
  writer.add('ticket.opened', 'triage', `Ticket #${workItem}: ${category}, ${severity}`, {
    title,
    category,
    severity,
    fingerprint,
    traces: tracesOf(signal),
  });
  const how =
    signal.sense === 'canary'
      ? `The canary’s analysis found it on ${where(signal.route, signal.sense)} in version ${signal.version}, which did worse on ${signal.check} than the version it would have replaced, and the release rolled back.`
      : `${sense} found it on ${where(signal.route)} in version ${signal.version}, on two checks in a row: ${signal.check}.`;
  return writer.add('work-item.summarised', 'triage', 'Summary written', {
    title,
    description: `${sense} found it: ${signal.check}. Triage opened a ticket, ${category} and ${severity}.`,
    story: `${how} A sense knows what it saw, so the ticket’s category and severity come from the policy’s table for the symptom, not from a model. Triage opened ticket #${workItem} with the evidence the sense captured.`,
  }).events;
}

/** A sense's signal on an open ticket, its first in this version of the app: its evidence joins the ticket. */
export function senseEvidence(signal: Seen, signalId: string, workItem: string, now: Date): NewEvent[] {
  return signalEvent(new Writer(signalId, workItem, now), signal).events;
}

/**
 * A sense's signal on a ticket closed as verified: the same defect came back. The work item reopens, saying what
 * came back, and the signal joins it with its evidence.
 */
export function senseReopened(signal: Seen, signalId: string, workItem: string, now: Date): NewEvent[] {
  const sense = signal.sense as Exclude<Sense, 'report'>;
  const reason = `${SENSE_NAMES[sense]} saw it again on ${where(signal.route, sense)} in version ${signal.version}: ${signal.check}`;
  const writer = new Writer(signalId, workItem, now);
  writer.add('work-item.reopened', 'triage', `Reopened: ${SENSE_NAMES[sense].toLowerCase()} saw it again`, {
    sense,
    check: signal.check,
    route: signal.route,
    version: signal.version,
    reason: cutTo(reason, 200),
    dryRun: false,
  });
  return signalEvent(writer, signal).events;
}

/**
 * A sense's signal that would have opened a ticket, or added to an open one in a version no release explains, and with
 * the others found with it makes a burst: a work item held for Martin, with the signal as its first evidence and none
 * of its problems a ticket or on one. `found` is how many it found.
 */
export function burstEvents(signal: Seen, signalId: string, workItem: string, found: number, now: Date): NewEvent[] {
  const sense = SENSE_NAMES[signal.sense as Exclude<Sense, 'report'>];
  const title = `A burst of new problems from ${lower(sense)}`;
  const writer = new Writer(signalId, workItem, now);
  writer.add('work-item.opened', 'triage', `${sense} found a burst of new problems`, {
    kind: 'defect-fix',
    title,
    sample: false,
    category: SYMPTOMS[signal.symptom as SymptomClass].category,
  });
  signalEvent(writer, signal);
  writer.add('hold.started', 'triage', 'Held for Martin: a burst of new problems', {
    stage: 'triage',
    kind: 'held',
    cause: 'burst',
    reason: `${sense} found ${found} new problems within ${BURST.minutes} minutes, more than ${BURST.tickets} at once, counting open tickets' problems it saw again: it may be what it reads that is at fault. None reaches a ticket until Martin looks. Approving opens a ticket or adds to one for each; rejecting closes them all.`,
  });
  return summarise(writer, {
    title,
    description: `${sense} found ${found} new problems at once. Triage held them for Martin as one burst, before any has a ticket or reaches Plan.`,
    story: `${sense} found ${found} new problems within ${BURST.minutes} minutes, first on ${where(signal.route)} in version ${signal.version}: ${signal.check}. That may be as many defects, or one fault in what the sense reads, and each ticket would cost a planner’s step and more. So triage opened none, and held the burst for Martin, for every new problem the sense found while it waited to join. An open ticket’s problem seen again in a version no release has just put live counts as new: the sense had stopped seeing it, or what it reads is at fault. Approving opens a ticket for each, as the sense’s would have been, or adds it to its open ticket; rejecting closes them all, and a problem still there is found again.`,
  });
}

const DEPENDENCY_NAMES: Record<Dependency, string> = {
  prometheus: 'Prometheus',
  loki: 'Loki',
  tempo: 'Tempo',
  disk: 'the cluster’s disk',
};

/**
 * A sense's signal that would have opened or reopened a ticket, seen while something the sense reads was not seen to
 * be healthy: a work item held for Martin, with the signal and triage's look as its first evidence and none of its
 * problems a ticket. No agent can mend the factory's environment.
 */
export function environmentEvents(signal: Seen, signalId: string, workItem: string, now: Date): NewEvent[] {
  const sense = SENSE_NAMES[signal.sense as Exclude<Sense, 'report'>];
  const unhealthy = (signal.environment?.dependencies ?? []).filter((dependency) => dependency.healthy !== true);
  const names = unhealthy.map((dependency) => DEPENDENCY_NAMES[dependency.name]);
  const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const which = `${listed ?? 'what it reads'} ${names.length > 1 ? 'were' : 'was'} not healthy`;
  const title = `New problems from ${lower(sense)}, while ${which}`;
  const writer = new Writer(signalId, workItem, now);
  writer.add('work-item.opened', 'triage', `${sense} found a problem while ${which}`, {
    kind: 'defect-fix',
    title: cutTo(title, 120),
    sample: false,
    category: SYMPTOMS[signal.symptom as SymptomClass].category,
  });
  signalEvent(writer, signal);
  writer.add('hold.started', 'triage', 'Held for Martin: what the sense reads was not healthy', {
    stage: 'triage',
    kind: 'held',
    cause: 'environment',
    reason: `${sense} found a new problem while ${which}: the factory’s environment may be at fault, not the app, and no agent can mend that. None has a ticket until Martin looks. Approving opens a ticket for each; rejecting closes them all.`,
  });
  const looked = unhealthy.map((dependency) => `${DEPENDENCY_NAMES[dependency.name]}, ${dependency.saw}`).join('; ');
  return summarise(writer, {
    title: cutTo(title, 120),
    description: `${sense} found a new problem while ${which}. Triage held it for Martin before it had a ticket: no agent can mend the factory’s environment.`,
    story: cutTo(
      `${sense} found a new problem on ${where(signal.route, signal.sense)} in version ${signal.version}: ${signal.check}. Before trusting it, triage looked at what the sense reads besides the app, as it stood then (${looked}). A sense reading a backend that stores nothing, or on a full disk, can see a fault in the app that is not there, and no agent can mend its environment: each ticket would cost a planner’s step and more for nothing. So triage opened none, and held it for Martin, for every new problem the sense found while it waited to join. Approving opens a ticket for each, as the sense’s would have been; rejecting closes them all, and a problem still there is found again.`,
      1200,
    ),
  });
}

/**
 * Signals triage held for Martin close when he answers: a burst, or a sense's new problems seen while what it reads was
 * not healthy. Approving lets them through, with the tickets they opened (`opened`, which may be none if open tickets
 * had them); rejecting closes them with none.
 */
export function closedHeld(
  workItem: string,
  cause: 'burst' | 'environment',
  why: { opened: readonly string[] } | { rejected: true },
  now: Date,
): NewEvent[] {
  const writer = new Writer(`burst:${workItem}:closed`, workItem, now);
  if ('rejected' in why) {
    const held = cause === 'burst' ? 'the burst' : 'the held problems';
    return writer.add('work-item.closed', 'triage', `Closed: Martin rejected ${held}`, {
      outcome: 'discarded',
      reason: `Martin rejected ${held}: none of ${cause === 'burst' ? 'its problems' : 'them'} has a ticket`,
    }).events;
  }
  const [first] = why.opened;
  const reason = !first
    ? 'Martin let it through: open tickets already had every problem in it'
    : why.opened.length === 1
      ? `Martin let it through: ticket #${first}`
      : `Martin let it through: ${why.opened.length} tickets, from #${first}`;
  return writer.add('work-item.closed', 'triage', reason, { outcome: 'no-change', reason }).events;
}

/** A hold of triage's that Martin answers, as it starts again: its cause, and a finding's defect. */
export type AskedAgain = { cause: 'finding'; defect: ParkedDefect } | { cause: 'burst' | 'environment' | 'suggestion' };

/**
 * Triage could not do as Martin answered one of its holds, in as many tries as it gives a signal, and leaves his
 * answer: the hold starts again, with its cause, saying so, and waits for his next answer, which it tries afresh.
 * `answered` is where the answer it could not act on is in the store, so this is written once for each such answer.
 */
export function askedAgain(
  workItem: string,
  held: AskedAgain,
  decision: 'approved' | 'rejected',
  answered: string,
  tries: number,
  now: Date,
): NewEvent[] {
  const did = decision === 'approved' ? 'approval' : 'rejection';
  return new Writer(`again:${workItem}:${answered}`, workItem, now).add(
    'hold.started',
    'triage',
    `Waiting for Martin again: triage could not act on his ${did}`,
    {
      stage: 'triage',
      // A suggestion waits for Martin's decision, as it did; the rest are held.
      kind: held.cause === 'suggestion' ? 'approval' : 'held',
      ...held,
      reason: `Triage tried ${tries} times to act on Martin's ${did} and could not; its log says why. It has stopped trying, and waits for his answer again.`,
    },
  ).events;
}

const lower = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

const QUARANTINED = 'The report holds instructions aimed at the system, so nothing acts on it';

/**
 * Jev's typed answers, verbatim with their probabilities, as a quarantine's refusal records them: one line an answer,
 * of each request to Jev, without the question, which is the factory's own.
 */
export function typedAnswers(judgements: readonly Judgement[]): string {
  return judgements
    .flatMap((judgement) => [
      `${judgement.questionSet}, ${judgement.model}:`,
      ...judgement.answers.map(({ question: _, ...answer }) => JSON.stringify(answer)),
    ])
    .join('\n');
}

/**
 * Triage's typed judgement refusing a report or a planner's finding (`action.refused`, guardrail 8): routing code
 * quarantined it on Jev's answers, so nothing acts on it. Before its work item closes, which takes no more events.
 */
function refused(writer: Writer, decision: ReportDecision, action: string, summary: string): void {
  writer.add(
    'action.refused',
    'triage',
    summary,
    {
      mechanism: 'typed-judgement',
      action,
      output: cutTo(typedAnswers(decision.judgements), 4000),
      guardrails: guardrailsFor('typed-judgement', 'quarantined'),
    },
    [],
    'refused',
  );
}

/**
 * The events a judged signal starts with, a report or a planner's finding: its work item opened (unless it joins an
 * open one), the signal with the page it names and its words scrubbed, and the factory's screenshot of that page, then
 * each request to Jev. Its page is given for the rest of its events, as a reader sees it.
 */
function judged(
  writer: Writer,
  signal: InboxSignal,
  decision: ReportDecision,
  opened: (page: string) => { actor: 'visitor' | 'planner'; summary: string; payload: PayloadOf<'work-item.opened'> },
): { writer: Writer; page: string } {
  // The page without its query or anything private in its path: whoever sent it may have typed either.
  const path = privatePath(signal.report?.page ?? signal.route);
  const page = shortPath(path);
  if (decision.routed.route !== 'repeat') {
    const { actor, summary, payload } = opened(page);
    writer.add('work-item.opened', actor, summary, payload);
  }
  const shot = decision.screenshot ? [decision.screenshot] : [];
  signalEvent(writer, {
    ...signal,
    route: privatePath(signal.route),
    report: { page: path, text: decision.text },
    artifacts: [...signal.artifacts, ...shot],
  });
  for (const judgement of decision.judgements) {
    writer.add('judgement.made', 'triage', judgementLine(judgement), judgement);
  }
  return { writer, page };
}

/** Every report becomes events, because whoever sent it is owed an answer. */
export function reportEvents(
  signal: InboxSignal,
  signalId: string,
  workItem: string,
  decision: ReportDecision,
  now: Date,
): NewEvent[] {
  const { routed } = decision;
  const { writer, page } = judged(new Writer(signalId, workItem, now), signal, decision, (page) => ({
    actor: 'visitor',
    summary: `A visitor sent a report from ${page}`,
    payload: {
      kind: 'visitor-report',
      title: `A report from ${page}`,
      sample: false,
      ...(CARD_CATEGORY[routed.route] && { category: CARD_CATEGORY[routed.route] }),
    },
  }));

  switch (routed.route) {
    case 'quarantine':
      refused(
        writer,
        decision,
        `Act on a visitor’s report from ${page}`,
        'Typed judgement refused the report: Jev read instructions aimed at the system in it',
      );
      writer.add('work-item.closed', 'triage', 'Quarantined: the report gives orders to the system', {
        outcome: 'quarantined',
        reason: QUARANTINED,
      });
      return summarise(writer, {
        title: 'A report that gave orders',
        description:
          'Jev read it as instructions aimed at the system, so triage quarantined it. No ticket, and no agent ever reads it.',
        story: `A visitor sent a report from ${page}. Report text is untrusted, so it went to Jev as data, and Jev can only answer the questions it is asked. It judged that the report holds instructions aimed at the system, and routing code quarantined it before anything else. Its text is kept as evidence for ${REPORT_TEXT.promisedDays} days; no generative agent ever reads it.`,
      });
    case 'park':
      writer.add('hold.started', 'triage', 'Waiting for Martin: a visitor suggested a change', {
        stage: 'triage',
        kind: 'approval',
        cause: 'suggestion',
        reason:
          'A visitor asked for something new, and only Martin asks for improvements: it waits for Martin to decide.',
      });
      return summarise(writer, {
        title: 'A visitor’s suggestion',
        description:
          'Jev read it as a request for something new, not a fault. Triage parked it for Martin, who alone asks for improvements.',
        story: `A visitor sent a report from ${page}. Jev judged it a suggestion: a request for new behaviour rather than a fault. Only Martin can ask for an improvement, so routing code parked it for Martin instead of opening a ticket.`,
      });
    case 'discard':
      writer.add('work-item.closed', 'triage', 'Closed with no ticket: not a defect', {
        outcome: 'discarded',
        reason: 'Jev found nothing wrong with the page in it',
      });
      return summarise(writer, {
        title: `A report from ${page} that was not a defect`,
        description: 'Triage read the report against the page and found nothing wrong. No ticket, nothing built.',
        story: `A visitor sent a report from ${page}. It went to Jev as data, and Jev judged that it describes nothing wrong with the site. Routing code closed it with no ticket. Its text is kept for ${REPORT_TEXT.promisedDays} days, where only Martin and its sender can read it.`,
      });
    case 'repeat':
      return writer.events;
    case 'ticket': {
      const fingerprint = decision.fingerprint as Fingerprint;
      const title = reportedTitle(fingerprint);
      writer.add('ticket.opened', 'triage', `Ticket #${workItem}: ${routed.category}, ${routed.severity}`, {
        title,
        category: routed.category,
        severity: routed.severity,
        fingerprint,
        traces: [],
      });
      return summarise(writer, {
        title,
        description: `A visitor reported it. Jev judged it ${routed.category} and ${routed.severity}; triage opened a ticket.`,
        story: `A visitor sent a report from ${page}. It went to Jev as data, and Jev judged it a ${routed.category} problem, ${routed.severity} for a visitor, with no instructions for the system in it. Triage opened ticket #${workItem} with a screenshot of the page, taken by the factory. The ticket holds Jev’s typed answers and the factory’s own evidence, never the visitor’s words.`,
      });
    }
  }
}

/**
 * A planner's finding: judged as a report is, and routed by `routeFinding`, so it never opens a ticket. Each becomes
 * events, so Martin can see what the planner noticed and what triage made of it, but never its words in public.
 */
export function findingEvents(
  signal: InboxSignal,
  signalId: string,
  workItem: string,
  decision: ReportDecision,
  now: Date,
  /** The ticket being planned, when a defect noticed has its fingerprint, which keeps it from a ticket of its own. */
  behind?: string,
): NewEvent[] {
  const { routed } = decision;
  const ticket = `ticket #${signal.planning}`;
  const category = routed.route === 'park' ? (routed.defect?.category ?? 'improvement') : CARD_CATEGORY[routed.route];
  const { writer, page } = judged(new Writer(signalId, workItem, now), signal, decision, (page) => ({
    actor: 'planner',
    summary: `The planner noted something on ${page}`,
    payload: { kind: 'planner-finding', title: `A finding on ${page}`, sample: false, ...(category && { category }) },
  }));

  switch (routed.route) {
    case 'quarantine':
      refused(
        writer,
        decision,
        `Act on the planner’s finding on ${page}, while planning ${ticket}`,
        'Typed judgement refused the planner’s finding: Jev read instructions aimed at the system in it',
      );
      writer.add('work-item.closed', 'triage', 'Quarantined: the finding gives orders to the system', {
        outcome: 'quarantined',
        reason: 'The finding holds instructions aimed at the system, so nothing acts on it',
      });
      return summarise(writer, {
        title: 'A finding that gave orders',
        description:
          'Jev read the planner’s finding as instructions aimed at the system, so triage quarantined it. No ticket, and no agent reads it.',
        story: `While planning ${ticket}, the planner noted something on ${page}. Its words are untrusted, as a visitor’s are, so they went to Jev as data. Jev judged that they hold instructions aimed at the system, and routing code quarantined them before anything else.`,
      });
    case 'park':
      if (routed.defect) {
        const { category, severity } = routed.defect;
        writer.add('hold.started', 'triage', 'Waiting for a sense or Martin: the planner noticed a defect', {
          stage: 'triage',
          kind: 'held',
          cause: 'finding',
          reason: behind
            ? `The planner noticed a defect outside its ticket, with that ticket’s fingerprint. A sense’s ticket can take it once #${behind} closes, or Martin can.`
            : 'The planner noticed a defect outside its ticket. Its word alone never opens a ticket: one opens when a sense sees it, or when Martin approves this.',
          defect: {
            fingerprint: decision.fingerprint ?? { route: privatePath(signal.route), class: routed.defect.symptom },
            symptom: routed.defect.symptom,
          },
        });
        return summarise(writer, {
          title: `A defect the planner noticed on ${page}`,
          description: `Jev judged it ${category} and ${severity}. The planner’s word alone opens no ticket, so triage held it for a sense to see it, or for Martin.`,
          story: `While planning ${ticket}, the planner noticed something else wrong on ${page}. A fix does only what its ticket asks, so it left this for triage. Jev judged it a ${category} problem, ${severity} for a visitor. A visitor can read the app’s public code and try to persuade an agent that a line of it holds a bug, so the planner is trusted no more than a visitor: no ticket opens until a sense sees the defect or Martin opens one.`,
        });
      }
      writer.add('hold.started', 'triage', 'Waiting for Martin: the planner suggested a change', {
        stage: 'triage',
        kind: 'approval',
        cause: 'suggestion',
        reason: 'The planner noticed something the app could do better, and only Martin asks for improvements.',
      });
      return summarise(writer, {
        title: 'The planner’s suggestion',
        description:
          'Jev read it as a request for something new, not a fault. Triage parked it for Martin, who alone asks for improvements.',
        story: `While planning ${ticket}, the planner noticed something on ${page} the app could do better. A fix does only what its ticket asks, so it left this for triage. Jev judged it a suggestion, and only Martin can ask for an improvement, so routing code parked it for him.`,
      });
    case 'discard':
      writer.add('work-item.closed', 'triage', 'Closed with no ticket: not a defect', {
        outcome: 'discarded',
        reason: 'Jev found nothing wrong with the page in it',
      });
      return summarise(writer, {
        title: `A finding on ${page} that was not a defect`,
        description: 'Triage read the planner’s finding against the page and found nothing wrong. No ticket.',
        story: `While planning ${ticket}, the planner noted something on ${page}. Jev judged that it describes nothing wrong with the site, and routing code closed it with no ticket.`,
      });
    case 'repeat':
      return writer.events;
    case 'ticket':
      throw new Error('A planner’s finding never opens a ticket');
  }
}

const CARD_CATEGORY: Partial<Record<ReportDecision['routed']['route'], 'red-team' | 'improvement' | 'not-a-defect'>> = {
  quarantine: 'red-team',
  park: 'improvement',
  discard: 'not-a-defect',
};

/** A defect the planner noticed, as its hold names it. */
export type ParkedDefect = NonNullable<PayloadOf<'hold.started'>['defect']>;

/**
 * Martin approved a defect the planner noticed: its own work item gets its ticket, as a sense's would, with its
 * category and severity from the policy's table for the symptom. The planner's word alone never comes here.
 */
export function approvedFinding(workItem: string, defect: ParkedDefect, now: Date): NewEvent[] {
  const { fingerprint, symptom } = defect;
  // Wrong words are content, whatever the symptom; the severity is the policy's for the symptom.
  const { severity, category: bySymptom } = SYMPTOMS[symptom];
  const category = 'page' in fingerprint ? 'content' : bySymptom;
  const title = ticketTitle(fingerprint);
  const writer = new Writer(`finding:${workItem}:approved`, workItem, now);
  writer.add('ticket.opened', 'triage', `Ticket #${workItem}: ${category}, ${severity}, on Martin’s word`, {
    title,
    category,
    severity,
    fingerprint,
    traces: [],
  });
  return summarise(writer, {
    title,
    description: `The planner noticed it, and Martin opened a ticket, ${category} and ${severity}.`,
    story: `While planning another ticket, the planner noticed this defect on ${'page' in fingerprint ? shortPath(fingerprint.page) : where(fingerprint.route)}. Its word alone never opens a ticket, so triage held it for a sense or for Martin. Martin approved it, so triage opened ticket #${workItem}, with its category and severity from the policy’s table for the symptom, as a sense’s ticket has.`,
  });
}

/**
 * A defect the planner noticed is held again, on the same work item, when a finding joined its hold after Martin
 * answered it: his answer settles nothing he had not read.
 */
export function heldAgain(workItem: string, defect: ParkedDefect, seed: string, now: Date): NewEvent[] {
  return new Writer(seed, workItem, now).add(
    'hold.started',
    'triage',
    'Waiting for Martin again: the planner noticed it again after he answered',
    {
      stage: 'triage',
      kind: 'held',
      cause: 'finding',
      reason:
        'The planner noticed this defect again after Martin answered, in words his answer did not cover. It waits for a sense to see it, or for his answer to all of them.',
      defect,
    },
  ).events;
}

/**
 * A defect the planner noticed closes, without a ticket of its own: a ticket now has it (`joined`), or Martin
 * rejected it. `seed` keeps its event's id the same however often triage writes it.
 */
export function closedFinding(
  workItem: string,
  why: { joined: string; by: 'sense' | 'report' | 'martin' } | { rejected: true },
  seed: string,
  now: Date,
): NewEvent[] {
  const writer = new Writer(seed, workItem, now);
  if ('rejected' in why) {
    return writer.add('work-item.closed', 'triage', 'Closed: Martin rejected it', {
      outcome: 'discarded',
      reason: 'Martin rejected the defect the planner noticed',
    }).events;
  }
  const reason = {
    sense: `A sense saw it: ticket #${why.joined}`,
    report: `A visitor reported it: ticket #${why.joined}`,
    martin: `Ticket #${why.joined} already has it`,
  }[why.by];
  return writer.add('work-item.closed', 'triage', reason, { outcome: 'no-change', reason }).events;
}

/**
 * A suggestion closes when Martin rejects it, a visitor's or the planner's, with no ticket: it was never a defect, and
 * only he asks for improvements. Written once for each, whatever the try.
 */
export function closedSuggestion(workItem: string, now: Date): NewEvent[] {
  return new Writer(`suggestion:${workItem}:rejected`, workItem, now).add(
    'work-item.closed',
    'triage',
    'Closed: Martin rejected the suggestion',
    { outcome: 'discarded', reason: 'Martin rejected the suggestion: nothing is built' },
  ).events;
}

/**
 * A summary says what happened, never where the work item stands now: it moves on, and nothing writes the summary
 * again, so the console ends the story from what it projects.
 */
const summarise = (writer: Writer, summary: PayloadOf<'work-item.summarised'>) =>
  writer.add('work-item.summarised', 'triage', 'Summary written', summary).events;

/** "Triage: functional (0.97), broken, no instructions (0.01)", from the answers alone. */
export function judgementLine(judgement: Judgement): string {
  const by = new Map(judgement.answers.map((a) => [a.key, a]));
  const parts: string[] = [];
  const category = by.get('category');
  if (category?.type === 'choice') {
    parts.push(`${category.answer.replaceAll('-', ' ')} (${p(category.probabilities[category.answer])})`);
  }
  const severity = by.get('severity');
  if (severity?.type === 'score') {
    parts.push(severity.levels[Math.round(severity.expected)] ?? `${severity.expected.toFixed(2)}`);
  }
  const injection = by.get('injection');
  if (injection?.type === 'noul') {
    parts.push(`${injection.probability >= 0.5 ? 'instructions' : 'no instructions'} (${p(injection.probability)})`);
  }
  const passage = by.get('passage');
  if (passage?.type === 'choice') parts.push(`passage chosen (${p(passage.probabilities[passage.answer])})`);
  return `Triage: ${parts.join(', ')}`;
}

const p = (value: number | undefined) => (value ?? 0).toFixed(2);
