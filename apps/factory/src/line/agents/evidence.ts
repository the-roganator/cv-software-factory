/**
 * What the senses saw, as an agent's prompt tells it: each signal by its typed fields, one line per piece of
 * evidence. An agent reads a ticket's evidence, or Martin's request for an improvement, through this module, so every
 * agent sees it alike.
 *
 * Never a visitor's words. A visitor's report is left out whole, by the type and by the line, which never reads a
 * report's signal. A log line is the one piece of evidence that can carry what a visitor typed: an app may log the
 * path or the query it was sent, in the line or in the exception it attaches, quoted or not. Taking the varying parts
 * out (the log watcher's `reduce`) leaves unquoted words standing, so no log message reaches a prompt at all: a log
 * signal is told by its route, how many requests it covers and how many lines it holds at each level, and its trace
 * by its id and timings. Every route an agent is told is cut at its query. Everything else the senses keep is the
 * app's answer to a request the sense made itself.
 */
import { elementWords, GIVEAWAY_WORDS, type PayloadOf, SECURITY_HEADER_ASKS } from '@software-factory/events';
import { CANARY_ANY_ROUTE } from '@software-factory/triage/events';
import { count } from './agent.ts';

/** A sense's signal as an agent sees it: everything but a visitor's report. */
export type Signal = Omit<PayloadOf<'signal.received'>, 'report'>;
type Evidence = NonNullable<Signal['evidence']>[number];

