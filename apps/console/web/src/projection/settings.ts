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

/** The settings in force at t, and the spend against them. */
export function settingsView(events: readonly PublicEvent[], profile: Profile, t: number): SettingsView {
  const seen = events.filter((event) => Date.parse(event.ts) <= t);
  const latest = seen.findLast((event) => event.type === 'settings.changed');
  const settings = inForce(profile, latest?.payload);

  const at = new Date(t);
  const dayStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const monthStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  let today = 0;
  let month = 0;
  const byItem = new Map<string, number>();
  const spentToday = new Set<string>();
  const week = Object.fromEntries(MODEL_AGENTS.map((agent) => [agent, { steps: 0, usd: 0 }])) as SettingsView['week'];
  for (const event of seen) {
    if (event.type !== 'model.called' && event.type !== 'judgement.made') continue;
    const usd = event.payload.costUsd;
    const when = Date.parse(event.ts);
    if (when >= monthStart) month += usd;
    if (when >= dayStart) today += usd;
    if (event.work_item) {
      byItem.set(event.work_item, (byItem.get(event.work_item) ?? 0) + usd);
      if (when >= dayStart && usd > 0) spentToday.add(event.work_item);
    }
    if (event.type === 'model.called' && when > t - 7 * DAY) {
      const agent = event.payload.agent as ModelAgent;
      if (!(MODEL_AGENTS as readonly string[]).includes(agent)) continue;
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
    last: latest && { seq: latest.seq ?? 0, at: Date.parse(latest.ts), chose: latest.payload },
    spend: {
      today: meter(today, settings.caps.dayUsd),
      month: meter(month, settings.caps.monthUsd),
      dearest,
      resets: dayStart + DAY,
    },
    week,
  };
}
