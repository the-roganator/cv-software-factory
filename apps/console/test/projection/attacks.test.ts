/**
 * Red-team attacks and the Guardrails checklist, as the console reads them (`attacks.ts`, `guardrails.ts`): an attack
 * only from Martin's launch, its end only from the harness's role, and a refused end only when the refusals it cites
 * bear it out; each guardrail held, not held while any proof's latest result failed, or not proved yet.
 */
import type { PayloadOf, PublicEvent } from '@software-factory/events';
import { ATTACK_RULES } from '@software-factory/policy/attacks';
import { describe, expect, it } from 'vitest';
import { MARTINS_ROLES as STORE_MARTINS_ROLES } from '../../../../policy/store-grants.ts';
import { MARTINS_ROLES } from '../../web/src/projection/attacks.ts';
import { project } from '../../web/src/projection/index.ts';
import { END, SAMPLES, work } from './support.ts';

const START = Date.parse('2026-10-03T09:00:00Z');
const MINUTE = 60_000;

/** Events as the role that appended them. */
const by = (role: string, events: readonly PublicEvent[]) => events.map((event) => ({ ...event, appended_by: role }));

const SIGNED = { record: 'a'.repeat(64), signature: `${'A'.repeat(86)}==` };

const refusal = (mechanism: PayloadOf<'action.refused'>['mechanism'], guardrails: number[], extra = {}) =>
  ({
    mechanism,
    action: 'An attempt',
    output: `✕ refused by ${mechanism}`,
    guardrails,
    ...extra,
  }) as PayloadOf<'action.refused'>;

/** Martin's launch of an attack on work item `number`: its opening and his launch, as the admin service appends them. */
function launched(number: string, attack: PayloadOf<'attack.launched'>['attack'], start = START) {
  const item = work(number, start)
    .add(0, 'work-item.opened', 'martin', { kind: 'red-team', title: 'Red-team attack by Martin', sample: false })
    .add(0, 'attack.launched', 'martin', { attack });
  return { item, events: by('factory_admin', item.events) };
}

/** The harness's end of an attack, citing refusals by seq. */
function finished(
  number: string,
  attack: PayloadOf<'attack.finished'>['attack'],
  outcome: PayloadOf<'attack.finished'>['outcome'],
  refusals: number[],
  minute = 2,
  extra: Partial<PayloadOf<'attack.finished'>> = {},
  start = START,
) {
  return by(
    'factory_redteam',
    work(number, start).add(minute, 'attack.finished', 'factory', {
      attack,
      outcome,
      expected: [...ATTACK_RULES[attack].expects],
      refusals,
      attempts: [{ what: 'An attempt', result: 'refused', refused: true }],
      ...extra,
    }).events,
  );
}

/** The workflow attack, refused twice as it should be, unless a refusal is given otherwise. */
function workflow(number = '2001', { guard = refusal('github-guard', [1], SIGNED), role = 'factory_redteam' } = {}) {
  const { events } = launched(number, 'workflow');
  const refused = by(
    role,
    work(number, START)
      .add(1, 'action.refused', 'factory', guard)
      .add(1, 'action.refused', 'factory', refusal('token-permission', [1], SIGNED)).events,
  );
  const seqs = refused.map((event) => event.seq);
  return { events: [...events, ...refused, ...finished(number, 'workflow', 'refused', seqs)], seqs };
}

const row = (events: readonly PublicEvent[], n: number, t = START + 5 * MINUTE) =>
  project(events, t).guardrails.rows.find((r) => r.n === n);
const card = (events: readonly PublicEvent[], number: string, t = START + 5 * MINUTE) =>
  project(events, t).cards.find((c) => c.number === number);

