/**
 * The admin service's HTTP handler: Martin's one way to change the factory from a browser, behind `/admin/` on the
 * console's host. It answers the routes `policy/access.ts` gives it and nothing else, each held to what the table
 * says (`guard.ts`), and every answer is JSON or the full-event stream, never stored by a browser or a proxy.
 *
 * - Enrolling: `POST /admin/enrol/options` with the code from `factory admin enrol`, then `POST /admin/enrol` with the
 *   new passkey, which signs in.
 * - Signing in: `POST /admin/sign-in/options`, then `POST /admin/sign-in` with the passkey's answer.
 * - The passkey again: `POST /admin/step-up/options`, then `POST /admin/step-up`, for the next five minutes.
 * - `POST /admin/sign-out`, `POST /admin/sign-out-everywhere` and `POST /admin/passkeys/:id/revoke`.
 * - The Canary panel's controls (`rollout.ts`): `POST /admin/release/promote` (with `fully` to send the canary all of
 *   the traffic), `/pause`, `/resume`, `/abort` and `/retry`, each naming the release the panel showed.
 * - Stop the line and Start the line (`line.ts`): `POST /admin/line/stop` and `/start`, each with Martin's reason; the
 *   stop aborts the canary in flight, and the start needs the passkey again.
 * - The line's controls (`line.ts`): `POST /admin/line/controls` with one change of the autonomy level, the switches
 *   or what the line takes, within policy, with the passkey again when it loosens.
 * - Alerts to the phone (`phone.ts`): `POST /admin/alerts/phone` with whether they reach it, with the passkey again to
 *   switch them off.
 * - The settings (`settings.ts`): `POST /admin/settings` with what the save changes, each agent's model and effort and
 *   the spend caps, within policy, with the passkey again when anything in it raises.
 * - The feature flags' stages (`flags.ts`): `POST /admin/flags/:flag/stage` with the stage the slider showed, the one
 *   chosen and, to turn it off, Martin's reason, with the passkey again when the move widens past Checks.
 * - `GET /admin/flags/held`, public: whether the app holds the flags as set (`flags-held.ts`), as last checked.
 * - Needs you (`holds.ts`): `POST /admin/holds/:workItem/approve`, `/reject` and `/answer` (with his words), each
 *   naming the hold the card showed, with the passkey again to approve a guardrail's, or an improvement's spec.
 * - The "+" (`improvements.ts`): `POST /admin/improvements` with Martin's words and the request's id, with the passkey
 *   again, which opens a work item of kind improvement with his request.
 * - A red-team attack (`attacks.ts`): `POST /admin/attacks/:attack`, one at a time and with no passkey, which opens a
 *   work item of kind red-team with his launch.
 * - `GET /admin/session`, with the token the session's writes carry and the deployment's tools Martin's menu links to,
 *   and `GET /admin/events/stream`.
 * - `GET /admin/health`.
 *
 * The session is a cookie, `__Host-session`, holding a random id the store keeps the hash of. Each action is recorded
 * as an event in the same transaction as the action; a control of the canary, once its patch of the Rollout is made.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { type HoldAnswer, REQUEST_WORDS, type ReleaseControl } from '@software-factory/events';
import { z } from 'zod';
import { ACCESS, ENROLMENT_CODE, PASSKEYS, routeOf, SESSION, type ServedBy } from '../../../../policy/access.ts';
import type { Logger } from '../log.ts';
import { LAUNCH, launchAttack } from './attacks.ts';
import { clientAddress, LIMITS, RateLimit } from './client.ts';
import type { AdminConfig } from './config.ts';
import { type FlagStages, MOVE } from './flags.ts';
import type { FlagsHeld } from './flags-held.ts';
import { fromConsole, type Guard, guardOf, refuseWrite } from './guard.ts';
import { ANSWER, answerHold, WORK_ITEM } from './holds.ts';
import { REQUEST, requestImprovement } from './improvements.ts';
import { CHANGE, changeControls, REASON, startLine, stopLine } from './line.ts';
import { SWITCH, switchPhone } from './phone.ts';
import type { ReleaseControls } from './rollout.ts';
import { codeHash, isSessionId, newChallenge, newSessionId, normalCode, tokenOf } from './secrets.ts';
import { SAVE, saveSettings } from './settings.ts';
import {
  type AdminStore,
  adminEvent,
  lockSessions,
  newestCode,
  Refused,
  type Session,
  sessionHash,
  TOO_MANY_PASSKEYS,
} from './store.ts';
import { type FullEvents, resumeFrom } from './stream.ts';
import {
  authenticationAnswer,
  authenticationOptions,
  challengeOf,
  registrationAnswer,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn.ts';

export const COOKIE = '__Host-session';

/**
 * Its answers are JSON and nothing else: no script, style, frame or form may come from them, and no page may frame
 * them. The console's own page has its own policy (`apps/console/src/app.ts`).
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Sent with every response. */
const SECURITY_HEADERS = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'strict-transport-security': 'max-age=31536000',
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/** The largest body a write takes: a passkey's answer is a few kilobytes. */
const MAX_BODY_BYTES = 64 * 1024;

