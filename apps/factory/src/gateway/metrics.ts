/**
 * The gateway's OpenTelemetry metrics. Until `telemetry.ts` starts an SDK these are no-ops, so tests and the
 * in-process gateway need none. Attributes are agent, provider, model and outcome, as the `model call` span names
 * them (`spans.ts`), and a few closed sets beside them (a token's kind, a provider's status, a cap): never a work
 * item, which would make a series for each, and never anything from a request.
 *
 * Each count starts at 0 as the gateway starts, for every label set it can count from closed sets (`zeroCounts`):
 * Prometheus's `increase` and `changes` read nothing into a series' first sample, so a series that started at 1 would
 * lose the first call, refusal or error of each kind after every restart, and the first call's spend.
 */
import { type BatchObservableResult, metrics } from '@opentelemetry/api';
import type { Profile } from '../../../../policy/spend.ts';
import type { ProviderErrorKind, SpendCapped } from './errors.ts';
import type { Outcome } from './gateway.ts';

const meter = metrics.getMeter('factory-gateway');

export const calls = meter.createCounter('gateway.calls', {
  description: 'Calls to the gateway, by agent, provider, model and outcome (answered, replayed, refused, failed)',
});

/**
 * Every priced call's cost, a judgement's or an agent's, as the gateway counts it, whatever event records it: the
 * line's dashboard reads it as `factory_gateway_spend_usd_total` (`deploy/base/telemetry/dashboards/line.json`).
 */
export const SPEND_METRIC = 'factory_gateway_spend_usd';

export const spend = meter.createCounter(SPEND_METRIC, {
  description: 'Model spend counted by the gateway, in US dollars',
});

export const latency = meter.createHistogram('gateway.call.duration', {
  description: 'How long a call took, a replay included',
  unit: 'ms',
});

/** What a token was spent on, as the span's `input_tokens`, `output_tokens`, `cache_read_tokens` and `cache_write_tokens`. */
export type TokenKind = 'input' | 'output' | 'cache_read' | 'cache_write';

/** A provider's error that is not an HTTP status: `providerErrors`' closed `status`es. */
export type ProviderFailure = 'network' | 'timeout' | 'malformed' | 'broken';

/** A cap a call is refused at: the factory's own, or a provider's (`capRefusals`). */
export type CapRefused = SpendCapped['cap'] | 'provider';

/**
 * Tokens, as the audit row counts them: an answered call's, a failed call's that the provider billed (a stream that
 * broke off), and a replay's as its cassette recorded them, which cost nothing. `outcome` tells them apart. A kind
 * a call used none of is not counted.
 */
export const tokens = meter.createCounter('gateway.tokens', {
  description:
    'Tokens in calls the gateway took, by agent, provider, model, outcome and kind (input, output, cache_read, cache_write)',
});

/**
 * A provider that answered with an error, or not at all: `status` is the HTTP status it answered (`429`, `529`, a
 * refusal for spent credit's `400`), or what happened instead: `network` (it could not be reached), `timeout`,
 * `malformed` (it answered with something other than an answer), or `broken` (a stream that reported an error or
 * broke off). Each failed attempt counts, TypeSafe's retried ones included. A runner that goes away is not the
 * provider's error, nor a cassette that no longer reads, and neither is counted.
 */
export const providerErrors = meter.createCounter('gateway.provider.errors', {
  description: 'Errors from a model provider, by agent, provider, model and status',
});

/**
 * Calls refused because a cap was reached, before anything was sent: `cap` is `day`, `month` or `work-item` (the
 * factory's own, `policy/spend.ts`), or `provider` (one it does not own: spent credit, a workspace's limit, or the
 * local model not listening, `provider-caps.ts`). A refusal for no cassette, or for a request the gateway will not
 * send, is only an `outcome` on `gateway.calls`.
 */
export const capRefusals = meter.createCounter('gateway.cap.refusals', {
  description: 'Calls refused for a spend cap, by agent, provider, model and cap (day, month, work-item, provider)',
});

/**
 * Judgements answered 401, without triage's token: triage's token not the gateway's, or another caller asking. Either
 * pages (`JudgementsUnauthorized`). It has no labels: nothing about the caller is known but that it was wrong.
 */
export const unauthorizedJudgements = meter.createCounter('gateway.judgements.unauthorized', {
  description: "Judgements answered 401 because they did not carry triage's token",
});

const capSpent = meter.createObservableGauge('gateway.cap.spent_usd', {
  description: "Model spend so far in the day's and the month's window, by cap (day, month) and profile, in US dollars",
});