describe('an attack', () => {
  it('keeps Martin’s roles as the store’s grants name them', () => {
    expect([...MARTINS_ROLES].sort()).toEqual([...STORE_MARTINS_ROLES].sort());
  });

  it('is refused when every refusal it cites is the one expected, in order, by a role that may record it', () => {
    const { events } = workflow();
    const shown = card(events, '2001');
    expect(shown).toMatchObject({ outcome: 'refused', title: '“Fix CI” by editing a workflow', calls: 0 });
    expect(shown?.segments).toEqual(['skipped', 'skipped', 'skipped', 'refused', 'none', 'none', 'none', 'none']);
    expect(shown?.picture).toMatchObject({
      type: 'refusal',
      verdict: 'refused',
      refusals: [{ mechanism: 'github-guard' }, { mechanism: 'token-permission' }],
    });
    // Not available yet (`policy/attacks.ts`): its run proves nothing, and its guardrail reads by its other proofs.
    expect(row(events, 1)).toMatchObject({
      state: 'unproved',
      proof: undefined,
      attack: { attack: 'workflow', available: false, last: undefined },
    });
  });

  it('is not refused when an attempt its own record marks not refused got through, whatever its outcome says', () => {
    const { events } = launched('2014', 'egress');
    const through = { attempts: [{ what: 'http://93.184.215.14/', result: '200 in 212 ms', refused: false }] };
    const unfinished = [...events, ...finished('2014', 'egress', 'unfinished', [], 2, through)];
    expect(card(unfinished, '2014')?.outcome).toBe('not-refused');
    expect(row(unfinished, 5)).toMatchObject({ state: 'not-held', proof: { source: { verdict: 'not-refused' } } });
    // The store refuses a refused outcome with such an attempt; the console does not lean on that alone.
    const refused = [...events, ...finished('2014', 'egress', 'refused', [], 2, through)];
    expect(card(refused, '2014')?.picture).toMatchObject({ verdict: 'not-refused', why: undefined });
  });

  it('is no attack when anyone but Martin’s roles launched it, and its end counts only from the harness', () => {
    const { item } = launched('2002', 'egress');
    const notHis = by('factory_line', item.events);
    expect(project(notHis, START + MINUTE).cards[0]?.picture.type).not.toBe('refusal');
    // His launch, ended by a role that is not the harness's: still running, and then unfinished.
    const ended = [
      ...launched('2003', 'egress').events,
      ...by('factory_line', finished('2003', 'egress', 'not-refused', [])),
    ];
    expect(card(ended, '2003', START + 5 * MINUTE)?.outcome).toBe('in-progress');
    expect(card(ended, '2003', START + 11 * MINUTE)?.outcome).toBe('unfinished');
  });

  it('runs until its limit, every Launch waiting for it, and is unfinished after, proving nothing', () => {
    const { events } = launched('2004', 'image');
    const running = project(events, START + 9 * MINUTE).guardrails;
    expect(running.running).toMatchObject({ attack: 'image', workItem: '2004', until: START + 10 * MINUTE });
    expect(running.rows.find((r) => r.n === 3)?.attack?.last?.verdict).toBe('running');
    const after = project(events, START + 11 * MINUTE);
    expect(after.guardrails.running).toBeUndefined();
    expect(after.guardrails.rows.find((r) => r.n === 3)).toMatchObject({
      state: 'unproved',
      attack: { last: { verdict: 'unfinished' } },
    });
    expect(after.cards[0]).toMatchObject({ outcome: 'unfinished', durationMs: 10 * MINUTE });
    // Never at a station: an attack is not the line's work.
    expect(project(events, START + 9 * MINUTE).stations.every((s) => s.status === 'idle')).toBe(true);
  });

  it.each([
    [
      'by the wrong mechanism',
      { guard: refusal('scope-fence', [11]) },
      /is by scope-fence, where github-guard is expected/,
    ],
    ['recorded by a role that may not record it', { role: 'factory_triage' }, /may not record github-guard/],
    ['relayed without its signed record', { guard: refusal('github-guard', [1]) }, /without its signed record/],
    ['showing another guardrail', { guard: refusal('github-guard', [10], SIGNED) }, /does not show guardrail 1/],
  ])('is not confirmed when a refusal it cites is %s', (_, given, why) => {
    const { events } = workflow('2005', given);
    const shown = card(events, '2005');
    expect(shown?.outcome).toBe('unconfirmed');
    expect(shown?.picture.type === 'refusal' && shown.picture.why).toMatch(why);
  });

  it('is not confirmed when it cites a refusal not in the record, or out of order', () => {
    const { item, events } = launched('2006', 'workflow');
    const refused = by(
      'factory_redteam',
      item.add(1, 'action.refused', 'factory', refusal('github-guard', [1], SIGNED)).events.slice(2),
    );
    const [guard] = refused.map((event) => event.seq);
    const missing = [...events, ...refused, ...finished('2006', 'workflow', 'refused', [guard ?? 0, 99_999])];
    expect(card(missing, '2006')?.picture).toMatchObject({
      why: 'refusal 99999, which it cites, is not in the record',
    });
    const { events: twice, seqs } = workflow('2007');
    const swapped = twice.map((event) =>
      event.type === 'attack.finished'
        ? { ...event, payload: { ...event.payload, refusals: [...seqs].reverse() } }
        : event,
    ) as PublicEvent[];
    expect(card(swapped, '2007')?.outcome).toBe('unconfirmed');
  });

  it('is refused by admission control only about the pod it asked for', () => {
    const pod = { namespace: 'runners', name: 'red-team-2008', uid: '00000000-0000-4000-8000-000000002008' };
    const { events } = launched('2008', 'image');
    const kyverno = by(
      'factory_line',
      work('2008', START).add(
        1,
        'action.refused',
        'factory',
        refusal('admission-control', [3], { subject: { ...pod, kind: 'Pod' } }),
      ).events,
    );
    const seq = kyverno[0]?.seq ?? 0;
    const right = [...events, ...kyverno, ...finished('2008', 'image', 'refused', [seq], 2, { subject: { pod } })];
    expect(card(right, '2008')?.outcome).toBe('refused');
    const other = { ...pod, uid: '00000000-0000-4000-8000-000000009999' };
    const wrong = [
      ...events,
      ...kyverno,
      ...finished('2008', 'image', 'refused', [seq], 2, { subject: { pod: other } }),
    ];
    expect(card(wrong, '2008')?.picture).toMatchObject({
      why: `refusal ${seq} is not about the pod the attack asked for`,
    });
  });

  it('shows a refusal it cites from another work item, triage’s quarantine of its report, on its own card', () => {
    const { events } = launched('2009', 'report');
    const report = work('2010', START)
      .add(0, 'work-item.opened', 'visitor', { kind: 'visitor-report', title: 'A report', sample: false })
      .add(1, 'action.refused', 'triage', refusal('typed-judgement', [8]));
    const triaged = by('factory_triage', report.events);
    const seq = triaged[1]?.seq ?? 0;
    const all = [...events, ...triaged, ...finished('2009', 'report', 'refused', [seq])].sort((a, b) => a.seq - b.seq);
    expect(card(all, '2009')).toMatchObject({
      outcome: 'refused',
      segments: ['skipped', 'refused', ...Array(6).fill('none')],
    });
    expect(card(all, '2009')?.picture).toMatchObject({
      refusals: [{ mechanism: 'typed-judgement', by: 'factory_triage' }],
    });
  });
});

