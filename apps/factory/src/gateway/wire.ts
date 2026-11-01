/**
 * How the gateway's errors cross HTTP, and back. `errorResponse` is the server's side and `errorFromResponse`
 * the client's, so a caller handles the same typed errors in process and over the wire.
 *
 * A body never echoes the request, and never carries a provider's body: only what the typed errors hold.
 */
import { z } from 'zod';
import { BadRequest, CassetteMissing, GatewayUnavailable, ProviderError, SpendCapped } from './errors.ts';

const body = z.discriminatedUnion('error', [
  z.object({
    error: z.literal('spend-capped'),
    message: z.string(),
    cap: z.enum(['day', 'month', 'work-item']),
    limitUsd: z.number(),
    spentUsd: z.number(),
    resets: z.string().nullable(),
  }),
  z.object({ error: z.literal('cassette-missing'), message: z.string(), key: z.string() }),
  z.object({
    error: z.literal('provider-failed'),
    message: z.string(),
    kind: z.enum(['rate-limited', 'overloaded', 'server', 'network', 'timeout', 'rejected', 'malformed']),
    status: z.number().int().optional(),
  }),
  z.object({ error: z.literal('bad-request'), message: z.string() }),
  z.object({ error: z.literal('unauthorized'), message: z.string() }),
  z.object({ error: z.literal('internal'), message: z.string() }),
]);

export type ErrorBody = z.infer<typeof body>;

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
  /** Seconds a caller should wait, when a cap's reset is known. */
  retryAfterSeconds?: number;
}

/** The status and body for an error. Anything the gateway does not know is a 500 that says nothing more. */
export function errorResponse(error: unknown, now: number = Date.now()): ErrorResponse {
  if (error instanceof SpendCapped) {
    const { message, cap, limitUsd, spentUsd, resets } = error;
    return {
      status: 429,
      body: { error: 'spend-capped', message, cap, limitUsd, spentUsd, resets },
      ...(resets ? { retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(resets) - now) / 1000)) } : {}),
    };
  }
  if (error instanceof CassetteMissing) {
    return { status: 409, body: { error: 'cassette-missing', message: error.message, key: error.key } };
  }
  if (error instanceof ProviderError) {
    return {
      status: 502,
      body: {
        error: 'provider-failed',
        message: error.message,
        kind: error.kind,
        ...(error.status ? { status: error.status } : {}),
      },
    };
  }
  if (error instanceof BadRequest) return { status: 400, body: { error: 'bad-request', message: error.message } };
  return { status: 500, body: { error: 'internal', message: 'The gateway failed. See its log.' } };
}

/** The typed error for a status and a body the gateway sent. A body it does not know is `GatewayUnavailable`. */
export function errorFromResponse(status: number, json: unknown): Error {
  const parsed = body.safeParse(json);
  if (!parsed.success) return new GatewayUnavailable(`The gateway answered with status ${status}.`, status);
  const found = parsed.data;
  switch (found.error) {
    case 'spend-capped':
      return new SpendCapped(found.cap, found.limitUsd, found.spentUsd, found.resets);
    case 'cassette-missing':
      return new CassetteMissing(found.key);
    case 'provider-failed':
      return new ProviderError(found.kind, found.message, found.status);
    case 'bad-request':
      return new BadRequest(found.message);
    // A caller without the right token: a fault in how the caller was deployed, which waits as an outage does.
    case 'unauthorized':
    case 'internal':
      return new GatewayUnavailable(found.message, status);
  }
}
