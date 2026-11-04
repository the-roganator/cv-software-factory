/**
 * The samples: twenty-eight hand-written work items over eight days, with work still on the line at the end, and the
 * line's own events beside them. They cover every kind of work item but a planner's finding and a red-team attack,
 * every outcome but a close with no change and an attack's, every picture the design system draws and every station
 * state. Seven are fixes as milestone 5's line makes them: rounds of review, a wait for Martin's merge, the four ways a
 * mechanism holds a fix, and a run on the local model. The rest of the last week ships as milestone 6's line does:
 * waits for Martin's deploy, releases step by step (one carrying two work items, some carrying none), a rollback with
 * no series and the ticket it opened, a fix that persisted and went round again, a reopened ticket, a dry run, the line
 * stopped with a canary in flight, and a canary in flight at the end, the line at Guarded and taking the next five, a
 * spec waiting for work in flight on the same page, an improvement out to everyone a stage at a time behind its flag,
 * another part way out, a third turned off at Checks and closed and a fourth whose spec waits for Martin, and a
 * visitor's suggestion Martin answered in words, which keep it held. A visitor's report that gave the factory orders is
 * quarantined by triage. The mechanisms refuse things over the week: the gateway a work item's calls at its cap,
 * admission control an unsigned image and a write to the app's Rollout, and the GitHub worker the line's comment on an
 * issue it did not open, a deploy it does not own and a merge the review check held, each relayed with its signed
 * record, one of them changed after it was signed. No red-team attack: none can be launched yet (`policy/attacks.ts`), and the console's browser
 * tests bring their own (`apps/console/test/attacks`). And a run of `make guardrails` on the last morning, whose egress
 * proof did not hold. The scoreboard counts them against an invented key. Nothing in them happened: the console labels
 * each as a sample.
 */
import type { NewEvent } from '@software-factory/events';
import { CITED, uuidFor } from './build.ts';
import pino from './items/1262-pino.ts';
import searchLogs from './items/1265-search-logs.ts';
import readsOnThursday from './items/1268-reads-on-thursday.ts';
import theLastOne from './items/1271-the-last-one.ts';
import otelRollback from './items/1276-otel-rollback.ts';
import nodeSecurity from './items/1282-node-security.ts';
import homePageSpeed from './items/1288-home-page-speed.ts';
import instructionReport from './items/1291-instruction-report.ts';
import deliveryDates from './items/1294-delivery-dates.ts';
import pricesGoNegative from './items/1296-prices-go-negative.ts';
import giftNote from './items/1299-gift-note.ts';
import sortByPrice from './items/1300-sort-by-price.ts';
import longWords from './items/1302-long-words.ts';
import apostrophe from './items/1304-apostrophe.ts';
import basketErrors from './items/1306-basket-errors.ts';
import canaryLatency from './items/1308-canary-latency.ts';
import sortByName from './items/1310-sort-by-name.ts';
import quantities from './items/1311-quantities.ts';
import contactMessage from './items/1314-contact-message.ts';
import stockCount from './items/1315-stock-count.ts';
import deliveryDays from './items/1317-delivery-dates.ts';
import wishlist from './items/1319-wishlist.ts';
import pino105 from './items/1321-pino.ts';
import discountCodes from './items/1323-discount-codes.ts';
import repeatedResult from './items/1325-repeated-result.ts';
import searchPages from './items/1327-search-pages.ts';
import searchByColour from './items/1329-search-by-colour.ts';
import freeDelivery from './items/1334-free-delivery.ts';
import releases from './items/line.ts';
import { PROOFS } from './proofs.ts';
import lineRefusals from './refusals.ts';
import { scoreEvents } from './score.ts';

export const ITEMS = [
  pino,
  searchLogs,
  readsOnThursday,
  theLastOne,
  otelRollback,
  nodeSecurity,
  homePageSpeed,
  instructionReport,
  deliveryDates,
  pricesGoNegative,
  giftNote,
  sortByPrice,
  longWords,
  apostrophe,
  basketErrors,
  canaryLatency,
  sortByName,
  quantities,
  contactMessage,
  stockCount,
  deliveryDays,
  wishlist,
  pino105,
  discountCodes,
  repeatedResult,
  searchPages,
  searchByColour,
  freeDelivery,
];

