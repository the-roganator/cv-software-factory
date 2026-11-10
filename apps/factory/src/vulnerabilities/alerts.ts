/**
 * The scan's alerts held to the policy, once code scanning has the upload: each open alert of the scan's own categories
 * (`vulnerabilities/01` to `vulnerabilities/20`, never CodeQL's or Scorecard's) whose result an exception in force
 * excepts is dismissed as won't fix, its comment the entry's reason and expiry; each one dismissed with no exception in
 * force, by anyone, is reopened; and one dismissed for an exception whose comment has changed is reopened and dismissed
 * again with the new one. So those categories' state is policy/vulnerabilities.ts's and nothing else's.
 *
 *     node apps/factory/src/vulnerabilities/alerts.ts <exceptions.json>
 *
 * The file is what scan.ts wrote beside the SARIF it uploaded: the repository, and the comment for each excepted
 * result's alert, by the key the API gives it back by (sarif.ts's `alertKey`). GH_TOKEN is the job's token, with
 * `security-events: write`. The log gives counts and alert numbers, never a package or an advisory.
 *
 * Node runs this with no dependencies, from a sparse checkout of this repository.
 */
import { readFileSync } from 'node:fs';
import { CATEGORY } from './sarif.ts';

/** An alert as code scanning's API gives it, as far as this reads it. */
export interface Alert {
  number: number;
  state: 'open' | 'dismissed' | 'fixed' | string;
  created_at?: string;
  updated_at?: string;
  fixed_at?: string | null;
  dismissed_reason?: string | null;
  dismissed_comment?: string | null;
  rule?: { id?: string } | null;
  tool?: { name?: string } | null;
  most_recent_instance?: {
    category?: string;
    message?: { text?: string };
    location?: { path?: string; start_line?: number };
  } | null;
}

export type Change = { number: number; to: 'dismissed'; comment: string } | { number: number; to: 'open' };

/** The scan's own categories, and only those. */
const OURS = new RegExp(`^${CATEGORY}/(0[1-9]|1[0-9]|20)$`);

/** Whether an alert is the scan's: Trivy's, in one of its categories. */
export const isOurs = (alert: Alert) =>
  alert.tool?.name === 'Trivy' && OURS.test(alert.most_recent_instance?.category ?? '');

/** An alert's key, as sarif.ts's `alertKey` gives a result's: its rule, its file and line, and its message. */
export const keyOf = (alert: Alert) =>
  JSON.stringify([
    alert.rule?.id ?? '',
    alert.most_recent_instance?.location?.path ?? '',
    alert.most_recent_instance?.location?.start_line ?? 0,
    alert.most_recent_instance?.message?.text ?? '',
  ]);

export const WONT_FIX = "won't fix";

/**
 * What changes, in order, for the alerts given (open and dismissed) and the comments by key: dismiss an open excepted
 * one; reopen a dismissed one nothing excepts; reopen and dismiss again one whose reason or comment is not the policy's.
 */
export function changes(alerts: Alert[], excepted: Record<string, string>): Change[] {
  const out: Change[] = [];
  for (const alert of alerts) {
    if (!isOurs(alert)) continue;
    const comment = excepted[keyOf(alert)];
    if (alert.state === 'open' && comment !== undefined) out.push({ number: alert.number, to: 'dismissed', comment });
    if (alert.state !== 'dismissed') continue;
    if (comment === undefined) out.push({ number: alert.number, to: 'open' });
    else if (alert.dismissed_reason !== WONT_FIX || (alert.dismissed_comment ?? '').trim() !== comment.trim())
      out.push({ number: alert.number, to: 'open' }, { number: alert.number, to: 'dismissed', comment });
  }
  return out;
}

/** GitHub's REST API, as far as this uses it, so the tests give it recorded answers. */
export interface Api {
  get(path: string): Promise<{ body: unknown; next?: string | undefined }>;
  patch(path: string, body: Record<string, string>): Promise<unknown>;
}