/** A route without its query or fragment, which a route never needs and a visitor may have typed. */
export const routeOf = (route: string) => route.split(/[?#]/)[0] || '/';

/** Martin's request for an improvement, as the public views of its opening and his request have it. */
export interface Request {
  /** The work item's title, made from his first sentence. */
  title: string;
  /** His words, through the redactor. */
  words: string;
}

/** What a work item asks for: the ticket triage opened, or the improvement Martin asked for in his own words. */
export type Asked = { kind: 'ticket'; ticket: PayloadOf<'ticket.opened'> } | { kind: 'request'; request: Request };

/** What a prompt calls the work item: `ticket #1207`, or `improvement #1300`. */
export const askedName = (asked: Asked, workItem: string) =>
  `${asked.kind === 'ticket' ? 'ticket' : 'improvement'} #${workItem}`;

/** The work item's title, as its ticket or its request has it. */
export const askedTitle = (asked: Asked) => (asked.kind === 'ticket' ? asked.ticket.title : asked.request.title);

/** What the work item asks, as lines of a prompt: where the ticket is, or Martin's words. */
export function askedLines(asked: Asked, signals: readonly Signal[] = []): string[] {
  if (asked.kind === 'ticket') return ticketLines(asked.ticket, signals);
  return [`Martin asked for it in his own words: “${asked.request.words}”`];
}

/**
 * What a visitor's report's ticket points at, as a line of a prompt: the passage or the element of the page Jev chose
 * from the page as the factory read it, which is what was reported. None when the ticket is not a report's, or its
 * fingerprint already holds the passage.
 */
export function pointsLines(ticket: PayloadOf<'ticket.opened'>): string[] {
  const { points, fingerprint } = ticket;
  if (!points) return [];
  const page = routeOf(points.page);
  if (points.passage) {
    if ('text' in fingerprint && fingerprint.text === points.passage) return [];
    return [
      `A visitor reported it on ${page}, about the passage "${points.passage}" there, as the factory read the page.`,
    ];
  }
  if (points.element)
    return [
      `A visitor reported it on ${page}, about ${elementWords(points.element)} there, as the factory read the page.`,
    ];
  return [`A visitor reported it on ${page}. Triage could point at nothing narrower than the page.`];
}

/**
 * What a visitor's report's ticket points at, as a quote is looked for in it: the passage, the content fingerprint's
 * or the points', or the element in the words the prompt gives it. Never the title, the kind of problem or the page,
 * which any defect of that kind there would fit; empty when the ticket points at nothing narrower than its page.
 */
export function reportedWords(ticket: PayloadOf<'ticket.opened'>): string[] {
  return reported(ticket).map((r) => r.words);
}

/** What a report's ticket points at: each passage or element's words, and how a prompt names it. */
export function reported({ points, fingerprint }: PayloadOf<'ticket.opened'>): { words: string; told: string }[] {
  const passages = new Set([
    ...('text' in fingerprint ? [fingerprint.text] : []),
    ...(points?.passage ? [points.passage] : []),
  ]);
  return [
    ...[...passages].map((words) => ({ words, told: `the passage “${words}”` })),
    ...(points?.element ? [{ words: elementWords(points.element), told: elementWords(points.element) }] : []),
  ];
}

/**
 * Where the ticket is, as triage fingerprinted it, and how it was classed, with its traces if it has any, and what a
 * visitor's report points at (`pointsLines`). A ticket on
 * `*` is on every page the senses checked, but the canary's: triage gives a canary's `*` a ticket of its own, and it
 * says the analysis found the canary worse on routes it could not narrow to one, which its evidence names if it can.
 */
export function ticketLines(ticket: PayloadOf<'ticket.opened'>, signals: readonly Signal[] = []): string[] {
  const { fingerprint } = ticket;
  const anywhere = signals.some((s) => s.sense === 'canary')
    ? `${CANARY_ANY_ROUTE}, as the canary's analysis found it`
    : 'every page the senses checked';
  const where =
    'class' in fingerprint
      ? `It is a ${fingerprint.class} on ${fingerprint.route === '*' ? anywhere : routeOf(fingerprint.route)}.`
      : `It is about the words "${fingerprint.text}" on ${routeOf(fingerprint.page)}, as the factory read the page.`;
  return [
    `${where} Category ${ticket.category}, severity ${ticket.severity}.`,
    ...pointsLines(ticket),
    ...(ticket.traces.length ? [`Its traces: ${ticket.traces.join(', ')}.`] : []),
  ];
}

const SENSE: Record<Signal['sense'], string> = {
  probe: 'A probe',
  crawler: 'The crawler',
  metrics: 'The metrics',
  logs: 'The log watcher',
  canary: 'The canary',
  report: 'A report',
  planner: 'The planner',
};

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;

/** One piece of evidence, as lines of the prompt. */
export function evidenceLines(evidence: Evidence): string[] {
  switch (evidence.kind) {
    case 'http': {
      const headers = Object.entries(evidence.headers).map(([name, value]) => `${name}: ${value ?? '(absent)'}`);
      return [
        `${evidence.method} ${evidence.url} answered ${evidence.status ?? 'nothing'} in ${evidence.timings.totalMs} ms`,
        ...evidence.redirects.map((r) => `  redirected ${r.status} to ${r.location}`),
        ...(headers.length ? [`  headers: ${headers.join('; ')}`] : []),
        ...(evidence.missing
          ? [
              `  missing: ${evidence.missing.map((h) => (SECURITY_HEADER_ASKS[h] ? `${h} (${SECURITY_HEADER_ASKS[h]})` : h)).join(', ')}`,
            ]
          : []),
        ...(evidence.givesAway ? [`  gives away: ${evidence.givesAway.map((g) => GIVEAWAY_WORDS[g]).join(', ')}`] : []),
      ];
    }
    case 'console':
      return evidence.messages.map(
        (m) =>
          `the browser's console on ${routeOf(evidence.route)}, ${m.level}: ${m.text}${m.source ? ` (${m.source})` : ''}`,
      );
    case 'accessibility':
      return evidence.findings.map(
        (f) =>
          `axe's ${f.rule} (${f.impact}) on ${routeOf(evidence.route)}: ${f.help}; at ${f.elements.map((e) => e.selector).join(', ')}`,
      );
    case 'metric': {
      const values = evidence.values.filter((v): v is number => v !== null);
      const range = values.length
        ? `from ${Math.min(...values)} to ${Math.max(...values)}, lately ${values.at(-1)}`
        : 'no values';
      const objective = evidence.objective === undefined ? '' : `, against an objective of ${evidence.objective}`;
      return [`${evidence.name} in ${evidence.unit}: ${range}${objective}`];
    }
    case 'logs': {
      const levels = LEVELS.flatMap((level) => {
        const n = evidence.lines.filter((l) => l.level === level).length;
        return n ? [`${count(n, 'line')} at ${level}`] : [];
      });
      const { trace } = evidence;
      const longest = trace?.spans.length ? Math.max(...trace.spans.map((s) => s.durationMs)) : 0;
      return [
        `${count(evidence.requests, 'request')} to ${routeOf(evidence.route)} logged ${levels.join(', ') || 'nothing'}`,
        ...(trace ? [`  trace ${trace.id}: ${trace.spans.length} spans, the longest ${longest} ms`] : []),
      ];
    }
    case 'canary': {
      const { measure, series, routes, checks } = evidence;
      const against = measure.limit === null ? '' : ` against a limit of ${measure.limit}`;
      const value = measure.value === null ? '' : `, measured ${measure.value}${against}`;
      const lately = (values: readonly (number | null)[]) => values.filter((v) => v !== null).at(-1) ?? 'nothing';
      return [
        `the canary's analysis of version ${evidence.version} against ${evidence.against}: ${measure.name} ${measure.phase}${value}${measure.message ? ` (${measure.message})` : ''}`,
        ...(series
          ? [
              `  ${series.label} in ${series.unit} when it failed: the canary ${lately(series.canary.slice(0, series.at + 1))}, the baseline ${lately(series.baseline.slice(0, series.at + 1))}`,
            ]
          : []),
        ...(routes?.worse.map(
          (r) =>
            `  worse on ${routeOf(r.route)}: ${r.canary} ${routes.unit} on the canary, ${r.baseline} on the baseline`,
        ) ?? []),
        ...(checks?.map(
          (c) =>
            `  ${c.sense} check "${c.check}" on ${c.route === '*' ? 'every page' : routeOf(c.route)} passed on the baseline and failed on the canary${c.message ? `: ${c.message}` : ''}`,
        ) ?? []),
      ];
    }
  }
}

/** A sense's signal, as lines of a prompt: what it checked and where, then each piece of its evidence. */
export function seen(signal: Signal): string[] {
  const symptom = signal.symptom ? `, ${signal.symptom}` : '';
  const where =
    signal.route !== '*' ? routeOf(signal.route) : signal.sense === 'canary' ? CANARY_ANY_ROUTE : 'every page';
  return [
    `- ${SENSE[signal.sense]}'s check "${signal.check}" on ${where} in version ${signal.version}${symptom}`,
    ...(signal.evidence ?? []).flatMap(evidenceLines).map((line) => `  - ${line}`),
  ];
}

/** Signals as `seen` tells them, numbered from 1, so an agent can name the one it means: "signal 2". */
export function numbered(signals: readonly Signal[]): string[] {
  return signals.flatMap((signal, i) => seen(signal).map((line, j) => (j ? line : line.replace(/^- /, `${i + 1}. `))));
}
