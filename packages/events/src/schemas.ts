/**
 * The shape of every event, checked with Zod when it is appended. An event that fails is refused, with the reason.
 *
 * Node only: the browser imports types from here, never values, so Zod stays out of the console's bundle.
 */
import { z } from 'zod';
import { PAGE_PATH, PATH_CHARS } from './line.ts';
import { REQUEST_WORDS } from './request.ts';
import { type EventType, LINE_TYPES, RELEASE_TYPES, VERSIONS } from './versions.ts';
import * as V from './vocabulary.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const count = z.number().int().nonnegative();
const probability = z.number().min(0).max(1);
const usd = z.number().nonnegative().max(1000);
const slug = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256, in lower-case hex');
const commit = z.string().regex(/^[0-9a-f]{40}$/, 'a full commit SHA');
const traceId = z.string().regex(/^[0-9a-f]{32}$/, 'a W3C trace id');
const timestamp = z.iso.datetime({ offset: true });
const route = z
  .string()
  .regex(/^\/[^\s]*$/, 'a path, such as /products/:slug')
  .max(200);
/** A page of the app, by its path alone (`PAGE_PATH`). */
const page = z.string().regex(PAGE_PATH, 'a page of the app, by its path, such as /products/blue-mug').max(200);
/** A route, or `*` for a symptom found on every page the senses checked. */
const routeOrEvery = z.union([route, z.literal('*')]);
/** A work item's number, as the store gives it. */
const workItem = z.string().regex(/^[1-9]\d{0,8}$/, 'a work item number, such as 1288');
/** The app's version, as `/version` reports it: a release such as v0.9.3, or a commit. */
const appVersion = z.string().regex(/^(v\d+\.\d+\.\d+|[0-9a-f]{7,40})$/, 'a version such as v0.9.3, or a commit');
const pullRequest = z.number().int().positive();
const stage = z.enum(V.STAGES);
const severities = z.strictObject({ critical: count, high: count, medium: count, low: count });

/**
 * What the line takes: every ticket; the next few, counted from when Martin chose it (`since`); or just one work item.
 * Its bounds are policy's (`policy/line.ts`), checked where it is read.
 */
const take = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('every') }),
  z.strictObject({ kind: z.literal('next-few'), count: z.number().int().positive().max(1000), since: timestamp }),
  z.strictObject({ kind: z.literal('just-one'), workItem }),
]);

/**
 * A feature flag's name, as the app names them and `policy/flags.ts` renders them: lower-case letters and digits, in
 * words joined by hyphens. Never the flag set's revision, which is no feature.
 */
const flagName = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'a flag name, such as delivery-dates')
  .refine((name) => name !== 'flag-set-revision', "the flag set's revision is no feature flag");
const flagShare = z.literal(V.FLAG_SHARES);
/** A colour scheme the browser says it prefers, as Verify pictures a flag's pages in each. */
const colorScheme = z.enum(V.COLOR_SCHEMES);
/** A flag's stage: the share stage with its share, any other alone (`policy/flags.ts`). */
const flagStage = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.enum(['off', 'checks', 'preview', 'everyone']) }),
  z.strictObject({ stage: z.literal('share'), share: flagShare }),
]);
/** One side of a flag at the share stage, from the traffic generator's own figures: none when it had no requests. */
const flagSide = z.strictObject({
  requests: count,
  errorRate: probability.nullable(),
  p99Ms: count.nullable(),
});

/** The flag set's revision as the app reported it (`x-flags-revision`): `none` when it held no flag set. */
const flagRevision = z.string().regex(/^[!-~]{1,128}$/, "the flag set's revision, as the app reports it");
/** How many of the journeys' checks ran in a run, and how many of those passed cleanly. */
const journeysCount = z
  .strictObject({ passed: count, ran: count })
  .refine((c) => c.passed <= c.ran, { message: 'no more passed than ran', path: ['passed'] });
/** One of the journeys' checks, as a flag's check names it: one that did not pass cleanly, or that regressed. */
const journeyCheck = z.strictObject({
  sense: z.enum(['probe', 'crawler']),
  check: text(120),
  route: routeOrEvery,
  /** Whether it failed, rather than could not tell. */
  failed: z.boolean(),
  /** What it saw, or why it could not tell, in its own words. */
  message: text(300).optional(),
});
/**
 * The revision of the flag set that Martin's move of this flag wrote (`flag.staged`'s), which a judgement judges: it
 * counts only while that move is his latest of the flag, and each write's revision is its own, so a judgement started
 * for an earlier move never counts for a later one. `none`, which no write's revision is, names no move.
 */
const moveRevision = z.string().regex(/^[!-~]{1,128}$/, "the revision Martin's move of the flag wrote");

/** What a flag's check at Checks or Preview judged its journeys on, against the run with the flag off. */
const flagJourneys = {
  moveRevision,
  /** The run with the flag off it was compared with: its version, or none when there was no such run. */
  against: appVersion.nullable(),
  outcome: z.enum(V.FLAG_CHECKS),
  /** The checks of the run with the flag off, and of this one. */
  journeys: z.strictObject({ base: journeysCount.nullable(), change: journeysCount }),
  /** Each check that passed cleanly with the flag off and failed, or could not finish, twice with it on. */
  regressions: z.array(journeyCheck).max(8),
  /** How many more regressed than are named. */
  more: count.optional(),
  /** Why it failed, or could not tell, in words. */
  reason: text(300).optional(),
};

/** Where on a page something is, in CSS pixels from the top left of the screenshot. */
const rect = {
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
};

/** Where on a screenshot the probe looked: a problem it found, or the thing as it should be. */
const box = z.strictObject({ ...rect, kind: z.enum(['problem', 'fix']), label: text(48).optional() });

/** An artifact is named by the SHA-256 of its contents. The console serves it with the type recorded here. */
export const artifactRef = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('screenshot'),
    hash: sha256,
    type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    size: count,
    route,
    version: appVersion,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    boxes: z.array(box).max(4),
  }),
  z.strictObject({
    kind: z.literal('file'),
    hash: sha256,
    type: z.enum(V.ARTIFACT_TYPES),
    size: count,
    name: text(120),
  }),
]);

/**
 * A release, as its events name it: in the cluster, `<hash>-<revision>`, the pod-template hash Argo Rollouts gives the
 * canary, which the telemetry and the analysis tell the versions apart by, and the Rollout's revision, so a later
 * release of the same image is a release of its own. One recorded before the revision is its hash alone. A dry run's
 * release names itself.
 */
const releaseId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{0,62}$/, 'a release, such as the canary’s pod-template hash and revision');
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'an image digest');
/** What Martin called a passkey as he made it ("iPhone"), so the settings can list it. */
const passkeyName = text(40);
/** A pinned model: `claude-sonnet-5-5`, or a local one such as `qwen/qwen3.8-27b`. */
const model = z.string().regex(/^[a-z0-9][a-z0-9./_-]{0,79}$/);
/** An agent's model as Martin chose it, at an effort for Claude; a local model takes none. */
const agentSetting = z.strictObject({ model, effort: z.enum(V.EFFORTS).optional() });

/**
 * One step of a canary as its Rollout plans it: a weight the canary holds, how long it pauses there, and whether a step
 * analysis judges it before it goes on. Argo Rollouts lists `setWeight`, `pause` and `analysis` as steps of their own;
 * a step here is a `setWeight` with the pauses and analysis that follow it, before the next. After the last, the canary
 * takes all of the traffic.
 */
const canaryStep = z.strictObject({
  /** The share of traffic it sends the canary, in percent, as a `canary.stepped` at that step has it. */
  weight: z.number().int().min(1).max(100),
  /** How long it pauses at that weight in all, in seconds. Null when it waits there for someone to promote it. */
  pauseSeconds: count.nullable(),
  /** Whether a step analysis judges the canary at that weight, which a `canary.stepped` records when it ends. */
  analysis: z.boolean(),
});

/** How far an analysis, or one of its measures, has got, in Argo Rollouts' words. */
const analysisPhase = z.enum(['pending', 'running', 'successful', 'failed', 'error', 'inconclusive']);

