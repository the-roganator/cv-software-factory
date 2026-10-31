/**
 * The line's count of Martin's security events and of the holds started, read from the store (line/security.ts), as an
 * OpenTelemetry SDK collects it: a meter provider is installed for this file before the module loads, as `telemetry.ts`
 * is before the line's.
 */
import { metrics as api } from '@opentelemetry/api';
import * as metrics from '@opentelemetry/sdk-metrics';
import { HOLD_CAUSES, RELEASE_CONTROLS, VERSIONS } from '@software-factory/events';
import { latestControls } from '@software-factory/store';
import pino from 'pino';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { ACCESS, GUARDRAIL_HOLDS } from '../../../../policy/access.ts';
import { controlsInForce } from '../../../../policy/line.ts';

const reader = new metrics.PeriodicExportingMetricReader({
  exporter: new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE),
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new metrics.MeterProvider({ readers: [reader] });
api.setGlobalMeterProvider(meterProvider);
const { countAs, emptyTally, observeSecurity, readOn, SECURITY_KINDS, STEPPED_UP_CONTROLS } = await import(
  '../../src/line/security.ts'
);

afterAll(async () => {
  await meterProvider.shutdown();
  api.disable();
});

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('line_security');
});
afterEach(() => database?.end());

/** Appends an event straight to the store as `sql`'s role, unchecked: what is counted is what the store holds. */
async function append(
  sql: Sql,
  type: string,
  payload: object,
  workItem: string | null = null,
  {
    version = (VERSIONS[type as keyof typeof VERSIONS] as number | undefined) ?? 1,
    sample = false,
  }: {
    version?: number;
    sample?: boolean;
  } = {},
): Promise<void> {
  await sql`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
    values (${crypto.randomUUID()}, now(), ${workItem}, ${type}, ${version}, 'martin', ${type},
            ${sql.json(payload as never)}, '[]', '{}', ${sample})`;
}

/** Each kind's and each cause's figure, as the SDK collects them now. */
async function collected(): Promise<{ kinds: Record<string, number>; holds: Record<string, number> }> {
  const { resourceMetrics } = await reader.collect();
  const all = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
  const of = (name: string, label: string) =>
    Object.fromEntries(
      (all.find((m) => m.descriptor.name === name)?.dataPoints ?? []).map((p) => [
        String(p.attributes[label]),
        p.value as number,
      ]),
    );
  return { kinds: of('line.security_events', 'kind'), holds: of('line.holds.stored', 'cause') };
}

/** Whether the last read succeeded, as the SDK collects it now. */
async function gauge(): Promise<number | undefined> {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((m) => m.descriptor.name === 'line.security_events.counting');
  return metric?.dataPoints.at(-1)?.value as number | undefined;
}

