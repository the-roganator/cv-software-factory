/**
 * The audit log (`?view=audit`): every event as a row, newest first, the same for everyone. The page reads the public
 * stream even for Martin signed in, so each row is drawn from the event's public view, and what a visitor wrote, or
 * Martin on a hold about a visitor's report, is never in what it is given.
 *
 * What happened is the event's own public summary, so a type added later shows with no change here. A few types get a
 * line of detail under it: a model call's model, effort, tokens and cost; the reason Martin gave; his words on a hold
 * or in a request for an improvement; each setting he changed; the release he controlled; and, on an action that asks
 * for his passkey again, when he gave it. Where the public view left something out, a row says what and why, in place
 * of the detail.
 */
import {
  ACTORS,
  type Actor,
  ADMIN_TYPES,
  AGENTS,
  type HoldCause,
  type PayloadOf,
  type PublicEvent,
  SENSES,
} from '@software-factory/events';
import { stageWords } from '@software-factory/policy/flag-moves';
import { CAP_NAMES, type CapField, changesBetween, inForce } from '@software-factory/policy/settings';
import type { Profile } from '@software-factory/policy/spend';
import {
  CONTROL_STEP_UP,
  FLAG_STEP_UP,
  FRESH_MINUTES,
  GUARDRAIL_HOLDS,
  IMPROVEMENT_STEP_UP,
  PHONE_STEP_UP,
  SETTINGS_STEP_UP,
  STEP_UP,
} from '../access.ts';
import { changeWords, clock, count, dayLabel, modelTitle, money, plural, startOfDay, tokens } from '../format.ts';
import { changeAction } from './controls.ts';
import { SENSE } from './senses.ts';