/** One measure of the canary's analysis, as the analysis reported it (policy/release.ts names them). */
const measure = z.strictObject({
  /** As the analysis names it: `enough-requests`, `errors`, `latency` or `journeys`. */
  name: slug,
  phase: analysisPhase,
  /**
   * Its latest measurement, in the analysis's own terms. Null when it has none that JSON can hold: the journeys report
   * no number, and a version with nothing to compare measures as infinitely worse.
   */
  value: z.number().nullable(),
  /** What the value is held to: the most it may be, or for `enough-requests` the least. Null for no threshold. */
  limit: z.number().nullable(),
  /** The analysis's own words about it, when it has any: why it failed, or could not measure. */
  message: text(300).optional(),
});

/** A measure on the canary and the baseline over the release, as the analysis compared them. */
const series = z.strictObject({
  /** What the values are, in words, such as `p99 latency`. */
  label: text(60),
  unit: text(16),
  /** When the first value was taken. A version 1 rollback did not record it. */
  start: timestamp.optional(),
  stepSeconds: z.number().int().positive(),
  canary: z.array(z.number().nullable()).min(2).max(500),
  baseline: z.array(z.number().nullable()).min(2).max(500),
  /** Where in the series the analysis failed the canary. */
  at: count,
});

/**
 * Evidence small enough to keep in the event itself: a metric series; log lines and the trace they link to; an HTTP
 * exchange; what a browser's console said; what an accessibility check found; or a canary's analysis.
 */
export const evidence = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('metric'),
    name: text(80),
    unit: text(16),
    objective: z.number().optional(),
    start: timestamp,
    stepSeconds: z.number().int().positive(),
    values: z.array(z.number().nullable()).min(2).max(500),
    marker: z.strictObject({ index: count, label: text(48) }).optional(),
  }),
  z.strictObject({
    kind: z.literal('logs'),
    route,
    version: appVersion,
    /** How many requests the lines cover, so that none at all says something. */
    requests: count,
    lines: z
      .array(
        z.strictObject({
          ts: timestamp,
          level: z.enum(['debug', 'info', 'warn', 'error']),
          message: text(300),
          traceId: traceId.nullable(),
        }),
      )
      // None at all is evidence too: a route that leaves no log record.
      .max(20),
    trace: z
      .strictObject({
        id: traceId,
        spans: z
          .array(z.strictObject({ name: text(80), offsetMs: count, durationMs: count, note: text(48).optional() }))
          .max(20),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('http'),
    method: z.enum(['GET', 'HEAD', 'POST']),
    /** The path asked for, with any query the sense chose. Never a visitor's: senses make their own requests. */
    url: z
      .string()
      .regex(/^\/[^\s]*$/, 'a path, such as /products?page=2')
      .max(300),
    /** Null when no response came. */
    status: z.number().int().min(100).max(599).nullable(),
    /** The headers the check looked at, by lower-case name, each null when absent. */
    headers: z.record(z.string().regex(/^[a-z0-9-]+$/), z.string().max(300).nullable()),
    timings: z.strictObject({ firstByteMs: count, totalMs: count }),
    /** Each redirect followed on the way, in order. */
    redirects: z.array(z.strictObject({ status: z.number().int().min(300).max(399), location: text(300) })).max(20),
  }),
  z.strictObject({
    kind: z.literal('console'),
    route,
    version: appVersion,
    messages: z
      .array(z.strictObject({ level: z.enum(['error', 'warning']), text: text(300), source: text(300).optional() }))
      .min(1)
      .max(20),
  }),
  z.strictObject({
    kind: z.literal('accessibility'),
    route,
    version: appVersion,
    findings: z
      .array(
        z.strictObject({
          /** axe's rule, such as `image-alt`. */
          rule: slug,
          impact: z.enum(['minor', 'moderate', 'serious', 'critical']),
          help: text(200),
          /** The elements concerned, and where they are on the signal's screenshot when they are in view. */
          elements: z
            .array(z.strictObject({ selector: text(300), box: z.strictObject(rect).optional() }))
            .min(1)
            .max(10),
        }),
      )
      .min(1)
      .max(20),
  }),
  /**
   * A measure of a canary's analysis, against its baseline: what the analysis said of it, the series it compared, the
   * routes where the canary did worse, worst first, and for the journeys, the checks that passed on the baseline and
   * failed on the canary.
   */
  z.strictObject({
    kind: z.literal('canary'),
    release: releaseId,
    /** The canary's version, and its baseline's: the version it would have replaced. */
    version: appVersion,
    against: appVersion,
    measure,
    series: series.optional(),
    /** The routes where the canary did worse, worst first, each with its figure on both versions. */
    routes: z
      .strictObject({
        unit: text(16),
        worse: z
          .array(z.strictObject({ route, canary: z.number(), baseline: z.number() }))
          .min(1)
          .max(10),
      })
      .optional(),
    /** The journeys' checks that passed on the baseline and failed on the canary, as the comparison said. */
    checks: z
      .array(
        z.strictObject({
          sense: z.enum(['probe', 'crawler']),
          check: text(80),
          route: routeOrEvery,
          symptom: z.enum(V.SYMPTOM_CLASSES).optional(),
          message: text(300).optional(),
        }),
      )
      .min(1)
      .max(8)
      .optional(),
  }),
]);

/** One answer from Jev (TYPESAFE.md): a label, a level on a rubric, or the probability of yes. Never free text. */
const answer = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choice'),
    key: slug,
    question: text(300),
    answer: slug,
    probabilities: z.record(slug, probability),
  }),
  z.strictObject({
    type: z.literal('score'),
    key: slug,
    question: text(300),
    levels: z.array(text(40)).min(2).max(10),
    probabilities: z.array(probability).min(2).max(10),
    expected: z.number().nonnegative(),
  }),
  z.strictObject({ type: z.literal('noul'), key: slug, question: text(300), probability }),
]);

/**
 * What a visitor sent through the widget. Untrusted: its text never reaches a public view or a generative agent.
 * The text is absent from an event read back from a public record, such as an event-log file.
 */
const report = z.strictObject({ page: route, text: z.string().min(1).max(2000).optional() });

/** An open ticket offered to triage as one a report might repeat: described from its typed fields, never a report. */
const candidate = z.strictObject({
  /** The label the question gives it. */
  key: slug,
  workItem,
  title: text(120),
  category: z.enum(V.DEFECT_CATEGORIES),
  symptom: z.enum(V.SYMPTOM_CLASSES).optional(),
});

/** A passage of a page's text, as the factory read the page itself, offered as the one a content report is about. */
const passage = z.strictObject({ key: slug, text: text(200) });

/**
 * What identifies a defect from outside: a route and a symptom class, or, for content, the page and the passage of its
 * text that is wrong, as the factory read it.
 */
const fingerprint = z.union([
  z.strictObject({ route: routeOrEvery, class: z.enum(V.SYMPTOM_CLASSES) }),
  z.strictObject({ page: route, text: text(200) }),
]);

/** A canary against its baseline, on the same measure. */
const versus = <T extends z.ZodType>(value: T) => z.strictObject({ canary: value, baseline: value });

/** One version's figures over a step, each null when there was nothing to measure. */
const figures = z.strictObject({
  requests: count.nullable(),
  errorRate: probability.nullable(),
  p99Ms: count.nullable(),
  /** The journeys' checks that passed, of how many ran. */
  journeys: z.tuple([count, count]).nullable(),
});

