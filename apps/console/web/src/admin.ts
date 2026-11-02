/**
 * Martin's side of the console: whether this browser holds his session, and the admin service's routes it calls. The
 * console's own server never sees the session: the admin service answers `/admin/` on the same origin, and the cookie
 * that names the session is `HttpOnly`, so this code never reads it either. It asks the service, and believes the answer.
 *
 * Every write carries the session's token in `X-CSRF-Token`, as JSON, which no form on another site can send; the
 * browser adds `Origin`, which the service matches against the console's own.
 */
import { useEffect, useState } from 'react';

/** The admin service's description of a live session (`GET /admin/session`). */
export interface Session {
  signedInAt: string;
  expiresAt: string;
  steppedUpAt: string | null;
  steppedUp: boolean;
  /** What every write in this session carries in `X-CSRF-Token`. */
  token: string;
  passkey: { id: string; name: string };
  passkeys: { id: string; name: string; enrolledAt: string; lastUsedAt: string | null; current: boolean }[];
  /** This deployment's Grafana and Argo CD, each when the service is given it: told to a signed-in session alone. */
  tools?: Tools;
}

export interface Tools {
  grafana?: string;
  argocd?: string;
}

/**
 * A tool's address from the session, and its host, when it is one a link may take (an http or https URL with no
 * credentials in it); anything
 * else draws no link. A session is still Martin's without them.
 */
export function toolLink(value: unknown): { href: string; host: string } | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.host) return undefined;
  // An address with credentials in it is never drawn.
  if (url.username || url.password) return undefined;
  return { href: url.href, host: url.host };
}

/**
 * Who is looking:
 * - `checking`: the admin service has not answered yet;
 * - `none`: there is no admin service to ask (the replay site, development without one, a cluster before its
 *   Deployment), so there is nothing to sign in to;
 * - `visitor`: the service is there, and this browser holds no session;
 * - `martin`: signed in.
 */
export type Admin =
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'visitor' }
  | { kind: 'martin'; session: Session };

/** An answer from the admin service: its status, and its JSON, or nothing when it sent none. */
export interface Answer {
  status: number;
  body: Record<string, unknown> | undefined;
}

