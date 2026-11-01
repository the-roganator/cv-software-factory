/**
 * Agents' calls: the gateway's Messages API, `POST /v1/messages` in Anthropic's own shape, streaming included, for
 * runners. A runner's Agent SDK points `ANTHROPIC_BASE_URL` here, with its job token where an API key would go.
 *
 * For each call the gateway:
 *
 * 1. Takes the job token (`x-api-key`, or `Authorization: Bearer`) and finds the job it was made for, while the job
 *    has not ended: that names the work item and the agent. It refuses every call while the line is stopped. Only
 *    then does it read the body. The store notifies every append on its `events` channel, and the gateway, listening
 *    there, reads the line's state again before it answers the next call, so a stop is refused from the first call
 *    after it is heard. Otherwise it keeps the state it read for a few seconds (`LINE_FRESH_MS`), which is how long a
 *    stop goes unseen when a notification is lost: while the listening connection is down, until it listens again or
 *    those seconds run out, whichever is first; or when it could not listen at all, which it logs.
 * 2. Takes only what it knows: the request's fields, its betas and its tools are allow-listed (`REQUEST`, `BETAS`).
 *    A server tool, such as web search, would let a fenced agent reach the web through the gateway and would cost
 *    what the caps do not count, so only the runner's own tools are allowed.
 * 3. Sends the call where the settings in force say (Martin's, within `policy/models.ts`; `settings.ts`): the provider,
 *    the pinned model and, for Claude, the effort, whatever the runner asked for. A job runs under the settings in force
 *    when its token was issued, read at its first call and kept for it, so a change applies from an agent's next step,
 *    never part-way through one. `ALL_LOCAL` sends every agent to the profile's local model, whatever the settings say.
 *    The local model is sent no effort: LM Studio's own setting decides it.
 * 4. Answers from a cassette, keyed as `agent-cassettes.ts` says, when its mode replays; otherwise checks the spend
 *    caps, asks the provider, relays the answer as it arrives, and records a cassette.
 * 5. Writes one audit row in `model_calls` for every call, answered or not, with its tokens, cache use and cost. A
 *    stream that breaks off is audited at what it had cost by then: the provider bills what it generated. The same
 *    figures go on the call's `model call` span, a child of the step's span the job token keeps (`spans.ts`).
 * 6. Records each refusal of a guardrail on the job's work item (`refusals.ts`): an agent that calls no model, the
 *    line stopped, a provider capped for its credit or its workspace's limit, a spend cap reached.
 *
 * Prompt caching passes through untouched: the runner's `cache_control` markers reach the provider as sent.
 *
 * Errors keep Anthropic's shape (`{ type: "error", error: { type, message } }`), so the Agent SDK reads them as it
 * would Anthropic's: it retries a 429 after `retry-after`, and gives up on a 4xx.
 */