describe('the count of Martin’s security events', () => {
  it('reports every kind and every cause, each from 0, before any has happened', async () => {
    const stop = observeSecurity(database.as.line, pino({ level: 'silent' }));
    try {
      const { kinds, holds } = await collected();
      expect(kinds).toEqual(Object.fromEntries(SECURITY_KINDS.map((kind) => [kind, 0])));
      expect(holds).toEqual(Object.fromEntries(HOLD_CAUSES.map((cause) => [cause, 0])));
    } finally {
      stop();
    }
  });

  it('counts each kind from the stored events, whatever role appended them, and nothing else', async () => {
    const { admin, operator } = database;
    await append(admin, 'admin.signed-in', { passkey: 'laptop' });
    await append(admin, 'admin.signed-in', {});
    await append(admin, 'admin.signed-out', { everywhere: false });
    await append(admin, 'admin.stepped-up', {});
    await append(operator, 'passkey.enrolled', {});
    await append(operator, 'passkey.revoked', { from: 'command-line' });
    await append(admin, 'settings.changed', {});
    await append(operator, 'line.started', { autonomy: 'supervised' });
    await append(operator, 'line.stopped', { reason: 'night' });
    await append(admin, 'line.stopped', { reason: 'from the console' });
    for (const action of RELEASE_CONTROLS) await append(admin, 'release.controlled', { action });
    // Each change of the controls with what it puts in force, as the admin service stores it.
    const controls = (autoRollback: boolean, change: object) => ({ autoRollback, change });
    await append(
      admin,
      'controls.changed',
      controls(true, { control: 'autonomy', before: 'supervised', after: 'guarded' }),
    );
    await append(
      admin,
      'controls.changed',
      controls(true, { control: 'take', before: null, after: { kind: 'every' } }),
    );
    await append(admin, 'controls.changed', controls(true, { control: 'new-work', before: true, after: false }));
    await append(admin, 'controls.changed', controls(false, { control: 'auto-rollback', before: true, after: false }));
    await append(admin, 'controls.changed', controls(true, { control: 'auto-rollback', before: false, after: true }));
    await append(admin, 'controls.changed', controls(false, { control: 'auto-rollback', before: true, after: false }));
    await append(admin, 'flag.staged', { from: { stage: 'off' }, to: { stage: 'checks' } });
    await append(admin, 'flag.staged', { from: { stage: 'checks' }, to: { stage: 'share', share: 50 } });
    await append(admin, 'flag.staged', { from: { stage: 'share', share: 50 }, to: { stage: 'preview' } });
    await append(admin, 'flag.staged', { from: { stage: 'preview' }, to: { stage: 'off' } });
    await append(admin, 'flag.staged', { from: { stage: 'everyone' }, to: { stage: 'everyone' } });
    await append(admin, 'improvement.requested', { words: 'Delivery dates.', steppedUp: true }, 'WI-10');
    await append(admin, 'alerts.switched', { phone: true });
    await append(admin, 'alerts.switched', { phone: false });
    await append(admin, 'alerts.switched', { phone: true });
    await append(database.as.line, 'model.called', {});
    // Each proof that did not hold, and none that did.
    await append(database.proofs, 'guardrail.proved', { proof: 'egress', held: false });
    await append(database.proofs, 'guardrail.proved', { proof: 'egress', held: true });
    await append(database.proofs, 'guardrail.proved', { proof: 'rollback', held: false });

    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds).toEqual({
      'sign-in': 2,
      'passkey-enrolled': 1,
      'passkey-revoked': 1,
      'setting-changed': 1,
      'release-control': STEPPED_UP_CONTROLS.length,
      'guardrail-approved': 0,
      'line-started': 1,
      'line-stopped': 2,
      'autonomy-loosened': 1,
      'autonomy-tightened': 0,
      'new-work-on': 0,
      'new-work-off': 1,
      'auto-merge-on': 0,
      'auto-merge-off': 0,
      'take-widened': 1,
      'take-narrowed': 0,
      'auto-rollback-off': 2,
      'auto-rollback-on': 1,
      'flag-widened': 2,
      'flag-narrowed': 1,
      'flag-off': 1,
      'improvement-requested': 1,
      'improvement-approved': 0,
      'phone-on': 2,
      'phone-off': 1,
      'guardrail-not-held': 2,
    });
  });

  it('counts a proof that did not hold only from the proofs’ role, were row security to let another append one', async () => {
    await database.owner`alter table events disable row level security`;
    try {
      await append(database.as.line, 'guardrail.proved', { proof: 'egress', held: false });
      await append(database.operator, 'guardrail.proved', { proof: 'egress', held: false });
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    expect((await readOn(database.as.line, emptyTally())).kinds['guardrail-not-held']).toBe(0);
    await append(database.proofs, 'guardrail.proved', { proof: 'egress', held: false });
    expect((await readOn(database.as.line, emptyTally())).kinds['guardrail-not-held']).toBe(1);
  });

  it('tells an improvement’s spec approved by the hold it answers and the kind its work item was opened as', async () => {
    const { admin } = database;
    const opened = (workItem: string, kind: string) =>
      append(kind === 'improvement' ? admin : database.as.triage, 'work-item.opened', { kind }, workItem);
    const hold = (workItem: string, cause: string) => append(database.as.line, 'hold.started', { cause }, workItem);
    const answer = (workItem: string, decision: string) => append(admin, 'hold.answered', { decision }, workItem);
    // An improvement's spec approved: counted. Rejected or answered in words: not.
    await opened('WI-11', 'improvement');
    await hold('WI-11', 'spec');
    await answer('WI-11', 'answered');
    await answer('WI-11', 'rejected');
    await hold('WI-11', 'spec');
    await answer('WI-11', 'approved');
    // Another hold on an improvement, approved, is no spec's.
    await hold('WI-11', 'question');
    await answer('WI-11', 'approved');
    // A defect fix's spec approved is not counted.
    await opened('WI-12', 'defect-fix');
    await hold('WI-12', 'spec');
    await answer('WI-12', 'approved');
    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds['improvement-approved']).toBe(1);
    expect(tally.kinds['guardrail-approved']).toBe(0);
  });

  it('tells a guardrail’s approval by the cause of the hold it answers, read from the store', async () => {
    const { admin } = database;
    const hold = (workItem: string, cause: string) => append(database.as.line, 'hold.started', { cause }, workItem);
    const answer = (workItem: string, decision: string) => append(admin, 'hold.answered', { decision }, workItem);
    // A guardrail's hold approved: counted. Rejected or answered in words: not.
    await hold('WI-1', 'scope');
    await answer('WI-1', 'rejected');
    await answer('WI-1', 'answered');
    await answer('WI-1', 'approved');
    // Held again, for a cause that is no guardrail: its approval is not counted, though an earlier hold's was one.
    await hold('WI-1', 'spec');
    await answer('WI-1', 'approved');
    // Another work item's guardrail does not lend its cause.
    await hold('WI-2', 'merge');
    await hold('WI-3', 'question');
    await answer('WI-3', 'approved');
    // An answer with no hold before it on its work item: nothing to tell it by.
    await answer('WI-4', 'approved');
    await hold('WI-4', 'spend');

    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds['guardrail-approved']).toBe(1);
    expect(tally.holds).toMatchObject({ scope: 1, spec: 1, merge: 1, question: 1, spend: 1, review: 0 });
  });

  it('reads a hold stored before holds had causes as the factory does, upcast', async () => {
    // A version 1 approval at Review implies a merge hold, a guardrail; a question implies none.
    await append(database.as.line, 'hold.started', { stage: 'review', kind: 'approval' }, 'WI-5', { version: 1 });
    await append(database.admin, 'hold.answered', { decision: 'approved' }, 'WI-5');
    await append(database.as.line, 'hold.started', { stage: 'plan', kind: 'question' }, 'WI-6', { version: 1 });
    await append(database.admin, 'hold.answered', { decision: 'approved' }, 'WI-6');
    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds['guardrail-approved']).toBe(1);
    expect(tally.holds).toMatchObject({ merge: 1, question: 1 });
  });

  it('counts auto-rollback turned off or on by what an event puts in force, whatever control its change names', async () => {
    const { admin } = database;
    const controls = (autoRollback: boolean, change: object) => ({
      autonomy: 'supervised',
      newWork: true,
      autoMerge: false,
      take: null,
      autoRollback,
      change,
    });
    // Off under a change that only informs him: it still pages as auto-rollback off.
    await append(
      admin,
      'controls.changed',
      controls(false, { control: 'autonomy', before: 'guarded', after: 'supervised' }),
    );
    // Still off: nothing more of auto-rollback.
    await append(admin, 'controls.changed', controls(false, { control: 'new-work', before: true, after: false }));
    // Its own switch on, counted once.
    await append(admin, 'controls.changed', controls(true, { control: 'auto-rollback', before: false, after: true }));
    // On again from off under another change.
    await append(admin, 'controls.changed', controls(false, { control: 'auto-rollback', before: true, after: false }));
    await append(admin, 'controls.changed', controls(true, { control: 'new-work', before: false, after: true }));
    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds).toMatchObject({
      'autonomy-tightened': 1,
      'new-work-off': 1,
      'new-work-on': 1,
      'auto-rollback-off': 2,
      'auto-rollback-on': 2,
    });
    expect(tally.autoRollback).toBe(true);
    // A reader that starts afresh agrees.
    expect(await readOn(database.as.line, emptyTally())).toEqual(tally);
  });

  it('follows auto-rollback in force through the events its series follow, so its before is theirs', async () => {
    const { admin, owner } = database;
    const controls = (autoRollback: boolean, change: object) => ({
      autonomy: 'supervised',
      newWork: true,
      autoMerge: false,
      take: null,
      autoRollback,
      change,
    });
    /** Whether the series say auto-rollback is on now: Martin's latest controls, through policy. */
    const inForce = async () => controlsInForce(await latestControls(database.as.line)).autoRollback;
    // Off in a change none of Martin's roles appended: counted by its change, as every stored change is, but not in
    // force, as the series do not read it.
    await append(
      owner,
      'controls.changed',
      controls(false, { control: 'take', before: null, after: { kind: 'every' } }),
    );
    let tally = await readOn(database.as.line, emptyTally());
    expect(await inForce()).toBe(true);
    expect(tally).toMatchObject({ autoRollback: true, kinds: { 'take-widened': 1, 'auto-rollback-off': 0 } });
    // Martin's own off, under a change that only informs him, is the switch the series see, and pages.
    await append(
      admin,
      'controls.changed',
      controls(false, { control: 'autonomy', before: 'guarded', after: 'supervised' }),
    );
    // On again under a version newer than this code knows, which the series read as it stands.
    await append(
      admin,
      'controls.changed',
      { ...controls(true, { control: 'new-work', before: true, after: false }), newer: true },
      null,
      { version: VERSIONS['controls.changed'] + 1 },
    );
    tally = await readOn(database.as.line, tally);
    expect(await inForce()).toBe(true);
    expect(tally).toMatchObject({ autoRollback: true, kinds: { 'auto-rollback-off': 1, 'auto-rollback-on': 1 } });
    // Read all at once, in order, it is the same.
    expect(await readOn(database.as.line, emptyTally())).toEqual(tally);
  });

  it('counts nothing in a store of samples, which never happened', async () => {
    await append(database.operator, 'admin.signed-in', {}, null, { sample: true });
    await append(database.operator, 'hold.started', { cause: 'merge' }, 'WI-7', { sample: true });
    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds['sign-in']).toBe(0);
    expect(tally.holds.merge).toBe(0);
  });

  it('reads on from the last event it read, and reports the same figure from the start', async () => {
    const { admin } = database;
    await append(admin, 'admin.signed-in', {});
    const first = await readOn(database.as.line, emptyTally());
    expect(first.kinds['sign-in']).toBe(1);
    await append(admin, 'admin.signed-in', {});
    await append(database.as.line, 'hold.started', { cause: 'not-a-cause' }, 'WI-9');
    const next = await readOn(database.as.line, first);
    expect(next.kinds['sign-in']).toBe(2);
    expect(next.holds.unknown).toBe(1);
    expect(BigInt(next.seq)).toBeGreaterThan(BigInt(first.seq));
    // Nothing new: the same figures. And a reader that starts afresh, as a restarted line or a second replica, agrees.
    expect(await readOn(database.as.line, next)).toEqual(next);
    expect(await readOn(database.as.line, emptyTally())).toEqual(next);
  });

  it('says the count is stale while the store cannot be read, and logs it once', async () => {
    const warnings: string[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => warnings.push(line) });
    await append(database.admin, 'admin.signed-in', {});
    // A store that refuses every query: a tagged call rejects, and the helper that makes its list makes nothing. A
    // fragment inside another query is never awaited itself, so its rejection is marked handled, as postgres.js's is.
    const refused = () => {
      const query = Promise.reject(new Error('the store is down'));
      query.catch(() => {});
      return query;
    };
    const broken = ((strings: unknown) =>
      Array.isArray(strings) && 'raw' in strings ? refused() : {}) as unknown as Sql;
    const stop = observeSecurity(broken, log);
    try {
      expect(await gauge()).toBe(0);
      expect(await gauge()).toBe(0);
      expect(warnings.filter((line) => line.includes('could not count'))).toHaveLength(1);
    } finally {
      stop();
    }
    const working = observeSecurity(database.as.line, log);
    try {
      expect(await gauge()).toBe(1);
      expect((await collected()).kinds['sign-in']).toBe(1);
    } finally {
      working();
    }
  });
});

