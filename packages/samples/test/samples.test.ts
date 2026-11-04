import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_TYPES, AGENTS, KINDS, type PublicEvent } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { mayAppend } from '../../../policy/refusals.ts';
import { MARTINS_ROLES, STORE_GRANTS } from '../../../policy/store-grants.ts';
import { ARTIFACTS, LOG } from '../src/captures.ts';
import { publicSamples } from '../src/export.ts';
import { sampleEvents } from '../src/index.ts';
import { SAMPLE_REFUSAL_KEY } from '../src/refusals.ts';
import { appenderOf } from '../src/roles.ts';

const events = sampleEvents();
const published = publicSamples();
const of = <K extends PublicEvent['type']>(type: K) =>
  published.filter((event): event is PublicEvent<K> => event.type === type);

describe('the samples', () => {
  it('are all valid events, each work item opening before anything else happens to it', () => {
    const opened = new Set<string>();
    for (const event of events) {
      if (event.type === 'work-item.opened' && event.work_item) opened.add(event.work_item);
      else if (event.work_item) expect(opened.has(event.work_item), `${event.work_item} ${event.type}`).toBe(true);
    }
  });

  it('say they are samples', () => {
    expect(of('work-item.opened').every((event) => event.payload.sample)).toBe(true);
  });

  it('cover every kind of work item but a planner’s finding and a red-team attack', () => {
    const kinds = KINDS.filter((kind) => kind !== 'planner-finding' && kind !== 'red-team');
    expect(new Set(of('work-item.opened').map((event) => event.payload.kind))).toEqual(new Set(kinds));
  });

  it('have model calls from every agent but the red team, on Claude and on the local model, and a Jev judgement', () => {
    // Milestone 7's attacks are scripted, with fixed content and no agent: nothing calls a model as the red team yet.
    const agents = new Set([...of('model.called').map((event) => event.payload.agent), 'triage']);
    expect(agents).toEqual(new Set(AGENTS.filter((agent) => agent !== 'red-team')));
    expect(new Set(of('model.called').map((event) => event.payload.provider))).toEqual(new Set(['anthropic', 'local']));
    expect(of('judgement.made').length).toBeGreaterThan(0);
  });

  it('record one model call event for each agent’s step, as the line does', () => {
    expect(of('model.called').some((event) => event.payload.calls > 1)).toBe(true);
  });

  it('send work back upstream at least once', () => {
    expect(of('work.returned').length).toBeGreaterThan(0);
  });

  it('answer an approval’s suggestions before the describer writes it up, as the line does: one taken, one declined in full', () => {
    const answered = of('suggestions.answered').map((event) => event.payload);
    expect(answered.some((a) => a.declined.length === 0)).toBe(true);
    expect(answered.some((a) => a.declined.length === a.suggestions)).toBe(true);
    expect(of('work.returned').some((event) => event.payload.suggestions !== undefined)).toBe(true);
    // Each review that leaves suggestions has them answered before the describer writes the change up: a blocking
    // review's with its findings, an approval's in a round of their own. (The review after a suggestions round goes on
    // whatever it suggests; no sample has one that does.)
    for (const summary of of('work-item.summarised').filter((event) => event.actor === 'describer')) {
      const before = published.filter((event) => event.work_item === summary.work_item && event.seq < summary.seq);
      before.forEach((review, i) => {
        if (review.type !== 'review.submitted' || review.payload.findings.every((f) => f.blocking)) return;
        const answer = before.slice(i + 1).find((event) => event.type === 'suggestions.answered');
        expect(answer, `${summary.work_item} review at ${review.ts}`).toBeDefined();
      });
    }
  });

  it('end with a work item still on the line', () => {
    const last = published.at(-1);
    const closed = new Set(of('work-item.closed').map((event) => event.work_item));
    expect(last?.work_item && !closed.has(last.work_item)).toBe(true);
  });

  it('measure every step a release records before it is promoted, and promote none early', () => {
    for (const start of of('release.started')) {
      const { release, steps } = start.payload;
      const later = published.filter(
        (event) =>
          event.work_item === start.work_item && 'release' in event.payload && event.payload.release === release,
      );
      const promotion = later.findIndex((event) => event.type === 'release.promoted');
      if (promotion < 0) continue;
      // Every step the release recorded, each measured before the promotion, and none after it.
      const weights = later.flatMap((event) => (event.type === 'canary.stepped' ? [event.payload.weight] : []));
      const before = later
        .slice(0, promotion)
        .flatMap((event) => (event.type === 'canary.stepped' ? [event.payload.weight] : []));
      expect(before, release).toEqual(steps?.map((step) => step.weight));
      expect(weights, release).toEqual(before);
    }
  });

  it('ship as milestone 6’s line does: a release on two work items, releases on none, and each way one ends', () => {
    const on = new Map<string, Set<string | null>>();
    for (const event of of('release.started')) {
      on.set(event.payload.release, (on.get(event.payload.release) ?? new Set()).add(event.work_item));
    }
    expect([...on.values()].some((items) => items.size > 1)).toBe(true);
    expect(of('release.started').some((event) => event.work_item === null)).toBe(true);
    expect(of('release.rolled-back').some((event) => event.payload.failed.every((m) => !m.series))).toBe(true);
    expect(of('signal.received').some((event) => event.payload.sense === 'canary')).toBe(true);
    expect(of('verification.finished').map((event) => event.payload.outcome)).toContain('persists');
    expect(of('work.returned').some((event) => event.payload.from === 'verify')).toBe(true);
    expect(of('work-item.reopened').length).toBeGreaterThan(0);
    expect(of('line.stopped').length).toBeGreaterThan(0);
    expect(of('release.aborted').map((event) => event.payload.by)).toEqual(['stop', 'martin']);
    expect(of('release.errored').map((event) => event.payload.weight)).toEqual([25]);
  });

  it('mark a dry run’s release and its verification, and nothing else', () => {
    const dry = published.filter((event) => 'dryRun' in event.payload && event.payload.dryRun);
    expect(new Set(dry.map((event) => event.type))).toEqual(
      new Set(['release.started', 'canary.stepped', 'release.promoted', 'verification.finished']),
    );
    expect(new Set(dry.map((event) => event.work_item))).toEqual(new Set(['1310']));
  });

  it('end with a canary in flight, and a merge waiting for Martin’s deploy', () => {
    const last = of('release.started').at(-1);
    const ended = published.filter(
      (event) =>
        (event.type === 'release.promoted' || event.type === 'release.rolled-back') &&
        event.payload.release === last?.payload.release,
    );
    expect(ended).toEqual([]);
    const holds = of('hold.started').filter((event) => event.payload.cause === 'deploy');
    const waiting = holds.filter(
      (hold) =>
        !published.some((e) => e.type === 'release.started' && e.work_item === hold.work_item && e.seq > hold.seq),
    );
    expect(waiting.map((hold) => hold.work_item)).toEqual(['1321']);
  });

  it('look at the canary in flight about once a minute, the journeys on their own, each recorded after it ended', () => {
    const last = of('release.started').at(-1);
    const looks = of('canary.measuring').filter((event) => event.payload.release === last?.payload.release);
    const times = looks.map((event) => Date.parse(event.payload.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const minutely = looks.filter((event) => event.payload.measures.some((m) => m.name === 'errors'));
    expect(minutely.length).toBeGreaterThanOrEqual(5);
    for (const [i, event] of minutely.entries()) {
      if (i > 0) expect(Date.parse(event.payload.at) - Date.parse(minutely[i - 1]?.payload.at ?? '')).toBe(60_000);
    }
    expect(looks.filter((event) => event.payload.measures.some((m) => m.name === 'journeys'))).toHaveLength(1);
    // A look is recorded a pass after it ended, and before the next step or look the line read.
    for (const event of looks) expect(Date.parse(event.ts)).toBeGreaterThan(Date.parse(event.payload.at));
    // Looks only at a release in flight: a dry run measures nothing, and one that ended has no more.
    expect(of('canary.measuring').every((event) => event.payload.release === last?.payload.release)).toBe(true);
    // Errors and latency wait for the canary's first 100 requests.
    expect(minutely[0]?.payload.measures.map((m) => m.value)).toEqual([null, null]);
    expect(minutely.at(-1)?.payload.weight).toBe(50);
  });

  it('keep the score from off to the figures the line’s own tickets earn', () => {
    const scores = of('score.updated').map((event) => event.payload);
    expect(scores[0]).toEqual({ keyed: false });
    const keyed = scores.flatMap((score) => (score.keyed ? [score] : []));
    // Verified moves both ways: a reopened ticket stops counting until it is verified again.
    expect(keyed.map((score) => score.verified)).toEqual([0, 1, 2, 3, 4, 4, 5, 6, 6, 5, 5]);
    expect(keyed.every((score, i) => i === 0 || score.found >= (keyed[i - 1]?.found ?? 0))).toBe(true);
  });

  it('carry the role that would append each, as the store would let it', () => {
    const roles = new Set(Object.keys(STORE_GRANTS));
    for (const event of published) {
      if (event.type === 'defect.injected') {
        expect(event.appended_by).toBeUndefined();
        continue;
      }
      expect(roles.has(event.appended_by ?? ''), `${event.work_item} ${event.type}`).toBe(true);
      if (ADMIN_TYPES.includes(event.type)) expect(MARTINS_ROLES).toContain(event.appended_by);
      if (event.type === 'action.refused') {
        expect(mayAppend(event.payload.mechanism, event.appended_by ?? ''), event.payload.mechanism).toBe(true);
      }
    }
    // The coder's scope fence is the line's to record, as are admission control's refusals and those the GitHub worker
    // answers it with; triage records its own quarantine, and the gateway its own.
    expect(
      Object.fromEntries(
        Object.entries(Object.groupBy(of('action.refused'), (event) => event.payload.mechanism)).map(
          ([mechanism, list]) => [mechanism, [...new Set(list?.map((event) => event.appended_by))]],
        ),
      ),
    ).toEqual({
      'admission-control': ['factory_line'],
      gateway: ['factory_gateway'],
      'github-guard': ['factory_line'],
      'review-gate': ['factory_line'],
      'scope-fence': ['factory_line'],
      'token-permission': ['factory_line'],
      'typed-judgement': ['factory_triage'],
    });
    expect(new Set(of('signal.received').map((event) => event.appended_by))).toEqual(new Set(['factory_triage']));
  });

  it('sign each relayed refusal’s record with their own key, kept beside the events, but the one changed after', () => {
    const key = createPublicKey(SAMPLE_REFUSAL_KEY);
    expect(readFileSync(join(LOG, 'refusal-key.pem'), 'utf-8')).toBe(SAMPLE_REFUSAL_KEY);
    const relayed = of('action.refused').filter((event) => event.payload.record !== undefined);
    const checked = relayed.map((event) => {
      const { record = '', signature = '' } = event.payload;
      const bytes = readFileSync(join(ARTIFACTS, record));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(record);
      expect(verify(null, bytes, key, Buffer.from(signature, 'base64'))).toBe(true);
      // The record holds the payload as signed: one whose public words differ was redacted, or changed after.
      const signed = (JSON.parse(bytes.toString('utf-8')) as { payload: { action: string; output: string } }).payload;
      return [
        event.payload.mechanism,
        signed.action === event.payload.action && signed.output === event.payload.output
          ? 'as signed'
          : signed.action === event.payload.action
            ? 'redacted'
            : 'changed',
      ];
    });
    expect(checked).toEqual([
      ['github-guard', 'as signed'],
      ['review-gate', 'redacted'],
      ['token-permission', 'changed'],
      ['github-guard', 'as signed'],
    ]);
  });

  it('hold no red-team attack: the samples never fabricate one, as Martin launches each live', () => {
    // Every attack is available now (the harness makes all five), but the samples stage none: a red-team attack is
    // Martin's live launch, not a sample. The console's browser tests bring their own (apps/console/test/attacks).
    expect(published.filter((event) => event.type.startsWith('attack.'))).toEqual([]);
    expect(of('work-item.opened').filter((event) => event.payload.kind === 'red-team')).toEqual([]);
  });

  it('keep a guardrail that did not hold, from make guardrails’ own proof', () => {
    const failed = of('guardrail.proved').filter((event) => !event.payload.held);
    expect(failed.map((event) => [event.payload.proof, event.appended_by])).toEqual([['egress', 'factory_proofs']]);
  });

  it("give a guardrail's proof to the proofs' role, the only one that may append it", () => {
    const proof = { type: 'guardrail.proved', actor: 'factory', payload: {} } as unknown as Parameters<
      typeof appenderOf
    >[0];
    expect(appenderOf(proof)).toBe('factory_proofs');
  });

  it('publish nothing a visitor may not see: no keys, no report text', () => {
    const log = readFileSync(join(LOG, 'events.ndjson'), 'utf-8');
    for (const event of events) {
      if (event.type === 'work-item.opened' && event.payload.visitor) {
        expect(log).not.toContain(event.payload.visitor.key);
      }
      if (event.type === 'signal.received' && event.payload.report?.text) {
        expect(log).not.toContain(event.payload.report.text.slice(0, 30));
      }
    }
  });
});