import { context, propagation, ROOT_CONTEXT, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { cutTo } from '@software-factory/events';
import { IgnoredCommands, jobForToken, lineStopped, listen } from '@software-factory/store';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { type AgentModel, MODEL_AGENTS, MODELS, type ModelAgent } from '../../../../policy/models.ts';
import { type InForce, inForce } from '../../../../policy/settings.ts';
import type { Profile } from '../../../../policy/spend.ts';
import type { Logger } from '../log.ts';
import type { SettingsReader } from '../settings.ts';
import { ATTRIBUTES as A, tracer } from '../spans.ts';
import { type AgentCassettes, agentCassetteKey, keyedRequest } from './agent-cassettes.ts';
import { SpendCapped } from './errors.ts';
import type { Mode, Outcome } from './gateway.ts';
import * as instruments from './metrics.ts';
import { costOf, priceOf, type Usage } from './prices.ts';
import type { ProviderCaps } from './provider-caps.ts';
import { capOf, forwardedHeaders, type MessagesProvider, type ProviderName } from './providers.ts';
import type { GatewayCause, Refusals } from './refusals.ts';
import type { Spend } from './spend.ts';

export interface Reply {
  status: number;
  headers: Record<string, string>;
  /** A whole body, or a stream relayed chunk by chunk. */
  body: string | AsyncIterable<Uint8Array>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** An error in Anthropic's shape. Its message never holds the request. */
export const apiError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  json(status, { type: 'error', error: { type, message } }, headers);

/**
 * The betas a runner may send: those the pinned Agent SDK sends. One it adds after an upgrade is refused until it is
 * added here, after a look at what it does.
 */
export const BETAS = new Set([
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'per-turn-control-2026-07-01',
  'mid-conversation-tool-changes-2026-07-01',
  'effort-2025-11-24',
  'thinking-display-updates-2026-08-18',
]);

/** A tool the runner runs itself. A server tool has a `type` (`web_search_…`, `code_execution_…`), and is refused. */
const clientTool = z.looseObject({
  name: z.string().min(1).max(128),
  input_schema: z.record(z.string(), z.unknown()),
  type: z.literal('custom').optional(),
});

/** What a runner may ask for: the fields the Agent SDK sends, and nothing that changes what a call costs or reaches. */
export const REQUEST = z.strictObject({
  model: z.string().max(100),
  max_tokens: z.number().int().positive().max(128_000),
  messages: z.array(z.looseObject({ role: z.enum(['user', 'assistant', 'system']) })).min(1),
  system: z.union([z.string(), z.array(z.looseObject({ type: z.literal('text') }))]).optional(),
  tools: z.array(clientTool).max(200).optional(),
  tool_choice: z.looseObject({ type: z.string() }).optional(),
  metadata: z.strictObject({ user_id: z.string().max(1000).optional() }).optional(),
  stream: z.boolean().optional(),
  thinking: z.looseObject({ type: z.string() }).optional(),
  stop_sequences: z.array(z.string()).max(8).optional(),
  temperature: z.number().optional(),
  output_config: z.strictObject({ effort: z.string().optional(), format: z.unknown().optional() }).optional(),
  context_management: z
    .strictObject({
      edits: z.array(z.looseObject({ type: z.string().regex(/^clear_(thinking|tool_uses)_\d{8}$/) })).max(10),
    })
    .optional(),
});

export interface AgentCallsOptions {
  sql: Sql;
  spend: Spend;
  caps: ProviderCaps;
  cassettes: AgentCassettes;
  /** What was asked for. A provider the gateway has no way to reach is replayed only. */
  mode: Mode;
  profile: Profile;
  /** Every agent to the profile's local model, whatever the settings say. */
  allLocal: boolean;
  /** Martin's settings, as each job's are read; without them, policy's defaults are in force. */
  settings?: SettingsReader;
  providers: Partial<Record<ProviderName, MessagesProvider>>;
  log: Logger;
  clock?: () => Date;
  /** How long a provider may take over one call, streaming included. */
  providerTimeoutMs?: number;
  /** Where each refusal of a guardrail is recorded; without it, none is. */
  refusals?: Refusals;
}

type Headers = Record<string, string | string[] | undefined>;

/** Whose call it is: the job its token was issued for, whose issue decides the settings the job runs under. */
type Who = Pick<Call, 'job' | 'workItem' | 'agent'>;

/** A call refused before the gateway takes its request: the answer, and the refusal to record, if it is one. */
type Refused = Reply & { refused?: { workItem: string; agent: string; cause: GatewayCause; message: string } };

interface Call {
  job: string;
  workItem: string;
  agent: ModelAgent;
  provider: ProviderName;
  model: string;
}

/**
 * Where an agent's calls go under the settings in force, or to the profile's local model under `ALL_LOCAL`: Bedrock's
 * go to Anthropic's API until Bedrock has a provider here.
 */
function routeOf(
  profile: Profile,
  settings: InForce,
  agent: ModelAgent,
  allLocal: boolean,
): { chosen: AgentModel; provider: ProviderName } {
  const local = MODELS[profile].local;
  if (allLocal && !local) throw new Error(`The ${profile} profile has no local model to send every agent to.`);
  const chosen: AgentModel = allLocal && local ? { provider: 'local', model: local.model } : settings.agents[agent];
  return { chosen, provider: chosen.provider === 'local' ? 'local' : 'anthropic' };
}

const providerOf = (model: AgentModel['provider']): ProviderName => (model === 'local' ? 'local' : 'anthropic');

/** Every route an agent's calls may take on a profile, each model policy lets it use, as its calls' series are labelled. */
export function routes(profile: Profile, allLocal: boolean): instruments.Route[] {
  const policy = MODELS[profile];
  return MODEL_AGENTS.flatMap((agent) => {
    if (allLocal) {
      const { chosen, provider } = routeOf(profile, inForce(profile), agent, true);
      return [{ agent, provider, model: chosen.model }];
    }
    return policy.models
      .filter((m) => policy.agents[agent].models.includes(m.model))
      .map((m) => ({ agent, provider: providerOf(m.provider), model: m.model }));
  });
}

/** How long the line's state is trusted before it is read again, when no append has been heard since it was read. */
const LINE_FRESH_MS = 5_000;
const PROVIDER_TIMEOUT_MS = 15 * 60_000;

const header = (headers: Headers, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value.join(',') : value;
};

export class AgentCalls {
  readonly #o: AgentCallsOptions;
  /** The line's state as last read, when, and how many appends had been heard when the read began. */
  #line: { stopped: boolean; at: number; heard: number } | undefined;
  /** The appends heard on the store's `events` channel, and each time it listened again after a dropped connection. */
  #heard = 0;
  #listening: { unlisten: () => Promise<void> } | undefined;
  /** Martin's commands that a role not his appended: ignored, and each logged once. */
  readonly #ignored: IgnoredCommands;

  constructor(options: AgentCallsOptions) {
    this.#o = options;
    this.#ignored = new IgnoredCommands(options.sql, options.log);
  }

  #now(): number {
    return (this.#o.clock?.() ?? new Date()).getTime();
  }

  /**
   * Listens for appends, so a stop or start is seen at the next call. After a dropped connection the client listens
   * again, which counts as heard too: what was appended meanwhile went unheard. If it cannot listen, the gateway reads
   * the line every few seconds, as it would after a lost notification, and logs why.
   */
  async start(): Promise<void> {
    const hear = () => {
      this.#heard++;
    };
    try {
      this.#listening = await listen(this.#o.sql, hear, hear);
    } catch (error) {
      this.#o.log.warn(
        { err: error },
        `could not listen for appends: a stop of the line is seen within ${LINE_FRESH_MS / 1000}s, not at once`,
      );
    }
  }

  /** Stops listening. */
  async stop(): Promise<void> {
    const listening = this.#listening;
    this.#listening = undefined;
    await listening?.unlisten();
  }

  /**
   * One call. `read` gives the body, and is called only once the token is good. `gone` is aborted when the runner
   * goes away, which stops the call to the provider.
   */
  async messages(headers: Headers, read: () => Promise<string>, gone?: AbortSignal): Promise<Reply> {
    const started = performance.now();
    const startTime = new Date();
    const authorised = await this.#authorise(headers);
    if ('status' in authorised) {
      const { refused, ...reply } = authorised;
      if (refused) this.#refused(refused.workItem, refused.agent, refused.cause, refused.message);
      return reply;
    }
    const { traceparent, ...who } = authorised;
    const betas = (header(headers, 'anthropic-beta') ?? '')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    const unknown = betas.filter((b) => !BETAS.has(b));
    if (unknown.length)
      return apiError(400, 'invalid_request_error', `The gateway does not allow the beta ${unknown.join(', ')}.`);
    let body: z.infer<typeof REQUEST>;
    try {
      const parsed = REQUEST.safeParse(JSON.parse(await read()));
      if (!parsed.success) {
        const problems = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(body)'}: ${i.code}`);
        return apiError(
          400,
          'invalid_request_error',
          `The gateway does not take this request (${problems.join('; ')}).`,
        );
      }
      body = parsed.data;
    } catch (error) {
      if (error instanceof SyntaxError) return apiError(400, 'invalid_request_error', 'The body is not JSON.');
      throw error;
    }
    // The call's span: under its step's when the job's token keeps one, and linked to the request that carried it;
    // otherwise under the request.
    const step = traceparent ? propagation.extract(ROOT_CONTEXT, { traceparent }) : context.active();
    const request = trace.getActiveSpan()?.spanContext();
    const span = tracer.startSpan(
      'model call',
      {
        startTime,
        attributes: { [A.workItem]: who.workItem, [A.job]: who.job, [A.agent]: who.agent },
        ...(traceparent && request ? { links: [{ context: request }] } : {}),
      },
      step,
    );
    try {
      return await context.with(trace.setSpan(step, span), () => this.#call(who, body, headers, span, started, gone));
    } catch (error) {
      // Audited calls end their span; one that threw before it was audited ends it here.
      if (span.isRecording()) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error)?.message });
        span.end();
      }
      throw error;
    }
  }

  /** A call whose request the gateway takes, inside its span, which its audit ends. */
  async #call(
    who: Who,
    body: z.infer<typeof REQUEST>,
    headers: Headers,
    span: Span,
    started: number,
    gone?: AbortSignal,
  ): Promise<Reply> {
    const { profile, settings, allLocal } = this.#o;
    const { chosen, provider } = routeOf(
      profile,
      settings ? await settings.ofJob(who.job) : inForce(profile),
      who.agent,
      allLocal,
    );
    const call: Call = { job: who.job, workItem: who.workItem, agent: who.agent, provider, model: chosen.model };
    span.setAttributes({ [A.provider]: provider, [A.model]: chosen.model });
    priceOf(chosen.model);
    // The model and effort in force, whatever the runner asked for. The local model takes no effort (LM Studio's own
    // setting decides), so none is sent, and none reaches its cassettes' keys.
    const sent: Record<string, unknown> =
      chosen.provider === 'local'
        ? withoutEffort({ ...body, model: chosen.model })
        : { ...body, model: chosen.model, output_config: { ...body.output_config, effort: chosen.effort } };
    const stream = sent.stream === true;
    const keyed = keyedRequest(sent);
    const key = agentCassetteKey(provider, keyed);
    const { cassettes, spend, caps, mode, providers, log } = this.#o;
    const audit = (outcome: Outcome, usage: Usage = NO_USAGE, reason?: string) =>
      this.#audit(call, span, key, outcome, usage, performance.now() - started, reason);
    const series = { agent: call.agent, provider, model: call.model };
    const providerError = (status: instruments.ProviderFailure | `${number}`) =>
      instruments.providerErrors.add(1, { ...series, status });

    const replaying = mode === 'replay' || mode === 'replay-record';
    const stored = replaying ? cassettes.find(key) : undefined;
    if (stored) {
      await audit('replayed', usageOf(stored.response, stored.stream) ?? NO_USAGE);
      return { status: 200, headers: { 'content-type': contentType(stored.stream) }, body: stored.response };
    }
    const target = providers[provider];
    if (mode === 'replay' || !target) {
      await audit('refused', undefined, 'no cassette');
      return apiError(
        400,
        'invalid_request_error',
        `No cassette ${key} holds this call, and the gateway may only replay ${provider}.`,
      );
    }
    const held = caps.heldFor(provider);
    if (held) {
      instruments.capRefusals.add(1, { ...series, cap: 'provider' });
      await audit('refused', undefined, held.reason);
      const message = `${provider} refuses calls for now (${held.reason}): ${held.message}`;
      // A provider out of credit or at its workspace's limit is a cap; one unreachable is an outage, which no guardrail
      // refused.
      if (held.reason !== 'unreachable') {
        this.#refused(call.workItem, call.agent, 'cap', message, `while ${provider} is at its ${held.reason} cap`);
      }
      return apiError(429, 'rate_limit_error', message, { 'retry-after': '300' });
    }
    try {
      await spend.check(call.workItem);
    } catch (error) {
      if (!(error instanceof SpendCapped)) throw error;
      instruments.capRefusals.add(1, { ...series, cap: error.cap });
      await audit('refused', undefined, error.message);
      this.#refused(call.workItem, call.agent, 'cap', error.message, `at the ${error.cap} spend cap`);
      // A day's or month's cap resets; a work item's does not, and holds the work item for Martin.
      return error.resets
        ? apiError(429, 'rate_limit_error', error.message, {
            'retry-after': String(Math.max(1, Math.ceil((Date.parse(error.resets) - this.#now()) / 1000))),
          })
        : apiError(403, 'permission_error', error.message);
    }

    // The call ends when it takes too long, or when the runner has gone: nobody would read the rest.
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.#o.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS),
      ...(gone ? [gone] : []),
    ]);
    let response: Response;
    try {
      response = await target.send('/v1/messages', JSON.stringify(sent), forwardedHeaders(headers), signal);
    } catch (error) {
      const message = cutTo(`${provider} could not be reached (${causeOf(error)})`, 300);
      // A runner that went away is not the provider's error.
      if (!gone?.aborted) providerError(signal.aborted ? 'timeout' : 'network');
      await audit('failed', undefined, message);
      // Nothing listening on the local model is a cap: it waits for Martin to start LM Studio.
      if (provider === 'local' && !signal.aborted) await caps.cap('local', { reason: 'unreachable', message });
      return provider === 'local'
        ? apiError(429, 'rate_limit_error', message, { 'retry-after': '300' })
        : apiError(502, 'api_error', message);
    }
    if (!response.ok) {
      // Counted before the body is read, which can break off too.
      providerError(`${response.status}`);
      const errorBody = await response.text();
      const refusal = capOf(response.status, errorBody);
      await audit('failed', undefined, `${provider} answered ${response.status}`);
      if (refusal) {
        await caps.cap(provider, refusal);
        // The first refusal is the cap's as much as those held after it.
        const message = `${provider} refuses calls for now (${refusal.reason}): ${refusal.message}`;
        this.#refused(call.workItem, call.agent, 'cap', message, `while ${provider} is at its ${refusal.reason} cap`);
        return apiError(429, 'rate_limit_error', message, { 'retry-after': '300' });
      }
      // Anything else is the provider's to say: a rate limit, an overload, a request it will not take.
      const retryAfter = response.headers.get('retry-after');
      return {
        status: response.status,
        headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) },
        body: errorBody,
      };
    }
    void caps.clear(provider);

    const record = (raw: string) => {
      if (mode === 'live') return;
      try {
        cassettes.record({
          key,
          kind: 'messages',
          provider,
          model: chosen.model,
          recordedAt: new Date(this.#now()).toISOString(),
          request: keyed,
          stream,
          response: raw,
        });
      } catch (error) {
        log.warn(
          { cassette: key, reason: (error as NodeJS.ErrnoException).code ?? 'unknown' },
          'the cassette could not be written',
        );
      }
    };
    if (!stream || !response.body) {
      const raw = await response.text().catch((error: unknown) => {
        if (!gone?.aborted) providerError(signal.aborted ? 'timeout' : 'broken');
        throw error;
      });
      const usage = usageOf(raw, false);
      if (!usage) {
        providerError('malformed');
        await audit('failed', undefined, `${provider} answered 200 with something other than a message`);
        return apiError(502, 'api_error', `${provider} answered with something other than a message.`);
      }
      await audit('answered', usage);
      await spend.reconcile();
      record(raw);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: raw };
    }
    return {
      status: 200,
      headers: { 'content-type': contentType(true) },
      body: relay(response.body, async (raw, whole) => {
        const usage = usageOf(raw, true) ?? NO_USAGE;
        if (whole) {
          await audit('answered', usage);
          record(raw);
        } else {
          if (!gone?.aborted) providerError(signal.aborted ? 'timeout' : 'broken');
          await audit('failed', usage, 'the stream broke off');
        }
        await spend.reconcile();
      }),
    };
  }

  /**
   * Token counting, for the Agent SDK's budgeting: an estimate, about four characters a token. The same in every mode,
   * so a recorded run and its replay see the same counts and send the same requests.
   */
  async countTokens(headers: Headers, read: () => Promise<string>): Promise<Reply> {
    const who = await this.#authorise(headers);
    // A count is no model call: one refused is the next call's to record, if the SDK makes it.
    if ('status' in who) {
      const { refused: _, ...reply } = who;
      return reply;
    }
    return json(200, { input_tokens: Math.ceil((await read()).length / 4) });
  }

  async #authorise(headers: Headers): Promise<(Who & { traceparent?: string }) | Refused> {
    const token = header(headers, 'x-api-key') ?? header(headers, 'authorization')?.replace(/^Bearer\s+/i, '');
    const job = token ? await jobForToken(this.#o.sql, token) : undefined;
    // Not a job's token: nothing was refused but a guess, and there is no work item to record it on.
    if (!job) return apiError(401, 'authentication_error', 'This is not the token of a job that is running.');
    const refuse = (cause: GatewayCause, message: string): Refused => ({
      ...apiError(403, 'permission_error', message),
      refused: { workItem: job.workItem, agent: job.agent, cause, message },
    });
    if (!(MODEL_AGENTS as readonly string[]).includes(job.agent)) {
      return refuse('policy', `The ${job.agent} agent does not call models through this API.`);
    }
    if (await this.#lineStopped()) {
      return refuse('stopped', 'The line is stopped: agents take no new calls until it starts again.');
    }
    return {
      job: job.job,
      workItem: job.workItem,
      agent: job.agent as ModelAgent,
      ...(job.traceparent ? { traceparent: job.traceparent } : {}),
    };
  }

  /**
   * Records a refusal of a guardrail on the job's work item, behind the answer. `which` names the cap, so one cap's
   * repeats fold apart from another's, each in its own words.
   */
  #refused(workItem: string, agent: string, cause: GatewayCause, output: string, which?: string): void {
    this.#o.refusals?.refused({
      workItem,
      cause,
      action: `A model call by the ${agent} agent${which ? `, ${which}` : ''}`,
      output,
      at: new Date(this.#now()),
    });
  }

  async #lineStopped(): Promise<boolean> {
    const now = this.#now();
    const line = this.#line;
    if (line && line.heard === this.#heard && now - line.at < LINE_FRESH_MS) return line.stopped;
    // Taken before the read: an append heard while it is under way may have committed after it, so is read again.
    const heard = this.#heard;
    // Only Martin's roles stop and start the line; a stop or start any other appended is ignored, and logged once.
    await this.#ignored.check();
    const stopped = await lineStopped(this.#o.sql);
    this.#line = { stopped, at: now, heard };
    return stopped;
  }

  async #audit(
    call: Call,
    span: Span,
    key: string,
    outcome: Outcome,
    usage: Usage,
    ms: number,
    reason?: string,
  ): Promise<void> {
    const { sql, log } = this.#o;
    // A replay costs nothing; anything the provider generated is billed, whether or not the stream got through.
    const costUsd = outcome === 'answered' || outcome === 'failed' ? costOf(call.model, usage) : 0;
    const durationMs = Math.round(ms);
    const cacheWrite = (usage.cacheWriteTokens ?? 0) + (usage.cacheWriteHourTokens ?? 0);
    span.setAttributes({
      [A.outcome]: outcome,
      [A.inputTokens]: usage.inputTokens,
      [A.outputTokens]: usage.outputTokens,
      [A.cacheReadTokens]: usage.cacheReadTokens ?? 0,
      [A.cacheWriteTokens]: cacheWrite,
      [A.costUsd]: costUsd,
      ...(reason ? { [A.reason]: reason } : {}),
    });
    if (outcome === 'failed') span.setStatus({ code: SpanStatusCode.ERROR, ...(reason ? { message: reason } : {}) });
    span.end();
    await sql`
      insert into model_calls (id, at, agent, work_item, provider, model, question_set, input_tokens, output_tokens,
                               cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, cassette, outcome, job)
      values (${crypto.randomUUID()}, ${new Date(this.#now()).toISOString()}::timestamptz, ${call.agent},
              ${call.workItem}, ${call.provider}, ${call.model}, 'messages', ${usage.inputTokens}, ${usage.outputTokens},
              ${usage.cacheReadTokens ?? 0}, ${cacheWrite}, ${costUsd}, ${durationMs}, ${key}, ${outcome}, ${call.job})`;
    const series = { agent: call.agent, provider: call.provider, model: call.model };
    instruments.calls.add(1, { ...series, outcome });
    instruments.latency.record(durationMs, { ...series, outcome });
    if (costUsd > 0) instruments.spend.add(costUsd, series);
    // What the call used, so a refusal, which used nothing, counts none.
    const kinds: Record<instruments.TokenKind, number> = {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cache_read: usage.cacheReadTokens ?? 0,
      cache_write: cacheWrite,
    };
    for (const [kind, n] of Object.entries(kinds)) if (n > 0) instruments.tokens.add(n, { ...series, outcome, kind });
    const level = outcome === 'failed' ? 'error' : outcome === 'refused' ? 'warn' : 'info';
    // In the call's span, so the line names the step's trace: a stream ends outside it.
    context.with(trace.setSpan(context.active(), span), () =>
      log[level](
        { ...call, ...usage, costUsd, durationMs, cassette: key, outcome, ...(reason ? { reason } : {}) },
        'model call',
      ),
    );
  }
}

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/** Why a fetch failed: Node puts the network's reason, such as ECONNREFUSED, in the error's cause. */
const causeOf = (error: unknown) => {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return 'it took too long, or the runner went away';
  const cause = (error as Error)?.cause as (Error & { code?: string }) | undefined;
  return cause?.code ?? cause?.message ?? (error as Error)?.message ?? 'unknown';
};