/**
 * The repository's Trivy alerts in a state, every page; or, with `while`, those it holds for, in the order `query` asks
 * for, stopping at the first that it does not.
 */
export async function alertsIn(
  api: Api,
  repository: string,
  state: 'open' | 'dismissed' | 'fixed',
  options: { query?: string; while?: (alert: Alert) => boolean } = {},
) {
  const alerts: Alert[] = [];
  let path: string | undefined =
    `/repos/${repository}/code-scanning/alerts?tool_name=Trivy&state=${state}&per_page=100${options.query ?? ''}`;
  while (path) {
    const page: { body: unknown; next?: string | undefined } = await api.get(path);
    if (!Array.isArray(page.body)) throw new Error(`code scanning answered ${path} with something other than a list`);
    const kept = options.while ? (page.body as Alert[]).filter(options.while) : (page.body as Alert[]);
    alerts.push(...kept);
    path = kept.length === page.body.length ? page.next : undefined;
  }
  return alerts;
}

/**
 * Holds the repository's alerts to the comments by key: reads the dismissed alerts, and the open ones only when
 * something is excepted, then makes each change. A change that fails stops the run with the rest unmade.
 */
export async function hold(api: Api, repository: string, excepted: Record<string, string>, log = console.log) {
  const dismissed = await alertsIn(api, repository, 'dismissed');
  const open = Object.keys(excepted).length ? await alertsIn(api, repository, 'open') : [];
  const todo = changes([...open, ...dismissed], excepted);
  for (const change of todo)
    await api.patch(
      `/repos/${repository}/code-scanning/alerts/${change.number}`,
      change.to === 'open'
        ? { state: 'open' }
        : { state: 'dismissed', dismissed_reason: WONT_FIX, dismissed_comment: change.comment },
    );
  const dismissedNow = todo.filter((change) => change.to === 'dismissed').map((change) => change.number);
  const reopened = todo.filter((change) => change.to === 'open' && !dismissedNow.includes(change.number));
  const again = todo.filter((change) => change.to === 'open' && dismissedNow.includes(change.number));
  log(
    `Alerts held to the policy: ${Object.keys(excepted).length} results excepted, ${dismissedNow.length - again.length} alerts dismissed, ${again.length} dismissed again with a new comment, ${reopened.length} reopened.`,
  );
  for (const change of reopened) log(`  Reopened #${change.number}: dismissed, and no exception in force.`);
  return todo;
}

/** The API through fetch, with the token, following each `Link: rel="next"`. */
export function realApi(token: string, base = process.env.GITHUB_API_URL ?? 'https://api.github.com'): Api {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const url = (path: string) => (path.startsWith('http') ? path : `${base}${path}`);
  const answer = async (response: Response, what: string) => {
    if (!response.ok) throw new Error(`${what}: ${response.status} ${(await response.text()).slice(0, 300)}`);
    return response.json();
  };
  return {
    async get(path) {
      const response = await fetch(url(path), { headers, signal: AbortSignal.timeout(60_000) });
      const body = await answer(response, `GET ${path}`);
      const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
      return { body, next };
    },
    async patch(path, body) {
      const response = await fetch(url(path), {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      return answer(response, `PATCH ${path}`);
    },
  };
}

export async function main(args: string[]): Promise<number> {
  const [file] = args;
  const token = process.env.GH_TOKEN;
  if (!file || !token) {
    console.error('Usage: GH_TOKEN=<token> alerts.ts <exceptions.json>');
    return 2;
  }
  const { repository, excepted } = JSON.parse(readFileSync(file, 'utf-8')) as {
    repository?: string;
    excepted?: Record<string, string>;
  };
  if (!repository || !excepted) {
    console.error(`::error::${file} names no repository or no exceptions.`);
    return 1;
  }
  try {
    await hold(realApi(token), repository, excepted);
  } catch (error) {
    console.error(
      `::error::The alerts could not be held to the policy: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