export interface AdminAppOptions {
  config: AdminConfig;
  store: AdminStore;
  events: FullEvents;
  log: Logger;
  /** The controls of the app's Rollout; without them, every control is refused. */
  controls?: ReleaseControls;
  /** The feature flags' stages; without them, every move is refused. */
  flags?: FlagStages;
  /** Whether the app holds the flags as set; without it, nobody can be told. */
  held?: FlagsHeld;
  /** The clock the rate limits count by. */
  now?: () => number;
}

/** A request on its way to its handler, with what its guard found. */
interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  values: Record<string, string>;
  body: unknown;
  /** The cookie's session id, when it names one with a session id's shape. */
  id: string | undefined;
  /** The live session it names, for every route but a visitor's. */
  session: Session | undefined;
}

type Reply = { status: number; body: object; cookie?: string } | 'streaming';

const sessionCookie = (id: string) =>
  `${COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION.minutes * 60}`;
const clearedCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

const name = z.string().trim().min(1).max(40);

/** A control of the canary names the release the panel showed, as the line names releases. */
const releaseOf = z.strictObject({ release: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/) });

export function createAdminApp({
  config,
  store,
  events,
  log,
  controls,
  flags,
  held,
  now = Date.now,
}: AdminAppOptions): RequestListener {
  const limits = { enrol: new RateLimit(LIMITS.enrol, now), 'sign-in': new RateLimit(LIMITS['sign-in'], now) };

  /** A session's description, with the token its writes carry. */
  const described = async (session: Session, id: string) => ({
    signedInAt: session.signedInAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    steppedUpAt: session.steppedUpAt?.toISOString() ?? null,
    steppedUp: session.steppedUp,
    token: tokenOf(id),
    passkey: { id: session.passkey.id, name: session.passkey.name },
    passkeys: (await store.passkeys()).map((passkey) => ({
      id: passkey.id,
      name: passkey.name,
      enrolledAt: passkey.enrolledAt.toISOString(),
      lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
      current: passkey.id === session.passkey.id,
    })),
    // This deployment's Grafana and Argo CD, for his account menu: told to a signed-in session alone.
    tools: config.tools ?? {},
  });

  /**
   * Signs in with a passkey, in a transaction with the event that records it, replacing any session the browser had:
   * the one it ends is recorded as signed out, as signing out records it.
   */
  const signIn = async (
    passkey: { id: string; name: string },
    replaces: string | undefined,
    act: Parameters<AdminStore['record']>[0],
    recorded: ReturnType<typeof adminEvent>[],
  ): Promise<Reply> => {
    const id = newSessionId();
    const { ended } = await store.record(
      async (tx) => {
        await act(tx);
        return store.startSession(tx, passkey.id, sessionHash(id), replaces);
      },
      ({ ended }) => [
        ...(ended ? [adminEvent('admin.signed-out', 'Martin signed out', { everywhere: false })] : []),
        ...recorded,
        adminEvent('admin.signed-in', 'Martin signed in with a passkey', { passkey: passkey.name }),
      ],
    );
    // One that had already ended closes its stream at the stream's next check, saying why.
    if (replaces && ended) events.end('signed-out', [replaces]);
    const session = await store.session(sessionHash(id));
    if (!session) throw new Error('A session just started is not live');
    return { status: 200, body: await described(session, id), cookie: sessionCookie(id) };
  };

  /** A control of the canary: made, and recorded, or refused having changed nothing. */
  const control = async (action: ReleaseControl, body: unknown): Promise<Reply> => {
    const given = (
      action === 'promote' || action === 'promote-fully'
        ? releaseOf.extend({ fully: z.boolean().optional() })
        : releaseOf
    ).safeParse(body);
    if (!given.success) return refused(400, 'body', 'Send the release the panel shows.');
    if (!controls) return refused(503, 'rollout', 'The admin service has no Rollout to control.');
    const done = await controls.control(action, given.data.release);
    return { status: 200, body: done };
  };

  /** Martin's answer to the hold the card showed: appended, or refused having changed nothing. */
  const answer = async (decision: HoldAnswer, { values, body, session }: Context): Promise<Reply> => {
    const workItem = values.workItem ?? '';
    const given = ANSWER[decision].safeParse(body);
    if (!WORK_ITEM.test(workItem) || !given.success) {
      return refused(400, 'body', decision === 'answered' ? 'Send the hold, and your words.' : 'Send the hold.');
    }
    return { status: 200, body: await answerHold(store, session as Session, workItem, decision, given.data) };
  };

  const handlers: Record<ServedBy<'admin'>, (context: Context) => Promise<Reply>> = {
    'admin.health': async () => ({ status: 200, body: { status: 'ok' } }),

    // What the last check found, never a check of its own: anyone may ask, as often as they like.
    'flags.held': async () =>
      held ? { status: 200, body: held.view() } : refused(503, 'flags', 'The admin service does not check the flags.'),

    session: async ({ session, id }) => ({ status: 200, body: await described(session as Session, id as string) }),

    'full-events': async ({ req, res, url, session }) => {
      // Asked only whether it is there, it opens no stream.
      if (req.method === 'HEAD') return { status: 200, body: {} };
      events.stream(req, res, (session as Session).hash, resumeFrom(req, url));
      return 'streaming';
    },

    enrol: async ({ url, body, id }) => {
      if (url.pathname.endsWith('/options')) {
        const code = (body as { code?: unknown }).code;
        // Something that cannot be a code is no try: it counts against no code, so it cannot burn Martin's.
        if (typeof code !== 'string' || !normalCode(code)) {
          return refused(400, 'code', 'Enter the code `factory admin enrol` printed.');
        }
        // With two passkeys held no code can be used, so the right one is refused before it is tried, and costs none
        // of its tries. That tells nobody more than the public events, which say each passkey enrolled and revoked.
        const held = await store.passkeys();
        if (held.length >= PASSKEYS.most) return refused(409, 'passkeys', TOO_MANY_PASSKEYS);
        const hash = codeHash(code);
        const tried = await store.tryCode(hash);
        if (!tried.match) {
          // How many tries the live code has left, across every browser, so the page can tell a mistyped code from
          // one that can no longer be used. ADR 0012 weighs what that tells anyone else.
          const reply = tried.left
            ? refused(403, 'code', `That code isn’t right: ${tries(tried.left)} left for it, across every browser.`)
            : refused(
                403,
                'code',
                `That code can’t be used any more: it has expired, been used or had its ${ENROLMENT_CODE.tries} tries. ` +
                  'Run `factory admin enrol` again for a new one.',
              );
          return { ...reply, body: { ...reply.body, left: tried.left } };
        }
        const challenge = newChallenge();
        await store.challenge(challenge, 'enrol', { code: hash });
        return { status: 200, body: await registrationOptions(config, challenge, held) };
      }
      const given = z.object({ response: registrationAnswer, name }).safeParse(body);
      if (!given.success) return refused(400, 'body', 'Send the new passkey and a name for it.');
      const challenge = challengeOf(given.data.response);
      const used = challenge ? await store.spendChallenge(challenge, 'enrol') : undefined;
      if (!challenge || !used?.code)
        return refused(403, 'challenge', 'Start again: that ceremony is used or out of time.');
      const passkey = await verifyRegistration(
        config,
        given.data.response as unknown as RegistrationResponseJSON,
        challenge,
      ).catch(() => undefined);
      if (!passkey) return refused(403, 'passkey', 'The passkey was not made for this console, or was not verified.');
      const code = used.code;
      return signIn(
        { id: passkey.id, name: given.data.name },
        id && sessionHash(id),
        async (tx) => {
          const spent = await tx`
            update enrolment_codes set used_at = now()
            where code_sha256 = ${code} and code_sha256 = (${newestCode(tx)})
              and used_at is null and expires_at > now()`;
          if (spent.count !== 1) {
            throw new Refused('code', 403, 'That code is used, more than ten minutes old, or replaced by a newer one.');
          }
          await tx`
            insert into passkeys (id, public_key, sign_count, transports, name, enrolled_with)
            values (${passkey.id}, ${passkey.publicKey}, ${passkey.signCount}, ${passkey.transports},
                    ${given.data.name}, ${code})`;
        },
        [adminEvent('passkey.enrolled', 'Martin enrolled a passkey', { passkey: given.data.name })],
      );
    },

    'sign-in': async ({ url, body, id }) => {
      if (url.pathname.endsWith('/options')) {
        const challenge = newChallenge();
        await store.challenge(challenge, 'sign-in');
        return { status: 200, body: await authenticationOptions(config, challenge) };
      }
      const given = z.object({ response: authenticationAnswer }).safeParse(body);
      if (!given.success) return refused(400, 'body', "Send the passkey's answer.");
      const answer = given.data.response as unknown as AuthenticationResponseJSON;
      const challenge = challengeOf(given.data.response);
      if (!challenge || !(await store.spendChallenge(challenge, 'sign-in'))) {
        return refused(403, 'challenge', 'Start again: that ceremony is used or out of time.');
      }
      const passkey = await store.passkey(answer.id);
      const signCount =
        passkey && (await verifyAuthentication(config, answer, challenge, passkey).catch(() => undefined));
      if (!passkey || signCount === undefined) return refused(403, 'passkey', 'That passkey does not sign in here.');
      return signIn(passkey, id && sessionHash(id), (tx) => store.used(tx, passkey.id, signCount), []);
    },

    'step-up': async ({ url, body, session }) => {
      const live = session as Session;
      if (url.pathname.endsWith('/options')) {
        const challenge = newChallenge();
        await store.challenge(challenge, 'step-up', { session: live.hash });
        return { status: 200, body: await authenticationOptions(config, challenge, live.passkey) };
      }
      const given = z.object({ response: authenticationAnswer }).safeParse(body);
      if (!given.success) return refused(400, 'body', "Send the passkey's answer.");
      const answer = given.data.response as unknown as AuthenticationResponseJSON;
      const challenge = challengeOf(given.data.response);
      if (!challenge || !(await store.spendChallenge(challenge, 'step-up', live.hash))) {
        return refused(403, 'challenge', 'Start again: that ceremony is used or out of time.');
      }
      // The passkey this session signed in with, and no other.
      const passkey = answer.id === live.passkey.id ? await store.passkey(answer.id) : undefined;
      const signCount =
        passkey && (await verifyAuthentication(config, answer, challenge, passkey).catch(() => undefined));
      if (!passkey || signCount === undefined) return refused(403, 'passkey', "That is not this session's passkey.");
      // Recorded with the passkey's use, in one transaction, and neither stays if the session ended meanwhile.
      const stepped = await store.record(
        async (tx) => {
          await store.used(tx, passkey.id, signCount);
          const [row] = await tx<{ stepped_up_at: Date }[]>`
            update sessions set stepped_up_at = now()
            where id_sha256 = ${live.hash} and ended_at is null and expires_at > now()
            returning stepped_up_at`;
          if (!row) throw new Refused('session', 401, 'Sign in first: the session has ended.');
          return row.stepped_up_at;
        },
        () => [adminEvent('admin.stepped-up', 'Martin gave his passkey again', { passkey: passkey.name })],
      );
      return { status: 200, body: { steppedUpAt: stepped.toISOString() } };
    },

    'sign-out': async ({ session }) => {
      const live = session as Session;
      // One that signing in again, from another tab, ended meanwhile was recorded then, and is not again here.
      await store.record(
        (tx) => tx`update sessions set ended_at = now(), ended_by = 'sign-out'
                   where id_sha256 = ${live.hash} and ended_at is null`,
        ({ count }) => (count ? [adminEvent('admin.signed-out', 'Martin signed out', { everywhere: false })] : []),
      );
      events.end('signed-out', [live.hash]);
      return { status: 200, body: { signedOut: 'here' }, cookie: clearedCookie };
    },

    'sign-out-everywhere': async () => {
      await store.record(
        async (tx) => {
          await lockSessions(tx);
          await tx`update sessions set ended_at = now(), ended_by = 'sign-out-everywhere' where ended_at is null`;
        },
        () => [adminEvent('admin.signed-out', 'Martin signed out everywhere', { everywhere: true })],
      );
      events.end('signed-out');
      return { status: 200, body: { signedOut: 'everywhere' }, cookie: clearedCookie };
    },

    'release.promote': ({ body }) =>
      control((body as { fully?: unknown }).fully === true ? 'promote-fully' : 'promote', body),
    'release.pause': ({ body }) => control('pause', body),
    'release.resume': ({ body }) => control('resume', body),
    'release.abort': ({ body }) => control('abort', body),
    'release.retry': ({ body }) => control('retry', body),

    'line.stop': async ({ body }) => {
      const given = REASON.safeParse(body);
      if (!given.success) return refused(400, 'body', 'Give a reason, for the audit log.');
      return { status: 200, body: await stopLine(store, controls, log, given.data.reason) };
    },
    'line.start': async ({ body, session }) => {
      const given = REASON.safeParse(body);
      if (!given.success) return refused(400, 'body', 'Give a reason, for the audit log.');
      return { status: 200, body: await startLine(store, session as Session, given.data.reason) };
    },

    'line.controls': async ({ body, session }) => {
      const given = CHANGE.safeParse(body);
      if (!given.success) return refused(400, 'body', 'Send one control, and what it changes to.');
      return { status: 200, body: await changeControls(store, session as Session, given.data) };
    },

    'phone.switch': async ({ body, session }) => {
      const given = SWITCH.safeParse(body);
      if (!given.success) return refused(400, 'body', 'Send whether alerts reach your phone.');
      return { status: 200, body: await switchPhone(store, config.profile, session as Session, given.data) };
    },

    'settings.save': async ({ body, session }) => {
      const given = SAVE.safeParse(body);
      if (!given.success) return refused(400, 'body', 'Send the settings the save changes.');
      return { status: 200, body: await saveSettings(store, config.profile, session as Session, given.data) };
    },

    'flag.stage': async ({ values, body, session }) => {
      const given = MOVE.safeParse(body);
      if (!given.success) return refused(400, 'body', 'Send the stage the slider shows, and the one chosen.');
      if (!flags) return refused(503, 'flags', 'The admin service has no flags to stage.');
      return { status: 200, body: await flags.stage(session as Session, values.flag ?? '', given.data) };
    },

    'improvement.request': async ({ body, session }) => {
      const given = REQUEST.safeParse(body);
      if (!given.success) {
        return refused(400, 'body', `Send your words, up to ${REQUEST_WORDS} characters, and the request’s id.`);
      }
      return { status: 200, body: await requestImprovement(store, session as Session, given.data) };
    },

    'attack.launch': async ({ values, body }) => {
      if (!LAUNCH.safeParse(body).success) return refused(400, 'body', 'Send nothing but the attack, in the path.');
      return { status: 200, body: await launchAttack(store, values.attack ?? '') };
    },

    'hold.approve': (context) => answer('approved', context),
    'hold.reject': (context) => answer('rejected', context),
    'hold.answer': (context) => answer('answered', context),

    'passkey.revoke': async ({ values, session }) => {
      const live = session as Session;
      const passkey = values.id ?? '';
      const [revoked] = await store.record(
        (tx) => tx<{ name: string; sessions: string[] }[]>`
          with revoked as (
            update passkeys set revoked_at = now() where id = ${passkey} and revoked_at is null returning id, name
          )
          select r.name, coalesce(array_agg(s.id_sha256) filter (where s.id_sha256 is not null), '{}') as sessions
          from revoked r left join sessions s on s.passkey = r.id and s.ended_at is null
          group by r.name`,
        (rows) => {
          if (!rows[0]) throw new Refused('passkey', 404, 'Martin holds no such passkey.');
          return [
            adminEvent('passkey.revoked', 'Martin revoked a passkey', { passkey: rows[0].name, from: 'console' }),
          ];
        },
      );
      events.end('revoked', revoked?.sessions ?? []);
      const mine = passkey === live.passkey.id;
      return { status: 200, body: { revoked: true, signedOut: mine }, ...(mine && { cookie: clearedCookie }) };
    },
  };

  return (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://admin');
    const route = routeOf('admin', req.method ?? 'GET', url.pathname);
    res.on('finish', () => {
      // Neither the kubelet's checks nor the console's reads of the flags held, which anyone may make as often as they like.
      if (route?.name === 'admin.health' || route?.name === 'flags.held') return;
      const ms = Math.round(performance.now() - started);
      // The route's name, never its path: a passkey's id is in one.
      log.info({ method: req.method, route: route?.name, status: res.statusCode, ms }, `${req.method} ${route?.name}`);
    });
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(header, value);
    if (!route) return send(req, res, { status: 404, body: { refused: 'route', message: 'Not found.' } });

    handle(req, res, url, route.name, route.values).then(
      (reply) => {
        if (reply !== 'streaming') send(req, res, reply);
      },
      (error: unknown) => {
        if (error instanceof Refused) return send(req, res, refused(error.status, error.refused, error.message));
        log.error({ err: error, route: route.name }, 'the admin service failed a request');
        if (!res.headersSent) send(req, res, { status: 500, body: { refused: 'error', message: 'Something failed.' } });
        else res.destroy();
      },
    );
  };

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    route: ServedBy<'admin'>,
    values: Record<string, string>,
  ): Promise<Reply> {
    const guard: Guard = guardOf(route);
    const id = cookieOf(req);
    const write = guard !== 'none' && guard !== 'session';
    const origin = header(req, 'origin');

    // Enrolling and signing in take no session, so each is limited by where it comes from.
    if (guard === 'code' || guard === 'passkey') {
      const limit = limits[guard === 'code' ? 'enrol' : 'sign-in'].take(clientAddress(req, config.trusted));
      if (!limit.ok) {
        res.setHeader('retry-after', String(limit.retryAfter));
        return refused(429, 'rate', 'Too many tries from here: wait, then try again.');
      }
      if (!fromConsole(origin, config.origin)) {
        return refused(403, 'origin', "Only the console's own pages may ask for this.");
      }
    }

    // A session for Martin's reads and writes; enrolling and signing in take none.
    const session = (guard === 'session' || guard === 'write') && id ? await store.session(sessionHash(id)) : undefined;
    if (guard === 'session' && !session) {
      return refused(401, 'session', 'Sign in first: there is no session, or it has ended.');
    }
    if (guard === 'write') {
      const refusal = refuseWrite(
        ACCESS[route],
        { origin, token: header(req, 'x-csrf-token'), id },
        session,
        config.origin,
      );
      if (refusal) return refused(refusal.status, refusal.refused, refusal.message);
    }
    // Read only once a write is allowed past its checks.
    const body = write ? await readBody(req) : undefined;
    if (body instanceof Refused) return refused(body.status, body.refused, body.message);
    return handlers[route]({ req, res, url, values, body, id, session });
  }
}

const tries = (n: number) => (n === 1 ? '1 try' : `${n} tries`);

const refused = (status: number, why: string, message: string): Exclude<Reply, 'streaming'> => ({
  status,
  body: { refused: why, message },
});

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? undefined : value;
}

/** The session id the browser's cookie holds, if it has one of the right shape. */
function cookieOf(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== COOKIE) continue;
    const value = rest.join('=');
    return isSessionId(value) ? value : undefined;
  }
  return undefined;
}

/** A write's JSON body: an object, no larger than `MAX_BODY_BYTES`, sent as `application/json`. */
async function readBody(req: IncomingMessage): Promise<object | Refused> {
  const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return new Refused('body', 415, 'Send JSON, as `application/json`.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return new Refused('body', 413, 'That is more than any request here needs.');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return new Refused('body', 400, 'Send a JSON object.');
}

function send(req: IncomingMessage, res: ServerResponse, reply: Exclude<Reply, 'streaming'>): void {
  if (reply.cookie) res.setHeader('set-cookie', reply.cookie);
  const body = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