/** The line, running from before the first sample. */
export const LINE_STARTED: NewEvent<'line.started'> = {
  id: uuidFor('line/started'),
  ts: '2026-09-29T07:00:00.000Z',
  work_item: null,
  type: 'line.started',
  version: 2,
  actor: 'martin',
  summary: 'Martin started the line',
  payload: {},
  artifacts: [],
};

/** A change of the line's controls by Martin, as the admin service appends it. */
const controlsChanged = (
  ts: string,
  summary: string,
  payload: NewEvent<'controls.changed'>['payload'],
): NewEvent<'controls.changed'> => ({
  id: uuidFor(`line/controls/${ts}`),
  ts,
  work_item: null,
  type: 'controls.changed',
  version: 2,
  actor: 'martin',
  summary,
  payload,
  artifacts: [],
});

/** At Guarded from the start, as the controls record it, and, on the last day, taking the next five. */
const CONTROLS: NewEvent<'controls.changed'>[] = [
  controlsChanged('2026-09-29T07:00:30.000Z', 'Martin loosened autonomy from Supervised to Guarded', {
    autonomy: 'guarded',
    newWork: true,
    autoMerge: false,
    take: null,
    autoRollback: true,
    change: { control: 'autonomy', before: 'supervised', after: 'guarded' },
  }),
  controlsChanged('2026-10-06T12:00:00.000Z', 'Martin widened what the line takes to the next 5 from now', {
    autonomy: 'guarded',
    newWork: true,
    autoMerge: false,
    take: { kind: 'next-few', count: 5, since: '2026-10-06T12:00:00.000Z' },
    autoRollback: true,
    change: { control: 'take', before: null, after: { kind: 'next-few', count: 5, since: '2026-10-06T12:00:00.000Z' } },
  }),
];

/**
 * Martin giving his passkey again, as the admin service records it, moments before each widening of a flag past Checks:
 * the audit log says the widening had it.
 */
const STEPPED_UP: NewEvent<'admin.stepped-up'>[] = [
  '2026-10-01T10:14:40.000Z',
  '2026-10-01T11:34:40.000Z',
  '2026-10-01T14:04:40.000Z',
  '2026-10-03T12:19:40.000Z',
].map((ts) => ({
  id: uuidFor(`martin/stepped-up/${ts}`),
  ts,
  work_item: null,
  type: 'admin.stepped-up',
  version: 1,
  actor: 'martin',
  summary: 'Martin gave his passkey again',
  payload: {},
  artifacts: [],
}));

/** Every sample event in the order it happened. Events at the same moment keep the order they were written in. */
export function sampleEvents(): NewEvent[] {
  const events = inOrder([
    LINE_STARTED,
    ...CONTROLS,
    ...STEPPED_UP,
    ...PROOFS,
    ...releases.events,
    ...lineRefusals.events,
    ...ITEMS.flatMap((item) => item.events),
  ]);
  return cited(inOrder([...events, ...scoreEvents(events)]));
}

/** Each attack's end citing its refusals by the seqs the event log gives them: their places in order, from 1. */
export function cited(events: NewEvent[]): NewEvent[] {
  const seq = new Map(events.map((event, i) => [event.id, i + 1]));
  return events.map((event) => {
    const cites = CITED.get(event.id);
    if (event.type !== 'attack.finished' || !cites) return event;
    const refusals = cites.map((id) => {
      const at = seq.get(id);
      if (at === undefined) throw new Error(`An attack's end cites ${id}, which is no sample`);
      return at;
    });
    return { ...event, payload: { ...event.payload, refusals } };
  });
}

export const inOrder = (events: readonly NewEvent[]) =>
  events
    .map((event, order) => ({ event, order }))
    .sort((a, b) => Date.parse(a.event.ts) - Date.parse(b.event.ts) || a.order - b.order)
    .map(({ event }) => event);
