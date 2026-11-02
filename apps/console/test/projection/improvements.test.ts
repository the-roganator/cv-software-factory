/**
 * An improvement Martin asked for with the "+" (`improvement.requested`): queued at Plan behind the open tickets, what
 * the "+" says, retitled by its spec, its spec held for him with the passkey, and a spec written again clearing the
 * card for the old one, as the admin service refuses an answer to it; its request on the sheet and in the audit log;
 * and the preview link made from the page its spec names, on the app's own origin only.
 */
import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { previewHref } from '../../web/src/profile.ts';
import { auditRows } from '../../web/src/projection/audit.ts';
import { project } from '../../web/src/projection/index.ts';
import { foldItems } from '../../web/src/projection/items.ts';
import { needsView } from '../../web/src/projection/needs.ts';
import { projectSheet } from '../../web/src/projection/sheet.ts';
import { END, SAMPLES, work } from './support.ts';

const START = Date.parse('2026-10-03T09:00:00Z');
const WORDS = 'Show the delivery date on each product. Count only the days we dispatch on.';

/** Martin's request, as the admin service appends it: the opening and his words, together. */
function asked(number: string, minute = 0) {
  return work(number, START)
    .add(minute, 'work-item.opened', 'martin', {
      kind: 'improvement',
      title: 'Show the delivery date on each product',
      sample: true,
      category: 'improvement',
    })
    .add(minute, 'improvement.requested', 'martin', { words: WORDS, steppedUp: true });
}

const SPEC: PayloadOf<'spec.written'> = {
  title: 'Delivery dates on each product',
  outcome: 'Each product page says when an order placed today would arrive',
  criteria: [
    { given: 'a product page', when: 'it is shown', expect: 'it gives a date', withFlag: 'on' },
    { given: 'the flag is off', when: 'a product page is shown', expect: 'it is as before', withFlag: 'off' },
  ],
  scope: ['src/pages/product.ts'],
  risks: [],
  rollout: 'Behind its flag, off.',
  flag: 'delivery-dates',
  pages: ['/products/blue-mug', '/products'],
};

const HELD: PayloadOf<'hold.started'> = {
  stage: 'plan',
  kind: 'approval',
  cause: 'spec',
  reason: 'The spec of an improvement Martin asked for: it waits for his approval before any code is written',
};

/** An open ticket, waiting for the planner. */
const ticket = (number: string) =>
  work(number, START)
    .open()
    .add(1, 'ticket.opened', 'triage', {
      title: 'Prices go negative',
      category: 'functional',
      severity: 'degraded',
      fingerprint: { route: '/basket', class: 'wrong-result' },
      signals: [],
    } as unknown as PayloadOf<'ticket.opened'>);

