/**
 * Asking the app for something over HTTP, and keeping the exchange as evidence. For what a check needs without a
 * browser: the app's own JSON, and whether a link opens.
 */
import { cutAt, type Evidence } from '@software-factory/events';
import type { Response as BrowserResponse } from 'playwright';

type HttpEvidence = Extract<Evidence, { kind: 'http' }>;

export interface Exchange {
  /** The status of the last response, or null when none came (the connection failed, or redirects never ended). */
  status: number | null;
  /** The body of the last response, as text. */
  body: string;
  /** The last response's content type, without parameters, or null. */
  type: string | null;
  evidence: HttpEvidence;
  /** Every header of the last response, by lower-case name. */
  headers: Record<string, string>;
  /** The address of the last response, as `pathOf` gives it: where the redirects, if any, led. */
  landed: string;
  /** Why no answer came, when none did. */
  failure?: 'redirect loop' | 'no answer';
}

/** Headers a request to the app carries besides the usual, by lower-case name. */
export type RequestHeaders = Readonly<Record<string, string>>;

/**
 * The header on the factory's own requests to the app, which must not count in what the app is judged on: the
 * probes', the crawler's and the page reader's, the pictures of a release, and the journeys that compare its versions.
 * The app keeps no record of a request that carries it, in its request log, request metrics or traces (an error it
 * causes is still logged, with no trace), so the errors and latency the objectives and a canary's analysis read are
 * the visitors' and the traffic generator's alone, the canary and its baseline are judged on the same mix, and the
 * three records still agree. The traffic generator does not send it: it stands in for the visitors, and must be
 * judged. Nor does the crawler's second ask for a static asset, whose caching only a visitor's answer can show: the app
 * answers every marked request `private, no-store` (`crawler/crawl.ts`).
 */
export const UNMEASURED: RequestHeaders = { 'x-unmeasured': '1' };

/** The headers every exchange records: the few a reviewer of a signal would ask about. */
const HEADERS = ['content-type', 'cache-control', 'location'] as const;

const MAX_REDIRECTS = 10;

/** What a path asks for, as an event may record it: the path and its query, never the host. */
export const pathOf = (url: string | URL, base?: string): string => {
  const { pathname, search } = new URL(url, base);
  return `${pathname}${search}`.slice(0, 300);
};

/** GETs a path of the app, following redirects by hand so each one is recorded. */
export async function exchange(
  app: string,
  path: string,
  init: {
    signal?: AbortSignal;
    /** Headers to keep in the evidence besides the usual. */
    record?: readonly string[];
    /** Headers to send. */
    headers?: RequestHeaders | undefined;
  } = {},
): Promise<Exchange> {
  const recorded = [...new Set([...HEADERS, ...(init.record ?? [])])];
  const started = performance.now();
  const redirects: HttpEvidence['redirects'] = [];
  const seen = new Set<string>();
  let url = new URL(path, app);
  let firstByteMs = 0;
  for (;;) {
    seen.add(url.href);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: init.signal ?? AbortSignal.timeout(15_000),
        ...(init.headers && { headers: init.headers }),
      });
    } catch {
      return finish(null, '', null, 'no answer');
    }
    firstByteMs = Math.round(performance.now() - started);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      redirects.push({ status: response.status, location: location.slice(0, 300) });
      url = new URL(location, url);
      // A visitor who is sent to another site has left the app: that is as far as the app's own answer goes.
      if (url.origin !== new URL(app).origin) return finish(response, '', null);
      if (seen.has(url.href) || redirects.length > MAX_REDIRECTS) return finish(response, '', null, 'redirect loop');
      continue;
    }
    return finish(response, await response.text().catch(() => ''), response.headers.get('content-type'));
  }

  function finish(response: Response | null, body: string, type: string | null, failure?: Exchange['failure']) {
    const evidence: HttpEvidence = {
      kind: 'http',
      method: 'GET',
      url: pathOf(path, app),
      status: response?.status ?? null,
      headers: Object.fromEntries(recorded.map((name) => [name, response?.headers.get(name)?.slice(0, 300) ?? null])),
      timings: { firstByteMs, totalMs: Math.round(performance.now() - started) },
      redirects,
    };
    return {
      status: response?.status ?? null,
      body,
      type: type?.split(';')[0]?.trim().toLowerCase() ?? null,
      evidence,
      headers: Object.fromEntries(response?.headers ?? []),
      landed: pathOf(url),
      ...(failure && { failure }),
    };
  }
}

/** The version the app says it is running, from its `/version`. */
export async function versionOf(app: string, headers?: RequestHeaders): Promise<string> {
  const answer = await exchange(app, '/version', { headers });
  let commit: unknown;
  try {
    commit = (JSON.parse(answer.body) as { commit?: unknown }).commit;
  } catch {
    // Not JSON: the check below says so.
  }
  if (answer.status !== 200 || typeof commit !== 'string') {
    throw new Error(`${app}/version did not say what version is running (status ${answer.status ?? 'none'})`);
  }
  return commit;
}

/** The exchange a browser had, as evidence: its request, and the redirects before the response. */
export async function evidenceOf(response: BrowserResponse): Promise<HttpEvidence> {
  const request = response.request();
  const redirects: HttpEvidence['redirects'] = [];
  for (let from = request.redirectedFrom(); from && redirects.length < MAX_REDIRECTS; from = from.redirectedFrom()) {
    const earlier = await from.response();
    redirects.unshift({
      status: Math.min(399, Math.max(300, earlier?.status() ?? 302)),
      location: (earlier ? (await earlier.allHeaders()).location : undefined) ?? 'unknown',
    });
  }
  const headers = await response.allHeaders();
  const timing = request.timing();
  return {
    kind: 'http',
    method: request.method() === 'POST' ? 'POST' : 'GET',
    url: pathOf(response.url()),
    status: response.status(),
    headers: Object.fromEntries(
      HEADERS.map((name) => {
        const value = headers[name];
        return [name, value === undefined ? null : cutAt(value, 300)];
      }),
    ),
    timings: {
      firstByteMs: Math.max(0, Math.round(timing.responseStart - timing.requestStart)),
      totalMs: Math.max(0, Math.round(timing.responseEnd)),
    },
    redirects,
  };
}
