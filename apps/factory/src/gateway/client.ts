/**
 * A client for the gateway over HTTP, for the workers that need a judgement (triage first). It sends a
 * `JudgeRequest` and returns a `Judgement`, and turns the gateway's statuses back into the typed errors that
 * `Gateway.judge` throws: `SpendCapped`, `CassetteMissing`, `ProviderError` and `BadRequest`. A gateway that
 * cannot be reached, refuses the caller's token, or answers in a way the client does not know, is `GatewayUnavailable`.
 */
import { z } from 'zod';
import { GatewayUnavailable } from './errors.ts';
import type { Judgement, JudgeRequest } from './gateway.ts';
import type { SpendReport } from './spend.ts';
import { answer, LONGEST_CALL_MS } from './typesafe.ts';
import { errorFromResponse } from './wire.ts';

const judgement = z.object({
  model: z.string(),
  answers: z.record(z.string(), answer),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
  costUsd: z.number(),
  durationMs: z.number(),
  cassette: z.string(),
  source: z.enum(['provider', 'cassette']),
});

export interface ClientOptions {
  /** The gateway's address, such as `http://gateway:8080`. */
  url: string;
  /** Triage's caller token, which the gateway takes judgements with (`JUDGEMENTS_TOKEN`). Sent with judgements alone. */
  token?: string | undefined;
  /**
   * For one request, retries inside the gateway included. By default, longer than the gateway can spend retrying,
   * so the client never gives up on a call the gateway goes on to pay for.
   */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class GatewayClient {
  readonly #url: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor({ url, token, timeoutMs = LONGEST_CALL_MS + 30_000, fetch: send = fetch }: ClientOptions) {
    this.#url = url.replace(/\/$/, '');
    this.#token = token;
    this.#timeoutMs = timeoutMs;
    this.#fetch = send;
  }

  async judge(input: JudgeRequest): Promise<Judgement> {
    const json = await this.#send('/v1/judgements', {
      method: 'POST',
      body: JSON.stringify(input),
      ...(this.#token ? { headers: { authorization: `Bearer ${this.#token}` } } : {}),
    });
    const parsed = judgement.safeParse(json);
    if (!parsed.success) throw new GatewayUnavailable('The gateway answered with something this client does not know.');
    return parsed.data as Judgement;
  }

  /** Spend so far against the caps. */
  async spend(): Promise<SpendReport> {
    return (await this.#send('/v1/spend', { method: 'GET' })) as SpendReport;
  }

  async #send(
    path: string,
    { headers, ...init }: { method: string; body?: string; headers?: Record<string, string> },
  ): Promise<unknown> {
    let result: Response;
    let json: unknown;
    try {
      result = await this.#fetch(`${this.#url}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      json = await result.json().catch(() => undefined);
    } catch {
      throw new GatewayUnavailable('The gateway could not be reached.');
    }
    if (!result.ok) throw errorFromResponse(result.status, json);
    return json;
  }
}
