/**
 * Martin's settings and the spend against the caps, as everyone sees them: the latest `settings.changed` turned into
 * the settings in force by policy's own check (`policy/settings.ts`, which the gateway, the line and the admin service
 * use too, so all four agree), and what the models cost by the events, against the caps in force.
 *
 * Spend is counted from the events: each agent's step (`model.called`, at its end) and each of triage's judgements
 * (`judgement.made`), in the UTC day and month holding t. The gateway counts each call as it is made, so a step in
 * progress shows here once it ends.
 */
import type { PublicEvent } from '@software-factory/events';
import { MODEL_AGENTS, type ModelAgent } from '@software-factory/policy/models';
import { type InForce, inForce } from '@software-factory/policy/settings';
import type { Profile } from '@software-factory/policy/spend';

/** What the models have cost in a window, against its cap. */
export interface Meter {
  spentUsd: number;
  /** The cap in force; none for a month with no cap. */
  capUsd: number | null;
  /** Whether the spend has reached the cap. */
  atCap: boolean;
}

export interface SpendView {
  today: Meter;
  month: Meter;
  /** The dearest work item that spent anything today, by all it has spent, against a work item's cap. */
  dearest: (Meter & { workItem: string }) | undefined;
  /** When the day's count starts again: the next midnight, UTC. */
  resets: number;
}

export interface SettingsView {
  profile: Profile;
  settings: InForce;
  /** Martin's last save, if he has made one: its seq, when, and what it said of each field, as the event carries it. */
  last: { seq: number; at: number; chose: unknown } | undefined;
  spend: SpendView;
  /** Each agent's steps and spend in the seven days to t. */
  week: Record<ModelAgent, { steps: number; usd: number }>;
}

const DAY = 86_400_000;

const meter = (spentUsd: number, capUsd: number | null): Meter => ({
  spentUsd,
  capUsd,
  atCap: capUsd !== null && spentUsd >= capUsd,
});

/** What a model cost, at its step's end or a judgement's: what the meters count. */
interface Spent {
  at: number;
  usd: number;
  workItem: PublicEvent['work_item'];
  /** The agent whose step it was; none for a judgement. */
  agent: ModelAgent | undefined;
}

/** The settings in force by the events, and every cost they record: what no later time changes. */
export interface SettingsFold {
  profile: Profile;
  settings: InForce;
  last: SettingsView['last'];
  spent: Spent[];
}

/** The settings and the costs in the events that had happened, read once for those events. */
export function foldSettings(seen: readonly PublicEvent[], profile: Profile): SettingsFold {
  const latest = seen.findLast((event) => event.type === 'settings.changed');
  const spent: Spent[] = [];
  for (const event of seen) {
    if (event.type !== 'model.called' && event.type !== 'judgement.made') continue;
    const agent = event.type === 'model.called' ? event.payload.agent : undefined;
    spent.push({
      at: Date.parse(event.ts),
      usd: event.payload.costUsd,
      workItem: event.work_item,
      agent: (MODEL_AGENTS as readonly string[]).includes(agent ?? '') ? (agent as ModelAgent) : undefined,
    });
  }
  return {
    profile,
    settings: inForce(profile, latest?.payload),
    last: latest && { seq: latest.seq ?? 0, at: Date.parse(latest.ts), chose: latest.payload },
    spent,
  };
}

/** The spend against the settings at t, from a fold of the events by t: the day, the month and the week are t's. */
export function settingsAt(folded: SettingsFold, t: number): SettingsView {
  const { profile, settings, last } = folded;
  const at = new Date(t);
  const dayStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const monthStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  let today = 0;
  let month = 0;
  const byItem = new Map<string, number>();
  const spentToday = new Set<string>();
  const week = Object.fromEntries(MODEL_AGENTS.map((agent) => [agent, { steps: 0, usd: 0 }])) as SettingsView['week'];
  for (const { at: when, usd, workItem, agent } of folded.spent) {
    if (when >= monthStart) month += usd;
    if (when >= dayStart) today += usd;
    if (workItem) {
      byItem.set(workItem, (byItem.get(workItem) ?? 0) + usd);
      if (when >= dayStart && usd > 0) spentToday.add(workItem);
    }
    if (agent && when > t - 7 * DAY) {
      week[agent].steps += 1;
      week[agent].usd += usd;
    }
  }
  let dearest: SpendView['dearest'];
  for (const workItem of spentToday) {
    const usd = byItem.get(workItem) ?? 0;
    if (!dearest || usd > dearest.spentUsd) dearest = { workItem, ...meter(usd, settings.caps.workItemUsd) };
  }
  return {
    profile,
    settings,
    last,
    spend: {
      today: meter(today, settings.caps.dayUsd),
      month: meter(month, settings.caps.monthUsd),
      dearest,
      resets: dayStart + DAY,
    },
    week,
  };
}

/** The settings in force at t, and the spend against them. */
export const settingsView = (events: readonly PublicEvent[], profile: Profile, t: number): SettingsView =>
  settingsAt(
    foldSettings(
      events.filter((event) => Date.parse(event.ts) <= t),
      profile,
    ),
    t,
  );