/** An admin action (a person), an agent's or a system's action (the arrows), or a model call (a chip). */
export const AUDIT_KINDS = ['admin', 'agent', 'model'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** Who did it, as the console names them elsewhere. */
export const ACTOR_NAME: Record<Actor, string> = {
  martin: 'Martin',
  visitor: 'a visitor',
  triage: 'triage',
  planner: 'the planner',
  coder: 'the coder',
  reviewer: 'the reviewer',
  describer: 'the describer',
  'red-team': 'the red-team agent',
  probe: SENSE.probe.the,
  crawler: SENSE.crawler.the,
  metrics: SENSE.metrics.the,
  logs: SENSE.logs.the,
  canary: SENSE.canary.the,
  widget: 'the report widget',
  injector: 'the injector',
  actions: 'GitHub Actions',
  rollouts: 'Argo Rollouts',
  dependabot: 'Dependabot',
  factory: 'the line',
  scoreboard: 'the scoreboard',
};

/** The senses that act on their own, grouped in the filter as one. */
const SENSE_ACTORS: readonly Actor[] = ACTORS.filter((actor) => (SENSES as readonly string[]).includes(actor));

/**
 * The actor filter's choices, as the design lists them: Martin, each agent, triage, the line, and the senses as one.
 * The systems around the line (GitHub Actions, Argo Rollouts, Dependabot, the scoreboard), the report widget, the
 * injector and a visitor show under Everyone.
 */
export const ACTOR_CHOICES: readonly { value: string; label: string; actors: readonly Actor[] }[] = [
  { value: 'martin', label: 'Martin', actors: ['martin'] },
  ...AGENTS.filter((agent) => agent !== 'triage').map((agent) => ({
    value: agent,
    label: ACTOR_NAME[agent],
    actors: [agent],
  })),
  { value: 'triage', label: 'triage', actors: ['triage'] },
  { value: 'factory', label: 'the line', actors: ['factory'] },
  { value: 'senses', label: 'the senses', actors: SENSE_ACTORS },
];

export interface AuditRow {
  seq: number;
  at: number;
  actor: Actor;
  kind: AuditKind;
  /** The work item's number, or none for the line as a whole. */
  item: string | null;
  /** The event's public summary. */
  what: string;
  /** A line of detail in `t-data`, when the type has one. */
  detail?: string;
  /** Why something the event held is not shown, in place of the detail: drawn muted and italic. */
  withheld?: string;
  /** One of Martin's own actions, ruled on its left. */
  martin: boolean;
  /** A mechanism refused something: drawn in `attn`. */
  refused: boolean;
  /** Admission control refused an image: Kyverno's mark follows the kind. */
  admission?: true;
}

/** What a visitor wrote, left out of every public view. */
const VISITOR_WROTE = 'Its text is left out: a visitor wrote it.';
/** The planner's finding, which the public view leaves out as it does a visitor's report. */
const PLANNER_WROTE = 'Its text is left out, as a visitor’s is: the planner wrote it from a page.';
/** Martin's words on a hold about a visitor's report, which stay his. */
const MARTIN_KEPT = 'His words stay his: the hold was about a visitor’s report.';
/** Any words he gave with an approval or a rejection on such a hold, which the public view leaves out as well. */
const MARTIN_ANY_KEPT = 'Any words of his stay his: the hold was about a visitor’s report.';

/** The mechanisms' refusals: an action the platform or the scope fence stopped, and the gateway's at a spend cap. */
const REFUSALS = new Set<string>(['action.refused', 'spend.capped']);

const FRESH_MS = FRESH_MINUTES * 60_000;

/** The kind of row an event is. */
function kindOf(event: PublicEvent): AuditKind {
  if (event.actor === 'martin' || ADMIN_TYPES.includes(event.type)) return 'admin';
  if (event.type === 'model.called' || event.type === 'judgement.made') return 'model';
  return 'agent';
}

/** A reason a payload carries, whichever version of its type wrote it: `line.started` gained one later. */
function reasonOf(payload: unknown): string | undefined {
  const reason = (payload as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

const quoted = (words: string) => `“${words}”`;

type Settings = PayloadOf<'settings.changed'>;

/** The cap's field in a settings event, by the name a change gives it. */
const CAP_FIELD = Object.fromEntries(Object.entries(CAP_NAMES).map(([field, name]) => [name, field])) as Record<
  (typeof CAP_NAMES)[CapField],
  CapField
>;

/**
 * Whether a save raised spend, by policy's own rule (`changesBetween`): the settings before it, made from the ones after
 * and each change's value before, against the ones after.
 */
function raises(profile: Profile, saved: Settings): boolean {
  const before = structuredClone({ agents: saved.agents, caps: saved.caps });
  for (const change of saved.changes) {
    if (change.field === 'cap') before.caps[CAP_FIELD[change.cap]] = change.beforeUsd as number;
    else if (change.field === 'model') before.agents[change.agent].model = change.before;
    else if (change.before === null) delete before.agents[change.agent].effort;
    else before.agents[change.agent].effort = change.before;
  }
  const after = { agents: saved.agents, caps: saved.caps };
  const { actions } = changesBetween(profile, inForce(profile, before), inForce(profile, after));
  return actions.some((action) => SETTINGS_STEP_UP[action]);
}

/** Every event up to t as a row, newest first. */
export function auditRows(events: readonly PublicEvent[], t: number, profile: Profile): AuditRow[] {
  const causes = new Map<string, HoldCause>();
  // The work items opened as improvements, whose spec Martin approves with his passkey again.
  const improvements = new Set<string>();
  // Whose words a work item's report is: a visitor's, or the planner's finding.
  const reporters = new Map<string, string>();
  let steppedUp: number | undefined;
  const rows: AuditRow[] = [];
  for (const event of events) {
    const at = Date.parse(event.ts);
    if (!(at <= t)) continue;
    if (event.type === 'hold.started') causes.set(event.id, event.payload.cause);
    if (event.type === 'work-item.opened' && event.payload.kind === 'improvement' && event.work_item)
      improvements.add(event.work_item);
    if (event.type === 'admin.stepped-up') steppedUp = at;
    if (event.type === 'signal.received' && event.payload.report && event.work_item)
      reporters.set(event.work_item, event.payload.sense === 'planner' ? PLANNER_WROTE : VISITOR_WROTE);
    const asks = askedForPasskey(event, causes, improvements, profile);
    const parts: string[] = [];
    let withheld: string | undefined;

    switch (event.type) {
      case 'model.called': {
        const p = event.payload;
        const input = p.tokens.input + p.tokens.cacheRead + p.tokens.cacheWrite;
        parts.push(
          [modelTitle(p.model), p.settings.effort].filter(Boolean).join(' · '),
          `${tokens(input)} in`,
          `${tokens(p.tokens.output)} out`,
          money(p.costUsd),
        );
        break;
      }
      case 'judgement.made': {
        const p = event.payload;
        parts.push(
          `Jev ${p.model.slice('jev-'.length)} · ${p.questionSet}`,
          plural(p.answers.length, 'question'),
          money(p.costUsd),
        );
        withheld = (event.work_item && reporters.get(event.work_item)) || VISITOR_WROTE;
        break;
      }
      case 'signal.received':
        if (event.payload.report) withheld = event.payload.sense === 'planner' ? PLANNER_WROTE : VISITOR_WROTE;
        break;
      case 'hold.answered':
        if (event.payload.answer) parts.push(quoted(event.payload.answer));
        else if (event.payload.report) withheld = event.payload.decision === 'answered' ? MARTIN_KEPT : MARTIN_ANY_KEPT;
        break;
      case 'settings.changed':
        parts.push(event.payload.changes.map(changeWords).join('; '));
        break;
      case 'flag.staged': {
        // The move, from the stage `flags` held to the one he set, and his reason for turning it off.
        const p = event.payload;
        parts.push(
          `${p.from ? stageWords(p.from).toLowerCase() : 'outside every stage'} → ${stageWords(p.to).toLowerCase()}`,
        );
        if (p.reason) parts.push(quoted(p.reason));
        // Flags set by hand outside every stage, which the write dropped, and so turned off.
        if (p.dropped?.length) parts.push(`dropped ${p.dropped.join(', ')}, set by hand`);
        break;
      }
      // Martin's request for an improvement, in his words, as everyone may read them.
      case 'improvement.requested':
        parts.push(quoted(event.payload.words));
        break;
      case 'release.controlled': {
        const p = event.payload;
        parts.push(`release ${p.release}`, p.to === undefined ? `at ${p.weight}%` : `${p.weight}% → ${p.to}%`);
        break;
      }
      default: {
        const reason = event.type.startsWith('line.') ? reasonOf(event.payload) : undefined;
        if (reason) parts.push(quoted(reason));
      }
    }
    // When Martin last gave his passkey, if it was fresh for an action that asks for it.
    if (asks && steppedUp !== undefined && at >= steppedUp && at - steppedUp <= FRESH_MS)
      parts.push(`passkey given at ${clock(steppedUp)}`);

    rows.push({
      seq: event.seq,
      at,
      actor: event.actor,
      kind: kindOf(event),
      item: event.work_item,
      what: event.summary,
      ...(parts.length && { detail: parts.join(' · ') }),
      ...(withheld && { withheld }),
      martin: event.actor === 'martin',
      refused: REFUSALS.has(event.type),
      ...(event.type === 'action.refused' && event.payload.mechanism === 'admission-control' && { admission: true }),
    });
  }
  return rows.reverse();
}

/** Whether the access table asks for Martin's passkey again for what this event records (`policy/access.ts`). */
function askedForPasskey(
  event: PublicEvent,
  causes: Map<string, HoldCause>,
  improvements: Set<string>,
  profile: Profile,
): boolean {
  switch (event.type) {
    case 'release.controlled':
      return STEP_UP[event.payload.action];
    case 'line.started':
      return event.actor === 'martin';
    case 'passkey.revoked':
      return event.payload.from === 'console';
    case 'settings.changed':
      return raises(profile, event.payload);
    case 'controls.changed': {
      const action = changeAction(event.payload.change);
      return action !== undefined && CONTROL_STEP_UP[action];
    }
    case 'flag.staged': {
      return FLAG_STEP_UP[event.payload.action];
    }
    case 'alerts.switched':
      return PHONE_STEP_UP[event.payload.phone ? 'phone.on' : 'phone.off'];
    case 'improvement.requested':
      return IMPROVEMENT_STEP_UP['improvement.request'];
    case 'hold.answered': {
      // A guardrail's hold, or an improvement's spec (`IMPROVEMENT_STEP_UP`).
      const cause = event.payload.hold ? causes.get(event.payload.hold) : undefined;
      return (
        event.payload.decision === 'approved' &&
        cause !== undefined &&
        (GUARDRAIL_HOLDS.includes(cause) || (cause === 'spec' && improvements.has(event.work_item ?? '')))
      );
    }
    default:
      return false;
  }
}

export interface AuditFilter {
  /** One of `ACTOR_CHOICES`' values, or empty for everyone. */
  actor: string;
  /** A work item's number, with or without its #; empty for any. */
  item: string;
  kinds: Record<AuditKind, boolean>;
}

export const NO_FILTER: AuditFilter = { actor: '', item: '', kinds: { admin: true, agent: true, model: true } };

/** How many rows a page shows, and Show older adds. */
export const PAGE = 100;

interface AuditDay {
  /** Midnight, where the viewer is. */
  day: number;
  /** Today, Yesterday, or Thu 1 Oct. */
  label: string;
  rows: AuditRow[];
}

interface AuditView {
  days: AuditDay[];
  /** Rows shown. */
  shown: number;
  /** Rows that match the filter. */
  matching: number;
  /** Every row there is. */
  total: number;
  /** Whether a filter narrows the log. */
  filtered: boolean;
  /** The oldest row shown, to hold the page where it is as new rows arrive; none when nothing shows. */
  floor: number | undefined;
  /** Where Show older moves the floor to, or none when every row that matches shows. */
  older: number | undefined;
  caption: string;
}

/** Whether a filter narrows the log at all. */
const filtering = (filter: AuditFilter) =>
  filter.actor !== '' || filter.item.trim() !== '' || AUDIT_KINDS.some((kind) => !filter.kinds[kind]);

/**
 * The rows that match a filter, from the newest down to a floor: the newest page of them when there is none, and every
 * row at or above it when there is, so rows that arrive join the top and nothing below moves.
 */
export function auditView(
  rows: readonly AuditRow[],
  filter: AuditFilter,
  t: number,
  floor: number | undefined = undefined,
): AuditView {
  const actors = ACTOR_CHOICES.find((choice) => choice.value === filter.actor)?.actors;
  const item = filter.item.trim().replace(/^#/, '').trim();
  const matches = rows.filter(
    (row) => filter.kinds[row.kind] && (!actors || actors.includes(row.actor)) && (!item || row.item === item),
  );
  // Every row down to the floor; the newest page when there is none, or when none that match is that new.
  let end = floor === undefined ? 0 : matches.findIndex((row) => row.seq < floor);
  if (end < 0) end = matches.length;
  const shown = matches.slice(0, end || PAGE);
  const rest = matches.length - shown.length;
  const older = rest > 0 ? matches[shown.length + Math.min(PAGE, rest) - 1]?.seq : undefined;

  const today = startOfDay(t);
  const yesterday = startOfDay(today - 1);
  const days: AuditDay[] = [];
  for (const row of shown) {
    const day = startOfDay(row.at);
    let last = days.at(-1);
    if (last?.day !== day) {
      last = {
        day,
        label: day === today ? 'Today' : day === yesterday ? 'Yesterday' : dayLabel(row.at),
        rows: [],
      };
      days.push(last);
    }
    last.rows.push(row);
  }

  const filtered = filtering(filter);
  return {
    days,
    shown: shown.length,
    matching: matches.length,
    total: rows.length,
    filtered,
    floor: shown.at(-1)?.seq,
    older,
    caption: captionOf(shown.length, matches.length, rows.length, filtered),
  };
}

/** How many rows show, of how many. */
function captionOf(shown: number, matching: number, total: number, filtered: boolean): string {
  const all = `${count(total)} in all`;
  if (!total) return 'Nothing has happened yet.';
  if (!filtered) return shown === total ? `Showing all ${all}.` : `Showing the latest ${count(shown)}, of ${all}.`;
  if (!matching) return `None of the ${all} match.`;
  return shown === matching
    ? `Showing the ${matching === 1 ? 'one' : count(matching)} that ${matching === 1 ? 'matches' : 'match'}, of ${all}.`
    : `Showing the latest ${count(shown)} of ${count(matching)} that match, of ${all}.`;
}