async function answer(res: Response): Promise<Answer> {
  // The service answers JSON alone; anything else (a proxy's page, development's fallback) is not it.
  const json = (res.headers.get('content-type') ?? '').startsWith('application/json');
  const body = json ? ((await res.json().catch(() => undefined)) as Record<string, unknown> | undefined) : undefined;
  return { status: res.status, body };
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isTime = (value: unknown): value is string => isString(value) && !Number.isNaN(Date.parse(value));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isPasskey = (value: unknown): boolean => isRecord(value) && isString(value.id) && isString(value.name);

/** Whether an answer is a whole session, every field the page reads in place, before the page takes it for Martin's. */
const isSession = (body: unknown): body is Session =>
  isRecord(body) &&
  isString(body.token) &&
  isTime(body.signedInAt) &&
  isTime(body.expiresAt) &&
  (body.steppedUpAt === null || isTime(body.steppedUpAt)) &&
  typeof body.steppedUp === 'boolean' &&
  isPasskey(body.passkey) &&
  Array.isArray(body.passkeys) &&
  body.passkeys.every(
    (passkey: unknown) =>
      isRecord(passkey) &&
      isPasskey(passkey) &&
      isTime(passkey.enrolledAt) &&
      (passkey.lastUsedAt === null || isTime(passkey.lastUsedAt)) &&
      typeof passkey.current === 'boolean',
  );

/** Asks the admin service whether this browser is signed in. */
export async function check(): Promise<Admin> {
  try {
    const got = await answer(await fetch('/admin/session', { cache: 'no-store', credentials: 'same-origin' }));
    // Anything less than a whole session is not the service's answer, and offers no sign-in.
    if (got.status === 200 && isSession(got.body)) return { kind: 'martin', session: got.body };
    // The service refuses with a reason of its own; no reason means something else answered.
    if (got.status === 401 && got.body?.refused === 'session') return { kind: 'visitor' };
    return { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

/** A write to the admin service: a `POST` of JSON, with the session's token when there is one. */
export async function post(path: string, body: object = {}, token?: string): Promise<Answer> {
  try {
    return await answer(
      await fetch(path, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(token && { 'x-csrf-token': token }) },
        body: JSON.stringify(body),
      }),
    );
  } catch {
    return { status: 0, body: undefined };
  }
}

/**
 * One of Martin's writes: a `POST` with his session's token. When the service refuses it because it needs his passkey
 * again, `stepUp` asks for it (the step-up dialog, `StepUp.tsx`), and the write is sent again once it is given; when
 * he cancels, the refusal stands.
 */
export async function write(
  path: string,
  body: object,
  token: string,
  stepUp?: () => Promise<boolean>,
): Promise<Answer> {
  const got = await post(path, body, token);
  if (got.status !== 403 || got.body?.refused !== 'step-up' || !stepUp) return got;
  return (await stepUp()) ? post(path, body, token) : got;
}

/** The service's own words for a refusal, or ours when it gave none (it was unreachable, or something else answered). */
export const said = (got: Answer): string =>
  typeof got.body?.message === 'string'
    ? got.body.message
    : got.status === 0
      ? 'The admin service can’t be reached. Try again in a moment.'
      : 'Something failed on the way to the admin service. Try again in a moment.';

/** Where a door is: `?view=sign-in` or `?view=enrol` on the console's own page. */
export type Door = 'sign-in' | 'enrol';

/** Why the sign-in page was opened, shown above its button: a session that ended, here, everywhere or by its time. */
export type Ended = 'here' | 'everywhere' | 'expired';

export const doorHref = (door: Door, ended?: Ended, at?: string) => {
  const params = new URLSearchParams({ view: door });
  if (ended) params.set('ended', ended);
  if (at) params.set('at', at);
  return `/?${params}`;
};

/** Set once this page is going to a door of its own accord (signing out), so nothing else sends it to another. */
let leaving = false;

/** Goes to a door, as signing out does, ahead of anything that would notice the session ending. */
export function leave(href: string): void {
  leaving = true;
  location.assign(href);
}

/**
 * Asks again whether the session is live, and when it has ended sends the page to the sign-in door, saying why: its
 * 30 minutes ran out, or it ended early (signed out everywhere from another device, or its passkey revoked). Resolves
 * true while it is live, or while the service cannot be asked, which leaves the page as it is.
 */
export async function stillSignedIn(expiresAt: string): Promise<boolean> {
  const found = await check();
  // Gone, not unreachable.
  if (found.kind !== 'visitor') return true;
  if (!leaving) {
    leaving = true;
    location.assign(
      Date.now() >= Date.parse(expiresAt) ? doorHref('sign-in', 'expired', expiresAt) : doorHref('sign-in', 'here'),
    );
  }
  return false;
}

/**
 * Whether this browser is signed in, asked as the page opens, and again when the session's 30 minutes are up or the
 * page is shown again: a session that has ended sends the page to the sign-in door, saying so. Only the live console asks: a recording has no service.
 */
export function useAdmin(live: boolean): Admin {
  const [admin, setAdmin] = useState<Admin>(() => (live ? { kind: 'checking' } : { kind: 'none' }));
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void check().then((found) => {
      if (!cancelled) setAdmin(found);
    });
    return () => {
      cancelled = true;
    };
  }, [live]);

  const expiresAt = admin.kind === 'martin' ? admin.session.expiresAt : undefined;
  useEffect(() => {
    if (!expiresAt) return;
    const ends = Date.parse(expiresAt);
    // Asked again rather than assumed, so a clock that is out says nothing wrong.
    const ended = () => void stillSignedIn(expiresAt);
    // A timer sleeps with the laptop, so coming back to the page asks again too: the session may also have ended
    // early, signed out everywhere from another device or its passkey revoked.
    const timer = setTimeout(ended, Math.max(0, ends - Date.now()) + 1000);
    const back = () => {
      if (document.visibilityState === 'visible') ended();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', back);
    };
  }, [expiresAt]);

  return admin;
}