describe('An improvement Martin asked for', () => {
  it('waits at Plan for the planner, behind every open ticket, and the "+" says how many and his latest words', () => {
    const alone = project(asked('2100').events, START + 60_000);
    const row = alone.panels.plan.rows.find((r) => r.item === '2100');
    expect(row).toMatchObject({ state: 'waiting', note: 'Asked by Martin · waiting for the planner' });
    expect(alone.cards.find((c) => c.number === '2100')?.outcome).toBe('waiting');
    expect(alone.improve).toEqual({ tickets: 0, latest: { workItem: '2100', words: WORDS, at: START } });

    // A ticket on a work item opened as an improvement is none the line's queue takes, so nothing waits ahead of it.
    const onImprovement = asked('2098').add(1, 'ticket.opened', 'triage', ticket('x').events[1]?.payload as never);
    expect(project(onImprovement.events, START + 60_000).improve.tickets).toBe(0);

    const behind = project([...ticket('2099').events, ...asked('2100', 2).events], START + 5 * 60_000);
    expect(behind.panels.plan.rows.find((r) => r.item === '2100')?.note).toBe(
      'Asked by Martin · waiting behind the open tickets',
    );
    expect(behind.improve.tickets).toBe(1);
    expect(behind.stations.find((s) => s.stage === 'plan')?.queued).toBe(2);
  });

  it('takes its spec’s title, and its spec waits for Martin with the passkey, flag and pages in its evidence', () => {
    const item = asked('2101').add(4, 'spec.written', 'planner', SPEC).add(5, 'hold.started', 'factory', HELD);
    const [state] = foldItems(item.events);
    expect(state?.title).toBe('Delivery dates on each product');
    const [need] = needsView(foldItems(item.events), START + 10 * 60_000).holds;
    expect(need).toMatchObject({
      kicker: 'An improvement’s spec',
      title: 'Delivery dates on each product',
      evidence: { kind: 'spec', flag: 'delivery-dates', pages: ['/products/blue-mug', '/products'], criteria: 2 },
    });
    expect(need?.answers.map((a) => [a.answer, a.stepUp])).toEqual([
      ['approved', true],
      ['answered', false],
      ['rejected', false],
    ]);
    expect(need?.answers[0]?.does).toBe(
      'The coder starts: tests first, with the flag on and off. Its pull request waits for you too.',
    );
  });

  it('approves another work item’s spec with no passkey, as a spec to approve', () => {
    const fix = work('2102', START)
      .open()
      .add(2, 'spec.written', 'planner', SPEC)
      .add(3, 'hold.started', 'factory', HELD);
    const [need] = needsView(foldItems(fix.events), START + 10 * 60_000).holds;
    expect(need?.kicker).toBe('A spec to approve');
    expect(need?.answers.find((a) => a.answer === 'approved')?.stepUp).toBe(false);
    expect(need?.evidence.kind).toBe('words');
  });

  it('drops the card for a spec the planner has written again, and holds the new one afresh', () => {
    const item = asked('2103')
      .add(4, 'spec.written', 'planner', SPEC)
      .add(5, 'hold.started', 'factory', HELD)
      .add(8, 'spec.written', 'planner', { ...SPEC, pages: ['/products'] });
    const at = START + 10 * 60_000;
    expect(needsView(foldItems(item.events), at).holds).toEqual([]);
    item.add(9, 'hold.started', 'factory', HELD);
    const [need] = needsView(foldItems(item.events), at).holds;
    expect(need?.hold).toBe(item.events.at(-1)?.id);
    expect(need?.evidence).toMatchObject({ kind: 'spec', pages: ['/products'] });
  });

  it('ends its wait on overlapping work when it moves on, as no look ends it, and reads only the planner’s spec', () => {
    const item = asked('2108')
      .add(4, 'spec.written', 'planner', SPEC)
      .add(5, 'wait.started', 'factory', {
        on: ['2099'],
        files: ['src/pages/product.ts'],
        reason: 'Waits for #2099, whose spec also changes src/pages/product.ts',
      })
      .add(9, 'hold.started', 'factory', HELD);
    const [state] = foldItems(item.events);
    expect(state).toMatchObject({ waitingOn: undefined, queued: false, outcome: 'needs-you' });
    // A spec no planner wrote leaves the title, and the hold, as they were.
    item.add(10, 'spec.written', 'coder', { ...SPEC, title: 'Something else' });
    const [after] = foldItems(item.events);
    expect(after).toMatchObject({ title: 'Delivery dates on each product', outcome: 'needs-you' });
    expect(after?.hold?.cause).toBe('spec');
  });

  it('shows his request on the sheet, the REQUEST chapter with his passkey, and each criterion’s side', () => {
    const item = asked('2104').add(4, 'spec.written', 'planner', SPEC).add(5, 'hold.started', 'factory', HELD);
    const sheet = projectSheet(project(item.events, START + 10 * 60_000), '2104');
    expect(sheet?.request).toEqual({ words: WORDS, steppedUp: true, at: START });
    expect(sheet?.chapters[0]).toMatchObject({ label: 'REQUEST', text: 'work-item.opened, with his passkey' });
    expect(sheet?.spec?.criteria.map((c) => c.withFlag)).toEqual(['on', 'off']);
  });

  it('puts his words in the audit log, with when he gave his passkey', () => {
    const item = asked('2105');
    const stepped = work('2105', START - 60_000).add(0, 'admin.stepped-up', 'martin', {} as never);
    const rows = auditRows([...stepped.events, ...item.events], START + 60_000, 'local');
    const row = rows.find((r) => r.what === 'improvement.requested');
    expect(row).toMatchObject({ martin: true, kind: 'admin' });
    expect(row?.detail).toMatch(new RegExp(`^“${WORDS}” · passkey given at `));
  });

  it('is in the samples: #1334’s spec waits for Martin, titled by the planner, the key on its Approve', () => {
    const view = project(SAMPLES, END);
    expect(view.cards.find((c) => c.number === '1334')).toMatchObject({
      title: 'How far the basket is from free delivery',
      outcome: 'needs-you',
    });
    const need = view.needs.holds.find((n) => n.workItem === '1334');
    expect(need?.kicker).toBe('An improvement’s spec');
    expect(need?.answers.find((a) => a.answer === 'approved')?.stepUp).toBe(true);
    expect(projectSheet(project(SAMPLES, END), '1334')?.request?.words).toMatch(/^Tell people how much more/);
  });
});

describe('Preview it', () => {
  const APP = 'http://website.localhost:8080';

  it('opens the first page the spec names, on the app’s own origin, or the front page', () => {
    expect(previewHref(APP, 'delivery-dates', '/products/blue-mug')).toBe(
      `${APP}/products/blue-mug?preview=delivery-dates`,
    );
    expect(previewHref(APP, 'delivery-dates')).toBe(`${APP}/?preview=delivery-dates`);
    for (const page of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example/',
      'products',
      '/a?b=c',
      '/a#b',
      '/ a',
    ]) {
      expect(previewHref(APP, 'delivery-dates', page), page).toBe(`${APP}/?preview=delivery-dates`);
    }
  });

  it('takes the page from the improvement’s latest spec, and the front page from one that names none', () => {
    const staged = (item: ReturnType<typeof asked>, flag: string) =>
      item.add(20, 'flag.staged', 'martin', {
        flag,
        from: { stage: 'off' },
        to: { stage: 'checks' },
        action: 'flag.to-checks',
        revision: 'r1',
        steppedUp: false,
      });
    const named = staged(asked('2106').add(4, 'spec.written', 'planner', SPEC), 'delivery-dates');
    const { pages: _, ...older } = SPEC;
    const none = staged(asked('2107').add(4, 'spec.written', 'planner', { ...older, flag: 'gift-note' }), 'gift-note');
    // A spec no planner wrote changes neither the flag's page nor whose flag it is.
    named.add(21, 'spec.written', 'coder', { ...SPEC, pages: ['/elsewhere'] });
    const view = project([...named.events, ...none.events], START + 30 * 60_000);
    expect(view.flags.flags.map((row) => [row.name, row.page])).toEqual([
      ['delivery-dates', '/products/blue-mug'],
      ['gift-note', '/'],
    ]);
  });
});
