/**
 * Upcasting: reading an older event as the current version of its type. A stored event is never rewritten; each
 * read passes it through one upcaster per version until it is current.
 *
 * Plain functions with no dependencies, so the browser can upcast an event-log file as the server upcasts the store.
 */
import type { PublicEvent } from './types.ts';
import { type EventType, VERSIONS } from './versions.ts';

/** Turns a payload at one version into the next. It also receives public views, so it must not need what they leave out. */
export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

export interface Catalogue {
  /** Each type's current version. */
  versions: Record<string, number>;
  /** For each type, the upcaster from version n to n + 1, keyed by n. */
  upcasters: Record<string, Record<number, Upcaster>>;
}

/** The guardrails a version 2 refusal shows, from its mechanism: the only ones version 2 knew. */
function guardrailsOf({ mechanism, output }: Record<string, unknown>): number[] {
  switch (mechanism) {
    case 'scope-fence':
      return [11];
    case 'egress-policy':
      return [5];
    case 'admission-control':
      return /\bimages?\b/i.test(String(output)) ? [3] : [4];
    // A token's permission and the ruleset both guard the repository (guardrail 1).
    default:
      return [1];
  }
}

export const UPCASTERS: Partial<Record<EventType, Record<number, Upcaster>>> = {
  // Version 1 recorded each call, with its cassette; version 2 records an agent's step, with how many calls it made.
  'model.called': { 1: ({ cassette: _, ...payload }) => ({ ...payload, calls: 1 }) },
  // Version 2 adds the provider's own caps beside the day's and the month's, which read as they did.
  'spend.capped': { 1: (payload) => payload },
  'spend.cleared': { 1: (payload) => payload },
  // Version 2 adds the hold's cause. A version 1 hold reads as the cause its kind and stage imply, where they imply one.
  'hold.started': {
    1: (payload) => ({
      ...payload,
      cause:
        payload.kind === 'question'
          ? 'question'
          : payload.kind === 'approval'
            ? (({ triage: 'suggestion', plan: 'spec' } as Record<string, string>)[String(payload.stage)] ?? 'merge')
            : (({ gates: 'gates', review: 'review' } as Record<string, string>)[String(payload.stage)] ?? 'unknown'),
    }),
    // Version 3 adds the coder finding nothing to fix to the causes; a version 2 hold reads as it was.
    2: (payload) => payload,
    // Version 4 adds a defect the planner noticed, with its fingerprint, and a fix beyond its ticket, to the causes; a
    // version 3 hold reads as it was.
    3: (payload) => payload,
    // Version 5 adds waiting for a deploy and for Martin's word on a verification; a version 4 hold reads as it was.
    4: (payload) => payload,
    // Version 6 adds a burst of new problems from one sense; a version 5 hold reads as it was.
    5: (payload) => payload,
    // Version 7 adds a sense's new problem held while what it reads was not healthy; a version 6 hold reads as it was.
    6: (payload) => payload,
    // Version 8 records a spend hold's spend beside its cap; a version 7 hold reads as it was, its spend unknown.
    7: (payload) => payload,
    // Version 9 adds the files a coder said it needs outside its scope, to a scope hold; a version 8 hold reads as it was.
    8: (payload) => payload,
    // Version 10 adds a canary paused for Martin, with auto-rollback off; a version 9 hold reads as it was.
    9: (payload) => payload,
  },
  // Version 2 names the hold it answers, and says when its words stay Martin's; a version 1 answer said neither.
  'hold.answered': { 1: (payload) => payload },
  // Version 2 adds Martin's reason, and the console's start names no autonomy level; a version 1 start named one, and
  // gave no reason.
  'line.started': { 1: (payload) => payload },
  // Version 2 marks the abort that came with Stop the line; a version 1 control was always the Canary panel's.
  'release.controlled': { 1: (payload) => payload },
  // Version 2 adds auto-rollback to the controls; until it had a switch, it was always on.
  'controls.changed': { 1: (payload) => ({ ...payload, autoRollback: true }) },
  // Version 2 of a release's events names the release, says whether the line watched it and whether the dry run
  // answers for it, and records the analysis's own measures. A version 1 release was told apart by its version, was
  // watched, and shipped.
  'release.started': {
    1: ({ digest, signed, admitted, ...payload }) => ({
      ...payload,
      release: payload.version,
      image: { digest, signed, admitted },
      watched: true,
      dryRun: false,
    }),
    // Version 3 records the canary's steps, as the line read them from the Rollout. A version 2 release never said.
    2: (payload) => ({ ...payload, steps: null }),
  },
  // A version 1 step recorded each version's figures and no measures: the steps it recorded had passed.
  'canary.stepped': {
    1: ({ analysis, ...payload }) => {
      const { errorRate, p99Ms, journeys } = analysis as Record<string, Record<'canary' | 'baseline', unknown>>;
      const of = (version: 'canary' | 'baseline') => ({
        requests: null,
        errorRate: errorRate?.[version] ?? null,
        p99Ms: p99Ms?.[version] ?? null,
        journeys: journeys?.[version] ?? null,
      });
      return {
        ...payload,
        release: payload.version,
        analysis: { phase: 'successful', requests: null, measures: [] },
        figures: { canary: of('canary'), baseline: of('baseline') },
        dryRun: false,
      };
    },
  },
  // Version 2 adds the looks at an open ticket, as the line takes it and beside another's verified fix, and the
  // version its signal was last seen on, and the merged pull requests of the work items carried; a version 1 look
  // reads as it was, its `carried` the release looked at's alone.
  'signal.rechecked': { 1: (payload) => payload },
  'release.promoted': { 1: (payload) => ({ ...payload, release: payload.version, watched: true, dryRun: false }) },
  // A version 1 rollback recorded one failed measure, by its label, with its series and the reason as its words.
  'release.rolled-back': {
    1: ({ analysis, ...payload }) => {
      const { metric, unit, stepSeconds, canary, baseline, at } = analysis as Record<string, unknown>;
      const slug = String(metric)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      // A name starts with a letter; a label that gives none is named for what it is.
      const name = /^[a-z]/.test(slug) ? slug : 'metric';
      return {
        ...payload,
        release: payload.version,
        failed: [
          {
            name,
            phase: 'failed',
            value: null,
            limit: null,
            message: payload.reason,
            series: { label: metric, unit, stepSeconds, canary, baseline, at },
          },
        ],
        dryRun: false,
      };
    },
    // Version 3 adds how many of each failed measure's looks failed; a version 2 rollback never counted them.
    2: (payload) => payload,
    // Version 4 says who rolled it back; until auto-rollback could be switched off, the analysis always did.
    3: (payload) => ({ ...payload, by: 'analysis' }),
  },
  // Version 2 adds the sense and the version verified, and whether the dry run answers for it; a version 1
  // verification was a sense's, though it never said which.
  // Version 3 adds the canary to the senses, and its analysis to the evidence; a version 2 verification reads as it was.
  // Version 4 adds the other work item whose own page a page is; a version 3 verification never said.
  'verification.finished': {
    1: (payload) => ({ ...payload, dryRun: false }),
    2: (payload) => payload,
    3: (payload) => payload,
  },
  // Version 2 adds the planner's findings to the kinds of work item; a version 1 work item reads as it was.
  'work-item.opened': { 1: (payload) => payload },
  // Version 2 adds an improvement closed as its flag was turned off; a version 1 close reads as it was.
  'work-item.closed': { 1: (payload) => payload },
  // Version 2 adds the planner to the sources of a signal; a version 1 signal reads as it was.
  // Version 3 adds the canary to the senses, and its analysis to the evidence; a version 2 signal reads as it was.
  // Version 4 adds how what the sense reads stood, as triage looked; a version 3 signal never said.
  'signal.received': { 1: (payload) => payload, 2: (payload) => payload, 3: (payload) => payload },
  // Version 2 lets the canary reopen a ticket as any sense may; a version 1 reopening reads as it was.
  // Version 3 adds the line's reopening of a ticket a dry run verified; a version 2 reopening was a sense's.
  'work-item.reopened': { 1: (payload) => payload, 2: (payload) => ({ ...payload, dryRun: false }) },
  // Version 2 adds where each criterion comes from. A version 1 spec never said, so its criteria read without it.
  // Version 3 adds the words each criterion quotes from there; a version 2 spec quoted none.
  // Version 4 adds an improvement's title, pages and each criterion's side of its flag; a version 3 spec named none, and
  // its flag, if it named one, reads as it was.
  'spec.written': { 1: (payload) => payload, 2: (payload) => payload, 3: (payload) => payload },
  // Version 2 adds the pull request's whole change. A version 1 push recorded only its own files, which are the whole
  // change for a first push, and the nearest the event has for a later one.
  // Version 3 marks a path in the whole change cut to what an event records; a version 2 push cut none.
  'pull-request.pushed': { 1: (payload) => ({ ...payload, whole: payload.files }), 2: (payload) => payload },
  // Version 2 adds the round the return starts and what sent it back as figures; a version 1 return reads as it was.
  // Version 3 adds the suggestions an approving review sends back; a version 2 return sent none.
  'work.returned': { 1: (payload) => payload, 2: (payload) => payload },
  // Version 2 adds the line's scope fence to the mechanisms; a version 1 refusal reads as it was.
  // Version 3 adds the guardrails a refusal shows, which a version 2 refusal never named: it reads as showing the one
  // `policy/refusals.ts` gives its mechanism. Admission control shows guardrail 3 for an image and 4 for anything
  // else, and a version 2 refusal said which only in its output, so one that names an image reads as 3.
  'action.refused': {
    1: (payload) => payload,
    2: (payload) => ({ ...payload, guardrails: guardrailsOf(payload) }),
  },
  // Version 1 counted a review's comments; version 2 carries each finding. What a version 1 comment said was never
  // recorded, so a version 1 review reads as one with no findings.
  // Version 3 lets a finding cite the ticket; a version 2 review cited none.
  // Version 4 lets a finding name the one of the review before that it holds again; a version 3 review named none.
  'review.submitted': {
    1: ({ comments: _, ...payload }) => ({ ...payload, findings: [] }),
    2: (payload) => payload,
    3: (payload) => payload,
  },
  // Version 2 of Verify's judgements of a flag names the move each judged (`moveRevision`). A version 1 comparison, or
  // check at Checks or Preview, never said, so it reads as judging no move (`none`, no write's revision), and counts
  // for none: the move is judged afresh. A version 1 baseline, at Off, judges no move, and reads as it was.
  'flag.compared': { 1: (payload) => ({ ...payload, moveRevision: 'none' }) },
  // Version 3 pictures each page in both colour schemes, and names each picture's: a version 2 check took the
  // browser's default, light, so each of its pages reads as light.
  'flag.checked': {
    1: (payload) => (payload.stage === 'off' ? payload : { ...payload, moveRevision: 'none' }),
    2: (payload) =>
      Array.isArray(payload.pages)
        ? { ...payload, pages: payload.pages.map((page: Record<string, unknown>) => ({ ...page, scheme: 'light' })) }
        : payload,
  },
};

