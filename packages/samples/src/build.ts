/**
 * Writing a sample work item: events at offsets from its start, in the types' own shapes, so the compiler checks
 * every payload. Everything is derived from names, never from the clock or chance, so an export is the same every
 * time and `make check` can tell when the event log is out of date.
 */
import { createHash } from 'node:crypto';
import type {
  Actor,
  Agent,
  ArtifactRef,
  EventType,
  Evidence,
  NewEvent,
  PayloadOf,
  Screenshot,
  Sense,
} from '@software-factory/events';
import { VERSIONS } from '@software-factory/events';
import { release } from '../../../policy/release.ts';
import { changed, shot } from './captures.ts';

const hex = (name: string, length = 64) => createHash('sha256').update(name).digest('hex').slice(0, length);

/** A UUID derived from a name (version 8, for custom schemes), so a sample keeps its ids from one export to the next. */
export function uuidFor(name: string): string {
  const h = hex(`sample-event:${name}`, 32).split('');
  h[12] = '8';
  h[16] = ((Number.parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export const commitFor = (name: string) => hex(`commit:${name}`, 40);
export const digestFor = (name: string) => `sha256:${hex(`image:${name}`)}`;
export const traceFor = (name: string) => hex(`trace:${name}`, 32);
const cassetteFor = (name: string) => hex(`cassette:${name}`);
/** A relayed refusal's artifact record, by hash, and the GitHub worker's signature over it (Ed25519, in base64). */
export const recordFor = (name: string) => hex(`record:${name}`);
export const signatureFor = (name: string) =>
  Buffer.from(`${hex(`signature:${name}:r`)}${hex(`signature:${name}:s`)}`, 'hex').toString('base64');

/**
 * Each attack's end, by its event's id, and the ids of the refusals it cites: an end cites them by seq, which the store
 * gives, so `sampleEvents` gives each its seq once every sample is in order, as the event log numbers them.
 */
export const CITED = new Map<string, string[]>();

type Files = PayloadOf<'pull-request.pushed'>['files'];

/** A small, repeatable source of variety: the same name always gives the same sequence. */
function random(name: string): () => number {
  let state = Number.parseInt(hex(`seed:${name}`, 8), 16);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seconds from `m:ss` or `h:mm:ss`. */
function seconds(offset: string): number {
  return offset.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** An offset some seconds after another, as `h:mm:ss`. */
export function later(offset: string, by: number): string {
  const total = seconds(offset) + by;
  const two = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `${Math.floor(total / 3600)}:${two((total % 3600) / 60)}:${two(total % 60)}`;
}

/** US dollars per million tokens, as Anthropic lists them in October 2026. */
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // LM Studio on Martin's Mac: counted and capped like any other, and priced at nothing.
  'qwen/qwen3.8-27b': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

type Model = keyof typeof PRICES;

/** How each agent is configured: the gateway logs these settings with every call. */
export const AGENT_SETTINGS = {
  planner: { model: 'claude-opus-5-5', settings: { effort: 'high' } },
  coder: { model: 'claude-sonnet-5-5', settings: { effort: 'medium', maxTurns: 40 } },
  reviewer: { model: 'claude-sonnet-5-5', settings: { effort: 'high' } },
  describer: { model: 'claude-sonnet-5-5', settings: { effort: 'low' } },
  'red-team': { model: 'claude-sonnet-5-5', settings: { effort: 'low', maxTurns: 20 } },
} as const satisfies Partial<Record<Agent, { model: Model; settings: PayloadOf<'model.called'>['settings'] }>>;

/** Every agent on the local model, as `ALL_LOCAL` on a gateway sends them for an unattended run. */
const LOCAL = { model: 'qwen/qwen3.8-27b', settings: {} } as const;

export interface Calls {
  /** How many calls, spread evenly between the two offsets. */
  calls: number;
  /** Totals across the calls. Input counts every input token, cached or not. */
  input: number;
  output: number;
  /** The share of input read from the prompt cache. */
  cached: number;
}

/** The checks every pull request must pass, and how long each usually takes. */
export const GATES: [name: string, seconds: number][] = [
  ['Pull request title', 4],
  ['Lint and format', 18],
  ['Types', 11],
  ['Unit tests', 23],
  ['Integration tests', 41],
  ['End-to-end journeys', 112],
  ['Test integrity', 9],
  ['Accessibility on changed pages', 34],
  ['Dependency review', 6],
  ['Secret scan', 5],
  ['CodeQL', 130],
  ['Image scan', 48],
];

/** The tests-first check: not required, so it never blocks a merge, and the line reads it. */
const TESTS_FIRST = 'Tests first';

export interface GateRun {
  pullRequest: number;
  /** Names the commit, so a second attempt is checked as a new one. */
  attempt?: number;
  /** A check that fails, with its own output. */
  failure?: { check: string; summary: string; output: string };
  /** Extra detail for a check that passes. */
  details?: Record<string, Partial<PayloadOf<'gate.finished'>>>;
  /**
   * The tests-first check, a signal and not required: how many of the change's new tests fail on the base, of how
   * many, and its output. It passes when at least one fails there.
   */
  testsFirst?: { failing: number; of: number; output?: string };
}

/** The pages verification compares with the version before, and the names of their screenshots. */
export const PAGES = [
  ['Home', '/', 'home'],
  ['Products', '/products', 'products'],
  ['Search', '/search', 'search'],
  ['Contact', '/contact', 'contact'],
] as const;

type SampleRoute = (typeof PAGES)[number][1];

/** The letters Kubernetes makes a pod-template hash of, which names a release with the Rollout's revision. */
const HASH_LETTERS = 'bcdfghjklmnpqrstvwxz2456789';

/**
 * A release's name, as the line names one: a canary's pod-template hash, and the Rollout's revision, which counts up
 * with the version (v0.9.13's is 913).
 */
export const releaseFor = (version: string) => {
  const hash = [...Buffer.from(hex(`release:${version}`, 20), 'hex')].map((byte) => HASH_LETTERS[byte % 27]).join('');
  const [, minor = 0, patch = 0] = version.match(/(\d+)\.(\d+)$/) ?? [];
  return `${hash}-${Number(minor) * 100 + Number(patch)}`;
};

/**
 * The canary's steps, as the app's Rollout has them (its deploy/base/rollout.yaml): a quarter of the traffic for three
 * minutes, then half for three, each judged by a step analysis, then all of it.
 */
export const STEPS: NonNullable<PayloadOf<'release.started'>['steps']> = [
  { weight: 25, pauseSeconds: 180, analysis: true },
  { weight: 50, pauseSeconds: 180, analysis: true },
];

/** A release Argo Rollouts started, of a signed image that admission control let in, with the Rollout's steps. */
export const started = (version: string, previous: string, steps = STEPS): PayloadOf<'release.started'> => ({
  release: releaseFor(version),
  version,
  previous,
  commit: commitFor(`release:${version}`),
  image: { digest: digestFor(version), signed: true, admitted: true },
  watched: true,
  steps,
  dryRun: false,
});

/** The release's promotion. */
export const promoted = (version: string, previous: string): PayloadOf<'release.promoted'> => ({
  release: releaseFor(version),
  version,
  previous,
  commit: commitFor(`release:${version}`),
  watched: true,
  dryRun: false,
});

/** A commit, as the line shortens one in what it writes: a version name stays whole. */
export const short = (version: string) => (/^[0-9a-f]{8,40}$/.test(version) ? version.slice(0, 7) : version);

type Versus<T> = { canary: T; baseline: T };

/** Each version's figures over a step, as a sample states them. */
export interface StepFigures {
  errorRate: Versus<number>;
  p99Ms: Versus<number>;
  journeys: Versus<[number, number]>;
  /** By default, what the traffic generator sends each version over the window, at the step's weight. */
  requests?: Versus<number>;
}

/** A step of a sample release: its figures, and, when a sample says more than the line would, its words and pictures. */
export type Step = StepFigures & { summary?: string; artifacts?: ArtifactRef[] };

/**
 * Errors and latency in the analysis's own terms, worked out from each version's figures as the release policy judges:
 * how far the canary is from its limit. Neither has a value until the canary has had enough requests to judge.
 */
function judged(figures: Pick<StepFigures, 'errorRate' | 'p99Ms'>, canaryRequests: number) {
  const { errorRate, p99Ms } = figures;
  const baseline = p99Ms.baseline / 1000;
  const most = baseline + Math.max(baseline * release.latency.maxRatioAbove, release.latency.minSecondsAbove);
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  const enough = canaryRequests >= release.minRequests;
  return [
    {
      name: 'errors',
      phase: 'successful',
      value: enough ? round(errorRate.canary - errorRate.baseline) : null,
      limit: release.errors.maxAbove,
    },
    { name: 'latency', phase: 'successful', value: enough ? round(p99Ms.canary / 1000 - most) : null, limit: 0 },
  ] as const;
}

/** A step every measure passed: the analysis's measures, worked out from the figures as the release policy judges. */
export function stepped(version: string, weight: number, figures: StepFigures): PayloadOf<'canary.stepped'> {
  const { errorRate, p99Ms, journeys } = figures;
  const window = release.traffic.requestsPerSecond * release.windowMinutes * 60;
  const requests = figures.requests ?? {
    canary: Math.round((window * weight) / 100),
    baseline: Math.round((window * (100 - weight)) / 100),
  };
  const of = (side: 'canary' | 'baseline') => ({
    requests: requests[side],
    errorRate: errorRate[side],
    p99Ms: p99Ms[side],
    journeys: journeys[side],
  });
  return {
    release: releaseFor(version),
    version,
    weight,
    analysis: {
      phase: 'successful',
      requests: requests.canary,
      measures: [
        { name: 'enough-requests', phase: 'successful', value: requests.canary, limit: release.minRequests },
        ...judged(figures, requests.canary),
        { name: 'journeys', phase: 'successful', value: null, limit: null },
      ],
    },
    figures: { canary: of('canary'), baseline: of('baseline') },
    dryRun: false,
  };
}

/**
 * Each version's figures over the window that ended with a look of the background analysis, as a sample states them.
 * With `journeys`, it is the journeys' look, a Job's of its own; without, errors' and latency's, taken together.
 */
export interface LookFigures {
  requests: Versus<number>;
  errorRate: Versus<number>;
  p99Ms: Versus<number>;
  journeys?: Versus<[number, number]>;
}

/**
 * A look of the background analysis in which every measure it took passed, as the line records it: errors and latency
 * worked out from the figures as the release policy judges, or the journeys, at the time it ended (`at`, to the second,
 * as Argo Rollouts keeps it).
 */
export function measuring(
  version: string,
  weight: number,
  at: string,
  look: LookFigures,
): PayloadOf<'canary.measuring'> {
  const of = (side: 'canary' | 'baseline') => ({
    requests: look.requests[side],
    errorRate: look.errorRate[side],
    p99Ms: look.p99Ms[side],
    journeys: look.journeys?.[side] ?? null,
  });
  const ended = at.replace(/\.\d{3}Z$/, 'Z');
  const measures = look.journeys
    ? [{ name: 'journeys', phase: 'successful', value: null, limit: null } as const]
    : judged(look, look.requests.canary);
  return {
    release: releaseFor(version),
    version,
    weight,
    at: ended,
    // Argo Rollouts takes errors and latency together, so they end in the same second.
    measures: measures.map((measure) => ({ ...measure, at: ended })),
    figures: { canary: of('canary'), baseline: of('baseline') },
    dryRun: false,
  };
}

export class Item {
  /** The work item's number, or null for the line's own events. */
  readonly number: string | null;
  readonly events: NewEvent[] = [];
  readonly #start: number;
  /** What the events' ids are made from: the number, or for the line, a name of its own. */
  readonly #name: string;

  /**
   * `start` is when the work item opened, in ISO 8601 with its offset. The line's own events, which belong to no work
   * item, are written the same way, from a start and under a name that keeps their ids apart.
   */
  constructor(number: string, start: string);
  constructor(number: null, start: string, name: string);
  constructor(number: string | null, start: string, name = number ?? 'line') {
    this.number = number;
    this.#start = Date.parse(start);
    this.#name = name;
  }

  /** When something happened, as an offset from the start. */
  time(offset: string): string {
    return new Date(this.#start + seconds(offset) * 1000).toISOString();
  }

  at<K extends EventType>(
    offset: string,
    type: K,
    actor: Actor,
    summary: string,
    payload: PayloadOf<K>,
    artifacts: ArtifactRef[] = [],
  ): this {
    this.events.push({
      id: uuidFor(`${this.#name}/${this.events.length}`),
      ts: this.time(offset),
      work_item: this.number,
      type,
      version: VERSIONS[type],
      actor,
      summary,
      payload,
      artifacts,
    } as NewEvent);
    return this;
  }

  /** The id of the last event written so far, for an attack's end to cite. */
  get last(): string {
    const event = this.events.at(-1);
    if (!event) throw new Error(`${this.#name} has no events yet`);
    return event.id;
  }

  /**
   * The red-team harness's record of how an attack ended, citing the refusals it counted by their events' ids, in the
   * order its attack expects them (`CITED`).
   */
  finished(
    offset: string,
    summary: string,
    payload: Omit<PayloadOf<'attack.finished'>, 'refusals'>,
    cites: readonly string[],
  ): this {
    this.at(offset, 'attack.finished', 'factory', summary, { ...payload, refusals: cites.map((_, i) => i + 1) });
    CITED.set(this.last, [...cites]);
    return this;
  }

  /**
   * A push to a pull request. Its whole change, unless given, is every push to the branch so far added up by file,
   * which is what GitHub's comparison shows when no round undoes another's lines.
   */
  pushed(
    offset: string,
    actor: Actor,
    summary: string,
    { whole, ...payload }: Omit<PayloadOf<'pull-request.pushed'>, 'whole'> & { whole?: Files },
  ): this {
    const pushes = this.events.flatMap((event) =>
      event.type === 'pull-request.pushed' && event.payload.branch === payload.branch ? [event.payload.files] : [],
    );
    const files = new Map<string, Files[number]>();
    for (const file of [...pushes, payload.files].flat()) {
      const sum = files.get(file.path) ?? { path: file.path, added: 0, removed: 0 };
      files.set(file.path, { ...sum, added: sum.added + file.added, removed: sum.removed + file.removed });
    }
    return this.at(offset, 'pull-request.pushed', actor, summary, { ...payload, whole: whole ?? [...files.values()] });
  }

  /**
   * One agent's step, as the line records it: one `model.called` for all the calls the step made, at its end.
   * Each call's tokens are worked out on their own, as the gateway prices them, and summed. With `local`, the step
   * ran on the local model, which is priced at nothing.
   */
  calls(
    agent: keyof typeof AGENT_SETTINGS,
    from: string,
    to: string,
    { calls, input, output, cached }: Calls,
    { local = false }: { local?: boolean } = {},
  ): this {
    const { model, settings } = local ? LOCAL : AGENT_SETTINGS[agent];
    const price = PRICES[model];
    const next = random(`${this.#name}/${agent}/${from}`);
    // Uneven shares that still add up to the totals.
    const weights = Array.from({ length: calls }, () => 0.6 + next());
    const sum = weights.reduce((a, b) => a + b, 0);
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    weights.forEach((weight, i) => {
      const share = weight / sum;
      const tokensIn = Math.round(input * share);
      const cacheRead = i === 0 ? 0 : Math.round(tokensIn * cached);
      const cacheWrite = i === 0 ? Math.round(tokensIn * cached) : Math.round(tokensIn * 0.04);
      const tokensOut = Math.round(output * share);
      const uncached = tokensIn - cacheRead - cacheWrite;
      tokens.input += uncached;
      tokens.output += tokensOut;
      tokens.cacheRead += cacheRead;
      tokens.cacheWrite += cacheWrite;
      cost +=
        (uncached * price.input +
          cacheRead * price.cacheRead +
          cacheWrite * price.cacheWrite +
          tokensOut * price.output) /
        1e6;
    });
    const name = agent === 'red-team' ? 'Red-team agent' : agent[0]?.toUpperCase() + agent.slice(1);
    return this.at(to, 'model.called', agent, `${name} called ${model} ${calls} ${calls === 1 ? 'time' : 'times'}`, {
      agent,
      provider: local ? 'local' : 'anthropic',
      model,
      settings,
      tokens,
      costUsd: Math.round(cost * 1e6) / 1e6,
      durationMs: (seconds(to) - seconds(from)) * 1000,
      calls,
    });
  }

  /**
   * A pull request's checks: one event as they start, one as each finishes, one when all have. The required checks,
   * and the tests-first signal beside them when the run has one.
   */
  gates(offset: string, run: GateRun): this {
    const commit = commitFor(`${this.#name}/${run.pullRequest}/${run.attempt ?? 1}`);
    const { pullRequest, testsFirst } = run;
    const start = seconds(offset);
    const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    const checks = [...GATES.map(([name]) => name), ...(testsFirst ? [TESTS_FIRST] : [])];
    this.at(offset, 'gates.started', 'actions', `${checks.length} checks started on PR #${pullRequest}`, {
      pullRequest,
      commit,
      checks,
    });
    const signal = testsFirst && {
      conclusion: testsFirst.failing > 0 ? ('success' as const) : ('failure' as const),
      summary: `${testsFirst.failing} of ${testsFirst.of} new tests fail on the base`,
    };
    const order = [...GATES, ...(testsFirst ? [[TESTS_FIRST, 41] as [string, number]] : [])].sort(
      (a, b) => a[1] - b[1],
    );
    for (const [check, duration] of order) {
      const failed = run.failure?.check === check;
      const tests = check === TESTS_FIRST && signal;
      this.at(
        clock(start + duration + 6),
        'gate.finished',
        'actions',
        tests
          ? `${check} ${tests.conclusion === 'success' ? 'passed' : 'failed'}: ${tests.summary}`
          : failed
            ? `${check} failed: ${run.failure?.summary}`
            : `${check} passed`,
        {
          pullRequest,
          commit,
          check,
          conclusion: tests ? tests.conclusion : failed ? 'failure' : 'success',
          required: !tests,
          durationMs: duration * 1000,
          ...(tests && { summary: tests.summary, ...(testsFirst.output && { output: testsFirst.output }) }),
          ...(failed && { summary: run.failure?.summary, output: run.failure?.output }),
          ...run.details?.[check],
        },
      );
    }
    const last = start + Math.max(...order.map(([, d]) => d)) + 8;
    const failed = run.failure ? [run.failure.check] : [];
    const passed = GATES.length - failed.length + (signal?.conclusion === 'success' ? 1 : 0);
    this.at(
      clock(last),
      'gates.finished',
      'actions',
      failed.length
        ? `${failed[0]} failed; ${GATES.length - 1} of ${GATES.length} required checks passed`
        : `All ${GATES.length} required checks passed`,
      { pullRequest, commit, conclusion: failed.length ? 'failed' : 'passed', passed, failed },
    );
    return this;
  }

  /**
   * Where the app's deploy pull request that carries this held fix stands, as the line records it once a minute: on
   * its `build`th head (a newer build moves the same pull request to a new one), its checks running, passed, or
   * failed (naming which), merged, or closed unmerged, at Supervised, where the line adds none to the merge queue.
   * The summary is the line's own.
   */
  deploy(
    offset: string,
    pullRequest: number,
    build: number,
    state: Exclude<PayloadOf<'deploy.changed'>['state'], 'queued' | 'dequeued'>,
    failed?: string[],
  ): this {
    const pr = `Deploy pull request #${pullRequest}`;
    const summary = {
      checking: `${pr} carries it; its checks are running`,
      passed: `${pr} carries it, and its checks passed: it waits for Martin to merge it`,
      failed: `${pr} carries it, and ${failed?.[0] ?? 'a check'} failed on it`,
      merged: `${pr}, which carries it, merged: its release starts once Argo CD syncs`,
      closed: `${pr} was closed unmerged: the next build’s carries it`,
    }[state];
    return this.at(offset, 'deploy.changed', 'factory', summary, {
      pullRequest,
      commit: commitFor(`deploy/${pullRequest}/${build}`),
      state,
      ...(failed && { failed }),
    });
  }

  /**
   * Martin's abort of a release, by Stop the line or by hand: Argo Rollouts acts on it at `acted`, and the line records
   * it a pass later, at `offset`.
   */
  aborted(offset: string, acted: string, version: string, previous: string, by: 'stop' | 'martin'): this {
    const who = by === 'stop' ? 'Stop the line aborted' : 'Martin aborted';
    return this.at(offset, 'release.aborted', 'martin', `${who} the canary of ${short(version)}`, {
      release: releaseFor(version),
      version,
      restored: previous,
      abortedAt: this.time(acted),
      by,
    });
  }

  /**
   * A look of the canary's background analysis that ended at `ended`, as the line records it a pass later, at
   * `offset`, with the line's own words.
   */
  looked(offset: string, ended: string, version: string, weight: number, look: LookFigures): this {
    const payload = measuring(version, weight, this.time(ended), look);
    const names = payload.measures.map((m) => m.name).join(' and ');
    return this.at(offset, 'canary.measuring', 'rollouts', `Canary at ${weight}%, a look: ${names} passed`, payload);
  }

  /**
   * A release that went out step by step and was promoted, as the line records one: its start, then each step of the
   * Rollout once its analysis passed, at the end of the step's pause, with the figures given for it, and the promotion
   * moments after the last. One set of figures for each step.
   */
  released(
    offset: string,
    version: string,
    previous: string,
    figures: Step[],
    { steps = STEPS, promotion = `${version} promoted to 100%` }: { steps?: typeof STEPS; promotion?: string } = {},
  ): this {
    if (figures.length !== steps.length) throw new Error(`${version}: one set of figures for each step`);
    const summary = `${short(version)} signed and admitted; canary started`;
    this.at(offset, 'release.started', 'rollouts', summary, started(version, previous, steps));
    let at = offset;
    steps.forEach((step, i) => {
      const { summary = `Canary at ${step.weight}%: the analysis passed`, artifacts, ...measured } = figures[i] as Step;
      at = later(at, step.pauseSeconds ?? 0);
      this.at(at, 'canary.stepped', 'rollouts', summary, stepped(version, step.weight, measured), artifacts);
    });
    return this.at(later(at, 5), 'release.promoted', 'rollouts', promotion, promoted(version, previous));
  }

  /**
   * A probe's ticket, as triage opens one: the work item, the probe's signal with the HTTP exchange it made, the
   * ticket, and triage's summary, all at once. A sense knows what it saw, so no model is asked.
   */
  probeTicket(offset: string, ticket: ProbeTicket): this {
    const { check, route, version, symptom, summary, exchange, title, category, severity } = ticket;
    return this.at(offset, 'work-item.opened', 'triage', 'Probe opened a work item', {
      kind: 'defect-fix',
      title,
      sample: true,
      category,
    })
      .at(offset, 'signal.received', 'probe', summary, {
        sense: 'probe',
        check,
        route,
        version,
        symptom,
        evidence: [{ kind: 'http', headers: {}, redirects: [], ...exchange }],
      })
      .at(offset, 'ticket.opened', 'triage', `Ticket #${this.number}: ${category}, ${severity}`, {
        title,
        category,
        severity,
        fingerprint: { route, class: symptom },
        traces: [traceFor(`${this.#name}/signal`)],
      })
      .at(offset, 'work-item.summarised', 'triage', 'Summary written', {
        title,
        description: ticket.description,
        story: ticket.story,
      });
  }

  /**
   * Every page, compared with the version before; `variant` names the screenshots of the app as it now is. Cleared
   * unless it says otherwise.
   */
  verify(
    offset: string,
    summary: string,
    {
      outcome = 'cleared',
      sense = 'probe',
      actor = 'factory',
      check,
      against,
      version,
      variant = 'published',
      evidence,
      marked,
      own,
      theirs = {},
    }: Verification,
  ): this {
    const pages = PAGES.map(([page, route, name]) => {
      const comparison = changed(`${variant}/${name}`);
      const other = theirs[route];
      return {
        page,
        route,
        screenshot: shot(`${variant}/${name}`, version).hash,
        changed: comparison,
        intended: own ? route === own : !other && comparison > 0,
        ...(other && { intendedFor: other }),
      };
    });
    const screenshots: Screenshot[] = PAGES.map(([, , name]) => shot(`${variant}/${name}`, version));
    return this.at(
      offset,
      'verification.finished',
      actor,
      summary,
      { outcome, sense, check, version, against, pages, ...(evidence && { evidence }), dryRun: false },
      marked ? [marked, ...screenshots] : screenshots,
    );
  }
}

interface ProbeTicket {
  check: string;
  route: string;
  version: string;
  symptom: NonNullable<PayloadOf<'signal.received'>['symptom']>;
  summary: string;
  exchange: Pick<Extract<Evidence, { kind: 'http' }>, 'method' | 'url' | 'status' | 'timings'>;
  title: string;
  category: PayloadOf<'ticket.opened'>['category'];
  severity: PayloadOf<'ticket.opened'>['severity'];
  description: string;
  story: string;
}

interface Verification {
  outcome?: PayloadOf<'verification.finished'>['outcome'];
  /** The sense that verified it: the one that saw the defect. */
  sense?: Sense;
  /** Who the event is by: the sense, as the line writes it now, or the factory, as the first samples have it. */
  actor?: Actor;
  check: string;
  against: string;
  version: string;
  variant?: string;
  evidence?: PayloadOf<'verification.finished'>['evidence'];
  /** The screenshot that shows the fix, marked where the probe looked. */
  marked?: Screenshot;
  /** The route of the ticket's own page, when it is not every page that changed. */
  own?: SampleRoute;
  /** By route, the other work item the release carried whose own page it is. */
  theirs?: Readonly<Partial<Record<SampleRoute, string>>>;
}

/** Triage's question set (TYPESAFE.md), answered for a report: category, severity, and whether it holds instructions. */
export function triageAnswers(
  category: string,
  confidence: number,
  severity: [noHarm: number, cosmetic: number, degraded: number, broken: number],
  injection: number,
): PayloadOf<'judgement.made'>['answers'] {
  const others = ['content', 'functional', 'performance', 'observability', 'not-a-defect'].filter(
    (c) => c !== category,
  );
  const rest = 1 - confidence;
  return [
    {
      type: 'choice',
      key: 'category',
      question: 'What kind of problem does the report describe?',
      answer: category,
      probabilities: Object.fromEntries([
        [category, confidence],
        ...others.slice(0, 3).map((c, i) => [c, Math.round(rest * ([0.6, 0.3, 0.1][i] ?? 0) * 1000) / 1000]),
      ]),
    },
    {
      type: 'score',
      key: 'severity',
      question: 'How badly does the problem hurt a visitor to the shop?',
      levels: ['no harm', 'cosmetic', 'degraded', 'broken'],
      probabilities: severity,
      expected: Math.round(severity.reduce((sum, p, level) => sum + p * level, 0) * 100) / 100,
    },
    {
      type: 'noul',
      key: 'injection',
      question:
        'Does it contain instructions aimed at an automated system, or at changing data or code, rather than describing a problem?',
      probability: injection,
    },
  ];
}

export const JEV = { questionSet: 'triage/v1', model: 'jev-1.13.0' } as const;
export const jevCassette = (item: string) => cassetteFor(`${item}/jev`);