const capLimit = meter.createObservableGauge('gateway.cap.limit_usd', {
  description:
    'The spend caps in force, by cap (day, month, work-item) and profile, in US dollars; NO_CAP (-1) for a month with none',
});

/**
 * What `gateway.cap.limit_usd` reads for a month with no cap: a figure no cap can be, which the alert and the
 * dashboards leave out. Always reported, so a cap that is lifted stops at once: a series no longer observed would go on
 * being sent at its last figure by the SDK, and page for a cap that is gone.
 */
export const NO_CAP = -1;

// Each closed set as a record, so a value added to its type and left out here fails to type-check.
const OUTCOMES: Record<Outcome, true> = { answered: true, replayed: true, refused: true, failed: true };
const KINDS: Record<TokenKind, true> = { input: true, output: true, cache_read: true, cache_write: true };
const FAILURES: Record<ProviderFailure, true> = { network: true, timeout: true, malformed: true, broken: true };
const CAPS: Record<CapRefused, true> = { day: true, month: true, 'work-item': true, provider: true };

/** Whose calls a series counts: an agent's, on the provider and model the gateway sends them to. */
export interface Route {
  agent: string;
  provider: string;
  model: string;
}

/**
 * Starts each count at 0 for each label set the routes can count, so the first of each after a restart is counted.
 * An agent's calls (`messages`) can end each way, use each kind of token (a refusal uses none), fail at the provider
 * without a status, and be refused at each cap. A judgement uses only input and output tokens, as it is answered or
 * replayed; TypeSafe's errors without a status are its kinds `network`, `timeout` and `malformed`; and the provider's
 * own caps are only agents'. An HTTP status is an open set, so the first of each status is still lost. Adding 0
 * again is harmless.
 */
export function zeroCounts(messages: readonly Route[], judgements: readonly Route[]): void {
  const every = <K extends string>(set: Record<K, true>) => Object.keys(set) as K[];
  zero(messages, {
    tokens: ['answered', 'replayed', 'failed'],
    kinds: every(KINDS),
    statuses: every(FAILURES),
    caps: every(CAPS),
  });
  const typesafe: ProviderErrorKind[] = ['network', 'timeout', 'malformed'];
  zero(judgements, {
    tokens: ['answered', 'replayed'],
    kinds: ['input', 'output'],
    statuses: typesafe,
    caps: every(CAPS).filter((cap) => cap !== 'provider'),
  });
  unauthorizedJudgements.add(0);
}

interface Sets {
  /** The outcomes that count tokens. */
  tokens: Outcome[];
  kinds: TokenKind[];
  statuses: string[];
  caps: CapRefused[];
}

function zero(routes: readonly Route[], { tokens: used, kinds, statuses, caps }: Sets): void {
  for (const route of routes) {
    const series = { agent: route.agent, provider: route.provider, model: route.model };
    spend.add(0, series);
    for (const outcome of Object.keys(OUTCOMES)) calls.add(0, { ...series, outcome });
    for (const outcome of used) for (const kind of kinds) tokens.add(0, { ...series, outcome, kind });
    for (const status of statuses) providerErrors.add(0, { ...series, status });
    for (const cap of caps) capRefusals.add(0, { ...series, cap });
  }
}

/** The spend against the profile's caps, as `Spend` last counted it. */
export interface CapReading {
  profile: Profile;
  dayUsd: number;
  monthUsd: number;
  limits: { dayUsd: number; monthUsd: number | null; workItemUsd: number };
}

/**
 * Reports spend against the caps whenever metrics are collected, from `read`, which gives nothing until it knows.
 * One series a cap, never one a work item: a work item's cap is reported, and what each spends is the audit log's.
 * A month with no cap reads `NO_CAP`.
 * Returns what stops it.
 */
export function observeCaps(read: () => CapReading | undefined): () => void {
  const observe = (result: BatchObservableResult) => {
    const reading = read();
    if (!reading) return;
    const { profile, limits } = reading;
    result.observe(capSpent, reading.dayUsd, { cap: 'day', profile });
    result.observe(capSpent, reading.monthUsd, { cap: 'month', profile });
    result.observe(capLimit, limits.dayUsd, { cap: 'day', profile });
    result.observe(capLimit, limits.monthUsd ?? NO_CAP, { cap: 'month', profile });
    result.observe(capLimit, limits.workItemUsd, { cap: 'work-item', profile });
  };
  meter.addBatchObservableCallback(observe, [capSpent, capLimit]);
  return () => meter.removeBatchObservableCallback(observe, [capSpent, capLimit]);
}