export const CATALOGUE: Catalogue = { versions: VERSIONS, upcasters: UPCASTERS };

/** An event as it might arrive from a store or a file written by another version of the factory. */
export interface RawEvent {
  type: string;
  version: number;
  payload: unknown;
  /** The store's order, once it has one. */
  seq?: number;
}

export type Upcast =
  | { ok: true; event: PublicEvent }
  /** Written by a newer factory than this one: a type it doesn't know, or a version beyond the current one. */
  | { ok: false; reason: 'unknown-type' | 'newer-version'; type: string; version: number };

export function upcast(event: RawEvent, catalogue: Catalogue = CATALOGUE): Upcast {
  const { type, version } = event;
  const current = Object.hasOwn(catalogue.versions, type) ? catalogue.versions[type] : undefined;
  if (current === undefined) return { ok: false, reason: 'unknown-type', type, version };
  if (version > current) return { ok: false, reason: 'newer-version', type, version };
  let payload = event.payload as Record<string, unknown>;
  for (let from = version; from < current; from++) {
    const step = catalogue.upcasters[type]?.[from];
    if (!step) throw new Error(`No upcaster for ${type} from version ${from} to ${from + 1}`);
    payload = step(payload);
  }
  return { ok: true, event: { ...event, version: current, payload } as unknown as PublicEvent };
}