/** The payload of each event type, at its current version. */
export const PAYLOADS = {
  'work-item.opened': z.strictObject({
    kind: z.enum(V.KINDS),
    title: text(120),
    /** Written by hand to show the console, not done by the factory. A store holds samples or real events, never both. */
    sample: z.boolean(),
    category: z.enum(V.CATEGORIES).optional(),
    /** The visitor whose key started it. Their key is a credential, so no public view carries it. */
    visitor: z.strictObject({ key: z.string().regex(/^[a-z]+-[a-z]+$/) }).optional(),
    dependency: z
      .strictObject({
        name: text(120),
        ecosystem: z.enum(['npm', 'docker']),
        from: text(40),
        to: text(40),
        security: z.boolean(),
      })
      .optional(),
  }),
  'work-item.summarised': z.strictObject({
    title: text(120),
    /** Two lines on a card. */
    description: text(260),
    /** A paragraph at the top of the sheet. */
    story: text(1200),
  }),
  'work-item.closed': z.strictObject({
    /**
     * How it ended. Triage ends a report it quarantines or discards; anything else ends after the line. An improvement
     * whose flag Martin turned off, at any stage, closes as turned off, with his reason: its code stays in the app, off,
     * and nothing is rolled back. One whose flag he widened to Everyone closes as verified, and its flag stays his.
     */
    outcome: z.enum(['verified', 'rolled-back', 'no-change', 'quarantined', 'discarded', 'turned-off']),
    reason: text(200),
  }),
  /**
   * A ticket closed as verified came back: a sense's signal on the same fingerprint, so the same defect, regressed.
   * The ticket and its work item open again, and the work goes back to Plan for a fresh pass. What came back is the
   * signal's: the sense, its check, the route and the version it was seen on. The signal's own event follows, with its
   * evidence.
   *
   * Or, with `dryRun`, the line running live reopened a ticket a dry run verified, whose fix never shipped: nothing came
   * back, as the defect never left. Then it names the ticket's first signal, whatever its source, and the version the
   * dry run's fix would have replaced.
   */
  'work-item.reopened': z
    .strictObject({
      sense: z.enum(V.SIGNAL_SOURCES),
      check: text(80),
      route: routeOrEvery,
      version: appVersion,
      reason: text(200),
      dryRun: z.boolean(),
    })
    .refine((r) => r.dryRun || (r.sense !== 'report' && r.sense !== 'planner'), {
      message: 'only a sense’s signal reopens a ticket, unless the reopening undoes a dry run’s verification',
      path: ['sense'],
    }),

  'defect.injected': z.strictObject({ choice: text(80), version: appVersion, pullRequest }),
  'attack.launched': z.strictObject({ attack: text(120), expected: text(120) }),

  /**
   * What a sense found, what a visitor reported, or what the planner noticed outside its ticket. A sense's signal
   * names the symptom class it saw; a report's, or a planner's finding, is for triage to judge, and its words are in
   * `report`, which no public view and no generative agent ever reads. On an open ticket, the first signal from each
   * sense in each version of the app adds its evidence.
   */
  'signal.received': z.strictObject({
    sense: z.enum(V.SIGNAL_SOURCES),
    check: text(80),
    route: routeOrEvery,
    version: appVersion,
    symptom: z.enum(V.SYMPTOM_CLASSES).optional(),
    report: report.optional(),
    evidence: z.array(evidence).max(8).optional(),
    /** For a planner's finding: the work item whose ticket it was planning, which the finding is not about. */
    planning: workItem.optional(),
    /**
     * For a sense's signal: how what the sense reads besides the app stood when it saw this, as triage looked, at a
     * time within a minute of it. Each dependency is healthy, not, or null when triage could not tell, with what it
     * saw. Triage writes it, never the sense; a signal triage took with nothing to look at has none.
     */
    environment: z
      .strictObject({
        at: timestamp,
        dependencies: z
          .array(z.strictObject({ name: z.enum(V.DEPENDENCIES), healthy: z.boolean().nullable(), saw: text(160) }))
          .min(1)
          .max(V.DEPENDENCIES.length),
      })
      .optional(),
  }),
  /**
   * One request to Jev about a report: what it was asked and answered. The request that routes the report records
   * where it went; one that only chooses a content report's passage from its page has no route.
   */
  'judgement.made': z
    .strictObject({
      questionSet: z.string().regex(/^[a-z-]+\/v\d+$/),
      model: z.string().regex(/^jev-\d+\.\d+\.\d+$/),
      state: z.strictObject({
        report,
        /** The open tickets on the same page it was offered, besides "none of these". */
        candidates: z.array(candidate).max(10).optional(),
        passages: z.array(passage).max(40).optional(),
      }),
      answers: z.array(answer).min(1).max(20),
      route: z.enum(V.TRIAGE_ROUTES).optional(),
      /** The open ticket a repeat joined. */
      joined: workItem.optional(),
      costUsd: usd,
      durationMs: count,
      cassette: sha256,
    })
    .refine((j) => (j.route === 'repeat') === (j.joined !== undefined), 'a repeat names the ticket it joined'),
  'ticket.opened': z.strictObject({
    title: text(120),
    category: z.enum(V.DEFECT_CATEGORIES),
    severity: z.enum(V.SEVERITIES),
    fingerprint,
    traces: z.array(traceId).max(10),
  }),

  /**
   * The planner's spec. An improvement's names its title, which replaces the one made from Martin's words, the flag its
   * change goes behind, the pages it changes, which Verify pictures with the flag off and on, and on each criterion
   * the side of the flag it holds on. A version 3 spec named none of them.
   */
  'spec.written': z.strictObject({
    title: text(120).optional(),
    outcome: text(200),
    /**
     * Given, when, then. `expect` holds the then, because an object with a `then` looks like a promise. `from` names
     * what in the ticket's evidence asks for it: a line of the ticket, or a signal. `quote` gives the words there that
     * ask for it, which the line found in what `from` names before it took the spec. A version 1 spec said neither,
     * and a version 2 spec only `from`. `withFlag` is the side of an improvement's flag the criterion holds on: on,
     * the change; off, the app as before.
     */
    criteria: z
      .array(
        z.strictObject({
          given: text(200),
          when: text(200),
          expect: text(200),
          from: text(200).optional(),
          quote: text(200).optional(),
          withFlag: z.enum(['on', 'off']).optional(),
        }),
      )
      .min(1)
      .max(12),
    scope: z.array(text(PATH_CHARS)).min(1).max(40),
    risks: z.array(z.enum(V.RISKS)).max(V.RISKS.length),
    rollout: text(300),
    flag: flagName.optional(),
    /** The app's pages the change shows on, by path, as many as Verify pictures (`flag.checked` keeps six, in two schemes). */
    pages: z.array(page).min(1).max(6).optional(),
  }),
  /** A change pushed for review: a new pull request, or another attempt on one that was sent back. */
  'pull-request.pushed': z.strictObject({
    number: pullRequest,
    title: text(200),
    branch: text(120),
    attempt: z.number().int().positive(),
    testsFirst: z.boolean(),
    /** What this push changed: from its round's start, so a later round's are only what it added. */
    files: z
      .array(z.strictObject({ path: text(PATH_CHARS), added: count, removed: count }))
      .min(1)
      .max(200),
    /**
     * The pull request's whole change after this push, as GitHub compares its head with main: what a merge would
     * bring in, every round together. Empty when a round undid every other. A path longer than an event records is
     * `cut` to it, ending in `…`: one the coder's patch could not name, so another push put it there, and it is not
     * known to be in the scope.
     */
    whole: z
      .array(z.strictObject({ path: text(PATH_CHARS), added: count, removed: count, cut: z.literal(true).optional() }))
      .max(200),
  }),
  /**
   * The coder's answer to the suggestions of the review that sent the work back, which do not block: it took each, or
   * declined it with a reason. A suggestion is numbered as the coder was given it, among the review's findings that do
   * not block, in order. One it took is the next review's to find taken.
   */
  'suggestions.answered': z
    .strictObject({
      pullRequest,
      /** How many suggestions the coder was given. */
      suggestions: z.number().int().min(1).max(V.MAX_FINDINGS),
      /** Those it declined, each with its reason, which the suggestion's thread on the pull request is answered with. */
      declined: z
        .array(z.strictObject({ suggestion: z.number().int().min(1).max(V.MAX_FINDINGS), reason: text(300) }))
        .max(V.MAX_FINDINGS),
    })
    .refine(
      (a) =>
        a.declined.every(
          (d, i) => d.suggestion <= a.suggestions && a.declined.findIndex((e) => e.suggestion === d.suggestion) === i,
        ),
      'each suggestion declined is one the coder was given, once',
    ),
  /**
   * After Plan, the work item's spec shares a file with the spec of work already in flight: it waits, before the coder
   * starts, until each of those work items is verified or closed, and then goes on only if its own signal is still
   * there. A wait needs nobody: it is not a hold.
   */
  'wait.started': z.strictObject({
    /** The work items in flight it waits on: every one whose spec shares a file. */
    on: z.array(workItem).min(1).max(40),
    /** The entries of its scope that share a file with theirs. */
    files: z.array(text(PATH_CHARS)).min(1).max(40),
    reason: text(300),
  }),

  'gates.started': z.strictObject({ pullRequest, commit, checks: z.array(text(80)).min(1).max(40) }),
  'gate.finished': z.strictObject({
    pullRequest,
    commit,
    check: text(80),
    conclusion: z.enum(['success', 'failure', 'skipped']),
    required: z.boolean(),
    durationMs: count,
    summary: text(200).optional(),
    /** The check's own output, verbatim. Public views redact anything secret-shaped. */
    output: z.string().max(4000).optional(),
    findings: z.strictObject({ before: severities, after: severities }).optional(),
  }),
  'gates.finished': z.strictObject({
    pullRequest,
    commit,
    conclusion: z.enum(['passed', 'failed']),
    passed: count,
    failed: z.array(text(80)).max(40),
  }),
  /**
   * The reviewer's review of a pull request's latest push, with each finding: the line it is anchored to, whether it
   * blocks, what it cites (a rule of the repository's `docs/REVIEWERS.md`, a criterion of the spec, the ticket, or
   * more than one) and its comment, so the console can show the thread and the rules can be counted by how often they
   * are cited. A finding that cites the ticket says the criterion it cites goes beyond what the ticket asks.
   */
  'review.submitted': z.strictObject({
    pullRequest,
    verdict: z.enum(['approved', 'changes-requested', 'escalated']),
    note: text(300),
    findings: z
      .array(
        z
          .strictObject({
            path: text(PATH_CHARS),
            /** In the change's version of the file. */
            line: z.number().int().positive(),
            blocking: z.boolean(),
            rule: z.number().int().min(1).max(50).optional(),
            criterion: z.number().int().min(1).max(12).optional(),
            /** The criterion it cites is one the ticket does not ask for: only a criterion goes beyond the ticket. */
            ticket: z.literal(true).optional(),
            /**
             * The finding of the review before that this one holds again, in its words or new, by its place among that
             * review's findings, from 1. Answering this one answers that one's thread too, and so on back.
             */
            holds: z.number().int().min(1).max(V.MAX_FINDINGS).optional(),
            comment: text(300),
          })
          .refine((f) => !f.ticket || f.criterion !== undefined, 'a finding cites the ticket for a criterion'),
      )
      .max(V.MAX_FINDINGS),
  }),
  /**
   * Martin approved a review hold in the console (`review` or `beyond-ticket`), which stands in for the reviewer's
   * approval: the line replied on the thread of each of that review's blocking findings, and of each suggestion his
   * approval sends on with no round, and of each earlier finding one holds again, saying he accepted it, and resolved
   * it, so the pull request has none open for his merge.
   */
  'review.accepted': z
    .strictObject({
      pullRequest,
      /** The review he accepted, by its number in the pass, from 1. */
      review: z.number().int().min(1).max(20),
      /** How many of its findings blocked. */
      findings: z.number().int().min(0).max(V.MAX_FINDINGS),
      /** How many of its suggestions went on with no round: those the coder had not declined already. */
      suggestions: z.number().int().min(0).max(V.MAX_FINDINGS),
      /** GitHub refused to resolve some of them, which are left for Martin to resolve by hand. */
      refused: z.literal(true).optional(),
    })
    .refine((a) => a.findings + a.suggestions > 0, 'an acceptance answers at least one thread'),
  'pull-request.merged': z.strictObject({ number: pullRequest, commit, by: z.enum(['martin', 'factory']) }),

  /**
   * The app's deploy pull request that carries a merged work item held for a deploy changed for it: it opened or
   * moved to a new head, and its required checks run there; they all passed, or some failed; it merged; or it was
   * closed unmerged. The line reads it from GitHub and records each change on every held work item it carries, so the
   * console can link it and say whether it waits for Martin yet. A dry run's deploy pull request is never recorded.
   */
  'deploy.changed': z
    .strictObject({
      pullRequest,
      /** The pull request's head: the commit its checks run on. */
      commit,
      state: z.enum(V.DEPLOY_STATES),
      /** The required checks that failed there, on `failed` only. */
      failed: z.array(text(80)).min(1).max(40).optional(),
    })
    .refine((d) => (d.state === 'failed') === (d.failed !== undefined), {
      message: 'a deploy whose checks failed names them, and no other does',
      path: ['failed'],
    }),

  /**
   * A release of the app began: Argo Rollouts started a canary of a new image, or, in a dry run, the dry run says one
   * would have. Each of a release's events names it, and is on every work item it carries, or on the line when it
   * carries none.
   */
  'release.started': z
    .strictObject({
      release: releaseId,
      version: appVersion,
      /** The version it replaces: the stable one, which the canary is compared with. */
      previous: appVersion,
      /** The app's commit it runs, as its image's revision says. A version 1 release never said. */
      commit: commit.optional(),
      /** The image, which admission control let in only because the pipeline signed it. A dry run's has none. */
      image: z.strictObject({ digest, signed: z.boolean(), admitted: z.boolean() }).optional(),
      /**
       * Whether the line watched it go out. A release the line found already live (one that shipped before the line
       * watched releases) is recorded as found, by the factory, with no steps: nobody saw them.
       */
      watched: z.boolean(),
      /**
       * The canary's steps, as the line read them from the Rollout when it recorded the start, or as a dry run takes
       * them. Null when they are not known: a release found live, which nobody saw step, and a version 2 release, which
       * never said.
       */
      steps: z.array(canaryStep).max(V.MAX_CANARY_STEPS).nullable(),
      /** A release the dry run answers for: its work items' merges were never made, so nothing shipped. */
      dryRun: z.boolean(),
    })
    .refine((r) => r.dryRun === (r.image === undefined), {
      message: 'a release that shipped names its image, and a dry run’s names none',
      path: ['image'],
    }),
  /** A step of the canary: its weight, and what the analysis made of it, in the analysis's own terms. */
  'canary.stepped': z.strictObject({
    release: releaseId,
    version: appVersion,
    weight: z.number().int().min(1).max(100),
    analysis: z.strictObject({
      /** How the step's analysis ended, or how far it has got. */
      phase: analysisPhase,
      /** What the traffic split had sent the canary in the analysis's window. Null when it had not counted. */
      requests: count.nullable(),
      measures: z.array(measure).max(8),
    }),
    /** Each version's own figures over the step, from the telemetry by its pod-template hash, when they were read. */
    figures: versus(figures).optional(),
    dryRun: z.boolean(),
  }),
  /**
   * A look of the canary's background analysis, as it lands: errors and latency about every minute, and the journeys
   * every three, throughout the release. It carries the measures the analysis took at that moment, each in the
   * analysis's own terms, and each version's own figures then. A look judges no step: a step's analysis ending is a
   * `canary.stepped`, and a measure that fails as many looks as its limit fails the release, which its
   * `release.rolled-back` records. The line records the looks of a release in flight only; a dry run's measures
   * nothing, so it has none.
   */
  'canary.measuring': z.strictObject({
    release: releaseId,
    version: appVersion,
    /**
     * The canary's share of the traffic when the analysis took the look, read from the attempt's step runs: the
     * Rollout's step now is not where the canary was for a look the line missed, or one read after an abort.
     */
    weight: z.number().int().min(1).max(100),
    /** When the analysis took the look: the latest of its measurements' ends, as Argo Rollouts keeps them. */
    at: timestamp,
    /**
     * Each measure the look took, with that measurement's phase, value and words, and when it ended, in the analysis's
     * order. A measure and its end name the measurement, so the line records each once.
     */
    measures: z
      .array(measure.extend({ at: timestamp }))
      .min(1)
      .max(8),
    /** Each version's own figures over the window that ended with the look, from the telemetry, when they were read. */
    figures: versus(figures).optional(),
    dryRun: z.boolean(),
  }),
  /** The canary took all of the traffic: the release is the stable version now. */
  'release.promoted': z.strictObject({
    release: releaseId,
    version: appVersion,
    previous: appVersion,
    /** As `release.started` has them. A version 1 promotion never named its commit. */
    commit: commit.optional(),
    watched: z.boolean(),
    dryRun: z.boolean(),
  }),
  /**
   * The analysis failed the canary, and Argo Rollouts sent all of the traffic back to the stable version; or, with
   * auto-rollback off, the analysis judged it bad, Argo Rollouts paused it for Martin, and he aborted it, which is a
   * rollback all the same: the work item fails Release, and triage gets the analysis's verdict.
   */
  'release.rolled-back': z.strictObject({
    release: releaseId,
    version: appVersion,
    restored: appVersion,
    /** The canary's weight when it failed: the share of the traffic that ever saw it. */
    weight: z.number().int().min(1).max(100),
    /** Why, in the analysis's words. */
    reason: text(200),
    /**
     * Each measure that failed, with the series that condemned it when there is one to draw, and how many of its run's
     * looks failed, as Argo Rollouts counted them: across the run, not in a row. A version 2 rollback never said. In
     * Martin's rollback, each measure the analysis judged bad, as it said it: `inconclusive`, with auto-rollback off, and
     * how many of its looks were.
     */
    failed: z
      .array(measure.extend({ series: series.optional(), failures: z.number().int().min(1).max(10_000).optional() }))
      .max(8),
    dryRun: z.boolean(),
    /**
     * Who rolled it back: the analysis, by itself, or Martin, aborting a canary the analysis judged bad and paused for
     * him with auto-rollback off. A version 3 rollback was always the analysis's.
     */
    by: z.enum(['analysis', 'martin']),
    /**
     * When Argo Rollouts acted on the abort, to the second, as the Rollout says, when it says: a retry's attempt is what
     * ended after it. Martin's rollback always has it. A version 3 rollback never said.
     */
    abortedAt: timestamp.optional(),
  }),
  /**
   * Martin aborted the canary, and Argo Rollouts sent all of the traffic back to the stable version, with no analysis
   * failed: no rollback, and no signal. It stays aborted until he retries it or a new deploy starts another release.
   * A dry run's release never ships, so none is aborted.
   */
  'release.aborted': z.strictObject({
    release: releaseId,
    version: appVersion,
    restored: appVersion,
    /**
     * When Argo Rollouts acted on the abort, to the second, as the Rollout says: the line records it up to a pass
     * later. The Rollout no longer says the step the canary had reached (an abort sends it back to the first), so the
     * canary's weight then is read from the release's steps, as the console reads one in flight.
     */
    abortedAt: timestamp,
    /** Stop the line, which aborts every release in flight, or Martin aborting this one alone. */
    by: z.enum(['stop', 'martin']),
  }),
  /**
   * An analysis of the canary ended in Error: it could not judge the canary, and Argo Rollouts aborted the Rollout and
   * sent all of the traffic back to the stable version. Nothing failed, so it is no rollback and no signal, and nobody
   * stopped it, so it is no abort. It stays stopped until Martin retries it or a new deploy starts another release. A
   * dry run's release runs no analysis, so none errs.
   */
  'release.errored': z.strictObject({
    release: releaseId,
    version: appVersion,
    restored: appVersion,
    /** The canary's weight when the analysis could not judge it: the share of the traffic that ever saw it. */
    weight: z.number().int().min(1).max(100),
    /** Why, in the analysis's words. */
    reason: text(200),
    /** Each measure that could not be taken, in the analysis's words. */
    errored: z.array(measure).max(8),
    /** When Argo Rollouts acted on the abort the Error made, to the second, as the Rollout says. */
    abortedAt: timestamp,
  }),
  /**
   * After a release, the sense that saw the defect looked again: whether what it saw has cleared on the new version.
   * Every page is compared with the version before the fix, when there are pictures to compare.
   */
  'verification.finished': z.strictObject({
    outcome: z.enum(['cleared', 'persists']),
    /** The sense that verified it: the one whose signal opened the ticket. A version 1 verification never said. */
    sense: z.enum(V.SENSES).optional(),
    check: text(120),
    /** The version verified: the release live when the sense looked. A version 1 verification never said. */
    version: appVersion.optional(),
    /** The version it was compared with: the one before the fix. */
    against: appVersion,
    evidence: evidence.optional(),
    /** The pages compared, if any were: a sense that does not look at pages compares none. */
    pages: z
      .array(
        z
          .strictObject({
            page: text(60),
            route,
            screenshot: sha256,
            /** The share of pixels that differ from the same page on `against`. */
            changed: z.number().min(0).max(1),
            /** Whether the page is the work item's own: the one its fix was meant to change. */
            intended: z.boolean(),
            /**
             * Another work item the release carried, whose own page this is: its fix was meant to change it. Only on a
             * page that is not this work item's own. A version 3 verification never said.
             */
            intendedFor: workItem.optional(),
          })
          .refine((page) => !(page.intended && page.intendedFor), {
            message: 'a page that is the work item’s own names no other',
            path: ['intendedFor'],
          }),
      )
      .max(12),
    /** A verification the dry run answers for: its release never shipped, so no sense looked. */
    dryRun: z.boolean(),
  }),

  /**
   * The sense that saw a work item's defect looked again, as Verify does, at the version the stable Service runs, which
   * did not carry its fix: at a held or waiting work item, after a release was promoted (`release`), or as the work it
   * waited on ended (`wait`); at an open ticket, as the line took it, before Plan (`take`), or as Verify cleared another
   * ticket's fix of the same sense and symptom (`fix`). It cleared, it persists, or the sense could not tell, and says
   * why. A look at the end of a wait with no release of the app recorded names none.
   */
  'signal.rechecked': z
    .strictObject({
      for: z.enum(['release', 'wait', 'take', 'fix']),
      outcome: z.enum(['cleared', 'persists', 'unsure']),
      /** The sense that looked: the one whose signal opened the ticket. */
      sense: z.enum(V.SENSES).optional(),
      check: text(120),
      /** The release looked at, the version it runs, and the version before it. */
      release: releaseId.optional(),
      version: appVersion.optional(),
      against: appVersion.optional(),
      /**
       * The work items carried by the releases promoted after the ticket's signal was last seen, up to the one looked
       * at, as their starts recorded them: none for releases on the line itself. Version 1 named only the release
       * looked at's.
       */
      carried: z.array(workItem).max(20),
      /** The version the ticket's signal was last seen on, which the releases `carried` names came after. */
      since: appVersion.optional(),
      /** The pull request each of the work items `carried` names merged, for those that merged one. */
      merged: z.array(z.strictObject({ workItem, pullRequest })).max(20).optional(),
      evidence: evidence.optional(),
      /** Why the sense could not tell. */
      why: text(200).optional(),
    })
    .refine((r) => (r.outcome === 'unsure') === (r.why !== undefined), {
      message: 'a look that could not tell says why, and only one',
      path: ['why'],
    })
    .refine((r) => r.outcome === 'unsure' || r.version !== undefined, {
      message: 'a look that cleared or persists names the version it looked at',
      path: ['version'],
    }),

  'work.returned': z
    .strictObject({
      from: stage,
      to: stage,
      reason: text(200),
      /** The coder's round the return starts. A version 1 return did not record it. */
      round: z.number().int().positive().optional(),
      /** From review: how many of its findings block. */
      blocking: count.optional(),
      /** From a review that approved: how many suggestions the coder is to take or decline, in a round of their own. */
      suggestions: count.optional(),
      /** From the gates: the required checks that failed, which may name none. */
      failed: z.array(text(80)).max(40).optional(),
    })
    .refine((r) => V.STAGES.indexOf(r.to) < V.STAGES.indexOf(r.from), 'work returns upstream, to an earlier stage'),
  'hold.started': z
    .strictObject({
      stage,
      /** Approval and questions are the line asking; held means a mechanism stopped the work for a human to decide. */
      kind: z.enum(['approval', 'question', 'held']),
      /** Why, so that Martin's answer has a meaning: what each answer does depends on it. */
      cause: z.enum(V.HOLD_CAUSES),
      reason: text(300),
      question: text(300).optional(),
      /** A spend hold's cap: the most the work item may spend on models, in the profile the line runs in. */
      limitUsd: usd.optional(),
      /** A spend hold's spend: what the work item had spent on models when it reached the cap. */
      spentUsd: usd.optional(),
      /**
       * A `finding` hold's defect: its fingerprint, as triage would give a report's ticket (the route the planner
       * named and the symptom Jev judged, or for wrong words the passage of the page), and the symptom. A ticket
       * with the same fingerprint closes it, and Martin's approval opens its ticket.
       */
      defect: z.strictObject({ fingerprint, symptom: z.enum(V.SYMPTOM_CLASSES) }).optional(),
      /**
       * A `scope` hold the coder asked for, rather than the fence: each file outside the spec's scope that it needs to
       * change and may not, with why, and whether no scope may name it (`barred`). Approving sends them to the
       * planner, which may widen the scope to them, never to one barred.
       */
      needs: z
        .array(
          z.strictObject({
            path: text(PATH_CHARS),
            reason: text(V.NEED_REASON_CHARS),
            barred: z.literal(true).optional(),
          }),
        )
        .min(1)
        .max(V.MAX_NEEDS)
        .optional(),
      /**
       * A `canary` hold's release, as the line names it: the canary paused for Martin. Its promotion, rollback, abort
       * or Error ends the hold.
       */
      release: releaseId.optional(),
    })
    .refine((hold) => (hold.cause === 'finding') === (hold.defect !== undefined), {
      message: 'a finding’s hold, and only one, names the defect',
      path: ['defect'],
    })
    .refine((hold) => hold.needs === undefined || hold.cause === 'scope', {
      message: 'only a scope hold names the files the coder needs',
      path: ['needs'],
    })
    .refine((hold) => (hold.cause === 'canary') === (hold.release !== undefined), {
      message: 'a canary’s hold, and only one, names the release',
      path: ['release'],
    }),
  'hold.answered': z.strictObject({
    decision: z.enum(V.HOLD_ANSWERS),
    answer: text(300).optional(),
    /** The hold it answers: its `hold.started` event's id. An answer from before the admin service never named it. */
    hold: z.uuid().optional(),
    /**
     * The hold is on a work item a visitor's report opened, so the answer's words stay Martin's: its public view leaves
     * them out, since a paraphrase of a report would pass any redactor. An answer from before never said.
     */
    report: z.literal(true).optional(),
  }),
  /**
   * A mechanism stopped an action: the platform's (a token's permissions, a ruleset, the egress policy, admission
   * control), the coder's scope fence, the GitHub worker's own guard, the review check, the gateway, or triage
   * quarantining a report. Each is appended only by the roles `policy/refusals.ts` names for its mechanism, which row
   * security holds it to (0040_refusals-by-mechanism.sql), with the guardrails that file gives its mechanism
   * (0041_refusals-as-they-read.sql).
   */
  'action.refused': z
    .strictObject({
      mechanism: z.enum(V.REFUSAL_MECHANISMS),
      action: text(200),
      /** The mechanism's own refusal, verbatim. */
      output: z.string().min(1).max(4000),
      /**
       * Which of spec 6's guardrails the refusal shows, as the appender, which knows why it was refused, says: the
       * Guardrails panel counts it under these and no others.
       */
      guardrails: z
        .array(z.number().int().min(1).max(V.GUARDRAIL_COUNT))
        .min(1)
        .max(V.GUARDRAIL_COUNT)
        .refine((guardrails) => new Set(guardrails).size === guardrails.length, 'each guardrail once'),
      /**
       * How many refusals this one event stands for: repeats of one refusal (its mechanism, work item and action) within
       * a minute are folded into one, so a loop cannot flood the store. None is one.
       */
      count: z.number().int().min(1).optional(),
      /** When the last of the refusals it stands for was, when it stands for more than one. */
      lastAt: timestamp.optional(),
      /** A relayed refusal: the artifact record the mechanism kept of it, by hash. */
      record: sha256.optional(),
      /** A relayed refusal: the mechanism's signature over its record (Ed25519, in base64), which a reader verifies. */
      signature: z
        .string()
        .regex(/^[A-Za-z0-9+/]{86}==$/, 'an Ed25519 signature, in base64')
        .optional(),
      /** What was refused, when it is no work item's: an object in the cluster, say. */
      subject: z
        .strictObject({
          namespace: text(63).optional(),
          kind: text(63),
          name: text(253),
          uid: z.uuid().optional(),
        })
        .optional(),
      /** The scope fence's verdict on each file the patch changed, which its output prints. */
      files: z
        .array(z.strictObject({ path: text(PATH_CHARS), added: count, removed: count, allowed: z.boolean() }))
        .max(200)
        .optional(),
    })
    .refine((refusal) => (refusal.lastAt === undefined) === ((refusal.count ?? 1) === 1), {
      message: 'a refusal that stands for more than one says when the last was, and only then',
      path: ['lastAt'],
    })
    .refine((refusal) => (refusal.record === undefined) === (refusal.signature === undefined), {
      message: 'a relayed refusal names its record and the signature over it together',
      path: ['signature'],
    }),
  /** One agent's step: every call it made, summed. The gateway's `model_calls` table keeps each call. */
  'model.called': z.strictObject({
    agent: z.enum(V.AGENTS),
    provider: z.enum(V.MODEL_PROVIDERS),
    model,
    settings: z.strictObject({
      effort: z.enum(V.EFFORTS).optional(),
      maxTurns: z.number().int().positive().optional(),
    }),
    tokens: z.strictObject({ input: count, output: count, cacheRead: count, cacheWrite: count }),
    costUsd: usd,
    durationMs: count,
    /** How many calls the step made. */
    calls: z.number().int().positive(),
  }),

  /**
   * The line started: from the console's Start the line, with Martin's reason, or from `make start-the-line`, with his
   * reason if he gave one. The autonomy level is a control of its own (`controls.changed`): a start that names one is
   * from before it was, kept as it was recorded, and sets nothing.
   */
  'line.started': z.strictObject({
    autonomy: z.enum(V.AUTONOMY).optional(),
    reason: text(V.MARTIN_REASON_CHARS).optional(),
  }),
  /** The line stopped, from the console's Stop the line or `make stop-the-line`, with Martin's reason. */
  'line.stopped': z.strictObject({ reason: text(V.MARTIN_REASON_CHARS) }),
  /**
   * One of a guardrail's proofs, taken by `make guardrails` from a clean checkout of `main`: the catalogue's proof
   * (`policy/guardrails.ts`), whether it held, and its output verbatim. Appended only by the proofs' role
   * (`factory_proofs`), which row security holds it to (0043_guardrail-proofs.sql). A proof read from CI names the
   * run it read, and its commit is that run's.
   */
  'guardrail.proved': z
    .strictObject({
      /** Spec 6's guardrails it proves. */
      guardrails: z
        .array(z.number().int().min(1).max(V.GUARDRAIL_COUNT))
        .min(1)
        .max(V.GUARDRAIL_COUNT)
        .refine((guardrails) => new Set(guardrails).size === guardrails.length, 'each guardrail once'),
      /** Its id in the catalogue, such as `egress`, or `ci:scope-fence` for one read from CI. */
      proof: z.string().regex(/^(ci:)?[a-z][a-z0-9-]{0,62}$/, 'a proof id, such as egress or ci:scope-fence'),
      /** What it was taken against, as the catalogue names it: `ci-tests` for a proof read from CI. */
      mechanism: slug.max(63),
      held: z.boolean(),
      /** What the proof printed, verbatim. */
      output: z.string().min(1).max(4000),
      /** The commit its scripts ran from (`main`'s head, clean), or the CI run's. */
      commit,
      /** The hash of the policies and Roles it was taken against (`policyHash`), as SHA-256 in lower-case hex. */
      policyHash: sha256.optional(),
      /** A proof read from CI: the run it read, and when that run finished. */
      run: z
        .strictObject({
          url: z
            .string()
            .max(300)
            .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(\/attempts\/\d+)?$/, 'a GitHub run'),
          at: timestamp,
        })
        .optional(),
    })
    .refine((proved) => proved.proof.startsWith('ci:') === (proved.mechanism === 'ci-tests'), {
      message: 'a proof read from CI, and only one, is by its tests (ci-tests)',
      path: ['mechanism'],
    })
    .refine((proved) => proved.proof.startsWith('ci:') === (proved.run !== undefined), {
      message: 'a proof read from CI, and only one, names its run',
      path: ['run'],
    }),
  /**
   * Model calls wait (guardrail 7). Either the factory's own day or month cap is reached, and the gateway refuses
   * calls until it resets; or a provider refuses for a cap the factory does not own (the account's credit is spent,
   * the workspace's limit is reached, or the local model is not running), and agent calls wait until it answers.
   */
  'spend.capped': z.discriminatedUnion('cap', [
    z.strictObject({
      cap: z.enum(['day', 'month']),
      limitUsd: usd,
      spentUsd: usd,
      resets: timestamp,
    }),
    z.strictObject({
      cap: z.literal('provider'),
      provider: z.enum(V.MODEL_PROVIDERS),
      reason: z.enum(V.PROVIDER_CAPS),
      /** The provider's own words, or what the gateway saw when it could not connect. */
      message: text(300),
    }),
  ]),
  'spend.cleared': z.discriminatedUnion('cap', [
    z.strictObject({ cap: z.enum(['day', 'month']) }),
    z.strictObject({ cap: z.literal('provider'), provider: z.enum(V.MODEL_PROVIDERS) }),
  ]),
  /**
   * The scoreboard's figures (spec section 3.2), when one changes: how many of the answer key's entries tickets have
   * found, how many are verified fixed, and the median time from a found entry's first signal to its verified fix.
   * Never which ticket found which entry. Without an answer key the scoreboard is off, and says so once.
   */
  'score.updated': z.union([
    z
      .strictObject({
        keyed: z.literal(true),
        /** The answer key's entries. */
        entries: count,
        /** Entries a ticket has found, counted on the scoreboard's slow cadence (`policy/scoreboard.ts`). */
        found: count,
        /** Entries a ticket that found them is verified fixed, now. */
        verified: count,
        /** The median, over verified entries, from a ticket's first signal to its verified close; null before one. */
        medianMs: count.nullable(),
      })
      .refine((s) => s.verified <= s.found && s.found <= s.entries, 'verified ≤ found ≤ entries')
      .refine((s) => (s.medianMs === null) === (s.verified === 0), 'a median exactly when an entry is verified'),
    z.strictObject({ keyed: z.literal(false) }),
  ]),

  /**
   * Martin signed in, with a passkey or by enrolling one (the admin service). The passkey's name is his alone: the public
   * view says that he signed in, never with which passkey, from where or in which browser.
   */
  'admin.signed-in': z.strictObject({ passkey: passkeyName.optional() }),
  /** Martin signed out: on the one device, or everywhere, which ends every session. */
  'admin.signed-out': z.strictObject({ everywhere: z.boolean() }),
  /**
   * Martin gave his passkey again in a session, the one it signed in with, so for five minutes it may do what the access
   * table marks as needing it. Its name is Martin's alone, as above.
   */
  'admin.stepped-up': z.strictObject({ passkey: passkeyName.optional() }),
  /** A passkey made with a one-time code from `factory admin enrol`. Its name is Martin's alone, as above. */
  'passkey.enrolled': z.strictObject({ passkey: passkeyName.optional() }),
  /**
   * A passkey revoked: from the console, with the passkey given again, or by `factory admin enrol --revoke-others`, which
   * revokes every passkey and ends every session. Its name is Martin's alone, as above.
   */
  'passkey.revoked': z.strictObject({ passkey: passkeyName.optional(), from: z.enum(['console', 'command-line']) }),
  /**
   * Martin controlled the canary from the console, and the admin service made the change to the app's Rollout: promoted
   * it to the next step's weight or fully, paused it, gave it back to its analysis, aborted it, or retried a release
   * that was stopped or rolled back; or he stopped the line from the console, and the admin service aborted the canary in flight with
   * it (`stop`). Appended once the change is made, never for one that failed. The line goes on recording what the
   * Rollout then does: after his abort, `release.aborted` with `by: martin`, or `release.rolled-back` with `by: martin`
   * of a canary the analysis judged bad, and after Stop the line's, `release.aborted` with `by: stop`.
   */
  'release.controlled': z
    .strictObject({
      action: z.enum(V.RELEASE_CONTROLS),
      /** The release he acted on, as the line names it. */
      release: releaseId,
      /** Its version: the canary's. */
      version: appVersion,
      /** The canary's weight when he acted: 0 for a release that was stopped. */
      weight: z.number().int().min(0).max(100),
      /** For a promotion, the weight it goes to: the next step's, or 100 for all of the traffic. */
      to: z.number().int().min(1).max(100).optional(),
      /** An abort that came with Stop the line, not from the Canary panel. */
      stop: z.literal(true).optional(),
    })
    .refine((c) => (c.to !== undefined) === (c.action === 'promote' || c.action === 'promote-fully'), {
      message: 'a promotion says the weight it goes to, and nothing else does',
      path: ['to'],
    })
    .refine((c) => c.action !== 'promote-fully' || c.to === 100, {
      message: 'promoting fully sends the canary all of the traffic',
      path: ['to'],
    })
    .refine((c) => !c.stop || c.action === 'abort', {
      message: 'Stop the line only aborts the canary',
      path: ['stop'],
    }),
  /**
   * Martin saved his settings in the console, within policy (`policy/settings.ts`): every agent's model and effort and
   * every spend cap as they now stand, and each field the save changed, with its value before and after. The gateway
   * and the line read the latest one that his roles appended, at an agent's next step, and check it against policy as
   * they read it: anything outside it is not in force, and policy's default is.
   */
  'settings.changed': z.strictObject({
    agents: z.strictObject(
      Object.fromEntries(V.MODEL_AGENTS.map((agent) => [agent, agentSetting])) as Record<
        V.ModelAgent,
        typeof agentSetting
      >,
    ),
    caps: z.strictObject({
      dayUsd: usd,
      /** None: the profile's default, which on `local` is no cap. */
      monthUsd: usd.nullable(),
      workItemUsd: usd,
    }),
    changes: z
      .array(
        z.discriminatedUnion('field', [
          z.strictObject({ field: z.literal('model'), agent: z.enum(V.MODEL_AGENTS), before: model, after: model }),
          z.strictObject({
            field: z.literal('effort'),
            agent: z.enum(V.MODEL_AGENTS),
            /** None for a local model, which takes no effort. */
            before: z.enum(V.EFFORTS).nullable(),
            after: z.enum(V.EFFORTS).nullable(),
          }),
          z.strictObject({
            field: z.literal('cap'),
            cap: z.enum(V.SPEND_CAPS),
            /** None for no cap. */
            beforeUsd: usd.nullable(),
            afterUsd: usd.nullable(),
          }),
        ]),
      )
      .min(1)
      .max(20),
  }),
  /**
   * Martin changed one of the line's controls in the console (`policy/line.ts`): every control as it now stands, and
   * the one he changed, with its value before and after. The line and the admin service read the latest one his roles
   * appended, and check it against policy as they read it: anything outside it is not in force, and policy's default
   * is. Nothing routes by the autonomy level or auto-merge until approval routing comes (Part C); the line acts on
   * the switch for new work and on what it takes from its next pass. Auto-rollback reaches the canary's analysis as
   * two series, the admin service's read of it and the line's (`release/analysis.ts`).
   */
  'controls.changed': z.strictObject({
    autonomy: z.enum(V.AUTONOMY),
    newWork: z.boolean(),
    autoMerge: z.boolean(),
    /** None: no take set, so the line's own default (`LINE_TAKE`, `LINE_ONLY`) is in force. */
    take: take.nullable(),
    /** Whether a canary the analysis judges bad rolls back by itself; off, it pauses for Martin. */
    autoRollback: z.boolean(),
    change: z.discriminatedUnion('control', [
      z.strictObject({
        control: z.literal('autonomy'),
        before: z.enum(V.AUTONOMY),
        after: z.enum(V.AUTONOMY),
      }),
      z.strictObject({ control: z.literal('new-work'), before: z.boolean(), after: z.boolean() }),
      z.strictObject({ control: z.literal('auto-merge'), before: z.boolean(), after: z.boolean() }),
      z.strictObject({ control: z.literal('take'), before: take.nullable(), after: take }),
      z.strictObject({ control: z.literal('auto-rollback'), before: z.boolean(), after: z.boolean() }),
    ]),
  }),
  /**
   * Martin switched alerts to his phone in the console (`policy/phone.ts`): every alert at its level, or none. The admin
   * service reads the latest one his roles appended, and tells Prometheus, whose `PhoneOff` then mutes every alert with
   * a level in Alertmanager; Grafana's Alerts dashboard shows them all either way.
   */
  'alerts.switched': z.strictObject({ phone: z.boolean() }),
  /**
   * Martin set a flag's stage in the console (the admin service): the flag, the stage `flags` held it at before (none
   * when it held it in no stage's shape) and the one he set, with its share at the share stage, the revision of the
   * flag set written with it, what the move was, whether his passkey was fresh as it was taken, and any flag set by
   * hand outside every stage that the write dropped. On the work item whose improvement's spec
   * names the flag. Turning it off takes his reason, for the audit log and the work item; any other move may give one.
   */
  'flag.staged': z
    .strictObject({
      flag: flagName,
      from: flagStage.nullable(),
      to: flagStage,
      /** What the move was, as the admin service judged it from the stage `flags` held. */
      action: z.enum(V.FLAG_ACTIONS),
      revision: z.string().regex(/^[!-~]{1,128}$/, "the flag set's revision, as flagd holds it"),
      reason: text(V.MARTIN_REASON_CHARS).optional(),
      steppedUp: z.boolean(),
      /** The names `flags` held in no stage's shape (set by hand), which the write dropped, and so turned off. */
      dropped: z.array(z.string().min(1).max(253)).min(1).max(100).optional(),
    })
    .refine((staged) => staged.to.stage !== 'off' || staged.reason !== undefined, {
      message: 'turning a flag off gives a reason',
      path: ['reason'],
    }),
  /**
   * Verify compared a flag's two sides at the share stage (task 17): flag on against flag off, on the traffic
   * generator's own requests in the window, each id's side worked out with flagd's own rule, judged on errors and
   * latency with the canary's thresholds. `setAsideMinutes` is how much of the window a canary was in flight, left out.
   * Until a comparison of a flag at its share, appended by the line, of Martin's latest move of it (`moveRevision`),
   * has passed, the admin service refuses Everyone. On the work item whose improvement's spec names the flag.
   */
  'flag.compared': z.strictObject({
    flag: flagName,
    share: flagShare,
    moveRevision,
    window: z.strictObject({ from: timestamp, to: timestamp }),
    setAsideMinutes: count,
    outcome: z.enum(V.FLAG_COMPARISONS),
    sides: z.strictObject({ on: flagSide, off: flagSide }),
    reason: text(300).optional(),
  }),
  /**
   * Verify checked a flag with the probes (task 17), on the improvement's work item, against the stable Service, whose
   * every probe request carries the mark and so sees the flag on from Checks; each run saw the flag set Martin's latest
   * move wrote (`revision`), before and after. The journeys and the `/device` check, and pictures of the spec's pages
   * (the front page, while a spec names none), each in both colour schemes, light and dark, as the browser says it
   * prefers, the screenshots the event's artifacts:
   *
   * - `off`, the baseline: once for each stable version while the flag is at Off, the run the later stages compare with.
   *   It names each check that did not pass cleanly, as the journeys gate's base.
   * - `checks`: at Checks, the journeys compared with that run by the journeys gate's rule, the `/device` check among
   *   them, and each page with the flag on against the page with it off. Its pictures are the work item's evidence.
   * - `preview`: at Preview, the same, after a probe asked to preview the flag: it passes only when the `/device` check
   *   allowed the preview cookie and kept nothing the run with the flag off did not.
   *
   * One for each of Martin's moves to Checks or Preview, naming the revision that move wrote (`moveRevision`), beside
   * the revision the run saw (`revision`, which a later move of another flag makes newer); unsure when there was no run
   * with the flag off to compare with, or one that names fewer of its failing checks than failed.
   */
  'flag.checked': z.discriminatedUnion('stage', [
    z.strictObject({
      stage: z.literal('off'),
      flag: flagName,
      version: appVersion,
      revision: flagRevision,
      journeys: journeysCount,
      /** Each check that failed, or could not tell: the checks a later stage's regressions are not counted on. */
      notClean: z.array(journeyCheck).max(200),
      /** Each page, in each colour scheme. */
      pages: z.array(z.strictObject({ page: route, route, scheme: colorScheme, off: sha256 })).max(12),
    }),
    z.strictObject({
      stage: z.literal('checks'),
      flag: flagName,
      version: appVersion,
      revision: flagRevision,
      ...flagJourneys,
      pages: z
        .array(
          z.strictObject({
            /** The page's path. */
            page: route,
            route,
            /** The colour scheme the browser said it preferred: each page is pictured in both. */
            scheme: colorScheme,
            /** The page with the flag off, in the same scheme, from the run compared with: none without one. */
            off: sha256.optional(),
            on: sha256,
            /** The share of pixels that differ from the page with the flag off, and where: no diff when none do. */
            changed: probability.optional(),
            diff: sha256.optional(),
          }),
        )
        .max(12),
    }),
    z.strictObject({
      stage: z.literal('preview'),
      flag: flagName,
      version: appVersion,
      revision: flagRevision,
      ...flagJourneys,
      /** What the `/device` check found: the preview cookie, allowed, and anything else kept, as `<kind> <name>`. */
      device: z.strictObject({ allowed: z.array(text(200)).max(10), kept: z.array(text(200)).max(10) }),
    }),
  ]),
  /**
   * Martin asked for an improvement in the console's "+", in his own words, with his passkey given again (the admin
   * service): the work item of kind `improvement` it opens comes just before it, in the same transaction, titled from
   * his first sentence (`requestTitle`). Only his roles may append either (`0035_improvement-requests.sql`), and the line
   * acts on an improvement only when both came from one of them. The words are his, and public through the redactor, as
   * his other words are. Its id is the request's own, so a request sent twice opens one work item.
   */
  'improvement.requested': z.strictObject({
    words: text(REQUEST_WORDS),
    steppedUp: z.boolean(),
  }),
} satisfies { [K in EventType]: z.ZodType };