describe('what counts as a security event', () => {
  it('counts the release controls the access table marks as needing the passkey again, and no other', () => {
    const access = ACCESS as Record<string, { stepUp: boolean }>;
    const key = (action: string) => `release.${action === 'promote-fully' ? 'promote' : action}`;
    for (const action of RELEASE_CONTROLS) {
      expect(access[key(action)], action).toBeDefined();
      expect(countAs({ type: 'release.controlled', action }) !== null, action).toBe(access[key(action)]?.stepUp);
    }
  });

  it('counts every action that needs the passkey again, or names the event it waits for', () => {
    // Each action the access table marks, by the kind its event is counted as.
    const counted: Record<string, string> = {
      'passkey.revoke': 'passkey-revoked',
      'hold.approve-guardrail': 'guardrail-approved',
      'line.start': 'line-started',
      'release.promote': 'release-control',
      'release.retry': 'release-control',
      'agent.raise': 'setting-changed',
      'caps.raise': 'setting-changed',
      'autonomy.loosen': 'autonomy-loosened',
      'auto-merge.on': 'auto-merge-on',
      'auto-rollback.off': 'auto-rollback-off',
      'take.widen': 'take-widened',
      'flag.widen': 'flag-widened',
      'flag.back-on': 'flag-widened',
      'improvement.request': 'improvement-requested',
      'hold.approve-improvement-spec': 'improvement-approved',
      'phone.off': 'phone-off',
    };
    const marked = Object.entries(ACCESS as Record<string, { stepUp: boolean }>)
      .filter(([, access]) => access.stepUp)
      .map(([name]) => name);
    expect(Object.keys(counted).sort()).toEqual(marked.sort());
    // Giving the passkey again is not counted itself: each action it allows is.
    expect(countAs({ type: 'admin.stepped-up' })).toBeNull();
    for (const kind of Object.values(counted)) {
      expect(SECURITY_KINDS).toContain(kind);
    }
  });

  it('counts a guardrail’s proof that did not hold, from the proofs’ role alone, and nothing it cannot read', () => {
    const proved = (held: unknown, appendedBy: string | null = 'factory_proofs') =>
      countAs({ type: 'guardrail.proved', held, appendedBy });
    expect(proved(false)).toEqual({ kind: 'guardrail-not-held' });
    expect(proved(true)).toBeNull();
    expect(proved('false')).toBeNull();
    expect(proved(undefined)).toBeNull();
    expect(proved(false, 'factory_line')).toBeNull();
    expect(proved(false, 'factory_operator')).toBeNull();
    expect(proved(false, null)).toBeNull();
  });

  it('counts every switch of alerts to the phone by whether they reach it now, and nothing it cannot read', () => {
    expect(countAs({ type: 'alerts.switched', phone: true })).toEqual({ kind: 'phone-on' });
    expect(countAs({ type: 'alerts.switched', phone: false })).toEqual({ kind: 'phone-off' });
    expect(countAs({ type: 'alerts.switched', phone: 'off' })).toBeNull();
    expect(countAs({ type: 'alerts.switched' })).toBeNull();
  });

  it('counts every move of a flag’s stage, as the action it is, from its stages alone', () => {
    const moved = (from: object | null, to: object) => countAs({ type: 'flag.staged', staged: { from, to } });
    expect(moved({ stage: 'off' }, { stage: 'checks' })).toEqual({ kind: 'flag-widened' });
    expect(moved({ stage: 'checks' }, { stage: 'share', share: 25 })).toEqual({ kind: 'flag-widened' });
    expect(moved({ stage: 'share', share: 10 }, { stage: 'share', share: 50 })).toEqual({ kind: 'flag-widened' });
    expect(moved({ stage: 'off' }, { stage: 'everyone' })).toEqual({ kind: 'flag-widened' });
    expect(moved(null, { stage: 'checks' })).toEqual({ kind: 'flag-widened' });
    expect(moved({ stage: 'everyone' }, { stage: 'preview' })).toEqual({ kind: 'flag-narrowed' });
    expect(moved({ stage: 'share', share: 50 }, { stage: 'share', share: 10 })).toEqual({ kind: 'flag-narrowed' });
    expect(moved({ stage: 'everyone' }, { stage: 'off' })).toEqual({ kind: 'flag-off' });
    expect(moved(null, { stage: 'off' })).toEqual({ kind: 'flag-off' });
    // No move, or none the event's schema allows: nothing.
    expect(moved({ stage: 'checks' }, { stage: 'checks' })).toBeNull();
    expect(moved({ stage: 'off' }, { stage: 'share', share: 30 })).toBeNull();
    expect(countAs({ type: 'flag.staged' })).toBeNull();
  });

  it('counts every change of the line’s controls, as the action it is, from its before and after alone', () => {
    const changed = (change: object) => countAs({ type: 'controls.changed', change });
    expect(changed({ control: 'autonomy', before: 'supervised', after: 'guarded' })).toEqual({
      kind: 'autonomy-loosened',
    });
    expect(changed({ control: 'autonomy', before: 'guarded', after: 'supervised' })).toEqual({
      kind: 'autonomy-tightened',
    });
    expect(changed({ control: 'new-work', before: true, after: false })).toEqual({ kind: 'new-work-off' });
    expect(changed({ control: 'new-work', before: false, after: true })).toEqual({ kind: 'new-work-on' });
    expect(changed({ control: 'auto-merge', before: false, after: true })).toEqual({ kind: 'auto-merge-on' });
    expect(changed({ control: 'auto-merge', before: true, after: false })).toEqual({ kind: 'auto-merge-off' });
    const one = { kind: 'just-one', workItem: '1290' };
    expect(changed({ control: 'take', before: one, after: { kind: 'every' } })).toEqual({ kind: 'take-widened' });
    expect(changed({ control: 'take', before: { kind: 'every' }, after: one })).toEqual({ kind: 'take-narrowed' });
    expect(changed({ control: 'take', before: null, after: one })).toEqual({ kind: 'take-widened' });
    expect(changed({ control: 'auto-rollback', before: true, after: false })).toEqual({ kind: 'auto-rollback-off' });
    expect(changed({ control: 'auto-rollback', before: false, after: true })).toEqual({ kind: 'auto-rollback-on' });
    expect(countAs({ type: 'controls.changed' })).toBeNull();
    // A malformed change is counted as nothing, and stops no count.
    expect(changed({ control: 'take', before: one, after: null })).toBeNull();
    expect(changed({ control: 'autonomy', before: 'supervised', after: 'yolo' })).toBeNull();
  });

  it('tells a guardrail by the access table’s list', () => {
    for (const cause of HOLD_CAUSES) {
      const approved = countAs({ type: 'hold.answered', decision: 'approved', cause });
      expect(approved !== null, cause).toBe((GUARDRAIL_HOLDS as readonly string[]).includes(cause));
    }
  });
});