const contentType = (stream: boolean) => (stream ? 'text/event-stream; charset=utf-8' : 'application/json');

/** A stream's events, as server-sent events: each event's name and its data, parsed where it is JSON. */
export function sseEvents(raw: string): { event: string; data: unknown }[] {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const event =
        lines
          .find((l) => l.startsWith('event:'))
          ?.slice(6)
          .trim() ?? 'message';
      const text = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      let data: unknown = text;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          // An event whose data is not JSON keeps it as text; nothing the gateway reads is in one.
        }
      }
      return { event, data };
    })
    .filter((e) => e.event !== 'message' || e.data !== '');
}

/**
 * Relays a stream to the runner as it arrives, keeping a copy. When it ends, `ended` gets the copy and whether it came
 * whole: a stream that reports an error, breaks off, or that the runner leaves, is not whole, and keeps no cassette.
 */
async function* relay(
  stream: ReadableStream<Uint8Array>,
  ended: (raw: string, whole: boolean) => Promise<void>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let whole = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      yield value;
    }
    raw += decoder.decode();
    const events = sseEvents(raw);
    whole = events.some((e) => e.event === 'message_stop') && !events.some((e) => e.event === 'error');
  } catch {
    // The provider's stream broke off: what came is audited as it stands, below.
  } finally {
    if (!whole) await reader.cancel().catch(() => undefined); // already closed, if it broke
    await ended(raw, whole);
  }
}

interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

/** The numbers in a usage, without its nulls: a later usage adds what it knows and keeps what it does not. */
const numbers = (usage: ApiUsage | undefined) =>
  Object.fromEntries(Object.entries(usage ?? {}).filter(([, v]) => v !== null && v !== undefined)) as ApiUsage;

const count = (n: number | null | undefined) => Math.max(0, n ?? 0);

/**
 * A response's usage, from its JSON or from its stream's events: `message_start` carries the input and the cache,
 * and each `message_delta` what it knows by then (output, and sometimes input again, or null for what it does not).
 * Undefined for a whole response that is not a message.
 */
export function usageOf(raw: string, stream: boolean): Usage | undefined {
  let usage: ApiUsage = {};
  if (!stream) {
    try {
      const message = JSON.parse(raw) as { type?: string; usage?: ApiUsage };
      if (message?.type !== 'message') return undefined;
      usage = numbers(message.usage);
    } catch {
      return undefined;
    }
  } else {
    for (const { event, data } of sseEvents(raw)) {
      const d = data as { message?: { usage?: ApiUsage }; usage?: ApiUsage };
      if (event === 'message_start') usage = { ...usage, ...numbers(d?.message?.usage) };
      if (event === 'message_delta') usage = { ...usage, ...numbers(d?.usage) };
    }
  }
  const hour = count(usage.cache_creation?.ephemeral_1h_input_tokens);
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: Math.max(0, count(usage.cache_creation_input_tokens) - hour),
    cacheWriteHourTokens: hour,
  };
}

/** A request with no effort, and no `output_config` left empty by taking it out. */
function withoutEffort({ output_config, ...rest }: z.infer<typeof REQUEST>) {
  if (!output_config) return rest;
  const { effort: _, ...output } = output_config;
  return Object.keys(output).length ? { ...rest, output_config: output } : rest;
}