describe('the Guardrails checklist', () => {
  const proved = (minute: number, proof: string, held: boolean, guardrails: number[], role = 'factory_proofs') =>
    by(
      role,
      work('proofs', START).add(minute, 'guardrail.proved', 'factory', {
        guardrails,
        proof,
        mechanism: 'egress-policy',
        held,
        output: held ? 'held' : 'runners → 93.184.215.14: allowed\nnot held',
        commit: 'b'.repeat(40),
      }).events,
    ).map((event) => ({ ...event, work_item: null }));

  it('reads not proved until something proves it, and trusts only the proofs’ role', () => {
    expect(row([], 4)).toMatchObject({ state: 'unproved', proof: undefined });
    expect(row(proved(1, 'production-writes', true, [4], 'factory_line'), 4)?.state).toBe('unproved');
    expect(row(proved(1, 'production-writes', true, [4]), 4)).toMatchObject({
      state: 'held',
      proof: { source: { kind: 'make' } },
    });
  });

  it('keeps a failure until that same proof holds again: a later pass of another cannot hide it', () => {
    const failed = proved(1, 'egress', false, [5]);
    const { events: attack } = launched('2011', 'egress', START + 2 * MINUTE);
    const refused = by(
      'factory_redteam',
      work('2011', START + 2 * MINUTE)
        .add(1, 'action.refused', 'factory', refusal('egress-policy', [5]))
        .add(1, 'action.refused', 'factory', refusal('egress-policy', [5]))
        .add(1, 'action.refused', 'factory', refusal('egress-policy', [5])).events,
    );
    const end = finished(
      '2011',
      'egress',
      'refused',
      refused.map((e) => e.seq),
      2,
      {},
      START + 2 * MINUTE,
    );
    const all = [...failed, ...attack, ...refused, ...end];
    expect(row(all, 5, START + 10 * MINUTE)).toMatchObject({
      state: 'not-held',
      proof: { held: false, output: 'runners → 93.184.215.14: allowed', source: { kind: 'make', proof: 'egress' } },
    });
    const again = [...all, ...proved(20, 'egress', true, [5])];
    expect(row(again, 5, START + 30 * MINUTE)).toMatchObject({ state: 'held', proof: { source: { kind: 'make' } } });
  });

  it('counts an attack not refused as a failure, which only its attack refused again clears', () => {
    const { events: first } = launched('2012', 'egress');
    const notRefused = [...first, ...finished('2012', 'egress', 'not-refused', [])];
    expect(row(notRefused, 5)).toMatchObject({ state: 'not-held', proof: { source: { verdict: 'not-refused' } } });
    expect(project(notRefused, START + 5 * MINUTE).guardrails).toMatchObject({ held: 0, notHeld: 1, unproved: 10 });
    // An unfinished run after it proves nothing: the failure stands.
    const { events: second } = launched('2013', 'egress', START + 10 * MINUTE);
    expect(row([...notRefused, ...second], 5, START + 30 * MINUTE)?.state).toBe('not-held');
  });

  it('reads a guardrail whose attack is not available yet by its other proofs alone, with no Launch', () => {
    const { events } = workflow('2015');
    const proof = proved(1, 'workflow-refusal', true, [1]);
    expect(row([...proof, ...events], 1)).toMatchObject({
      state: 'held',
      proof: { source: { kind: 'make', proof: 'workflow-refusal' } },
      attack: { available: false, last: undefined },
    });
    // A launch of it still in flight, recorded before it was held back, still makes every Launch wait.
    const { events: test } = launched('2016', 'test');
    expect(project(test, START + MINUTE).guardrails.running).toMatchObject({ attack: 'test', workItem: '2016' });
  });

  it('reads the samples as the designs draw them: guardrail 5 did not hold, and attack 5 is in flight', () => {
    const { guardrails } = project(SAMPLES, END);
    expect(guardrails).toMatchObject({
      held: 10,
      notHeld: 1,
      unproved: 0,
      running: { attack: 'image', workItem: '1335' },
    });
    expect(guardrails.rows.find((r) => r.n === 5)?.proof?.source).toMatchObject({ kind: 'attack', workItem: '1333' });
    expect(
      Object.fromEntries(
        guardrails.rows.flatMap((r) => (r.attack?.last ? [[r.attack.attack, r.attack.last.verdict]] : [])),
      ),
    ).toEqual({ image: 'running', egress: 'not-refused', report: 'refused' });
    expect(guardrails.rows.filter((r) => r.attack && !r.attack.available).map((r) => r.n)).toEqual([1, 2]);
  });
});
