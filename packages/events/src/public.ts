/**
 * Public views: what anyone but Martin may see of an event. Each type defines its own, and the compiler refuses a
 * type without one. The store writes the view once, when the event is appended, and the console serves only views.
 *
 * Every view leaves out what a visitor wrote (a report's text, and the query of the page it came from) and their
 * key, and redacts anything shaped like a secret, because some fields (a gate's output, a log line) are copied
 * verbatim from places the factory does not control.
 */
import type { View } from './types.ts';
import type { EventType } from './versions.ts';

type Rule = [pattern: RegExp, replacement: string];

/** Shapes of credentials that must never be published, even where a check's output prints one by mistake. */
const SECRET_SHAPES: Rule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bsk-ant-[\w-]{8,}/g, '[redacted]'],
  [/\bsk-[\w-]{20,}/g, '[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[redacted]'],
  [/\b(Bearer|Basic) +[\w.~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [
    /\b([\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key))(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
    '$1$2[redacted]',
  ],
];

/** Replaces anything secret-shaped in a string. */
export function redactSecrets(text: string): string {
  return SECRET_SHAPES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** Redacts every string in a value, keeping its shape. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactDeep(inner)])) as T;
  }
  return value;
}

type PublicViewOf<K extends EventType> = (event: View<K>) => View<K>;

/** The page a report came from, without its query: a query is typed by the visitor, so it is theirs, like the text. */
const pathOf = (page: string) => page.split(/[?#]/)[0] || '/';

/** The view of an event with nothing to leave out but secrets. */
const redacted = <K extends EventType>(event: View<K>): View<K> => redactDeep(event);

/** How Martin answered a hold, in words of the factory's own. */
const ANSWERED = {
  approved: 'Martin approved the hold',
  rejected: 'Martin rejected the hold',
  answered: 'Martin answered the hold in words',
} as const;

export const PUBLIC_VIEWS = {
  'work-item.opened': ({ payload: { visitor: _key, ...payload }, ...event }) => redacted({ ...event, payload }),
  'work-item.summarised': redacted,
  'work-item.closed': redacted,
  'work-item.reopened': redacted,
  'defect.injected': redacted,
  'attack.launched': redacted,
  'signal.received': (event) => {
    const { report, ...payload } = event.payload;
    if (!report) return redacted(event);
    // A report's summary is replaced as well as its text, so a careless summary cannot quote the report. A planner's
    // finding is kept as close: its words are untrusted too.
    const summary =
      payload.sense === 'planner'
        ? `The planner noted something on ${pathOf(report.page)}`
        : `A visitor reported a problem on ${pathOf(report.page)}`;
    return redacted({
      ...event,
      summary,
      payload: { ...payload, report: { page: pathOf(report.page) } },
    });
  },
  'judgement.made': (event) => {
    const { report, ...state } = event.payload.state;
    return redacted({
      ...event,
      payload: { ...event.payload, state: { ...state, ...(report && { report: { page: pathOf(report.page) } }) } },
    });
  },
  'ticket.opened': redacted,
  'spec.written': redacted,
  'pull-request.pushed': redacted,
  'suggestions.answered': redacted,
  'wait.started': redacted,
  'gates.started': redacted,
  'gate.finished': redacted,
  'gates.finished': redacted,
  'review.submitted': redacted,
  'review.accepted': redacted,
  'pull-request.merged': redacted,
  'deploy.changed': redacted,
  'release.started': redacted,
  'canary.stepped': redacted,
  'canary.measuring': redacted,
  'release.promoted': redacted,
  'release.rolled-back': redacted,
  'release.aborted': redacted,
  'release.errored': redacted,
  'verification.finished': redacted,
  'signal.rechecked': redacted,
  'work.returned': redacted,
  'hold.started': redacted,
  // Martin's answer, through the redactor, but for his words on a hold about a visitor's report, which stay his: the
  // summary too says only how he answered.
  'hold.answered': (event) => {
    if (!event.payload.report) return redacted(event);
    const { answer: _words, ...payload } = event.payload;
    return redacted({ ...event, summary: ANSWERED[payload.decision], payload });
  },
  'action.refused': redacted,
  'model.called': redacted,
  'line.started': redacted,
  'line.stopped': redacted,
  'spend.capped': redacted,
  'spend.cleared': redacted,
  'score.updated': redacted,
  // A proof's output is a script's or a check's own words, through the redactor, as a refusal's is.
  'guardrail.proved': redacted,
  // Martin's own: that he did it, never with which passkey, from where or in which browser.
  'admin.signed-in': (event) => ({ ...event, summary: 'Martin signed in with a passkey', payload: {} }),
  'admin.signed-out': redacted,
  'admin.stepped-up': (event) => ({ ...event, summary: 'Martin gave his passkey again', payload: {} }),
  'passkey.enrolled': (event) => ({ ...event, summary: 'Martin enrolled a passkey', payload: {} }),
  'passkey.revoked': ({ payload: { passkey: _name, ...payload }, ...event }) =>
    redacted({ ...event, summary: 'Martin revoked a passkey', payload }),
  // What he did to the canary, and nothing of his session: public as it is.
  'release.controlled': redacted,
  // His settings are everyone's to see: models, efforts and caps, and nothing of his session.
  'settings.changed': redacted,
  // His controls of the line are everyone's to see too, as Controls shows them to visitors.
  'controls.changed': redacted,
  // So is whether alerts reach his phone, as Controls shows it to visitors.
  'alerts.switched': redacted,
  // His stages of the flags are everyone's to see, as Controls shows them to visitors, with his reason through the
  // redactor; Verify's comparisons are figures alone, and its checks the probes' own words about the app's pages.
  'flag.staged': redacted,
  'flag.compared': redacted,
  'flag.checked': redacted,
  // His request for an improvement is everyone's to see, in his words, as Plan shows it to visitors, through the
  // redactor.
  'improvement.requested': redacted,
} satisfies { [K in EventType]: PublicViewOf<K> };

/** The public view of an event. Applying it twice changes nothing. */
export function publicView<K extends EventType>(type: K, event: View<K>): View<K> {
  return (PUBLIC_VIEWS[type] as PublicViewOf<K>)(event);
}