/** The envelope of an event about to be appended: everything but `seq` and `public`, which the store adds. */
export const newEvent = z.strictObject({
  id: z.uuid(),
  ts: timestamp,
  work_item: workItem.nullable(),
  type: z.enum(Object.keys(VERSIONS) as [EventType, ...EventType[]]),
  version: z.number().int().positive(),
  actor: z.enum(V.ACTORS),
  summary: text(200),
  payload: z.unknown(),
  artifacts: z.array(artifactRef).max(40),
});

export type Validated = { ok: true } | { ok: false; problems: string[] };

/**
 * A signal as a sense leaves it in the inbox: what `signal.received` will say if triage makes an event of it, when
 * the sense saw it, and its artifacts.
 */
export const inboxSignal = z
  .intersection(
    // Triage's look at what the sense reads, which `validateSignal` refuses from a sense.
    PAYLOADS['signal.received'].omit({ environment: true }),
    z.object({
      observedAt: timestamp,
      /** What the sense saw, in a line, for the event's summary. A report has none: its text is never a summary. */
      summary: text(200).optional(),
      artifacts: z.array(artifactRef).max(10),
    }),
  )
  .superRefine((signal, context) => {
    // A report is its text, as a planner's finding is: one without any is nothing to judge, and nothing to answer.
    const judged = signal.sense === 'report' || signal.sense === 'planner';
    if (judged && !signal.report?.text) {
      context.addIssue({
        code: 'custom',
        path: ['report', 'text'],
        message: signal.sense === 'report' ? 'a report needs its text' : 'a finding needs its text',
      });
    }
    if (!judged && signal.report) {
      context.addIssue({ code: 'custom', path: ['report'], message: 'only a report or a finding carries words' });
    }
    if (signal.sense === 'planner' && signal.symptom) {
      context.addIssue({
        code: 'custom',
        path: ['symptom'],
        message: 'the planner names no symptom: triage judges it',
      });
    }
    if ((signal.sense === 'planner') !== (signal.planning !== undefined)) {
      const message = 'a planner’s finding, and only one, names the work item it was planning';
      context.addIssue({ code: 'custom', path: ['planning'], message });
    }
  });

