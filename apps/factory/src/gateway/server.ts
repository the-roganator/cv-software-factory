/**
 * The gateway over HTTP, for the workers in the cluster.
 *
 *     POST /v1/judgements   a judgement request as JSON (`JudgeRequest`), with triage's token; the answers, cost and
 *                           cassette key out
 *     POST /v1/messages     Anthropic's Messages API, for runners with a job token (`agents.ts`)
 *     POST /v1/messages/count_tokens
 *     GET  /v1/spend        today's and this month's spend against the caps
 *     GET  /health          for the cluster's probes
 *
 * The Messages API answers its errors in Anthropic's shape (`agents.ts`). The judgements' errors keep their meaning: a spend cap is 429 with the cap and when it resets (and `Retry-After`), a request
 * with no cassette in replay is 409, a provider that failed is 502, a request the gateway will not send is 400
 * (413 when it is too big). No error body echoes the request, which may hold a report's text.
 *
 * Judgements are triage's alone: a request without its token (`authorization: Bearer <token>`) is 401, before its body
 * is read. That is no guardrail's refusal, and is not recorded as one, as a token that is no running job's is not; it is
 * counted, and pages Martin. With no token configured, every judgement is 401: the route is never open to any caller the
 * network policy lets in.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '../log.ts';
import { type AgentCalls, apiError, type Reply } from './agents.ts';
import { BadRequest } from './errors.ts';
import type { Gateway } from './gateway.ts';
import { unauthorizedJudgements } from './metrics.ts';
import type { Spend } from './spend.ts';
import { errorResponse } from './wire.ts';

/** A judgement request is a few hundred tokens of text; this leaves room for a long report and its context. */
const MAX_BODY_BYTES = 256 * 1024;
/** An agent's call carries its whole conversation: Anthropic takes up to 32 MB. */
const MAX_MESSAGES_BYTES = 32 * 1024 * 1024;

class TooLarge extends Error {}

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Reads to the end even when it is too big, and keeps none of it: stopping early would drop the connection
  // before the 413 could be sent.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  if (size > limit) throw new TooLarge();
  return Buffer.concat(chunks).toString('utf-8');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export interface ServerOptions {
  gateway: Gateway;
  /** The Messages API for runners. Without it, those paths are not here. */
  agents?: AgentCalls | undefined;
  spend: Spend;
  /** Triage's caller token for judgements (`JUDGEMENTS_TOKEN`). Without it, judgements are off. */
  judgementsToken: string | undefined;
  log: Logger;
  clock?: () => Date;
}

/**
 * Whether a request carries the token. Both sides are hashed first, so the comparison takes the same time whatever
 * the length or content of what was sent.
 */
function carries(req: IncomingMessage, token: string): boolean {
  const sent = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (sent === undefined) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(sent), digest(token));
}

/**
 * Writes a reply, relaying a stream chunk by chunk at the pace the runner reads it, and stops reading it if the
 * runner goes away.
 */
async function write(res: ServerResponse, reply: Reply): Promise<void> {
  res.writeHead(reply.status, { 'cache-control': 'no-store', ...reply.headers });
  if (typeof reply.body === 'string') return void res.end(reply.body);
  for await (const chunk of reply.body) {
    if (res.destroyed) break;
    if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve).once('close', resolve));
  }
  res.end();
}

export function createGatewayServer({
  gateway,
  agents,
  spend,
  judgementsToken,
  log,
  clock = () => new Date(),
}: ServerOptions): Server {
  if (!judgementsToken) log.warn('no JUDGEMENTS_TOKEN: every judgement is answered 401, and triage judges nothing');
  async function agentCall(req: IncomingMessage, res: ServerResponse, call: 'messages' | 'countTokens') {
    if (!agents) return send(res, 404, { error: 'bad-request', message: 'This gateway serves no agents.' });
    // The body is read only once the token is good, and the call to the provider ends if the runner goes away.
    const gone = new AbortController();
    res.once('close', () => gone.abort());
    let reply: Reply;
    try {
      const read = () => readBody(req, MAX_MESSAGES_BYTES);
      reply =
        call === 'messages'
          ? await agents.messages(req.headers, read, gone.signal)
          : await agents.countTokens(req.headers, read);
    } catch (error) {
      if (error instanceof TooLarge) reply = apiError(413, 'request_too_large', 'The request is over 32 MB.');
      else if (error instanceof BadRequest) reply = apiError(400, 'invalid_request_error', error.message);
      else {
        log.error({ err: error }, 'agent call failed');
        reply = apiError(500, 'api_error', 'The gateway failed. See its log.');
      }
    }
    await write(res, reply);
  }

  async function judgements(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!judgementsToken || !carries(req, judgementsToken)) {
      // Counted, and paged on; not logged, so a caller cannot fill the log.
      unauthorizedJudgements.add(1);
      return send(
        res,
        401,
        { error: 'unauthorized', message: 'Judgements take triage’s token, and this request did not carry it.' },
        // Closed once answered: the body is never read, so a caller cannot hold the connection open by sending it slowly.
        { 'www-authenticate': 'Bearer', connection: 'close' },
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof TooLarge) {
        return send(res, 413, { error: 'bad-request', message: `The request is over ${MAX_BODY_BYTES} bytes.` });
      }
      return send(res, 400, { error: 'bad-request', message: 'The request is not valid JSON.' });
    }
    // The gateway checks the request; this only hands it over.
    send(res, 200, await gateway.judge(input as Parameters<Gateway['judge']>[0]));
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { pathname } = new URL(req.url ?? '/', 'http://gateway');
    const only = (method: string) => {
      if (req.method === method) return true;
      send(res, 405, { error: 'bad-request', message: `Use ${method}.` }, { allow: method });
      return false;
    };
    if (pathname === '/health') {
      if (only('GET')) send(res, 200, { status: 'ok', mode: gateway.mode });
    } else if (pathname === '/v1/spend') {
      if (only('GET')) send(res, 200, await spend.report());
    } else if (pathname === '/v1/judgements') {
      if (only('POST')) await judgements(req, res);
    } else if (pathname === '/v1/messages') {
      if (only('POST')) await agentCall(req, res, 'messages');
    } else if (pathname === '/v1/messages/count_tokens') {
      if (only('POST')) await agentCall(req, res, 'countTokens');
    } else {
      send(res, 404, { error: 'bad-request', message: 'There is nothing here.' });
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const { status, body, retryAfterSeconds } = errorResponse(error, clock().getTime());
      if (status === 500) {
        // As the factory's logger keeps an error: its other fields can hold a query's parameters, and it drops them.
        log.error({ err: error }, 'request failed');
      }
      if (res.headersSent) return void res.destroy();
      send(res, status, body, retryAfterSeconds ? { 'retry-after': String(retryAfterSeconds) } : {});
    });
  });
}
