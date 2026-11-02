/**
 * The settings as everyone sees them (`projection/settings.ts`): the latest `settings.changed` through policy's own
 * check, so the console agrees with the gateway, the line and the admin service, and the spend the events record
 * against the caps in force. And the console's copy of which of a save's actions ask for the passkey again, held to
 * the access table.
 */
import type { PayloadOf, PublicEvent } from '@software-factory/events';
import { VERSIONS } from '@software-factory/events';
import type { Profile } from '@software-factory/policy/spend';
import { describe, expect, it } from 'vitest';
import { ACCESS } from '../../../../policy/access.ts';
import { inForce } from '../../../../policy/settings.ts';
import { SPEND } from '../../../../policy/spend.ts';
import { SETTINGS_STEP_UP } from '../../web/src/access.ts';
import { factoryOf } from '../../web/src/profile.ts';
import { foldAt, settingsAt } from '../../web/src/projection/index.ts';
import { work } from './support.ts';

const DAY = Date.parse('2026-10-03T00:00:00Z');
const at = (hours: number) => DAY + hours * 3_600_000;

/** Settings at t, as the console draws them: from the fold of the events by t. */
const settingsView = (events: readonly PublicEvent[], profile: Profile, t: number) =>
  settingsAt(foldAt(events, t).settings, profile, t);

const step = (agent: PayloadOf<'model.called'>['agent'], costUsd: number): PayloadOf<'model.called'> => ({
  agent,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  settings: { effort: 'medium', maxTurns: 50 },
  tokens: { input: 100, output: 10, cacheRead: 1000, cacheWrite: 50 },
  costUsd,
  durationMs: 1000,
  calls: 3,
});

let seq = 10_000;
const settings = (ts: number, payload: unknown): PublicEvent =>
  ({
    id: `settings-${seq}`,
    seq: ++seq,
    ts: new Date(ts).toISOString(),
    work_item: null,
    type: 'settings.changed',
    version: VERSIONS['settings.changed'],
    actor: 'martin',
    summary: 'Martin changed the settings',
    payload,
    artifacts: [],
  }) as PublicEvent;

const chosen = (over: { agents?: object; caps?: object } = {}) => ({
  agents: {
    planner: { model: 'claude-sonnet-5-5', effort: 'medium' },
    coder: { model: 'claude-sonnet-5-5', effort: 'medium' },
    reviewer: { model: 'claude-sonnet-5-5', effort: 'medium' },
    describer: { model: 'claude-sonnet-5-5', effort: 'low' },
    ...over.agents,
  },
  caps: { dayUsd: 20, monthUsd: null, workItemUsd: 1, ...over.caps },
  changes: [{ field: 'cap', cap: 'day', beforeUsd: 20, afterUsd: 20 }],
});

describe('the settings in force', () => {
  it('are policy’s defaults until Martin saves any', () => {
    const view = settingsView([], 'local', at(12));
    expect(view.settings).toEqual(inForce('local'));
    expect(view.last).toBeUndefined();
    expect(view.spend.today).toEqual({ spentUsd: 0, capUsd: 20, atCap: false });
    expect(view.spend.month.capUsd).toBeNull();
    expect(settingsView([], 'do', at(12)).spend.month.capUsd).toBe(100);
  });

  it('are his latest save as policy’s check reads it, and his saves after t are not yet', () => {
    const events = [
      settings(at(1), chosen({ agents: { coder: { model: 'claude-opus-5-5', effort: 'high' } } })),
      settings(at(3), chosen({ agents: { coder: { model: 'claude-opus-5-5', effort: 'max' } }, caps: { dayUsd: 0 } })),
    ];
    expect(settingsView(events, 'local', at(2)).settings.agents.coder).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    // Outside policy, the gateway's default is in force, and the page says it was his.
    const later = settingsView(events, 'local', at(4));
    expect(later.settings.agents.coder).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(later.settings.caps.dayUsd).toBe(SPEND.local.dayUsd);
    expect(later.settings.outside.sort()).toEqual(['caps.dayUsd', 'coder.effort']);
    expect(later.last?.at).toBe(at(3));
  });
});