/** Checks a signal before it goes in the inbox, so a sense cannot leave triage something it would refuse. */
export function validateSignal(input: unknown): Validated {
  // How what the sense reads stood is triage's to look at, not the sense's to say.
  if (input && typeof input === 'object' && 'environment' in input) {
    return { ok: false, problems: ['environment: triage looks at what a sense reads; a sense never says'] };
  }
  const result = inboxSignal.safeParse(input);
  return result.success ? { ok: true } : { ok: false, problems: problemsOf(result.error) };
}

/** Checks an event's envelope and payload against the current version of its type. */
export function validate(input: unknown): Validated {
  const envelope = newEvent.safeParse(input);
  if (!envelope.success) return { ok: false, problems: problemsOf(envelope.error) };
  const event = envelope.data;
  const problems: string[] = [];
  if (event.version !== VERSIONS[event.type]) {
    problems.push(`version ${event.version} of ${event.type} is not current; append version ${VERSIONS[event.type]}`);
  }
  // A release's events may be on a work item or on the line, and so may a refusal, of what no work item asked for (an
  // object applied in the cluster, a model call with no job token); every other type is on one or the other.
  if (!RELEASE_TYPES.includes(event.type) && event.type !== 'action.refused') {
    const line = LINE_TYPES.includes(event.type);
    if (line && event.work_item !== null) problems.push(`${event.type} belongs to the line, not to a work item`);
    if (!line && event.work_item === null) problems.push(`${event.type} needs a work item`);
  }
  const payload = PAYLOADS[event.type].safeParse(event.payload);
  if (!payload.success) problems.push(...problemsOf(payload.error, 'payload'));
  return problems.length ? { ok: false, problems } : { ok: true };
}

function problemsOf(error: z.ZodError, prefix?: string): string[] {
  return error.issues.map((issue) => {
    const path = [...(prefix ? [prefix] : []), ...issue.path.map(String)].join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
