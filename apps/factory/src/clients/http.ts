/**
 * What the telemetry backends have in common: a GET that returns JSON, and the shape of a metric answer.
 *
 * An error names the backend and the status and never the response, because a response can hold what the backend
 * was asked for, and what the log watcher asks Loki for includes visitors' reports.
 */
export type Fetch = typeof fetch;

/** A backend's answer that was not a success: the status, and the backend and path it came from in the message. */
export class BackendAnswered extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'BackendAnswered';
    this.status = status;
  }
}

/**
 * How long a telemetry backend may be away before a reader that cannot reach it is at fault: two minutes. Patching
 * Loki, Prometheus or Tempo restarts its one pod: the old one has up to thirty seconds to stop, and the new one is
 * passed traffic only once its readiness probe, fifteen seconds after it starts and every ten after that, finds it
 * ready, which Loki is only once its ingester has been ready for fifteen seconds. That is under a minute; two is
 * twice it, on a Mac busy with the patch, and two turns of a reader that looks once a minute.
 */
export const TELEMETRY_AWAY_MS = 2 * 60_000;

/** The codes of a connection that could not be made or was cut, as Node's `fetch` gives them in a failure's cause. */
const CUT = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const codesOf = (error: unknown): string[] => {
  const { code, errors } = (error ?? {}) as { code?: unknown; errors?: unknown };
  const own = typeof code === 'string' ? [code] : [];
  return Array.isArray(errors) ? [...own, ...errors.flatMap(codesOf)] : own;
};

/**
 * Whether a read of a telemetry backend failed as it does while the backend restarts, rather than for a fault: no
 * answer within the read's time, a connection refused, cut or not resolved, or a 5xx, which the read-only proxy in
 * front of the backends (`query.yaml`) answers while the backend behind it is down, and the backend itself while it
 * starts. A 4xx, or an answer that is not what was asked for, is not one.
 */
export function telemetryAway(error: unknown): boolean {
  if (error instanceof BackendAnswered) return error.status >= 500;
  if ((error as { name?: unknown } | null)?.name === 'TimeoutError') return true;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return error instanceof TypeError && cause !== undefined && codesOf(cause).some((code) => CUT.has(code));
}

export async function getJson(
  fetcher: Fetch,
  base: string,
  path: string,
  params: Record<string, string | number> = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  const url = new URL(path, base);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new BackendAnswered(`${url.host}${path} answered ${response.status}`, response.status);
  return response.json();
}

/** One series of an instant query: its labels and its value. */
export interface Sample {
  labels: Record<string, string>;
  value: number;
}

/** A number as Prometheus and Loki write it, or null for the NaN of a ratio with nothing to divide. */
export function toNumber(text: unknown): number | null {
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The series of an instant query's answer, with NaN and infinity left out. */
export function samplesOf(answer: unknown): Sample[] {
  const result = (answer as { data?: { result?: unknown } })?.data?.result;
  if (!Array.isArray(result)) throw new Error('A backend answered an instant query with something else');
  return result.flatMap((series: { metric?: Record<string, string>; value?: [number, string] }) => {
    const value = toNumber(series.value?.[1]);
    return value === null ? [] : [{ labels: series.metric ?? {}, value }];
  });
}