describe('the spend against the caps', () => {
  it('counts today’s and this month’s steps and judgements, and the dearest work item today', () => {
    const month = Date.parse('2026-10-01T09:00:00Z');
    const events = [
      ...work('1001', month).open().add(0, 'model.called', 'planner', step('planner', 2)).events,
      ...work('1002', at(8))
        .open()
        .add(0, 'model.called', 'coder', step('coder', 0.4))
        .add(60, 'model.called', 'reviewer', step('reviewer', 0.3)).events,
      ...work('1003', at(9)).open().add(0, 'model.called', 'coder', step('coder', 0.25)).events,
      settings(at(1), chosen({ caps: { dayUsd: 0.9, monthUsd: 10, workItemUsd: 0.5 } })),
    ];
    const { spend, week } = settingsView(events, 'local', at(12));
    expect(spend.today.spentUsd).toBeCloseTo(0.95);
    expect(spend.today).toMatchObject({ capUsd: 0.9, atCap: true });
    expect(spend.month.spentUsd).toBeCloseTo(2.95);
    expect(spend.month).toMatchObject({ capUsd: 10, atCap: false });
    expect(spend.dearest).toMatchObject({ workItem: '1002', capUsd: 0.5, atCap: true });
    expect(spend.dearest?.spentUsd).toBeCloseTo(0.7);
    expect(spend.resets).toBe(Date.parse('2026-10-04T00:00:00Z'));
    expect(week.coder).toEqual({ steps: 2, usd: expect.closeTo(0.65) });
    expect(week.planner).toEqual({ steps: 1, usd: 2 });
    expect(week.describer).toEqual({ steps: 0, usd: 0 });
  });

  it('is drawn at each time from the events read once, as from the events alone', () => {
    const events = [
      ...work('1002', at(8))
        .open()
        .add(0, 'model.called', 'coder', step('coder', 0.4))
        .add(60, 'model.called', 'reviewer', step('reviewer', 0.3)).events,
      settings(at(1), chosen({ caps: { dayUsd: 0.9, monthUsd: 10, workItemUsd: 0.5 } })),
    ];
    const folded = foldAt(events, at(12)).settings;
    // The day turns, and the week runs out, with no new event.
    for (const t of [at(12), at(30), at(8 * 24 + 9)]) {
      expect(settingsAt(folded, 'local', t)).toEqual(settingsView([...events], 'local', t));
    }
    expect(settingsAt(folded, 'local', at(30)).spend.today.spentUsd).toBe(0);
    expect(settingsAt(folded, 'local', at(8 * 24 + 9)).week.coder.steps).toBe(0);
  });

  it('counts nothing spent after t, from a fold made for a later time', () => {
    const events = work('1002', at(8))
      .open()
      .add(0, 'model.called', 'coder', step('coder', 0.4))
      .add(120, 'model.called', 'reviewer', step('reviewer', 0.3)).events;
    const later = foldAt(events, at(12)).settings;
    const between = at(9);
    expect(settingsAt(later, 'local', between)).toEqual(settingsView([...events], 'local', between));
    expect(settingsAt(later, 'local', between).spend.today.spentUsd).toBeCloseTo(0.4);
  });

  it('names no dearest work item on a day none has spent', () => {
    expect(settingsView([], 'local', at(12)).spend.dearest).toBeUndefined();
  });
});

describe('the console’s copies', () => {
  it('ask for the passkey on a save exactly where the access table does', () => {
    for (const [action, stepUp] of Object.entries(SETTINGS_STEP_UP)) {
      expect(ACCESS[action as keyof typeof SETTINGS_STEP_UP].stepUp, action).toBe(stepUp);
    }
  });

  it('read the profile, ALL_LOCAL and the app’s address from the page, and the defaults from anything else', () => {
    // The page's meta tags, as its server writes them.
    const page = (profile: string, allLocal: string, app = '') => {
      const meta: Record<string, string> = { 'sf-profile': profile, 'sf-all-local': allLocal, 'sf-app': app };
      const doc = {
        querySelector: (selector: string) => {
          const name = /name="([^"]+)"/.exec(selector)?.[1] ?? '';
          return { getAttribute: () => meta[name] ?? null };
        },
      };
      return factoryOf(doc);
    };
    expect(page('do', 'true')).toEqual({ profile: 'do', allLocal: true, app: undefined });
    expect(page('mars', 'yes')).toEqual({ profile: 'local', allLocal: false, app: undefined });
    expect(page('local', 'false', 'http://website.localhost:8080').app).toBe('http://website.localhost:8080');
    expect(page('local', 'false', 'javascript:alert(1)').app).toBeUndefined();
  });
});
